import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "@std/path";

const RUNNING = 2; // walks at once
const STUCK_MS = 60_000; // a walk that's found nothing more for this long is stopped (a drive gone, a share hung); one going on takes as long as it takes (an exFAT drive's big folder: minutes)
const KEEP = 1_000_000; // folders remembered; past that, the ones worked out longest ago go
const CHECK_WALKS = 200; // F5: more folders than this (and a quarter of them) changed or not known: one walk through all
const LONG_MS = 10_000; // a walk going this long goes on when nobody waits for it any more, and is listed (processes)
const TOUCHED_MS = 3000; // something written in a folder: its total read again once that's been quiet this long

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS totals (
    path TEXT PRIMARY KEY,
    parent TEXT NOT NULL, -- the folder it's in (its total adds this one's up)
    bytes INTEGER NOT NULL, -- everything in it: own, and its folders' (those on its file system)
    own INTEGER NOT NULL, -- its own files
    mtime INTEGER NOT NULL, -- the folder's when it was read (ms); -1: out of date
    dev INTEGER NOT NULL, -- its file system (st_dev)
    at INTEGER NOT NULL -- when it was read
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS totals_parent ON totals (parent);
  CREATE INDEX IF NOT EXISTS totals_at ON totals (at);
`;
const INSERT = "INSERT OR REPLACE INTO totals (path, parent, bytes, own, mtime, dev, at) VALUES (?, ?, ?, ?, ?, ?, ?)";

/**
 * Folders' total sizes, everything in them and in their subfolders (like
 * `du -sb`), for their tiles: in bytes, the files' sizes (as on the tiles; a
 * file hard-linked in two places in each), on the folder's own file system (not
 * /proc or a drive mounted inside it).
 *
 * Every folder is kept with the size of its own files, its total (that and
 * its folders' totals) and its modification time. A folder never counted is
 * walked (one find), which gives every folder under it its total too: going
 * into one, its folders' totals are known. One that changed since (something
 * put in it, deleted or renamed) has its own files read again; its folders'
 * totals are what's known of them, read again the same way where they changed.
 * A change deeper doesn't touch a folder's time: F5 (`check`) has the time of
 * every folder under it looked at (a find of the folders only) and those that
 * changed read again.
 *
 * A folder's total changed, those of the folders above it are added up again
 * from what's known of what's in them (nothing read). What phil does itself
 * keeps them up to date: a delete, copy, move, rename, new folder or file
 * changes what's known of the folders it's in, and those are added up again;
 * a file written (an editor's save, imageresize's, a download done, something
 * changed in the folder shown: `touched`) has its folder read again. The pages
 * hear of the new totals ({totalOf, bytes}, through `changed`).
 *
 * Kept in an SQLite database (node:sqlite, <thumbs>/folder-totals.sqlite).
 * `readOnly` (incognito): read, never written; its first change (F5, or a
 * delete, copy...) copies what's known into a database in memory, for the
 * session.
 *
 * Walks run at the lowest priority (nice, ionice's idle class): a slow drive
 * isn't kept from anything else. Asked with a signal (the folder shown), a
 * total no longer wanted when it's aborted is dropped, its walk stopped;
 * one that's gone on for LONG_MS already goes on (aside: it doesn't hold up the
 * others), until it's done or cancel()led. Those are the processes(), for the
 * sidebar; `processesChanged()` when there's one more or one less.
 */
export class FolderTotals {
  #db;
  #readOnly;
  #statements = new Map();
  #touched = new Map(); // folder -> its timer (touched)

  /**
   * `changed(path, bytes)`: a total that changed, for the pages; `counts(path)`:
   * whether totals are worked out there (a USB drive's may not be; incognito's not but on F5).
   */
  constructor(file, { readOnly = false, changed = () => {}, counts = () => true, processesChanged = () => {} } = {}) {
    this.changed = changed;
    this.processesChanged = processesChanged;
    this.counts = counts;
    this.#readOnly = readOnly;
    try {
      if (!file) throw new Error("in memory");
      if (readOnly) {
        this.#db = new DatabaseSync(file, { readOnly: true });
        this.#db.prepare("SELECT parent, own FROM totals LIMIT 1").get(); // (one from before: not read)
      } else {
        Deno.mkdirSync(dirname(file), { recursive: true });
        this.#db = new DatabaseSync(file);
        this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
        const columns = this.#db.prepare("PRAGMA table_info(totals)").all().map((c) => c.name);
        if (columns.length && !columns.includes("parent")) this.#db.exec("DROP TABLE totals"); // kept before without what's in them: worked out again
        this.#db.exec(SCHEMA);
        Deno.remove(join(dirname(file), "folder-totals.json")).catch(() => {}); // (from before that)
      }
    } catch {
      this.#db = new DatabaseSync(":memory:");
      this.#db.exec(SCHEMA);
      this.#readOnly = false;
    }
    this.queue = []; // folders waiting, the most recently asked for last (done first)
    this.waiting = new Map(); // path -> [{ done, signal }]
    this.modes = new Map(); // path -> how it's to be worked out, when not "update": "walk" (all of it), "check" (F5)
    this.jobs = new Map(); // path -> { started, mode, stop, long, aside, cancelled }, while it runs
    this.running = 0; // (not those aside)
  }

  /** The walks that have gone on for a while: [{id, path, mode, started}]. */
  processes() {
    return [...this.jobs].filter(([, j]) => j.long).map(([path, j]) => ({ id: path, path, mode: j.mode, started: j.started }));
  }

  /** Stops one (processes()' id); those waiting for it hear null. */
  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.cancelled = true;
    job.stop.abort();
    return true;
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
      for (const r of this.#db.prepare("SELECT * FROM totals").all()) insert.run(r.path, r.parent, r.bytes, r.own, r.mtime, r.dev, r.at);
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
    return this.#q("SELECT * FROM totals WHERE path = ?").get(path);
  }

  #put(path, bytes, own, mtime, dev, at = Date.now()) {
    this.#run(INSERT, path, dirname(path), bytes, own, mtime, dev, at);
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
   * `mode`: "update" (where it changed), "walk" (all of it), "check" (F5: the time
   * of every folder under it looked at).
   */
  refresh(path, done, signal = null, mode = "update") {
    if (signal?.aborted) return;
    const waiter = { done, signal };
    signal?.addEventListener("abort", () => this.drop(path, waiter), { once: true });
    const order = ["update", "check", "walk"]; // (asked twice: the one that reads more)
    if (order.indexOf(mode) > order.indexOf(this.modes.get(path) ?? "update")) this.modes.set(path, mode);
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
    if (i !== -1) return void (this.queue.splice(i, 1), this.waiting.delete(path), this.modes.delete(path));
    const job = this.jobs.get(path);
    if (!job?.long) return void job?.stop.abort(); // running a moment: its walk stopped
    if (job.aside) return;
    job.aside = true; // a long one goes on, aside: the next starts
    this.running--;
    this.next();
  }

  next() {
    while (this.running < RUNNING && this.queue.length) {
      const path = this.queue.pop();
      const mode = this.modes.get(path) ?? "update";
      this.modes.delete(path);
      this.running++;
      const stop = new AbortController();
      const job = { started: Date.now(), mode, stop, long: false, aside: false, cancelled: false };
      job.timer = setTimeout(() => ((job.long = true), this.processesChanged()), LONG_MS);
      this.jobs.set(path, job);
      (mode === "check" ? this.#check(path, stop.signal) : mode === "walk" ? this.#walk(path, stop.signal) : this.#update(path, stop.signal))
        .catch(() => null)
        .then((bytes) => {
          if (!stop.signal.aborted || job.cancelled) for (const { done } of this.waiting.get(path) ?? []) done(job.cancelled ? null : bytes);
        })
        .finally(() => {
          clearTimeout(job.timer);
          this.jobs.delete(path);
          this.waiting.delete(path);
          if (!job.aside) this.running--;
          if (job.long) this.processesChanged();
          this.next();
        });
    }
  }

  /**
   * Something phil wrote in `dir` (a file saved, a download done, a change seen
   * in the folder shown): once it's been quiet a moment, its total is worked out
   * again (its own files read; `walk`: all of it), and those above it added up
   * again. Where nothing above is known, nothing's done.
   */
  touched(dir, { walk = false } = {}) {
    clearTimeout(this.#touched.get(dir));
    this.#touched.set(dir, setTimeout(async () => {
      this.#touched.delete(dir);
      if (!(await this.counts(dir))) return;
      let known = dir; // the nearest known, it or a folder it's in
      while (!this.#row(known) && known !== "/") known = dirname(known);
      if (!this.#row(known)) return;
      let target = dir; // not known: the folder under the known one it's in, walked
      while (target !== known && dirname(target) !== known) target = dirname(target);
      const was = this.#row(target)?.bytes;
      this.refresh(target, (bytes) => bytes !== null && bytes !== was && this.changed(target, bytes), null, target === dir && !walk ? "update" : "walk");
    }, TOUCHED_MS));
  }

  // Not known: walked; known: read again where it changed.
  async #update(path, signal) {
    if (!this.#row(path)) return await this.#walk(path, signal);
    const bytes = await this.#reread(path, signal);
    if (bytes !== null) this.#addUp(dirname(path));
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
        const bytes = !known ? await this.#walk(path, signal, { addUp: false })
          : known.mtime === (s.mtime?.getTime() ?? 0) ? known.bytes
          : await this.#reread(path, signal, dev);
        if (bytes === null) return null;
        inside += bytes;
      }
    } catch { /* can't be read: as du, nothing in it counted */ }
    for (const { path } of this.#q("SELECT path FROM totals WHERE parent = ?").all(dir)) {
      if (!folders.has(path)) this.#forgetUnder(path); // gone
    }
    this.#put(dir, own + inside, own, st.mtime?.getTime() ?? 0, dev);
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
    const changed = list.filter((d) => !d.known || d.known.mtime !== d.mtime);
    if (changed.length > CHECK_WALKS && changed.length > list.length / 4) return await this.#walk(path, signal);
    for (const d of list) d.own = d.known?.own ?? 0;
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
  // known under `path`; the folders above it added up again.
  #keep(path, rows, { addUp: up = true } = {}) {
    const at = Date.now();
    this.#run("BEGIN");
    try {
      this.#forgetUnder(path);
      for (const r of rows) this.#put(r.path, r.bytes, r.own, r.mtime, r.dev, at);
      this.#run("COMMIT");
    } catch {
      this.#run("ROLLBACK");
      return null;
    }
    this.#evict();
    if (up) this.#addUp(dirname(path));
    return rows.at(-1).bytes;
  }

  // Past KEEP, the folders read longest ago go, and the folders they're in (a
  // total is added up from all that's in it: one missing would be short).
  #evict() {
    const { n } = this.#q("SELECT count(*) AS n FROM totals").get();
    if (n <= KEEP) return;
    const gone = new Set();
    for (const { path } of this.#q("SELECT path FROM totals ORDER BY at LIMIT ?").all(n - KEEP + 1000)) {
      for (let p = path; !gone.has(p); p = dirname(p)) {
        gone.add(p);
        if (p === "/") break;
      }
    }
    this.#run("BEGIN");
    for (const p of gone) this.#run("DELETE FROM totals WHERE path = ?", p);
    this.#run("COMMIT");
  }

  // `dir` and the folders above it: their totals added up again, their own
  // files' and what's known of their folders' (nothing read); the pages hear of
  // those that changed. Up to the first not known, or not changed.
  #addUp(dir) {
    for (let p = dir;; p = dirname(p)) {
      const known = this.#row(p);
      if (!known) return;
      const { inside } = this.#q("SELECT coalesce(sum(bytes), 0) AS inside FROM totals WHERE parent = ? AND dev = ? AND path != ?").get(p, known.dev, p);
      const bytes = known.own + inside;
      if (bytes === known.bytes && p !== dir) return;
      if (bytes !== known.bytes) {
        this.#run("UPDATE totals SET bytes = ? WHERE path = ?", bytes, p);
        this.changed(p, bytes);
      }
      if (p === "/") return;
    }
  }

  // `dir` and the folders above it on file system `dev`: out of date (read again when shown).
  #outdated(dir, dev) {
    for (let p = dir;; p = dirname(p)) { // (one not known is passed over)
      const known = this.#row(p);
      if (known && known.dev !== dev) break; // above the drive it's on: its total doesn't count it
      if (known) this.#run("UPDATE totals SET mtime = -1 WHERE path = ?", p);
      if (p === "/") break;
    }
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
    this.#run(
      "UPDATE totals SET path = ? || substr(path, ?), parent = CASE WHEN path = ? THEN ? ELSE ? || substr(parent, ?) END WHERE path = ? OR (path >= ? AND path < ?)",
      to, from.length + 1, from, dirname(to), to, from.length + 1, from, lo, hi,
    );
  }

  // The folders whose contents phil is about to change: their file system, and
  // whether what's known of them is up to date (then, their new time is taken after).
  async #before(dirs) {
    const out = new Map();
    for (const dir of new Set(dirs)) {
      const st = await Deno.stat(dir).catch(() => null);
      const known = st && this.#row(dir);
      out.set(dir, { dev: st?.dev ?? null, current: !!known && known.mtime === (st.mtime?.getTime() ?? 0) });
    }
    return out;
  }

  // Done: `owns` (folder -> bytes its own files have more, or fewer) go to the
  // folders that were up to date, with their new time; those in `unknown`
  // (what changed isn't known) and every one above are out of date. All are
  // added up again.
  async #after(before, owns = new Map(), unknown = new Set()) {
    const folders = new Map(before);
    for (const dir of [...owns.keys(), ...unknown]) {
      if (!folders.has(dir)) folders.set(dir, { dev: (await Deno.stat(dir).catch(() => null))?.dev ?? null, current: false });
    }
    for (const [dir, { dev, current }] of folders) {
      if (dev === null) continue;
      if (unknown.has(dir)) this.#outdated(dir, dev);
      else if (current) {
        const mtime = (await Deno.stat(dir).catch(() => null))?.mtime?.getTime() ?? -1;
        this.#run("UPDATE totals SET mtime = ?, own = own + ? WHERE path = ?", mtime, owns.get(dir) ?? 0, dir);
      }
      this.#addUp(dir);
    }
  }

  // A folder's total now (a walk, through the queue: one the page asked for is
  // the same walk), or null where totals aren't worked out.
  async #measureNow(path) {
    if (!(await this.counts(path))) return null;
    return await new Promise((done) => this.refresh(path, done, null, "walk"));
  }

  /**
   * Deleting `paths`: call what this returns with what's gone (find's entries,
   * {type, size, path}: deletePaths' `forget`).
   */
  async deleting(paths) {
    const before = await this.#before(paths.map(dirname));
    return async (gone) => {
      const dirs = new Set(gone.filter((e) => e.type === "d").map((e) => e.path));
      const owns = new Map(), unknown = new Set();
      for (const e of gone) {
        const dir = dirname(e.path);
        if (dirs.has(dir)) continue; // in a folder gone (forgotten with it)
        if (!before.has(dir) || e.type === "?") unknown.add(dir); // (in a folder only partly deleted; find couldn't say)
        else if (e.type === "d") this.#forgetUnder(e.path);
        else owns.set(dir, (owns.get(dir) ?? 0) - e.size);
      }
      for (const dir of dirs) if (!before.has(dirname(dir)) && !dirs.has(dirname(dir))) this.#forgetUnder(dir);
      await this.#after(before, owns, unknown);
    };
  }

  /**
   * A copy or move of `paths` into `dest`: call what this returns with
   * transfer()'s result ({moved: [{from, to}], errors}).
   */
  async transferring(op, paths, dest) {
    const before = await this.#before([dest, ...(op === "move" ? paths.map(dirname) : [])]);
    const known = new Set(); // a folder moved, what's known of it up to date: it goes along (on the same file system)
    if (op === "move") {
      for (const path of paths) {
        const st = await Deno.lstat(path).catch(() => null);
        const row = st?.isDirectory && this.#row(path);
        if (row && row.mtime === st.mtime?.getTime() && row.dev === before.get(dest)?.dev) known.add(path);
      }
    }
    return async ({ moved = [], errors = [] }) => {
      const owns = new Map(), unknown = new Set();
      const own = (dir, bytes) => owns.set(dir, (owns.get(dir) ?? 0) + bytes);
      for (const { from, to } of moved) {
        const st = await Deno.lstat(to).catch(() => null);
        if (st && !st.isDirectory) { // (a link: its own size, as find's)
          own(dirname(to), st.size);
          if (op === "move") own(dirname(from), -st.size);
          continue;
        }
        if (st && known.has(from)) this.#rename(from, to);
        else {
          if (op === "move") this.#forgetUnder(from);
          if (!st || (await this.#measureNow(to)) === null) unknown.add(dirname(to));
        }
      }
      for (const { path } of errors) { // stopped or failed: part of it may be there
        if (!(await Deno.lstat(join(dest, basename(path))).then(() => true, () => false))) continue;
        unknown.add(dest);
        if (op === "move") unknown.add(dirname(path));
      }
      await this.#after(before, owns, unknown);
    };
  }

  /** Renaming `path`: call what this returns with where it is now. */
  async renaming(path) {
    const before = await this.#before([dirname(path)]);
    return async (to) => {
      if (to !== path && this.#row(path)) this.#rename(path, to);
      await this.#after(before);
    };
  }

  /** Making a folder or file in `dir`: call what this returns with its path. */
  async creating(dir) {
    const before = await this.#before([dir]);
    return async (path) => {
      const st = await Deno.lstat(path).catch(() => null);
      if (st?.isDirectory && before.get(dir)?.current) this.#put(path, 0, 0, st.mtime?.getTime() ?? 0, st.dev);
      await this.#after(before, new Map([[dir, st && !st.isDirectory ? st.size : 0]]), st ? new Set() : new Set([dir]));
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
// (\0-ended); whether it got through (not stopped, nor stuck: STUCK_MS
// without a line; a folder it couldn't read is left out, as du does).
async function find(path, expr, signal, each) {
  const stuck = new AbortController();
  let timer = setTimeout(() => stuck.abort(), STUCK_MS);
  try {
    const child = new Deno.Command("ionice", {
      args: ["-c", "3", "nice", "-n", "19", "find", path, "-xdev", ...expr],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.any([stuck.signal, signal]),
    }).spawn();
    let buffer = "";
    for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
      clearTimeout(timer);
      timer = setTimeout(() => stuck.abort(), STUCK_MS);
      buffer += chunk;
      const lines = buffer.split("\0");
      buffer = lines.pop();
      for (const line of lines) each(line);
    }
    const status = await child.status;
    return !status.signal && !signal.aborted && !stuck.signal.aborted;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
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
