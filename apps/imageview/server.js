// imageview's server: the images in a folder, the files themselves, and
// images the webview can't decode converted (engine/media.js). Runs in the
// engine's server worker (engine/server.js).
//   GET /api/images?path=&sort=   images()
//   GET /file?path=               the file
//   GET /preview?path=&size=      a JPEG of it, for HEIC, TIFF, ...
import { dirname, join } from "@std/path";
import { httpError, json, serveFile } from "../../engine/http.js";
import { imagePreview, mediaKind } from "../../engine/media.js";

export const UI_DIR = new URL("./ui/", import.meta.url);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function createServer() {
  return {
    async handle(req, url) {
      const path = url.searchParams.get("path");
      switch (`${req.method} ${url.pathname}`) {
        case "GET /api/images":
          return json(await images(absolute(path), url.searchParams.get("sort") ?? "name"));
        case "GET /file":
        case "HEAD /file":
          return serveFile(req, absolute(path), { "content-security-policy": "sandbox" });
        case "GET /preview":
          return await imagePreview(absolute(path), url.searchParams.get("size") ?? "2560");
      }
      return null;
    },
  };
}

function absolute(path) {
  if (!path?.startsWith("/")) throw httpError(400, "absolute path required");
  return path;
}

/**
 * The images in `path`'s folder (or in `path`, a folder): {dir, images:
 * [{path, name, size, mtime}], index} with `index` the one asked for. Sorted
 * like phil sorts: by name (numbers in order), date or size (largest first),
 * or type. Hidden ones only when it's the one asked for.
 */
async function images(path, sort) {
  const stat = await Deno.stat(path).catch(() => null);
  if (!stat) throw httpError(404, `${path} doesn't exist`);
  const dir = stat.isDirectory ? path : dirname(path);
  const list = [];
  for await (const d of Deno.readDir(dir)) {
    const file = join(dir, d.name);
    if (file !== path && (d.name.startsWith(".") || mediaKind(d.name) !== "image")) continue;
    const s = file === path ? stat : await Deno.stat(file).catch(() => null);
    if (s?.isFile) list.push({ path: file, name: d.name, size: s.size, mtime: s.mtime?.getTime() ?? 0 });
  }
  const ext = (name) => name.slice(name.lastIndexOf(".") + 1);
  const by = {
    mtime: (a, b) => b.mtime - a.mtime,
    size: (a, b) => b.size - a.size,
    kind: (a, b) => collator.compare(ext(a.name), ext(b.name)),
  }[sort];
  list.sort((a, b) => by?.(a, b) || collator.compare(a.name, b.name));
  return { dir, images: list, index: Math.max(0, list.findIndex((i) => i.path === path)) };
}
