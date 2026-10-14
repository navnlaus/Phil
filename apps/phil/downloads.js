// Downloads in progress, from panda-dl (a download manager: HTTP and
// BitTorrent, through librqbit), shown in phil like its own copies: a bar on
// what's being downloaded, on the folder it goes to and on its drive, with
// pause and stop. phil asks panda-dl's daemon over its socket
// (~/.local/share/panda-dl/panda-dl.sock, one JSON line per request and per
// answer, on one connection kept open): every second while something is
// downloading, every 5 seconds otherwise, and not at all while no window is
// open. (The daemon has no way to tell of changes by itself.) Windows hear only
// what changed.

import { join } from "@std/path";

const SOCKET = Deno.env.get("PANDA_DL_SOCKET") ?? join(Deno.env.get("HOME") ?? "/", ".local/share/panda-dl/panda-dl.sock");
// panda-dl itself, to start its daemon when a download is added and it isn't running (phil may be
// started without ~/.local/bin on its PATH).
const BINARY = Deno.env.get("PANDA_DL") ?? join(Deno.env.get("HOME") ?? "/", ".local/bin/panda-dl");
const ACTIVE_MS = 1000, IDLE_MS = 5000, ABSENT_MS = 15_000; // how often it's asked: downloading, not, no daemon
const SHOWN = new Set(["downloading", "paused", "queued", "initializing", "checking", "metadata", "starting", "error", "failed", "completed"]); // not cancelled
const RESTING = new Set(["paused", "error", "failed", "completed"]); // asked about less often (IDLE_MS)

/**
 * `onChange(list)`: the downloads to show changed ([] once none are left).
 * Each: {id, name, path, dir, state, error, percent, bytes, total, speed,
 * upSpeed, eta, peers, seeds}.
 */
export function watchDownloads(onChange) {
  let conn = null, reader = null, pending = "", last = "[]", timer = null, users = 0, asking = false;
  const encoder = new TextEncoder(), decoder = new TextDecoder();

  // One request at a time on the connection: answers come in order, one line each.
  let queue = Promise.resolve();
  const request = (message) => (queue = queue.then(() => send(message), () => send(message)));

  async function send(message) {
    if (!conn) {
      conn = await Deno.connect({ transport: "unix", path: SOCKET });
      reader = conn.readable.getReader();
      pending = "";
    }
    try {
      await conn.write(encoder.encode(JSON.stringify(message) + "\n"));
      while (!pending.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("panda-dl closed the connection");
        pending += decoder.decode(value, { stream: true });
        if (pending.length > 4 << 20) throw new Error("panda-dl's answer is too long");
      }
      const line = pending.slice(0, pending.indexOf("\n"));
      pending = pending.slice(line.length + 1);
      return JSON.parse(line);
    } catch (err) {
      close();
      throw err;
    }
  }

  function close() {
    try {
      conn?.close();
    } catch { /* closed */ }
    conn = reader = null;
  }

  async function poll() {
    timer = null;
    if (!users || asking) return;
    asking = true;
    let next = ABSENT_MS, list = [];
    try {
      const status = await request({ action: "status" });
      list = (status.downloads ?? []).map(describe).filter((d) => SHOWN.has(d.state));
      // A torrent's files and how far each is: panda-dl lists them (since phil's
      // change to it, ~/Projects/panda-dl); one that doesn't: guessed (filesOf),
      // with only the whole download's progress.
      for (const d of list) if (!d.files) d.files = (await filesOf(d)).map((path) => ({ path, length: null, downloaded: null }));
      next = list.some((d) => !RESTING.has(d.state)) ? ACTIVE_MS : IDLE_MS;
    } catch { /* no daemon (not installed, or not running): looked for again later */ }
    asking = false;
    const now = JSON.stringify(list);
    if (now !== last) {
      last = now;
      onChange(list);
    }
    if (users && !timer) timer = setTimeout(poll, next);
  }

  return {
    /** The downloads shown now. */
    get list() {
      return JSON.parse(last);
    },
    /** A window opened (asking starts) or closed (and stops after the last). */
    use() {
      if (users++ === 0) poll();
      return () => {
        if (--users > 0) return;
        clearTimeout(timer);
        timer = null;
        close();
      };
    },
    /**
     * A new download of `uri` (a magnet or web link, or a .torrent file's
     * path) into the folder `dir`; then asked again at once.
     */
    async add(uri, dir) {
      if (typeof uri !== "string" || !/^(magnet:\?|https?:\/\/|\/.+\.torrent$)/i.test(uri)) throw new Error("A magnet or web link, or a .torrent file");
      if (typeof dir !== "string" || !dir.startsWith("/")) throw new Error("Which folder to download into");
      let answer;
      try {
        answer = await request({ action: "add", uri, dir });
      } catch (err) {
        // Its daemon isn't running (it isn't started at login): started now (`panda-dl start`, which
        // waits till it answers; it runs on by itself, apart from phil), and asked again.
        if (!(err instanceof Deno.errors.NotFound || err instanceof Deno.errors.ConnectionRefused)) throw err;
        let started;
        try {
          started = await new Deno.Command(BINARY, { args: ["start"], stdin: "null", stdout: "null", stderr: "piped" }).output();
        } catch {
          started = { success: false, stderr: new TextEncoder().encode(`${BINARY} isn't there`) };
        }
        if (!started.success) throw new Error(`panda-dl isn't running and couldn't be started: ${new TextDecoder().decode(started.stderr).trim().split("\n").pop()}`);
        answer = await request({ action: "add", uri, dir });
      }
      if (answer.status === "error") throw new Error(answer.message ?? "panda-dl couldn't");
      clearTimeout(timer);
      timer = null;
      poll();
      return answer;
    },
    /** pause, resume or remove (`deleteFile`: its files too) a download; then asked again at once. */
    async act(action, id, { deleteFile = false } = {}) {
      if (!["pause", "resume", "remove"].includes(action) || typeof id !== "string") throw new Error("pause, resume or remove, and a download's id");
      const answer = await request({ action, id, ...(action === "remove" && deleteFile ? { delete_file: true } : {}) });
      if (answer.status === "error") throw new Error(answer.message ?? "panda-dl couldn't");
      clearTimeout(timer);
      timer = null;
      poll();
      return answer;
    },
  };
}

// A download's files still being written (for thumbnails: not till they're done).
export const unfinished = (d) => d.state === "completed" ? [] : d.files.filter((f) => f.length === null || f.downloaded < f.length).map((f) => f.path);

// What a download is writing: its name in its folder, when that's there (a
// file, or a torrent's folder); otherwise (a torrent whose files land in the
// folder itself, under their own names) the entries there that appeared since
// it was added and share most of its name's words. Folders' entries are read
// again only when they change.
const listings = new Map(); // folder -> {mtime, entries: [{name, born}]}
async function filesOf(d) {
  if (!d.dir) return [];
  if (d.path && await Deno.lstat(d.path).then(() => true, () => false)) return [d.path];
  const dirStat = await Deno.stat(d.dir).catch(() => null);
  if (!dirStat) return [];
  let listing = listings.get(d.dir);
  if (listing?.mtime !== dirStat.mtime?.getTime()) {
    const entries = [];
    try {
      for await (const e of Deno.readDir(d.dir)) {
        const st = await Deno.lstat(join(d.dir, e.name)).catch(() => null);
        if (st) entries.push({ name: e.name, born: (st.birthtime ?? st.mtime)?.getTime() ?? 0 });
      }
    } catch { /* gone */ }
    listings.set(d.dir, listing = { mtime: dirStat.mtime?.getTime(), entries });
    if (listings.size > 50) listings.delete(listings.keys().next().value);
  }
  const words = wordsOf(d.name);
  if (!words.size) return [];
  return listing.entries
    .filter((e) => e.born >= (d.created - 60) * 1000) // appeared since it was added (a minute's leeway)
    .filter((e) => {
      const theirs = wordsOf(e.name);
      let shared = 0;
      for (const w of words) if (theirs.has(w)) shared++;
      return shared / words.size >= 0.6;
    })
    .map((e) => join(d.dir, e.name));
}

const wordsOf = (name) => new Set(name.toLowerCase().replace(/\.[a-z0-9]{2,4}$/, "").split(/[^a-z0-9]+/).filter((w) => w.length > 1));

// panda-dl's record of a download, as phil shows it.
function describe(d) {
  const state = typeof d.status === "object" && d.status ? Object.keys(d.status)[0] : String(d.status ?? "");
  const total = d.total_bytes ?? 0, bytes = d.downloaded_bytes ?? 0;
  return {
    id: String(d.id),
    name: d.name ?? "",
    dir: d.output_path ?? "",
    path: d.output_path && d.name ? join(d.output_path, d.name) : null,
    state,
    error: typeof d.status === "object" && d.status ? String(Object.values(d.status)[0] ?? "") : null,
    percent: total ? Math.floor((bytes / total) * 1000) / 10 : 0,
    bytes,
    total,
    speed: d.download_speed ?? 0,
    upSpeed: d.upload_speed ?? 0,
    eta: d.eta_seconds ?? null,
    uploaded: d.uploaded_bytes ?? 0,
    created: d.created_at ?? 0,
    // A torrent's files, as panda-dl lists them ([]: not known yet, a magnet's metadata); null: not
    // listed (a web download: itself; a panda-dl without phil's change: guessed, see filesOf).
    files: d.kind === "torrent" && Array.isArray(d.files)
      ? d.files.map((f) => ({ path: String(f.path), length: f.length ?? 0, downloaded: f.downloaded ?? 0 }))
      : null,
    peers: d.torrent_info?.peers ?? null,
    seeds: d.torrent_info?.seeds ?? null,
  };
}
