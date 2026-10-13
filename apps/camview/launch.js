// camview's command line and window URL (engine/apps.js).
export const appId = "camview";

const HELP = `camview — network cameras: live video, and pan, tilt and zoom

Usage: camview [camera]

Shows a camera phil has found on the local network (ONVIF cameras; phil's
sidebar lists them): by its name or address, or the first one. Hold the
arrow buttons (or keys) to turn it, + and − to zoom; its saved positions are
along the bottom; F is fullscreen. Runs on phil-engine, like phil; see
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

export function windowUrl(base, { camera }) {
  if (camera) base.searchParams.set("camera", camera);
  return base;
}
