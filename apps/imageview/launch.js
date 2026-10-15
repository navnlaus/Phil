// imageview's command line and window URL (engine/apps.js).
import { resolve } from "@std/path";

export const appId = "imageview";

const HELP = `imageview — an image viewer

Usage: imageview [--incognito] [file or folder]

Shows an image, and the other images in its folder (a folder: its first).
Z switches between fitting the window's height or width (cropping the other
side) and the original size, + and − zoom, the arrow keys scroll an image
larger than the window, F is fullscreen. Run in phil's terminal panel, it
opens in that phil window (an incognito phil's: incognito too, as
--incognito: nothing remembered). Runs on phil-engine, like phil; see
\`phil-engine --help\` for the engine options (--browser, --standalone,
--quit, --retire).
`;

export function parse(args, { cwd }) {
  if (args.some((a) => a === "-h" || a === "--help")) return { help: HELP };
  const incognito = args.includes("--incognito") || Deno.env.get("PHIL_INCOGNITO") === "1";
  args = args.filter((a) => a !== "--incognito");
  const unknown = args.find((a) => a.startsWith("-"));
  if (unknown) throw new Error(`Unknown option ${unknown}`);
  if (args.length > 1) throw new Error("one file or folder at a time");
  const file = args[0] ? resolve(cwd, args[0]) : null;
  // In phil's terminal: ask that phil to show it (see phil-editor). If it can't, a window.
  const terminal = Deno.env.get("PHIL_TERMINAL"), socket = Deno.env.get("PHIL_ENGINE_SOCKET");
  const embed = { terminal, app: "imageview", params: { file } };
  return { open: { file }, profile: incognito ? { incognito: true } : undefined, send: file && terminal && socket ? { socket, message: { to: "phil", embed } } : undefined };
}

export function windowUrl(base, { file }) {
  if (file) base.searchParams.set("file", file);
  return base;
}
