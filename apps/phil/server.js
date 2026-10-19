// phil's server: folder listings, files with Range, thumbnails, the terminal
// panel's shells. Runs in the engine's server worker (engine/server.js).
import { basename, dirname, join, normalize } from "@std/path";
import { httpError, json, serveFile, text } from "../../engine/http.js";
import { imagePreview } from "../../engine/media.js";
import { currentTheme, themeNames, themesDir } from "../../engine/themes.js";
import { FolderSummaries, makeSummary } from "./folders.js";
import { createTerms } from "./terms.js";
import { Hooks, metadataFile, runHook } from "./hooks.js";
import * as cameras from "../camview/cameras.js";
import { requireSudo, sudo, sudoPassword, sudoWanted } from "./sudo.js";
import { Tagging, tagKind } from "./tagging.js";
import { home, serverConfig } from "./launch.js";
import { canWrite, driveInfo, driveSpeed, folderSize, me, properties } from "./properties.js";
import { isTextFile, runCommand, textHead, textPreview } from "./texthead.js";
import { FolderTotals } from "./foldertotals.js";
import { DriveOptions } from "./driveoptions.js";
import { onWrote } from "../../engine/written.js";
import { engineCommand } from "../../engine/instance.js";
import { buildInfo } from "../../engine/version.js";
import { mediaKind, Thumbnailer } from "./thumbs.js";
import { unfinished, watchDownloads } from "./downloads.js";
import { watchBrowserDownloads } from "./browserdownloads.js";
import { feed, setDownloads } from "./downloadfeed.js";

export const UI_DIR = new URL("./ui/", import.meta.url);
const DEFAULT_THEME = "overlay"; // see ~/.config/phil/themes (engine/themes.js)

export function createServer({ profile, controlSocket }) {
  const config = serverConfig(profile);
  // Thumbnails at once per drive go by its speed test (thumbs.js): the drive a
  // file is on, by its mount point, and that drive's last test.
  const thumbs = new Thumbnailer({
    ...config,
    async driveSpeed(path) {
      const out = await new Deno.Command("findmnt", { args: ["-n", "-o", "TARGET", "-T", path], stdout: "piped", stderr: "null" }).output();
      const mount = new TextDecoder().decode(out.stdout).trim().split("\n").at(-1);
      const info = mount ? await driveInfo(mount, join(dirname(config.stateFile), "drive-speeds.json")) : null;
      const read = info?.speed?.read ?? info?.speed?.buffered;
      return read ? { read, rotational: !!info.disk?.rotational } : null;
    },
  });
  setTimeout(() => thumbs.pruneContent().catch(() => {}), 60_000); // content entries left by deleted files
  // Incognito leaves no traces, so its folder summaries last for the session only.
  const sockets = new Set(); // every page's WebSocket, for {theme}
  let terms = null; // the terminal panels' shells (below)
  const terminals = new Map(); // terminal panel id (PHIL_TERMINAL) -> its WebSocket
  const folders = new FolderSummaries(config.incognito ? null : join(thumbs.dir, "folders"));
  // What phil does on each drive (its Properties): thumbnails, folder sizes.
  const driveOptions = new DriveOptions(join(dirname(config.settingsFile), "drives.json"), { readOnly: config.incognito });
  // Whether previews are made where `path` is (pictures', videos', documents'; folders' faces of them).
  const previewsOn = async (path) => (await driveOptions.get(path)).thumbnails !== false;
  // Incognito: the totals known, read; F5's, and phil's own changes', in memory for the session.
  const totals = new FolderTotals(join(config.incognito ? join(config.cacheThumbDir, thumbs.name) : thumbs.dir, "folder-totals.sqlite"), {
    readOnly: config.incognito,
    changed: (path, bytes) => broadcast({ totalOf: path, bytes }), // phil's own changes: the totals of the folders they're in, and above
    counts: async (path) => !config.incognito && await countsTotals(path), // (a folder copied: walked)
    processesChanged: () => broadcast({ processes: processes() }), // the sidebar's Processes
  });
  // The terminal panels' shells (terms.js): those in the background (Super+°) are Processes too.
  terms = createTerms({ controlSocket, incognito: config.incognito, onChange: () => broadcast({ processes: processes() }) });
  // The sidebar's Processes: folders' totals being worked out, terminals in the background.
  function processes() {
    return [...totals.processes(), ...(terms?.list() ?? []).map((t) => ({ ...t, id: `term:${t.id}`, term: t.id, kind: "terminal" }))];
  }
  onWrote((path) => totals.touched(dirname(path))); // an editor's save, imageresize's
  // A download whose state changed (done, paused, stopped) or that's gone from
  // the list: the folder it's in, read again (a folder it makes: all of it).
  const downloadStates = { panda: new Map(), browser: new Map() }; // id -> {state, path, dir}
  const downloadsChanged = (source, list) => {
    const was = downloadStates[source], now = new Map(list.map((d) => [d.id, { state: d.state, path: d.target ?? d.path, dir: d.dir }]));
    for (const [id, d] of was) {
      if (now.get(id)?.state === d.state) continue;
      const path = d.path ?? d.dir;
      if (!path) continue;
      isDir(path).then((folder) => totals.touched(folder ? path : dirname(path), { walk: folder }));
    }
    downloadStates[source] = now;
  };
  const speedsFile = join(dirname(config.stateFile), "drive-speeds.json"); // the drives' read speed tests
  // Copies and moves under way, in the metadata of the folder or file being
  // made ({copying: {op, from, percent, bytes, total, started, updated,
  // state}}), so a copy cut off (a crash, a cancel) is known as stopped and
  // can be resumed. Written every few seconds, gone when it's done.
  const copyRecords = {
    set: (target, record) => hooks.set(target, { copying: record ?? "" }).catch(() => {}),
    get: async (target) => (await hooks.get(target).catch(() => ({}))).copying ?? null,
    // A copy done: the records left in it (files cut off before, finished now) go too.
    clearUnder: async (target) => {
      const all = await hooks.all().catch(() => ({}));
      for (const path of Object.keys(all)) if (path.startsWith(target + "/") && all[path].copying) await hooks.set(path, { copying: "" }).catch(() => {});
    },
  };

  // Copies cut off, wherever they are (the Transfers list shows them, with ↻ and ×): the
  // records of what they were making, those no copy under way has (not a file's own record
  // inside one: its folder's goes on with it). One whose target is gone is forgotten.
  const stoppedTransfers = async () => {
    const all = await hooks.all().catch(() => ({}));
    const stopped = [];
    for (const [path, meta] of Object.entries(all)) {
      const c = meta.copying;
      if (!c || c.file || liveTargets.has(path)) continue;
      const st = await Deno.lstat(path).catch(() => null);
      if (!st) {
        await hooks.set(path, { copying: "" }).catch(() => {});
        continue;
      }
      // A file: how far it got is its size (the record is written every few seconds, so it can be behind).
      const got = st.isFile && c.total ? { bytes: Math.min(st.size, c.total), percent: Math.floor((Math.min(st.size, c.total) / c.total) * 100) } : {};
      stopped.push({ path, copying: { ...c, ...got, state: "stopped" } });
    }
    return stopped.sort((a, b) => (b.copying.updated ?? 0) - (a.copying.updated ?? 0));
  };

  // What phil kept of things deleted goes too: their thumbnails, documents read
  // as Markdown (both by path, size and time), and folders' summaries and
  // tagging. (Their metadata goes with movedHooks, their totals with totals.deleting.)
  // The cache folders are listed once, and only what's in them is removed (a
  // big folder is many thousand files, most never seen).
  const forgetDeleted = async (entries) => {
    const dirs = entries.filter((e) => e.type === "d").map((e) => e.path);
    for (const dir of dirs) await folders.forget(dir), await tagging.forget(dir);
    const names = async (dir) => {
      const set = new Set();
      try {
        for await (const e of Deno.readDir(dir)) set.add(e.name);
      } catch { /* none yet */ }
      return set;
    };
    const [inThumbs, inDocuments] = await Promise.all([names(thumbs.dir), names(documentCache)]);
    if (!inThumbs.size && !inDocuments.size) return;
    for (const e of entries) {
      if (e.type !== "f") continue;
      const key = await thumbs.key(e.path, { size: e.size, mtime: new Date(e.ms) });
      for (const [set, dir, name] of [[inThumbs, thumbs.dir, `${key}.jpg`], [inThumbs, thumbs.dir, `${key}.fail`], [inDocuments, documentCache, `${key}.md`]]) {
        if (set.has(name)) await Deno.remove(join(dir, name)).catch(() => {});
      }
    }
  };

  // The sidebar's folders, as the user has arranged them (sidebar.json, next to
  // the settings: {"folders": [paths]}); null until they've changed them: the
  // default ones. Incognito: kept for the session.
  const sidebarFile = join(dirname(config.settingsFile), "sidebar.json");
  let sidebarMemory;
  const sidebarFolders = async () => {
    if (sidebarMemory !== undefined) return sidebarMemory;
    try {
      const { folders } = JSON.parse(await Deno.readTextFile(sidebarFile));
      return Array.isArray(folders) ? folders.filter((p) => typeof p === "string" && (p.startsWith("/") || p === MEDIA_PLACE)) : null;
    } catch {
      return null;
    }
  };
  // {add: [paths], before: path | null} puts folders (links to them) in the
  // sidebar, before that one of its folders (null: after the last); ones in it
  // already move there. {remove: path} takes one out. Every window's sidebar
  // is refreshed.
  const arrangeSidebar = async ({ add = [], before = null, remove = null }) => {
    let folders = (await sidebarFolders()) ?? await defaultFolders();
    if (!folders.includes(MEDIA_PLACE)) folders.push(MEDIA_PLACE); // (where it is by default: after the folders)
    const adding = [];
    for (const path of add) {
      if (typeof path !== "string" || !path.startsWith("/")) throw httpError(400, "paths, please");
      const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
      if (await isDir(p) && !adding.includes(p)) adding.push(p); // files dropped with them: not
    }
    if (add.length && !adding.length) throw httpError(400, "Only folders go in the sidebar");
    folders = folders.filter((p) => p !== remove && !adding.includes(p));
    const at = before === null ? -1 : folders.indexOf(before);
    folders.splice(at === -1 ? folders.length : at, 0, ...adding);
    if (config.incognito) sidebarMemory = folders;
    else {
      await Deno.mkdir(dirname(sidebarFile), { recursive: true });
      const tmp = `${sidebarFile}.${crypto.randomUUID().slice(0, 8)}.tmp`;
      await Deno.writeTextFile(tmp, JSON.stringify({ folders }, null, 2) + "\n");
      await Deno.rename(tmp, sidebarFile);
    }
    broadcast({ places: true });
    return { folders };
  };

  // The sidebar's places, with the description each has in its Properties (shown in place of its name),
  // and the icon picked there (`customIcon`, one of vendor/lucide-sprite.svg's).
  const describedPlaces = async () =>
    Promise.all((await places(await sidebarFolders())).map(async (p) => {
      const meta = p.path ? await hooks.get(p.path).catch(() => null) : null;
      return { ...p, ...(meta?.description ? { description: meta.description } : {}), ...(meta?.icon ? { customIcon: meta.icon } : {}), ...(meta?.media ? { mediaFolder: true } : {}) };
    }));
  // Files copied or cut (Ctrl+C / Ctrl+X), for every window: pasting goes by the
  // desktop's clipboard, which has their paths as text (`text`) while they're it.
  let fileClipboard = null;
  // A drag a phil window started: another window's drop gets its files from here when the
  // drop itself doesn't carry them.
  let philDrag = null;
  const shown = new Map(); // page WebSocket -> the folder it shows
  const broadcast = (msg) => {
    for (const socket of shown.keys()) if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  };
  // Downloads under way (panda-dl's; downloads.js), for every window as
  // {downloads}; what they're writing isn't thumbnailed till they're done.
  // Others' downloads saved through phil's file chooser (a browser's partial file growing), for the Transfers list too.
  // Their temporary file, when its name doesn't say what it is (a browser's "Unconfirmed
  // 123456.crdownload"), gets the download's name as its description (not over one given
  // by hand), taken off again when it's done.
  const describedPartials = new Map(); // partial file -> the description given it
  let pandaWriting = [], browserWriting = []; // files downloads are writing (for thumbs.downloading)
  let barDownloadsChanged = () => {}; // (set with the bar's file, below)
  const browserDownloads = watchBrowserDownloads(async (list) => {
    setDownloads("browser", list); // (for mediaview's server: downloadfeed.js)
    downloadsChanged("browser", list);
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ browserDownloads: list }));
    browserWriting = list.map((d) => d.path);
    thumbs.downloading([...pandaWriting, ...browserWriting]); // (no thumbnails of them till they're done)
    const now = new Map(list.filter((d) => !basename(d.path).startsWith(d.name)).map((d) => [d.path, d.name]));
    for (const [path, name] of now) {
      if (describedPartials.get(path) === name) continue;
      const meta = await hooks.get(path).catch(() => ({}));
      if (meta?.description && meta.description !== describedPartials.get(path)) continue; // the user's own
      await hooks.set(path, { description: name }).catch(() => {});
      describedPartials.set(path, name);
    }
    for (const [path, name] of describedPartials) {
      if (now.has(path)) continue;
      describedPartials.delete(path);
      const meta = await hooks.get(path).catch(() => ({}));
      if (meta?.description === name) await hooks.set(path, { description: "" }).catch(() => {});
    }
  }, { incognito: config.incognito });
  const downloads = watchDownloads((list) => {
    setDownloads("panda", list); // (for mediaview's server: downloadfeed.js)
    downloadsChanged("panda", list);
    pandaWriting = list.flatMap(unfinished);
    barDownloadsChanged();
    thumbs.downloading([...pandaWriting, ...browserWriting]);
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ downloads: list }));
  });
  // Others in this worker (mediaview) ask for downloads to be followed while they show them.
  feed.use = () => {
    const stops = [downloads.use(), browserDownloads.use()];
    return () => stops.forEach((stop) => stop());
  };
  // Copies, moves and deletes under way (and panda-dl's downloads), for the bar (the phil widget for
  // Omarchy's bar, extras/omarchy-bar): $XDG_RUNTIME_DIR/phil/progress.json,
  // {pid, updated, jobs: [{id, op (copy, move, delete, download), name, items,
  // dest, percent, bytes, total, speed (bytes/s), eta (s), paused, counting,
  // found, started}]}, written at most once a
  // second as they go, and every 5 seconds while there are any (a paused one
  // reports nothing): `updated` going stale means this phil is gone. The bar
  // shows the ones that have taken more than 10 seconds. Not incognito ones.
  const barFile = config.incognito ? null : join(Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp", "phil", "progress.json");
  const barJobs = new Map(); // id -> its last progress, and when it was first heard of
  let barTimer = 0, barWritten = 0, barBeat = 0;
  const writeBar = async () => {
    barTimer = 0;
    barWritten = Date.now();
    const jobs = [...barJobs.values()].map((p) => ({
      id: p.id, op: p.op, name: basename(p.targets?.[0] ?? p.dest ?? ""), items: p.items ?? 1, dest: p.dest,
      percent: p.percent ?? 0, bytes: p.bytes ?? 0, total: p.total ?? 0, speed: p.speed ?? null, eta: p.eta ?? null,
      paused: !!p.paused, counting: !!p.counting, found: p.found ?? 0, started: p.started,
    }));
    // panda-dl's downloads under way (torrents, web downloads), as "download" jobs.
    for (const d of downloads.list) {
      if (d.state !== "downloading") continue;
      jobs.push({
        id: `download-${d.id}`, op: "download", name: d.name, items: 1, dest: d.dir, percent: Math.floor(d.percent ?? 0), bytes: d.bytes ?? 0,
        total: d.total ?? 0, speed: d.speed ?? null, eta: d.eta ?? null, paused: false, counting: false, found: 0, started: (d.created ?? 0) * 1000,
      });
    }
    try {
      await Deno.mkdir(dirname(barFile), { recursive: true });
      const tmp = `${barFile}.${crypto.randomUUID().slice(0, 8)}.tmp`;
      await Deno.writeTextFile(tmp, JSON.stringify({ pid: Deno.pid, updated: Date.now(), jobs }) + "\n");
      await Deno.rename(tmp, barFile);
    } catch { /* no runtime folder: no bar */ }
    clearInterval(barBeat);
    barBeat = jobs.length ? setInterval(writeBar, 5000) : 0;
  };
  const barProgress = (p) => {
    if (!barFile) return;
    if (p.finished) barJobs.delete(p.id);
    else barJobs.set(p.id, { ...p, started: barJobs.get(p.id)?.started ?? Date.now() });
    if (!barTimer) barTimer = setTimeout(writeBar, p.finished ? 0 : Math.max(0, 1000 - (Date.now() - barWritten)));
  };
  if (barFile) {
    writeBar(); // none: a phil that was stopped mid-copy left its own
    downloads.use(); // asked about with no window open too (for the bar), every few seconds at most
  }
  // (downloads.js's list changed: the bar's file soon.)
  barDownloadsChanged = () => barFile && !barTimer && (barTimer = setTimeout(writeBar, Math.max(0, 1000 - (Date.now() - barWritten))));

  // The network cameras, at the bottom of the sidebar (camview shows them): looked
  // for only when asked (the sidebar's ↻, or its menu's "Look for cameras"), as
  // looking is seconds of probing the network; every window hears of changes.
  if (config.incognito) cameras.keepInMemory();
  cameras.onChange(async () => broadcast({ cameras: await cameras.list() }));
  const cameraError = (err) => httpError(err.status ?? 502, err.message);

  // A hook ran: the windows showing its folder say so.
  const hooks = new Hooks(metadataFile(config.settingsFile), {
    persist: !config.incognito,
    onRun(run) {
      for (const [socket, dir] of shown) if (dir === dirname(run.path) && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ hook: run }));
    },
  });
  console.log(`phil: thumbnails in ${config.thumbDir}`);
  // Auto-tagging (tagging.js): embeddings cached next to the thumbnails.
  const tagging = new Tagging({
    cacheDir: config.incognito ? null : join(thumbs.dir, "tags"),
    configDir: dirname(config.settingsFile), // the tag lists
    persist: !config.incognito,
  });
  // What's tagged: pictures, documents, each if it's set up and not turned off in Preferences.
  const tagKinds = async () => {
    const [available, settings] = await Promise.all([tagging.available(), readSettings()]);
    return { pictures: available.pictures && settings.tagPictures !== false, documents: available.documents && settings.tagDocuments !== false };
  };
  // Tags given by hand join the list of each kind among `paths` (pictures': folders' and other files' too).
  const addTagsToLists = async (paths, tags) => {
    const kinds = new Set(paths.map((p) => tagKind(p) ?? "pictures"));
    for (const kind of kinds) await tagging.addToVocabulary(tags, kind);
  };
  // A picture's thumbnail file, made if need be: what tagging looks at.
  const thumbnailFile = async (path, signal) => {
    const url = await thumbs.get(path, signal);
    if (url.startsWith("/thumbs/")) return thumbs.fileFor(basename(url));
    if (url.startsWith("/file?")) return new URLSearchParams(url.slice(6)).get("path"); // a picture in a .thumbnails folder
    return null;
  };

  async function handle(req, url) {
    const path = url.searchParams.get("path");
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /api/places": // again, when the window gets focus: drives come and go
        return json({ places: await describedPlaces(), mounts: await networkMounts() });
      case "POST /api/sidebar": // {add, before} or {remove}: the sidebar's folders arranged (see arrangeSidebar)
        return json(await arrangeSidebar(await req.json()));
      case "GET /api/cameras": // the cameras found so far; ?look=now: looked for first (the sidebar's refresh button: only then), answered when that's done
        if (url.searchParams.get("look") === "now") return json(await cameras.discover({ force: true }));
        return json(await cameras.list());
      case "POST /api/cameras": // {address, user, password}: a camera added by its address
        try {
          const { address, user, password } = await req.json();
          return json(await cameras.add(address, user ? { user, password: password ?? "" } : {}));
        } catch (err) {
          throw cameraError(err);
        }
      case "PUT /api/camera": // {id, name} / {id, user, password} / {id, hidden}: renamed, logged into, forgotten
        try {
          const { id, ...changes } = await req.json();
          return json(await cameras.update(String(id ?? ""), changes));
        } catch (err) {
          throw cameraError(err);
        }
      case "GET /api/space": // ?path=...&path=...: the sidebar's drives, size and free space
        return json(await freeSpace(url.searchParams.getAll("path")));
      case "GET /api/init":
        return json({
          start: (await lastDir()) ?? config.startDir, // windows asked for a folder get it in the URL
          home: home(),
          places: await describedPlaces(),
          mounts: await networkMounts(),
          hostname: await hostname(),
          incognito: config.incognito,
          thumbDir: config.thumbsInMemory ? "in memory" : config.thumbDir,
          thumbSize: thumbs.name,
          tagging: { available: await tagging.available() }, // auto-tagging is set up (scripts/install-tagging.sh): {pictures, documents}
          settings: { ...await readSettings(), theme: await currentTheme() }, // a theme that's gone: the default
        });
      case "GET /api/list": {
        const listing = await listDir(requirePath(path), url.searchParams.get("sort") ?? "name");
        if (url.searchParams.get("remember") !== "0") rememberDir(listing.path); // (not a file chooser's)
        return json(listing);
      }
      case "GET /file":
      case "HEAD /file":
        return serveFile(req, requirePath(path), { "content-security-policy": "sandbox" });
      case "GET /api/is-text": // opening a file: run it in the terminal? in the text editor?
        return json({ run: await runCommand(requirePath(path)), text: await isTextFile(path) });
      case "GET /preview":
        return imagePreview(requirePath(path), url.searchParams.get("size") ?? "2560");
      case "POST /api/open":
        return openExternal(await req.json(), config.incognito);
      case "POST /api/delete": {
        const paths = (await req.json()).paths ?? [];
        await downloads.deleting(paths); // a download writing them stops (with nothing left of it: it's removed)
        const deleted = await totals.deleting(paths);
        const forget = async (gone) => (await deleted(gone), await forgetDeleted(gone));
        const result = await deletePaths(paths, { report: (progress) => (broadcast({ transfer: progress }), barProgress(progress)), forget });
        await movedHooks(paths, result, () => null);
        return json(result);
      }
      case "POST /api/transfer": { // {op, paths, dest}; progress to every page as {transfer} (see transfer())
        const body = await req.json();
        const transferred = await totals.transferring(body.op, Array.isArray(body.paths) ? body.paths : [], requirePath(body.dest));
        const result = await transfer(body, { report: (progress) => (broadcast({ transfer: progress }), barProgress(progress)), track: copyRecords });
        broadcast({ stoppedTransfers: true }); // cut off (×), or done (a stopped one gone on with)
        transferred(result).catch((err) => console.error(`phil: folders' totals after a ${body.op}: ${err.message}`)); // (a folder copied: walked, in the background)
        if (body.op === "move") await movedHooks(body.paths ?? [], result, (p) => join(body.dest, basename(p)));
        for (const { from, to } of result.moved ?? []) thumbs.carry(from, to).catch(() => {}); // their thumbnails go along
        delete result.moved;
        return json(result);
      }
      case "POST /api/process-cancel": { // {id}: stops one of the sidebar's Processes (a folder's total being worked out; a terminal in the background: ended)
        const id = String((await req.json()).id ?? "");
        if (id.startsWith("term:")) return json({ cancelled: (await terms.kill(id.slice(5)), true) });
        return json({ cancelled: totals.cancel(id) });
      }
      case "POST /api/transfer-cancel": // {id}: stops a copy or move (what's done stays done; it can be resumed)
        return json({ cancelled: cancelTransfer((await req.json()).id) });
      case "PUT /api/drag": // {paths, button}: a phil window started dragging these (for another window's drop)
        philDrag = { ...await req.json(), at: Date.now() };
        return json({ ok: true });
      case "GET /api/drag": // the drag a phil window started, if it's recent
        return json(philDrag && Date.now() - philDrag.at < 2 * 60_000 ? philDrag : null);
      case "DELETE /api/drag":
        philDrag = null;
        return json({ ok: true });
      case "GET /api/clipboard": // files copied or cut in phil (any window): {op, paths, text} or null
        return json(fileClipboard);
      case "PUT /api/clipboard": { // {op: "copy" | "cut", paths, text}: the desktop's clipboard has `text` (their paths)
        const { op, paths = [], text = "" } = await req.json();
        fileClipboard = (op === "copy" || op === "cut") && paths.length ? { op, paths: paths.map(requirePath), text } : null;
        broadcast({ clipboard: fileClipboard });
        return json({ ok: true });
      }
      case "DELETE /api/clipboard": // pasted (a cut), or emptied
        fileClipboard = null;
        broadcast({ clipboard: null });
        return json({ ok: true });
      case "GET /api/transfers": // copies and moves under way: their last progress (a window just opened shows them)
        return json([...transfers.values()].map((job) => job.last).filter(Boolean));
      case "GET /api/stopped-transfers": // copies and moves cut off (phil crashed or closed, ×), wherever they are: [{path, copying}]
        return json(await stoppedTransfers());
      case "POST /api/transfer-pause": { // {id, pause}: pauses or goes on with a copy or move
        const { id, pause } = await req.json();
        return json({ paused: pauseTransfer(id, !!pause) });
      }
      case "POST /api/download": // {action: pause|resume|remove, id, deleteFile} / {action: skip|pause_files|resume_files, id, paths} / {action: add, uri, dir}: a download (panda-dl's)
        try {
          const { action, id, deleteFile, uri, dir, paths } = await req.json();
          if (action === "add") {
            const folder = requirePath(dir);
            if (!(await isDir(folder))) throw new Error(`${folder} isn't a folder`);
            return json(await downloads.add(uri, folder));
          }
          return json(await downloads.act(action, id, { deleteFile: !!deleteFile, paths }));
        } catch (err) {
          throw httpError(502, err.message);
        }
      case "POST /api/transfer-report-stop": // {id}: a program's transfer (its report, browserdownloads.js), stopped
        return json({ stopped: browserDownloads.stop(String((await req.json()).id ?? "")) });
      case "POST /api/choose": { // {out, paths}: a file chooser's answer (phil --choose): the paths, one per line, in <out>, then <out>.done; [] cancelled
        const { out, paths = [], save = false } = await req.json();
        if (typeof out !== "string" || !out.startsWith("/") || !Array.isArray(paths) || !paths.every((p) => typeof p === "string" && p.startsWith("/"))) throw httpError(400, "out, and the chosen paths");
        if (await isDir(out)) throw httpError(400, "out is a folder");
        if (await Deno.lstat(`${out}.done`).then(() => true, () => false)) return json({ ok: true, already: true }); // answered once
        await Deno.writeTextFile(out, paths.length ? paths.join("\n") + "\n" : "");
        if (save && paths.length) browserDownloads.saved(paths[0]); // an app downloading it there: in the Transfers list
        await Deno.writeTextFile(`${out}.done`, "");
        return json({ ok: true });
      }
      case "GET /api/download-settings": // panda-dl's: {running, config}
        return json(await downloads.settings());
      case "PUT /api/download-settings": // {name: value, ...}: some of them changed; answers as GET
        try {
          return json(await downloads.setSettings(await req.json()));
        } catch (err) {
          throw httpError(400, err.message);
        }
      case "POST /api/transfer-forget": // {path}: drops a stopped copy's record (what was copied stays)
        await hooks.set(requirePath(path), { copying: "" });
        broadcast({ stoppedTransfers: true });
        return json({ ok: true });
      case "POST /api/rename": {
        const body = await req.json();
        const renamed = await totals.renaming(requirePath(body.path));
        const result = await rename(body);
        await renamed(result.path);
        await hooks.moved(body.path, result.path);
        await movedPositions(body.path, result.path).catch(() => {});
        thumbs.carry(body.path, result.path).catch(() => {});
        return json(result);
      }
      case "POST /api/mount": // {device}: a drive listed as not mounted
        return json(await mountDrive(await req.json()));
      case "POST /api/unmount": // {path}: a drive mounted under /run/media
        return json(await unmountDrive(await req.json()));
      case "POST /api/create": { // {dir, kind: "dir" | "file"}: a new folder or file there
        const body = await req.json();
        const created = await totals.creating(requirePath(body.dir));
        const result = await create(body);
        await created(result.path);
        return json(result);
      }
      case "GET /api/properties":
        return json({ ...await properties(requirePath(path)), meta: await hooks.get(path) });
      case "GET /api/drive-speeds": { // ?path=...&path=...: the sidebar's drives' last speed tests, {path: {read, at}}
        const out = {};
        await Promise.all(url.searchParams.getAll("path").map(async (p) => {
          const info = await driveInfo(p, speedsFile).catch(() => null);
          if (info?.speed) out[p] = info.speed;
        }));
        return json(out);
      }
      case "GET /api/drive": { // a mount point's drive (Properties of the sidebar's drives), with its last speed test, and what phil does on it
        const drive = requirePath(path);
        const [info, own] = await Promise.all([driveInfo(drive, speedsFile), driveOptions.get(drive)]);
        return json({ ...info, options: { thumbnails: own.thumbnails !== false, folderSizes: await countsTotals(drive), own } });
      }
      case "PUT /api/drive-options": { // {path, thumbnails, folderSizes}: a drive's (true, false; null: as usual)
        const { path: drive, ...changes } = await req.json();
        await driveOptions.set(requirePath(drive), changes);
        return json({ ok: true });
      }
      case "POST /api/sudo": { // {password}: for sudo (sudo.js), after a 401; 401 again when it's wrong
        const { password, why } = await req.json();
        if (!(await sudoPassword(password ?? ""))) throw httpError(401, `That password didn't work.${why ? ` ${why}` : ""}\nPassword for sudo:`);
        return json({ ok: true });
      }
      case "POST /api/drive-speed": // {path}: time reading from it, as root (401: sudo's password needed)
        try {
          const result = await driveSpeed(requirePath((await req.json()).path), speedsFile);
          thumbs.forgetLimits(); // thumbnails at once on it go by its new speed
          return json(result);
        } catch (err) {
          throw err.status ? err : httpError(500, err.message);
        }
      case "GET /api/folder-size":
        return json(await folderSize(requirePath(path)));
      case "PUT /api/meta": { // {path, description, onChange, tags, autoTags, icon, background}: Properties' phil section
        const { path, ...changes } = await req.json();
        if ("icon" in changes && changes.icon && !/^[a-z0-9-]{1,64}$/.test(changes.icon)) throw httpError(400, "An icon's name, from the list");
        const clean = (key) => key in changes ? { [key]: String(changes[key] ?? "").trim() } : {};
        const tags = "tags" in changes ? cleanTags(changes.tags) : null;
        const auto = "autoTags" in changes ? { autoTags: changes.autoTags ? true : "" } : {}; // a folder's: tag its pictures
        const media = "media" in changes ? { media: changes.media ? true : "" } : {}; // a folder's: its videos in mediaview
        const background = "background" in changes ? { background: changes.background ? true : "" } : {}; // a script's: run as a terminal in the background
        await hooks.set(requirePath(path), { ...clean("description"), ...clean("onChange"), ...clean("icon"), ...(tags ? { tags: tags.length ? tags : "" } : {}), ...auto, ...media, ...background });
        if (tags?.length) await addTagsToLists([path], tags);
        return json({ ok: true });
      }
      case "POST /api/tags": { // {paths, tags}: tags added by hand to the selected pictures
        const body = await req.json();
        const tags = cleanTags(body.tags);
        const all = await hooks.all();
        for (const p of body.paths ?? []) {
          requirePath(p);
          await hooks.set(p, { tags: [...new Set([...(all[p]?.tags ?? []), ...tags])] });
        }
        await addTagsToLists(body.paths ?? [], tags);
        return json({ ok: true, tags });
      }
      case "POST /api/run-hook": { // Properties' "Run now"
        const { path, command } = await req.json();
        return json(await runHook(requirePath(path), String(command ?? "")));
      }
      case "POST /api/add-to-config":
        return json(await addToConfig(requirePath((await req.json()).path)));
      case "GET /api/tag-lists": // Preferences: what auto-tagging looks for, {available, pictures: {tags, text, custom}, documents}
        return json({ available: await tagging.available(), pictures: await tagging.list("pictures"), documents: await tagging.list("documents") });
      case "PUT /api/tag-lists": { // {kind, text: one tag per line | null (phil's list again)}
        const { kind, text } = await req.json();
        if (kind !== "pictures" && kind !== "documents") throw httpError(400, "pictures or documents");
        if (text !== null && typeof text !== "string") throw httpError(400, "text: the list, or null");
        try {
          await tagging.setList(kind, text);
        } catch (err) {
          throw httpError(409, err.message);
        }
        return json(await tagging.list(kind));
      }
      case "POST /api/terms-rename": { // {id, name}: a terminal in the background named ("": as what runs there)
        const { id, name } = await req.json();
        await terms.rename(String(id), name);
        return json({ ok: true });
      }
      case "POST /api/terms-script": { // {id, dir, name, icon}: a background terminal dragged onto a folder: a script there that starts it again
        const { id, dir, name, icon } = await req.json();
        const t = terms.list().find((t) => t.id === String(id));
        if (!t) throw httpError(404, "No such terminal");
        const folder = requirePath(dir);
        // What runs there (a shell at its prompt: nothing but where it is). ssh'd in, with a command
        // typed there (its prompt left out): that one run there, on a terminal (-t).
        const argv = t.argv?.length ? t.argv : (t.command ?? "").split(/\s+/).filter(Boolean);
        const program = (argv[0] ?? "").split("/").pop().replace(/^-/, "");
        const typed = (t.typed ?? "").replace(/^.*?[#$%>❯➜»]\s+(?=\S)/u, "").trim();
        const command = ["bash", "sh", "zsh", "fish", "dash"].includes(program) ? [] : program === "ssh" && typed ? [argv[0], "-t", ...argv.slice(1), typed] : argv;
        const base = String(name || program || "terminal").replaceAll("/", "-").replace(/^\.+/, "").trim().slice(0, 120) || "terminal";
        let path = join(folder, base);
        for (let n = 2; await Deno.lstat(path).then(() => true, () => false); n++) path = join(folder, `${base} ${n}`);
        const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
        // Just what to run, where: a script like any. Marked to run in the background (its
        // Properties): double-clicked, phil runs it in a terminal of its own there (sourced in its
        // shell: where it cds is where that shell is, and back at its prompt when it ends).
        const script = `#!/bin/sh\ncd ${q(t.cwd || home())}${command.length ? ` && ${command.map(shellWord).join(" ")}` : ""}\n`;
        await Deno.writeTextFile(path, script, { createNew: true });
        await Deno.chmod(path, 0o755);
        await hooks.set(path, { background: true, ...(typeof icon === "string" && /^[a-z0-9-]{1,64}$/.test(icon) ? { icon } : {}) });
        return json({ path });
      }
      case "POST /api/terms-run": { // {path}: a script marked to run in the background: a terminal there, named after it, running it
        const path = requirePath((await req.json()).path);
        const name = basename(path).replace(/\.(sh|bash)$/, "");
        // (One that only goes somewhere, cds and nothing else: its shell stays, there.)
        const lines = (await Deno.readTextFile(path).catch(() => "")).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
        const stay = lines.length > 0 && lines.every((l) => /^cd\s+(?:'[^']*'|\S+)$/.test(l));
        const result = await background({ command: [".", path], name, cwd: dirname(path), stay });
        if (!result.ok) throw httpError(409, result.error);
        return json(result);
      }
      case "PUT /api/terms-order": // {ids}: the terminals in the background in this order (the sidebar's, dragged)
        await terms.setOrder((await req.json()).ids ?? []);
        return json({ ok: true });
      case "GET /api/icon/claude": { // the sidebar's Processes: Claude Code in a terminal in the background
        // claude.ai's favicon: fetched once, kept in phil's cache (not in phil itself: Anthropic's).
        const file = join(dirname(config.cacheThumbDir), "icons", "claude.ico");
        let icon = await Deno.readFile(file).catch(() => null);
        if (!icon) {
          const res = await fetch("https://claude.ai/favicon.ico", { signal: AbortSignal.timeout(5000) }).catch(() => null);
          if (!res?.ok) return text(404, "No icon");
          icon = new Uint8Array(await res.arrayBuffer());
          await Deno.mkdir(dirname(file), { recursive: true }).catch(() => {});
          await Deno.writeFile(file, icon).catch(() => {});
        }
        return new Response(icon, { headers: { "content-type": "image/vnd.microsoft.icon", "cache-control": "max-age=86400" } });
      }
      case "GET /api/version": // Preferences: the commit it's built from
        return json(await buildInfo());
      case "GET /api/themes": // the bottom bar's theme picker
        return json({ themes: await themeNames(), dir: themesDir(), theme: await currentTheme() });
      case "PUT /api/theme": // {theme}: picked there
        return json(await pickTheme((await req.json()).theme));
      case "POST /api/themes": // {name}: a new one, from the template
        return json(await newTheme((await req.json()).name));
      case "PUT /api/settings": { // a window's settings; ?chooser=1: a file chooser's own (its "chooser" key), the rest kept
        if (config.incognito) return json({ ok: true }); // incognito: this session only
        const body = await req.json(), saved = await readSettings();
        if (url.searchParams.get("chooser") === "1") await writeSettings({ ...saved, chooser: body });
        else await writeSettings({ ...body, chooser: saved.chooser }); // (not over the chooser's)
        return json({ ok: true });
      }
      case "GET /ws":
        return thumbSocket(req);
      case "GET /term":
        return terminalSocket(req, url);
    }
    const thumb = /^\/thumbs\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && thumb && thumb[1] === thumbs.name) {
      const file = thumbs.fileFor(thumb[2]);
      if (file) return serveFile(req, file, { "cache-control": "private, max-age=31536000, immutable" });
    }
    return null;
  }

  async function listDir(dir, sort) {
    const mtime = (await Deno.stat(dir)).mtime?.getTime() ?? 0; // before reading: a change while listing is caught next time
    const entries = await readEntries(dir);
    const meta = await hooks.all();
    const byHand = new Map(); // folder -> tag -> how many there have it, given by hand
    for (const [p, m] of Object.entries(meta)) {
      if (!m.tags?.length) continue;
      const counts = byHand.get(dirname(p)) ?? byHand.set(dirname(p), new Map()).get(dirname(p));
      for (const t of m.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    for (const e of entries) {
      if (meta[e.path]?.onChange) e.onChange = meta[e.path].onChange;
      if (meta[e.path]?.description) e.description = meta[e.path].description;
      if (meta[e.path]?.icon) e.icon = meta[e.path].icon; // a folder's, picked in its Properties
      if (meta[e.path]?.media) e.mediaFolder = true; // a media folder (its Properties): mediaview's
      if (meta[e.path]?.background) e.background = true; // a script run as a terminal in the background (its Properties)
      if (meta[e.path]?.copying) { // a copy into it: under way, or stopped (cut off: no job has it)
        e.copying = { ...meta[e.path].copying };
        if (!liveTargets.has(e.path)) e.copying.state = "stopped";
      }
      if (meta[e.path]?.tags?.length) e.tags = meta[e.path].tags; // given by hand
      if (e.kind === "dir") { // its most common tags, for its tile: found when it was last tagged, and given by hand
        const counts = new Map(await tagging.summary(e.path));
        for (const [t, n] of byHand.get(e.path) ?? []) counts.set(t, Math.max(counts.get(t) ?? 0, n));
        if (counts.size) e.folderTags = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12);
      }
    }
    // While we're here, this folder's own summary, from thumbnails already cached (a drive without previews: none).
    const previews = await previewsOn(dir);
    const previewOf = (e) => (!previews ? false : e.kind === "file" ? textPreviewOf(e) : typeof e.thumb === "string" ? { url: e.thumb } : e.thumb ?? null);
    makeSummary({ entries, mtime, sort, previewOf, subfolderPreviewOf: async (e) => (!previews ? false : e.summary ? lentPreview(e.summary) ?? false : null) }) // none yet: incomplete, made when its tile shows
      .then((summary) => folders.save(dir, previews ? summary : { ...summary, noPreviews: true }))
      .catch((err) => console.error(`phil: can't save folder summary: ${err.message}`));
    return { path: dir, parent: dir === "/" ? null : dirname(dir), entries, autoTags: !!meta[dir]?.autoTags };
  }

  // The folder's entries with size and date; with `lookups`, also each media
  // file's cached thumbnail, each subfolder's saved summary, whether you can
  // change it without sudo (`writable`; through a link, what it points to)
  // and what a link points to (`target`).
  async function readEntries(dir, { lookups = true } = {}) {
    const dirents = [];
    for await (const d of Deno.readDir(dir)) dirents.push(d);
    const who = lookups ? await me() : null;
    const dirStat = lookups ? await Deno.stat(dir).catch(() => null) : null;
    const counted = lookups && await countsTotals(dir);
    const previews = !lookups || await previewsOn(dir);
    const mountPoints = []; // subfolders on another file system: drives mounted there
    const entries = await mapLimit(dirents, 64, async (d) => {
      const path = join(dir, d.name);
      let stat = null;
      try {
        stat = await Deno.stat(path);
      } catch { /* broken symlink or no permission */ }
      const kind = stat?.isDirectory ? "dir" : mediaKind(d.name);
      const entry = {
        name: d.name,
        path,
        kind,
        size: stat?.size ?? 0,
        mtime: stat?.mtime?.getTime() ?? 0,
        symlink: d.isSymlink,
      };
      if (!lookups) return entry;
      if (d.isSymlink) entry.target = await Deno.readLink(path).catch(() => null);
      if (stat) {
        const folder = !stat.isFile ? null : d.isSymlink ? await Deno.realPath(path).then((real) => Deno.stat(dirname(real))).catch(() => null) : dirStat;
        entry.writable = canWrite(stat, folder, who);
      }
      if (stat && (kind === "image" || kind === "video" || kind === "pdf")) entry.thumb = previews ? await thumbs.lookup(path, stat) : false; // (false: none, nothing asked)
      if (kind === "dir" && !d.isSymlink && dirStat && stat.dev !== dirStat.dev) mountPoints.push(entry);
      else if (kind === "dir") entry.total = counted ? await totals.get(path, entry.mtime) : null; // { bytes, stale } or null; the page asks for stale ones
      if (kind === "dir") entry.summary = await folders.get(path);
      // A drive without previews: its folders' faces without them. One made so, with them again: made again.
      if (entry.summary && !previews) entry.summary = { ...entry.summary, previews: [] };
      else if (entry.summary?.noPreviews) entry.summary = null;
      return entry;
    });
    // A drive mounted here: its size and free space ({size, avail}, df's, as the sidebar's), not a total.
    if (mountPoints.length) {
      const space = await freeSpace(mountPoints.map((e) => e.path));
      for (const e of mountPoints) e.space = space[e.path] ?? null, e.total = null;
    }
    return entries;
  }

  // A text file's preview for its folder's tile, or false if it isn't text.
  // Documents (Word, RTF, ...) are converted to Markdown for it, once: kept
  // with the thumbnails.
  const documentCache = join(config.thumbDir, "documents");
  const textPreviewOf = (e, signal) => textPreview(e.path, { cacheDir: documentCache, signal }).then((text) => text && { text }, () => false);

  // A folder tile came into view without an up-to-date summary: read the folder
  // and make previews of its first files in the view's sort order.
  // What a subfolder lends its folder's tile: its first picture (an image's or a
  // video's thumbnail), its first text only when it has no picture.
  const lentPreview = (summary) => summary?.previews?.find((p) => p.url) ?? summary?.previews?.[0];

  // A folder with too few files of its own borrows its first subfolders' first
  // previews (`deep`: their summaries made too, one level down).
  async function summarize(path, sort, signal, deep = true) {
    const mtime = (await Deno.stat(path)).mtime?.getTime() ?? 0;
    const entries = await readEntries(path, { lookups: false });
    const previews = await previewsOn(path); // (a drive without them: its counts and size only)
    signal.throwIfAborted();
    let busy = 0; // a picture in it being written, without a thumbnail yet: asked again (in this many ms) when it may have settled
    const summary = await makeSummary({
      entries,
      mtime,
      sort,
      async previewOf(e) {
        if (!previews) return false;
        if (e.kind === "file") return await textPreviewOf(e, signal);
        try {
          return { url: await thumbs.get(e.path, signal) };
        } catch (err) {
          if (signal.aborted) throw err;
          if (err.busy) return (busy = busy ? Math.min(busy, err.retryIn) : err.retryIn), null; // not yet: the summary is incomplete till it is
          return false; // can't be thumbnailed: skipped, not retried
        }
      },
      subfolderPreviewOf: deep && previews
        ? async (e) => {
          const known = await folders.get(e.path);
          const theirs = known?.mtime === e.mtime ? known : await summarize(e.path, sort, signal, false).catch(() => null);
          return lentPreview(theirs) ?? false;
        }
        : null,
    });
    if (busy) summary.busy = true;
    if (!previews) summary.noPreviews = true; // (made with them when they're on again)
    await folders.save(path, summary);
    return summary;
  }

  // One WebSocket per page. The page sends {want: [paths]} for tiles entering the
  // viewport (thumbnails for images and videos, the start of the text for other files), {folders: [paths], sort} for folder tiles that need a summary,
  // {cancel: [paths]} for tiles that scrolled away before loading, and
  // {watch: path} for the folder it shows. Unlike <img> requests this isn't
  // capped at ~6 connections per host. The server sends the answers, {changed}
  // (see watchFolder), and {theme} when the theme in the settings file changes.
  function thumbSocket(req) {
    if (req.headers.get("upgrade") !== "websocket") return text(400, "Bad request");
    const { socket, response } = Deno.upgradeWebSocket(req);
    const pending = new Map();
    let watcher = null, watching = Promise.resolve(); // one watch request at a time
    let hookWatch = null; // the shown folder's hooks (hooks.js)
    let tagJob = null; // the shown folder's tagging, aborted when another is asked for
    let backgroundJob = null; // the shown folder's other thumbnails, made in the background
    let totalsJob = new AbortController(); // the shown folder's folders' totals, dropped when another is shown
    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.watch) {
        watching = watching.then(async () => (watcher = await watchFolder(msg.watch, watcher, send))).catch(() => {});
        if (shown.get(socket) !== msg.watch) {
          totalsJob.abort();
          totalsJob = new AbortController();
          hookWatch?.close();
          hookWatch = hooks.watch(msg.watch);
          shown.set(socket, msg.watch);
        }
      }
      if (msg.search) { // {search: {dir, text}}: its pictures that look like `text`, as {searched: dir, text, scores}
        const { dir, text } = msg.search;
        tagKinds()
          .then((kinds) => (kinds.pictures || kinds.documents ? tagging.search(dir, text, kinds) : {}))
          .then((scores) => send({ searched: dir, text, scores }), (err) => send({ searched: dir, text, scores: {}, error: err.message }));
      }
      if ("tag" in msg) { // {tag: folder} tags its pictures, sending {tagged: folder, tags, left}; {tag: null} stops
        tagJob?.abort();
        tagJob = msg.tag ? new AbortController() : null;
        if (tagJob) tagFolder(msg.tag, tagJob.signal, send).catch(() => {});
      }
      if ("background" in msg) { // {background: [paths]}, top first: made while nothing on screen waits, each sent as {made: path, url}
        backgroundJob?.abort();
        backgroundJob = new AbortController();
        makeInBackground(Array.isArray(msg.background) ? msg.background : [], backgroundJob.signal, send);
      }
      // {totals: [folder], check}: worked out (foldertotals.js; `check`, F5: the time of every folder
      // under them looked at), then {totalOf, bytes} (null: none, as on a USB drive unless set otherwise).
      // Incognito, only on F5: otherwise what's known.
      if (msg.totals?.length) {
        const signal = totalsJob.signal;
        countsTotals(msg.totals[0]).then(async (counted) => {
          for (const path of msg.totals) {
            if (counted && (msg.check || !config.incognito)) totals.refresh(path, (bytes) => send({ totalOf: path, bytes }), signal, msg.check ? "check" : "update", (bytes) => send({ totalOf: path, bytes, partial: true }));
            else send({ totalOf: path, bytes: counted ? (await totals.get(path, null))?.bytes ?? null : null });
          }
        });
      }
      for (const path of msg.cancel ?? []) pending.get(path)?.abort();
      for (const path of msg.want ?? []) {
        if (pending.has(path)) continue;
        if (mediaKind(path) === "file") { // other files: the start of their text, if they're text (documents: converted)
          const ctrl = new AbortController();
          pending.set(path, ctrl);
          previewsOn(path).then((on) => (on ? textHead(path, { cacheDir: documentCache, signal: ctrl.signal }) : null))
            .then((text) => send({ path, text }), () => !ctrl.signal.aborted && send({ path, text: null }))
            .finally(() => pending.get(path) === ctrl && pending.delete(path));
          continue;
        }
        const ctrl = new AbortController();
        pending.set(path, ctrl);
        previewsOn(path).then((on) => (on ? thumbs.get(path, ctrl.signal) : false)) // (a drive without them: none, as one that can't be made)
          .then((url) => send({ path, url }))
          .catch((err) => {
            if (ctrl.signal.aborted) return;
            if (err.busy) return send({ path, url: null, busy: err.retryIn }); // being written: asked again when it may have settled
            console.error(`phil: ${err.message}`);
            send({ path, url: false });
          })
          .finally(() => pending.delete(path));
      }
      for (const path of msg.folders ?? []) {
        if (pending.has(path)) continue;
        const ctrl = new AbortController();
        pending.set(path, ctrl);
        summarize(path, msg.sort, ctrl.signal)
          .then((summary) => send({ folder: path, summary }))
          .catch(() => ctrl.signal.aborted || send({ folder: path, summary: null }))
          .finally(() => pending.delete(path));
      }
    };
    sockets.add(socket);
    const stopDownloads = downloads.use(); // asked about while a window is open
    const stopBrowserDownloads = browserDownloads.use();
    socket.addEventListener("open", () => {
      if (downloads.list.length) send({ downloads: downloads.list });
      if (processes().length) send({ processes: processes() });
      if (browserDownloads.list.length) send({ browserDownloads: browserDownloads.list });
    });
    socket.onclose = () => {
      stopDownloads();
      stopBrowserDownloads();
      sockets.delete(socket);
      shown.delete(socket);
      hookWatch?.close();
      tagJob?.abort();
      backgroundJob?.abort();
      totalsJob.abort();
      pending.forEach((c) => c.abort());
      watching.then(() => watcher?.close());
    };
    const send = (msg) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(msg));
    return response;
  }

  // A folder's thumbnails not on screen, made in the background (the
  // thumbnailer runs one only when none on screen waits): a few asked for at a
  // time, so pictures still go to vips together.
  async function makeInBackground(paths, signal, send) {
    let next = 0;
    const worker = async () => {
      while (next < paths.length && !signal.aborted) {
        const path = paths[next++];
        if (typeof path !== "string" || mediaKind(path) === "file" || !(await previewsOn(path))) continue;
        const url = await thumbs.get(path, signal, { background: true }).catch(() => null);
        if (url && !signal.aborted) send({ made: path, url });
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  // Tags the pictures and documents in `dir` for a page (the kinds set up and
  // on), sending what's ready as it goes: {tagged: dir, tags: {path: [[tag,
  // score]]}, left}, or {tagged: dir, error} ("setup" when the tagger isn't
  // installed).
  async function tagFolder(dir, signal, send) {
    if (!(await tagging.available()).pictures) return send({ tagged: dir, error: "setup" });
    const kinds = await tagKinds();
    if (!kinds.pictures && !kinds.documents) return send({ tagged: dir, tags: {}, left: 0 });
    const files = [];
    for await (const d of Deno.readDir(dir)) {
      if (d.name.startsWith(".") || !kinds[tagKind(d.name)]) continue;
      const stat = await Deno.stat(join(dir, d.name)).catch(() => null);
      if (stat?.isFile) files.push({ path: join(dir, d.name), size: stat.size, mtime: stat.mtime?.getTime() ?? 0 });
    }
    try {
      for await (const step of tagging.tag(dir, files, thumbnailFile, signal, kinds)) {
        if (signal.aborted) return;
        send({ tagged: dir, ...step });
      }
    } catch (err) {
      if (!signal.aborted) send({ tagged: dir, error: err.message });
    }
  }

  // Watches the folder a page shows and its subfolders (not deeper), and sends
  // {changed: dir, folders: [subfolders]} at most twice a second: `dir` itself
  // when something in it was added, removed or modified, `folders` for those
  // whose contents changed. Whatever made the change: phil, the terminal or
  // another program. Returns the watcher, or reuses `old` when it already
  // watches the same folders (the page asks again after every refresh, so
  // new subfolders get watched).
  const MODIFIED_MS = 5000; // a file only growing: told this often, at most (see watchFolder)
  async function watchFolder(dir, old, send) {
    const subfolders = [];
    try {
      for await (const d of Deno.readDir(dir)) {
        if (d.name.startsWith(".") || subfolders.length >= 2000) continue;
        const path = join(dir, d.name);
        if (d.isDirectory || (d.isSymlink && await isDir(path))) subfolders.push(path);
      }
    } catch { /* gone, or no permission: watch nothing */ }
    const paths = [dir, ...subfolders.sort()];
    const key = paths.join("\0");
    if (old?.key === key) return old;
    old?.close();
    let fsWatcher;
    try {
      fsWatcher = Deno.watchFs(paths, { recursive: false });
    } catch {
      try {
        fsWatcher = Deno.watchFs(dir, { recursive: false }); // a subfolder we can't watch
      } catch {
        return null;
      }
    }
    const watched = new Set(subfolders);
    // Told within half a second of a file coming, going or renamed; a file only
    // growing (a download writing it) every few seconds, not every half second
    // (each time, the window reads the folder again).
    let changed = false, timer = null, timerQuick = false;
    const folders = new Set();
    const flush = () => {
      timer = null;
      if (changed) totals.touched(dir); // (what's in the folders shown, too: their totals)
      for (const folder of folders) totals.touched(folder);
      send({ changed: changed ? dir : null, folders: [...folders] });
      changed = false;
      folders.clear();
    };
    (async () => {
      for await (const event of fsWatcher) {
        if (event.kind === "access") continue; // closing a file isn't a change
        for (const path of event.paths) {
          if (thumbs.dir && path.startsWith(thumbs.dir + "/")) continue; // our own cache, shown in phil: no feedback loop
          const parent = dirname(path);
          if (path === dir || parent === dir) changed = true;
          else if (watched.has(parent) && !basename(path).startsWith(".")) folders.add(parent);
        }
        if (!changed && !folders.size) continue;
        const quick = event.kind !== "modify";
        if (timer && (timerQuick || !quick)) continue;
        clearTimeout(timer);
        timer = setTimeout(flush, quick ? 500 : MODIFIED_MS);
        timerQuick = quick;
      }
    })().catch(() => {});
    return { key, close: () => (clearTimeout(timer), fsWatcher.close()) };
  }

  // Terminal panel: one bash per WebSocket, on a pseudo-terminal in a host of
  // its own (terms.js; ?session=: an earlier one's, in the background, shown
  // again). Binary frames carry terminal data both ways; text frames carry
  // {resize: [cols, rows]}, {cd: path}, which changes the shell's directory
  // without typing a command (see __phil_follow in shell-init.bash), and
  // {background: true} (Super+°: it goes on without the panel); back, {session}
  // (which it is), {open} (phil-editor's), {replayed} (its screen given, as it
  // was: an earlier one's), {background}, {taken} (shown in another panel now).
  const cdFileOf = (terminal) => join(Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp", `phil-cd-${terminal}`);
  // A shell in a host of its own (terms.js), as the panel's are.
  async function startShell(terminal, cwd, cols, rows, env = {}) {
    await terms.start({
      id: terminal,
      command: ["bash", "--rcfile", await shellInit, "-i"],
      cwd,
      cols,
      rows,
      env: {
        PHIL_CD_FILE: cdFileOf(terminal),
        PHIL_TERMINAL: terminal,
        PHIL_ENGINE_COMMAND: engineCommand().join(" "), // (vu's: shell-init.bash)
        ...(controlSocket ? { PHIL_ENGINE_SOCKET: controlSocket } : {}),
        ...(config.incognito ? { PHIL_INCOGNITO: "1" } : {}),
        ...env,
      },
    });
  }

  // phil --background: a terminal put in the background at once, last in their order: its shell
  // in `cwd`, running `command` before its first prompt (shell-init.bash's PHIL_RUN: nothing typed,
  // only its output on the screen), `name` its name. When `command` ends, so does the terminal
  // (`stay`: its shell's prompt then, there: a script that only cds).
  async function background({ command = [], name = "", cwd, stay = false }) {
    if (!terms.persistent) return { ok: false, error: "no terminals in the background here (incognito)" };
    const terminal = crypto.randomUUID();
    await startShell(terminal, await isDir(cwd ?? "") ? cwd : home(), 120, 36, command.length ? { PHIL_RUN: command.map(shellWord).join(" "), ...(stay ? {} : { PHIL_RUN_THEN: "exit" }) } : {});
    const host = await terms.attach(terminal, { onData() {}, onMessage() {}, onClose() {} });
    if (!host) return { ok: false, error: "its terminal didn't start" };
    await host.send({ keep: true });
    host.close();
    if (name) await terms.rename(terminal, name);
    await terms.last(terminal);
    return { ok: true, id: terminal };
  }
  const shellWord = (s) => (/^[\w.+@%/:=,-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);
  async function terminalSocket(req, url) {
    if (req.headers.get("upgrade") !== "websocket") return text(400, "Bad request");
    const size = (name, fallback) => Math.max(1, Number(url.searchParams.get(name)) || fallback);
    const cols = size("cols", 80), rows = size("rows", 24);
    // PHIL_TERMINAL and PHIL_ENGINE_SOCKET: so phil-editor run in this shell
    // can have its editor shown in this window (see control()).
    let terminal = url.searchParams.get("session");
    if (!terminal) {
      const cwd = await isDir(url.searchParams.get("cwd") ?? "") ? url.searchParams.get("cwd") : home();
      terminal = crypto.randomUUID();
      try {
        await startShell(terminal, cwd, cols, rows);
      } catch (err) {
        return text(500, err.message);
      }
    }
    const cdFile = cdFileOf(terminal);
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.binaryType = "arraybuffer";
    // (What comes before the page's end is open: kept for it.)
    const outbox = [];
    const out = (m) => (socket.readyState === WebSocket.OPEN ? socket.send(m) : socket.readyState === WebSocket.CONNECTING && outbox.push(m));
    socket.onopen = () => outbox.splice(0).forEach((m) => socket.send(m));
    const host = await terms.attach(terminal, {
      onData: (bytes) => out(bytes),
      onMessage: (m) => out(JSON.stringify(m)),
      onClose: () => {
        if (socket.readyState === WebSocket.OPEN) socket.close(1000, "shell exited");
        else if (socket.readyState === WebSocket.CONNECTING) socket.onopen = () => socket.close(1000, "shell exited");
      },
    });
    if (!host) {
      socket.onopen = () => socket.close(1000, "no such terminal");
      return response;
    }
    out(JSON.stringify({ session: terminal }));
    host.send({ resize: [cols, rows] }); // (an earlier one: this panel's size)
    terminals.set(terminal, socket);
    // Handled strictly in order, so keystrokes sent right after a {cd} can't
    // overtake its key sequence + Enter and end up executed as a command.
    let queue = Promise.resolve();
    socket.onmessage = (e) => {
      queue = queue.then(async () => {
        if (typeof e.data !== "string") return host.write(new Uint8Array(e.data));
        const { resize, cd, host: remote, background, line } = JSON.parse(e.data);
        if (resize) host.send({ resize });
        if (typeof line === "string") host.send({ line }); // (Enter pressed on it: what's run, over ssh too)
        if (background) {
          // Super+°: on without the panel (not incognito's, nor a run with no engine of its own).
          if (!terms.persistent) return out(JSON.stringify({ background: false }));
          await host.send({ keep: true });
          return out(JSON.stringify({ background: true }));
        }
        if (cd && remote) {
          // The shell is ssh'd in (phil's ssh, shell-init.bash): leave the
          // target in its cd file over the session's own connection, then the
          // empty Enter, as below.
          const shq = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
          const write = `printf '%s\\000%s\\000' "$(date +%s)" ${shq(cd)} > /tmp/phil-cd-${terminal}`;
          const socketPath = join(Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp", `phil-ssh-${terminal}`);
          const done = await new Deno.Command("ssh", {
            args: ["-S", socketPath, "-o", "ControlMaster=no", "-o", "BatchMode=yes", remote, write],
            stdin: "null", stdout: "null", stderr: "null",
          }).output().catch(() => ({ success: false }));
          if (done.success) await host.write(new TextEncoder().encode("\r"));
        } else if (cd && await isDir(cd)) {
          await Deno.writeTextFile(cdFile, `${Math.floor(Date.now() / 1000)}\0${cd}\0`);
          await host.write(new TextEncoder().encode("\r"));
        }
      }).catch(() => {});
    };
    socket.onclose = () => {
      if (terminals.get(terminal) === socket) terminals.delete(terminal);
      host.close(); // (its host goes, unless it's in the background)
    };
    return response;
  }

  // F2: renames in place. Never overwrites: a name that's taken is an error.
  // The metadata of what was deleted or moved (the paths without an error) follows it.
  async function movedHooks(paths, { errors = [] }, to) {
    const failed = new Set(errors.map((e) => e.path));
    for (const path of paths) {
      if (failed.has(path)) continue;
      await hooks.moved(path, to(path)).catch(() => {});
      await movedPositions(path, to(path)).catch(() => {});
    }
  }

  // Where each video was left, and which were watched (videoplayer's, by path:
  // mediaview shows them) follow a move or rename, or go with a delete (`to` null).
  const positionsFile = join(dirname(config.stateFile), "videoplayer-positions.json");
  async function movedPositions(from, to) {
    if (config.incognito) return;
    const all = await Deno.readTextFile(positionsFile).then(JSON.parse, () => null);
    if (!all) return;
    let changed = false;
    for (const path of Object.keys(all)) {
      if (path !== from && !path.startsWith(from + "/")) continue;
      if (to) all[to + path.slice(from.length)] = all[path];
      delete all[path];
      changed = true;
    }
    if (!changed) return;
    const tmp = `${positionsFile}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(all));
    await Deno.rename(tmp, positionsFile);
  }

  async function rename({ path, name }) {
    requirePath(path);
    if (typeof name !== "string" || !name || name.includes("/") || name.includes("\0") || name === "." || name === "..") {
      throw httpError(400, "That isn't a valid name.");
    }
    const target = join(dirname(path), name);
    if (target === path) return { path };
    if (normalize(path) !== path || path === "/") throw httpError(400, "invalid path");
    if (await Deno.lstat(target).then(() => true, () => false)) {
      throw httpError(409, `There's already an item called “${name}” here.`);
    }
    await Deno.rename(path, target);
    await folders.moved(path, target).catch(() => {});
    return { path: target };
  }

  // Whether folders' totals are worked out where `path` is: the drive's own
  // say (its Properties), else the folderSizes setting, "all", "off", or
  // (unset) not on a USB drive.
  async function countsTotals(path) {
    const own = (await driveOptions.get(path)).folderSizes; // the drive's (its Properties)
    if (typeof own === "boolean") return own;
    const { folderSizes } = await readSettings();
    if (folderSizes === "all" || folderSizes === "off") return folderSizes === "all";
    return !await onUsb(path);
  }

  async function readSettings() {
    try {
      const settings = JSON.parse(await Deno.readTextFile(config.settingsFile));
      settings.theme ??= settings.labels; // its name in an earlier build
      delete settings.labels;
      return settings;
    } catch {
      return {};
    }
  }

  // The theme is in the settings file (edited by hand, or set by pickTheme):
  // the page's other settings are saved around it. It's written out even when
  // unset, so the file shows where it goes.
  async function writeSettings(settings, { theme } = {}) {
    theme ??= (await readSettings()).theme ?? DEFAULT_THEME;
    delete settings.theme;
    await Deno.mkdir(dirname(config.settingsFile), { recursive: true });
    const tmp = `${config.settingsFile}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify({ theme, ...settings }, null, 2) + "\n");
    await Deno.rename(tmp, config.settingsFile); // atomic, for the watcher and other phils
  }

  // A theme picked in a window: saved in the settings file, which restyles
  // every window (watchTheme). Incognito: those windows only, for the session.
  async function pickTheme(theme) {
    if (!(await themeNames()).includes(theme)) throw httpError(404, `No theme called ${theme}`);
    if (!config.incognito) await writeSettings(await readSettings(), { theme });
    else for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ theme }));
    return { theme };
  }

  // A new theme: <name>.css in the themes folder, from theme-template.css, picked.
  async function newTheme(name) {
    name = String(name ?? "").trim().toLowerCase().replace(/\s+/g, "-");
    if (!/^[\w-]+$/.test(name) || name === "base") throw httpError(400, "A theme's name: letters, digits, - and _");
    const file = join(themesDir(), `${name}.css`);
    const template = await Deno.readTextFile(new URL("./theme-template.css", import.meta.url));
    await Deno.mkdir(themesDir(), { recursive: true });
    try {
      await Deno.writeTextFile(file, template.replace("NAME", name), { createNew: true });
    } catch (err) {
      if (err instanceof Deno.errors.AlreadyExists) throw httpError(409, `There's a theme called ${name} already`);
      throw err;
    }
    await pickTheme(name);
    return { theme: name, file };
  }

  // Editing the theme in the settings file restyles open windows right away.
  async function watchTheme() {
    let theme = await currentTheme();
    let timer;
    for await (const event of Deno.watchFs(dirname(config.settingsFile), { recursive: false })) {
      if (!event.paths.includes(config.settingsFile)) continue;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        let next;
        try {
          JSON.parse(await Deno.readTextFile(config.settingsFile));
          next = await currentTheme();
        } catch {
          return; // gone, or half-written by an editor: wait for the next change
        }
        if (next === theme) return;
        theme = next;
        for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ theme }));
      }, 150);
    }
  }
  watchTheme().catch(() => {}); // no settings folder yet: nothing to watch

  // The folder shown last, so phil reopens there. Written on every folder
  // change (not on exit) so it survives however phil is closed.
  let remembered = null;
  function rememberDir(dir) {
    if (config.incognito || dir === remembered) return;
    remembered = dir;
    Deno.mkdir(dirname(config.stateFile), { recursive: true })
      .then(() => Deno.writeTextFile(config.stateFile, JSON.stringify({ lastDir: dir }, null, 2) + "\n"))
      .catch((err) => console.error(`phil: can't save last folder: ${err.message}`));
  }

  async function lastDir() {
    try {
      const { lastDir } = JSON.parse(await Deno.readTextFile(config.stateFile));
      return typeof lastDir === "string" && await isDir(lastDir) ? lastDir : null;
    } catch {
      return null;
    }
  }

  // Requests to phil on the engine's control socket: { embed: { terminal, app,
  // params } } from phil-editor in a terminal panel shows that app in the
  // panel's window (a text frame on its WebSocket; see terminal.js).
  async function control({ embed, background: wanted }) {
    if (wanted) return await background(wanted);
    const socket = embed && terminals.get(embed.terminal);
    if (socket?.readyState !== WebSocket.OPEN) return { ok: false };
    socket.send(JSON.stringify({ open: { app: embed.app, params: embed.params ?? {} } }));
    return { ok: true };
  }

  return { handle, control, port: config.port || undefined };
}

// bash --rcfile needs a real file, and under `deno compile` ours lives in the
// binary, so copy it out once per run. Named after its contents, so a phil of
// another version (running alongside, say a development one) never overwrites
// it with its own.
const shellInit = (async () => {
  const text = await Deno.readTextFile(new URL("./shell-init.bash", import.meta.url));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const id = Array.from(hash.subarray(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
  const path = join(Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp", `phil-shell-init-${id}.bash`);
  const tmp = `${path}.${Deno.pid}`;
  await Deno.writeTextFile(tmp, text);
  await Deno.rename(tmp, path); // atomic, so a concurrently starting shell never reads half a file
  return path;
})();

// Tags as given (a list, or text separated by commas): trimmed, single
// spaces, no duplicates or empty ones.
function cleanTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags ?? "").split(",");
  return [...new Set(list.map((t) => String(t).trim().replace(/\s+/g, " ")).filter(Boolean))];
}

function requirePath(path) {
  if (!path || !path.startsWith("/")) throw httpError(400, "absolute path required");
  return path;
}

// The XDG user folders (DOCUMENTS, DOWNLOAD, ...) from user-dirs.dirs.
async function userDirs() {
  const h = home();
  const dirs = {};
  try {
    const file = await Deno.readTextFile(join(Deno.env.get("XDG_CONFIG_HOME") ?? join(h, ".config"), "user-dirs.dirs"));
    for (const [, name, value] of file.matchAll(/^XDG_(\w+)_DIR="(.*)"$/gm)) dirs[name] = value.replace(/^\$HOME/, h);
  } catch { /* use defaults */ }
  return dirs;
}

/**
 * "Add to Config": a link to the file in Documents/Config, a place for config
 * files used often but kept who knows where. Named like the file; if that's
 * taken by another file, with its folder's name in front ("waybar-config"),
 * then numbered. Returns { name, existed }.
 */
async function addToConfig(path) {
  const docs = (await userDirs()).DOCUMENTS ?? join(home(), "Documents");
  const dir = join(docs, "Config");
  await Deno.mkdir(dir, { recursive: true });
  const name = basename(path);
  const candidates = [name, `${basename(dirname(path)).replace(/^\./, "")}-${name}`];
  for (let i = 2; i < 100; i++) candidates.push(`${basename(dirname(path)).replace(/^\./, "")}-${name} ${i}`);
  for (const candidate of candidates) {
    const link = join(dir, candidate);
    const target = await Deno.readLink(link).catch(() => null);
    if (target === path) return { name: candidate, existed: true };
    if (target !== null || await Deno.lstat(link).then(() => true, () => false)) continue; // taken
    await Deno.symlink(path, link);
    return { name: candidate, existed: false };
  }
  throw httpError(409, "too many files with this name in Config");
}

// The Media view's place in the sidebar's list of folders (sidebar.json): where it's shown.
const MEDIA_PLACE = "phil:media";

// The sidebar's folders by default: home and its usual folders (the XDG ones), those there are.
async function defaultFolders() {
  const h = home();
  const dirs = await userDirs();
  const known = [h, ...["DESKTOP", "DOCUMENTS", "DOWNLOAD", "PICTURES", "VIDEOS", "MUSIC"].map((k) => (dirs[k] ?? join(h, xdgNames[k])).replace(/\/$/, ""))];
  const out = [];
  for (const path of known) if (!out.includes(path) && await isDir(path)) out.push(path);
  return out;
}
const xdgNames = { DESKTOP: "Desktop", DOCUMENTS: "Documents", DOWNLOAD: "Downloads", PICTURES: "Pictures", VIDEOS: "Videos", MUSIC: "Music" };
const xdgIcons = { DESKTOP: "folder", DOCUMENTS: "folder", DOWNLOAD: "download", PICTURES: "image", VIDEOS: "video", MUSIC: "music" };

// The sidebar: its folders (`folders`, the user's list: dragged there, removed,
// in their order; null for the default ones), each `folder: true`, and the
// Media view (`media: true`; after the folders unless the list says where),
// then the drives and shares, then the whole file system. Folders that aren't
// there (a drive's, while it isn't mounted) are left out until they are.
async function places(folders = null) {
  const h = home();
  const dirs = await userDirs();
  const out = [];
  const seen = new Set();
  const list = folders ?? await defaultFolders();
  for (const path of list.includes(MEDIA_PLACE) ? list : [...list, MEDIA_PLACE]) {
    if (path === MEDIA_PLACE) {
      out.push({ name: "Media", path: null, media: true, folder: true });
      continue;
    }
    if (seen.has(path) || !(await isDir(path))) continue;
    seen.add(path);
    const key = Object.keys(xdgNames).find((k) => (dirs[k] ?? join(h, xdgNames[k])).replace(/\/$/, "") === path);
    const name = path === h ? "Home" : path === "/" ? "Filesystem" : key ? xdgNames[key] : basename(path);
    out.push({ name, path, icon: path === h ? "home" : key ? xdgIcons[key] : "folder", folder: true });
  }
  // Drives and shares: whatever is in /run/media/<user> (USB drives) and /mnt,
  // and the mounts in /etc/fstab that are network shares or outside the
  // system's own folders. Mount points are never looked inside, so a share
  // whose server is asleep can't hold this up (or wake an automount).
  const add = (path, icon) => {
    if (seen.has(path)) return;
    seen.add(path);
    out.push({ name: basename(path), path, icon });
  };
  const mounts = await fstabMounts();
  const drives = await blockDevices();
  for (const base of [`/run/media/${basename(h)}`, "/mnt"]) {
    try {
      for await (const d of Deno.readDir(base)) {
        if (d.isDirectory) add(join(base, d.name), mounts.get(join(base, d.name)) ?? "drive");
      }
    } catch { /* not present */ }
  }
  for (const [path, icon] of mounts) add(path, icon);
  for (const place of out) if (place.folder && place.path && (mounts.has(place.path) || place.path.startsWith(`/run/media/`) && dirname(place.path) === `/run/media/${basename(h)}`)) place.icon = mounts.get(place.path) ?? "drive"; // a drive put among the folders
  // A drive mounted without a label is in a folder named after its UUID: it's
  // called what it was called before, its size and file system.
  for (const place of out) {
    const drive = drives.find((d) => d.mountpoints.includes(place.path));
    if (drive && !drive.label && place.path.startsWith(`/run/media/`)) place.name = driveName(drive);
    if (drive && place.path.startsWith(`/run/media/`)) place.mounted = drive.path; // can be unmounted
  }
  // Partitions nothing has mounted (an internal drive's: only removable ones
  // are mounted by themselves), for a click to mount them.
  for (const d of await unmountedDrives(drives)) out.push({ name: driveName(d), path: null, device: d.path, icon: "drive", unmounted: true });
  if (!seen.has("/")) out.push({ name: "Filesystem", path: "/", icon: "drive" });
  return out;
}

// Size and free space of the sidebar's drives and shares ({path: {size, avail}},
// bytes; df), for those mounted now: not an automount point that isn't (a share
// whose server would have to wake up), and 2 s at most each.
async function freeSpace(paths) {
  // Read by cat: Deno wants --allow-all for /proc/self itself, which the installed build hasn't.
  let mounts = "";
  try {
    const r = await new Deno.Command("cat", { args: ["/proc/self/mounts"], stdin: "null", stdout: "piped", stderr: "null" }).output();
    mounts = new TextDecoder().decode(r.stdout);
  } catch { /* no /proc */ }
  const mounted = new Set(mounts.split("\n").map((l) => l.split(" "))
    .filter((f) => f[2] && f[2] !== "autofs").map((f) => f[1].replace(/\\040/g, " ")));
  const out = {};
  await Promise.all(paths.filter((p) => mounted.has(p)).map(async (path) => {
    try {
      const r = await new Deno.Command("df", {
        args: ["-B1", "--output=size,avail", "--", path],
        stdin: "null",
        stdout: "piped",
        stderr: "null",
        signal: AbortSignal.timeout(2000),
      }).output();
      const [size, avail] = new TextDecoder().decode(r.stdout).trim().split("\n").at(-1).trim().split(/\s+/).map(Number);
      if (size > 0) out[path] = { size, avail };
    } catch { /* df failed, or took too long */ }
  }));
  return out;
}

// The block devices with a file system: { path, size, fstype, label, uuid,
// parttypename, type, mountpoints } (lsblk's), [] without lsblk.
async function blockDevices() {
  try {
    const out = await new Deno.Command("lsblk", {
      args: ["-J", "-b", "-o", "PATH,SIZE,FSTYPE,LABEL,UUID,PARTTYPENAME,TYPE,MOUNTPOINTS"],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(3000),
    }).output();
    const flat = (list) => list.flatMap((d) => [d, ...flat(d.children ?? [])]);
    return flat(JSON.parse(new TextDecoder().decode(out.stdout)).blockdevices ?? [])
      .map((d) => ({ ...d, mountpoints: (d.mountpoints ?? []).filter(Boolean) }));
  } catch {
    return [];
  }
}

const MOUNTABLE = /^(ntfs3?|exfat|vfat|ext[234]|btrfs|xfs|f2fs|hfsplus|apfs|udf)$/;
const NOT_DATA = /^(EFI|BIOS boot|Microsoft reserved|Windows recovery|Linux swap|Linux reserved)/i;

// Partitions with a file system for files that aren't mounted, nor in
// /etc/fstab (those are places already): not EFI, recovery or swap ones, not
// a btrfs whose volume is mounted from another device.
async function unmountedDrives(drives) {
  const fstab = await readFstab();
  const inFstab = (d) =>
    fstab.some(({ source }) => source === d.path || (d.uuid && source === `UUID=${d.uuid}`) || (d.label && source === `LABEL=${d.label}`));
  const mountedUuids = new Set(drives.filter((d) => d.mountpoints.length && d.uuid).map((d) => d.uuid));
  return drives.filter((d) =>
    MOUNTABLE.test(d.fstype ?? "") && !d.mountpoints.length && !NOT_DATA.test(d.parttypename ?? "") &&
    d.size >= 256 * 1024 ** 2 && !inFstab(d) && !mountedUuids.has(d.uuid)
  );
}

// A drive's name: its label, or its size and file system ("1.7 TB NTFS").
function driveName({ label, size, fstype }) {
  if (label) return label;
  let n = size, unit = 0; // in 1024s, as the tiles' sizes
  while (n >= 1024 && unit < 4) n /= 1024, unit++;
  return `${n.toFixed(n < 10 && unit ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][unit]} ${fstype.replace(/3$/, "").toUpperCase()}`;
}

// Mounting a partition listed as not mounted, under /run/media/<user>: by
// udisks when it lets the user (removable drives: no password); a system
// drive's needs root, which is sudo (sudo.js: a 401 when it wants the
// password) and mount, with what udisks would give: the files the user's on
// NTFS, exFAT and FAT. Gives where it is. An NTFS drive Windows (or Linux)
// didn't close properly is a 409: it can only be mounted `readOnly`.
async function mountDrive({ device, readOnly = false, clearDirty = false }) {
  const drive = (await unmountedDrives(await blockDevices())).find((d) => d.path === device);
  if (!drive) throw httpError(404, "That drive isn't there to mount (mounted already?)");
  // Asked, after the 409 below: its "not closed properly" flag cleared (ntfsfix -d, ntfs-3g's; root),
  // then mounted as usual. It repairs nothing: only Windows' chkdsk checks and repairs NTFS.
  if (clearDirty) {
    if (!/^ntfs/.test(drive.fstype)) throw httpError(400, "Only an NTFS drive has that flag");
    // (A missing program throws as it starts, not in the promise.)
    let ntfsfix = true;
    try {
      await new Deno.Command("ntfsfix", { args: ["--version"], stdin: "null", stdout: "null", stderr: "null" }).output();
    } catch {
      ntfsfix = false;
    }
    if (!ntfsfix) throw httpError(501, "Clearing it needs ntfsfix, from ntfs-3g: sudo pacman -S ntfs-3g (or omarchy pkg add ntfs-3g), then try again.");
    await requireSudo(`Clearing ${driveName(drive)}'s "not closed properly" flag needs root.`);
    const fixed = await sudo(["ntfsfix", "-d", device], { ms: 120_000 });
    if (sudoWanted(fixed.stderr)) await requireSudo(`Clearing ${driveName(drive)}'s "not closed properly" flag needs root.`);
    if (!fixed.ok) throw httpError(500, `ntfsfix couldn't clear it:\n${(fixed.stderr || fixed.stdout).trim()}`);
  }
  let stdout;
  try {
    try {
      ({ stdout } = await udisksctl(["mount", "--no-user-interaction", "-b", device, ...(readOnly ? ["-o", "ro"] : [])]));
    } catch (err) {
      if (!err.notAuthorized) throw err;
      await requireSudo(`Mounting ${driveName(drive)} needs root.`);
      return { path: await sudoMount(drive, readOnly) };
    }
  } catch (err) {
    if (err.status === 401) throw err;
    if (/^ntfs/.test(drive.fstype) && !readOnly && await kernelSaid(new RegExp(`${basename(device)}\\): volume is dirty`))) {
      throw httpError(
        409,
        "It's marked as not closed properly: the computer stopped while it was mounted, or Windows' Fast Startup or hibernation has it. " +
          "Until it's checked, Linux only mounts it read-only. Starting Windows checks it (or chkdsk /f on it there).",
      );
    }
    throw err;
  }
  const path = /\bat (\/.+?)\.?\s*$/.exec(stdout)?.[1] ??
    (await blockDevices()).find((d) => d.path === device)?.mountpoints[0];
  if (!path) throw httpError(500, "Mounted, but couldn't tell where");
  return { path };
}

// Whether the kernel's last messages (a mount's reasons) have one like `pattern`.
async function kernelSaid(pattern) {
  try {
    const out = await new Deno.Command("journalctl", { args: ["-k", "-n", "40", "-o", "cat", "--no-pager"], stdin: "null", stdout: "piped", stderr: "null" }).output();
    return pattern.test(new TextDecoder().decode(out.stdout));
  } catch {
    return false;
  }
}

// sudo mount of `drive` (one udisks won't mount for the user) at
// /run/media/<user>/<its label or UUID>, as udisks would: nosuid, nodev, and on
// file systems without owners (NTFS, exFAT, FAT) the files the user's.
async function sudoMount(drive, readOnly) {
  const user = basename(home());
  const uid = await new Deno.Command("id", { args: ["-u"], stdout: "piped" }).output().then((o) => new TextDecoder().decode(o.stdout).trim());
  const gid = await new Deno.Command("id", { args: ["-g"], stdout: "piped" }).output().then((o) => new TextDecoder().decode(o.stdout).trim());
  let target = join("/run/media", user, (drive.label || drive.uuid || basename(drive.path)).replaceAll("/", "_"));
  for (let n = 2; await Deno.lstat(target).then(() => true, () => false); n++) target = target.replace(/( \d+)?$/, ` ${n}`);
  const type = /^ntfs/.test(drive.fstype) ? "ntfs3" : drive.fstype;
  const options = ["nosuid", "nodev", "relatime", ...(readOnly ? ["ro"] : [])];
  if (type === "ntfs3") options.push(`uid=${uid}`, `gid=${gid}`, "umask=022", "iocharset=utf8", "prealloc");
  else if (/^(exfat|vfat|msdos)$/.test(type)) options.push(`uid=${uid}`, `gid=${gid}`, "umask=022");
  const made = await sudo(["mkdir", "-p", target]);
  if (!made.ok) throw httpError(500, made.stderr.trim() || "couldn't make the mount point");
  const mounted = await sudo(["mount", "-t", type, "-o", options.join(","), drive.path, target]);
  if (!mounted.ok) {
    await sudo(["rmdir", target]);
    throw httpError(500, mounted.stderr.trim().split("\n").at(-1) || "mount failed");
  }
  return target;
}

// Unmounting a drive mounted under /run/media/<user>: by udisks when it lets
// the user (what it mounted for them), otherwise sudo umount (sudo.js: a 401
// when it wants the password), and its mount point goes.
async function unmountDrive({ path }) {
  requirePath(path);
  const drive = (await blockDevices()).find((d) => d.mountpoints.includes(path));
  if (!drive || !path.startsWith("/run/media/")) throw httpError(400, "That isn't a drive phil can unmount");
  try {
    await udisksctl(["unmount", "--no-user-interaction", "-b", drive.path]);
  } catch (err) {
    if (!err.notAuthorized) throw err;
    await requireSudo(`Unmounting ${basename(path)} needs root.`);
    const out = await sudo(["umount", path]);
    if (!out.ok) throw httpError(500, out.stderr.trim().split("\n").at(-1) || "umount failed");
    await sudo(["rmdir", path]);
  }
  return { ok: true };
}

async function udisksctl(args) {
  let out;
  try {
    out = await new Deno.Command("udisksctl", { args, stdin: "null", stdout: "piped", stderr: "piped", signal: AbortSignal.timeout(180_000) }).output();
  } catch (err) {
    throw httpError(500, err instanceof Deno.errors.NotFound ? "Mounting drives needs udisks (udisksctl)" : "udisksctl didn't finish");
  }
  const said = (b) => new TextDecoder().decode(b).trim();
  if (!out.success) {
    // "Error mounting /dev/x: GDBus.Error:org.freedesktop.UDisks2.Error.Failed: <the reason>", after, at
    // times, a line of its own about asking for a password in a terminal (it has none): not the reason.
    const lines = said(out.stderr).split("\n").filter((l) => l.trim());
    const reason = lines.find((l) => /GDBus\.Error/.test(l)) ?? lines.find((l) => !/authentication agent/.test(l)) ?? lines[0] ?? "udisksctl failed";
    const err = httpError(500, reason.replace(/^.*?GDBus\.Error:[\w.]+:\s*/, "").replace(/^Error \w+ \S+:\s*/, ""));
    err.notAuthorized = lines.some((l) => /NotAuthorized/.test(l)); // it'd take a password: root's way (sudo) instead
    throw err;
  }
  return { stdout: said(out.stdout) };
}

const NETWORK_FS = /^(nfs4?|cifs|smb3?|fuse\.sshfs|sshfs|fuse\.rclone|rclone|9p|davfs2?|fuse\.davfs2?|ceph|glusterfs)$/;
const SYSTEM_DIRS = /^\/(boot|efi|usr|var|etc|opt|root|tmp|srv\/tftp|proc|sys|dev|run(?!\/media)|home)(\/|$)|^\/$/;

// Mount point -> icon ("network" or "drive") for /etc/fstab's mounts worth
// a place: network shares anywhere, other file systems outside the system's
// own folders (not /, /home, /boot, swap...).
async function fstabMounts() {
  const out = new Map();
  for (const { target, type } of await readFstab()) {
    if (type === "swap") continue;
    if (NETWORK_FS.test(type)) out.set(target, "network");
    else if (!SYSTEM_DIRS.test(target)) out.set(target, "drive");
  }
  return out;
}

// This machine's name, for telling a shell on it from one ssh'd elsewhere
// (Deno.hostname() would need --allow-sys).
async function hostname() {
  return (await Deno.readTextFile("/etc/hostname").catch(() => "")).trim() || Deno.env.get("HOSTNAME") || "localhost";
}

async function readFstab() {
  let fstab = "";
  try {
    fstab = await Deno.readTextFile("/etc/fstab");
  } catch {
    return [];
  }
  return fstab.split("\n").map((line) => line.replace(/#.*/, "").trim().split(/\s+/))
    .filter(([source, target, type]) => source && target?.startsWith("/") && type)
    .map(([source, target, type]) => ({ source, target: target.replace(/\\040/g, " ").replace(/\/+$/, "") || "/", type }));
}

/**
 * Network mounts that ssh can follow into: { target, host, root }, the local
 * mount point, the machine and the folder there (root "" for one relative to
 * the remote home, as sshfs allows). From /etc/fstab and the mounts in use.
 */
async function networkMounts() {
  const found = new Map();
  const add = (source, type, target) => {
    const m = /^([^/:][^:]*):(.*)$/.exec(source); // host:/path (NFS), [user@]host:path (sshfs)
    if (m && /^(nfs4?|fuse\.sshfs|sshfs)$/.test(type)) found.set(target, { target, host: m[1], root: m[2].replace(/(.)\/+$/, "$1") });
  };
  for (const { source, type, target } of await readFstab()) add(source, type, target);
  try {
    const out = await new Deno.Command("findmnt", { args: ["-rn", "-o", "SOURCE,FSTYPE,TARGET"], stdin: "null", stdout: "piped", stderr: "null" }).output();
    const unescape = (s) => s.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    for (const line of new TextDecoder().decode(out.stdout).split("\n")) {
      const [source, type, target] = line.split(" ").map(unescape);
      if (target) add(source, type, target);
    }
  } catch { /* no findmnt: fstab only */ }
  return [...found.values()];
}

async function isDir(path) {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

// Full-size preview for formats the webview can't decode itself (HEIC, TIFF, ...).
// Permanent delete (Shift+Delete). Folders go recursively; symlinks are
// removed themselves, never what they point to.
// Deleting: a folder with a lot in it (counted first, find) goes with rm -rv,
// whose lines say how far it is: `report` gets {id, op: "delete", dest,
// targets, bytes (entries gone), total, percent} a few times a second, then
// {id, finished}, as copies do; cancelTransfer stops it (what's gone is gone).
// Something small just goes.
const deleting = new Set(); // what deletes under way are deleting

async function deletePaths(paths, { report = () => {}, forget = async () => {} } = {}) {
  const errors = [];
  // Already being deleted (it, or a folder it's in): nothing more to do for it.
  const underWay = (path) => [...deleting].some((d) => path === d || path.startsWith(d + "/"));
  paths = paths.filter((path) => !underWay(path));
  const id = crypto.randomUUID().slice(0, 8);
  const job = { cancelled: false, paused: false, child: null };
  transfers.set(id, job);
  const checked = [];
  for (const path of paths) {
    try {
      requirePath(path);
      if (normalize(path) !== path || path === "/" || path === home()) throw new Error("refusing to delete this path");
      checked.push(path);
    } catch (err) {
      errors.push({ path, error: err.message });
    }
  }
  for (const path of checked) deleting.add(path); // from now: a second delete of it does nothing
  // Everything in them, with sizes and times: how many there are (the progress), and what to forget after.
  // That can take a while on a big folder on a slow drive: meanwhile the pages hear how many so far.
  const started = Date.now();
  const found = checked.map(() => 0);
  const counting = () => {
    if (Date.now() - started < 300) return;
    job.last = { id, started, op: "delete", dest: dirname(checked[0]), targets: checked, items: checked.length, counting: true,
      found: found.reduce((a, b) => a + b, 0), bytes: 0, total: 0, percent: 0 };
    report(job.last);
  };
  const ticker = setInterval(counting, 200);
  let listed;
  try {
    listed = [];
    for (const [i, path] of checked.entries()) {
      listed.push(job.cancelled ? [] : await entriesIn(path, { job, found: (n) => (found[i] = n) }));
    }
  } finally {
    clearInterval(ticker);
  }
  const counts = listed.map((l) => l.length);
  const total = counts.reduce((a, b) => a + b, 0);
  let gone = 0, last = 0;
  const progress = () => {
    if ((Date.now() - started < 300 && !job.last) || Date.now() - last < 250 || !total) return; // a quick one shows nothing
    last = Date.now();
    job.last = { id, started, op: "delete", dest: dirname(checked[0]), targets: checked, items: checked.length, bytes: Math.min(gone, total), total,
      percent: Math.floor((Math.min(gone, total) / total) * 100) };
    report(job.last);
  };
  try {
    for (const [i, path] of checked.entries()) {
      if (job.cancelled) {
        errors.push({ path, error: "cancelled" });
        continue;
      }
      try {
        if (counts[i] < 200) await Deno.remove(path, { recursive: true });
        else await removeCounting(path, job, () => (gone++, progress()));
      } catch (err) {
        errors.push({ path, error: job.cancelled ? "cancelled" : err.message });
      }
      gone = counts.slice(0, i + 1).reduce((a, b) => a + b, 0);
      progress();
    }
  } finally {
    transfers.delete(id);
    for (const path of checked) deleting.delete(path);
    if (job.last) report({ id, dest: dirname(checked[0] ?? "/"), finished: true });
  }
  // What's gone (all of an item deleted; of one stopped or failed, what isn't there any more): its caches go.
  const failed = new Set(errors.map((e) => e.path));
  (async () => {
    const gone = [];
    for (const [i, path] of checked.entries()) {
      if (!failed.has(path)) for (const e of listed[i]) gone.push(e); // (not push(...): a big folder is more arguments than a call takes)
      else {
        const left = new Set((await entriesIn(path)).map((e) => e.path)); // one find, not a stat each
        for (const e of listed[i]) if (!left.has(e.path)) gone.push(e);
      }
    }
    await forget(gone);
  })().catch((err) => console.error(`phil: forgetting what was deleted: ${err.message}`));
  return { errors, cancelled: job.cancelled };
}

// Everything at and under `path` (this file system only): {type (f, d, l...),
// size, ms (modified), path}. Read as find gives them: `found(n)` hears how many
// so far; `job` (cancelTransfer) can stop it.
async function entriesIn(path, { job = null, found = () => {} } = {}) {
  const parse = (line) => {
    const [type, size, time] = line.split(" ", 3);
    const [sec, frac = ""] = time.split(".");
    return { type, size: Number(size), ms: Number(sec) * 1000 + Number(frac.padEnd(3, "0").slice(0, 3)), path: line.slice(type.length + size.length + time.length + 3) };
  };
  try {
    const child = new Deno.Command("find", { args: [path, "-xdev", "-printf", "%y %s %T@ %p\\0"], stdin: "null", stdout: "piped", stderr: "null" }).spawn();
    if (job) job.child = child;
    const entries = [];
    let buffer = "";
    for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
      buffer += chunk;
      const parts = buffer.split("\0");
      buffer = parts.pop();
      for (const line of parts) if (line) entries.push(parse(line));
      found(entries.length);
    }
    await child.status;
    if (job) job.child = null;
    return entries;
  } catch {
    return [{ type: "?", size: 0, ms: 0, path }];
  }
}

// rm -rv, calling `each` for every line it gives (one per file or folder removed).
async function removeCounting(path, job, each) {
  const child = (job.child = new Deno.Command("rm", { args: ["-rv", "--one-file-system", "--", path], stdin: "null", stdout: "piped", stderr: "piped" }).spawn());
  const stderr = new Response(child.stderr).text();
  let buffer = "";
  for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (let n = lines.length; n > 0; n--) each();
  }
  const { success } = await child.status;
  job.child = null;
  if (job.cancelled) throw new Error("cancelled");
  if (!success) throw new Error((await stderr).trim().split("\n").at(-1) || "rm failed");
}

// The + button, Insert, Super+Insert: a new, empty folder ("Folder") or file
// ("File.txt") in `dir`, numbered ("Folder 2", "File 2.txt") when the name is
// taken. Made so it can't take the place of anything already there.
async function create({ dir, kind }) {
  if (kind !== "dir" && kind !== "file") throw httpError(400, "bad kind");
  requirePath(dir);
  if (!(await isDir(dir))) throw httpError(400, "not a folder");
  for (let n = 1; n < 10_000; n++) {
    const name = kind === "dir" ? `Folder${n > 1 ? ` ${n}` : ""}` : `File${n > 1 ? ` ${n}` : ""}.txt`;
    const path = join(dir, name);
    try {
      if (kind === "dir") await Deno.mkdir(path);
      else (await Deno.open(path, { createNew: true, write: true })).close();
      return { path, name };
    } catch (err) {
      if (!(err instanceof Deno.errors.AlreadyExists)) throw httpError(err instanceof Deno.errors.PermissionDenied ? 403 : 500, err.message);
    }
  }
  throw httpError(409, "too many with that name already");
}

// Drag and drop: move or copy items into `dest`. Nothing is ever overwritten:
// a name that already exists in `dest` is reported and skipped, except a copy
// into the item's own folder, which gets a number ("photo 2.jpg"), and a
// stopped copy (its record says it came from this item) being resumed. `made`:
// the paths of what's there now.
//
const SPEED_WINDOW_MS = 5000; // a copy's speed: over this long

// A move within a file system is a rename (mv), and a copy within one that
// clones files (btrfs, xfs) is cp's clone: instant both. Anything else goes
// through rsync, which tells how far it is: `report` gets {id, op, dest,
// targets, items, bytes, total, percent, speed (bytes/s, over the last few
// seconds), eta (seconds, or null), paused} a few times a
// second, then {id, finished}; `track.set(target, record)` keeps the record
// of each item being made (see copyRecords), null when it's done. Resuming
// counts what's there already as done; rsync skips the files that are
// complete. A move through rsync removes each file once it's copied, so
// stopping (cancelTransfer, a crash) leaves everything in one place or the
// other.
const transfers = new Map(); // id -> { cancelled, paused, child }
const liveTargets = new Set(); // what copies under way are making

async function transfer({ op, paths = [], dest, resume = false, target: resumeTarget = null }, { report = () => {}, track = { set() {}, get: async () => null, clearUnder: async () => {} } } = {}) {
  if (op !== "move" && op !== "copy") throw httpError(400, "bad op");
  requirePath(dest);
  if (!(await isDir(dest))) throw httpError(400, "destination is not a folder");
  const errors = [], made = [], moved = []; // moved: what was made from what ({from, to}), for its thumbnails
  const id = crypto.randomUUID().slice(0, 8);
  const job = { cancelled: false, paused: false, child: null };
  transfers.set(id, job);
  const destFs = await fsOf(dest);
  // What goes where, checked first; then the sizes, for the progress.
  const items = [];
  for (const src of paths) {
    try {
      requirePath(src);
      if (normalize(src) !== src || src === "/") throw new Error("invalid path");
      const copyHere = op === "copy" && dirname(src) === dest;
      if (!copyHere && (dest === src || dest.startsWith(src + "/"))) throw new Error("can't put a folder inside itself");
      if (dirname(src) === dest && !copyHere) throw new Error("it's already in that folder");
      // Resuming: the very one that was being made (a copy here had a number: "photo 2").
      const target = resume && resumeTarget && dirname(resumeTarget) === dest ? resumeTarget
        : copyHere ? await freeName(src) : join(dest, basename(src));
      const there = await Deno.lstat(target).then(() => true, () => false);
      // A copy of this very item that was cut off (its record says so): copying it again goes on with it.
      const resuming = there && (await track.get(target))?.from === src;
      if (there && !resuming) throw new Error("an item with that name already exists there");
      if (liveTargets.has(target)) throw new Error("it's being copied there already");
      const sameFs = (await fsOf(dirname(src))).dev === destFs.dev;
      const quick = !resuming && sameFs && (op === "move" || CLONING_FS.test(destFs.type));
      items.push({ src, target, quick, resuming });
    } catch (err) {
      errors.push({ path: src, error: err.message });
    }
  }
  for (const it of items) if (!it.quick) liveTargets.add(it.target);
  // Before it copies anything (sizes, rsync's list of files; on a resume, checking what's
  // there): `preparing` says what it's doing, then progress replaces it.
  if (items.some((it) => !it.quick)) {
    job.last = { id, started: Date.now(), op, dest, targets: items.filter((it) => !it.quick).map((it) => it.target), items: items.length, bytes: 0, total: 0, percent: 0, paused: false, preparing: "Counting" };
    report(job.last);
  }
  // Done already, for a resumed one: what's at the target (a move's source has only what's left).
  const sizes = await Promise.all(items.map(async (it) => {
    if (it.quick) return { total: 0, there: 0 };
    const [left, there] = await Promise.all([apparentSize(it.src), it.resuming ? apparentSize(it.target) : 0]);
    return { total: op === "move" ? left + there : Math.max(left, there), there };
  }));
  const total = sizes.reduce((a, b) => a + b.total, 0);
  // Room for what's left to copy (not a move within the drive: nothing's added): said at
  // once, not after rsync runs into a full disk. (A stopped copy's record stays: ↻ later.)
  const needed = sizes.reduce((a, b, i) => a + (items[i].quick ? 0 : Math.max(0, b.total - b.there)), 0);
  const free = needed ? await availableBytes(dest) : null;
  if (free !== null && needed > free) {
    for (const it of items) liveTargets.delete(it.target);
    transfers.delete(id);
    report({ id, dest, finished: true }); // (its "Counting" row gone)
    throw httpError(507, `${basename(dest) || dest} has ${formatBytes(free)} free; this needs ${formatBytes(needed)} more (free some space, then try again)`);
  }
  // Done: the items finished (doneBefore), what was at the current one's target
  // when its rsync started (base: resumed, or going on after a pause), and what
  // that rsync has copied.
  // rsync counts neither the files it skips (base has them) nor, until it gets
  // there, the part of a cut-off file that's there: then all of it at once
  // (partial; a resumed rsync gets there first: what's before it is done).
  let doneBefore = 0, base = 0, partial = 0, last = 0, lastRecord = 0, lastDone = 0;
  const started = Date.now();
  let current = null;
  const record = (state, done) => current && track.set(current.target, {
    op, from: current.src, state, percent: total ? Math.floor((done / total) * 100) : 0, bytes: done, total, started, updated: Date.now(),
  });
  // The file being copied: its own record (its percentage) once it's taken a few
  // seconds, gone when it's done; marked when the copy stops while it's at it.
  let file = null; // { path, from, since, recorded, percent }
  const fileRecord = (state) => {
    if (!file) return;
    file.recorded = true;
    liveTargets.add(file.path);
    track.set(file.path, { op, from: file.from, state, percent: file.percent ?? 0, file: true, updated: Date.now() });
  };
  const fileEnd = () => {
    if (file?.recorded) track.set(file.path, null);
    if (file) liveTargets.delete(file.path);
    file = null;
  };
  // Its speed: how much it copied over the last few seconds (bytes/s; rsync's own is the file's,
  // as it is that moment), and from it the time left, in seconds.
  let samples = [];
  const speedOf = (done) => {
    const now = Date.now();
    if (job.paused) return (samples = []), { speed: 0, eta: null };
    samples.push([now, done]);
    while (samples.length > 2 && now - samples[1][0] >= SPEED_WINDOW_MS) samples.shift();
    const [t0, d0] = samples[0];
    if (now - t0 < 1000) return { speed: job.last?.speed ?? 0, eta: job.last?.eta ?? null }; // not enough to go by yet
    const speed = Math.round(((done - d0) * 1000) / (now - t0));
    return { speed, eta: speed > 0 ? Math.round((total - done) / speed) : null };
  };
  const progress = (bytes, extra = {}) => {
    // (A file copied on its own is the item: its record is the item's.)
    if (extra.file && extra.file === current?.target) extra.file = undefined;
    if (extra.file && extra.file !== file?.path) fileEnd(), (file = { path: extra.file, from: extra.from, since: Date.now(), recorded: false });
    if (file && extra.filePercent !== undefined) file.percent = extra.filePercent;
    if (extra.fileDone) fileEnd();
    else if (file && Date.now() - file.since > 3000 && Date.now() - (file.written ?? 0) > 3000) {
      file.written = Date.now();
      fileRecord(job.paused ? "paused" : "running");
    }
    const done = (lastDone = Math.min(total, doneBefore + base + Math.max(0, bytes - partial)));
    if (Date.now() - lastRecord > 3000) (lastRecord = Date.now()), record(job.paused ? "paused" : "running", done);
    if (Date.now() - last < 250 || !total) return;
    last = Date.now();
    job.last = { id, started, op, dest, targets: items.filter((it) => !it.quick).map((it) => it.target), items: items.length, bytes: done, total,
      percent: Math.floor((done / total) * 100), paused: job.paused, file: file?.path ?? null, filePercent: file?.percent ?? null,
      ...speedOf(done) };
    report(job.last);
  };
  // Pausing and going on: the pages hear of it at once, and the record says so, as far as it got.
  job.tell = () => ((last = 0), (lastRecord = 0), progress(lastDone - doneBefore - base + partial));
  try {
    for (const [i, it] of items.entries()) {
      const { src, target, quick } = it;
      if (job.cancelled) {
        errors.push({ path: src, error: "cancelled" });
        continue;
      }
      current = it;
      try {
        if (quick) {
          const [cmd, ...args] = op === "move" ? ["mv", "-n", "-T"] : ["cp", "-a", "-n", "-T"];
          const result = await new Deno.Command(cmd, { args: [...args, "--", src, target], stdin: "null", stdout: "null", stderr: "piped" }).output();
          if (!result.success) throw new Error(new TextDecoder().decode(result.stderr).trim().split("\n").at(-1) || `${cmd} failed`);
        } else {
          // Paused: rsync is stopped (its partial file kept), and started again on ▶,
          // over what's there; nothing is left frozen if phil goes away meanwhile.
          for (;;) {
            if (job.paused) await job.resumed; // paused between two
            if (job.cancelled) throw new Error("cancelled");
            base = await apparentSize(target);
            partial = base ? await partialBytes(src, target) : 0;
            record(job.paused ? "paused" : "running", doneBefore + base);
            last = 0; // (its first progress line goes out at once, replacing this)
            job.last = { ...job.last, started, total, bytes: doneBefore + base, percent: total ? Math.floor(((doneBefore + base) / total) * 100) : 0, paused: job.paused, file: null, preparing: base ? "Comparing with what's there" : "Listing files" };
            report(job.last);
            try {
              await rsync(src, target, { move: op === "move", posix: !NON_POSIX_FS.test(destFs.type), job, progress });
              break;
            } catch (err) {
              if (!job.paused || job.cancelled) throw err;
              fileRecord("paused"); // the file it stopped in: how far
              lastRecord = 0;
              progress(lastDone - doneBefore - base + partial); // "paused", as far as it got
              await job.resumed;
              if (job.cancelled) throw new Error("cancelled");
            }
          }
          fileEnd();
          await track.set(target, null); // done: no record
          await track.clearUnder(target);
        }
        made.push(target);
        moved.push({ from: src, to: target });
      } catch (err) {
        if (!quick) { // cancelled or failed: it can be resumed; the file it was at is marked
          record("stopped", lastDone);
          if (file) fileRecord("stopped"), liveTargets.delete(file.path), (file = null);
        }
        errors.push({ path: src, error: job.cancelled ? "cancelled" : err.message });
      }
      doneBefore += sizes[i].total;
      base = partial = 0;
    }
  } finally {
    transfers.delete(id);
    for (const it of items) liveTargets.delete(it.target);
    report({ id, dest, finished: true });
  }
  return { errors, made, moved, cancelled: job.cancelled };
}

function cancelTransfer(id) {
  const job = transfers.get(id);
  if (!job) return false;
  job.cancelled = true;
  job.resume?.(); // paused: it ends now
  try {
    job.child?.kill("SIGTERM"); // rsync removes the file it was writing
  } catch { /* finished meanwhile */ }
  return true;
}

// Pausing stops rsync (the file it was writing stays, cut off); going on starts it again, appending, over
// what's there. Not SIGSTOP: a frozen rsync couldn't be stopped if phil went away meanwhile.
function pauseTransfer(id, pause) {
  const job = transfers.get(id);
  if (!job || job.paused === pause) return job?.paused ?? false;
  job.paused = pause;
  if (pause) {
    job.resumed = new Promise((resolve) => (job.resume = resolve));
    try {
      job.child?.kill("SIGTERM");
    } catch { /* between files */ }
  } else {
    job.resume?.();
  }
  job.tell?.(); // the pages hear of it now
  return pause;
}

const hasSetpriv = new Deno.Command("setpriv", { args: ["--version"], stdin: "null", stdout: "null", stderr: "null" }).output().then((o) => o.success, () => false);

// Whether `path` is on a drive plugged in by USB (its block device's place in
// /sys is under a USB controller), remembered by file system.
const usbByDev = new Map();
async function onUsb(path) {
  const dev = await Deno.stat(path).then((s) => s.dev, () => null);
  if (dev === null) return false;
  if (usbByDev.has(dev)) return usbByDev.get(dev);
  let usb = false;
  try {
    const out = await new Deno.Command("findmnt", { args: ["-no", "SOURCE", "-T", path], stdin: "null", stdout: "piped", stderr: "null" }).output();
    const source = new TextDecoder().decode(out.stdout).trim().replace(/\[.*\]$/, ""); // (btrfs: its subvolume, after)
    if (source.startsWith("/dev/")) { // lsblk -s: it and what it's on (a partition, its disk; LUKS too), with how they're connected
      const tran = await new Deno.Command("lsblk", { args: ["-sno", "TRAN", "--", source], stdin: "null", stdout: "piped", stderr: "null" }).output();
      usb = new TextDecoder().decode(tran.stdout).split("\n").some((t) => t.trim() === "usb");
    }
  } catch { /* not a block device's */ }
  usbByDev.set(dev, usb);
  return usb;
}

const CLONING_FS = /^(btrfs|xfs|bcachefs)$/; // cp clones files there: a copy is instant
const NON_POSIX_FS = /^(msdos|vfat|exfat|fuseblk|ntfs3?)$/; // no owners or permissions to keep

// The file system `path` is on: { dev, type } (stat -f's type name).
async function fsOf(path) {
  const info = await Deno.stat(path);
  const out = await new Deno.Command("stat", { args: ["-f", "-c", "%T", "--", path], stdin: "null", stdout: "piped", stderr: "null" }).output();
  return { dev: info.dev, type: new TextDecoder().decode(out.stdout).trim() };
}

// The bytes in `path`, everything under it (du -sb), 0 if that fails.
async function apparentSize(path) {
  try {
    const out = await new Deno.Command("du", { args: ["-sb", "--", path], stdin: "null", stdout: "piped", stderr: "null" }).output();
    return parseInt(new TextDecoder().decode(out.stdout)) || 0;
  } catch {
    return 0;
  }
}

// What's at `target` in files shorter than their `src` (cut off mid-copy): bytes.
async function partialBytes(src, target) {
  let sum = 0;
  const walk = async (s, t) => {
    const [a, b] = await Promise.all([Deno.lstat(s).catch(() => null), Deno.lstat(t).catch(() => null)]);
    if (!a || !b) return;
    if (a.isDirectory && b.isDirectory) {
      for await (const e of Deno.readDir(t)) await walk(join(s, e.name), join(t, e.name));
    } else if (a.isFile && b.isFile && b.size < a.size) sum += b.size;
  };
  await walk(src, target).catch(() => {});
  return sum;
}

// rsync of one item (a file, or a folder and all in it) to `target`, telling
// `progress(bytes, {file, from, filePercent, fileDone})` how far it
// is: in all, and in the file it's at (rsync's per-file progress; the total is
// added up here). Files written straight to
// their names (--inplace: a cut-off one is there to go on with, after a crash
// too); a file there and shorter is appended to, then checked whole against
// the source (--append-verify: copied again if they differ); finished ones are
// skipped (same size and time). A move removes each file once it's copied, and
// the emptied folders at the end.
// A folder's drive's free space in bytes (df), or null when it can't be told.
async function availableBytes(dir) {
  try {
    const out = await new Deno.Command("df", { args: ["--output=avail", "-B1", "--", dir], stdin: "null", stdout: "piped", stderr: "null" }).output();
    const n = Number(new TextDecoder().decode(out.stdout).trim().split("\n").at(-1));
    return out.success && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

const formatBytes = (n) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) (n /= 1000), i++;
  return `${i && n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
};

// What went wrong, from rsync's errors: the line that says why (a full disk, no
// permission...), not its last ("write error: Broken pipe": the other side, which had stopped).
function rsyncError(stderr) {
  const lines = stderr.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const why = /No space left on device|Disk quota exceeded|Permission denied|Read-only file system|File name too long|Invalid argument|Input\/output error|File too large|No such file or directory/i;
  const line = lines.find((l) => why.test(l)) ?? lines.find((l) => /^rsync(: \[receiver\]|:).*(error|failed)/i.test(l) && !/Broken pipe/i.test(l)) ?? lines.at(-1);
  return line || "rsync failed";
}

async function rsync(src, target, { move, posix, job, progress }) {
  const folder = (await Deno.lstat(src)).isDirectory;
  const args = [posix ? "-a" : "-rlt", "--info=name1,progress1", "--8-bit-output", "--no-inc-recursive", "--inplace", "--append-verify", "--outbuf=L",
    ...(move ? ["--remove-source-files"] : []), "--", folder ? src + "/" : src, target];
  // It stops with phil (closed, crashed, updated): the copy's record says so, and ↻ goes on. Not
  // left running unseen. setpriv execs rsync, so the pid is rsync's (pausing signals it and its helpers).
  const [cmd, ...pre] = (await hasSetpriv) ? ["setpriv", "--pdeathsig", "TERM", "--", "rsync"] : ["rsync"];
  const child = (job.child = new Deno.Command(cmd, { args: [...pre, ...args], stdin: "null", stdout: "piped", stderr: "piped" }).spawn());
  const stderr = new Response(child.stderr).text();
  // A file's name (as it's in the folder; a file of its own: its name), then its progress lines.
  const where = (name) => (folder ? { file: join(target, name), from: join(src, name) } : { file: target, from: src });
  let buffer = "", current = null, bytes = 0, done = 0;
  for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    const lines = buffer.split(/[\r\n]/);
    buffer = lines.pop();
    for (const line of lines) {
      // "  1,234,567  45%   12.34MB/s    0:00:05 (xfr#3, to-chk=10/20)": the file's; xfr#: it's done
      const m = /^\s*([\d,]+)\s+(\d+)%\s+(\S+)\s+(\d+:\d+:\d+)(.*xfr#)?/.exec(line);
      if (m) {
        bytes = Number(m[1].replaceAll(",", ""));
        progress(done + bytes, { ...(current && where(current)), filePercent: Number(m[2]), fileDone: !!m[5] });
        if (m[5]) (done += bytes), (bytes = 0), (current = null);
      } else if (line.trim() && !line.endsWith("/")) {
        if (current) done += bytes; // a file with no last line (skipped as it was)
        current = line;
        bytes = 0;
      }
    }
  }
  const { success } = await child.status;
  job.child = null;
  if (job.cancelled) throw new Error("cancelled");
  if (!success) throw new Error(rsyncError(await stderr));
  if (move) {
    if (folder) await new Deno.Command("find", { args: [src, "-depth", "-type", "d", "-empty", "-delete"], stdin: "null", stdout: "null", stderr: "null" }).output();
    if (await Deno.lstat(src).then(() => true, () => false)) throw new Error("copied, but some of it couldn't be removed from where it was");
  }
}

// A name for a copy of `path` beside it: the next number after the name, before
// the extension ("photo.jpg" → "photo 2.jpg"; "photo 2.jpg" → "photo 3.jpg").
async function freeName(path) {
  const name = basename(path);
  const isFolder = await isDir(path) && !(await Deno.lstat(path)).isSymlink;
  const dot = isFolder ? -1 : name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  const [, base, number] = stem.match(/^(.*?) (\d+)$/) ?? [, stem, "1"];
  for (let n = Number(number) + 1; ; n++) {
    const target = join(dirname(path), `${base} ${n}${ext}`);
    if (!(await Deno.lstat(target).then(() => true, () => false))) return target;
  }
}

function openExternal({ path, url, app }, incognito) {
  // A web page's or mail address's (a link in the terminal: vu's): the browser's, the mail app's.
  if (url !== undefined) {
    if (!/^(https?|mailto):/i.test(url)) throw httpError(400, "a web or mail link");
    path = url;
  } else requirePath(path);
  // (Incognito: mpv doesn't remember where it was either.)
  const mpv = ["mpv", ...(incognito ? ["--save-position-on-quit=no", "--no-resume-playback"] : []), "--", path];
  const [cmd, ...args] = app === "mpv" ? mpv : ["xdg-open", path];
  const child = new Deno.Command(cmd, { args, stdin: "null", stdout: "null", stderr: "null" }).spawn();
  child.unref();
  child.status.catch(() => {});
  return json({ ok: true });
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
