// Reading and saving the text files an editor app edits (jsonedit, textedit):
//   GET /api/init         { home }
//   GET /api/file?path=   read()
//   PUT /api/file         write()
//   POST /api/open        { path }: opens the file with its default app
import { basename, dirname, join } from "@std/path";
import { documentMarkdown, documentType, isDocument } from "./documents.js";
import { httpError, json } from "./http.js";

const MAX_SIZE = 64 * 1024 * 1024;

/** The routes above, for an app server's handle(); null for other requests. */
export async function fileRoutes(req, url) {
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /api/init") return json({ home: Deno.env.get("HOME") ?? "/" });
  if (route === "GET /api/file") return json(await read(absolute(url.searchParams.get("path"))));
  if (route === "PUT /api/file") return json(await write(await req.json()));
  if (route === "POST /api/open") return json(openExternal(absolute((await req.json()).path)));
  return null;
}

function absolute(path) {
  if (!path?.startsWith("/")) throw httpError(400, "absolute path required");
  return path;
}

// { path, text, mtime }, or { path, missing: true } for a file to be created.
// A document (Word, RTF, ...: documents.js) comes as Markdown, for reading,
// with `document`: what kind it is.
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
  if (isDocument(path)) {
    let text;
    try {
      text = await documentMarkdown(path, { urgent: true });
    } catch (err) {
      throw httpError(415, err.message);
    }
    return { path, text, mtime: stat.mtime?.getTime() ?? 0, document: documentType(path) };
  }
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
// one, keeping its permissions, so the file is never half-written. A file you
// can't write (root's) is saved with sudo (sudoWrite): 401 when that needs
// the password, which comes back as `sudo`.
async function write({ path, text, mtime = null, force = false, sudo }) {
  absolute(path);
  if (typeof text !== "string") throw httpError(400, "text required");
  const stat = await Deno.stat(path).catch(() => null);
  if (stat && !stat.isFile) throw httpError(400, `${path} isn't a file`);
  // It's read as Markdown: saved over it, the document would be lost.
  if (stat && isDocument(path)) throw httpError(400, `${basename(path)} is a ${documentType(path)} document; save the Markdown as a new file`);
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
    if (!(err instanceof Deno.errors.PermissionDenied)) throw err;
    await sudoWrite(real, text, sudo);
  }
  return { path, mtime: (await Deno.stat(path)).mtime?.getTime() ?? 0 };
}

/**
 * Saves `text` to `real` as root: a private temporary copy, then `sudo cp`
 * over the file (keeping its owner and permissions). sudo remembers a
 * password for a while (by default 5 minutes, for this process), so it's
 * tried without one first; then with `password`, if given. Throws 401 when a
 * password is needed (or was wrong), so the page can ask for it.
 */
async function sudoWrite(real, text, password) {
  const run = async (args, input) => {
    const child = new Deno.Command("sudo", { args, stdin: input === undefined ? "null" : "piped", stdout: "null", stderr: "piped" }).spawn();
    if (input !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(input));
      await writer.close();
    }
    const out = await child.output();
    return { ok: out.success, error: new TextDecoder().decode(out.stderr).trim() };
  };
  const tmp = join(Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp", `phil-sudo-${crypto.randomUUID()}`);
  await Deno.writeTextFile(tmp, text, { mode: 0o600 });
  try {
    if (!(await run(["-n", "true"])).ok) { // not remembered: the password, checked
      const needs = `${basename(real)} belongs to root. Save it with sudo:`;
      if (password === undefined || password === null) throw httpError(401, needs);
      if (!(await run(["-S", "-p", "", "-v"], password + "\n")).ok) throw httpError(401, `That password didn't work. ${needs}`);
    }
    const copy = await run(["-n", "--", "cp", "--no-preserve=mode,ownership", "--", tmp, real]);
    if (!copy.ok) throw httpError(403, `Couldn't save ${real} with sudo: ${copy.error || "sudo refused"}`);
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
}

function openExternal(path) {
  const child = new Deno.Command("xdg-open", { args: [path], stdin: "null", stdout: "null", stderr: "null" }).spawn();
  child.unref();
  child.status.catch(() => {});
  return { ok: true };
}
