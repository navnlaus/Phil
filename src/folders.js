import { extname, join } from "@std/path";

const PREVIEWS = 4;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * What a folder holds, for its tile in the parent folder: how many files and
 * folders, the files' total size, and the thumbnails of its first four images
 * or videos in the view's sort order. Saved with the folder's modification time
 * and that sort order; when either has changed, the summary is out of date and
 * the page asks for a new one (see `summarize` in server.js).
 *
 * Stored next to the thumbnails they point at, <thumbs>/folders/<hash>.json,
 * so clearing the thumbnail cache clears these too. Without a directory
 * (incognito) they are kept in memory for the session only.
 */
export class FolderSummaries {
  constructor(dir) {
    this.dir = dir;
    this.memory = new Map(); // path -> summary, when there's no dir
  }

  async file(path) {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path)));
    return join(this.dir, Array.from(hash.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("") + ".json");
  }

  /** The summary saved for `path`, or null. */
  async get(path) {
    if (!this.dir) return this.memory.get(path) ?? null;
    try {
      return JSON.parse(await Deno.readTextFile(await this.file(path)));
    } catch {
      return null;
    }
  }

  async save(path, summary) {
    if (!this.dir) return void this.memory.set(path, summary);
    const file = await this.file(path);
    await Deno.mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(summary));
    await Deno.rename(tmp, file); // atomic: another phil may be reading it
  }

  /** A folder was renamed: its summary goes with it. */
  async moved(from, to) {
    const summary = await this.get(from);
    if (summary) await this.save(to, summary);
  }
}

/**
 * A summary of a folder's `entries` (read at `mtime`). `thumbOf(entry)` gives
 * the thumbnail URL of one of the first four images/videos in `sort` order:
 * a string, or null/false when there is none (yet). `complete` is false when a
 * thumbnail wasn't generated yet, so the page asks again later.
 */
export async function makeSummary({ entries, mtime, sort, thumbOf }) {
  const files = entries.filter((e) => e.kind !== "dir");
  const first = firstMedia(files, sort);
  const thumbs = await Promise.all(first.map(thumbOf));
  return {
    mtime,
    sort,
    files: files.length,
    dirs: entries.length - files.length,
    size: files.reduce((sum, e) => sum + e.size, 0),
    previews: thumbs.filter((t) => typeof t === "string"),
    complete: !thumbs.includes(null),
  };
}

// The first images/videos as the page would list them (see sortEntries in
// ui/app.js), hidden files left out.
function firstMedia(files, sort) {
  const ext = (e) => extname(e.name).toLowerCase();
  const by = {
    name: (a, b) => collator.compare(a.name, b.name),
    mtime: (a, b) => b.mtime - a.mtime,
    size: (a, b) => b.size - a.size,
    kind: (a, b) => collator.compare(a.kind, b.kind) || collator.compare(ext(a), ext(b)),
  }[sort] ?? (() => 0);
  return files
    .filter((e) => (e.kind === "image" || e.kind === "video") && !e.name.startsWith("."))
    .sort((a, b) => by(a, b) || collator.compare(a.name, b.name))
    .slice(0, PREVIEWS);
}
