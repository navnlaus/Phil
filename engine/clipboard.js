// The desktop's clipboard, through wl-clipboard (wl-copy, wl-paste): what the
// apps copy lands in the clipboard (and Omarchy's clipboard history) like any
// other program's, and pasting takes whatever was copied anywhere. Pages use it
// through /engine/clipboard (see kit.js): the desktop's, whatever has the focus,
// with no permission asked (a page reads the browser's only on a key press).
import { httpError } from "./http.js";

export async function writeClipboard(text) {
  let child;
  try {
    // wl-copy stays in the background serving the clipboard: no pipes to it
    // except stdin, or waiting for it would never end.
    child = new Deno.Command("wl-copy", { args: ["--type", "text/plain;charset=utf-8"], stdin: "piped", stdout: "null", stderr: "null" }).spawn();
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) throw httpError(501, "wl-copy isn't installed");
    throw err;
  }
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(text));
  await writer.close();
  if (!(await child.status).success) throw httpError(502, "wl-copy failed");
}

export async function readClipboard() {
  let out;
  try {
    out = await new Deno.Command("wl-paste", { args: ["--no-newline", "--type", "text"], stdin: "null", stdout: "piped", stderr: "null" }).output();
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) throw httpError(501, "wl-paste isn't installed");
    throw err;
  }
  return out.success ? new TextDecoder().decode(out.stdout) : ""; // fails when nothing is copied
}
