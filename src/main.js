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

console.log(`phil: thumbnails in ${config.thumbDir}`);
if (config.browser) {
  console.log(`phil: open ${url}`);
} else {
  const { openWindow } = await import("./window.js");
  openWindow({ title: "phil", url, width: 1280, height: 820 });
  Deno.exit(0);
}
