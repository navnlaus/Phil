import { join } from "@std/path";
import { mediaKind } from "../../engine/media.js";

export { mediaKind };

async function exists(path) {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// A file's content, in short: its size and three samples (start, middle, end),
// hashed. Enough to know a copy, a move or a rename of a file again (its path,
// which the cache key has, is new) for a few small reads: 5–35 ms on a slow
// drive, against seconds for making its thumbnail again. An edit changes the
// size, the start (where most formats keep what tag editors change) or the end.
const SAMPLE = 64 * 1024;
export async function fingerprint(path, size) {
  const file = await Deno.open(path);
  try {
    const parts = [new TextEncoder().encode(`${size}\0`)];
    for (const at of new Set([0, Math.max(0, Math.floor(size / 2) - SAMPLE / 2), Math.max(0, size - SAMPLE)])) {
      await file.seek(at, Deno.SeekMode.Start);
      const buf = new Uint8Array(Math.min(SAMPLE, size - at));
      let n = 0;
      while (n < buf.length) {
        const got = await file.read(buf.subarray(n));
        if (!got) break;
        n += got;
      }
      parts.push(buf.subarray(0, n));
    }
    const all = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
    let o = 0;
    for (const p of parts) all.set(p, o), (o += p.length);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
    return Array.from(hash.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  } finally {
    file.close();
  }
}

// `to` made the same file as `from` (a hard link: no copy, no space; a copy
// where linking can't): false if there's no `from`.
async function share(from, to) {
  try {
    await Deno.link(from, to);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.AlreadyExists) return true;
    if (err instanceof Deno.errors.NotFound) return false;
    try {
      await Deno.copyFile(from, to);
      return true;
    } catch {
      return false;
    }
  }
}

// Thumbnails living in a .thumbnails folder are small JPEGs already; they are
// shown as themselves rather than thumbnailed again.
const insideThumbnailFolder = (path) => path.includes("/.thumbnails/");
const fileUrl = (path) => `/file?path=${encodeURIComponent(path)}`;

/**
 * Thumbnail cache: <thumbDir>/<W>x<H>/<key>.jpg, where key hashes path + size
 * + mtime, so edited files get fresh thumbnails. Each is also filed by its
 * content (<W>x<H>/by-content/<fingerprint>.jpg, the same file, hard-linked), so
 * a copy, move or rename finds it: when a file has none under its key, its
 * fingerprint is looked up before one is made. phil's own copies, moves and
 * renames link theirs straight away (carry), with no reads at all. (Incognito's thumbDir is in
 * memory: see serverConfig in launch.js.) Files that fail to thumbnail get an
 * empty <key>.fail marker so they aren't retried. Thumbnails are 16:9, scaled
 * to cover and center-cropped.
 *
 * Jobs run on a LIFO stack: the most recently requested thumbnails (what the
 * user is looking at now) are generated first, and jobs nobody waits for any
 * more are dropped before they start. Files on the system's own drive get all
 * the jobs at once; on any other (USB drives, other disks, network shares: often
 * slow) as many as its speed allows: with a speed test (Properties), one per
 * MBPS_PER_JOB of its read speed (a spinning disk at most SLOW_DRIVE_JOBS: it
 * seeks between files, which a straight read doesn't measure); without one,
 * SLOW_DRIVE_JOBS, since more only get in each other's way on a slow drive.
 * A thumbnail that takes longer than JOB_TIMEOUT_MS is given up on (and marked
 * failed), so a file that hangs its decoder can't hold a job forever.
 */
const SLOW_DRIVE_JOBS = 3;
// Pictures go to vipsthumbnail several at a time: starting it takes ~55 ms (it
// loads its modules), more than half of a 12 MP picture's ~90 ms, so one run for
// 6 makes them about twice as fast. A batch is one job slot.
const BATCH = 6;
// In the background (a folder's thumbnails not on screen), runs are kept
// shorter: one on screen asked for meanwhile waits for the run to end.
const BACKGROUND_BATCH = 3;
// A file being written (a download, a copy, a recording) isn't thumbnailed
// yet: every write would make another, of a half-written file (a torrent's
// pieces come in any order), and a folder showing it would change its picture
// every moment. Its last thumbnail shows meanwhile, if it had one. A file just
// saved waits QUIET_MS; one seen changing between two looks waits until it's
// been left alone WRITING_MS.
const QUIET_MS = 1500;
const WRITING_MS = 30_000;
const MBPS_PER_JOB = 30;
const JOB_TIMEOUT_MS = 60_000;
export class Thumbnailer {
  /** `driveSpeed(path)`: {read (MB/s), rotational} of the drive a file is on, or null. */
  constructor({ thumbDir, thumbSize, jobs, driveSpeed = async () => null }) {
    this.driveSpeed = driveSpeed;
    this.limits = new Map(); // device -> jobs at once
    this.width = thumbSize;
    this.height = Math.round((thumbSize * 9) / 16);
    this.name = `${this.width}x${this.height}`;
    this.dir = join(thumbDir, this.name);
    this.contentDir = join(this.dir, "by-content");
    this.concurrency = jobs;
    this.stack = [];
    this.jobs = new Map();
    this.running = 0;
    this.runningBackground = 0; // of them, made in the background (get's `background`)
    this.latest = new Map(); // path -> URL of the last thumbnail it had (shown while it's being written)
    this.looks = new Map(); // path -> its size and time when last looked at, while it's recent (busyFor)
    this.writing = new Set(); // paths seen changing between two looks
    this.runningOn = new Map(); // device -> jobs running on it
    this.systemDevice = null; // the device "/" is on: all the jobs at once
  }

  async key(path, stat) {
    const data = new TextEncoder().encode(`${path}\0${stat.size}\0${stat.mtime?.getTime() ?? 0}`);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    return Array.from(hash.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  url(key) {
    return `/thumbs/${this.name}/${key}.jpg`;
  }

  /** The file behind a /thumbs URL, or null if it isn't one of ours. */
  fileFor(name) {
    return /^[0-9a-f]{32}\.jpg$/.test(name) ? join(this.dir, name) : null;
  }

  /** Cached thumbnail URL, false if it failed before, null if not generated yet. */
  async lookup(path, stat) {
    if (insideThumbnailFolder(path)) return fileUrl(path);
    const key = await this.key(path, stat);
    const thumb = await Deno.stat(join(this.dir, key + ".jpg")).catch(() => null);
    if (thumb) {
      // Made before thumbnails were filed by content (only one link to it): filed now, in the background.
      if (thumb.nlink === 1) this.fileLater({ key, path, size: stat.size, dev: stat.dev });
      return this.remember(path, this.url(key));
    }
    const known = await this.lookupKey(key);
    return known === null && this.busyFor(path, stat) ? this.latest.get(path) ?? null : known;
  }

  // How long until `path` counts as settled (0: it is): see QUIET_MS.
  busyFor(path, stat) {
    const mtime = stat.mtime?.getTime() ?? 0, since = Date.now() - mtime, look = `${stat.size} ${mtime}`;
    if (since < QUIET_MS) {
      if (this.looks.has(path) && this.looks.get(path) !== look) this.writing.add(path);
      this.looks.set(path, look);
      if (this.looks.size > 5000) this.looks.delete(this.looks.keys().next().value);
    }
    if (this.writing.has(path)) {
      if (since < WRITING_MS) return WRITING_MS - since;
      this.writing.delete(path);
      this.looks.delete(path);
      return 0;
    }
    return Math.max(0, QUIET_MS - since);
  }

  // The last thumbnail `path` had: what it shows while it's being written.
  remember(path, url) {
    this.latest.delete(path);
    this.latest.set(path, url);
    if (this.latest.size > 20_000) this.latest.delete(this.latest.keys().next().value); // the longest unseen
    return url;
  }

  // Thumbnails made before they were filed by content get filed as their folders
  // are looked at: their files' fingerprints read one at a time, only while no
  // thumbnail is being made (a slow drive isn't asked for two things at once).
  fileLater(item) {
    this.toFile ??= new Map();
    if (this.toFile.has(item.key) || this.toFile.size > 5000) return;
    this.toFile.set(item.key, item);
    if (this.filing) return;
    this.filing = (async () => {
      while (this.toFile.size) {
        while (this.running) await new Promise((r) => setTimeout(r, 1000));
        const [key, { path, size }] = this.toFile.entries().next().value;
        this.toFile.delete(key);
        const fp = await fingerprint(path, size).catch(() => null);
        if (fp) {
          await Deno.mkdir(this.contentDir, { recursive: true }).catch(() => {});
          await share(join(this.dir, key + ".jpg"), join(this.contentDir, fp + ".jpg"));
        }
      }
      this.filing = null;
    })();
  }

  async lookupKey(key) {
    if (await exists(join(this.dir, key + ".jpg"))) return this.url(key);
    if (await exists(join(this.dir, key + ".fail"))) return false;
    return null;
  }

  /**
   * Resolves to the thumbnail URL, generating it if needed. `background`: for
   * one not on screen, made only while nothing on screen waits, one run at a
   * time, at the lowest priority.
   */
  async get(path, signal, { background = false } = {}) {
    const kind = mediaKind(path);
    if (kind === "file") throw new Error("not a media file");
    if (insideThumbnailFolder(path)) return fileUrl(path);
    const stat = await Deno.stat(path);
    const key = await this.key(path, stat);
    const cached = await this.lookupKey(key);
    if (cached) return this.remember(path, cached);
    if (cached === false) throw new Error("thumbnailing failed earlier");
    signal?.throwIfAborted();
    const wait = this.busyFor(path, stat);
    if (wait) { // being written: its last thumbnail, or none yet (asked again in `retryIn` ms, when it may have settled)
      const last = this.latest.get(path);
      if (last) return last;
      throw Object.assign(new Error(`still being written (${path})`), { busy: true, retryIn: wait + 200 });
    }

    this.systemDevice ??= (await Deno.stat("/").catch(() => null))?.dev ?? -1;
    await this.learnLimit(stat.dev, path);
    let job = this.jobs.get(key);
    if (!job) {
      job = { id: key, key, path, kind, dev: stat.dev, size: stat.size, background, waiters: 0, started: false, ...Promise.withResolvers() };
      job.promise.catch(() => {});
      this.jobs.set(key, job);
      this.stack.push(job);
    } else if (!background && job.background && !job.started) { // now on screen: no longer behind the others
      job.background = false;
      this.stack.push(...this.stack.splice(this.stack.indexOf(job), 1));
    }
    job.waiters++;
    this.pump();
    try {
      return this.remember(path, await abortable(job.promise, signal));
    } finally {
      if (--job.waiters === 0 && !job.started) {
        this.stack.splice(this.stack.indexOf(job), 1);
        this.jobs.delete(job.id);
      }
    }
  }

  // How many jobs at once a drive gets (see the top), worked out from its
  // speed test once (which drive a file is on and its last test: two commands)
  // and kept: until forgetLimits() (after a new speed test). A drive plugged in
  // again is another device, worked out afresh.
  async learnLimit(dev, path) {
    if (dev === this.systemDevice || this.limits.has(dev)) return;
    this.limits.set(dev, SLOW_DRIVE_JOBS); // meanwhile (and when asking fails)
    const speed = await this.driveSpeed(path).catch(() => null);
    if (speed?.read) this.limits.set(dev, Math.max(1, Math.min(this.concurrency, Math.round(speed.read / MBPS_PER_JOB), speed.rotational ? SLOW_DRIVE_JOBS : Infinity)));
  }

  /**
   * After phil copied, moved or renamed `from` to `to` (a file, or a folder
   * and all in it): their thumbnails go along, linked under the new paths (a
   * copy keeps its size and time, so only the path in the key is new). In the
   * background; nothing is read but the files' sizes and times.
   */
  async carry(from, to) {
    const walk = async (path, rel, depth) => {
      const st = await Deno.stat(path).catch(() => null);
      if (!st) return;
      if (st.isDirectory) {
        if (depth > 20) return;
        for await (const e of Deno.readDir(path)) await walk(join(path, e.name), `${rel}/${e.name}`, depth + 1);
        return;
      }
      if (mediaKind(path) === "file") return;
      const [old, now] = await Promise.all([this.key(from + rel, st), this.key(path, st)]);
      await share(join(this.dir, old + ".jpg"), join(this.dir, now + ".jpg"));
    };
    await walk(to, "", 0);
  }

  /**
   * Content entries no thumbnail shares any more (its files deleted, their
   * thumbnails forgotten): removed, now and then.
   */
  async pruneContent() {
    try {
      for await (const e of Deno.readDir(this.contentDir)) {
        const path = join(this.contentDir, e.name);
        if (e.name.endsWith(".jpg") && (await Deno.stat(path).catch(() => null))?.nlink === 1) await Deno.remove(path).catch(() => {});
      }
    } catch { /* none yet */ }
  }

  /** A drive's speed was tested again: every drive's limit is worked out afresh. */
  forgetLimits() {
    this.limits.clear();
  }

  // The newest job whose drive has room, while there's room overall. One made
  // in the background only when no other waits, and one at a time.
  pump() {
    const limit = (dev) => (dev === this.systemDevice ? this.concurrency : Math.min(this.concurrency, this.limits.get(dev) ?? SLOW_DRIVE_JOBS));
    const room = (dev) => (this.runningOn.get(dev) ?? 0) < limit(dev);
    while (this.running < this.concurrency) {
      const backgroundToo = !this.runningBackground && !this.stack.some((j) => !j.background);
      let i = this.stack.length - 1;
      while (i >= 0 && (!room(this.stack[i].dev) || (this.stack[i].background && !backgroundToo))) i--;
      if (i < 0) break;
      const [job] = this.stack.splice(i, 1);
      // A picture takes the newest others on its drive along (their names apart: vips names its outputs by them),
      // as background as it is: fewer in the background, so one on screen soon gets its turn.
      const batch = [job];
      if (job.kind === "image") {
        const stems = new Set([stemOf(job.path)]);
        for (let j = this.stack.length - 1; j >= 0 && batch.length < (job.background ? BACKGROUND_BATCH : BATCH); j--) {
          const other = this.stack[j];
          if (other.kind !== "image" || other.dev !== job.dev || other.background !== job.background || stems.has(stemOf(other.path))) continue;
          stems.add(stemOf(other.path));
          batch.push(...this.stack.splice(j, 1));
        }
      }
      for (const b of batch) b.started = true;
      this.running++;
      if (job.background) this.runningBackground++;
      this.runningOn.set(job.dev, (this.runningOn.get(job.dev) ?? 0) + 1);
      (batch.length > 1 ? this.generateBatch(batch) : this.generate(job).then(job.resolve, job.reject))
        .finally(() => {
          this.running--;
          if (job.background) this.runningBackground--;
          this.runningOn.set(job.dev, this.runningOn.get(job.dev) - 1);
          for (const b of batch) this.jobs.delete(b.id);
          this.pump();
        });
    }
  }

  // The same file elsewhere (a copy, before a move or a rename) has a
  // thumbnail already: its URL; or failed already: throws. Null: none.
  async fromContent(job) {
    const { key, path, size } = job;
    await Deno.mkdir(this.contentDir, { recursive: true });
    job.fp ??= await fingerprint(path, size).catch(() => null);
    const byContent = job.fp && join(this.contentDir, job.fp);
    if (job.fp && await share(byContent + ".jpg", join(this.dir, key + ".jpg"))) return this.url(key);
    if (job.fp && await exists(byContent + ".fail")) {
      await Deno.writeFile(join(this.dir, key + ".fail"), new Uint8Array()).catch(() => {});
      throw new Error(`thumbnailing failed earlier, as another copy (${path})`);
    }
    return null;
  }

  // Made: kept under its key, and filed by its content.
  async keep(job, made) {
    await Deno.rename(made, join(this.dir, job.key + ".jpg"));
    if (job.fp) await share(join(this.dir, job.key + ".jpg"), join(this.contentDir, job.fp + ".jpg"));
    return this.url(job.key);
  }

  // Pictures, one vipsthumbnail run for all (each settled on its own). One it
  // didn't make (a broken file stops the run) is tried again alone, so it
  // fails alone.
  async generateBatch(jobs) {
    const todo = [];
    for (const job of jobs) {
      const url = await this.fromContent(job).catch((err) => (job.reject(err), undefined));
      if (url) job.resolve(url);
      else if (url === null) todo.push(job);
    }
    if (todo.length < 2) return todo[0] && this.generate(todo[0]).then(todo[0].resolve, todo[0].reject);
    const id = crypto.randomUUID().slice(0, 8);
    const out = (job) => join(this.dir, `${stemOf(job.path)}.${id}.tmp.jpg`);
    await run("vipsthumbnail", [...todo.map((j) => j.path), "--size", this.name, "--smartcrop", "centre", "-o", join(this.dir, `%s.${id}.tmp.jpg[Q=82,keep=none]`)], null, jobs[0].background)
      .catch(() => {}); // what it didn't make is made alone, below
    await Promise.all(todo.map(async (job) => {
      if (await exists(out(job))) return job.resolve(await this.keep(job, out(job)));
      await this.generate(job).then(job.resolve, job.reject);
    }));
  }

  async generate(job) {
    const { key, path, kind } = job;
    const dir = this.dir;
    const known = await this.fromContent(job);
    if (known) return known;
    const fp = job.fp;
    const byContent = fp && join(this.contentDir, fp);
    const tmp = (suffix) => join(dir, `${key}.${crypto.randomUUID().slice(0, 8)}.tmp${suffix}.jpg`);
    const dest = tmp("");
    const frame = kind === "video" ? tmp(".frame") : null;
    try {
      if (frame) {
        // Grab a frame large enough that even portrait video still covers the 16:9 box.
        await run("ffmpegthumbnailer", ["-i", path, "-o", frame, "-s", String(this.width * 2), "-q", "9", "-c", "jpeg"], frame, job.background);
      }
      // A PDF (vips renders its first page) is cropped from the top, so its
      // title and headings show; everything else around the middle.
      await run("vipsthumbnail", [
        frame ?? path, "--size", this.name, "--smartcrop", kind === "pdf" ? "low" : "centre", "-o", `${dest}[Q=82,keep=none]`,
      ], dest, job.background);
      return await this.keep(job, dest);
    } catch (err) {
      await Deno.remove(dest).catch(() => {});
      await Deno.writeFile(join(dir, key + ".fail"), new Uint8Array()).catch(() => {});
      if (fp) await Deno.writeFile(byContent + ".fail", new Uint8Array()).catch(() => {});
      throw new Error(`${err.message} (${path})`);
    } finally {
      if (frame) await Deno.remove(frame).catch(() => {});
    }
  }
}

// The file name without its folder or extension: what vipsthumbnail's %s is.
const stemOf = (path) => path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]*$/, "");

// Runs a thumbnailing command at a lower priority (nice): it gets the CPU the
// windows don't need, so they don't stutter while a folder's thumbnails are
// made. `output`: the file it must have made (null: not checked here).
// `idle`: made in the background: the lowest CPU priority, and the drive
// only when nothing else wants it (ionice's idle class).
async function run(cmd, args, output, idle = false) {
  const signal = AbortSignal.timeout(JOB_TIMEOUT_MS); // killed then: see JOB_TIMEOUT_MS
  const result = await new Deno.Command("nice", { args: idle ? ["-n", "19", "ionice", "-c", "3", cmd, ...args] : ["-n", "10", cmd, ...args], stdin: "null", stdout: "null", stderr: "piped", signal }).output().catch((err) => {
    throw signal.aborted ? new Error(`${cmd} took longer than ${JOB_TIMEOUT_MS / 1000} s`) : err;
  });
  if (signal.aborted) throw new Error(`${cmd} took longer than ${JOB_TIMEOUT_MS / 1000} s`);
  if (!result.success || (output && !(await exists(output)))) {
    const msg = new TextDecoder().decode(result.stderr).split("\n").filter((l) => l && !l.includes("WARNING")).at(-1);
    throw new Error(`${cmd} failed: ${msg ?? "no output"}`);
  }
}
