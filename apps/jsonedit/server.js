// jsonedit's server: reads and writes the files being edited. Runs in the
// engine's server worker (engine/server.js).
import { basename, dirname, join } from "@std/path";
import { httpError, json } from "../../engine/http.js";

export const UI_DIR = new URL("./ui/", import.meta.url);

const MAX_SIZE = 64 * 1024 * 1024;

export function createServer() {
  return {
    async handle(req, url) {
      const route = `${req.method} ${url.pathname}`;
      if (route === "GET /api/init") return json({ home: Deno.env.get("HOME") ?? "/" });
      if (route === "GET /api/file") return json(await read(absolute(url.searchParams.get("path"))));
      if (route === "PUT /api/file") return json(await write(await req.json()));
      return null;
    },
  };
}

function absolute(path) {
  if (!path?.startsWith("/")) throw httpError(400, "absolute path required");
  return path;
}

// { path, text, mtime }, or { path, missing: true } for a file to be created.
async function read(path) {
  let stat;
  try {
    stat = await Deno.stat(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return { path, missing: true };
    throw err;
  }
  if (!stat.isFile) throw httpError(400, `${path} isn't a file`);
  if (stat.size > MAX_SIZE) throw httpError(413, `${basename(path)} is too large to edit here (over 64 MB)`);
  return { path, text: await Deno.readTextFile(path), mtime: stat.mtime?.getTime() ?? 0 };
}

// Saves `text` to `path`. `mtime` is when the file was read (null for a new
// one): if the file changed on disk since, nothing is written and the answer is
// 409, unless `force`. Written to a temporary file then renamed over the old
// one, keeping its permissions, so the file is never half-written.
async function write({ path, text, mtime = null, force = false }) {
  absolute(path);
  if (typeof text !== "string") throw httpError(400, "text required");
  const stat = await Deno.stat(path).catch(() => null);
  if (stat && !stat.isFile) throw httpError(400, `${path} isn't a file`);
  if (!force) {
    if (stat && mtime === null) throw httpError(409, `${basename(path)} already exists.`);
    if (stat && mtime !== null && (stat.mtime?.getTime() ?? 0) !== mtime) throw httpError(409, `${basename(path)} changed on disk since it was opened.`);
    if (!stat && mtime !== null) throw httpError(409, `${basename(path)} was deleted since it was opened.`);
  }
  const tmp = join(dirname(path), `.${basename(path)}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  try {
    await Deno.writeTextFile(tmp, text, { mode: stat ? stat.mode & 0o7777 : 0o644 });
    if (stat) await Deno.chmod(tmp, stat.mode & 0o7777); // writeTextFile's mode is masked by the umask
    await Deno.rename(tmp, path);
  } catch (err) {
    await Deno.remove(tmp).catch(() => {});
    throw err;
  }
  return { path, mtime: (await Deno.stat(path)).mtime?.getTime() ?? 0 };
}
