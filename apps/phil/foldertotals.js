import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "@std/path";

const RUNNING = 2; // walks at once
const TIMEOUT = 120_000; // ms, for one folder
const KEEP = 1_000_000; // folders remembered; past that, the ones worked out longest ago go
const CHECK_WALKS = 200; // F5: more folders than this (and a quarter of them) changed or not known: one walk through all

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS totals (
    path TEXT PRIMARY KEY,
    bytes INTEGER NOT NULL, -- everything in it
    own INTEGER, -- its own files (not its folders'); null: not known (a total from before), walked again
    mtime INTEGER NOT NULL, -- the folder's when it was worked out (ms); -1: out of date
    dev INTEGER NOT NULL, -- its file system (st_dev)
    at INTEGER NOT NULL -- when it was worked out
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS totals_at ON totals (at);
`;
const INSERT = "INSERT OR REPLACE INTO totals (path, bytes, own, mtime, dev, at) VALUES (?, ?, ?, ?, ?, ?)";

/**
 * Folders' total sizes, everything in them and in their subfolders (like
 * `du -sb`), for their tiles: in bytes, the files' sizes (as on the tiles; a
 * file hard-linked in two places in each), on the folder's own file system (not
 * /proc or a drive mounted inside it).
 *
 * Each folder is kept with its total, the size of its own files and its
 * modification time. A folder never counted is walked (one find), which gives
 * every folder under it its total too: going into one, its folders' totals are
 * known. One that changed since (something put in it, deleted or renamed) has
 * its own files read again; what's in its folders comes from what's known of
 * them, read again the same way where they changed. A change deeper doesn't
 * touch a folder's time: F5 (`check`) has the time of every folder under it
 * looked at (a find of the folders only) and those that changed read again. A
 * file that grew where it was changes no folder's time: its new size counts
 * once something else in its folder changes.
 *
 * A folder's new total changes those of the folders above it (on the same
 * file system) by as much. What phil does itself (a delete, copy, move,
 * rename, new folder or file) changes the totals of the folders it's in and
 * every one above them by what it added or took away, with nothing read; the
 * pages hear of the new totals ({totalOf, bytes}, through `changed`).
 *
 * Kept in an SQLite database (node:sqlite, <thumbs>/folder-totals.sqlite).
 * `readOnly` (incognito): read, never written; its first change (F5, or a
 * delete, copy...) copies what's known into a database in memory, for the
 * session.
 *
 * Walks run at the lowest priority (nice, ionice's idle class): a slow drive
 * isn't kept from anything else. Asked with a signal (the folder shown), a
 * total no longer wanted when it's aborted is dropped, its walk stopped.
 */
export class FolderTotals {
  #db;
  #readOnly;
  #statements = new Map();

  /**
   * `changed(path, bytes)`: a total phil's own change made, for the pages;
   * `counts(path)`: whether totals are worked out there (a USB drive's may not be).
   */
  constructor(file, { readOnly = false, changed = () => {}, counts = () => true } = {}) {
    this.changed = changed;
    this.counts = counts;
    this.#readOnly = readOnly;
    try {
      if (!file) throw new Error("in memory");
      if (readOnly) {
        this.#db = new DatabaseSync(file, { readOnly: true });
        this.#db.prepare("SELECT 1 FROM totals LIMIT 1").get();
      } else {
        Deno.mkdirSync(dirname(file), { recursive: true });
        this.#db = new DatabaseSync(file);
        this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;" + SCHEMA);
        if (!this.#db.prepare("PRAGMA table_info(totals)").all().some((c) => c.name === "own")) this.#db.exec("ALTER TABLE totals ADD COLUMN own INTEGER");
        Deno.remove(join(dirname(file), "folder-totals.json")).catch(() => {}); // what was kept before (no file systems in it): worked out again
      }
    } catch {
      this.#db = new DatabaseSync(":memory:");
      this.#db.exec(SCHEMA);
      this.#readOnly = false;
    }
    this.queue = []; // folders waiting, the most recently asked for last (done first)
    this.waiting = new Map(); // path -> [{ done, signal }]
    this.checks = new Set(); // those waiting that F5 asked for: the time of every folder under them looked at
    this.stops = new Map(); // path -> AbortController, for its walk while it runs
    this.running = 0;
  }

  #q(sql) {
    if (!this.#statements.has(sql)) this.#statements.set(sql, this.#db.prepare(sql));
    return this.#statements.get(sql);
  }

  // A change. Read-only (incognito): what's known goes into a database in memory first.
  #run(sql, ...args) {
    if (this.#readOnly) {
      const memory = new DatabaseSync(":memory:");
      memory.exec(SCHEMA);
      const insert = memory.prepare(INSERT);
      memory.exec("BEGIN");
      for (const r of this.#db.prepare("SELECT * FROM totals").all()) insert.run(r.path, r.bytes, r.own ?? null, r.mtime, r.dev, r.at);
      memory.exec("COMMIT");
      this.#db.close();
      this.#db = memory;
      this.#readOnly = false;
      this.#statements.clear();
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return this.#db.exec(sql);
    return this.#q(sql).run(...args);
  }

  #row(path) {
    const r = this.#q("SELECT * FROM totals WHERE path = ?").get(path);
    return r && { ...r, own: r.own ?? null };
  }

  /** The total known for `path` (bytes), or null; `stale` when it should be worked out again. */
  // deno-lint-ignore require-await
  async get(path, mtime) {
    const known = this.#row(path);
    return known ? { bytes: known.bytes, stale: known.mtime !== mtime } : null;
  }

  /**
   * Works the total out (again), calling `done(bytes)`, or done(null) if that fails;
   * `signal` aborted first: not called, and when nobody else waits, not worked out.
   * `check` (F5): the time of every folder under it looked at, not only its own.
   */
  refresh(path, done, signal = null, check = false) {
    if (signal?.aborted) return;
    const waiter = { done, signal };
    signal?.addEventListener("abort", () => this.drop(path, waiter), { once: true });
    if (check) this.checks.add(path);
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
    if (i !== -1) this.queue.splice(i, 1), this.waiting.delete(path), this.checks.delete(path);
    else this.stops.get(path)?.abort(); // running: its walk stopped
  }

  next() {
    while (this.running < RUNNING && this.queue.length) {
      const path = this.queue.pop();
      const check = this.checks.delete(path);
      this.running++;
      const stop = new AbortController();
      this.stops.set(path, stop);
      (check ? this.#check(path, stop.signal) : this.#update(path, stop.signal))
        .catch(() => null)
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

  // Not known (or from before own files were kept): walked; known: read again where it changed.
  async #update(path, signal) {
    const known = this.#row(path);
    if (!known || known.own === null) return await this.#walk(path, signal);
    const bytes = await this.#reread(path, signal);
    if (bytes !== null) this.#addUp(path, bytes - known.bytes, known.dev);
    return bytes;
  }

  // A folder read again: its own files' sizes, and its folders' totals, known
  // (their time the same), read again (changed) or walked (not known). Its
  // folders no longer there are forgotten.
  async #reread(dir, signal, dev = null) {
    const st = await Deno.stat(dir).catch(() => null);
    if (!st || signal.aborted) return null;
    dev ??= st.dev;
    let own = 0, inside = 0;
    const folders = new Set();
    try {
      for await (const e of Deno.readDir(dir)) {
        if (signal.aborted) return null;
        const path = join(dir, e.name);
        const s = await Deno.lstat(path).catch(() => null);
        if (!s) continue;
        if (!s.isDirectory) {
          own += s.size;
          continue;
        }
        if (s.dev !== dev) continue; // a drive mounted here: not counted
        folders.add(path);
        const known = this.#row(path);
        const bytes = !known || known.own === null ? await this.#walk(path, signal, { addUp: false })
          : known.mtime === (s.mtime?.getTime() ?? 0) ? known.bytes
          : await this.#reread(path, signal, dev);
        if (bytes === null) return null;
        inside += bytes;
      }
    } catch { /* can't be read: as du, nothing in it counted */ }
    const [from, to] = under(dir);
    for (const { path } of this.#q("SELECT path FROM totals WHERE path >= ? AND path < ? AND instr(substr(path, ?), '/') = 0").all(from, to, from.length + 1)) {
      if (!folders.has(path)) this.#forgetUnder(path); // gone
    }
    this.#run(INSERT, dir, own + inside, own, st.mtime?.getTime() ?? 0, dev, Date.now());
    return own + inside;
  }

  // F5: the time of every folder under `path` (one find, of the folders
  // only); those changed, or not known, have their own files read again, the
  // rest are as they were, and the totals are added up again from the bottom.
  // Many of them: one walk through all instead.
  async #check(path, signal) {
    if (await notWorthIt(path)) return null;
    const list = []; // { path, depth, mtime, dev, known }, a folder before what's in it
    let rootDev = null;
    const read = await find(path, ["-type", "d", "-printf", "%d %D %T@ %p\\0"], signal, (line) => {
      const [depth, dev, time] = line.split(" ", 3);
      rootDev ??= Number(dev);
      if (Number(dev) !== rootDev) return; // a drive mounted here
      const p = line.slice(depth.length + dev.length + time.length + 3);
      list.push({ path: p, depth: Number(depth), mtime: ms(time), dev: rootDev, known: this.#row(p) });
    });
    if (!read || list[0]?.path !== path) return null;
    const changed = list.filter((d) => !d.known || d.known.own === null || d.known.mtime !== d.mtime);
    if (changed.length > CHECK_WALKS && changed.length > list.length / 4) return await this.#walk(path, signal);
    for (const d of list) d.own = d.known?.own ?? null;
    for (const d of changed) {
      d.own = await ownBytes(d.path);
      if (signal.aborted) return null;
    }
    return this.#keep(path, addUp(list));
  }

  // One find: every file's size and every folder's time and file system, in
  // the order it goes (a folder, then what's in it, a file at depth n in the
  // last folder at depth n - 1), added up from the bottom; every folder's
  // total is kept. Folders it can't read are left out.
  async #walk(path, signal, { addUp: up = true } = {}) {
    if (await notWorthIt(path)) return null;
    const list = []; // { path, depth, mtime, dev, own }
    const open = []; // depth -> the folder at it now
    let rootDev = null;
    const read = await find(path, ["(", "-type", "d", "-printf", "d %d %D %T@ %p\\0", ")", "-o", "-printf", "f %d %s\\0"], signal, (line) => {
      if (line[0] === "d") {
        const [, depth, dev, time] = line.split(" ", 4);
        rootDev ??= Number(dev);
        if (Number(dev) !== rootDev) return; // a drive mounted here (find doesn't go into it)
        const folder = { path: line.slice(depth.length + dev.length + time.length + 5), depth: Number(depth), mtime: ms(time), dev: rootDev, own: 0 };
        list.push(folder);
        open[folder.depth] = folder;
      } else {
        const [, depth, size] = line.split(" ", 3);
        const folder = open[Number(depth) - 1];
        if (folder) folder.own += Number(size);
      }
    });
    if (!read || list[0]?.path !== path) return null;
    return this.#keep(path, addUp(list), { addUp: up });
  }

  // A walk's or check's totals (the folder last), in place of everything
  // known under `path`; the folders above it change by as much as it did.
  #keep(path, rows, { addUp: up = true } = {}) {
    const before = this.#row(path);
    const at = Date.now();
    this.#run("BEGIN");
    try {
      this.#forgetUnder(path);
      for (const r of rows) this.#run(INSERT, r.path, r.bytes, r.own, r.mtime, r.dev, at);
      this.#run("COMMIT");
    } catch {
      this.#run("ROLLBACK");
      return null;
    }
    const { n } = this.#q("SELECT count(*) AS n FROM totals").get();
    if (n > KEEP) this.#run("DELETE FROM totals WHERE path IN (SELECT path FROM totals ORDER BY at LIMIT ?)", n - KEEP);
    const total = rows.at(-1).bytes;
    if (up && before) this.#addUp(path, total - before.bytes, before.dev);
    return total;
  }

  // The folders above `path` (on file system `dev`), `delta` bytes more; the pages hear.
  #addUp(path, delta, dev) {
    if (!delta || path === "/") return;
    for (const p of this.#chain(dirname(path), delta, dev)) this.changed(p, this.#row(p).bytes);
  }

  // `dir` and the folders above it on file system `dev`: `delta` bytes more
  // (null: not known, out of date). The folders changed.
  #chain(dir, delta, dev) {
    const changed = [];
    for (let p = dir;; p = dirname(p)) { // (one not known is passed over)
      const known = this.#row(p);
      if (known && known.dev !== dev) break; // above the drive it's on: its total doesn't count it
      if (known && delta === null) this.#run("UPDATE totals SET mtime = -1 WHERE path = ?", p);
      else if (known && delta) this.#run("UPDATE totals SET bytes = bytes + ? WHERE path = ?", delta, p), changed.push(p);
      if (p === "/") break;
    }
    return changed;
  }

  // `path` and everything under it.
  #forgetUnder(path) {
    const [from, to] = under(path);
    this.#run("DELETE FROM totals WHERE path = ? OR (path >= ? AND path < ?)", path, from, to);
  }

  // `from` and everything under it is now at `to`.
  #rename(from, to) {
    this.#forgetUnder(to);
    const [lo, hi] = under(from);
    this.#run("UPDATE totals SET path = ? || substr(path, ?) WHERE path = ? OR (path >= ? AND path < ?)", to, from.length + 1, from, lo, hi);
  }

  // The folders whose contents phil is about to change: their file system, and
  // whether their total is up to date (then, their new time is taken after).
  async #before(dirs) {
    const out = new Map();
    for (const dir of new Set(dirs)) {
      const st = await Deno.stat(dir).catch(() => null);
      const known = st && this.#row(dir);
      out.set(dir, { dev: st?.dev ?? null, current: !!known && known.own !== null && known.mtime === (st.mtime?.getTime() ?? 0) });
    }
    return out;
  }

  // Done: `deltas` (folder -> bytes added, negative taken away; null: not
  // known, their totals are out of date) go to those folders and every one above
  // them on their file system; `owns` (folder -> bytes) is what of that was its
  // own files. Those up to date before have their new time.
  async #after(before, deltas, owns = new Map()) {
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
      for (const p of this.#chain(dir, delta, dev)) changed.add(p);
      if (delta !== null && times.has(dir)) this.#run("UPDATE totals SET mtime = ?, own = own + ? WHERE path = ?", times.get(dir), owns.get(dir) ?? 0, dir);
    }
    for (const path of changed) this.changed(path, this.#row(path).bytes);
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
      const deltas = new Map(), owns = new Map();
      for (const e of gone) {
        const dir = kept(e.path);
        if (e.type === "?" || deltas.get(dir) === null) deltas.set(dir, null); // (find couldn't say)
        else if (e.type !== "d") {
          deltas.set(dir, (deltas.get(dir) ?? 0) - e.size);
          if (dirname(e.path) === dir) owns.set(dir, (owns.get(dir) ?? 0) - e.size); // one of its own files
        }
        if (e.type === "d" && !dirs.has(dirname(e.path)) && this.#row(e.path)) this.#forgetUnder(e.path);
      }
      await this.#after(before, deltas, owns);
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
        const row = st?.isDirectory && this.#row(path);
        if (row && row.own !== null && row.mtime === st.mtime?.getTime() && row.dev === before.get(dest)?.dev) known.set(path, row.bytes);
      }
    }
    return async ({ moved = [], errors = [] }) => {
      const deltas = new Map(), owns = new Map();
      const add = (dir, bytes, file = false) => {
        deltas.set(dir, bytes === null || deltas.get(dir) === null ? null : (deltas.get(dir) ?? 0) + bytes);
        if (file && bytes !== null) owns.set(dir, (owns.get(dir) ?? 0) + bytes);
      };
      for (const { from, to } of moved) {
        const st = await Deno.lstat(to).catch(() => null);
        const file = !!st && !st.isDirectory;
        let bytes = null;
        if (file) bytes = st.size; // (a link: its own, as find's)
        else if (st && known.has(from)) this.#rename(from, to), (bytes = known.get(from));
        else if (st) {
          if (op === "move" && this.#row(from)) this.#forgetUnder(from);
          bytes = await this.#measureNow(to);
        }
        add(dirname(to), bytes, file);
        if (op === "move") add(dirname(from), bytes === null ? null : -bytes, file);
      }
      for (const { path } of errors) { // stopped or failed: part of it may be there
        if (!(await Deno.lstat(join(dest, basename(path))).then(() => true, () => false))) continue;
        add(dest, null);
        if (op === "move") add(dirname(path), null);
      }
      await this.#after(before, deltas, owns);
    };
  }

  /** Renaming `path`: call what this returns with where it is now. */
  async renaming(path) {
    const before = await this.#before([dirname(path)]);
    return async (to) => {
      if (to !== path && this.#row(path)) this.#rename(path, to);
      await this.#after(before, new Map());
    };
  }

  /** Making a folder or file in `dir`: call what this returns with its path. */
  async creating(dir) {
    const before = await this.#before([dir]);
    return async (path) => {
      const st = await Deno.lstat(path).catch(() => null);
      if (st?.isDirectory && before.get(dir)?.current) this.#run(INSERT, path, 0, 0, st.mtime?.getTime() ?? 0, st.dev, Date.now());
      const bytes = st ? (st.isDirectory ? 0 : st.size) : null;
      await this.#after(before, new Map([[dir, bytes]]), new Map([[dir, bytes ?? 0]]));
    };
  }
}

// Folders as find gives them (a folder before what's in it, {depth, own}),
// with their totals (`bytes`): their own files' and their folders'. The
// deepest first, the first one last.
function addUp(list) {
  const open = [], rows = [];
  const close = (depth) => {
    while (open.length && open.at(-1).depth >= depth) {
      const done = open.pop();
      rows.push(done);
      if (open.length) open.at(-1).bytes += done.bytes;
    }
  };
  for (const folder of list) {
    close(folder.depth);
    folder.bytes = folder.own;
    open.push(folder);
  }
  close(0);
  return rows.map(({ path, bytes, own, mtime, dev }) => ({ path, bytes, own, mtime, dev }));
}

// find `path` -xdev `expr`, at the lowest priority, `each` line it prints
// (\0-ended); whether it got through (not stopped; a folder it couldn't read
// is left out, as du does).
async function find(path, expr, signal, each) {
  try {
    const child = new Deno.Command("ionice", {
      args: ["-c", "3", "nice", "-n", "19", "find", path, "-xdev", ...expr],
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
      for (const line of lines) each(line);
    }
    const status = await child.status;
    return !status.signal && !signal.aborted;
  } catch {
    return false;
  }
}

// The size of the files in `dir`, not in its folders (0 if it can't be read).
async function ownBytes(dir) {
  let bytes = 0;
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isDirectory) bytes += (await Deno.lstat(join(dir, e.name)).catch(() => null))?.size ?? 0;
    }
  } catch { /* can't be read */ }
  return bytes;
}

// find's %T@ ("1729250000.1234567890"), as Deno.stat's mtime.getTime().
function ms(time) {
  const [sec, frac = ""] = time.split(".");
  return Number(sec) * 1000 + Number(frac.padEnd(3, "0").slice(0, 3));
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
