// camview's command line and window URL (engine/apps.js).
export const appId = "camview";
// Its windows hold embeds (mpv, a camera's each, under the page): salir's composited ones.
export const embeds = true;

const HELP = `camview — network cameras: live video, and pan, tilt and zoom

Usage: camview [camera]

Without a camera: every camera that's on, live side by side (the wall; click
one for it alone, Esc comes back; L lists them all, offline and turned off
too). With one: that camera phil has found on the local network (ONVIF
cameras; phil's sidebar lists them), by its name or address. Hold the arrow
buttons (or keys) to turn it, + and − to zoom; its saved positions are along
the bottom; F is fullscreen. Runs on phil-engine, like phil; see
\`phil-engine --help\` for the engine options (--browser, --standalone,
--quit, --retire).
`;

export function parse(args) {
  if (args.some((a) => a === "-h" || a === "--help")) return { help: HELP };
  const unknown = args.find((a) => a.startsWith("-"));
  if (unknown) throw new Error(`Unknown option ${unknown}`);
  if (args.length > 1) throw new Error("one camera at a time");
  return { open: { camera: args[0] ?? null } };
}

// No camera asked for: the wall, every camera that's on.
export function windowUrl(base, { camera }) {
  if (camera) base.searchParams.set("camera", camera);
  else base.searchParams.set("wall", "1");
  return base;
}
