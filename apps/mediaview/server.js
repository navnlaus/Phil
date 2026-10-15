// mediaview's server: the library (media.js) of the folders marked as media
// (phil's metadata.json: a folder's Properties), IMDb's datasets (imdb.js),
// and the videos' pictures (phil's thumbnails, shared with it). Runs in the
// engine's server worker (engine/server.js).
//   GET  /api/media              the movies and shows (library())
//   GET  /api/media/status       IMDb's datasets: there, being updated
//   POST /api/media/update       download them (again) and build the database
//   GET  /api/media/events       the status as it changes (server-sent events)
//   GET  /api/media/search?q=    titles, picking one by hand
//   PUT  /api/media/fix          {key, id}: what the files named so are (an IMDb id; 0: none; null: matched again)
//   GET  /api/media/poster?path= a video's thumbnail
//   POST /api/open-url           {url}: a web page (an IMDb link), in the default browser
//   POST /api/show               {path}: a file in its folder, in a phil window (mediaview on its own)
//
// Incognito (the engine's profile): fixes and what's remembered of unplugged
// drives aren't written, and thumbnails are made in memory.
import { basename, dirname, join } from "@std/path";
import { httpError, json, serveFile, text } from "../../engine/http.js";
import { ask } from "../../engine/instance.js";
import { serverConfig } from "../phil/launch.js";
import { metadataFile } from "../phil/hooks.js";
import { Thumbnailer } from "../phil/thumbs.js";
import * as imdb from "./imdb.js";
import { library } from "./media.js";

export const UI_DIR = new URL("./ui/", import.meta.url);

export function createServer({ profile = {}, controlSocket = null }) {
  const config = serverConfig(profile);
  const thumbs = new Thumbnailer(config);
  const stateFile = join(dirname(config.stateFile), "media.json");
  const positionsFile = join(dirname(config.stateFile), "videoplayer-positions.json");
  const listeners = new Set(); // /api/media/events
  const tell = () => {
    const line = new TextEncoder().encode(`data: ${JSON.stringify(imdb.status())}\n\n`);
    for (const c of listeners) {
      try {
        c.enqueue(line);
      } catch {
        listeners.delete(c);
      }
    }
  };

  const readState = async () => {
    const state = await Deno.readTextFile(stateFile).then(JSON.parse, () => ({}));
    return { fixes: state.fixes ?? {}, remembered: state.remembered ?? {} };
  };
  const saveState = async (state) => {
    if (config.incognito) return;
    await Deno.mkdir(dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(state));
    await Deno.rename(tmp, stateFile);
  };

  // The folders marked as media, matched by hand where it was put right, how
  // far each video was watched (videoplayer's positions), and what was in the
  // ones not there now (a drive unplugged) when they were last seen.
  async function mediaLibrary() {
    const meta = await Deno.readTextFile(metadataFile(config.settingsFile)).then(JSON.parse, () => ({}));
    const roots = Object.entries(meta).filter(([, m]) => m?.media === true).map(([p]) => p).sort();
    const state = await readState();
    const watched = await Deno.readTextFile(positionsFile).then(JSON.parse, () => ({}));
    const lib = await library(roots, { fixes: state.fixes, watched, remembered: state.remembered });
    const remembered = Object.fromEntries(roots.map((r) => [r, lib.scanned[r] ?? state.remembered[r]]).filter(([, files]) => files));
    if (JSON.stringify(remembered) !== JSON.stringify(state.remembered)) await saveState({ ...state, remembered });
    delete lib.scanned;
    return { imdb: imdb.status(), roots: roots.map((path) => ({ path, online: lib.online[path] })), ...lib };
  }

  return {
    async handle(req, url) {
      switch (`${req.method} ${url.pathname}`) {
        case "GET /api/media":
          return json(await mediaLibrary());
        case "GET /api/media/status":
          return json(imdb.status());
        case "POST /api/media/update":
          imdb.update(tell);
          return json(imdb.status());
        case "GET /api/media/events": {
          let me;
          const body = new ReadableStream({
            start: (c) => void listeners.add(me = c),
            cancel: () => void listeners.delete(me),
          });
          return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
        }
        case "GET /api/media/search":
          return json(imdb.search(url.searchParams.get("q") ?? "").map((t) => ({ ...t, imdb: imdb.tconst(t.id) })));
        case "PUT /api/media/fix": {
          const { key, id } = await req.json();
          if (typeof key !== "string" || !/^(movie|show)\|/.test(key)) throw httpError(400, "A key, from the library");
          const state = await readState();
          if (id === null) delete state.fixes[key];
          else if (id === 0 || (Number.isInteger(id) && imdb.title(id))) state.fixes[key] = id;
          else throw httpError(404, "No such title");
          await saveState(state);
          return json({ ok: true });
        }
        case "GET /api/media/poster": {
          const file = absolute(url.searchParams.get("path"));
          const thumb = await thumbs.get(file).catch(() => null);
          const path = thumb?.startsWith("/thumbs/") ? thumbs.fileFor(basename(thumb)) : thumb?.startsWith("/file?") ? new URLSearchParams(thumb.slice(6)).get("path") : null;
          return path ? serveFile(req, path, { "cache-control": "max-age=3600" }) : text(404, "No picture");
        }
        case "POST /api/open-url": {
          const { url: page } = await req.json();
          if (!/^https:\/\/\S+$/.test(String(page))) throw httpError(400, "A web address (https://…)");
          const child = new Deno.Command("xdg-open", { args: [page], stdin: "null", stdout: "null", stderr: "null" }).spawn();
          child.unref();
          child.status.catch(() => {});
          return json({ ok: true });
        }
        case "POST /api/show": { // on its own (not inside phil): a phil window, through the engine
          const path = absolute((await req.json()).path);
          const answer = controlSocket ? await ask(controlSocket, { open: { app: "phil", dir: dirname(path), select: [path] } }).catch(() => null) : null;
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
