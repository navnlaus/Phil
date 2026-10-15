// videoplayer's server: the videos in a folder, how to play one (probe()), the
// file itself, or (what the browser can't play: AVI, MPEG-TS, WMV, HEVC...) the
// file made into a fragmented MP4 as it plays (stream()), and the settings and
// where each video was left. Runs in the engine's server worker (engine/server.js).
//   GET  /api/videos?path=&sort=   the videos in its folder (engine/media.js)
//   GET  /api/probe?path=          how to play it: {duration, width, height, direct, ...}
//   GET  /file?path=               the file (Range: seeking)
//   GET  /stream?path=&t=          it, from `t` seconds, as fragmented MP4 (ffmpeg)
//   GET  /api/settings             the settings and where the video was left
//   PUT  /api/settings             {settings}: changed in the player
//   PUT  /api/position             {path, t, done}: where it was left (done: watched to the end, kept as t null; t null: barely begun, forgotten)
//   POST /api/mpv                  {path, t}: plays it in mpv from there
//   GET  /user.css                 ~/.config/phil/videoplayer.css, the player restyled
//
// Incognito (the engine's profile): the settings are read but changes, and where
// videos were left, are kept in memory only; nothing's written, and mpv's told
// not to remember either.
import { join } from "@std/path";
import { httpError, json, serveFile } from "../../engine/http.js";
import { mediaInFolder } from "../../engine/media.js";

export const UI_DIR = new URL("./ui/", import.meta.url);

const home = Deno.env.get("HOME") ?? "/";
const configDir = join(Deno.env.get("XDG_CONFIG_HOME") || join(home, ".config"), "phil");
const SETTINGS_FILE = join(configDir, "videoplayer.json");
const USER_CSS = join(configDir, "videoplayer.css");
const POSITIONS_FILE = join(Deno.env.get("XDG_STATE_HOME") || join(home, ".local", "state"), "phil", "videoplayer-positions.json");
const MAX_POSITIONS = 500; // the most recent ones kept

// What the settings are when the file doesn't say (ui/app.js documents them).
export const DEFAULTS = {
  volume: 1,
  muted: false,
  speed: 1, // what each video starts at ([ ] change it for this one)
  resume: true, // start where the video was left
  playNext: false, // at the end, the next video in the folder
  loop: false,
  seekStep: 5, // ← →, seconds
  seekStepLong: 60, // Shift+← →
  hideControlsAfter: 2, // seconds without the mouse moving, while playing
  transcode: { preset: "veryfast", crf: 22, maxHeight: 1080 }, // what the browser can't decode, made into H.264
};

// What Chromium (and WebKit, mostly) plays itself: these codecs in these containers.
const VIDEO_OK = new Set(["h264", "vp8", "vp9", "av1"]);
const AUDIO_OK = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
const CONTAINER_OK = /^(mov,mp4|matroska,webm|ogg)/;
// Copied as they are into the MP4 stream() makes; the rest is converted.
const VIDEO_COPY = new Set(["h264", "vp9", "av1"]);
const AUDIO_COPY = new Set(["aac", "mp3", "opus", "flac"]);

export function createServer({ profile = {} } = {}) {
  const incognito = !!profile.incognito;
  let settings = null; // read once, then this
  let positions = null; // incognito's: path -> {t, at} (otherwise the file, read each time: phil changes it too, when videos move)
  const readSettings = async () =>
    settings ??= { ...DEFAULTS, ...await Deno.readTextFile(SETTINGS_FILE).then(JSON.parse, () => ({})) };
  const readPositions = async () =>
    incognito ? (positions ??= new Map()) : new Map(Object.entries(await Deno.readTextFile(POSITIONS_FILE).then(JSON.parse, () => ({}))));

  async function savePositions(list) {
    if (incognito) return;
    const recent = [...list].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_POSITIONS);
    await Deno.mkdir(join(POSITIONS_FILE, ".."), { recursive: true });
    const tmp = `${POSITIONS_FILE}.${crypto.randomUUID().slice(0, 8)}.tmp`; // (whole, for whoever reads it: mediaview, phil)
    await Deno.writeTextFile(tmp, JSON.stringify(Object.fromEntries(recent)));
    await Deno.rename(tmp, POSITIONS_FILE);
  }

  return {
    async handle(req, url) {
      const path = url.searchParams.get("path");
      switch (`${req.method} ${url.pathname}`) {
        case "GET /api/videos": {
          const { dir, items, index } = await mediaInFolder(absolute(path), "video", url.searchParams.get("sort") ?? "name");
          return json({ dir, videos: items, index });
        }
        case "GET /api/probe":
          return json(await probe(absolute(path)));
        case "GET /file":
        case "HEAD /file":
          return serveFile(req, absolute(path), { "content-security-policy": "sandbox" });
        case "GET /stream":
          return stream(absolute(path), Number(url.searchParams.get("t")) || 0, await readSettings());
        case "GET /api/settings": {
          const at = path ? (await readPositions()).get(path) : null;
          return json({ settings: await readSettings(), position: at?.t ?? null, incognito, file: SETTINGS_FILE.replace(home, "~") });
        }
        case "PUT /api/settings": {
          const changed = await req.json();
          settings = { ...await readSettings(), ...pick(changed) };
          if (!incognito) {
            // Only what differs from the defaults goes in the file (and what the file had that
            // the player doesn't know, kept).
            const saved = await Deno.readTextFile(SETTINGS_FILE).then(JSON.parse, () => ({}));
            const out = { ...saved };
            for (const [k, v] of Object.entries(settings)) {
              if (JSON.stringify(v) === JSON.stringify(DEFAULTS[k])) delete out[k];
              else out[k] = v;
            }
            await Deno.mkdir(configDir, { recursive: true });
            await Deno.writeTextFile(SETTINGS_FILE, JSON.stringify(out, null, 2) + "\n");
          }
          return json({ ok: true });
        }
        case "PUT /api/position": {
          const { path: file, t, done } = await req.json();
          const list = await readPositions();
          if (done) list.set(absolute(file), { t: null, at: Date.now() }); // watched (mediaview's ✓, and its next episode)
          else if (typeof t === "number" && t > 0) list.set(absolute(file), { t: Math.round(t), at: Date.now() });
          else list.delete(absolute(file));
          await savePositions(list);
          return json({ ok: true });
        }
        case "POST /api/mpv": {
          const { path: file, t } = await req.json();
          const args = [...(t > 0 ? [`--start=${Math.floor(t)}`] : []), ...(incognito ? ["--save-position-on-quit=no", "--no-resume-playback"] : []), "--", absolute(file)];
          const child = new Deno.Command("mpv", { args, stdin: "null", stdout: "null", stderr: "null" }).spawn();
          child.unref();
          child.status.catch(() => {});
          return json({ ok: true });
        }
        case "GET /user.css": {
          const css = await Deno.readTextFile(USER_CSS).catch(() => "");
          return new Response(css, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" } });
        }
      }
      return null;
    },
  };
}

// The settings the player may change (the rest only by editing the file).
function pick(changed) {
  const out = {};
  for (const key of ["volume", "muted", "resume", "playNext", "loop"]) {
    if (typeof changed?.[key] === typeof DEFAULTS[key]) out[key] = changed[key];
  }
  return out;
}

function absolute(path) {
  if (!path?.startsWith("/")) throw httpError(400, "absolute path required");
  return path;
}

/**
 * How to play `path`: {duration, width, height, video, audio (codecs), direct}.
 * `direct`: the browser should play the file itself (otherwise /stream, which
 * it can); HEVC is worth a try (some browsers decode it on the GPU).
 */
async function probe(path) {
  const out = await new Deno.Command("ffprobe", {
    args: ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "--", path],
    stdin: "null", stdout: "piped", stderr: "piped",
  }).output().catch(() => null);
  if (!out) throw httpError(500, "ffprobe isn't installed");
  if (!out.success) throw httpError(415, new TextDecoder().decode(out.stderr).trim().split("\n").pop() || "Not a video");
  const info = JSON.parse(new TextDecoder().decode(out.stdout));
  const streams = info.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === "audio");
  const container = info.format?.format_name ?? "";
  const direct = CONTAINER_OK.test(container) && (!video || VIDEO_OK.has(video.codec_name) || video.codec_name === "hevc") &&
    (!audio || AUDIO_OK.has(audio.codec_name));
  return {
    duration: Number(info.format?.duration) || null,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    video: video?.codec_name ?? null,
    audio: audio?.codec_name ?? null,
    container,
    direct,
  };
}

/**
 * `path` from `t` seconds as a fragmented MP4, made as it's read (ffmpeg, to
 * the response): the video and audio copied when the browser plays them,
 * converted when not. Seeking further than it got is a new request (with t).
 * The response cancelled (the player went elsewhere) stops ffmpeg.
 */
async function stream(path, t, settings) {
  const { video, audio } = await probe(path);
  const { preset = "veryfast", crf = 22, maxHeight = 1080 } = settings.transcode ?? {};
  const args = ["-nostdin", "-loglevel", "error", ...(t > 0 ? ["-ss", String(t)] : []), "-i", path, "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn"];
  if (!video) args.push("-vn");
  else if (VIDEO_COPY.has(video)) args.push("-c:v", "copy");
  else args.push("-c:v", "libx264", "-preset", String(preset), "-crf", String(crf), "-pix_fmt", "yuv420p", "-vf", `scale=-2:min(ih\\,${Number(maxHeight) || 1080})`);
  if (!audio) args.push("-an");
  else if (AUDIO_COPY.has(audio)) args.push("-c:a", "copy", ...(audio === "aac" ? ["-bsf:a", "aac_adtstoasc"] : [])); // (MPEG-TS's AAC: ADTS)
  else args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2");
  args.push("-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1");
  const child = new Deno.Command("ffmpeg", { args, stdin: "null", stdout: "piped", stderr: "null" }).spawn();
  const stop = () => {
    try {
      child.kill("SIGKILL");
    } catch { /* gone */ }
  };
  const reader = child.stdout.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: stop,
  });
  return new Response(body, { headers: { "content-type": "video/mp4", "cache-control": "no-store" } });
}
