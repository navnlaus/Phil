// phil-engine: runs the apps in apps/ (engine/apps.js) in one background
// process per profile (engine/instance.js), with their windows (window.js)
// and servers (server.js).
//
//   phil-engine <app> [args]   open a window of the app; what the app commands
//                              (`phil`, `jsonedit`) run. The first one starts the
//                              engine in the background.
//   phil-engine --retire       every running engine stops taking new windows and
//                              exits once its windows are closed
//   phil-engine --install-themes  copies the built-in themes to ~/.config/phil/themes
//                              (engine/themes.js; scripts/install.sh runs it)
//   phil-engine --serve JSON   the background engine itself (internal)
//
// Engine options, given with any app: --browser, --standalone, --quit (see
// HELP). Everything else on the command line is the app's.
import { join } from "@std/path";
import { APPS } from "./apps.js";
import { ask, engineCommand, socketDir, socketPath } from "./instance.js";
import { localCertificate } from "./tls.js";

const NAME = "phil-engine";
const ENGINE_OPTIONS = ["--browser", "--standalone", "--quit", "--retire", "--install-themes"];

const HELP = `${NAME} — runs apps (${Object.keys(APPS).join(", ")}) in one background process

Usage: ${NAME} <app> [options] [arguments]
       ${NAME} --retire
       ${NAME} --install-themes

The app commands run \`${NAME} <app> ...\`; see \`<app> --help\` for theirs.

Engine options, with any app:
  --browser      Don't open a window; print the URL to open in a browser
  --standalone   Don't use or start the background engine: a process of its own
                 that exits when its window closes (handy for development)
  --quit         Stop the background engine (the one the app's options pick)
  --retire       Ask every running engine to stop taking new windows and exit once
                 its windows are closed, so the next launch runs a new build
  --install-themes
                 Copy the built-in themes to ~/.config/phil/themes, where they can
                 be edited (open windows follow edits); copies that were edited
                 are left alone
`;

// PHIL_TRACE=1 prints startup milestones (ms since the process started).
const trace = Deno.env.get("PHIL_TRACE")
  ? (label) => console.error(`${NAME}: ${performance.now().toFixed(0).padStart(5)}ms ${label}`)
  : () => {};
trace("main.js running");

if (Deno.args[0] === "--serve") await serve(JSON.parse(Deno.args[1]));
else await launch(Deno.args);

async function launch(argv) {
  const flags = new Set(argv.filter((a) => ENGINE_OPTIONS.includes(a)));
  const [name, ...args] = argv.filter((a) => !ENGINE_OPTIONS.includes(a));
  if (flags.has("--install-themes")) {
    const { installThemes, themesDir } = await import("./themes.js");
    const { copied, updated, removed, kept } = await installThemes();
    const list = (names) => names.join(", ");
    const done = [
      copied.length && `copied ${list(copied)}`,
      updated.length && `updated ${list(updated)}`,
      removed.length && `removed ${list(removed)} (no longer built in)`,
      kept.length && `kept your edited ${list(kept)} (this build's are in the source's themes/)`,
    ].filter(Boolean);
    console.log(`Themes in ${themesDir()}: ${done.join("; ") || "up to date"}`);
    Deno.exit(0);
  }
  if (flags.has("--retire")) {
    try {
      for await (const entry of Deno.readDir(socketDir())) {
        if (entry.name.endsWith(".sock")) await ask(join(socketDir(), entry.name), { retire: true }).catch(() => null);
      }
    } catch { /* no engine running */ }
    Deno.exit(0);
  }
  if (!APPS[name]) {
    if (name && name !== "--help" && name !== "-h") console.error(`${NAME}: no app called ${name}\n`);
    console.log(HELP);
    Deno.exit(!name || name === "--help" || name === "-h" ? 0 : 2);
  }

  const app = await APPS[name].launch();
  let parsed;
  try {
    parsed = app.parse(args, { cwd: Deno.cwd() });
  } catch (err) {
    console.error(`${name}: ${err.message}\nSee ${name} --help.`);
    Deno.exit(2);
  }
  if (parsed.help) {
    console.log(parsed.help);
    Deno.exit(0);
  }
  if (parsed.run) {
    await parsed.run();
    Deno.exit(0);
  }
  if (parsed.send && (await ask(parsed.send.socket, parsed.send.message).catch(() => null))?.ok) Deno.exit(0);
  const profile = JSON.parse(JSON.stringify(parsed.profile ?? {})); // without the undefined values
  const request = {
    open: { app: parsed.app ?? name, ...parsed.open },
    startupId: Deno.env.get("XDG_ACTIVATION_TOKEN") ?? Deno.env.get("DESKTOP_STARTUP_ID"),
  };
  const socket = socketPath(profile);

  if (flags.has("--quit")) {
    console.log(await ask(socket, { quit: true }) ? `${NAME}: stopped` : `${NAME}: not running`);
    Deno.exit(0);
  }
  if (flags.has("--browser") || flags.has("--standalone")) {
    return serve({ profile, request, browser: flags.has("--browser"), standalone: flags.has("--standalone") });
  }
  // An engine is running: it opens the window, we're done (unless the app waits
  // for something of the window's: phil --choose, for the choice).
  if (await ask(socket, request)) {
    trace("handed to the running engine");
    await parsed.waitFor?.();
    Deno.exit(0);
  }
  await startEngine({ profile, request }, socket);
  await parsed.waitFor?.();
  Deno.exit(0);
}

// Starts the engine in the background, detached, with the request for its
// first window; its output goes to <socket>.log. Returns once it answers, so a
// failure to start is reported here.
async function startEngine(job, socket) {
  await Deno.mkdir(socketDir(), { recursive: true, mode: 0o700 });
  const log = socket.replace(/\.sock$/, ".log");
  const command = [...engineCommand(), "--serve", JSON.stringify(job)];
  const child = new Deno.Command("sh", {
    args: ["-c", 'exec "$@" >"$0" 2>&1', log, ...command],
    stdin: "null",
    stdout: "null",
    stderr: "null",
    detached: true,
  }).spawn();
  child.unref();
  let exited = null;
  child.status.then((status) => (exited = status));
  trace("engine started");
  for (let i = 0; i < 150; i++) {
    if (await ask(socket, { ping: true }).catch(() => null)) return trace("engine answered");
    if (exited?.success) return; // another engine started at the same moment and took the request
    if (exited) {
      const output = await Deno.readTextFile(log).catch(() => "");
      console.error(`${NAME}: the engine stopped while starting (${log}):\n${output.trim().split("\n").slice(-15).join("\n")}`);
      Deno.exit(1);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error(`${NAME}: the engine didn't answer within 15 seconds; see ${log}`);
  Deno.exit(1);
}

// The engine: GTK/WebKit windows on this thread, the servers in a worker.
// Without --standalone or --browser it takes the profile's control socket and
// keeps running after its last window closes (incognito ones don't).
// The settings' "browser" (~/.config/phil/settings.json): which windows (see serve).
async function browserSetting() {
  const config = Deno.env.get("XDG_CONFIG_HOME") || join(Deno.env.get("HOME") ?? "/", ".config");
  return await Deno.readTextFile(join(config, "phil", "settings.json")).then((t) => JSON.parse(t).browser ?? null, () => null);
}

async function serve({ profile = {}, request = null, browser = false, standalone = false }) {
  const instance = browser || standalone ? null : socketPath(profile);

  // Requests reaching the worker's control socket are written to a pipe the
  // GTK main loop watches, since this thread is blocked in gtk_main().
  const libc = Deno.dlopen("libc.so.6", { pipe2: { parameters: ["buffer", "i32"], result: "i32" } });
  const pipe = new Int32Array(2);
  libc.symbols.pipe2(new Uint8Array(pipe.buffer), 0x800 | 0x80000); // O_NONBLOCK | O_CLOEXEC

  // HTTPS (for HTTP/2) for the engine's own windows (tls.js); a browser
  // (--browser) wouldn't trust the certificate, so plain HTTP there, and with PHIL_PLAIN_HTTP=1.
  const tls = browser || Deno.env.get("PHIL_PLAIN_HTTP") ? null : await localCertificate();
  trace(tls ? "certificate made" : "plain HTTP");

  const server = new Worker(new URL("./server.js", import.meta.url), { type: "module" });
  const serverReady = new Promise((resolve, reject) => {
    server.onmessage = (e) => resolve(e.data);
    server.onerror = (e) => reject(e.error ?? new Error(e.message));
    server.postMessage({ profile, controlSocket: instance, wakeFd: pipe[1], tls });
  });

  // Meanwhile set up GTK/WebKit on this thread.
  const launchers = Object.fromEntries(
    await Promise.all(Object.entries(APPS).map(async ([name, app]) => [name, await app.launch()])),
  );
  // Windows: in a Chromium-based browser (chromium.js) when the settings'
  // "browser" (or PHIL_BROWSER) asks for one ("default": the default browser,
  // or another installed; a path) and there is one; otherwise WebKitGTK's (window.js).
  const chromium = browser ? null : await import("./chromium.js").then(async (m) => {
    const path = await m.findBrowser(Deno.env.get("PHIL_BROWSER") ?? await browserSetting());
    return path && { module: m, path };
  });
  if (!browser) trace(chromium ? `windows: ${chromium.path}` : "windows: WebKitGTK");
  const appOptions = { name: NAME, ephemeral: !!profile.incognito, keepRunning: !!instance && !profile.incognito, trustCertificate: tls?.cert, trace };
  const windows = browser ? null : chromium
    ? chromium.module.createApp({ ...appOptions, browser: chromium.path })
    : (await import("./window.js")).createApp(appOptions);

  const { urls, control } = await serverReady;
  trace("servers listening");
  // Pages of the browser's windows talk to it through the server (POST /engine/window).
  if (windows?.onPageMessage) server.onmessage = (e) => e.data.window && windows.onPageMessage(e.data.window);
  if (control === "in-use") {
    // Another engine started at the same moment and won: hand the request over.
    if (request && await ask(instance, request)) Deno.exit(0);
    console.error(`${NAME}: another engine is starting up; try again`);
    Deno.exit(1);
  }

  const cleanUp = () => Object.values(launchers).forEach((app) => app.cleanUp?.(profile));
  const windowUrl = ({ app, ...open }) => launchers[app].windowUrl(new URL(urls[app]), open).href;
  const openWindow = ({ open, startupId }) => {
    const app = launchers[open?.app];
    if (!app) return console.error(`${NAME}: no app called ${open?.app}`);
    windows.openWindow(windowUrl(open), { appId: app.appId + (profile.incognito ? "-incognito" : ""), app: open.app, startupId });
  };

  if (profile.incognito) console.log(`${NAME}: incognito`);
  if (browser) {
    console.log(`${request.open.app}: open ${windowUrl(request.open)}`);
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
    return;
  }

  let retired = false;
  windows.watchPipe(pipe[0], (line) => {
    const message = JSON.parse(line);
    if (message.open) openWindow(message);
    else if (message.retire) windows.retire(retired = true);
    else if (message.quit) windows.quit();
  });
  if (request) openWindow(request);
  await windows.run(); // WebKitGTK's: blocks in gtk_main(); the browser's: a promise
  trace("exiting");
  cleanUp();
  // A retired engine already gave up the socket, and a newer one may own the path now.
  if (instance && !retired) Deno.removeSync(instance);
  Deno.exit(0);
}
