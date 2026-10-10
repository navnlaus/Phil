import { extname, join } from "@std/path";

const IMAGE_EXT = new Set([
  "jpg", "jpeg", "jpe", "jfif", "png", "gif", "webp", "avif", "heic", "heif",
  "jxl", "tif", "tiff", "bmp", "svg", "ico", "jp2",
]);
const VIDEO_EXT = new Set([
  "mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "flv", "mpg", "mpeg",
  "m2ts", "mts", "ts", "3gp", "ogv", "vob",
]);

export function mediaKind(name) {
  const ext = extname(name).slice(1).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  return "file";
}

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

/**
 * Thumbnail cache in its own directory: <thumbDir>/<W>x<H>/<key>.jpg, where key
 * hashes path + size + mtime, so edited files get fresh thumbnails. Files that
 * fail to thumbnail get an empty <key>.fail marker so they aren't retried.
 * Thumbnails are 16:9, scaled to cover and center-cropped.
 *
 * Jobs run on a LIFO stack: the most recently requested thumbnails (what the
 * user is looking at now) are generated first, and jobs nobody waits for any
 * more are dropped before they start.
 */
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
    this.ready = Deno.mkdir(this.dir, { recursive: true });
  }

  async key(path, stat) {
    const data = new TextEncoder().encode(`${path}\0${stat.size}\0${stat.mtime?.getTime() ?? 0}`);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    return Array.from(hash.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  url(key) {
    return `/thumbs/${this.name}/${key}.jpg`;
  }

  fileFor(name) {
    return /^[0-9a-f]{32}\.jpg$/.test(name) ? join(this.dir, name) : null;
  }

  /** Cached thumbnail URL, false if it failed before, null if not generated yet. */
  async lookup(path, stat) {
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
    const stat = await Deno.stat(path);
    const key = await this.key(path, stat);
    const cached = await this.lookupKey(key);
    if (cached) return cached;
    if (cached === false) throw new Error("thumbnailing failed earlier");
    signal?.throwIfAborted();

    let job = this.jobs.get(key);
    if (!job) {
      job = { key, path, kind, waiters: 0, started: false, ...Promise.withResolvers() };
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
        this.jobs.delete(key);
      }
    }
  }

  pump() {
    while (this.running < this.concurrency && this.stack.length) {
      const job = this.stack.pop();
      job.started = true;
      this.running++;
      this.generate(job)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.running--;
          this.jobs.delete(job.key);
          this.pump();
        });
    }
  }

  async generate({ key, path, kind }) {
    await this.ready;
    const tmp = (suffix) => join(this.dir, `${key}.${crypto.randomUUID().slice(0, 8)}.tmp${suffix}.jpg`);
    const dest = tmp("");
    const frame = kind === "video" ? tmp(".frame") : null;
    try {
      if (frame) {
        // Grab a frame large enough that even portrait video still covers the 16:9 box.
        await run("ffmpegthumbnailer", ["-i", path, "-o", frame, "-s", String(this.width * 2), "-q", "9", "-c", "jpeg"], frame);
      }
      await run("vipsthumbnail", [
        frame ?? path, "--size", this.name, "--smartcrop", "centre", "-o", `${dest}[Q=82,keep=none]`,
      ], dest);
      await Deno.rename(dest, join(this.dir, key + ".jpg"));
      return this.url(key);
    } catch (err) {
      await Deno.remove(dest).catch(() => {});
      await Deno.writeFile(join(this.dir, key + ".fail"), new Uint8Array());
      throw new Error(`${err.message} (${path})`);
    } finally {
      if (frame) await Deno.remove(frame).catch(() => {});
    }
  }
}

async function run(cmd, args, output) {
  const result = await new Deno.Command(cmd, { args, stdin: "null", stdout: "null", stderr: "piped" }).output();
  if (!result.success || !(await exists(output))) {
    const msg = new TextDecoder().decode(result.stderr).split("\n").filter((l) => l && !l.includes("WARNING")).at(-1);
    throw new Error(`${cmd} failed: ${msg ?? "no output"}`);
  }
}
