import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "@std/path";

const RUNNING = 2; // walks at once
const TIMEOUT = 120_000; // ms, for one folder
const KEEP = 1_000_000; // folders remembered; past that, the ones worked out longest ago go

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS totals (
    path TEXT PRIMARY KEY,
    bytes INTEGER NOT NULL,
    mtime INTEGER NOT NULL, -- the folder's when it was worked out (ms); -1: out of date
    dev INTEGER NOT NULL, -- its file system (st_dev)
    at INTEGER NOT NULL -- when it was worked out
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS totals_at ON totals (at);
`;

/**
 * Folders' total sizes, everything in them and in their subfolders (like
 * `du -sb`), for their tiles: in bytes, the files' sizes (as on the tiles; a
 * file hard-linked in two places in each), on the folder's own file system (not
 * /proc or a drive mounted inside it). Worked out in the background by
 * one find walking the folder, which gives every folder under it its total
 * too: opening one of those, its folders' totals are known already.
 *
 * Each is kept with the folder's modification time: it's out of date when the
 * folder changed since (something put in it, deleted or renamed; a change
 * deeper doesn't touch it: F5 has the page ask again). What phil does itself
 * keeps them up to date: a delete, copy, move, rename or new folder or file
 * changes the totals of the folders it's in and every one above them (on the
 * same file system) by what it added or took away, and the pages hear the new
 * totals ({totalOf, bytes}, through `changed`).
 *
 * Kept in <thumbs>/folder-totals.sqlite (node:sqlite); without a directory
 * (incognito) in memory for the session only.
 *
 * The walk runs at the lowest priority (nice, ionice's idle class): a slow
 * drive isn't kept from anything else. Asked with a signal (the folder shown),
 * a total no longer wanted when it's aborted is dropped, its walk stopped.
 */
export class FolderTotals {
  #db;
  #get;
  #add;
  #outdated;

  /**
   * `changed(path, bytes)`: a total phil's own change made, for the pages;
   * `counts(path)`: whether totals are worked out there (a USB drive's may not be).
   */
  constructor(dir, { changed = () => {}, counts = () => true } = {}) {
    this.changed = changed;
    this.counts = counts;
    try {
      if (!dir) throw new Error("in memory");
      Deno.mkdirSync(dir, { recursive: true });
      this.#db = new DatabaseSync(join(dir, "folder-totals.sqlite"));
      this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;" + SCHEMA);
      Deno.remove(join(dir, "folder-totals.json")).catch(() => {}); // what was kept before (no file systems in it): worked out again
    } catch {
      this.#db = new DatabaseSync(":memory:");
      this.#db.exec(SCHEMA);
    }
    this.#get = this.#db.prepare("SELECT bytes, mtime, dev FROM totals WHERE path = ?");
    this.#add = this.#db.prepare("UPDATE totals SET bytes = bytes + ? WHERE path = ?");
    this.#outdated = this.#db.prepare("UPDATE totals SET mtime = -1 WHERE path = ?");
    this.queue = []; // folders waiting, the most recently asked for last (done first)
    this.waiting = new Map(); // path -> [{ done, signal }]
    this.stops = new Map(); // path -> AbortController, for its walk while it runs
    this.running = 0;
  }

  /** The total known for `path` (bytes), or null; `stale` when it should be worked out again. */
  // deno-lint-ignore require-await
  async get(path, mtime) {
    const known = this.#get.get(path);
    return known ? { bytes: known.bytes, stale: known.mtime !== mtime } : null;
  }

  /**
   * Works the total out (again), calling `done(bytes)`, or done(null) if that fails;
   * `signal` aborted first: not called, and when nobody else waits, not worked out.
   */
  refresh(path, done, signal = null) {
    if (signal?.aborted) return;
    const waiter = { done, signal };
    signal?.addEventListener("abort", () => this.drop(path, waiter), { once: true });
    const waiters = this.waiting.get(path);
    if (waiters) {
      waiters.push(waiter);
      const i = this.queue.indexOf(path);
      if (i !== -1) this.queue.push(...this.queue.splice(i, 1)); // asked again: sooner
      return;
    }
    this.waiting.set(path, [waiter]);
    this.queue.push(path);
    this.next();
  }

  drop(path, waiter) {
    const waiters = this.waiting.get(path);
    if (!waiters?.includes(waiter)) return;
    waiters.splice(waiters.indexOf(waiter), 1);
    if (waiters.length) return;
    const i = this.queue.indexOf(path);
    if (i !== -1) this.queue.splice(i, 1), this.waiting.delete(path);
    else this.stops.get(path)?.abort(); // running: its walk stopped
  }

  next() {
    while (this.running < RUNNING && this.queue.length) {
      const path = this.queue.pop();
      this.running++;
      const stop = new AbortController();
      this.stops.set(path, stop);
      this.measure(path, stop.signal)
        .then((bytes) => {
          if (!stop.signal.aborted) for (const { done } of this.waiting.get(path) ?? []) done(bytes);
        })
        .finally(() => {
          this.stops.delete(path);
          this.waiting.delete(path);
          this.running--;
          this.next();
        });
    }
  }

  // One find: every file's size and every folder's time and file system, in
  // the order it goes (a folder, then what's in it), added up from the bottom;
  // every folder's total is kept. Folders it can't read are left out.
  async measure(path, signal) {
    if (await notWorthIt(path)) return null;
    const folders = []; // { path, depth, dev, mtime, bytes }, the one being read and those it's in
    const rows = [];
    let rootDev = null;
    const close = (depth) => { // the folders at `depth` and deeper are done
      while (folders.length && folders.at(-1).depth >= depth) {
        const done = folders.pop();
        rows.push(done);
        if (folders.length) folders.at(-1).bytes += done.bytes;
      }
    };
    try {
      const child = new Deno.Command("ionice", {
        args: ["-c", "3", "nice", "-n", "19", "find", path, "-xdev",
          "(", "-type", "d", "-printf", "d %d %D %T@ %p\\0", ")", "-o", "-printf", "f %d %s\\0"],
        stdin: "null",
        stdout: "piped",
        stderr: "null",
        signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT), signal]),
      }).spawn();
      let buffer = "";
      for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
        buffer += chunk;
        const lines = buffer.split("\0");
        buffer = lines.pop();
        for (const line of lines) {
          const fields = line.split(" ", line[0] === "d" ? 4 : 3);
          const depth = Number(fields[1]);
          if (line[0] === "d") {
            const [, , dev, time] = fields;
            close(depth);
            rootDev ??= Number(dev);
            if (Number(dev) !== rootDev) continue; // a drive mounted here: not gone into, not counted
            const [sec, frac = ""] = time.split(".");
            folders.push({
              path: line.slice(fields.join(" ").length + 1),
              depth,
              dev: rootDev,
              mtime: Number(sec) * 1000 + Number(frac.padEnd(3, "0").slice(0, 3)),
              bytes: 0,
            });
          } else if (folders.length) {
            close(depth);
            folders.at(-1).bytes += Number(fields[2]);
          }
        }
      }
      const status = await child.status;
      if (status.signal || signal.aborted || !rows.length && !folders.length) return null; // (find says 1 for a folder it couldn't read: the rest is right)
    } catch {
      return null;
    }
    close(0);
    const root = rows.at(-1);
    if (root?.path !== path) return null;
    this.#keep(path, rows);
    return root.bytes;
  }

  // A walk's totals, in place of everything known under `path`.
  #keep(path, rows) {
    const at = Date.now();
    const insert = this.#db.prepare("INSERT OR REPLACE INTO totals (path, bytes, mtime, dev, at) VALUES (?, ?, ?, ?, ?)");
    this.#db.exec("BEGIN");
    try {
      this.#forgetUnder(path);
      for (const r of rows) insert.run(r.path, r.bytes, r.mtime, r.dev, at);
      this.#db.exec("COMMIT");
    } catch {
      this.#db.exec("ROLLBACK");
      return;
    }
    const { n } = this.#db.prepare("SELECT count(*) AS n FROM totals").get();
    if (n > KEEP) this.#db.prepare("DELETE FROM totals WHERE path IN (SELECT path FROM totals ORDER BY at LIMIT ?)").run(n - KEEP);
  }

  // `path` and everything under it.
  #forgetUnder(path) {
    const [from, to] = under(path);
    this.#db.prepare("DELETE FROM totals WHERE path = ? OR (path >= ? AND path < ?)").run(path, from, to);
  }

  // `from` and everything under it is now at `to`.
  #rename(from, to) {
    this.#forgetUnder(to);
    const [lo, hi] = under(from);
    this.#db.prepare("UPDATE totals SET path = ? || substr(path, ?) WHERE path = ? OR (path >= ? AND path < ?)").run(to, from.length + 1, from, lo, hi);
  }

  // The folders whose contents phil is about to change: their file system, and
  // whether their total is up to date (then, their new time is taken after).
  async #before(dirs) {
    const out = new Map();
    for (const dir of new Set(dirs)) {
      const st = await Deno.stat(dir).catch(() => null);
      const known = st && this.#get.get(dir);
      out.set(dir, { dev: st?.dev ?? null, current: !!known && known.mtime === (st.mtime?.getTime() ?? 0) });
    }
    return out;
  }

  // Done: `deltas` (folder -> bytes added, negative taken away; null: not
  // known, their totals are out of date) go to those folders and every one above
  // them on their file system; those up to date before have their new time.
  async #after(before, deltas) {
    const folders = new Map(before);
    for (const dir of deltas.keys()) {
      if (!folders.has(dir)) folders.set(dir, { dev: (await Deno.stat(dir).catch(() => null))?.dev ?? null, current: false });
    }
    const times = new Map();
    for (const [dir, { current }] of folders) {
      if (current) times.set(dir, (await Deno.stat(dir).catch(() => null))?.mtime?.getTime() ?? -1);
    }
    const changed = new Set();
    for (const [dir, { dev }] of folders) {
      if (dev === null) continue;
      const delta = deltas.get(dir) ?? 0;
      for (let p = dir;; p = dirname(p)) { // (one not known is passed over)
        const known = this.#get.get(p);
        if (known && known.dev !== dev) break; // above the drive it's on: its total doesn't count it
        if (known && delta === null) this.#outdated.run(p);
        else if (known && delta) this.#add.run(delta, p), changed.add(p);
        if (p === "/") break;
      }
      if (times.has(dir) && delta !== null) this.#db.prepare("UPDATE totals SET mtime = ? WHERE path = ?").run(times.get(dir), dir);
    }
    for (const path of changed) this.changed(path, this.#get.get(path).bytes);
  }

  // A folder's total now (a walk, through the queue: one the page asked for is
  // the same walk), or null where totals aren't worked out.
  async #measureNow(path) {
    if (!(await this.counts(path))) return null;
    return await new Promise((done) => this.refresh(path, done));
  }

  /**
   * Deleting `paths`: call what this returns with what's gone (find's entries,
   * {type, size, path}: deletePaths' `forget`).
   */
  async deleting(paths) {
    const before = await this.#before(paths.map(dirname));
    return async (gone) => {
      const dirs = new Set(gone.filter((e) => e.type === "d").map((e) => e.path));
      const keptOf = new Map(); // a folder gone -> the folder it was in that's still there
      const kept = (path) => {
        const parent = dirname(path);
        if (!dirs.has(parent)) return parent;
        if (!keptOf.has(parent)) keptOf.set(parent, kept(parent));
        return keptOf.get(parent);
      };
      const deltas = new Map();
      for (const e of gone) {
        const dir = kept(e.path);
        if (e.type === "?" || deltas.get(dir) === null) deltas.set(dir, null); // (find couldn't say)
        else if (e.type !== "d") deltas.set(dir, (deltas.get(dir) ?? 0) - e.size);
        if (e.type === "d" && !dirs.has(dirname(e.path))) this.#forgetUnder(e.path);
      }
      await this.#after(before, deltas);
    };
  }

  /**
   * A copy or move of `paths` into `dest`: call what this returns with
   * transfer()'s result ({moved: [{from, to}], errors}).
   */
  async transferring(op, paths, dest) {
    const before = await this.#before([dest, ...(op === "move" ? paths.map(dirname) : [])]);
    const known = new Map(); // a folder moved whose total's up to date: it goes along (on the same file system)
    if (op === "move") {
      for (const path of paths) {
        const st = await Deno.lstat(path).catch(() => null);
        const row = st?.isDirectory && this.#get.get(path);
        if (row && row.mtime === st.mtime?.getTime() && row.dev === before.get(dest)?.dev) known.set(path, row.bytes);
      }
    }
    return async ({ moved = [], errors = [] }) => {
      const deltas = new Map();
      const add = (dir, bytes) => deltas.set(dir, bytes === null || deltas.get(dir) === null ? null : (deltas.get(dir) ?? 0) + bytes);
      for (const { from, to } of moved) {
        const st = await Deno.lstat(to).catch(() => null);
        let bytes = null;
        if (st && !st.isDirectory) bytes = st.size; // (a link: its own, as find's)
        else if (st && known.has(from)) this.#rename(from, to), (bytes = known.get(from));
        else if (st) {
          if (op === "move") this.#forgetUnder(from);
          bytes = await this.#measureNow(to);
        }
        add(dirname(to), bytes);
        if (op === "move") add(dirname(from), bytes === null ? null : -bytes);
      }
      for (const { path } of errors) { // stopped or failed: part of it may be there
        if (!(await Deno.lstat(join(dest, basename(path))).then(() => true, () => false))) continue;
        add(dest, null);
        if (op === "move") add(dirname(path), null);
      }
      await this.#after(before, deltas);
    };
  }

  /** Renaming `path`: call what this returns with where it is now. */
  async renaming(path) {
    const before = await this.#before([dirname(path)]);
    return async (to) => {
      if (to !== path) this.#rename(path, to);
      await this.#after(before, new Map());
    };
  }

  /** Making a folder or file in `dir`: call what this returns with its path. */
  async creating(dir) {
    const before = await this.#before([dir]);
    return async (path) => {
      const st = await Deno.lstat(path).catch(() => null);
      if (st?.isDirectory) {
        this.#db.prepare("INSERT OR REPLACE INTO totals (path, bytes, mtime, dev, at) VALUES (?, ?, ?, ?, ?)")
          .run(path, 0, st.mtime?.getTime() ?? 0, st.dev, Date.now());
      }
      await this.#after(before, new Map([[dir, st ? (st.isDirectory ? 0 : st.size) : null]]));
    };
  }
}

// The range of paths under `path` (its folders and files, not it): [from, to).
function under(path) {
  const prefix = path.endsWith("/") ? path : path + "/";
  return [prefix, prefix.slice(0, -1) + "0"]; // ("0" comes after "/")
}

// Whether `path` is on a network file system (NFS, Samba, sshfs...: the whole
// share would be read, over the network) or the kernel's (/proc, /sys...).
async function notWorthIt(path) {
  try {
    const out = await new Deno.Command("stat", { args: ["-f", "-c", "%T", "--", path], stdin: "null", stdout: "piped", stderr: "null" }).output();
    const type = new TextDecoder().decode(out.stdout).trim();
    return /^(nfs|cifs|smb|9p|afs|ceph|fuse\.(sshfs|rclone|gvfsd-fuse))/.test(type) ||
      /^(proc|sysfs|devpts|cgroup2?|debugfs|tracefs|securityfs|pstore|bpf_fs|configfs|fusectl|efivarfs|mqueue|hugetlbfs)$/.test(type);
  } catch {
    return false;
  }
}
