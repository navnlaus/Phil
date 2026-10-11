// What kind of media a file is, by its name, and images the webview can't
// decode (HEIC, TIFF, ...) converted for it. Shared by phil and imageview.
import { extname } from "@std/path";
import { text } from "./http.js";

const IMAGE_EXT = new Set([
  "jpg", "jpeg", "jpe", "jfif", "png", "gif", "webp", "avif", "heic", "heif",
  "jxl", "tif", "tiff", "bmp", "svg", "ico", "jp2",
]);
const VIDEO_EXT = new Set([
  "mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "flv", "mpg", "mpeg",
  "m2ts", "mts", "ts", "3gp", "ogv", "vob",
]);

/** "image", "video", "pdf" or "file". */
export function mediaKind(name) {
  const ext = extname(name).slice(1).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
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
