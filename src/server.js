// Local HTTP server for the UI. Runs in a worker; posts { url } once listening.
import { basename, dirname, extname, join, normalize } from "@std/path";
import { home } from "./config.js";
import { FolderSummaries, makeSummary } from "./folders.js";
import { listen } from "./instance.js";
import { Pty } from "./pty.js";
import { mediaKind, Thumbnailer } from "./thumbs.js";

const UI_DIR = new URL("../ui/", import.meta.url);
const DEFAULT_THEME = "overlay"; // see the themes in ui/style.css

const CONTENT_TYPES = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml", txt: "text/plain; charset=utf-8", json: "application/json",
  jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", jfif: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", avif: "image/avif", heic: "image/heic", heif: "image/heif",
  jxl: "image/jxl", tif: "image/tiff", tiff: "image/tiff", bmp: "image/bmp", ico: "image/x-icon",
  mp4: "video/mp4", m4v: "video/mp4", mkv: "video/x-matroska", webm: "video/webm", mov: "video/quicktime",
  avi: "video/x-msvideo", wmv: "video/x-ms-wmv", flv: "video/x-flv", mpg: "video/mpeg", mpeg: "video/mpeg",
  m2ts: "video/mp2t", mts: "video/mp2t", ts: "video/mp2t", "3gp": "video/3gpp", ogv: "video/ogg",
};
const contentType = (path) => CONTENT_TYPES[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream";

self.onmessage = (e) => start(e.data);

function start(config) {
  const token = crypto.randomUUID();
  const thumbs = new Thumbnailer(config);
  // Incognito leaves no traces, so its folder summaries last for the session only.
  const sockets = new Set(); // every page's WebSocket, for {theme}
  const folders = new FolderSummaries(thumbs.dir && !config.incognito ? join(thumbs.dir, "folders") : null);
  let host, cookie;

  // Tell the main thread we're up, after taking over the instance's control
  // socket (if any): its requests go to the GTK main loop through wakeFd.
  async function announce(url) {
    let control = "none";
    if (config.controlSocket) {
      const libc = Deno.dlopen("libc.so.6", { write: { parameters: ["i32", "buffer", "usize"], result: "isize" } });
      const forward = (message) => {
        const line = new TextEncoder().encode(JSON.stringify(message) + "\n");
        libc.symbols.write(config.wakeFd, line, line.length);
      };
      const listening = await listen(config.controlSocket, async (message, { stopListening }) => {
        if (message.retire) await stopListening();
        forward(message);
        return { ok: true };
      });
      control = listening ? "listening" : "in-use";
    }
    self.postMessage({ url, control });
  }

  Deno.serve({
    hostname: "127.0.0.1",
    port: config.port,
    onListen({ port }) {
      host = `127.0.0.1:${port}`;
      cookie = `phil-${port}`; // per port, so two phils never overwrite each other's session
      announce(`http://${host}/?token=${token}`);
    },
  }, async (req) => {
    try {
      return await handle(req);
    } catch (err) {
      return errorResponse(err);
    }
  });

  async function handle(req) {
    const url = new URL(req.url);
    // Only answer requests addressed to us (blocks DNS rebinding) that carry the session cookie.
    if (req.headers.get("host") !== host) return text(403, "Forbidden");
    if (url.searchParams.get("token") === token) {
      url.searchParams.delete("token"); // keep the rest (?select=...); the #folder carries over by itself
      return new Response(null, {
        status: 303,
        headers: { location: "/" + url.search, "set-cookie": `${cookie}=${token}; HttpOnly; SameSite=Strict; Path=/` },
      });
    }
    const cookies = (req.headers.get("cookie") ?? "").split(/;\s*/);
    if (!cookies.includes(`${cookie}=${token}`)) return text(403, "Forbidden: open the URL printed by phil");

    const path = url.searchParams.get("path");
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /":
        return staticFile("index.html");
      case "GET /api/init":
        return json({
          start: (await lastDir()) ?? config.startDir, // windows asked for a folder get it in the URL
          home: home(),
          places: await places(),
          incognito: config.incognito,
          thumbDir: config.thumbDir ?? "a .thumbnails folder in each folder",
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
      case "GET /preview":
        return preview(requirePath(path), url.searchParams.get("size") ?? "2560");
      case "POST /api/quit": // the close button in --browser mode (the window closes itself natively)
        self.postMessage({ quit: true });
        return json({ ok: true });
      case "POST /api/open":
        return openExternal(await req.json());
      case "POST /api/delete":
        return json(await deletePaths((await req.json()).paths ?? []));
      case "POST /api/transfer":
        return json(await transfer(await req.json()));
      case "POST /api/rename":
        return json(await rename(await req.json()));
      case "PUT /api/settings":
        if (!config.incognito) await writeSettings(await req.json()); // incognito: this session only
        return json({ ok: true });
      case "GET /ws":
        return thumbSocket(req);
      case "GET /term":
        return terminalSocket(req, url);
    }
    if (req.method === "GET" && url.pathname.startsWith("/ui/")) return staticFile(url.pathname.slice(4));
    const thumb = /^\/thumbs\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && thumb && thumb[1] === thumbs.name) {
      const file = thumbs.fileFor(thumb[2], url.searchParams.get("dir"));
      if (file) return serveFile(req, file, { "cache-control": "private, max-age=31536000, immutable" });
    }
    return text(404, "Not found");
  }

  async function listDir(dir, sort) {
    const mtime = (await Deno.stat(dir)).mtime?.getTime() ?? 0; // before reading: a change while listing is caught next time
    const entries = await readEntries(dir);
    // While we're here, this folder's own summary, from thumbnails already cached.
    makeSummary({ entries, mtime, sort, thumbOf: (e) => e.thumb ?? null })
      .then((summary) => folders.save(dir, summary))
      .catch((err) => console.error(`phil: can't save folder summary: ${err.message}`));
    return { path: dir, parent: dir === "/" ? null : dirname(dir), entries };
  }

  // The folder's entries with size and date; with `lookups`, also each media
  // file's cached thumbnail and each subfolder's saved summary.
  async function readEntries(dir, { lookups = true } = {}) {
    const dirents = [];
    for await (const d of Deno.readDir(dir)) dirents.push(d);
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
      if (stat && (kind === "image" || kind === "video")) entry.thumb = await thumbs.lookup(path, stat);
      if (kind === "dir") entry.summary = await folders.get(path);
      return entry;
    });
  }

  // A folder tile came into view without an up-to-date summary: read the folder
  // and make thumbnails for its first images/videos in the view's sort order.
  async function summarize(path, sort, signal) {
    const mtime = (await Deno.stat(path)).mtime?.getTime() ?? 0;
    const entries = await readEntries(path, { lookups: false });
    signal.throwIfAborted();
    const summary = await makeSummary({
      entries,
      mtime,
      sort,
      thumbOf: (e) =>
        thumbs.get(e.path, signal).catch((err) => {
          if (signal.aborted) throw err;
          return false; // can't be thumbnailed: skipped, not retried
        }),
    });
    await folders.save(path, summary);
    return summary;
  }

  // One WebSocket per page. The page sends {want: [paths]} for tiles entering the
  // viewport, {folders: [paths], sort} for folder tiles that need a summary,
  // {cancel: [paths]} for tiles that scrolled away before loading, and
  // {watch: path} for the folder it shows. Unlike <img> requests this isn't
  // capped at ~6 connections per host. The server sends the answers, {changed}
  // (see watchFolder), and {theme} when the theme in the settings file changes.
  function thumbSocket(req) {
    if (req.headers.get("upgrade") !== "websocket" || req.headers.get("origin") !== `http://${host}`) {
      return text(400, "Bad request");
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    const pending = new Map();
    let watcher = null, watching = Promise.resolve(); // one watch request at a time
    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.watch) {
        watching = watching.then(async () => (watcher = await watchFolder(msg.watch, watcher, send))).catch(() => {});
      }
      for (const path of msg.cancel ?? []) pending.get(path)?.abort();
      for (const path of msg.want ?? []) {
        if (pending.has(path)) continue;
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
    if (req.headers.get("upgrade") !== "websocket" || req.headers.get("origin") !== `http://${host}`) {
      return text(400, "Bad request");
    }
    const cwd = await isDir(url.searchParams.get("cwd") ?? "") ? url.searchParams.get("cwd") : home();
    const size = (name, fallback) => Math.max(1, Number(url.searchParams.get(name)) || fallback);
    const cdFile = join(Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp", `phil-cd-${crypto.randomUUID()}`);
    const pty = new Pty(["bash", "--rcfile", await shellInit, "-i"], {
      cwd,
      cols: size("cols", 80),
      rows: size("rows", 24),
      env: { PHIL_CD_FILE: cdFile, ...(config.incognito ? { PHIL_INCOGNITO: "1" } : {}) },
    });
    const { socket, response } = Deno.upgradeWebSocket(req);
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
        const { resize, cd } = JSON.parse(e.data);
        if (resize) pty.resize(resize[0], resize[1]);
        if (cd && await isDir(cd)) {
          await Deno.writeTextFile(cdFile, `${Math.floor(Date.now() / 1000)}\0${cd}\0`);
          await pty.write("\r");
        }
      }).catch(() => {});
    };
    socket.onclose = () => {
      pty.close();
      Deno.remove(cdFile).catch(() => {});
    };
    return response;
  }

  // F2: renames in place. Never overwrites: a name that's taken is an error.
  async function rename({ path, name }) {
    requirePath(path);
    if (typeof name !== "string" || !name || name.includes("/") || name.includes("\0") || name === "." || name === "..") {
      throw Object.assign(new Error("That isn't a valid name."), { status: 400 });
    }
    const target = join(dirname(path), name);
    if (target === path) return { path };
    if (normalize(path) !== path || path === "/") throw Object.assign(new Error("invalid path"), { status: 400 });
    if (await Deno.lstat(target).then(() => true, () => false)) {
      throw Object.assign(new Error(`There's already an item called “${name}” here.`), { status: 409 });
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
}

// bash --rcfile needs a real file, and under `deno compile` ours lives in the
// binary, so copy it out once per run.
const shellInit = (async () => {
  const dir = Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp";
  const path = join(dir, "phil-shell-init.bash");
  const tmp = `${path}.${Deno.pid}`;
  await Deno.writeTextFile(tmp, await Deno.readTextFile(new URL("./shell-init.bash", import.meta.url)));
  await Deno.rename(tmp, path); // atomic, so a concurrently starting shell never reads half a file
  return path;
})();

function requirePath(path) {
  if (!path || !path.startsWith("/")) throw Object.assign(new Error("absolute path required"), { status: 400 });
  return path;
}

async function places() {
  const h = home();
  const userDirs = {};
  try {
    const file = await Deno.readTextFile(join(Deno.env.get("XDG_CONFIG_HOME") ?? join(h, ".config"), "user-dirs.dirs"));
    for (const [, name, value] of file.matchAll(/^XDG_(\w+)_DIR="(.*)"$/gm)) {
      userDirs[name] = value.replace(/^\$HOME/, h);
    }
  } catch { /* use defaults */ }
  const candidates = [
    ["Home", h, "home"],
    ...[
      ["Desktop", "DESKTOP", "folder"],
      ["Documents", "DOCUMENTS", "folder"],
      ["Downloads", "DOWNLOAD", "download"],
      ["Pictures", "PICTURES", "image"],
      ["Videos", "VIDEOS", "video"],
      ["Music", "MUSIC", "music"],
    ].map(([name, key, icon]) => [name, (userDirs[key] ?? join(h, name)).replace(/\/$/, ""), icon]),
  ];
  const out = [];
  const seen = new Set();
  for (const [name, path, icon] of candidates) {
    if (seen.has(path) || (path === h && name !== "Home")) continue;
    if (await isDir(path)) out.push({ name, path, icon }), seen.add(path);
  }
  for (const base of [`/run/media/${basename(h)}`, "/mnt"]) {
    try {
      for await (const d of Deno.readDir(base)) {
        if (d.isDirectory) out.push({ name: d.name, path: join(base, d.name), icon: "drive" });
      }
    } catch { /* not present */ }
  }
  out.push({ name: "Filesystem", path: "/", icon: "drive" });
  return out;
}

async function isDir(path) {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

async function serveFile(req, path, extraHeaders = {}) {
  const stat = await Deno.stat(path);
  if (!stat.isFile) return text(404, "Not a file");
  const size = stat.size;
  let start = 0, end = size - 1, status = 200;
  const headers = {
    "content-type": contentType(path),
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "cache-control": "no-cache",
    ...extraHeaders,
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range")?.trim() ?? "");
  if (range && (range[1] || range[2])) {
    if (range[1] === "") {
      start = Math.max(0, size - Number(range[2]));
    } else {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    }
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    }
    status = 206;
    headers["content-range"] = `bytes ${start}-${end}/${size}`;
  }
  const length = Math.max(0, end - start + 1);
  headers["content-length"] = String(length);
  if (req.method === "HEAD" || length === 0) return new Response(null, { status, headers });

  const file = await Deno.open(path);
  if (start) await file.seek(start, Deno.SeekMode.Start);
  return new Response(rangeStream(file, length), { status, headers });
}

function rangeStream(file, length) {
  let left = length;
  let closed = false;
  const close = () => {
    if (!closed) closed = true, file.close();
  };
  return new ReadableStream({
    async pull(ctrl) {
      const buf = new Uint8Array(Math.min(left, 512 * 1024));
      const n = await file.read(buf);
      if (!n) {
        close();
        return ctrl.close();
      }
      left -= n;
      ctrl.enqueue(buf.subarray(0, n));
      if (left <= 0) {
        close();
        ctrl.close();
      }
    },
    cancel: close,
  });
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
  if (op !== "move" && op !== "copy") throw Object.assign(new Error("bad op"), { status: 400 });
  requirePath(dest);
  if (!(await isDir(dest))) throw Object.assign(new Error("destination is not a folder"), { status: 400 });
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

async function staticFile(name) {
  if (!/^(vendor\/)?[\w.-]+$/.test(name)) return text(404, "Not found");
  try {
    const body = await Deno.readFile(new URL(name, UI_DIR));
    return new Response(body, { headers: { "content-type": contentType(name), "cache-control": "no-cache" } });
  } catch {
    return text(404, "Not found");
  }
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

function json(data) {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}

function text(status, body) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function errorResponse(err) {
  if (err instanceof Deno.errors.NotFound) return text(404, "Not found");
  if (err instanceof Deno.errors.PermissionDenied) return text(403, "Permission denied");
  if (err instanceof Deno.errors.NotADirectory) return text(400, "Not a directory");
  if (err.status) return text(err.status, err.message);
  console.error(err);
  return text(500, String(err?.message ?? err));
}
