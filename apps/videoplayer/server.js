// videoplayer's server: the videos in a folder, how to play one (probe()), the
// file itself, or (what the browser can't play: AVI, MPEG-TS, WMV, HEVC...) the
// file made into a fragmented MP4 as it plays (stream()), and the settings and
// where each video was left. Runs in the engine's server worker (engine/server.js).
//   GET  /api/videos?path=&sort=   the videos in its folder (engine/media.js)
//   GET  /api/probe?path=          how to play it: {duration, width, height, direct, subtitles, ...}
//   GET  /api/subtitle?path=&stream=&from= | ?file=   a subtitle track's cues, as they're read (NDJSON)
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
import { basename, dirname, extname, join, relative } from "@std/path";
import { httpError, json, serveFile } from "../../engine/http.js";
import { mediaInFolder, mediaKind } from "../../engine/media.js";

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
  subtitles: "auto", // shown first: "auto" (a file named as the video, or the ones it says to), "off", or a language ("English": the last chosen)
  transcode: { preset: "veryfast", crf: 22, maxHeight: 1080 }, // what the browser can't decode, made into H.264
};

// What Chromium (and WebKit, mostly) plays itself: these codecs in these containers.
const VIDEO_OK = new Set(["h264", "vp8", "vp9", "av1"]);
const AUDIO_OK = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
const CONTAINER_OK = /^(mov,mp4|matroska,webm|ogg)/;
// Copied as they are into the MP4 stream() makes; the rest is converted.
const VIDEO_COPY = new Set(["h264", "vp9", "av1"]);
const AUDIO_COPY = new Set(["aac", "mp3", "opus", "flac"]);
// Subtitles that are text, which ffmpeg makes into WebVTT (the rest, PGS and DVD's, are pictures).
const TEXT_SUBS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text", "microdvd", "subviewer", "mpl2", "realtext", "sami"]);
const SUB_FILE = /\.(srt|vtt|ass|ssa)$/i;
const SUBS_DIR = /^(subs?|subtitles)$/i;

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
        case "GET /api/probe": {
          const [info, files] = await Promise.all([probe(absolute(path)), subtitleFiles(absolute(path))]);
          return json({ ...info, subtitles: [...info.subtitles, ...files] });
        }
        case "GET /api/subtitle": {
          const file = url.searchParams.get("file");
          const stream = Number(url.searchParams.get("stream"));
          if (!file && !(stream >= 0)) throw httpError(400, "stream or file required");
          return subtitle(absolute(path), file ? absolute(file) : null, stream, Number(url.searchParams.get("from")) || 0);
        }
        case "GET /file":
        case "HEAD /file":
          return serveFile(req, absolute(path), { "content-security-policy": "sandbox" });
        case "GET /api/seekpoint": // where a stream asked for at `t` really starts (see stream())
          return json({ t: await seekPoint(absolute(path), Number(url.searchParams.get("t")) || 0) });
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
  for (const key of ["volume", "muted", "resume", "playNext", "loop", "subtitles"]) {
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
    sampleRate: Number(audio?.sample_rate) || 0,
    // Its subtitles: {stream, lang, title, forced, default, text (false: pictures, not shown)}.
    subtitles: streams.filter((s) => s.codec_type === "subtitle").map((s) => ({
      stream: s.index,
      lang: s.tags?.language ?? "",
      title: s.tags?.title ?? "",
      forced: !!s.disposition?.forced,
      default: !!s.disposition?.default,
      text: TEXT_SUBS.has(s.codec_name),
    })),
    // How late the first picture comes, in a copy (its frames reordered: B-frames).
    delay: video ? (video.has_b_frames || 0) / (rate(video.avg_frame_rate) || rate(video.r_frame_rate) || 25) : 0,
    container,
    direct,
  };
}

const rate = (r) => {
  const [n, d] = String(r ?? "").split("/").map(Number);
  return n > 0 && d > 0 ? n / d : 0;
};

/**
 * The keyframe at or before `t` in `path`'s video, where seeking there lands (ffprobe's
 * seek, ffmpeg's): a copied video can only start at one, so its stream does (stream()).
 * `t` itself when the video is converted (or there's none), or it can't tell.
 */
async function seekPoint(path, t, info = null) {
  if (t <= 0) return 0;
  const { video } = info ?? await probe(path);
  if (!VIDEO_COPY.has(video)) return t;
  const out = await new Deno.Command("ffprobe", {
    args: ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", "-read_intervals", `${t}%+#1`, "--", path],
    stdin: "null", stdout: "piped", stderr: "null",
  }).output().catch(() => null);
  const at = out?.success ? parseFloat(new TextDecoder().decode(out.stdout)) : NaN;
  return at >= 0 && at <= t + 0.001 ? at : t;
}

/**
 * `path` from `t` seconds as a fragmented MP4, made as it's read (ffmpeg, to
 * the response): the video and audio copied when the browser plays them,
 * converted when not. Seeking further than it got is a new request (with t).
 *
 * A copied video starts at a keyframe (seekPoint()'s), the audio there too: the
 * browser plays the audio on from its first sample, whatever the gap the MP4
 * says comes before it, so a gap is filled with silence, as audio (converted,
 * to do that). Its first picture comes `delay` late (B-frames reordered; an MP4
 * made as it's read can't say otherwise): the audio starts that late too, less
 * the AAC encoder's own lead-in (1024 samples).
 * The response cancelled (the player went elsewhere) stops ffmpeg.
 */
async function stream(path, t, settings) {
  const info = await probe(path);
  const { video, audio, delay, sampleRate } = info;
  const { preset = "veryfast", crf = 22, maxHeight = 1080 } = settings.transcode ?? {};
  const copy = VIDEO_COPY.has(video);
  let from = [], pad = null;
  if (copy) {
    // ffmpeg seeks 3/23 s before where it's asked with B-frames (fftools): asked
    // that much past the keyframe, it lands on it either way. Both start there.
    const key = await seekPoint(path, t, info);
    const ss = key > 0 ? key + (delay > 0 ? 3 / 23 : 0) + 0.001 : 0;
    if (ss > 0) from = ["-noaccurate_seek", "-ss", ss.toFixed(3)];
    // The first audio sample's time (in samples; from ss): the picture's, less the encoder's lead-in.
    if (audio && sampleRate) pad = Math.min(0, Math.round((key - ss - delay) * sampleRate) + 1024);
  } else if (t > 0) {
    from = ["-ss", String(t)];
  }
  const args = ["-nostdin", "-loglevel", "error", ...from, "-i", path, "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn"];
  if (!video) args.push("-vn");
  else if (VIDEO_COPY.has(video)) args.push("-c:v", "copy");
  else args.push("-c:v", "libx264", "-preset", String(preset), "-crf", String(crf), "-pix_fmt", "yuv420p", "-vf", `scale=-2:min(ih\\,${Number(maxHeight) || 1080})`);
  if (!audio) args.push("-an");
  else if (pad !== null) args.push("-af", `aresample=async=1:first_pts=${pad}`, "-c:a", "aac", "-b:a", "192k", "-ac", "2");
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

/**
 * The subtitle files that go with `path`: beside it, named as it is (Movie.srt,
 * Movie.en.srt), or in a Subs folder there, in one named as it is (a season's:
 * Subs/Show.S01E02/2_English.srt). When it's the only video in its folder (a film's),
 * any there and in Subs. {file, name (from its folder), exact (Movie.srt, beside it)}.
 */
async function subtitleFiles(path) {
  const dir = dirname(path), stem = basename(path, extname(path)).toLowerCase();
  const list = async (d) => {
    const out = [];
    try {
      for await (const e of Deno.readDir(d)) out.push(e);
    } catch { /* none */ }
    return out;
  };
  const here = await list(dir);
  const alone = here.filter((e) => e.isFile && mediaKind(e.name) === "video").length === 1;
  const found = [];
  const add = (file, exact = false) => found.push({ file, name: relative(dir, file), lang: "", title: "", forced: false, default: false, text: true, exact });
  for (const e of here) {
    const named = e.name.toLowerCase().startsWith(stem);
    if (e.isFile && SUB_FILE.test(e.name) && (named || alone)) add(join(dir, e.name), named);
    if (!e.isDirectory || !SUBS_DIR.test(e.name)) continue;
    for (const s of await list(join(dir, e.name))) {
      if (s.isFile && SUB_FILE.test(s.name) && (alone || s.name.toLowerCase().startsWith(stem))) add(join(dir, e.name, s.name));
      if (s.isDirectory && s.name.toLowerCase() === stem) {
        for (const f of await list(join(dir, e.name, s.name))) if (f.isFile && SUB_FILE.test(f.name)) add(join(dir, e.name, s.name, f.name));
      }
    }
  }
  return found.sort((a, b) => b.exact - a.exact || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// A subtitle file's encoding, when it isn't UTF-8: the one its language's Windows used
// (from its name: Movie.rus.srt), western European otherwise.
const CHARSETS = [
  [/^(rus?|ukr?|bul|bg|srp|sr|mkd|mac|bel|be)$/, "CP1251"],
  [/^(pol?|pl|cze|ces|cs|slo|slk|sk|hun?|rum|ron|ro|slv|sl|hrv|hr|scr|bos|bs)$/, "CP1250"],
  [/^(gre|ell|el)$/, "CP1253"],
  [/^(tur?|tr)$/, "CP1254"],
  [/^(heb?|he)$/, "CP1255"],
  [/^(ara?|ar)$/, "CP1256"],
  [/^(lit|lt|lav|lv|est|et)$/, "CP1257"],
  [/^(vie|vi)$/, "CP1258"],
];
async function charsetOf(file) {
  const bytes = await Deno.readFile(file);
  if (bytes[0] === 0xff || bytes[0] === 0xfe) return null; // UTF-16, its BOM says (ffmpeg reads it)
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return null;
  } catch {
    const words = basename(file).toLowerCase().split(/[^a-z]+/);
    return CHARSETS.find(([re]) => words.some((w) => re.test(w)))?.[1] ?? "CP1252";
  }
}

// Whole tracks' cues, read before (`${path}\n${track}` -> {mtime, cues}): choosing one again is at once.
const subtitleCache = new Map();
const SUBTITLES_KEPT = 40;

/**
 * A subtitle track's cues, as NDJSON lines ([start, end, text]: seconds, WebVTT's text)
 * as ffmpeg reads them: the file's `stream`, or the subtitle `file`. The video's own
 * are spread through it, all of it read to find them (a film's, over a minute
 * from a slow drive): from `from` (where it's playing) to the end first, then the
 * start, at the lowest priority (the video's playing from the same drive).
 * Cancelled (another track, another video), ffmpeg's stopped.
 */
function subtitle(path, file, stream, from) {
  const key = `${path}\n${file ?? stream}`;
  const stop = new AbortController();
  async function* cues() {
    const mtime = (await Deno.stat(file ?? path)).mtime?.getTime();
    const known = subtitleCache.get(key);
    if (known?.mtime === mtime) return yield* known.cues;
    const all = [], seen = new Set();
    const passes = file
      ? [[...(await charsetOf(file).then((c) => (c ? ["-sub_charenc", c] : []))), "-i", file, "-map", "0:s:0"]]
      : from > 1
      ? [["-ss", String(from), "-copyts", "-i", path, "-map", `0:${stream}`], ["-i", path, "-map", `0:${stream}`, "-t", String(from + 5)]]
      : [["-i", path, "-map", `0:${stream}`]];
    for (const args of passes) {
      for await (const cue of vttCues(args, stop.signal)) {
        const id = `${cue[0]}\n${cue[2]}`;
        if (seen.has(id)) continue;
        seen.add(id);
        all.push(cue);
        yield cue;
      }
    }
    if (stop.signal.aborted) return;
    subtitleCache.delete(key);
    subtitleCache.set(key, { mtime, cues: all.sort((a, b) => a[0] - b[0]) });
    if (subtitleCache.size > SUBTITLES_KEPT) subtitleCache.delete(subtitleCache.keys().next().value);
  }
  const it = cues(), enc = new TextEncoder();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await it.next();
        if (done) controller.close();
        else controller.enqueue(enc.encode(JSON.stringify(value) + "\n"));
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      stop.abort();
      it.return();
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}

// ffmpeg's WebVTT of `args`' input, cue by cue as it comes: [start, end, text]. At the
// lowest priority (ionice's idle, when there's ionice), stopped with `signal`.
async function* vttCues(args, signal) {
  const ffmpeg = ["ffmpeg", "-nostdin", "-v", "error", ...args, "-flush_packets", "1", "-f", "webvtt", "pipe:1"];
  const options = { stdin: "null", stdout: "piped", stderr: "null", signal };
  let child;
  try {
    child = new Deno.Command("ionice", { ...options, args: ["-c", "3", "nice", "-n", "19", ...ffmpeg] }).spawn();
  } catch {
    child = new Deno.Command(ffmpeg[0], { ...options, args: ffmpeg.slice(1) }).spawn();
  }
  child.status.catch(() => {});
  let text = "";
  try {
    for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
      text += chunk.replaceAll("\r", "");
      const blocks = text.split("\n\n");
      text = blocks.pop();
      for (const b of blocks) {
        const cue = parseCue(b);
        if (cue) yield cue;
      }
    }
    const cue = parseCue(text);
    if (cue) yield cue;
  } finally {
    try {
      child.kill("SIGKILL");
    } catch { /* done */ }
  }
}

function parseCue(block) {
  const lines = block.split("\n");
  const at = lines.findIndex((l) => l.includes("-->"));
  if (at < 0) return null;
  const [start, end] = lines[at].split("-->").map((s) => seconds(s.trim().split(/\s/)[0]));
  const text = lines.slice(at + 1).join("\n").trim();
  return text && end > start ? [start, end, text] : null;
}

// "01:02:03.456" or "02:03.456" in seconds.
const seconds = (s) => s.split(":").reduce((t, part) => t * 60 + Number(part), 0);
