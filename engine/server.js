// The engine's servers, in a worker of the engine process (its main thread is
// blocked in gtk_main()). Every app gets its own HTTP server on 127.0.0.1, so
// its pages have an origin of their own and keep their absolute URLs. Posts
// { urls: {app: url}, control } once all are listening.
import { APPS } from "./apps.js";
import { readClipboard, writeClipboard } from "./clipboard.js";
import { errorResponse, json, staticFile, text } from "./http.js";
import { listen } from "./instance.js";

const KIT_DIR = new URL("./ui/", import.meta.url); // scripts shared by every app's pages
const THEMES_DIR = new URL("../themes/", import.meta.url); // styles shared by every app's pages, and phil's themes
const TRACE = !!Deno.env.get("PHIL_TRACE"); // also logs every request

self.onmessage = (e) => start(e.data);

async function start({ profile, controlSocket, wakeFd }) {
  const token = crypto.randomUUID();
  const quit = () => self.postMessage({ quit: true });
  // Every app's server, then a listening port for each.
  const apps = {};
  await Promise.all(Object.entries(APPS).filter(([, app]) => app.server).map(async ([name, app]) => {
    const mod = await app.server();
    apps[name] = { uiDir: mod.UI_DIR, server: await mod.createServer({ profile, quit, controlSocket }) };
  }));
  const urls = {};
  await Promise.all(Object.keys(apps).map(async (name) => (urls[name] = await serve(name, apps, { token, quit }))));

  // Take over the instance's control socket (if any): its requests go to the
  // GTK main loop through wakeFd.
  let control = "none";
  if (controlSocket) {
    const libc = Deno.dlopen("libc.so.6", { write: { parameters: ["i32", "buffer", "usize"], result: "isize" } });
    const forward = (message) => {
      const line = new TextEncoder().encode(JSON.stringify(message) + "\n");
      libc.symbols.write(wakeFd, line, line.length);
    };
    const listening = await listen(controlSocket, async (message, { stopListening }) => {
      if (message.to) return (await apps[message.to]?.server.control?.(message)) ?? { ok: false }; // for an app
      if (message.retire) await stopListening();
      if (!message.ping) forward(message);
      return { ok: true };
    });
    control = listening ? "listening" : "in-use";
  }
  self.postMessage({ urls, control });
}

// Serves app `name`; resolves to its URL with the token (opening it sets the
// session cookie). Besides the app's own files and routes, its pages get
// /engine/ui/ (shared scripts), /themes/ (shared styles, phil's themes), /engine/clipboard (the desktop's
// clipboard) and /engine/embed/<app>/: any other app, to show inside this
// one's window. That's on this origin, since WebKit won't let a page in a
// frame from another origin take keyboard focus. (Apps that can be shown so
// use relative URLs.)
function serve(name, apps, { token, quit }) {
  let host, cookie;
  const { promise, resolve } = Promise.withResolvers();
  Deno.serve({
    hostname: "127.0.0.1",
    port: apps[name].server.port ?? 0,
    onListen({ port }) {
      host = `127.0.0.1:${port}`;
      cookie = `${name}-${port}`; // per port, so two engines never overwrite each other's session
      resolve(`http://${host}/?token=${token}`);
    },
  }, async (req) => {
    let res;
    try {
      res = await handle(req);
    } catch (err) {
      res = errorResponse(err);
    }
    if (TRACE) console.error(`${name}: ${req.method} ${new URL(req.url).pathname} ${res.status}`);
    return res;
  });

  function handle(req) {
    const url = new URL(req.url);
    // Only answer requests addressed to us (blocks DNS rebinding) that carry the session cookie.
    if (req.headers.get("host") !== host) return text(403, "Forbidden");
    if (url.searchParams.get("token") === token) {
      url.searchParams.delete("token"); // keep the rest of the query; the #fragment carries over by itself
      return new Response(null, {
        status: 303,
        headers: { location: "/" + url.search, "set-cookie": `${cookie}=${token}; HttpOnly; SameSite=Strict; Path=/` },
      });
    }
    const cookies = (req.headers.get("cookie") ?? "").split(/;\s*/);
    if (!cookies.includes(`${cookie}=${token}`)) return text(403, "Forbidden: open the URL printed by the app");
    if (req.headers.get("upgrade") === "websocket" && req.headers.get("origin") !== `http://${host}`) {
      return text(400, "Bad request");
    }

    const embed = /^\/engine\/embed\/([\w-]+)(\/.*)$/.exec(url.pathname);
    if (embed && apps[embed[1]]) {
      url.pathname = embed[2];
      return route(req, url, apps[embed[1]]);
    }
    if (req.method === "POST" && url.pathname === "/api/quit") { // the close button in --browser mode (windows close natively)
      quit();
      return json({ ok: true });
    }
    return route(req, url, apps[name]);
  }

  return promise;
}

// A request for an app, at the root of the URL space it's served in.
async function route(req, url, { uiDir, server }) {
  if (req.method === "GET" && url.pathname === "/") return staticFile(uiDir, "index.html");
  if (req.method === "GET" && url.pathname.startsWith("/ui/")) return staticFile(uiDir, url.pathname.slice(4));
  if (req.method === "GET" && url.pathname.startsWith("/engine/ui/")) return staticFile(KIT_DIR, url.pathname.slice(11));
  if (req.method === "GET" && url.pathname.startsWith("/themes/")) return staticFile(THEMES_DIR, url.pathname.slice(8));
  if (url.pathname === "/engine/clipboard") { // the desktop's clipboard (clipboard.js)
    if (req.method === "GET") return text(200, await readClipboard());
    if (req.method === "PUT") return await writeClipboard(await req.text()), json({ ok: true });
  }
  return (await server.handle(req, url)) ?? text(404, "Not found");
}
