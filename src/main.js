import { HELP, parseConfig } from "./config.js";

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

// The HTTP server lives in a worker because the GTK main loop blocks this thread.
const server = new Worker(new URL("./server.js", import.meta.url), { type: "module" });
const serverReady = new Promise((resolve, reject) => {
  server.onmessage = (e) => resolve(e.data.url);
  server.onerror = (e) => reject(e.error ?? new Error(e.message));
  server.postMessage(config);
});

// Meanwhile set up GTK/WebKit (window still hidden) on this thread.
const appWindow = config.browser ? null : (await import("./window.js")).createWindow({
  title: "phil",
  width: 1280,
  height: 820,
  ephemeral: config.incognito,
  trace,
});

const url = await serverReady;
trace("server listening");

// Incognito thumbnails for folders that couldn't hold a .thumbnails folder.
const cleanUp = () => {
  if (config.incognito) {
    try {
      Deno.removeSync(config.scratchDir, { recursive: true });
    } catch { /* never created */ }
  }
};

if (config.incognito) console.log("phil: incognito");
console.log(`phil: thumbnails in ${config.thumbDir ?? "a .thumbnails folder in each folder"}`);
if (config.browser) {
  console.log(`phil: open ${url}`);
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
  appWindow.run(url);
  cleanUp();
  Deno.exit(0);
}
