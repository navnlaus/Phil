// videoplayer's command line and window URL (engine/apps.js).
import { resolve } from "@std/path";

export const appId = "videoplayer";

const HELP = `videoplayer — a video player

Usage: videoplayer [--incognito] file

Plays a video, and the other videos in its folder (Page Up / Page Down).
What the browser can't play itself (AVI, MPEG-TS, WMV, HEVC...) is converted
by ffmpeg as it plays. Space plays and pauses, ← → seek, ↑ ↓ the volume,
[ ] the speed, F is fullscreen, M mutes, Esc closes; the gear has the rest.
Settings: ~/.config/phil/videoplayer.json; your own styles:
~/.config/phil/videoplayer.css. It starts where a video was left (not in
incognito, which remembers nothing). Run in phil's terminal panel, it opens
in that phil window. Runs on phil-engine, like phil; see \`phil-engine --help\`
for the engine options (--browser, --standalone, --quit, --retire).
`;

export function parse(args, { cwd }) {
  if (args.some((a) => a === "-h" || a === "--help")) return { help: HELP };
  const incognito = args.includes("--incognito") || Deno.env.get("PHIL_INCOGNITO") === "1";
  args = args.filter((a) => a !== "--incognito");
  const unknown = args.find((a) => a.startsWith("-"));
  if (unknown) throw new Error(`Unknown option ${unknown}`);
  if (args.length !== 1) throw new Error("one video, please");
  const file = resolve(cwd, args[0]);
  // In phil's terminal: ask that phil to show it (see phil-editor). If it can't, a window.
  const terminal = Deno.env.get("PHIL_TERMINAL"), socket = Deno.env.get("PHIL_ENGINE_SOCKET");
  const embed = { terminal, app: "videoplayer", params: { file } };
  return {
    open: { file },
    profile: incognito ? { incognito: true } : undefined,
    send: terminal && socket ? { socket, message: { to: "phil", embed } } : undefined,
  };
}

export function windowUrl(base, { file }) {
  if (file) base.searchParams.set("file", file);
  return base;
}
