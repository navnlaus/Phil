// Local HTTP server for the UI. Runs in a worker; posts { url } once listening.
import { basename, dirname, extname, join } from "@std/path";
import { home } from "./config.js";
import { mediaKind, Thumbnailer } from "./thumbs.js";

const UI_DIR = new URL("../ui/", import.meta.url);

const CONTENT_TYPES = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
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
  let host;

  Deno.serve({
    hostname: "127.0.0.1",
    port: config.port,
    onListen({ port }) {
      host = `127.0.0.1:${port}`;
      self.postMessage({ url: `http://${host}/?token=${token}` });
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
      return new Response(null, {
        status: 303,
        headers: { location: "/", "set-cookie": `phil=${token}; HttpOnly; SameSite=Strict; Path=/` },
      });
    }
    const cookies = (req.headers.get("cookie") ?? "").split(/;\s*/);
    if (!cookies.includes(`phil=${token}`)) return text(403, "Forbidden: open the URL printed by phil");

    const path = url.searchParams.get("path");
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /":
        return staticFile("index.html");
      case "GET /api/init":
        return json({
          start: config.startDir,
          home: home(),
          places: await places(),
          thumbDir: config.thumbDir,
          thumbSize: thumbs.name,
          settings: await readSettings(),
        });
      case "GET /api/list":
        return json(await listDir(requirePath(path)));
      case "GET /file":
      case "HEAD /file":
        return serveFile(req, requirePath(path), { "content-security-policy": "sandbox" });
      case "GET /preview":
        return preview(requirePath(path), url.searchParams.get("size") ?? "2560");
      case "POST /api/open":
        return openExternal(await req.json());
      case "PUT /api/settings":
        await writeSettings(await req.json());
        return json({ ok: true });
      case "GET /ws":
        return thumbSocket(req);
    }
    if (req.method === "GET" && url.pathname.startsWith("/ui/")) return staticFile(url.pathname.slice(4));
    const thumb = /^\/thumbs\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && thumb && thumb[1] === thumbs.name) {
      const file = thumbs.fileFor(thumb[2]);
      if (file) return serveFile(req, file, { "cache-control": "private, max-age=31536000, immutable" });
    }
    return text(404, "Not found");
  }

  async function listDir(dir) {
    const dirents = [];
    for await (const d of Deno.readDir(dir)) dirents.push(d);
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
      if (stat && (kind === "image" || kind === "video")) entry.thumb = await thumbs.lookup(path, stat);
      return entry;
    });
    return { path: dir, parent: dir === "/" ? null : dirname(dir), entries };
  }

  // One WebSocket per page. The page sends {want: [paths]} for tiles entering the
  // viewport and {cancel: [paths]} for tiles that scrolled away before loading.
  // Unlike <img> requests this isn't capped at ~6 connections per host.
  function thumbSocket(req) {
    if (req.headers.get("upgrade") !== "websocket" || req.headers.get("origin") !== `http://${host}`) {
      return text(400, "Bad request");
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    const pending = new Map();
    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data);
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
    };
    socket.onclose = () => pending.forEach((c) => c.abort());
    const send = (msg) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(msg));
    return response;
  }

  async function readSettings() {
    try {
      return JSON.parse(await Deno.readTextFile(config.settingsFile));
    } catch {
      return {};
    }
  }

  async function writeSettings(settings) {
    await Deno.mkdir(dirname(config.settingsFile), { recursive: true });
    await Deno.writeTextFile(config.settingsFile, JSON.stringify(settings, null, 2) + "\n");
  }
}

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

function openExternal({ path, app }) {
  requirePath(path);
  const [cmd, ...args] = app === "mpv" ? ["mpv", "--", path] : ["xdg-open", path];
  const child = new Deno.Command(cmd, { args, stdin: "null", stdout: "null", stderr: "null" }).spawn();
  child.unref();
  child.status.catch(() => {});
  return json({ ok: true });
}

async function staticFile(name) {
  if (!/^[\w.-]+$/.test(name)) return text(404, "Not found");
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
