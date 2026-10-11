// HTTP helpers for the engine and its apps' servers.
import { extname } from "@std/path";

const CONTENT_TYPES = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml", txt: "text/plain; charset=utf-8", json: "application/json",
  jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", jfif: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", avif: "image/avif", heic: "image/heic", heif: "image/heif",
  jxl: "image/jxl", tif: "image/tiff", tiff: "image/tiff", bmp: "image/bmp", ico: "image/x-icon",
  mp4: "video/mp4", m4v: "video/mp4", mkv: "video/x-matroska", webm: "video/webm", mov: "video/quicktime",
  avi: "video/x-msvideo", wmv: "video/x-ms-wmv", flv: "video/x-flv", mpg: "video/mpeg", mpeg: "video/mpeg",
  m2ts: "video/mp2t", mts: "video/mp2t", ts: "video/mp2t", "3gp": "video/3gpp", ogv: "video/ogg",
};
export const contentType = (path) => CONTENT_TYPES[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream";

/** An error that becomes a response with this status and the message as text. */
export const httpError = (status, message) => Object.assign(new Error(message), { status });

export function json(data) {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}

export function text(status, body) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export function errorResponse(err) {
  if (err instanceof Deno.errors.NotFound) return text(404, "Not found");
  if (err instanceof Deno.errors.PermissionDenied) return text(403, "Permission denied");
  if (err instanceof Deno.errors.NotADirectory) return text(400, "Not a directory");
  if (err.status) return text(err.status, err.message);
  console.error(err);
  return text(500, String(err?.message ?? err));
}

/** A file of an app's ui/ folder (`dir`), e.g. "app.js" or "vendor/x.mjs". */
export async function staticFile(dir, name) {
  if (!/^(vendor\/)?[\w.-]+$/.test(name)) return text(404, "Not found");
  try {
    const body = await Deno.readFile(new URL(name, dir));
    return new Response(body, { headers: { "content-type": contentType(name), "cache-control": "no-cache" } });
  } catch {
    return text(404, "Not found");
  }
}

/** Serves a file from disk, with Range support (video seeking). */
export async function serveFile(req, path, extraHeaders = {}) {
  const stat = await Deno.stat(path);
  if (!stat.isFile) return text(404, "Not a file");
  const size = stat.size;
  let start = 0, end = size - 1, status = 200;
  const headers = {
    "content-type": contentType(path),
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "cache-control": "no-cache",
    ...extraHeaders,
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range")?.trim() ?? "");
  if (range && (range[1] || range[2])) {
    if (range[1] === "") {
      start = Math.max(0, size - Number(range[2]));
    } else {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    }
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    }
    status = 206;
    headers["content-range"] = `bytes ${start}-${end}/${size}`;
  }
  const length = Math.max(0, end - start + 1);
  headers["content-length"] = String(length);
  if (req.method === "HEAD" || length === 0) return new Response(null, { status, headers });

  const file = await Deno.open(path);
  if (start) await file.seek(start, Deno.SeekMode.Start);
  return new Response(rangeStream(file, length), { status, headers });
}

function rangeStream(file, length) {
  let left = length;
  let closed = false;
  const close = () => {
    if (!closed) closed = true, file.close();
  };
  return new ReadableStream({
    async pull(ctrl) {
      const buf = new Uint8Array(Math.min(left, 512 * 1024));
      const n = await file.read(buf);
      if (!n) {
        close();
        return ctrl.close();
      }
      left -= n;
      ctrl.enqueue(buf.subarray(0, n));
      if (left <= 0) {
        close();
        ctrl.close();
      }
    },
    cancel: close,
  });
}
