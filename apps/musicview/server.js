// musicview's server: the library (library.js) of the folders marked as music
// (phil's metadata.json: a folder's Properties, "A music folder"), the songs and
// their cover art, and the radio stations (radio.js). Runs in the engine's
// server worker (engine/server.js).
//   GET    /api/library            every song, the music folders (away: not there now), the scan under way;
//                                  a scan starts when the last was a while ago
//   POST   /api/scan               the music folders scanned now (a folder just marked as music, Rescan)
//   GET    /api/events             the scan as it goes ("scan": {root, done, total}), and "library" when
//                                  it's done (server-sent events)
//   GET    /api/file?path=         a song, to play
//   GET    /api/cover?path=        its cover art, album-sized (kept once made)
//   GET    /api/stations           the radio stations; POST {name, url, homepage, image, genre,
//                                  description}: one added; PUT {id, ...}: one changed; DELETE ?id=
//   POST   /api/stations/somafm    SomaFM's stations added (again: new ones too)
//   GET    /api/radio/stream?id=   a station's stream, through here
//   GET    /api/radio/now?id=      what's playing on it
//   GET    /api/radio/logo?id=     its logo (kept once fetched)
//   GET    /api/view               how musicview was left (tab, sort...); PUT: changed
//   POST   /api/show               {path}: a song in its folder, in a phil window
//
// Incognito (the engine's profile): the library's read, never written.
import { dirname, join } from "@std/path";
import { httpError, json, serveFile, text } from "../../engine/http.js";
import { ask } from "../../engine/instance.js";
import { serverConfig } from "../phil/launch.js";
import { Hooks, metadataFile } from "../phil/hooks.js";
import { coverTo } from "../phil/audio.js";
import { Library, scan } from "./library.js";
import { logo, nowPlaying, somafmStations, stream } from "./radio.js";

export const UI_DIR = new URL("./ui/", import.meta.url);
const SCAN_EVERY_MS = 5 * 60_000; // the library opened: the music folders scanned again if the last scan was longer ago
const COVER_PX = 400;

export function createServer({ profile = {}, controlSocket = null }) {
  const config = serverConfig(profile);
  const hooks = new Hooks(metadataFile(config.settingsFile), { persist: !config.incognito }); // (phil's: a folder's Properties)
  const library = new Library(join(dirname(config.stateFile), "music.sqlite"), { write: !config.incognito });
  const coversDir = join(config.thumbDir, "music-covers");
  const logosDir = join(dirname(config.stateFile), "radio-logos");
  const listeners = new Set(); // /api/events
  let scanning = null, lastScan = 0;

  const tell = (event, data) => {
    const line = new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const c of listeners) {
      try {
        c.enqueue(line);
      } catch {
        listeners.delete(c);
      }
    }
  };

  // SomaFM's stations, the first time (somafm.json).
  if (!library.get("somafm")) {
    Deno.readTextFile(new URL("./somafm.json", import.meta.url)).then((t) => {
      for (const s of JSON.parse(t).stations) library.putStation(s);
      library.set("somafm", String(Date.now()));
    }).catch(() => {});
  }

  const musicRoots = async () => Object.entries(await hooks.all()).filter(([, m]) => m?.music === true).map(([p]) => p).sort();
  const roots = async () => Promise.all((await musicRoots()).map(async (path) => ({ path, away: !(await Deno.stat(path).then((s) => s.isDirectory, () => false)) })));

  function rescan() {
    if (scanning) return;
    scanning = { done: 0, total: 0 };
    lastScan = Date.now();
    (async () => {
      try {
        await scan(library, await musicRoots(), { progress: (p) => tell("scan", scanning = p) });
      } catch (err) {
        console.error(`musicview: scanning: ${err.message}`);
      } finally {
        scanning = null;
        tell("library", {});
      }
    })();
  }

  // A song's cover art, album-sized: made from the picture in it once, kept by its path, size and time.
  async function cover(path) {
    const stat = await Deno.stat(path);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${path}\0${stat.size}\0${stat.mtime?.getTime()}`)));
    const file = join(coversDir, Array.from(hash.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("") + ".jpg");
    if (await Deno.stat(file).then(() => true, () => false)) return file;
    if (await Deno.stat(`${file}.fail`).then(() => true, () => false)) return null;
    await Deno.mkdir(coversDir, { recursive: true });
    const raw = `${file}.${crypto.randomUUID().slice(0, 8)}.raw.jpg`, part = `${file}.${crypto.randomUUID().slice(0, 8)}.part.jpg`;
    try {
      await coverTo(path, raw);
      const made = await new Deno.Command("vipsthumbnail", { args: [raw, "--size", `${COVER_PX}x${COVER_PX}`, "-o", `${part}[Q=85,strip]`], stdin: "null", stdout: "null", stderr: "null" }).output();
      if (!made.success) throw new Error("vips");
      await Deno.rename(part, file);
      return file;
    } catch {
      await Deno.writeFile(`${file}.fail`, new Uint8Array()).catch(() => {});
      return null;
    } finally {
      await Deno.remove(raw).catch(() => {});
      await Deno.remove(part).catch(() => {});
    }
  }

  const stationOf = (url) => {
    const s = library.station(url.searchParams.get("id") ?? "");
    if (!s) throw httpError(404, "No such station");
    return s;
  };

  const station = (body, id) => {
    const name = String(body.name ?? "").trim(), address = String(body.url ?? "").trim();
    if (!name) throw httpError(400, "A name, please");
    if (!/^https?:\/\/\S+$/i.test(address)) throw httpError(400, "Its address: an http:// or https:// one (a stream, or a .pls or .m3u playlist)");
    const opt = (k) => (String(body[k] ?? "").trim() || null);
    return { id, name, url: address, homepage: opt("homepage"), image: opt("image"), genre: opt("genre"), description: opt("description"), nowPlaying: opt("nowPlaying") };
  };

  return {
    async handle(req, url) {
      const path = url.searchParams.get("path");
      switch (`${req.method} ${url.pathname}`) {
        case "GET /api/library":
          if (!scanning && Date.now() - lastScan > SCAN_EVERY_MS) rescan();
          return json({ songs: library.songs(), roots: await roots(), scanning });
        case "POST /api/scan":
          rescan();
          return json({ ok: true });
        case "GET /api/events": {
          let me;
          const body = new ReadableStream({
            start: (c) => void listeners.add(me = c),
            cancel: () => void listeners.delete(me),
          });
          return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
        }
        case "GET /api/file":
        case "HEAD /api/file":
          return serveFile(req, absolute(path));
        case "GET /api/cover": {
          const file = await cover(absolute(path)).catch(() => null);
          return file ? serveFile(req, file, { "cache-control": "private, max-age=86400" }) : text(404, "No cover art");
        }
        case "GET /api/stations":
          return json(library.stations());
        case "POST /api/stations": {
          const s = station(await req.json(), `user:${crypto.randomUUID()}`);
          library.putStation(s);
          return json(s);
        }
        case "PUT /api/stations": {
          const body = await req.json();
          const was = library.station(String(body.id ?? ""));
          if (!was) throw httpError(404, "No such station");
          const s = station({ ...was, ...body }, was.id);
          library.putStation(s);
          return json(s);
        }
        case "DELETE /api/stations":
          library.removeStation(url.searchParams.get("id") ?? "");
          return json({ ok: true });
        case "POST /api/stations/somafm": {
          const known = new Set(library.stations().map((s) => s.id));
          const all = await somafmStations();
          for (const s of all) library.putStation(s);
          library.set("somafm", String(Date.now()));
          return json({ added: all.filter((s) => !known.has(s.id)).length, stations: library.stations() });
        }
        case "GET /api/radio/stream":
          try {
            return await stream(stationOf(url), req);
          } catch (err) {
            throw httpError(502, err.message);
          }
        case "GET /api/radio/now":
          return json(await nowPlaying(stationOf(url)));
        case "GET /api/radio/logo": {
          const l = await logo(stationOf(url), logosDir).catch(() => null);
          return l ? new Response(l.bytes, { headers: { "content-type": l.type, "cache-control": "private, max-age=86400" } }) : text(404, "No logo");
        }
        case "GET /api/view":
          return json(JSON.parse(library.get("view") ?? "{}"));
        case "PUT /api/view":
          library.set("view", JSON.stringify(await req.json()));
          return json({ ok: true });
        case "POST /api/show": { // a phil window, through the engine
          const song = absolute((await req.json()).path);
          const answer = controlSocket ? await ask(controlSocket, { open: { app: "phil", dir: dirname(song), select: [song] } }).catch(() => null) : null;
          if (!answer?.ok) throw httpError(503, "Couldn't open a phil window");
          return json({ ok: true });
        }
      }
      return null;
    },
  };
}

function absolute(path) {
  if (!path?.startsWith("/")) throw httpError(400, "absolute path required");
  return path;
}
