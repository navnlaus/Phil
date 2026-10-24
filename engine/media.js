// What kind of media a file is (a song: "audio"), by its name, the ones of a kind in a folder,
// and images the webview can't decode (HEIC, TIFF, ...) converted for it.
// Shared by phil, imageview and videoplayer.
import { dirname, extname, join } from "@std/path";
import { httpError, text } from "./http.js";

const IMAGE_EXT = new Set([
  "jpg", "jpeg", "jpe", "jfif", "png", "gif", "webp", "avif", "heic", "heif",
  "jxl", "tif", "tiff", "bmp", "svg", "ico", "jp2",
]);
const VIDEO_EXT = new Set([
  "mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "flv", "mpg", "mpeg",
  "m2ts", "mts", "ts", "3gp", "ogv", "vob",
]);

const AUDIO_EXT = new Set(["mp3", "m4a", "aac", "flac", "ogg", "oga", "opus", "wav", "wma", "alac", "aif", "aiff", "ape", "wv", "mka"]);

/** "image", "video", "audio", "pdf" or "file". */
export function mediaKind(name) {
  const ext = extname(name).slice(1).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  return "file";
}

/**
 * GET /preview?path=&size=: the image as a JPEG at most `size` pixels on its
 * longer side, made by vips, for formats the webview can't show itself.
 */
export async function imagePreview(path, size) {
  if (!/^\d{2,5}$/.test(size ?? "")) return text(400, "Bad size");
  const child = new Deno.Command("vips", {
    args: ["thumbnail", path, ".jpg[Q=88]", size, "--size", "down"],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const out = await child.output();
  if (!out.success) return text(415, "Can't decode image");
  return new Response(out.stdout, { headers: { "content-type": "image/jpeg", "cache-control": "no-cache" } });
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * The files of `kind` ("image", "video") in `path`'s folder (or in `path`, a
 * folder): {dir, items: [{path, name, size, mtime}], index} with `index` the
 * one asked for. Sorted like phil sorts: by name (numbers in order), date or
 * size (largest first), or type. Hidden ones only when it's the one asked for.
 */
export async function mediaInFolder(path, kind, sort = "name") {
  const stat = await Deno.stat(path).catch(() => null);
  if (!stat) throw httpError(404, `${path} doesn't exist`);
  const dir = stat.isDirectory ? path : dirname(path);
  const items = [];
  for await (const d of Deno.readDir(dir)) {
    const file = join(dir, d.name);
    if (file !== path && (d.name.startsWith(".") || mediaKind(d.name) !== kind)) continue;
    const s = file === path ? stat : await Deno.stat(file).catch(() => null);
    if (s?.isFile) items.push({ path: file, name: d.name, size: s.size, mtime: s.mtime?.getTime() ?? 0 });
  }
  const ext = (name) => name.slice(name.lastIndexOf(".") + 1);
  const by = {
    mtime: (a, b) => b.mtime - a.mtime,
    size: (a, b) => b.size - a.size,
    kind: (a, b) => collator.compare(ext(a.name), ext(b.name)),
  }[sort];
  items.sort((a, b) => by?.(a, b) || collator.compare(a.name, b.name));
  return { dir, items, index: Math.max(0, items.findIndex((i) => i.path === path)) };
}
