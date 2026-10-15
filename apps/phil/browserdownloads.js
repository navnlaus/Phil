// Downloads other programs are doing, for the Transfers list: those saved through
// phil's file chooser (phil --choose save: an app's Save dialog). When one is
// saved, phil knows where it goes; a browser downloads it into a partial file
// next to that (Chrome, Chromium, Brave, Vivaldi, Edge: <path>.crdownload;
// Firefox and others: <path>.part), renamed to it when it's done. That partial
// file's size is read every second while it's there (and a window is open); its
// speed from that. Its full size: a Chromium-family browser's History database
// has it (its downloads table, by that path), read in place without locking it
// (sqlite3, immutable) when it changed. One not growing for STALLED_MS is
// "stalled" (paused, or cut off). A Chromium-family browser that started the
// download before its Save dialog was answered writes it to "Unconfirmed
// 123456.crdownload" (in its download folder) and keeps that name till it's
// done: the one made in the two minutes before the save is taken to be it. The
// paths saved are kept
// ($XDG_STATE_HOME/phil/saved-downloads.json), so a restart keeps following them;
// one whose partial file never shows up (WAIT_MS), or is gone, is let go.

import { basename, dirname, join } from "@std/path";

const POLL_MS = 1000; // sizes, while there are any
const HISTORY_MS = 4000; // the databases looked at (their modification time) this often, at most
const STALLED_MS = 30_000;
const WAIT_MS = 5 * 60_000; // a saved path's partial file not there after this: let go
const SUFFIXES = [".crdownload", ".part"];
const UNCONFIRMED_MS = 120_000; // an "Unconfirmed" partial file made this long before a save, at most: its download

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
    const m = /^XDG_DOWNLOAD_DIR="([^"]+)"/m.exec(Deno.readTextFileSync(join(configHome(), "user-dirs.dirs")));
    if (m) return m[1].replace("$HOME", home());
  } catch { /* none */ }
  return join(home(), "Downloads");
}

// "Unconfirmed" partial files in `dir` (Chromium's, named before a Save dialog's answer): [{path, born}].
async function unconfirmedIn(dir) {
  const found = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !/^Unconfirmed \d+\.crdownload$/.test(e.name)) continue;
      const st = await Deno.stat(join(dir, e.name)).catch(() => null);
      if (st) found.push({ path: join(dir, e.name), born: st.birthtime?.getTime() ?? st.mtime?.getTime() ?? 0 });
    }
  } catch { /* no such folder */ }
  return found;
}

const stateFile = () => join(Deno.env.get("XDG_STATE_HOME") || join(home(), ".local/state"), "phil", "saved-downloads.json");

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

// A History database's newest download to `target`: {total, started} or null.
async function downloadTo(file, target) {
  const query = `SELECT total_bytes AS total, start_time AS start FROM downloads WHERE target_path = '${target.replaceAll("'", "''")}' ORDER BY start_time DESC LIMIT 1`;
  try {
    const out = await new Deno.Command("sqlite3", {
      args: ["-readonly", "-json", `file:${encodeURI(file)}?immutable=1`, query], stdin: "null", stdout: "piped", stderr: "null",
    }).output();
    const text = out.success ? new TextDecoder().decode(out.stdout).trim() : "";
    const r = text ? JSON.parse(text)[0] : null;
    // (Chromium's time: microseconds since 1601.)
    return r ? { total: r.total > 0 ? r.total : null, started: r.start ? Math.round(r.start / 1000 - 11644473600000) : null } : null;
  } catch {
    return null;
  }
}

/**
 * Follows downloads saved through phil's file chooser; `onChange(list)` when
 * the list changes. Each: {id, app, name, path (the partial file), target, dir,
 * bytes, total, percent, speed, eta, started, state: "downloading" | "stalled"}.
 * saved(path): a Save dialog answered with `path` (phil --choose save).
 */
export function watchBrowserDownloads(onChange) {
  const items = new Map(); // target -> {saved, partial, app, total, started, samples, grew, bytes}
  let users = 0, timer = 0, historyTimer = 0, last = "[]";
  const historyChecked = new Map(); // History file -> its mtime when last read

  function newItem(saved = Date.now()) {
    return { saved, partial: null, app: null, total: null, started: null, samples: [], grew: Date.now(), bytes: 0 };
  }
  // The paths saved, kept for a restart.
  try {
    for (const { target, saved } of JSON.parse(Deno.readTextFileSync(stateFile()))) {
      if (typeof target === "string") items.set(target, newItem(saved));
    }
  } catch { /* none */ }
  function keep() {
    const list = [...items].map(([target, it]) => ({ target, saved: it.saved }));
    Deno.mkdir(dirname(stateFile()), { recursive: true })
      .then(() => Deno.writeTextFile(stateFile(), JSON.stringify(list) + "\n"))
      .catch(() => {});
  }

  // Its full size, from a browser's database, when one changed (or `force`).
  async function readHistories(force = false) {
    for (const { file, browser } of await historyFiles()) {
      const mtime = await Deno.stat(file).then((s) => s.mtime?.getTime() ?? 0, () => 0);
      if (!force && historyChecked.get(file) === mtime) continue;
      historyChecked.set(file, mtime);
      for (const [target, it] of items) {
        if (it.total && it.app) continue;
        const d = await downloadTo(file, target);
        if (d) Object.assign(it, { app: browser, total: it.total ?? d.total, started: it.started ?? d.started });
      }
    }
  }

  async function poll() {
    timer = 0;
    if (!users) return;
    const now = Date.now();
    let changed = false;
    const claimed = new Set([...items.values()].map((it) => it.partial).filter(Boolean));
    for (const [target, it] of items) {
      let st = null;
      if (it.partial) st = await Deno.stat(it.partial).catch(() => null);
      else {
        for (const suffix of SUFFIXES) {
          st = await Deno.stat(target + suffix).catch(() => null);
          if (st) {
            it.partial = target + suffix;
            it.app ??= suffix === ".part" ? "Download" : "Browser";
            break;
          }
        }
      }
      // Not under its name: an "Unconfirmed" one made just before it was saved (nearest first).
      if (!st && !it.partial) {
        const dirs = [...new Set([dirname(target), downloadDir()])];
        const candidates = (await Promise.all(dirs.map(unconfirmedIn))).flat()
          .filter((c) => !claimed.has(c.path) && c.born <= it.saved + 5000 && it.saved - c.born <= UNCONFIRMED_MS)
          .sort((a, b) => Math.abs(it.saved - a.born) - Math.abs(it.saved - b.born));
        if (candidates[0]) {
          it.partial = candidates[0].path;
          it.app ??= "Browser";
          claimed.add(it.partial);
          st = await Deno.stat(it.partial).catch(() => null);
        }
      }
      if (!st) { // not there yet, or done (renamed into place), or gone
        if (it.partial || now - it.saved > WAIT_MS) items.delete(target), (changed = true);
        continue;
      }
      if (st.size !== it.bytes) (it.bytes = st.size), (it.grew = now);
      it.samples.push([now, st.size]);
      while (it.samples.length > 2 && now - it.samples[1][0] >= 5000) it.samples.shift();
      it.started ??= st.birthtime?.getTime() ?? it.saved;
    }
    if (changed) keep();
    publish();
    if (users && items.size) timer = setTimeout(poll, POLL_MS);
  }

  function publish() {
    const now = Date.now();
    const list = [...items].filter(([, it]) => it.partial && it.samples.length).map(([target, it]) => {
      const [t0, b0] = it.samples[0];
      const speed = now - t0 >= 1000 ? Math.max(0, Math.round(((it.bytes - b0) * 1000) / (now - t0))) : 0;
      const stalled = now - it.grew > STALLED_MS;
      const total = it.total && it.total >= it.bytes ? it.total : null;
      return {
        id: target, app: it.app, path: it.partial, target, dir: dirname(target), name: basename(target),
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

  function start() {
    if (!items.size) return;
    readHistories(true).finally(() => !timer && poll());
    const checkHistories = async () => {
      historyTimer = 0;
      if (!users || !items.size) return;
      await readHistories();
      historyTimer = setTimeout(checkHistories, HISTORY_MS);
    };
    clearTimeout(historyTimer);
    historyTimer = setTimeout(checkHistories, HISTORY_MS);
  }

  return {
    get list() {
      return JSON.parse(last);
    },
    /** A Save dialog (phil's file chooser) answered with `path`: followed from now. */
    saved(path) {
      if (typeof path !== "string" || !path.startsWith("/")) return;
      items.set(path, newItem());
      keep();
      if (users) start();
    },
    /** A window opened (following starts) or closed (and stops after the last). */
    use() {
      if (users++ === 0) start();
      return () => {
        if (--users > 0) return;
        clearTimeout(timer);
        clearTimeout(historyTimer);
        timer = historyTimer = 0;
      };
    },
  };
}
