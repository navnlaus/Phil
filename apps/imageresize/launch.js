// imageresize's command line and window URL (engine/apps.js).
import { join, resolve } from "@std/path";

export const appId = "imageresize";

const HELP = `imageresize — resize, crop and compress an image

Usage: imageresize file

Crops (by hand or to a preset's shape), resizes to a preset (this monitor's
resolution, common screen and social media sizes, a longest side, a
percentage) or a size of your own, and saves it as JPEG, WebP or PNG at a
quality or file size you pick, next to the original. In phil: right-click an
image. Runs on phil-engine, like phil; see \`phil-engine --help\` for the
engine options (--browser, --standalone, --quit, --retire).
`;

export function parse(args, { cwd }) {
  if (args.some((a) => a === "-h" || a === "--help")) return { help: HELP };
  const unknown = args.find((a) => a.startsWith("-"));
  if (unknown) throw new Error(`Unknown option ${unknown}`);
  if (args.length !== 1) throw new Error("one image, please");
  return { open: { file: resolve(cwd, args[0]) } };
}

export function windowUrl(base, { file }) {
  if (file) base.searchParams.set("file", file);
  return base;
}

/** Where the server keeps its working copies (in memory: a tmpfs). */
export const workDir = () => join(Deno.env.get("XDG_RUNTIME_DIR") ?? "/dev/shm", `phil-imageresize-${Deno.pid}`);

export function cleanUp() {
  try {
    Deno.removeSync(workDir(), { recursive: true });
  } catch { /* never used */ }
}
