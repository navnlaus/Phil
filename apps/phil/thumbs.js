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
async function fingerprint(path, size) {
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
      return this.url(key);
    }
    return this.lookupKey(key);
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

  /** Resolves to the thumbnail URL, generating it if needed. */
  async get(path, signal) {
    const kind = mediaKind(path);
    if (kind === "file") throw new Error("not a media file");
    if (insideThumbnailFolder(path)) return fileUrl(path);
    const stat = await Deno.stat(path);
    const key = await this.key(path, stat);
    const cached = await this.lookupKey(key);
    if (cached) return cached;
    if (cached === false) throw new Error("thumbnailing failed earlier");
    signal?.throwIfAborted();

    this.systemDevice ??= (await Deno.stat("/").catch(() => null))?.dev ?? -1;
    await this.learnLimit(stat.dev, path);
    let job = this.jobs.get(key);
    if (!job) {
      job = { id: key, key, path, kind, dev: stat.dev, size: stat.size, waiters: 0, started: false, ...Promise.withResolvers() };
      job.promise.catch(() => {});
      this.jobs.set(key, job);
      this.stack.push(job);
    }
    job.waiters++;
    this.pump();
    try {
      return await abortable(job.promise, signal);
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

  // The newest job whose drive has room, while there's room overall.
  pump() {
    const limit = (dev) => (dev === this.systemDevice ? this.concurrency : Math.min(this.concurrency, this.limits.get(dev) ?? SLOW_DRIVE_JOBS));
    const room = (dev) => (this.runningOn.get(dev) ?? 0) < limit(dev);
    while (this.running < this.concurrency) {
      let i = this.stack.length - 1;
      while (i >= 0 && !room(this.stack[i].dev)) i--;
      if (i < 0) break;
      const [job] = this.stack.splice(i, 1);
      job.started = true;
      this.running++;
      this.runningOn.set(job.dev, (this.runningOn.get(job.dev) ?? 0) + 1);
      this.generate(job)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.running--;
          this.runningOn.set(job.dev, this.runningOn.get(job.dev) - 1);
          this.jobs.delete(job.id);
          this.pump();
        });
    }
  }

  async generate({ key, path, kind, size }) {
    const dir = this.dir;
    await Deno.mkdir(this.contentDir, { recursive: true });
    // The same file elsewhere (a copy, before a move or a rename) has one already, or failed already.
    const fp = await fingerprint(path, size).catch(() => null);
    const byContent = fp && join(this.contentDir, fp);
    if (fp && await share(byContent + ".jpg", join(dir, key + ".jpg"))) return this.url(key);
    if (fp && await exists(byContent + ".fail")) {
      await Deno.writeFile(join(dir, key + ".fail"), new Uint8Array()).catch(() => {});
      throw new Error(`thumbnailing failed earlier, as another copy (${path})`);
    }
    const tmp = (suffix) => join(dir, `${key}.${crypto.randomUUID().slice(0, 8)}.tmp${suffix}.jpg`);
    const dest = tmp("");
    const frame = kind === "video" ? tmp(".frame") : null;
    try {
      if (frame) {
        // Grab a frame large enough that even portrait video still covers the 16:9 box.
        await run("ffmpegthumbnailer", ["-i", path, "-o", frame, "-s", String(this.width * 2), "-q", "9", "-c", "jpeg"], frame);
      }
      // A PDF (vips renders its first page) is cropped from the top, so its
      // title and headings show; everything else around the middle.
      await run("vipsthumbnail", [
        frame ?? path, "--size", this.name, "--smartcrop", kind === "pdf" ? "low" : "centre", "-o", `${dest}[Q=82,keep=none]`,
      ], dest);
      await Deno.rename(dest, join(dir, key + ".jpg"));
      if (fp) await share(join(dir, key + ".jpg"), byContent + ".jpg");
      return this.url(key);
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

async function run(cmd, args, output) {
  const signal = AbortSignal.timeout(JOB_TIMEOUT_MS); // killed then: see JOB_TIMEOUT_MS
  const result = await new Deno.Command(cmd, { args, stdin: "null", stdout: "null", stderr: "piped", signal }).output().catch((err) => {
    throw signal.aborted ? new Error(`${cmd} took longer than ${JOB_TIMEOUT_MS / 1000} s`) : err;
  });
  if (signal.aborted) throw new Error(`${cmd} took longer than ${JOB_TIMEOUT_MS / 1000} s`);
  if (!result.success || !(await exists(output))) {
    const msg = new TextDecoder().decode(result.stderr).split("\n").filter((l) => l && !l.includes("WARNING")).at(-1);
    throw new Error(`${cmd} failed: ${msg ?? "no output"}`);
  }
}
