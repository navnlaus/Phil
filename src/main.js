import { join } from "@std/path";
import { HELP, parseConfig } from "./config.js";
import { ask, socketDir, socketPath } from "./instance.js";

// PHIL_TRACE=1 prints startup milestones (ms since the process started).
const trace = Deno.env.get("PHIL_TRACE")
  ? (label) => console.error(`phil: ${performance.now().toFixed(0).padStart(5)}ms ${label}`)
  : () => {};
trace("main.js running");

let config;
try {
  config = parseConfig(Deno.args);
} catch (err) {
  console.error(`phil: ${err.message}\n\n${HELP}`);
  Deno.exit(2);
}
if (config.help) {
  console.log(HELP);
  Deno.exit(0);
}
if (config.fileManagerService) {
  const { runFileManagerService } = await import("./dbus.js");
  runFileManagerService();
  Deno.exit(0);
}

const instance = config.browser || config.standalone ? null : socketPath(config);

if (config.quit) {
  const reply = instance && await ask(instance, { quit: true });
  console.log(reply ? "phil: stopped" : "phil: not running");
  Deno.exit(0);
}
if (config.retire) {
  try {
    for await (const entry of Deno.readDir(socketDir())) {
      if (entry.name.endsWith(".sock")) await ask(join(socketDir(), entry.name), { retire: true }).catch(() => null);
    }
  } catch { /* no phil running */ }
  Deno.exit(0);
}

const request = {
  open: { dir: config.startDirGiven ? config.startDir : null, select: config.select },
  startupId: Deno.env.get("XDG_ACTIVATION_TOKEN") ?? Deno.env.get("DESKTOP_STARTUP_ID"),
};

// A phil is already running: it opens the window, we're done.
if (instance && await ask(instance, request)) {
  trace("handed to the running phil");
  Deno.exit(0);
}

// Otherwise this process becomes the instance. Requests reaching the server
// worker's control socket are written to a pipe the GTK main loop watches,
// since this thread is blocked in gtk_main().
const libc = Deno.dlopen("libc.so.6", { pipe2: { parameters: ["buffer", "i32"], result: "i32" } });
const pipe = new Int32Array(2);
libc.symbols.pipe2(new Uint8Array(pipe.buffer), 0x800 | 0x80000); // O_NONBLOCK | O_CLOEXEC

const server = new Worker(new URL("./server.js", import.meta.url), { type: "module" });
const serverReady = new Promise((resolve, reject) => {
  server.onmessage = (e) => resolve(e.data);
  server.onerror = (e) => reject(e.error ?? new Error(e.message));
  server.postMessage({ ...config, controlSocket: instance, wakeFd: pipe[1] });
});

// Meanwhile set up GTK/WebKit on this thread.
const app = config.browser ? null : (await import("./window.js")).createApp({
  appId: config.incognito ? "phil-incognito" : "phil",
  ephemeral: config.incognito,
  keepRunning: !!instance && !config.incognito,
  trace,
});

const { url, control } = await serverReady;
trace("server listening");

if (control === "in-use") {
  // Another phil started at the same moment and won: hand the request over.
  if (await ask(instance, request)) Deno.exit(0);
  console.error("phil: another phil is starting up; try again");
  Deno.exit(1);
}

// Incognito thumbnails for folders that couldn't hold a .thumbnails folder.
const cleanUp = () => {
  if (config.incognito) {
    try {
      Deno.removeSync(config.scratchDir, { recursive: true });
    } catch { /* never created */ }
  }
};

// The page URL for a window: the token sets the session cookie; the folder
// goes in the fragment, files to select in ?select=.
function windowUrl({ dir, select = [] }) {
  const u = new URL(url);
  for (const path of select) u.searchParams.append("select", path);
  if (dir) u.hash = dir.split("/").map(encodeURIComponent).join("/");
  return u.href;
}

if (config.incognito) console.log("phil: incognito");
console.log(`phil: thumbnails in ${config.thumbDir ?? "a .thumbnails folder in each folder"}`);
if (config.browser) {
  console.log(`phil: open ${windowUrl(request.open)}`);
  server.onmessage = (e) => {
    if (!e.data.quit) return;
    cleanUp();
    Deno.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    Deno.addSignalListener(signal, () => {
      cleanUp();
      Deno.exit(0);
    });
  }
} else {
  let retired = false;
  app.watchPipe(pipe[0], (line) => {
    const message = JSON.parse(line);
    if (message.open) app.openWindow(windowUrl(message.open), { startupId: message.startupId });
    else if (message.retire) app.retire(retired = true);
    else if (message.quit) app.quit();
  });
  app.openWindow(windowUrl(request.open), { startupId: request.startupId });
  app.run();
  trace("exiting");
  cleanUp();
  // A retired instance already gave up the socket, and a newer phil may own the path now.
  if (instance && !retired) Deno.removeSync(instance);
  Deno.exit(0);
}
