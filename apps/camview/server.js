// camview's server: a camera's live video and its pan, tilt and zoom. Runs in
// the engine's server worker (engine/server.js), as phil's does, which lists
// the cameras (cameras.js).
//   GET  /api/cameras            the cameras phil knows (looked for first, when there are none)
//   GET  /api/camera?id=         cameras.info(): the camera, its profiles, what its PTZ can do
//   GET  /stream?id=&profile=&mode=   its live video, as the page can show it (ui/app.js
//                                tries them in turn): mode=copy (default), the camera's
//                                own H.264 copied into fragmented MP4, for its Media
//                                Source; mode=h264, the same re-encoded as the plainest
//                                H.264 (H.265 cameras, and players that can't take a
//                                camera's own); mode=mjpeg, JPEG pictures one after
//                                another (multipart/x-mixed-replace, for an <img>)
//   POST /api/log                {message}: what the page found (which mode shows), to the engine's log
//   POST /api/ptz                {id, op: "move", x, y, zoom} (speeds, -1 to 1: the page
//                                repeats it while a button is held, and the camera stops
//                                by itself 1.5 s after it last did, in case the page is gone),
//                                {id, op: "stop"}, {id, op: "goto", preset},
//                                {id, op: "save", name}, {id, op: "remove", preset}
//   PUT  /api/camera             {id, invert}: its controls turned around (mounted upside down)
//   GET  /api/presets?id=        its saved positions
//   POST /api/snapshot           {id}: a picture from its best stream, in ~/Pictures/Cameras
import { join } from "@std/path";
import { httpError, json } from "../../engine/http.js";
import * as cameras from "./cameras.js";
import * as onvif from "./onvif.js";
import * as tuya from "./tuya.js";

export const UI_DIR = new URL("./ui/", import.meta.url);

const MOVE_HOLD_MS = 1500; // a move not repeated within this stops

export function createServer({ profile = {} } = {}) {
  if (profile.incognito) cameras.keepInMemory();
  const moving = new Map(); // id -> {timer, speed}: moves under way

  async function ptz(body) {
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

  return {
    async handle(req, url) {
      const id = url.searchParams.get("id");
      switch (`${req.method} ${url.pathname}`) {
        case "GET /api/cameras": {
          const list = await cameras.list();
          return json(list.length ? list : await cameras.discover({ force: true }));
        }
        case "GET /api/camera":
          try {
            return json(await cameras.info(id));
          } catch (err) {
            throw httpError(err.status ?? (err.auth ? 403 : 502), err.message);
          }
        case "GET /stream":
          return await stream(req, id, url.searchParams.get("profile"), url.searchParams.get("mode") ?? "copy");
        case "POST /api/log":
          console.error(`camview: ${String((await req.json()).message ?? "").slice(0, 500)}`);
          return json({ ok: true });
        case "PUT /api/camera": {
          const { id: which, invert } = await req.json();
          return json(await cameras.update(String(which ?? ""), { invert }));
        }
        case "POST /api/ptz":
          return json(await ptz(await req.json()));
        case "GET /api/presets": {
          const p = await cameras.ptzOf(id);
          if (p.tuya) return json([]);
          return json(await onvif.presets(p.url, p.token, p.login).catch(() => []));
        }
        case "POST /api/snapshot":
          return json(await snapshot((await req.json()).id));
      }
      return null;
    },
  };
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

/** The camera's live video, as long as the page reads it: ffmpeg from its RTSP stream, in `mode` (MODES). */
async function stream(req, id, profile, mode) {
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
  const [cmd, args] = await command(["ffmpeg", "-loglevel", "error", "-nostdin", "-rtsp_transport", "tcp", "-timeout", "5000000",
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

/** A picture from the camera's best stream, saved in ~/Pictures/Cameras: {path}. */
async function snapshot(id) {
  const c = await cameras.get(String(id ?? ""));
  const rtsp = await cameras.rtspUrl(c.id);
  const dir = join(await picturesDir(), "Cameras");
  await Deno.mkdir(dir, { recursive: true });
  const stamp = new Date().toLocaleString("sv-SE").replace(/:/g, ".");
  const name = (c.name || c.model || c.host).replace(/[/\0]/g, "-");
  const path = join(dir, `${name} ${stamp}.jpg`);
  const out = await new Deno.Command("ffmpeg", {
    args: ["-loglevel", "error", "-nostdin", "-rtsp_transport", "tcp", "-timeout", "5000000", "-i", rtsp, "-frames:v", "1", "-q:v", "2", "-y", path],
    stdin: "null", stdout: "null", stderr: "piped", signal: AbortSignal.timeout(15000),
  }).output();
  if (!out.success) throw httpError(502, `Couldn't take a picture: ${new TextDecoder().decode(out.stderr).trim().split("\n").pop() || "ffmpeg failed"}`);
  return { path };
}

async function picturesDir() {
  const home = Deno.env.get("HOME") ?? "/";
  try {
    const dirs = await Deno.readTextFile(join(Deno.env.get("XDG_CONFIG_HOME") ?? join(home, ".config"), "user-dirs.dirs"));
    const m = /^XDG_PICTURES_DIR="(.*)"$/m.exec(dirs);
    if (m) return m[1].replace(/^\$HOME/, home);
  } catch { /* the default */ }
  return join(home, "Pictures");
}
