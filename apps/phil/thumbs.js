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

// Thumbnails living in a .thumbnails folder are small JPEGs already; they are
// shown as themselves rather than thumbnailed again.
const insideThumbnailFolder = (path) => path.includes("/.thumbnails/");
const fileUrl = (path) => `/file?path=${encodeURIComponent(path)}`;

/**
 * Thumbnail cache: <thumbDir>/<W>x<H>/<key>.jpg, where key hashes path + size
 * + mtime, so edited files get fresh thumbnails. (Incognito's thumbDir is in
 * memory: see serverConfig in launch.js.) Files that fail to thumbnail get an
 * empty <key>.fail marker so they aren't retried. Thumbnails are 16:9, scaled
 * to cover and center-cropped.
 *
 * Jobs run on a LIFO stack: the most recently requested thumbnails (what the
 * user is looking at now) are generated first, and jobs nobody waits for any
 * more are dropped before they start. Files on the system's own drive get all
 * the jobs at once; on any other (USB drives, other disks, network shares: often
 * slow) at most SLOW_DRIVE_JOBS, since more only get in each other's way there.
 * A thumbnail that takes longer than JOB_TIMEOUT_MS is given up on (and marked
 * failed), so a file that hangs its decoder can't hold a job forever.
 */
const SLOW_DRIVE_JOBS = 3;
const JOB_TIMEOUT_MS = 60_000;
export class Thumbnailer {
  constructor({ thumbDir, thumbSize, jobs }) {
    this.width = thumbSize;
    this.height = Math.round((thumbSize * 9) / 16);
    this.name = `${this.width}x${this.height}`;
    this.dir = join(thumbDir, this.name);
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
    return this.lookupKey(await this.key(path, stat));
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
    let job = this.jobs.get(key);
    if (!job) {
      job = { id: key, key, path, kind, dev: stat.dev, waiters: 0, started: false, ...Promise.withResolvers() };
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

  // The newest job whose drive has room, while there's room overall.
  pump() {
    const room = (dev) => (this.runningOn.get(dev) ?? 0) < (dev === this.systemDevice ? this.concurrency : Math.min(this.concurrency, SLOW_DRIVE_JOBS));
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

  async generate({ key, path, kind }) {
    const dir = this.dir;
    await Deno.mkdir(dir, { recursive: true });
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
      return this.url(key);
    } catch (err) {
      await Deno.remove(dest).catch(() => {});
      await Deno.writeFile(join(dir, key + ".fail"), new Uint8Array()).catch(() => {});
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
