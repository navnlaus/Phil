// `phil-editor [file]` (alias `ed`): the right editor for a file, jsonedit for JSON and textedit
// for other text. Run in phil's terminal panel, it opens in that phil window
// (the panel's shell has PHIL_TERMINAL and PHIL_ENGINE_SOCKET); elsewhere in
// a window of its own. A launcher only: no server, no pages (engine/apps.js).
import { extname, resolve } from "@std/path";

const HELP = `phil-editor — edit a file in the right editor

Usage: phil-editor [file]     (or ed, with the alias)

JSON files open in jsonedit, other text files in textedit (also new files,
and no file at all). Run in phil's terminal panel, the editor opens in that
phil window, like a picture in its viewer; anywhere else, in a window of its
own. Runs on phil-engine.
`;

const JSON_EXTENSIONS = new Set([".json", ".geojson", ".webmanifest"]);

export function parse(args, { cwd }) {
  if (args.some((a) => a === "-h" || a === "--help")) return { help: HELP };
  const unknown = args.find((a) => a.startsWith("-"));
  if (unknown) throw new Error(`Unknown option ${unknown}`);
  if (args.length > 1) throw new Error("one file at a time");
  const file = args[0] ? resolve(cwd, args[0]) : null;
  if (file && !isText(file)) throw new Error(`${args[0]} isn't a text file`);
  const app = file && JSON_EXTENSIONS.has(extname(file).toLowerCase()) ? "jsonedit" : "textedit";

  const terminal = Deno.env.get("PHIL_TERMINAL"), socket = Deno.env.get("PHIL_ENGINE_SOCKET");
  const params = file ? { file } : {};
  return {
    app,
    open: { file },
    // In phil's terminal: ask that phil to show it. If it can't (gone), a window.
    send: terminal && socket ? { socket, message: { to: "phil", embed: { terminal, app, params } } } : undefined,
  };
}

// A file that doesn't exist yet counts (it will be created), and so does an
// empty one; otherwise no NUL bytes and valid UTF-8 at the start.
function isText(path) {
  let file;
  try {
    file = Deno.openSync(path);
  } catch {
    return true;
  }
  try {
    const buf = new Uint8Array(8192);
    const n = file.readSync(buf) ?? 0;
    const head = buf.subarray(0, n);
    if (head.includes(0)) return false;
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  } finally {
    file.close();
  }
}
