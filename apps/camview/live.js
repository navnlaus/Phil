// A camera's live video and its pan, tilt and zoom: camview's (its page's
// /stream, /api/ptz) and the phone link's (link.js: the Android app's cameras,
// through this PC). One module for both, as cameras.js: they run in the same
// worker, so a move held from the phone and one from camview are the same one.
import { httpError } from "../../engine/http.js";
import * as cameras from "./cameras.js";
import * as onvif from "./onvif.js";
import * as tuya from "./tuya.js";

const MOVE_HOLD_MS = 1500; // a move not repeated within this stops
const moving = new Map(); // id -> {timer, speed}: moves under way

// Whether a stream's address is on this network (a private, link-local or loopback address, a
// .local name, or a bare host name): there it's played with no buffer; else over the internet.
export function isLocalHost(address) {
  let host;
  try {
    host = new URL(address).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  if (!host.includes(".") && !host.includes(":")) return true; // ("camera", "gerpi": a LAN name)
  if (host.endsWith(".local") || host.endsWith(".lan") || host === "localhost") return true;
  const v4 = host.split(".").map(Number);
  if (v4.length === 4 && v4.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = v4;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return host === "::1" || /^f[cd]/.test(host) || host.startsWith("fe80:");
}

/**
 * {id, op: "move", x, y, zoom} (speeds, -1 to 1: repeated while a button is
 * held; the camera stops 1.5 s after it last was), {id, op: "stop"}, {id, op:
 * "goto", preset}, {id, op: "save", name}, {id, op: "remove", preset}.
 */
export async function ptz(body) {
  const { id, op } = body;
  const p = await cameras.ptzOf(String(id ?? ""));
  // A Tuya camera's: cloud commands; one speed, no presets here (yet).
  if (p.tuya) {
    const t = p.tuya, flip = p.invert ? -1 : 1;
    const cloud = (fn) => fn().catch((err) => {
      throw httpError(502, err.message);
    });
    if (op === "move") {
      const speed = { x: flip * Math.sign(Number(body.x) || 0), y: flip * Math.sign(Number(body.y) || 0), zoom: 0 };
      const m = moving.get(id);
      clearTimeout(m?.timer);
      const same = m && m.speed.x === speed.x && m.speed.y === speed.y;
      const timer = setTimeout(() => (moving.delete(id), tuya.stop(t, t.deviceId).catch(() => {})), MOVE_HOLD_MS);
      moving.set(id, { timer, speed });
      if (!same) await cloud(() => tuya.move(t, t.deviceId, speed));
      return { ok: true };
    }
    if (op === "stop") {
      clearTimeout(moving.get(id)?.timer);
      moving.delete(id);
      await cloud(() => tuya.stop(t, t.deviceId));
      return { ok: true };
    }
    throw httpError(400, "This camera's saved positions aren't supported here yet");
  }
  const quiet = (fn) => fn().catch((err) => {
    throw httpError(err.auth ? 403 : 502, err.message);
  });
  if (op === "move") {
    const flip = p.invert ? -1 : 1; // upside down: right turns it left, up turns it down
    const speed = { x: flip * (Number(body.x) || 0), y: flip * (Number(body.y) || 0), zoom: Number(body.zoom) || 0 };
    const m = moving.get(id);
    clearTimeout(m?.timer);
    const same = m && m.speed.x === speed.x && m.speed.y === speed.y && m.speed.zoom === speed.zoom;
    const timer = setTimeout(() => (moving.delete(id), onvif.stop(p.url, p.token, p.login).catch(() => {})), MOVE_HOLD_MS);
    moving.set(id, { timer, speed });
    if (!same) await quiet(() => onvif.move(p.url, p.token, speed, p.login)); // repeated: only the hold is renewed
    return { ok: true };
  }
  if (op === "stop") {
    clearTimeout(moving.get(id)?.timer);
    moving.delete(id);
    await quiet(() => onvif.stop(p.url, p.token, p.login));
    return { ok: true };
  }
  if (op === "goto") return await quiet(() => onvif.gotoPreset(p.url, p.token, String(body.preset), p.login)), { ok: true };
  if (op === "save") {
    const name = String(body.name ?? "").trim().slice(0, 40);
    if (!name) throw httpError(400, "A name for it, please");
    return { token: await quiet(() => onvif.savePreset(p.url, p.token, name, p.login)) };
  }
  if (op === "remove") return await quiet(() => onvif.removePreset(p.url, p.token, String(body.preset), p.login)), { ok: true };
  throw httpError(400, "op: move, stop, goto, save or remove");
}

/** A camera's saved positions: [{token, name}]. */
export async function presets(id) {
  const p = await cameras.ptzOf(id);
  if (p.tuya) return [];
  return await onvif.presets(p.url, p.token, p.login).catch(() => []);
}

// ffmpeg, stopped with the engine if it goes (setpriv), when there's setpriv.
let setpriv;
async function command(args) {
  setpriv ??= await new Deno.Command("setpriv", { args: ["--help"], stdout: "null", stderr: "null" }).output().then((o) => o.success, () => false);
  return setpriv ? ["setpriv", ["--pdeathsig", "TERM", "--", ...args]] : [args[0], args.slice(1)];
}

// How ffmpeg makes each mode (see /stream): the copy costs next to nothing;
// the others decode and encode, so they're scaled to at most 1920 wide.
const SCALE = ["-vf", "scale='min(1920,iw)':-2"];
const MODES = {
  copy: { type: "video/mp4", args: ["-c:v", "copy"], mp4: true },
  h264: { type: "video/mp4", mp4: true, args: [...SCALE, "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline", "-g", "15", "-pix_fmt", "yuv420p"] },
  mjpeg: { type: "multipart/x-mixed-replace;boundary=ffmpeg", args: [...SCALE, "-r", "12", "-c:v", "mjpeg", "-q:v", "5", "-f", "mpjpeg"] },
};

/** The camera's live video, as long as the page reads it: ffmpeg from its stream (RTSP, or a web one), in `mode` (MODES). */
export async function stream(req, id, profile, mode) {
  const how = MODES[mode];
  if (!how) throw httpError(400, "mode: copy, h264 or mjpeg");
  let rtsp;
  try {
    rtsp = await cameras.rtspUrl(id, profile);
  } catch (err) {
    throw httpError(err.status ?? (err.auth ? 403 : 502), err.message);
  }
  // A fragment per frame: each sent the moment it's there (not ~200 ms of them at once).
  const mp4 = ["-f", "mp4", "-movflags", "frag_keyframe+frag_every_frame+empty_moov+default_base_moof"];
  const [cmd, args] = await command(["ffmpeg", "-loglevel", "error", "-nostdin", ...cameras.inputArgs(rtsp),
    "-fflags", "nobuffer", "-i", rtsp, "-an", ...how.args, ...(how.mp4 ? mp4 : []), "pipe:1"]);
  const child = new Deno.Command(cmd, { args, stdin: "null", stdout: "piped", stderr: "null" }).spawn();
  const end = () => {
    try {
      child.kill("SIGTERM");
    } catch { /* gone */ }
  };
  req.signal.addEventListener("abort", end);
  const reader = child.stdout.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) return controller.close();
      controller.enqueue(value);
    },
    cancel: end,
  });
  return new Response(body, { headers: { "content-type": how.type, "cache-control": "no-store" } });
}
