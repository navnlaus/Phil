// Downloads other programs are doing, for the Transfers list: a browser's file
// being downloaded is a partial file next to where it goes (Chrome, Chromium,
// Brave, Vivaldi, Edge: <name>.crdownload; Firefox and others: <name>.part),
// renamed when it's done. Found two ways:
//  - Chromium-family browsers' History databases (their downloads table: the
//    partial file wherever it was saved, its final name and its size from the
//    start), read in place without locking (sqlite3, immutable) when the file
//    changed, at most every HISTORY_MS;
//  - partial files in the download folder (any program's; its size unknown).
// Each one's size is read every second while it's there (and a window is open);
// its speed from that. One not growing for STALLED_MS is "stalled" (paused, or
// cut off); a partial file the browser no longer has in progress, not growing,
// or one of the folder's left untouched for FORGET_MS, is left out.

import { basename, dirname, join } from "@std/path";

const POLL_MS = 1000; // sizes, while there are any
const HISTORY_MS = 4000; // the databases looked at (their modification time) this often, at most
const STALLED_MS = 30_000;
const FORGET_MS = 6 * 3600_000; // a leftover partial file not growing: not shown after this
const SUFFIXES = [".crdownload", ".part"];

// Chromium-family browsers' profile folders (under ~/.config), and their names.
const BROWSERS = [
  ["BraveSoftware/Brave-Browser", "Brave"], ["google-chrome", "Chrome"], ["chromium", "Chromium"],
  ["vivaldi", "Vivaldi"], ["microsoft-edge", "Edge"], ["thorium", "Thorium"],
];

const home = () => Deno.env.get("HOME") ?? "/";
const configHome = () => Deno.env.get("XDG_CONFIG_HOME") || join(home(), ".config");

// The download folder (XDG's, from user-dirs.dirs; ~/Downloads otherwise).
function downloadDir() {
  try {
    const text = Deno.readTextFileSync(join(configHome(), "user-dirs.dirs"));
    const m = /^XDG_DOWNLOAD_DIR="([^"]+)"/m.exec(text);
    if (m) return m[1].replace("$HOME", home());
  } catch { /* none */ }
  return join(home(), "Downloads");
}

// The History databases there are: [{file, browser}].
async function historyFiles() {
  const found = [];
  for (const [dir, browser] of BROWSERS) {
    const root = join(configHome(), dir);
    try {
      for await (const e of Deno.readDir(root)) {
        if (!e.isDirectory || !(e.name === "Default" || e.name.startsWith("Profile "))) continue;
        const file = join(root, e.name, "History");
        if (await Deno.stat(file).then((s) => s.isFile, () => false)) found.push({ file, browser });
      }
    } catch { /* not installed */ }
  }
  return found;
}

// A History database's downloads in progress: [{partial, target, total, started}].
async function inProgress(file) {
  const query = "SELECT current_path, target_path, total_bytes, start_time FROM downloads WHERE state = 0";
  try {
    const out = await new Deno.Command("sqlite3", {
      args: ["-readonly", "-json", `file:${encodeURI(file)}?immutable=1`, query], stdin: "null", stdout: "piped", stderr: "null",
    }).output();
    if (!out.success) return [];
    const text = new TextDecoder().decode(out.stdout).trim();
    return (text ? JSON.parse(text) : []).map((r) => ({
      partial: r.current_path, target: r.target_path, total: r.total_bytes > 0 ? r.total_bytes : null,
      // Chromium's time: microseconds since 1601.
      started: r.start_time ? Math.round(r.start_time / 1000 - 11644473600000) : null,
    })).filter((r) => r.partial);
  } catch {
    return [];
  }
}

const isPartial = (name) => SUFFIXES.some((s) => name.endsWith(s) && name.length > s.length);
const finalName = (name) => name.replace(/\.(crdownload|part)$/, "");

/**
 * Watches for others' downloads; `onChange(list)` when it changes. Each:
 * {id, app, name, path (the partial file), target, dir, bytes, total, percent,
 * speed, eta, started, state: "downloading" | "stalled"}.
 */
export function watchBrowserDownloads(onChange) {
  const items = new Map(); // partial path -> {app, target, total, started, samples: [[ms, bytes]], grew, bytes}
  let users = 0, timer = 0, historyTimer = 0, watcher = null, last = "[]";
  const historyChecked = new Map(); // file -> its mtime when last read
  const dir = downloadDir();

  // From the download folder: partial files there (another program's, or a browser's not in its History yet).
  async function scanFolder() {
    try {
      for await (const e of Deno.readDir(dir)) {
        if (e.isFile && isPartial(e.name) && !items.has(join(dir, e.name))) add(join(dir, e.name), {});
      }
    } catch { /* no such folder */ }
  }

  function add(path, { app = null, target = null, total = null, started = null }) {
    const known = items.get(path);
    if (known) return Object.assign(known, { app: app ?? known.app, target: target ?? known.target, total: total ?? known.total, started: started ?? known.started, inHistory: !!app || known.inHistory });
    items.set(path, { app: app ?? (path.endsWith(".crdownload") ? "Browser" : "Download"), target, total, started, inHistory: !!app, samples: [], grew: Date.now(), bytes: 0 });
  }

  // The browsers' databases, when they changed: their downloads in progress.
  async function readHistories(force = false) {
    const files = await historyFiles();
    const nowInProgress = new Set();
    let any = false;
    for (const { file, browser } of files) {
      const mtime = await Deno.stat(file).then((s) => s.mtime?.getTime() ?? 0, () => 0);
      if (!force && historyChecked.get(file) === mtime) {
        for (const [path, it] of items) if (it.historyFile === file) nowInProgress.add(path); // as it was
        continue;
      }
      historyChecked.set(file, mtime);
      any = true;
      for (const r of await inProgress(file)) {
        add(r.partial, { app: browser, target: r.target, total: r.total, started: r.started });
        if (items.get(r.partial).missing === undefined) items.get(r.partial).missing = true; // (till it's seen)
        items.get(r.partial).historyFile = file;
        nowInProgress.add(r.partial);
      }
    }
    // No longer in progress in its browser's database: done or cancelled (kept while it grows).
    if (any) for (const [path, it] of items) if (it.inHistory && !nowInProgress.has(path) && Date.now() - it.grew > 5000) items.delete(path);
  }

  async function poll() {
    timer = 0;
    if (!users) return;
    const now = Date.now();
    for (const [path, it] of items) {
      const st = await Deno.stat(path).catch(() => null);
      if (!st) { // renamed into place (done), or gone; a browser's, in progress: maybe not made yet (kept till it says)
        if (it.inHistory) it.missing = true;
        else items.delete(path);
        continue;
      }
      it.missing = false;
      if (st.size !== it.bytes) (it.bytes = st.size), (it.grew = now);
      it.samples.push([now, st.size]);
      while (it.samples.length > 2 && now - it.samples[1][0] >= 5000) it.samples.shift();
      it.started ??= st.birthtime?.getTime() ?? st.mtime?.getTime() ?? now;
      if (!it.inHistory && now - (st.mtime?.getTime() ?? now) > FORGET_MS) items.delete(path); // a leftover
    }
    publish();
    if (users && items.size) timer = setTimeout(poll, POLL_MS);
  }

  function publish() {
    const now = Date.now();
    const list = [...items].filter(([, it]) => !it.missing && it.samples.length).map(([path, it]) => {
      const [t0, b0] = it.samples[0] ?? [now, it.bytes];
      const speed = now - t0 >= 1000 ? Math.max(0, Math.round(((it.bytes - b0) * 1000) / (now - t0))) : 0;
      const stalled = now - it.grew > STALLED_MS;
      const total = it.total && it.total >= it.bytes ? it.total : null;
      return {
        id: path, app: it.app, path, target: it.target, dir: dirname(it.target ?? path), name: basename(it.target ?? finalName(path)),
        bytes: it.bytes, total, percent: total ? Math.floor((it.bytes / total) * 1000) / 10 : null,
        speed: stalled ? 0 : speed, eta: !stalled && speed > 0 && total ? Math.round((total - it.bytes) / speed) : null,
        started: it.started, state: stalled ? "stalled" : "downloading",
      };
    }).sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
    const json = JSON.stringify(list);
    if (json === last) return;
    last = json;
    onChange(list);
  }

  // Started with the first window, stopped after the last (as downloads.js).
  async function start() {
    await scanFolder();
    await readHistories(true);
    poll();
    // New partial files in the download folder, at once (a size changing: the next poll).
    try {
      watcher = Deno.watchFs(dir, { recursive: false });
      (async () => {
        for await (const e of watcher) {
          if (e.kind !== "create" && e.kind !== "rename") continue;
          let fresh = false;
          for (const p of e.paths) if (dirname(p) === dir && isPartial(basename(p)) && !items.has(p)) add(p, {}), (fresh = true);
          if (fresh && !timer) poll();
        }
      })().catch(() => {});
    } catch { /* no such folder */ }
    const checkHistories = async () => {
      historyTimer = 0;
      if (!users) return;
      const before = items.size;
      await readHistories();
      if (items.size !== before && !timer) poll();
      historyTimer = setTimeout(checkHistories, HISTORY_MS);
    };
    historyTimer = setTimeout(checkHistories, HISTORY_MS);
  }

  return {
    get list() {
      return JSON.parse(last);
    },
    use() {
      if (users++ === 0) start();
      return () => {
        if (--users > 0) return;
        clearTimeout(timer);
        clearTimeout(historyTimer);
        timer = historyTimer = 0;
        try {
          watcher?.close();
        } catch { /* closed */ }
        watcher = null;
      };
    },
  };
}
