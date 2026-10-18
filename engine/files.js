// Reading and saving the text files an editor app edits (jsonedit, textedit):
//   GET /api/init         { home }
//   GET /api/file?path=   read()
//   PUT /api/file         write()
//   POST /api/open        { path }: opens the file with its default app
import { basename, dirname, join } from "@std/path";
import { documentMarkdown, documentType, isDocument } from "./documents.js";
import { httpError, json } from "./http.js";
import { wrote } from "./written.js";

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
  const decoded = decode(await Deno.readFile(path));
  // Saving it back would ruin it.
  if (!decoded) throw httpError(415, `${basename(path)} isn't a text file (or isn't UTF-8 or UTF-16), so it can't be edited here`);
  return { path, ...decoded, mtime: stat.mtime?.getTime() ?? 0 };
}

// A text file's encodings: UTF-8, with or without a byte order mark (BOM), or
// UTF-16 (Windows' "Unicode": its setup files, some exported lists), little or
// big endian, usually with one. Whichever a file has, it's saved with again.
const ENCODINGS = ["utf-8", "utf-16le", "utf-16be"];

/**
 * {text, encoding, bom} for a text file's bytes; null when they aren't text.
 * `partial`: only the file's start (a character cut off at the end is fine).
 */
export function decode(bytes, { partial = false } = {}) {
  const { encoding, bom } = sniffEncoding(bytes);
  const body = bom ? bytes.subarray(encoding === "utf-8" ? 3 : 2) : bytes;
  try {
    const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(body, { stream: partial });
    if (text.includes("\0")) return null; // binary, whatever it decodes as
    // Only a guess (no BOM): binary that happens to look like it, unless it reads as text.
    if (!bom && encoding !== "utf-8" && (text.match(/[\x01-\x08\x0e-\x1a\x1c-\x1f\x7f\ufffd]/g)?.length ?? 0) > text.length / 100) return null;
    return { text, encoding, bom };
  } catch {
    return null;
  }
}

/** What a file's bytes would be, if text: {encoding, bom} (UTF-8 unless they say or look otherwise). */
export function sniffEncoding(bytes) {
  const starts = (...b) => b.every((x, i) => bytes[i] === x);
  const bom = starts(0xef, 0xbb, 0xbf) ? "utf-8" : starts(0xff, 0xfe) ? "utf-16le" : starts(0xfe, 0xff) ? "utf-16be" : null;
  return { encoding: bom ?? utf16Guess(bytes) ?? "utf-8", bom: !!bom };
}

// UTF-16 without a BOM: mostly ASCII text, so every other byte is 0 (the
// second of each pair in little endian, the first in big endian).
function utf16Guess(bytes) {
  const n = Math.min(bytes.length, 4096) & ~1;
  if (n < 4) return null;
  let even = 0, odd = 0;
  for (let i = 0; i < n; i += 2) (bytes[i] === 0 && even++), (bytes[i + 1] === 0 && odd++);
  const pairs = n / 2;
  if (odd > pairs * 0.4 && even < pairs * 0.05) return "utf-16le";
  if (even > pairs * 0.4 && odd < pairs * 0.05) return "utf-16be";
  return null;
}

/** `text` as bytes in `encoding` (see ENCODINGS), with its BOM if `bom`. */
export function encode(text, encoding = "utf-8", bom = false) {
  if (encoding === "utf-8") {
    const body = new TextEncoder().encode(text);
    if (!bom) return body;
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body, 3);
    return out;
  }
  const head = bom ? 2 : 0, le = encoding === "utf-16le";
  const out = new Uint8Array(head + text.length * 2);
  const view = new DataView(out.buffer);
  if (bom) view.setUint16(0, 0xfeff, le);
  for (let i = 0; i < text.length; i++) view.setUint16(head + i * 2, text.charCodeAt(i), le); // code units: surrogate pairs as they are
  return out;
}

// Saves `text` to `path`, in `encoding` (with a BOM if `bom`): as the file was
// read (read() says), or, not given, as the file there is now (UTF-8 for a new
// one). `mtime` is when the file was read (null for a new one): if the file changed on disk since, nothing is written and the answer is
// 409, unless `force`. Written to a temporary file then renamed over the old
// one, keeping its permissions, so the file is never half-written. A file you
// can't write (root's) is saved with sudo (sudoWrite): 401 when that needs
// the password, which comes back as `sudo`.
async function write({ path, text, mtime = null, force = false, sudo, encoding, bom }) {
  absolute(path);
  if (typeof text !== "string") throw httpError(400, "text required");
  if (encoding !== undefined && !ENCODINGS.includes(encoding)) throw httpError(400, `encoding: one of ${ENCODINGS.join(", ")}`);
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
  if (encoding === undefined) {
    const now = stat && decode(await Deno.readFile(real).catch(() => new Uint8Array()));
    ({ encoding, bom } = now ?? { encoding: "utf-8", bom: false });
  }
  const bytes = encode(text, encoding, !!bom);
  const tmp = join(dirname(real), `.${basename(real)}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  try {
    await Deno.writeFile(tmp, bytes, { mode: stat ? stat.mode & 0o7777 : 0o644 });
    if (stat) await Deno.chmod(tmp, stat.mode & 0o7777); // writeFile's mode is masked by the umask
    await Deno.rename(tmp, real);
  } catch (err) {
    await Deno.remove(tmp).catch(() => {});
    if (!(err instanceof Deno.errors.PermissionDenied)) throw err;
    await sudoWrite(real, bytes, sudo);
  }
  wrote(real);
  return { path, mtime: (await Deno.stat(path)).mtime?.getTime() ?? 0 };
}

/**
 * Saves `bytes` to `real` as root: a private temporary copy, then `sudo cp`
 * over the file (keeping its owner and permissions). sudo remembers a
 * password for a while (by default 5 minutes, for this process), so it's
 * tried without one first; then with `password`, if given. Throws 401 when a
 * password is needed (or was wrong), so the page can ask for it.
 */
async function sudoWrite(real, bytes, password) {
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
  await Deno.writeFile(tmp, bytes, { mode: 0o600 });
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
