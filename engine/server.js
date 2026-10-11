// The engine's servers, in a worker of the engine process (its main thread is
// blocked in gtk_main()). Every app gets its own HTTP server on 127.0.0.1, so
// its pages have an origin of their own and keep their absolute URLs. Posts
// { urls: {app: url}, control } once all are listening.
import { APPS } from "./apps.js";
import { errorResponse, json, staticFile, text } from "./http.js";
import { listen } from "./instance.js";

const KIT_DIR = new URL("./ui/", import.meta.url); // shared by every app's pages
const TRACE = !!Deno.env.get("PHIL_TRACE"); // also logs every request

self.onmessage = (e) => start(e.data);

async function start({ profile, controlSocket, wakeFd }) {
  const token = crypto.randomUUID();
  const quit = () => self.postMessage({ quit: true });
  const urls = {};
  await Promise.all(Object.entries(APPS).map(async ([name, app]) => {
    const mod = await app.server();
    const server = await mod.createServer({ profile, quit });
    urls[name] = await serve(name, mod.UI_DIR, server, { token, quit, urls });
  }));

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
      if (message.retire) await stopListening();
      if (!message.ping) forward(message);
      return { ok: true };
    });
    control = listening ? "listening" : "in-use";
  }
  self.postMessage({ urls, control });
}

// Resolves to the app's URL with the token: opening it sets the session cookie.
// Besides the app's own files and routes, its pages get /engine/ui/ (shared
// styles and scripts) and /engine/apps (every app's URL, for showing one
// inside another).
function serve(name, uiDir, app, { token, quit, urls }) {
  let host, cookie;
  const { promise, resolve } = Promise.withResolvers();
  Deno.serve({
    hostname: "127.0.0.1",
    port: app.port ?? 0,
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

  async function handle(req) {
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

    if (req.method === "GET" && url.pathname === "/") return staticFile(uiDir, "index.html");
    if (req.method === "GET" && url.pathname.startsWith("/ui/")) return staticFile(uiDir, url.pathname.slice(4));
    if (req.method === "GET" && url.pathname.startsWith("/engine/ui/")) return staticFile(KIT_DIR, url.pathname.slice(11));
    if (req.method === "GET" && url.pathname === "/engine/apps") return json(urls);
    if (req.method === "POST" && url.pathname === "/api/quit") { // the close button in --browser mode (windows close natively)
      quit();
      return json({ ok: true });
    }
    return (await app.handle(req, url)) ?? text(404, "Not found");
  }

  return promise;
}
