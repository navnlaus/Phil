// Songs' tags (MP3's ID3, FLAC's and Ogg's Vorbis comments, M4A's): read with
// ffprobe, written with ffmpeg (the audio copied as it is: -c copy), and their
// cover art (the picture in the file) for the thumbnail (thumbs.js) and the
// Properties' tab. Tags are ffmpeg's names for them (title, artist, album,
// album_artist, date, track, disc, genre, comment, composer, ...); ones it has
// no name for are kept as they're called (an MP3's TXXX).
//
// What a tile shows (title, artist, album, how long) is kept next to the
// thumbnails, <thumbs>/audio/<key>.json, by the file's path, size and time
// (thumbs.key), so a folder lists its songs' names without reading them again.

import { basename, dirname, extname, join } from "@std/path";

const PROBE_MS = 15_000;
const COVER_PX = 1200; // a new cover's longer side, at most

export class AudioInfo {
  /** `dir`: where the tiles' summaries are kept (null: in memory, incognito); `key(path, stat)`: thumbs.js's. */
  constructor(dir, key) {
    this.dir = dir;
    this.key = key;
    this.memory = new Map();
  }

  async file(path, stat) {
    return join(this.dir, `${await this.key(path, stat)}.json`);
  }

  /** What a tile shows, if it's been read: {title, artist, album, duration} (or {} : nothing), else null. */
  async lookup(path, stat) {
    if (!this.dir) return this.memory.get(`${path}\0${stat.size}\0${stat.mtime?.getTime()}`) ?? null;
    try {
      return JSON.parse(await Deno.readTextFile(await this.file(path, stat)));
    } catch {
      return null;
    }
  }

  /** What a tile shows, read now if need be (and kept). */
  async get(path, stat = null) {
    stat ??= await Deno.stat(path);
    const known = await this.lookup(path, stat);
    if (known) return known;
    const info = await readAudio(path).catch(() => null);
    const short = info ? tileInfo(info) : {};
    if (!this.dir) this.memory.set(`${path}\0${stat.size}\0${stat.mtime?.getTime()}`, short);
    else {
      await Deno.mkdir(this.dir, { recursive: true });
      const file = await this.file(path, stat), tmp = `${file}.${crypto.randomUUID().slice(0, 8)}.tmp`;
      await Deno.writeTextFile(tmp, JSON.stringify(short));
      await Deno.rename(tmp, file);
    }
    return short;
  }
}

const tileInfo = ({ tags, duration }) => {
  const out = {};
  for (const key of ["title", "artist", "album"]) if (tags[key]) out[key] = tags[key];
  if (!out.artist && tags.album_artist) out.artist = tags.album_artist;
  if (duration) out.duration = duration;
  return out;
};

/**
 * Everything about a song: {tags: {name: value}, format ("MP3", "FLAC"...),
 * codec, duration (s), bitrate (bits/s), sampleRate, channels, cover (it has
 * one: {width, height, codec}), id3 (an MP3's ID3v2 version, if ffprobe says)}.
 */
export async function readAudio(path) {
  const out = await new Deno.Command("ffprobe", {
    args: ["-v", "error", "-show_format", "-show_streams", "-of", "json", "--", path],
    stdin: "null", stdout: "piped", stderr: "piped", signal: AbortSignal.timeout(PROBE_MS),
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr).trim().split("\n").at(-1) || "ffprobe failed");
  const { format = {}, streams = [] } = JSON.parse(new TextDecoder().decode(out.stdout));
  const audio = streams.find((s) => s.codec_type === "audio") ?? {};
  const picture = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic);
  // Ogg and Opus keep their comments on the stream, the rest on the file.
  const tags = {};
  for (const [k, v] of Object.entries({ ...audio.tags, ...format.tags })) tags[k.toLowerCase()] = String(v);
  delete tags.encoder; // (ffmpeg's own, rewritten by every save)
  return {
    tags,
    format: formatName(path, format.format_name),
    codec: audio.codec_long_name ?? audio.codec_name ?? null,
    duration: Number(format.duration) || null,
    bitrate: Number(format.bit_rate) || Number(audio.bit_rate) || null,
    sampleRate: Number(audio.sample_rate) || null,
    channels: audio.channels ?? null,
    cover: picture ? { width: picture.width, height: picture.height, codec: picture.codec_name } : null,
  };
}

const formatName = (path, ffmpegName = "") => {
  const ext = extname(path).slice(1).toUpperCase();
  return ext || ffmpegName.split(",")[0].toUpperCase();
};

/** The song's cover art, as the file has it: {bytes, type}, or null. */
export async function readCover(path) {
  const info = await readAudio(path);
  if (!info.cover) return null;
  const png = info.cover.codec === "png";
  const out = await new Deno.Command("ffmpeg", {
    args: ["-v", "error", "-i", path, "-an", "-map", "0:v:0", "-c", "copy", "-f", png ? "image2pipe" : "mjpeg", "-"],
    stdin: "null", stdout: "piped", stderr: "null", signal: AbortSignal.timeout(PROBE_MS),
  }).output();
  return out.success && out.stdout.length ? { bytes: out.stdout, type: png ? "image/png" : "image/jpeg" } : null;
}

/** The cover art written to `out` (a JPEG), for thumbs.js; throws if there's none. */
export async function coverTo(path, out, signal) {
  const res = await new Deno.Command("ffmpeg", {
    args: ["-v", "error", "-y", "-i", path, "-an", "-map", "0:v:0", "-frames:v", "1", "-q:v", "2", out],
    stdin: "null", stdout: "null", stderr: "piped", signal,
  }).output();
  if (!res.success || !(await Deno.stat(out).then((s) => s.size > 0, () => false))) throw new Error("no cover art");
}

/**
 * Writes a song's tags (`tags`: all of them, as they're to be: one left out is
 * removed) and its cover art (`cover`: "keep", "remove", or {bytes, type} for a
 * new one), into a copy that then takes its place (the audio is copied as it
 * is). Its permissions are kept.
 */
export async function writeAudio(path, { tags, cover = "keep" }) {
  const info = await readAudio(path);
  const ext = extname(path).toLowerCase();
  const ogg = /^\.(ogg|oga|opus|spx)$/.test(ext);
  if (ogg && cover !== "keep") throw new Error("ffmpeg can't write cover art into Ogg files");
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${crypto.randomUUID().slice(0, 8)}.tmp${ext}`);
  const coverFile = typeof cover === "object" ? join(Deno.env.get("XDG_RUNTIME_DIR") || "/tmp", `phil-cover-${crypto.randomUUID()}${cover.type === "image/png" ? ".png" : ".jpg"}`) : null;
  const args = ["-v", "error", "-y", "-i", path];
  const sized = coverFile && `${coverFile}.sized.jpg`;
  if (coverFile) {
    await Deno.writeFile(coverFile, cover.bytes, { mode: 0o600 });
    // Cover-sized (a photo is far bigger): a JPEG, COVER_PX at most; vips failing, the picture as given.
    const made = await new Deno.Command("vipsthumbnail", { args: [coverFile, "--size", `${COVER_PX}x${COVER_PX}>`, "-o", `${sized}[Q=90,strip]`], stdin: "null", stdout: "null", stderr: "null" })
      .output().then((r) => r.success, () => false);
    args.push("-i", made && await Deno.stat(sized).then(() => true, () => false) ? sized : coverFile);
  }
  args.push("-map", "0:a");
  if (coverFile) args.push("-map", "1:0", "-disposition:v:0", "attached_pic", "-metadata:s:v:0", "title=Album cover", "-metadata:s:v:0", "comment=Cover (front)");
  else if (cover === "keep" && info.cover) args.push("-map", "0:v:0");
  args.push("-c", "copy", "-map_metadata", "-1");
  for (const [key, value] of Object.entries(tags)) {
    if (!/^[\w.:-]{1,64}$/.test(key) || value === "") continue;
    args.push(ogg ? "-metadata:s:a:0" : "-metadata", `${key}=${value}`);
  }
  if (ext === ".mp3") args.push("-id3v2_version", "3", "-write_id3v1", "1"); // (what most players read)
  args.push("--", tmp);
  try {
    const res = await new Deno.Command("ffmpeg", { args, stdin: "null", stdout: "null", stderr: "piped" }).output();
    if (!res.success) throw new Error(new TextDecoder().decode(res.stderr).trim().split("\n").at(-1) || "ffmpeg failed");
    const mode = (await Deno.stat(path)).mode;
    if (mode !== null) await Deno.chmod(tmp, mode & 0o7777);
    await Deno.rename(tmp, path);
  } finally {
    await Deno.remove(tmp).catch(() => {});
    if (coverFile) for (const f of [coverFile, sized]) await Deno.remove(f).catch(() => {});
  }
  return await readAudio(path);
}
