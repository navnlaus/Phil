// textedit's server: reads and saves the files being edited (engine/files.js),
// and serves files for the Markdown view's images. Runs in the engine's server
// worker (engine/server.js).
import { fileRoutes } from "../../engine/files.js";
import { httpError, serveFile } from "../../engine/http.js";

export const UI_DIR = new URL("./ui/", import.meta.url);

export function createServer() {
  return {
    async handle(req, url) {
      if (req.method === "GET" && url.pathname === "/file") {
        const path = url.searchParams.get("path");
        if (!path?.startsWith("/")) throw httpError(400, "absolute path required");
        return serveFile(req, path, { "content-security-policy": "sandbox" });
      }
      return await fileRoutes(req, url);
    },
  };
}
