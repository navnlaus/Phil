import { basename, dirname, extname, join } from "@std/path";

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

// FNV-1a, for naming scratch folders; not security relevant.
function shortHash(s) {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(s)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

// Thumbnails living in a .thumbnails folder are small JPEGs already; they are
// shown as themselves rather than thumbnailed again.
const insideThumbnailFolder = (path) => path.includes("/.thumbnails/");
const fileUrl = (path) => `/file?path=${encodeURIComponent(path)}`;

/**
 * Thumbnail cache. Normally one directory: <thumbDir>/<W>x<H>/<key>.jpg, where
 * key hashes path + size + mtime, so edited files get fresh thumbnails.
 * Without a thumbDir (incognito) each folder keeps its own:
 * <folder>/.thumbnails/<W>x<H>/<key>.jpg, keyed by file name instead of full
 * path so they stay valid when the folder moves; folders that can't be written
 * to use the same layout under scratchDir. Files that fail to thumbnail get an
 * empty <key>.fail marker so they aren't retried. Thumbnails are 16:9, scaled
 * to cover and center-cropped.
 *
 * Jobs run on a LIFO stack: the most recently requested thumbnails (what the
 * user is looking at now) are generated first, and jobs nobody waits for any
 * more are dropped before they start.
 */
export class Thumbnailer {
  constructor({ thumbDir, thumbSize, jobs, scratchDir }) {
    this.width = thumbSize;
    this.height = Math.round((thumbSize * 9) / 16);
    this.name = `${this.width}x${this.height}`;
    this.perFolder = !thumbDir;
    this.dir = thumbDir ? join(thumbDir, this.name) : null;
    this.scratchDir = scratchDir;
    this.concurrency = jobs;
    this.stack = [];
    this.jobs = new Map();
    this.running = 0;
  }

  /** Directories a thumbnail of `path` may be stored in, preferred first. */
  dirsFor(path) {
    if (!this.perFolder) return [this.dir];
    const folder = dirname(path);
    return [join(folder, ".thumbnails", this.name), join(this.scratchDir, shortHash(folder), ".thumbnails", this.name)];
  }

  async key(path, stat) {
    const id = this.perFolder ? basename(path) : path;
    const data = new TextEncoder().encode(`${id}\0${stat.size}\0${stat.mtime?.getTime() ?? 0}`);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    return Array.from(hash.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  url(key, dir) {
    const url = `/thumbs/${this.name}/${key}.jpg`;
    return this.perFolder ? `${url}?dir=${encodeURIComponent(dir)}` : url;
  }

  /** The file behind a /thumbs URL, or null if it isn't one of ours. */
  fileFor(name, dir) {
    if (!/^[0-9a-f]{32}\.jpg$/.test(name)) return null;
    if (!this.perFolder) return join(this.dir, name);
    const ok = dir?.startsWith("/") && basename(dir) === this.name && basename(dirname(dir)) === ".thumbnails";
    return ok ? join(dir, name) : null;
  }

  /** Cached thumbnail URL, false if it failed before, null if not generated yet. */
  async lookup(path, stat) {
    if (insideThumbnailFolder(path)) return fileUrl(path);
    return this.lookupKey(await this.key(path, stat), path);
  }

  async lookupKey(key, path) {
    for (const dir of this.dirsFor(path)) {
      if (await exists(join(dir, key + ".jpg"))) return this.url(key, dir);
      if (await exists(join(dir, key + ".fail"))) return false;
    }
    return null;
  }

  /** Resolves to the thumbnail URL, generating it if needed. */
  async get(path, signal) {
    const kind = mediaKind(path);
    if (kind === "file") throw new Error("not a media file");
    if (insideThumbnailFolder(path)) return fileUrl(path);
    const stat = await Deno.stat(path);
    const key = await this.key(path, stat);
    const cached = await this.lookupKey(key, path);
    if (cached) return cached;
    if (cached === false) throw new Error("thumbnailing failed earlier");
    signal?.throwIfAborted();

    const id = join(this.dirsFor(path)[0], key); // per-folder keys are only unique within a folder
    let job = this.jobs.get(id);
    if (!job) {
      job = { id, key, path, kind, waiters: 0, started: false, ...Promise.withResolvers() };
      job.promise.catch(() => {});
      this.jobs.set(id, job);
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

  pump() {
    while (this.running < this.concurrency && this.stack.length) {
      const job = this.stack.pop();
      job.started = true;
      this.running++;
      this.generate(job)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.running--;
          this.jobs.delete(job.id);
          this.pump();
        });
    }
  }

  // The first of dirsFor(path) that exists or can be created.
  async writableDir(path) {
    for (const dir of this.dirsFor(path)) {
      try {
        await Deno.mkdir(dir, { recursive: true });
        return dir;
      } catch { /* read-only or no permission: try the next one */ }
    }
    throw new Error(`no writable thumbnail folder for ${path}`);
  }

  async generate({ key, path, kind }) {
    const dir = await this.writableDir(path);
    const tmp = (suffix) => join(dir, `${key}.${crypto.randomUUID().slice(0, 8)}.tmp${suffix}.jpg`);
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
      await Deno.rename(dest, join(dir, key + ".jpg"));
      return this.url(key, dir);
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
  const result = await new Deno.Command(cmd, { args, stdin: "null", stdout: "null", stderr: "piped" }).output();
  if (!result.success || !(await exists(output))) {
    const msg = new TextDecoder().decode(result.stderr).split("\n").filter((l) => l && !l.includes("WARNING")).at(-1);
    throw new Error(`${cmd} failed: ${msg ?? "no output"}`);
  }
}
