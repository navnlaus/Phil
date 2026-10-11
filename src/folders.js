import { join } from "@std/path";

const PREVIEWS = 4;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * What a folder held when it was last opened: how many files and folders, the
 * files' total size, and up to four of its cached thumbnails. Its tile in the
 * parent folder shows these; folders never opened have no summary.
 *
 * Stored next to the thumbnails they point at, <thumbs>/folders/<hash>.json,
 * so clearing the thumbnail cache clears these too. Without a directory
 * (incognito) they are kept in memory for the session only.
 */
export class FolderSummaries {
  constructor(dir) {
    this.dir = dir;
    this.memory = new Map(); // path -> summary: every one when there's no dir, else recent ones
  }

  async file(path) {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path)));
    return join(this.dir, Array.from(hash.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("") + ".json");
  }

  /** The summary saved for `path`, or null. */
  async get(path) {
    if (this.memory.has(path) || !this.dir) return this.memory.get(path) ?? null;
    try {
      return JSON.parse(await Deno.readTextFile(await this.file(path)));
    } catch {
      return null;
    }
  }

  /**
   * Records a folder that was just read, with its modification time (when that
   * changes, the summary is out of date). Previews are spread over its media,
   * in name order. Returns the summary.
   */
  async update(path, mtime, entries) {
    const files = entries.filter((e) => e.kind !== "dir");
    const media = entries
      .filter((e) => typeof e.thumb === "string" && !e.name.startsWith("."))
      .sort((a, b) => collator.compare(a.name, b.name));
    const step = media.length / Math.min(PREVIEWS, media.length);
    const summary = {
      mtime,
      files: files.length,
      dirs: entries.length - files.length,
      size: files.reduce((sum, e) => sum + e.size, 0),
      previews: Array.from({ length: Math.min(PREVIEWS, media.length) }, (_, i) => media[Math.floor(i * step)].thumb),
      seen: Date.now(),
    };
    // Kept in memory too, so thumbnails generated while the folder is open can
    // fill up its previews (see addPreview).
    this.memory.delete(path);
    this.memory.set(path, summary);
    if (this.dir && this.memory.size > 200) this.memory.delete(this.memory.keys().next().value);
    await this.save(path, summary);
    return summary;
  }

  /** A folder was renamed: its summary goes with it. */
  async moved(from, to) {
    const summary = await this.get(from);
    if (!summary) return;
    this.memory.delete(from);
    this.memory.set(to, summary);
    await this.save(to, summary);
  }

  /** A thumbnail was just generated for a file in `folder`: use it if the folder has room. */
  async addPreview(folder, url) {
    const summary = this.memory.get(folder);
    if (!summary || summary.previews.length >= PREVIEWS || summary.previews.includes(url)) return;
    summary.previews.push(url);
    await this.save(folder, summary);
  }

  async save(path, summary) {
    if (!this.dir) return;
    const file = await this.file(path);
    await Deno.mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(summary));
    await Deno.rename(tmp, file); // atomic: another phil may be reading it
  }
}
