// phil's server: folder listings, files with Range, thumbnails, the terminal
// panel's shells. Runs in the engine's server worker (engine/server.js).
import { basename, dirname, join, normalize } from "@std/path";
import { httpError, json, serveFile, text } from "../../engine/http.js";
import { Pty } from "../../engine/pty.js";
import { FolderSummaries, makeSummary } from "./folders.js";
import { Hooks, metadataFile, runHook } from "./hooks.js";
import { home, serverConfig } from "./launch.js";
import { canWrite, folderSize, me, properties } from "./properties.js";
import { isTextFile, textHead, textPreview } from "./texthead.js";
import { mediaKind, Thumbnailer } from "./thumbs.js";

export const UI_DIR = new URL("./ui/", import.meta.url);
const DEFAULT_THEME = "overlay"; // see the themes in ui/style.css

export function createServer({ profile, controlSocket }) {
  const config = serverConfig(profile);
  const thumbs = new Thumbnailer(config);
  // Incognito leaves no traces, so its folder summaries last for the session only.
  const sockets = new Set(); // every page's WebSocket, for {theme}
  const terminals = new Map(); // terminal panel id (PHIL_TERMINAL) -> its WebSocket
  const folders = new FolderSummaries(config.incognito ? null : join(thumbs.dir, "folders"));
  const shown = new Map(); // page WebSocket -> the folder it shows
  // A hook ran: the windows showing its folder say so.
  const hooks = new Hooks(metadataFile(config.settingsFile), {
    persist: !config.incognito,
    onRun(run) {
      for (const [socket, dir] of shown) if (dir === dirname(run.path) && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ hook: run }));
    },
  });
  console.log(`phil: thumbnails in ${config.thumbDir}`);

  async function handle(req, url) {
    const path = url.searchParams.get("path");
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /api/places": // again, when the window gets focus: drives come and go
        return json({ places: await places(), mounts: await networkMounts() });
      case "GET /api/init":
        return json({
          start: (await lastDir()) ?? config.startDir, // windows asked for a folder get it in the URL
          home: home(),
          places: await places(),
          mounts: await networkMounts(),
          hostname: await hostname(),
          incognito: config.incognito,
          thumbDir: config.thumbsInMemory ? "in memory" : config.thumbDir,
          thumbSize: thumbs.name,
          settings: await readSettings(),
        });
      case "GET /api/list": {
        const listing = await listDir(requirePath(path), url.searchParams.get("sort") ?? "name");
        rememberDir(listing.path);
        return json(listing);
      }
      case "GET /file":
      case "HEAD /file":
        return serveFile(req, requirePath(path), { "content-security-policy": "sandbox" });
      case "GET /api/is-text": // opening a file: in the text editor?
        return json({ text: await isTextFile(requirePath(path)) });
      case "GET /preview":
        return preview(requirePath(path), url.searchParams.get("size") ?? "2560");
      case "POST /api/open":
        return openExternal(await req.json());
      case "POST /api/delete": {
        const paths = (await req.json()).paths ?? [];
        const result = await deletePaths(paths);
        await movedHooks(paths, result, () => null);
        return json(result);
      }
      case "POST /api/transfer": {
        const body = await req.json();
        const result = await transfer(body);
        if (body.op === "move") await movedHooks(body.paths ?? [], result, (p) => join(body.dest, basename(p)));
        return json(result);
      }
      case "POST /api/rename": {
        const body = await req.json();
        const result = await rename(body);
        await hooks.moved(body.path, result.path);
        return json(result);
      }
      case "GET /api/properties":
        return json({ ...await properties(requirePath(path)), meta: await hooks.get(path) });
      case "GET /api/folder-size":
        return json(await folderSize(requirePath(path)));
      case "PUT /api/meta": { // {path, description, onChange}: Properties' phil section
        const { path, ...changes } = await req.json();
        const clean = (key) => key in changes ? { [key]: String(changes[key] ?? "").trim() } : {};
        await hooks.set(requirePath(path), { ...clean("description"), ...clean("onChange") });
        return json({ ok: true });
      }
      case "POST /api/run-hook": { // Properties' "Run now"
        const { path, command } = await req.json();
        return json(await runHook(requirePath(path), String(command ?? "")));
      }
      case "POST /api/add-to-config":
        return json(await addToConfig(requirePath((await req.json()).path)));
      case "PUT /api/settings":
        if (!config.incognito) await writeSettings(await req.json()); // incognito: this session only
        return json({ ok: true });
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
    for (const e of entries) {
      if (meta[e.path]?.onChange) e.onChange = meta[e.path].onChange;
      if (meta[e.path]?.description) e.description = meta[e.path].description;
    }
    // While we're here, this folder's own summary, from thumbnails already cached.
    const previewOf = (e) => (e.kind === "file" ? textPreviewOf(e) : typeof e.thumb === "string" ? { url: e.thumb } : e.thumb ?? null);
    makeSummary({ entries, mtime, sort, previewOf })
      .then((summary) => folders.save(dir, summary))
      .catch((err) => console.error(`phil: can't save folder summary: ${err.message}`));
    return { path: dir, parent: dir === "/" ? null : dirname(dir), entries };
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
    return await mapLimit(dirents, 64, async (d) => {
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
      if (stat && (kind === "image" || kind === "video" || kind === "pdf")) entry.thumb = await thumbs.lookup(path, stat);
      if (kind === "dir") entry.summary = await folders.get(path);
      return entry;
    });
  }

  // A text file's preview for its folder's tile, or false if it isn't text.
  const textPreviewOf = (e) => textPreview(e.path).then((text) => text && { text }, () => false);

  // A folder tile came into view without an up-to-date summary: read the folder
  // and make previews of its first files in the view's sort order.
  async function summarize(path, sort, signal) {
    const mtime = (await Deno.stat(path)).mtime?.getTime() ?? 0;
    const entries = await readEntries(path, { lookups: false });
    signal.throwIfAborted();
    const summary = await makeSummary({
      entries,
      mtime,
      sort,
      async previewOf(e) {
        if (e.kind === "file") return await textPreviewOf(e);
        try {
          return { url: await thumbs.get(e.path, signal) };
        } catch (err) {
          if (signal.aborted) throw err;
          return false; // can't be thumbnailed: skipped, not retried
        }
      },
    });
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
    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.watch) {
        watching = watching.then(async () => (watcher = await watchFolder(msg.watch, watcher, send))).catch(() => {});
        if (shown.get(socket) !== msg.watch) {
          hookWatch?.close();
          hookWatch = hooks.watch(msg.watch);
          shown.set(socket, msg.watch);
        }
      }
      for (const path of msg.cancel ?? []) pending.get(path)?.abort();
      for (const path of msg.want ?? []) {
        if (pending.has(path)) continue;
        if (mediaKind(path) === "file") { // other files: the start of their text, if they're text
          textHead(path).then((text) => send({ path, text }), () => send({ path, text: null }));
          continue;
        }
        const ctrl = new AbortController();
        pending.set(path, ctrl);
        thumbs.get(path, ctrl.signal)
          .then((url) => send({ path, url }))
          .catch((err) => {
            if (ctrl.signal.aborted) return;
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
    socket.onclose = () => {
      sockets.delete(socket);
      shown.delete(socket);
      hookWatch?.close();
      pending.forEach((c) => c.abort());
      watching.then(() => watcher?.close());
    };
    const send = (msg) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(msg));
    return response;
  }

  // Watches the folder a page shows and its subfolders (not deeper), and sends
  // {changed: dir, folders: [subfolders]} at most twice a second: `dir` itself
  // when something in it was added, removed or modified, `folders` for those
  // whose contents changed. Whatever made the change: phil, the terminal or
  // another program. Returns the watcher, or reuses `old` when it already
  // watches the same folders (the page asks again after every refresh, so
  // new subfolders get watched).
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
    let changed = false, timer = null;
    const folders = new Set();
    const flush = () => {
      timer = null;
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
        if ((changed || folders.size) && !timer) timer = setTimeout(flush, 500);
      }
    })().catch(() => {});
    return { key, close: () => (clearTimeout(timer), fsWatcher.close()) };
  }

  // Terminal panel: one bash on a pseudo-terminal per WebSocket. Binary frames
  // carry terminal data both ways; text frames carry {resize: [cols, rows]} or
  // {cd: path}, which changes the shell's directory without typing a command
  // (see __phil_follow in shell-init.bash).
  async function terminalSocket(req, url) {
    if (req.headers.get("upgrade") !== "websocket") return text(400, "Bad request");
    const cwd = await isDir(url.searchParams.get("cwd") ?? "") ? url.searchParams.get("cwd") : home();
    const size = (name, fallback) => Math.max(1, Number(url.searchParams.get(name)) || fallback);
    const cdFile = join(Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp", `phil-cd-${crypto.randomUUID()}`);
    // PHIL_TERMINAL and PHIL_ENGINE_SOCKET: so phil-editor run in this shell
    // can have its editor shown in this window (see control()).
    const terminal = crypto.randomUUID();
    const pty = new Pty(["bash", "--rcfile", await shellInit, "-i"], {
      cwd,
      cols: size("cols", 80),
      rows: size("rows", 24),
      env: {
        PHIL_CD_FILE: cdFile,
        PHIL_TERMINAL: terminal,
        ...(controlSocket ? { PHIL_ENGINE_SOCKET: controlSocket } : {}),
        ...(config.incognito ? { PHIL_INCOGNITO: "1" } : {}),
      },
    });
    const { socket, response } = Deno.upgradeWebSocket(req);
    terminals.set(terminal, socket);
    socket.binaryType = "arraybuffer";
    socket.onopen = async () => {
      for await (const chunk of pty.output()) {
        if (socket.readyState !== WebSocket.OPEN) break;
        socket.send(chunk);
      }
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, "shell exited");
    };
    // Handled strictly in order, so keystrokes sent right after a {cd} can't
    // overtake its key sequence + Enter and end up executed as a command.
    let queue = Promise.resolve();
    socket.onmessage = (e) => {
      queue = queue.then(async () => {
        if (typeof e.data !== "string") return pty.write(new Uint8Array(e.data));
        const { resize, cd, host } = JSON.parse(e.data);
        if (resize) pty.resize(resize[0], resize[1]);
        if (cd && host) {
          // The shell is ssh'd in (phil's ssh, shell-init.bash): leave the
          // target in its cd file over the session's own connection, then the
          // empty Enter, as below.
          const shq = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
          const write = `printf '%s\\000%s\\000' "$(date +%s)" ${shq(cd)} > /tmp/phil-cd-${terminal}`;
          const socketPath = join(Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp", `phil-ssh-${terminal}`);
          const done = await new Deno.Command("ssh", {
            args: ["-S", socketPath, "-o", "ControlMaster=no", "-o", "BatchMode=yes", host, write],
            stdin: "null", stdout: "null", stderr: "null",
          }).output().catch(() => ({ success: false }));
          if (done.success) await pty.write("\r");
        } else if (cd && await isDir(cd)) {
          await Deno.writeTextFile(cdFile, `${Math.floor(Date.now() / 1000)}\0${cd}\0`);
          await pty.write("\r");
        }
      }).catch(() => {});
    };
    socket.onclose = () => {
      terminals.delete(terminal);
      pty.close();
      Deno.remove(cdFile).catch(() => {});
    };
    return response;
  }

  // F2: renames in place. Never overwrites: a name that's taken is an error.
  // The metadata of what was deleted or moved (the paths without an error) follows it.
  async function movedHooks(paths, { errors = [] }, to) {
    const failed = new Set(errors.map((e) => e.path));
    for (const path of paths) if (!failed.has(path)) await hooks.moved(path, to(path)).catch(() => {});
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

  // The theme is chosen by editing the settings file, never by the page: the
  // page's settings are saved around it. It's written out even when unset, so
  // the file shows where it goes.
  async function writeSettings(settings) {
    const { theme = DEFAULT_THEME } = await readSettings();
    delete settings.theme;
    await Deno.mkdir(dirname(config.settingsFile), { recursive: true });
    const tmp = `${config.settingsFile}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify({ theme, ...settings }, null, 2) + "\n");
    await Deno.rename(tmp, config.settingsFile); // atomic, for the watcher and other phils
  }

  // Editing the theme in the settings file restyles open windows right away.
  async function watchTheme() {
    let theme = (await readSettings()).theme;
    let timer;
    for await (const event of Deno.watchFs(dirname(config.settingsFile), { recursive: false })) {
      if (!event.paths.includes(config.settingsFile)) continue;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        let next;
        try {
          next = JSON.parse(await Deno.readTextFile(config.settingsFile)).theme;
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
  function control({ embed }) {
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

async function places() {
  const h = home();
  const dirs = await userDirs();
  const candidates = [
    ["Home", h, "home"],
    ...[
      ["Desktop", "DESKTOP", "folder"],
      ["Documents", "DOCUMENTS", "folder"],
      ["Downloads", "DOWNLOAD", "download"],
      ["Pictures", "PICTURES", "image"],
      ["Videos", "VIDEOS", "video"],
      ["Music", "MUSIC", "music"],
    ].map(([name, key, icon]) => [name, (dirs[key] ?? join(h, name)).replace(/\/$/, ""), icon]),
  ];
  const out = [];
  const seen = new Set();
  for (const [name, path, icon] of candidates) {
    if (seen.has(path) || (path === h && name !== "Home")) continue;
    if (await isDir(path)) out.push({ name, path, icon }), seen.add(path);
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
  for (const base of [`/run/media/${basename(h)}`, "/mnt"]) {
    try {
      for await (const d of Deno.readDir(base)) {
        if (d.isDirectory) add(join(base, d.name), mounts.get(join(base, d.name)) ?? "drive");
      }
    } catch { /* not present */ }
  }
  for (const [path, icon] of mounts) add(path, icon);
  out.push({ name: "Filesystem", path: "/", icon: "drive" });
  return out;
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
async function preview(path, size) {
  if (!/^\d{2,5}$/.test(size)) return text(400, "Bad size");
  const child = new Deno.Command("vips", {
    args: ["thumbnail", path, ".jpg[Q=88]", size, "--size", "down"],
    stdin: "null", stdout: "piped", stderr: "null",
  }).spawn();
  const out = await child.output();
  if (!out.success) return text(415, "Can't decode image");
  return new Response(out.stdout, { headers: { "content-type": "image/jpeg", "cache-control": "no-cache" } });
}

// Permanent delete (Shift+Delete). Folders go recursively; symlinks are
// removed themselves, never what they point to.
async function deletePaths(paths) {
  const errors = [];
  for (const path of paths) {
    try {
      requirePath(path);
      if (normalize(path) !== path || path === "/" || path === home()) {
        throw new Error("refusing to delete this path");
      }
      await Deno.remove(path, { recursive: true });
    } catch (err) {
      errors.push({ path, error: err.message });
    }
  }
  return { errors };
}

// Drag and drop: move or copy items into `dest`. mv/cp handle folders,
// symlinks (copied as links) and moves across filesystems. Nothing is ever
// overwritten: a name that already exists in `dest` is reported and skipped.
async function transfer({ op, paths = [], dest }) {
  if (op !== "move" && op !== "copy") throw httpError(400, "bad op");
  requirePath(dest);
  if (!(await isDir(dest))) throw httpError(400, "destination is not a folder");
  const errors = [];
  for (const src of paths) {
    try {
      requirePath(src);
      if (normalize(src) !== src || src === "/") throw new Error("invalid path");
      if (dest === src || dest.startsWith(src + "/")) throw new Error("can't put a folder inside itself");
      if (dirname(src) === dest) throw new Error("it's already in that folder");
      const target = join(dest, basename(src));
      if (await Deno.lstat(target).then(() => true, () => false)) throw new Error("an item with that name already exists there");
      const [cmd, ...args] = op === "move" ? ["mv", "-n", "-T"] : ["cp", "-a", "-n", "-T"];
      const result = await new Deno.Command(cmd, { args: [...args, "--", src, target], stdin: "null", stdout: "null", stderr: "piped" }).output();
      if (!result.success) {
        throw new Error(new TextDecoder().decode(result.stderr).trim().split("\n").at(-1) || `${cmd} failed`);
      }
    } catch (err) {
      errors.push({ path: src, error: err.message });
    }
  }
  return { errors };
}

function openExternal({ path, app }) {
  requirePath(path);
  const [cmd, ...args] = app === "mpv" ? ["mpv", "--", path] : ["xdg-open", path];
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
