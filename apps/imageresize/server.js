// imageresize's server: crops, resizes and encodes with vips. Runs in the
// engine's server worker (engine/server.js).
//   GET  /api/info?path=     the image (upright: EXIF rotation applied), its
//                            size and format, and the monitors' resolutions
//   GET  /api/source?path=&turns=&flip=&angle=
//                            it as a JPEG to show and crop on (≤ 2560 px), turned
//                            as asked (orient())
//   POST /api/render         the result's bytes, for the preview (render())
//   POST /api/save           the result written to `dest`
// The image is turned upright once into a vips file in workDir (a tmpfs), and
// the last crop + resize is kept there too, so changing only the quality just
// encodes again.
import { basename, dirname, extname, join } from "@std/path";
import { httpError, json } from "../../engine/http.js";
import { wrote } from "../../engine/written.js";
import { workDir } from "./launch.js";

export const UI_DIR = new URL("./ui/", import.meta.url);

export function createServer() {
  return {
    async handle(req, url) {
      const path = url.searchParams.get("path");
      switch (`${req.method} ${url.pathname}`) {
        case "GET /api/info":
          return json(await info(absolute(path)));
        case "GET /api/source":
          return await source(absolute(path), url.searchParams);
        case "POST /api/render": {
          const job = await req.json();
          const { bytes, width, height, quality } = await serially(() => render(job));
          return new Response(bytes, {
            headers: { "content-type": "application/octet-stream", "x-width": String(width), "x-height": String(height), "x-quality": String(quality ?? "") },
          });
        }
        case "POST /api/save": {
          const job = await req.json();
          return json(await serially(() => save(job)));
        }
      }
      return null;
    },
  };
}

// One render at a time: they share the working copies (and the CPU).
let queue = Promise.resolve();
function serially(fn) {
  const done = queue.then(fn);
  queue = done.catch(() => {});
  return done;
}

function absolute(path) {
  if (typeof path !== "string" || !path.startsWith("/")) throw httpError(400, "absolute path required");
  return path;
}

async function vips(args, { stdout = false } = {}) {
  const out = await new Deno.Command("vips", { args, stdin: "null", stdout: stdout ? "piped" : "null", stderr: "piped" }).output();
  if (!out.success) {
    const msg = new TextDecoder().decode(out.stderr).split("\n").filter((l) => l && !l.includes("WARNING")).at(-1);
    throw httpError(422, `vips ${args[0]}: ${msg ?? "failed"}`);
  }
  return stdout ? out.stdout : null;
}

async function header(file, field) {
  const out = await new Deno.Command("vipsheader", { args: ["-f", field, file], stdin: "null", stdout: "piped", stderr: "null" }).output();
  return out.success ? new TextDecoder().decode(out.stdout).trim() : null;
}

// The upright working copy of `path`, made once per version of the file.
const uprights = new Map(); // path -> { mtime, file }
async function upright(path) {
  const stat = await Deno.stat(path).catch(() => null);
  if (!stat?.isFile) throw httpError(404, `${path} isn't there`);
  const mtime = stat.mtime?.getTime() ?? 0;
  const known = uprights.get(path);
  if (known?.mtime === mtime) return { ...known, size: stat.size };
  if (known) for (const f of [known.file, known.small]) if (f) await Deno.remove(f).catch(() => {});
  uprights.delete(path);
  for (const [old, entry] of [...uprights].slice(0, Math.max(0, uprights.size - 2))) { // the last few images only
    uprights.delete(old);
    for (const f of [entry.file, entry.small]) if (f) await Deno.remove(f).catch(() => {});
  }
  await Deno.mkdir(workDir(), { recursive: true, mode: 0o700 });
  const file = join(workDir(), `${crypto.randomUUID()}.v`);
  await vips(["autorot", path, file]);
  const entry = { mtime, file, width: Number(await header(file, "width")), height: Number(await header(file, "height")) };
  uprights.set(path, entry);
  return { ...entry, size: stat.size };
}

async function info(path) {
  const u = await upright(path);
  const ext = extname(path).slice(1).toLowerCase();
  return {
    path,
    name: basename(path),
    dir: dirname(path),
    width: u.width,
    height: u.height,
    size: u.size,
    format: ext === "jpeg" || ext === "jpg" ? "jpeg" : ext,
    monitors: await monitors(),
  };
}

// Hyprland's monitors: [{name, width, height}] (none elsewhere).
async function monitors() {
  try {
    const out = await new Deno.Command("hyprctl", { args: ["monitors", "-j"], stdin: "null", stdout: "piped", stderr: "null" }).output();
    return JSON.parse(new TextDecoder().decode(out.stdout)).map((m) => {
      const turned = m.transform % 2 === 1; // rotated 90° or 270°
      return { name: m.name, description: m.description, width: turned ? m.height : m.width, height: turned ? m.width : m.height };
    });
  } catch {
    return [];
  }
}

async function source(path, params) {
  const u = await upright(path);
  const entry = uprights.get(path);
  entry.smaller ??= (async () => { // the upright copy, small enough to show; made once
    const file = join(workDir(), `${crypto.randomUUID()}.v`);
    await vips(["thumbnail", u.file, file, "2560", "--size", "down"]);
    return (entry.small = file);
  })();
  const small = await entry.smaller;
  const ops = turning({ turns: params.get("turns"), flip: params.get("flip") === "1", angle: params.get("angle") });
  const turned = await turn(small, ops);
  try {
    const bytes = await vips(["copy", turned, ".jpg[Q=90]"], { stdout: true });
    return new Response(bytes, { headers: { "content-type": "image/jpeg", "cache-control": "no-cache" } });
  } finally {
    if (turned !== small) await Deno.remove(turned).catch(() => {});
  }
}

// Turning: quarter turns clockwise (0–3), then a mirror image (left to right),
// then straightening by `angle` degrees (−45 to 45, clockwise), which crops
// away the corners that leaves: the largest rectangle of the same shape.
const turning = ({ turns = 0, flip = false, angle = 0 } = {}) => ({
  turns: ((Math.round(Number(turns) || 0) % 4) + 4) % 4,
  flip: !!flip,
  angle: Math.round(Math.max(-45, Math.min(45, Number(angle) || 0)) * 10) / 10,
});
const turned = (ops) => ops.turns || ops.flip || ops.angle;

/** The size of a `width` × `height` image after `ops` (as turn() makes it). */
export function turnedSize(width, height, ops) {
  const [w, h] = ops.turns % 2 ? [height, width] : [width, height];
  if (!ops.angle) return { width: w, height: h };
  const a = Math.abs(ops.angle) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const f = Math.min(w / (w * c + h * s), h / (w * s + h * c));
  return { width: Math.max(1, Math.floor(w * f)), height: Math.max(1, Math.floor(h * f)) };
}

// `file` turned by `ops`: a new vips file (or `file` itself, for none).
async function turn(file, ops) {
  if (!turned(ops)) return file;
  const temps = [];
  const next = () => (temps.push(join(workDir(), `${crypto.randomUUID()}.v`)), temps.at(-1));
  let at = file;
  try {
    if (ops.turns) {
      const out = next();
      await vips(["rot", at, out, ["", "d90", "d180", "d270"][ops.turns]]);
      at = out;
    }
    if (ops.flip) {
      const out = next();
      await vips(["flip", at, out, "horizontal"]);
      at = out;
    }
    if (ops.angle) {
      const width = Number(await header(at, "width")), height = Number(await header(at, "height"));
      const rotated = next();
      await vips(["rotate", at, rotated, String(ops.angle)]);
      const bw = Number(await header(rotated, "width")), bh = Number(await header(rotated, "height"));
      const size = turnedSize(width, height, { turns: 0, angle: ops.angle });
      const out = next();
      await vips(["extract_area", rotated, out, String(Math.floor((bw - size.width) / 2)), String(Math.floor((bh - size.height) / 2)), String(size.width), String(size.height)]);
      at = out;
    }
    return at;
  } finally {
    for (const t of temps) if (t !== at) await Deno.remove(t).catch(() => {});
  }
}

// The upright image turned by `ops`, at full size: the last one is kept.
let oriented = null; // { key, file, width, height }
async function orient(path, ops) {
  const u = await upright(path);
  if (!turned(ops)) return u;
  const key = JSON.stringify([u.file, ops]);
  if (oriented?.key === key) return oriented;
  if (oriented) await Deno.remove(oriented.file).catch(() => {});
  oriented = null;
  const file = await turn(u.file, ops);
  oriented = { key, file, width: Number(await header(file, "width")), height: Number(await header(file, "height")) };
  return oriented;
}

// The last crop + resize, kept for re-encoding at other qualities.
let scaled = null; // { key, file, width, height, own: made here (not the turned or upright copy) }

/**
 * The result of `job`: {path, turn: {turns, flip, angle} (turning), crop:
 * {x, y, width, height} in the turned image's pixels, width, height (the
 * output's), format: "jpeg" | "webp" | "png", quality (1–100) or targetKB (the
 * best quality that fits), progressive, keepMetadata}. Resolves to {bytes,
 * width, height, quality}.
 */
async function render(job) {
  const path = absolute(job.path);
  const u = await orient(path, turning(job.turn));
  const crop = job.crop ?? { x: 0, y: 0, width: u.width, height: u.height };
  const c = {
    x: clampInt(crop.x, 0, u.width - 1),
    y: clampInt(crop.y, 0, u.height - 1),
  };
  c.width = clampInt(crop.width, 1, u.width - c.x);
  c.height = clampInt(crop.height, 1, u.height - c.y);
  const width = clampInt(job.width ?? c.width, 1, 20000), height = clampInt(job.height ?? c.height, 1, 20000);
  const key = JSON.stringify([u.file, c, width, height]);
  if (scaled?.key !== key) {
    if (scaled?.own) await Deno.remove(scaled.file).catch(() => {});
    scaled = null;
    let file = u.file;
    const temps = [];
    const next = () => (temps.push(join(workDir(), `${crypto.randomUUID()}.v`)), temps.at(-1));
    if (c.x || c.y || c.width !== u.width || c.height !== u.height) {
      const out = next();
      await vips(["extract_area", file, out, c.x, c.y, c.width, c.height].map(String));
      file = out;
    }
    if (width !== c.width || height !== c.height) {
      const out = next();
      await vips(["resize", file, out, String(width / c.width), "--vscale", String(height / c.height), "--kernel", "lanczos3"]);
      file = out;
    }
    for (const t of temps) if (t !== file) await Deno.remove(t).catch(() => {});
    scaled = { key, file, width, height, own: file !== u.file };
  }
  const encode = (q) => vips(["copy", scaled.file, target(job, q)], { stdout: true });
  if (job.format === "png") return { bytes: await encode(null), width, height, quality: null };
  if (!job.targetKB) {
    const quality = clampInt(job.quality ?? 82, 1, 100);
    return { bytes: await encode(quality), width, height, quality };
  }
  // The highest quality that fits in targetKB: a binary search, 6–7 encodes.
  const limit = Number(job.targetKB) * 1024;
  let lo = 5, hi = 95, best = null;
  while (lo <= hi) {
    const q = Math.floor((lo + hi) / 2);
    const bytes = await encode(q);
    if (bytes.length <= limit) (best = { bytes, quality: q }), (lo = q + 1);
    else hi = q - 1;
  }
  best ??= { bytes: await encode(5), quality: 5 }; // can't get under it: as small as it goes
  return { ...best, width, height };
}

// The vips output "filename" that writes to stdout in `job`'s format.
function target(job, quality) {
  const keep = job.keepMetadata ? "all" : "icc"; // the color profile, always
  if (job.format === "png") return `.png[compression=9,keep=${keep}]`;
  if (job.format === "webp") return `.webp[Q=${quality},effort=5,smart_subsample,keep=${keep}]`;
  return `.jpg[Q=${quality},optimize_coding,${job.progressive === false ? "" : "interlace,"}keep=${keep}]`;
}

const clampInt = (n, min, max) => Math.min(max, Math.max(min, Math.round(Number(n) || 0)));

// Writes the result to `dest`: never over the file being resized unless
// `overwrite` says so, nor over another file unless `overwrite`. Atomic.
async function save(job) {
  const dest = absolute(job.dest);
  if (!job.overwrite && await Deno.lstat(dest).then(() => true, () => false)) {
    throw httpError(409, `${basename(dest)} already exists`);
  }
  const { bytes, width, height, quality } = await render(job);
  const tmp = join(dirname(dest), `.${basename(dest)}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  try {
    await Deno.writeFile(tmp, bytes, { mode: 0o644 });
    await Deno.rename(tmp, dest);
  } catch (err) {
    await Deno.remove(tmp).catch(() => {});
    if (err instanceof Deno.errors.PermissionDenied) throw httpError(403, `You can't write in ${dirname(dest)}`);
    throw err;
  }
  wrote(dest);
  return { path: dest, bytes: bytes.length, width, height, quality };
}
