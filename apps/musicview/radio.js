// musicview's radio: stations by their stream's address, or a playlist's (.pls,
// .m3u: resolved when played, so a station's current servers are used). The
// stream comes through musicview's server (the page is HTTPS, and many
// stations are plain HTTP); what's playing on it comes from the station's own
// list of songs when it has one (SomaFM's), else from the stream's titles
// (ICY: StreamTitle). Logos are kept on disk once fetched.
//
// SomaFM's stations come with musicview (somafm.json: from
// https://api.somafm.com/channels.json), added the first time; "Add SomaFM's
// stations" adds them again (new ones too: fetched afresh, else these).
import { join } from "@std/path";

const TIMEOUT_MS = 15_000;
const NOW_MS = 20_000; // what's playing, asked again after
const AGENT = "phil-musicview";

/** SomaFM's stations, as {id, name, url, ...}: fetched now, or (offline) the ones musicview came with. */
export async function somafmStations() {
  try {
    const res = await fetch("https://api.somafm.com/channels.json", { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": AGENT } });
    if (!res.ok) throw new Error(`${res.status}`);
    return (await res.json()).channels.map((c) => ({
      id: `somafm:${c.id}`, name: c.title, description: c.description, genre: String(c.genre ?? "").replaceAll("|", ", "),
      homepage: `https://somafm.com/${c.id}/`, image: c.largeimage || c.image,
      url: (c.playlists.find((p) => p.format === "mp3") ?? c.playlists[0]).url, nowPlaying: `https://somafm.com/songs/${c.id}.json`,
    }));
  } catch {
    return JSON.parse(await Deno.readTextFile(new URL("./somafm.json", import.meta.url))).stations;
  }
}

/** A playlist's (.pls, .m3u) first stream; a stream as it is. */
async function streamOf(url) {
  if (!/\.(pls|m3u)$/i.test(new URL(url).pathname)) return url;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": AGENT } });
  if (!res.ok) throw new Error(`The playlist: ${res.status} ${res.statusText}`);
  const text = await res.text();
  const found = /^File\d+=(\S+)/mi.exec(text)?.[1] ?? text.split("\n").map((l) => l.trim()).find((l) => /^https?:\/\//i.test(l));
  if (!found) throw new Error("The playlist has no stream in it");
  return found;
}

/** The station's stream, passed on as it comes (stopped when the page stops listening). */
export async function stream(station, req) {
  const url = await streamOf(station.url);
  const upstream = new AbortController();
  req.signal?.addEventListener("abort", () => upstream.abort());
  const res = await fetch(url, { signal: upstream.signal, headers: { "user-agent": AGENT, "icy-metadata": "0" } });
  if (!res.ok || !res.body) throw new Error(`The station: ${res.status} ${res.statusText}`);
  const type = res.headers.get("content-type")?.split(";")[0] || "audio/mpeg";
  return new Response(res.body, { headers: { "content-type": type, "cache-control": "no-store" } });
}

const nowCache = new Map(); // station id -> {at, now}

/** What's playing on it: {title, artist, album} (or {text}), or null; asked again every NOW_MS at most. */
export async function nowPlaying(station) {
  const cached = nowCache.get(station.id);
  if (cached && Date.now() - cached.at < NOW_MS) return cached.now;
  let now = null;
  try {
    if (station.nowPlaying) { // the station's own list of songs (SomaFM's), the newest first
      const res = await fetch(station.nowPlaying, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": AGENT } });
      const song = res.ok ? (await res.json()).songs?.[0] : null;
      if (song) now = { title: song.title || null, artist: song.artist || null, album: song.album || null };
    } else now = await icyTitle(await streamOf(station.url));
  } catch { /* not known */ }
  nowCache.set(station.id, { at: Date.now(), now });
  return now;
}

// The stream's title now (ICY's StreamTitle: "Artist - Title"), read from its
// first metadata block, then the stream let go.
async function icyTitle(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": AGENT, "icy-metadata": "1" } });
    const every = Number(res.headers.get("icy-metaint"));
    if (!res.ok || !every || !res.body) return null;
    const reader = res.body.getReader();
    let buf = new Uint8Array(0);
    while (true) {
      const { value, done } = await reader.read();
      if (done) return null;
      const both = new Uint8Array(buf.length + value.length);
      both.set(buf);
      both.set(value, buf.length);
      buf = both;
      if (buf.length > every) {
        const length = buf[every] * 16;
        if (buf.length < every + 1 + length) continue;
        const meta = new TextDecoder().decode(buf.subarray(every + 1, every + 1 + length));
        const title = /StreamTitle='(.*?)';/.exec(meta)?.[1]?.trim();
        if (!title) return null;
        const [artist, ...rest] = title.split(" - ");
        return rest.length ? { artist, title: rest.join(" - ") } : { title };
      }
      if (buf.length > 1 << 20) return null;
    }
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

/** The station's logo, kept in `dir` once fetched: {bytes, type}, or null. */
export async function logo(station, dir) {
  if (!station.image) return null;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(station.image)));
  const file = join(dir, Array.from(hash.subarray(0, 12), (b) => b.toString(16).padStart(2, "0")).join(""));
  try {
    return { bytes: await Deno.readFile(file), type: await Deno.readTextFile(`${file}.type`) };
  } catch { /* fetched below */ }
  const res = await fetch(station.image, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": AGENT } }).catch(() => null);
  if (!res?.ok) return null;
  const type = res.headers.get("content-type")?.split(";")[0] ?? "image/png";
  if (!type.startsWith("image/")) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeFile(file, bytes);
  await Deno.writeTextFile(`${file}.type`, type);
  return { bytes, type };
}
