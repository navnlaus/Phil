import { dirname, join } from "@std/path";

const MAX_AGE = 10 * 60_000; // ms: a total older than this is worked out again when its tile shows
const RUNNING = 2; // du processes at once
const TIMEOUT = 120_000; // ms, for one folder
const KEEP = 5000; // totals remembered

/**
 * Folders' total sizes, everything in them and in their subfolders (like
 * `du -s`), for their tiles: worked out by du in the background, in bytes
 * (the files' sizes, as on the tiles; on the folder's own file system, so not
 * /proc or a mount inside it). Remembered with the folder's modification time
 * and when it was worked out: a total is out of date when the folder changed
 * since, or after 10 minutes (a change deep inside doesn't touch the folder).
 *
 * Kept in <thumbs>/folder-totals.json; without a directory (incognito) in
 * memory for the session only.
 */
export class FolderTotals {
  constructor(dir) {
    this.file = dir ? join(dir, "folder-totals.json") : null;
    this.totals = new Map(); // path -> { bytes, mtime, at }
    this.queue = []; // folders waiting, the most recently asked for last (done first)
    this.waiting = new Map(); // path -> [callbacks]
    this.running = 0;
    this.loaded = this.file
      ? Deno.readTextFile(this.file).then((t) => (this.totals = new Map(Object.entries(JSON.parse(t)))), () => {})
      : Promise.resolve();
  }

  /** The total known for `path` (bytes), or null; `stale` when it should be worked out again. */
  async get(path, mtime) {
    await this.loaded;
    const known = this.totals.get(path);
    if (!known) return null;
    return { bytes: known.bytes, stale: known.mtime !== mtime || Date.now() - known.at > MAX_AGE };
  }

  /** Folders deleted: `paths` and everything under them are forgotten. */
  forget(paths) {
    let changed = false;
    for (const key of this.totals.keys()) {
      if (paths.some((p) => key === p || key.startsWith(p + "/"))) this.totals.delete(key), (changed = true);
    }
    if (changed) this.save();
  }

  /** Works the total out (again), calling `done(bytes)`, or done(null) if du fails. */
  refresh(path, done) {
    const callbacks = this.waiting.get(path);
    if (callbacks) {
      callbacks.push(done);
      const i = this.queue.indexOf(path);
      if (i !== -1) this.queue.push(...this.queue.splice(i, 1)); // asked again: sooner
      return;
    }
    this.waiting.set(path, [done]);
    this.queue.push(path);
    this.next();
  }

  next() {
    while (this.running < RUNNING && this.queue.length) {
      const path = this.queue.pop();
      this.running++;
      this.measure(path)
        .then((bytes) => {
          for (const done of this.waiting.get(path) ?? []) done(bytes);
        })
        .finally(() => {
          this.waiting.delete(path);
          this.running--;
          this.next();
        });
    }
  }

  async measure(path) {
    const mtime = await Deno.stat(path).then((s) => s.mtime?.getTime() ?? 0, () => null);
    if (mtime === null) return null;
    if (await notWorthIt(path)) return null;
    let out;
    try {
      // -s: one total; -b: bytes, the files' sizes; -x: this file system only. Folders
      // it can't read are left out (du says so on stderr and still gives the rest).
      out = await new Deno.Command("du", {
        args: ["-sbx", "--", path],
        stdin: "null",
        stdout: "piped",
        stderr: "null",
        signal: AbortSignal.timeout(TIMEOUT),
      }).output();
    } catch {
      return null;
    }
    const bytes = parseInt(new TextDecoder().decode(out.stdout));
    if (!Number.isFinite(bytes)) return null;
    this.totals.delete(path);
    this.totals.set(path, { bytes, mtime, at: Date.now() });
    if (this.totals.size > KEEP) this.totals.delete(this.totals.keys().next().value);
    this.save();
    return bytes;
  }

  // Written a moment after the last change, not after each.
  save() {
    if (!this.file) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      const tmp = `${this.file}.${crypto.randomUUID().slice(0, 8)}.tmp`;
      try {
        await Deno.mkdir(dirname(this.file), { recursive: true });
        await Deno.writeTextFile(tmp, JSON.stringify(Object.fromEntries(this.totals)));
        await Deno.rename(tmp, this.file);
      } catch {
        await Deno.remove(tmp).catch(() => {});
      }
    }, 2000);
  }
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
