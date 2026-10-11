// jsonedit's server: reads and saves the files being edited (engine/files.js).
// Runs in the engine's server worker (engine/server.js).
import { fileRoutes } from "../../engine/files.js";

export const UI_DIR = new URL("./ui/", import.meta.url);

export function createServer() {
  return { handle: fileRoutes };
}
