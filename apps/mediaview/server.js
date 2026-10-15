// mediaview's server: the library (media.js) of the folders marked as media
// (phil's metadata.json: a folder's Properties), IMDb's datasets (imdb.js),
// and the videos' pictures (phil's thumbnails, shared with it). Runs in the
// engine's server worker (engine/server.js).
//   GET  /api/media              the movies and shows (library()); ?cached=1: as they were last time, at once
//   GET  /api/media/status       IMDb's datasets: there, being updated
//   POST /api/media/update       download them (again) and build the database
//   GET  /api/media/events       the status as it changes (server-sent events)
//   GET  /api/media/search?q=    titles, picking one by hand
//   PUT  /api/media/fix          {key, id}: what the files named so are (an IMDb id; 0: none; null: matched again)
//   GET  /api/media/poster?path= a video's thumbnail
//   POST /api/open-url           {url}: a web page (an IMDb link), in the default browser
//   POST /api/show               {path}: a file in its folder, in a phil window (mediaview on its own)
//   POST /api/media/prepare      {path}: a folder just marked as media, made ready (prepare()): its
//                                progress as lines of JSON ({phase, done, total, title}), then {finished, total} or {error}
//   POST /api/media/forget       {path}: a media folder not there now (moved outside phil, or gone) no longer one
//
// Incognito (the engine's profile): fixes and what's remembered of unplugged
// drives aren't written, and thumbnails are made in memory.
import { basename, dirname, join } from "@std/path";
import { httpError, json, serveFile, text } from "../../engine/http.js";
import { ask } from "../../engine/instance.js";
import { serverConfig } from "../phil/launch.js";
import { Hooks, metadataFile } from "../phil/hooks.js";
import { Thumbnailer } from "../phil/thumbs.js";
import * as imdb from "./imdb.js";
import { library, loadMatches, prepare, unsavedMatches } from "./media.js";

export const UI_DIR = new URL("./ui/", import.meta.url);

export function createServer({ profile = {}, controlSocket = null }) {
  const config = serverConfig(profile);
  const thumbs = new Thumbnailer(config);
  const hooks = new Hooks(metadataFile(config.settingsFile), { persist: !config.incognito }); // (phil's: a folder's Properties)
  const stateFile = join(dirname(config.stateFile), "media.json");
  const positionsFile = join(dirname(config.stateFile), "videoplayer-positions.json");
  // Titles matched (media.js), and the library as it was last shown (opened again, it shows at once).
  const matchesFile = join(dirname(config.stateFile), "media-matches.json");
  const lastFile = join(dirname(config.stateFile), "media-library.json");
  const matchesLoaded = Deno.readTextFile(matchesFile).then((t) => loadMatches(JSON.parse(t)), () => {});
  const writeJson = async (file, data) => {
    if (config.incognito) return;
    await Deno.mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(data));
    await Deno.rename(tmp, file);
  };
  const saveMatches = async () => {
    const changed = unsavedMatches();
    if (changed) await writeJson(matchesFile, changed).catch(() => {});
  };
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
  const saveState = (state) => writeJson(stateFile, state);

  // Folders being made ready (prepare()): root -> {progress, listeners}. Asked
  // again while it is (another window), the same one is followed.
  const preparing = new Map();
  function prepareFolder(root) {
    let job = preparing.get(root);
    if (job) return job;
    job = { progress: null, listeners: new Set() };
    preparing.set(root, job);
    const send = (message, last = false) => {
      job.progress = message;
      const line = new TextEncoder().encode(JSON.stringify(message) + "\n");
      for (const c of job.listeners) {
        try {
          c.enqueue(line);
          if (last) c.close();
        } catch {
          job.listeners.delete(c);
        }
      }
    };
    (async () => {
      try {
        await matchesLoaded;
        const files = await prepare(root, { poster: (path) => thumbs.get(path), onProgress: (p) => send(p) });
        await saveMatches();
        const state = await readState();
        state.remembered[root] = files;
        await saveState(state);
        send({ finished: true, total: job.progress?.total ?? 0 }, true);
      } catch (err) {
        send({ error: err.message }, true);
      } finally {
        preparing.delete(root);
      }
    })();
    return job;
  }

  // The folders marked as media, matched by hand where it was put right, how
  // far each video was watched (videoplayer's positions), and what was in the
  // ones not there now (a drive unplugged) when they were last seen.
  async function mediaLibrary() {
    const meta = await hooks.all();
    const roots = Object.entries(meta).filter(([, m]) => m?.media === true).map(([p]) => p).sort();
    const state = await readState();
    const watched = await Deno.readTextFile(positionsFile).then(JSON.parse, () => ({}));
    await matchesLoaded;
    const lib = await library(roots, { fixes: state.fixes, watched, remembered: state.remembered });
    await saveMatches();
    const remembered = Object.fromEntries(roots.map((r) => [r, lib.scanned[r] ?? state.remembered[r]]).filter(([, files]) => files));
    if (JSON.stringify(remembered) !== JSON.stringify(state.remembered)) await saveState({ ...state, remembered });
    delete lib.scanned;
    const out = { roots: roots.map((path) => ({ path, online: lib.online[path] })), ...lib };
    writeJson(lastFile, out).catch(() => {});
    return { imdb: imdb.status(), ...out };
  }

  return {
    async handle(req, url) {
      switch (`${req.method} ${url.pathname}`) {
        case "GET /api/media": {
          const last = url.searchParams.get("cached") === "1" ? await Deno.readTextFile(lastFile).then(JSON.parse, () => null) : null;
          return json(last ? { imdb: imdb.status(), cached: true, ...last } : await mediaLibrary());
        }
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
        case "POST /api/media/prepare": {
          const job = prepareFolder(absolute((await req.json()).path));
          let me;
          const body = new ReadableStream({
            start(c) {
              me = c;
              job.listeners.add(c);
              if (job.progress) c.enqueue(new TextEncoder().encode(JSON.stringify(job.progress) + "\n"));
            },
            cancel: () => void job.listeners.delete(me),
          });
          return new Response(body, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" } });
        }
        case "POST /api/media/forget": {
          const path = absolute((await req.json()).path);
          if ((await hooks.get(path)).media !== true) throw httpError(404, "Not a media folder");
          await hooks.set(path, { media: "" });
          const state = await readState();
          delete state.remembered[path];
          await saveState(state);
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
