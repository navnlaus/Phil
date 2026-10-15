// imageview's server: the images in a folder, the files themselves, and
// images the webview can't decode converted (engine/media.js). Runs in the
// engine's server worker (engine/server.js).
//   GET /api/images?path=&sort=   images()
//   GET /file?path=               the file
//   GET /preview?path=&size=      a JPEG of it, for HEIC, TIFF, ...
import { httpError, json, serveFile } from "../../engine/http.js";
import { imagePreview, mediaInFolder } from "../../engine/media.js";

export const UI_DIR = new URL("./ui/", import.meta.url);

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

async function images(path, sort) {
  const { dir, items, index } = await mediaInFolder(path, "image", sort);
  return { dir, images: items, index };
}
