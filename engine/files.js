// Reading and saving the text files an editor app edits (jsonedit, textedit):
//   GET /api/init         { home }
//   GET /api/file?path=   read()
//   PUT /api/file         write()
import { basename, dirname, join } from "@std/path";
import { httpError, json } from "./http.js";

const MAX_SIZE = 64 * 1024 * 1024;

/** The routes above, for an app server's handle(); null for other requests. */
export async function fileRoutes(req, url) {
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /api/init") return json({ home: Deno.env.get("HOME") ?? "/" });
  if (route === "GET /api/file") return json(await read(absolute(url.searchParams.get("path"))));
  if (route === "PUT /api/file") return json(await write(await req.json()));
  return null;
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
  const bytes = await Deno.readFile(path);
  let text;
  try {
    if (bytes.includes(0)) throw new Error();
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Saving it back would ruin it.
    throw httpError(415, `${basename(path)} isn't a text file (or isn't UTF-8), so it can't be edited here`);
  }
  return { path, text, mtime: stat.mtime?.getTime() ?? 0 };
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
  // Through a symlink (a link in Documents/Config, say), the file it points to
  // is what's saved: renaming over the link would replace the link instead.
  const real = stat ? await Deno.realPath(path) : path;
  const tmp = join(dirname(real), `.${basename(real)}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  try {
    await Deno.writeTextFile(tmp, text, { mode: stat ? stat.mode & 0o7777 : 0o644 });
    if (stat) await Deno.chmod(tmp, stat.mode & 0o7777); // writeTextFile's mode is masked by the umask
    await Deno.rename(tmp, real);
  } catch (err) {
    await Deno.remove(tmp).catch(() => {});
    if (err instanceof Deno.errors.PermissionDenied) {
      throw httpError(403, `You can't write ${real}${real !== path ? ` (where ${basename(path)} links to)` : ""}: it belongs to ${stat?.uid === 0 ? "root" : "another user"} or its folder is read-only.`);
    }
    throw err;
  }
  return { path, mtime: (await Deno.stat(path)).mtime?.getTime() ?? 0 };
}
