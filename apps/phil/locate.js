// What's typed in a file chooser's box (phil --choose: ui/app.js), as a path
// here: an app's Open or Save gets local paths only (the portal answers with
// file:// ones). A name or a path is in the folder shown (~: home); a web
// address (http, https) is downloaded into a folder of its own in /tmp, its
// progress in the Transfers list as it comes; a network location (smb://, sftp://,
// ftp://, nfs://, afp://...) is mounted by gvfs (gio mount: its files under
// /run/user/<uid>/gvfs, there till it's unmounted), its login, or its question
// (a host's key not known yet), asked in the window first.

import { join, normalize } from "@std/path";
import { reportsDir } from "./browserdownloads.js";

const MOUNT_MS = 60_000; // a share's mounting given up after
const ANSWER_MS = 20_000; // a web address's: no answer by then
const enc = new TextEncoder();

/**
 * `text` typed, in folder `base`; `mode` (open, dir, save); `login` ({user, domain,
 * password}) and `choice` (1...): a share's, as asked. Answers {path, kind: "dir" |
 * "file" | null (none there), folder (its folder is there)}, or what's to be asked:
 * {login: message, user (its user name, if it asks for one), failed (a wrong one
 * given)} or {question, choices}. Throws, saying why, when it can't be had.
 */
export async function locate({ text, base, mode, login = null, choice = null, incognito = false }) {
  const typed = String(text ?? "").trim();
  if (!typed) throw new Error("Nothing typed");
  if (/^file:\/\//i.test(typed)) return at(decodeURIComponent(new URL(typed).pathname));
  if (/^https?:\/\//i.test(typed)) {
    if (mode !== "open") throw new Error("A web address can only be opened (a file from it, downloaded)");
    return { path: await download(typed, incognito), kind: "file", folder: true };
  }
  if (/^[a-z][\w+.-]*:\/\//i.test(typed)) return network(typed, { login, choice });
  const path = typed.replace(/^~(?=\/|$)/, Deno.env.get("HOME") ?? "/");
  return at(path.startsWith("/") ? path : join(String(base ?? "/"), path));
}

// A local path: what's there, and whether its folder is.
async function at(path) {
  path = normalize(path).replace(/(.)\/+$/, "$1");
  const kind = await Deno.stat(path).then((s) => (s.isDirectory ? "dir" : "file"), () => null);
  const parent = path.slice(0, path.lastIndexOf("/")) || "/";
  return { path, kind, folder: kind !== null || await Deno.stat(parent).then((s) => s.isDirectory, () => false) };
}

// ---------------------------------------------------------------- network locations (gvfs)

async function network(url, asked) {
  const ask = await mount(url, asked);
  if (ask) return ask;
  // Its path under gvfs's (none there: in its folder's, to save as).
  const here = await gioInfo(url);
  if (here) return { path: here.path, kind: here.kind, folder: true };
  const trimmed = url.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  const folder = cut > trimmed.indexOf("//") + 1 ? await gioInfo(trimmed.slice(0, cut)) : null;
  if (folder?.kind !== "dir") throw new Error("It's not there");
  return { path: join(folder.path, decodeURIComponent(trimmed.slice(cut + 1))), kind: null, folder: true };
}

// gio mount: its prompts answered (User, Domain, Password, Choice), as given; one
// it hasn't an answer for (or asked again: a wrong one) is what's to be asked.
async function mount(url, { login, choice }) {
  // (stdbuf: gio's prompts, unended lines, come as they're written)
  const child = new Deno.Command("stdbuf", { args: ["-o0", "gio", "mount", url], stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
  const timer = setTimeout(() => child.kill(), MOUNT_MS);
  const stdin = child.stdin.getWriter();
  const say = (line) => stdin.write(enc.encode(`${line}\n`)).catch(() => {});
  const errors = new Response(child.stderr).text();
  const answered = new Set();
  let seen = "", message = "", ask = null;
  for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
    seen += chunk;
    const prompt = /(User|Domain|Password|Choice)(?: \[([^\]]*)\])?: $/.exec(seen);
    if (!prompt) continue;
    const [, what, given] = prompt;
    const before = seen.slice(0, prompt.index).trim();
    if (before) message = before;
    seen = "";
    if (what === "Choice") {
      const lines = message.split("\n");
      const choices = lines.filter((l) => /^\[\d+\] /.test(l)).map((l) => l.replace(/^\[\d+\] /, ""));
      if (!choice || answered.has(what)) ask = { question: lines.filter((l) => !/^\[\d+\] /.test(l)).join("\n"), choices };
      else say(choice);
    } else if (what === "Domain") say(login?.domain ?? "");
    else if (!login || answered.has(what)) {
      ask = { login: message.replace(/^Authentication Required\n/, ""), failed: answered.size > 0, ...(what === "User" ? { user: given ?? "" } : {}) };
    } else say(what === "User" ? login.user ?? given ?? "" : login.password ?? "");
    if (ask) break;
    answered.add(what);
  }
  if (ask) child.kill();
  await stdin.close().catch(() => {});
  const status = await child.status;
  clearTimeout(timer);
  const why = (await errors).trim().split("\n").pop()?.replace(/^gio: [^:]*: /, "").replace(/^gio: /, "") ?? "";
  if (ask) return ask;
  if (!status.success && !/already mounted/i.test(why)) throw new Error(why || "It couldn't be mounted");
  return null;
}

// Where gvfs has it (a path, and what it is), or null: not there.
async function gioInfo(url) {
  const out = await new Deno.Command("gio", { args: ["info", "-a", "standard::type", url], stdout: "piped", stderr: "null" }).output();
  if (!out.success) return null;
  const info = new TextDecoder().decode(out.stdout);
  const path = /^local path: (.*)$/m.exec(info)?.[1];
  if (!path) throw new Error("gvfs has no path here for it");
  return { path, kind: /standard::type: 2$/m.test(info) ? "dir" : "file" };
}

// ---------------------------------------------------------------- web addresses

// Downloaded into a folder of its own in /tmp (/tmp/phil-download-XXXXXX: made new,
// only this user's), under its own name, into a .part file first; in the Transfers
// list (a report: browserdownloads.js) meanwhile.
async function download(url, incognito) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), ANSWER_MS);
  let res;
  try {
    res = await fetch(url, { signal: stop.signal });
  } catch (err) {
    throw new Error(stop.signal.aborted ? "No answer from there" : err.message);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`.trim());
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "phil-download-" });
  const path = join(dir, fileName(res));
  const part = `${path}.part`;
  const total = Number(res.headers.get("content-length")) || null;
  const id = crypto.randomUUID(), started = Date.now();
  const reportFile = join(reportsDir(), `${id}.json`);
  let bytes = 0, reported = 0;
  const report = () =>
    Deno.writeTextFile(reportFile, JSON.stringify({
      id, app: "phil", name: path.split("/").pop(), target: path, path: part, bytes, total, percent: total ? (bytes / total) * 100 : null,
      speed: bytes / Math.max(0.001, (Date.now() - started) / 1000), state: "downloading", started, pid: Deno.pid, incognito,
    })).catch(() => {});
  await Deno.mkdir(reportsDir(), { recursive: true, mode: 0o700 }).catch(() => {});
  const file = await Deno.open(part, { write: true, createNew: true });
  try {
    await res.body.pipeThrough(new TransformStream({
      transform(chunk, out) {
        bytes += chunk.length;
        if (Date.now() - reported > 500) (reported = Date.now()), report();
        out.enqueue(chunk);
      },
    })).pipeTo(file.writable);
    await Deno.rename(part, path);
    return path;
  } catch (err) {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    throw new Error(`The download stopped: ${err.message}`);
  } finally {
    await Deno.remove(reportFile).catch(() => {});
  }
}

// A download's name: the server's (Content-Disposition), else its address's last part.
function fileName(res) {
  const disposition = res.headers.get("content-disposition") ?? "";
  const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition)?.[1];
  let name = "";
  try {
    name = star ? decodeURIComponent(star) : plain ?? decodeURIComponent(new URL(res.url).pathname.split("/").pop() ?? "");
  } catch { /* badly encoded */ }
  name = name.replace(/[/\0]/g, "_").replace(/^\.+/, "").trim().slice(0, 200);
  return name || new URL(res.url).hostname || "download";
}
