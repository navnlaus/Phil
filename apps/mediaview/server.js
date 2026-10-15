// mediaview's server: the library (media.js) of the folders marked as media
// (phil's metadata.json: a folder's Properties), IMDb's datasets (imdb.js),
// and the videos' pictures (phil's thumbnails, shared with it). Runs in the
// engine's server worker (engine/server.js).
//   GET  /api/media              the movies and shows (library()); ?cached=1: as they were last time, at once
//   GET  /api/media/status       IMDb's datasets: there, being updated
//   POST /api/media/update       download them (again) and build the database
//   GET  /api/media/events       IMDb's status as it changes, and (event "downloads") how far
//                                each video being downloaded into a media folder is (server-sent events)
//   GET  /api/media/search?q=    titles, picking one by hand
//   GET  /api/media/season?id=&season=  a show's season none of which is here: its episodes
//   PUT  /api/media/fix          {key, id}: what the files named so are (an IMDb id; 0: none; null: matched again)
//   GET  /api/media/poster?path= a video's thumbnail
//   POST /api/open-url           {url}: a web page (an IMDb link, a missing episode's search), in the default browser
//   POST /api/show               {path}: a file in its folder, in a phil window (mediaview on its own)
//   POST /api/show-transfer      {transfer}: a download in phil's Transfers view, in a phil window (likewise)
//   POST /api/media/prepare      {path}: a folder just marked as media, made ready (prepare()): its
//                                progress as lines of JSON ({phase, done, total, title}), then {finished, total} or {error}
//   POST /api/media/forget       {path}: a media folder not there now (moved outside phil, or gone) no longer one
//
// mediaview's own data is in an SQLite database (store.js). Incognito (the
// engine's profile): it's read but not written, and thumbnails are made in memory.
import { basename, dirname, join } from "@std/path";
import { httpError, json, serveFile, text } from "../../engine/http.js";
import { ask } from "../../engine/instance.js";
import { serverConfig } from "../phil/launch.js";
import { Hooks, metadataFile } from "../phil/hooks.js";
import { Thumbnailer } from "../phil/thumbs.js";
import { feed } from "../phil/downloadfeed.js";
import { mediaKind } from "../../engine/media.js";
import * as imdb from "./imdb.js";
import { library, loadMatches, prepare, seasonEpisodes, unsavedMatches } from "./media.js";
import { Store } from "./store.js";

export const UI_DIR = new URL("./ui/", import.meta.url);

export function createServer({ profile = {}, controlSocket = null }) {
  const config = serverConfig(profile);
  const thumbs = new Thumbnailer(config);
  const hooks = new Hooks(metadataFile(config.settingsFile), { persist: !config.incognito }); // (phil's: a folder's Properties)
  const positionsFile = join(dirname(config.stateFile), "videoplayer-positions.json");
  // Fixes, the media folders' files when last seen, titles matched, the library as last shown (store.js).
  const store = new Store(join(dirname(config.stateFile), "media.sqlite"), { write: !config.incognito });
  loadMatches(store.matches());
  const saveMatches = () => {
    const changed = unsavedMatches();
    if (changed) store.saveMatches(changed);
  };
  const listeners = new Set(); // /api/media/events
  let stopFeed = null; // phil's downloads followed while a page listens
  const tell = (event = null, data = imdb.status()) => {
    const line = new TextEncoder().encode(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
    for (const c of listeners) {
      try {
        c.enqueue(line);
      } catch {
        listeners.delete(c);
      }
    }
  };

  // Videos being downloaded into the media folders (phil's downloads: panda-dl's,
  // a browser's): [{path, root, progress (0 to 1), total, speed, eta, state, name}].
  // A torrent's own files as soon as it lists them; before, the download itself (its name).
  const mediaRoots = async () => Object.entries(await hooks.all()).filter(([, m]) => m?.media === true).map(([p]) => p).sort();
  function mediaDownloads(roots) {
    const inRoot = (path) => roots.find((r) => path.startsWith(r + "/"));
    const out = [];
    const add = (e) => {
      const root = inRoot(e.path);
      if (root) out.push({ ...e, root });
    };
    for (const d of feed.panda) {
      if (d.state === "completed") continue;
      const common = { speed: d.speed ?? null, eta: d.eta ?? null, state: d.state, name: d.name, transfer: `download ${d.id}` };
      const videos = (d.files ?? []).filter((f) => mediaKind(f.path) === "video");
      if (videos.length) {
        for (const f of videos) add({ path: f.path, progress: f.length ? f.downloaded / f.length : (d.percent ?? 0) / 100, total: f.length ?? null, ...common });
      } else if (!d.files?.length || d.state === "metadata") add({ path: d.path ?? join(d.dir, d.name), progress: (d.percent ?? 0) / 100, total: d.total ?? null, ...common });
    }
    for (const w of feed.browser) {
      if (mediaKind(w.target) !== "video") continue;
      add({ path: w.target, progress: (w.percent ?? 0) / 100, total: w.total ?? null, speed: w.speed ?? null, eta: w.eta ?? null, state: w.state, name: w.name, transfer: `web ${w.id}` });
    }
    return out;
  }
  // The page's bars, as the downloads go (phil's lists change: every second or so while they do).
  const tellDownloads = async () => {
    if (!listeners.size) return;
    const items = mediaDownloads(await mediaRoots()).map(({ path, progress, speed, eta, state, transfer }) => ({ path, progress, speed, eta, state, transfer }));
    tell("downloads", { items });
  };
  feed.addEventListener("change", () => tellDownloads().catch(() => {}));

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
        const files = await prepare(root, { poster: (path) => thumbs.get(path), onProgress: (p) => send(p) });
        saveMatches();
        store.remember(root, files);
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
    const roots = await mediaRoots();
    const watched = await Deno.readTextFile(positionsFile).then(JSON.parse, () => ({}));
    const downloads = mediaDownloads(roots);
    const remembered = store.remembered();
    const lib = await library(roots, { fixes: store.fixes(), watched, remembered, downloads });
    saveMatches();
    for (const [root, files] of Object.entries(lib.scanned)) store.remember(root, files);
    for (const root of Object.keys(remembered)) if (!roots.includes(root)) store.forget(root); // (no longer a media folder, or inside one)
    delete lib.scanned;
    const out = { roots: roots.map((path) => ({ path, online: lib.online[path] })), ...lib, downloads: downloads.map((d) => d.path) };
    store.setLast(out);
    return { imdb: imdb.status(), ...out };
  }

  return {
    async handle(req, url) {
      switch (`${req.method} ${url.pathname}`) {
        case "GET /api/media": { // (and where a missing episode's link searches: phil's Preferences, mediaSearchUrl)
          const last = url.searchParams.get("cached") === "1" ? store.last() : null;
          const settings = await Deno.readTextFile(config.settingsFile).then(JSON.parse, () => ({}));
          const searchUrl = /^https?:\/\/\S+$/.test(settings.mediaSearchUrl ?? "") ? settings.mediaSearchUrl : null;
          return json({ ...(last ? { imdb: imdb.status(), cached: true, ...last } : await mediaLibrary()), searchUrl });
        }
        case "GET /api/media/status":
          return json(imdb.status());
        case "POST /api/media/update":
          imdb.update(tell);
          return json(imdb.status());
        case "GET /api/media/events": {
          let me;
          const body = new ReadableStream({
            start: (c) => {
              listeners.add(me = c);
              stopFeed ??= feed.use();
              tellDownloads().catch(() => {});
            },
            cancel: () => {
              listeners.delete(me);
              if (!listeners.size) stopFeed?.(), (stopFeed = null);
            },
          });
          return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
        }
        case "GET /api/media/season": {
          const id = Number(url.searchParams.get("id")), season = Number(url.searchParams.get("season"));
          if (!Number.isInteger(id) || !Number.isInteger(season)) throw httpError(400, "id and season, numbers");
          return json(seasonEpisodes(id, season));
        }
        case "GET /api/media/search":
          return json(imdb.search(url.searchParams.get("q") ?? "").map((t) => ({ ...t, imdb: imdb.tconst(t.id) })));
        case "PUT /api/media/fix": {
          const { key, id } = await req.json();
          if (typeof key !== "string" || !/^(movie|show)\|/.test(key)) throw httpError(400, "A key, from the library");
          if (id !== null && id !== 0 && !(Number.isInteger(id) && imdb.title(id))) throw httpError(404, "No such title");
          store.setFix(key, id);
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
          if (!/^https?:\/\/\S+$/.test(String(page))) throw httpError(400, "A web address (https://…)");
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
          store.forget(path);
          return json({ ok: true });
        }
        case "POST /api/show-transfer": { // on its own: a phil window, its Transfers view on that download
          const { transfer } = await req.json();
          if (!/^(download|web) \S+$/.test(String(transfer))) throw httpError(400, "A download, as phil names it");
          const answer = controlSocket ? await ask(controlSocket, { open: { app: "phil", transfer } }).catch(() => null) : null;
          if (!answer?.ok) throw httpError(503, "Couldn't open a phil window");
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
