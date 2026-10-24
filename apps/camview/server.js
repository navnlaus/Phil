// camview's server: a camera's live video and its pan, tilt and zoom. Runs in
// the engine's server worker (engine/server.js), as phil's does, which lists
// the cameras (cameras.js).
//   GET  /api/cameras            the cameras phil knows (looked for first, when there are none)
//   GET  /api/camera?id=         cameras.info(): the camera, its profiles, what its PTZ can do
//   GET  /api/hls?id=&profile=   {url}: its HLS stream (a web one), for the page to play with
//                                hls.js; null: not HLS (then /stream)
//   GET  /api/source?id=&profile=   {url}: its stream's address (RTSP, or a web one), for mpv
//                                to read itself (salir's windows with phil's mpv plugin)
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
//   PUT  /api/camera             {id, invert}: its controls turned around (mounted upside down);
//                                {id, disabled}: turned off (not shown) or on; {id, name}
//   GET  /api/cameras/all        every camera, with its state (on, offline, off): the wall's list
//   POST /api/cameras/look       looks for them again, and checks the streams; as /all
//   POST /api/cameras/stream     {name, url}: a stream added by its URL (rtsp, or http(s))
//   DELETE /api/camera?id=       a stream added by URL goes; a camera is forgotten
//   GET  /api/presets?id=        its saved positions
//   POST /api/snapshot           {id}: a picture from its best stream, in ~/Pictures/Cameras
import { join } from "@std/path";
import { httpError, json } from "../../engine/http.js";
import * as cameras from "./cameras.js";
import { isLocalHost, presets, ptz, stream } from "./live.js";

export const UI_DIR = new URL("./ui/", import.meta.url);

export function createServer({ profile = {} } = {}) {
  if (profile.incognito) cameras.keepInMemory();

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
        case "GET /api/source": // ?id=&profile=: {url, local}: its stream as it is, for mpv (ui/app.js); local: on this network
          try {
            const source = await cameras.rtspUrl(id, url.searchParams.get("profile"));
            return json({ url: source, local: isLocalHost(source) });
          } catch (err) {
            throw httpError(err.status ?? (err.auth ? 403 : 502), err.message);
          }
        case "GET /api/hls": // ?id=&profile=: {url}: its HLS stream, for the page to play itself, or null (then /stream)
          try {
            return json({ url: await cameras.hlsUrl(id, url.searchParams.get("profile")) });
          } catch (err) {
            throw httpError(err.status ?? 502, err.message);
          }
        case "GET /stream":
          return await stream(req, id, url.searchParams.get("profile"), url.searchParams.get("mode") ?? "copy");
        case "POST /api/log":
          console.error(`camview: ${String((await req.json()).message ?? "").slice(0, 500)}`);
          return json({ ok: true });
        case "PUT /api/camera": { // {id, invert} / {id, disabled} / {id, name} / {id, profile} / {id, buffer}
          const { id: which, ...rest } = await req.json();
          const changes = Object.fromEntries(Object.entries(rest).filter(([k]) => ["invert", "disabled", "name", "profile", "buffer"].includes(k)));
          return json(await cameras.update(String(which ?? ""), changes));
        }
        case "GET /api/cameras/all": // every camera, with whether it's on, offline or off (the wall's list)
          return json(await cameras.all());
        case "POST /api/cameras/look": // looks for them again (and checks the streams): every camera, as GET /api/cameras/all
          await cameras.discover({ force: true });
          return json(await cameras.all());
        case "POST /api/cameras/stream": // {name, url}: a stream added by its URL
          try {
            return json(await cameras.addStream(await req.json()));
          } catch (err) {
            throw httpError(err.status ?? 400, err.message);
          }
        case "DELETE /api/camera": // ?id=: a stream added by URL goes; a camera is forgotten
          await cameras.remove(String(id ?? "")).catch((err) => {
            throw httpError(err.status ?? 400, err.message);
          });
          return json({ ok: true });
        case "POST /api/ptz":
          return json(await ptz(await req.json()));
        case "GET /api/presets":
          return json(await presets(id));
        case "POST /api/snapshot":
          return json(await snapshot((await req.json()).id));
      }
      return null;
    },
  };
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
    args: ["-loglevel", "error", "-nostdin", ...cameras.inputArgs(rtsp), "-i", rtsp, "-frames:v", "1", "-q:v", "2", "-y", path],
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
