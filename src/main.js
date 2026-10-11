import { HELP, parseConfig } from "./config.js";

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

// The HTTP server lives in a worker because the GTK main loop blocks this thread.
const server = new Worker(new URL("./server.js", import.meta.url), { type: "module" });
const url = await new Promise((resolve, reject) => {
  server.onmessage = (e) => resolve(e.data.url);
  server.onerror = (e) => reject(e.error ?? new Error(e.message));
  server.postMessage(config);
});

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
  for (const signal of ["SIGINT", "SIGTERM"]) {
    Deno.addSignalListener(signal, () => {
      cleanUp();
      Deno.exit(0);
    });
  }
} else {
  const { openWindow } = await import("./window.js");
  openWindow({ title: "phil", url, width: 1280, height: 820, ephemeral: config.incognito });
  cleanUp();
  Deno.exit(0);
}
