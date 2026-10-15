// Windows in a Chromium-based browser instead of WebKitGTK (window.js): the
// default browser when it's one (Chrome, Chromium, Brave, Vivaldi, Edge…),
// otherwise another one installed. Its video and drawing are Blink's: smoother
// than WebKitGTK's here (HLS cameras stuttered in WebKit, not in Brave).
//
// One browser for all the engine's windows, with a profile of its own
// (~/.local/state/phil/browser-<name>; a throwaway one for incognito), so it
// shares nothing with your browsing (extensions, Shields, history) but its
// program: one already running (your own browsing) shares its code in memory.
// Its windows are app windows (no tabs, no address bar): each opened by handing
// `<browser> --app=<url>` to it, the way a desktop shortcut does. The engine
// drives it over its DevTools protocol on a private pipe (two FIFOs in a folder
// only you can open; no port another user could reach): to see windows come and
// go, to close one, and to give it the servers' session cookies (a window's
// address carries no token: a command line's arguments are for any user to
// see). Pages talk to the engine through the server (POST /engine/window,
// kit.js), each window knowing its id (?philWindow=). With no windows left for
// IDLE_MS, a background engine's browser is closed (it starts again with the
// next window, in about half a second).
//
// The servers' certificate (tls.js) is accepted in these windows for the
// servers alone, for HTTP/2: every window is held as it opens until the engine
// has asked to hear of its certificate errors (Security), and those of the
// servers' address and ports are let through; any other is refused, as ever.
// (Not --ignore-certificate-errors-spki-list: a bar over the first window
// called it "unsupported".)
//
// The window's class (Wayland app id), for window rules, is the browser's for
// an app at that address: "<browser>-127.0.0.1__<app>-Default" (e.g.
// brave-127.0.0.1__phil-Default); each app's windows open at /<app id>.
//
// Not as in WebKit's windows: a right- or middle-drag of files out of a window
// stays in it (GTK started those); files dropped in from other programs come
// without their paths (Chromium keeps them from the page).

import { basename, join } from "@std/path";

const POLL_PIPE_MS = 100; // how often the control pipe is read (the main thread isn't blocked here)
const IDLE_MS = 10 * 60 * 1000; // the browser, with no windows, closed after this (a background engine's)

// Chromium-based browsers, by their program's name (as in a .desktop file's
// Exec, or on PATH), in the order they're looked for when the default browser isn't one.
const KNOWN = [
  "chromium", "google-chrome-stable", "google-chrome", "brave", "brave-browser", "brave-browser-stable",
  "vivaldi-stable", "vivaldi", "microsoft-edge-stable", "microsoft-edge", "thorium-browser", "opera", "chromium-browser",
];
const CHROMIUM_LIKE = /chrom|brave|vivaldi|edge|opera|thorium|yandex|cromite|helium/i;

/**
 * The browser to use for windows (its program's path), by `setting` (the
 * settings' "browser", or PHIL_BROWSER): "default" (the default browser if
 * it's Chromium-based, otherwise the first of KNOWN installed), a path, or
 * "webkit"/empty: none (WebKitGTK windows). Null when there's none.
 */
export async function findBrowser(setting) {
  if (!setting || setting === "webkit") return null;
  if (setting.startsWith("/")) return (await isProgram(setting)) ? setting : null;
  if (setting !== "default") return CHROMIUM_LIKE.test(setting) ? await onPath(setting) : null; // (a name: one of theirs)
  const desktop = await run("xdg-settings", ["get", "default-web-browser"]);
  const exec = desktop ? await execOf(desktop.trim()) : null;
  if (exec && CHROMIUM_LIKE.test(basename(exec))) {
    const path = exec.startsWith("/") ? exec : await onPath(exec);
    if (path) return path;
  }
  for (const name of KNOWN) {
    const path = await onPath(name);
    if (path) return path;
  }
  return null;
}

async function run(cmd, args) {
  try {
    const out = await new Deno.Command(cmd, { args, stdin: "null", stdout: "piped", stderr: "null" }).output();
    return out.success ? new TextDecoder().decode(out.stdout) : null;
  } catch {
    return null;
  }
}

const isProgram = (path) => Deno.stat(path).then((s) => s.isFile && (s.mode ?? 0o111) & 0o111, () => false);

async function onPath(name) {
  for (const dir of (Deno.env.get("PATH") ?? "/usr/bin").split(":")) {
    if (dir && await isProgram(join(dir, name))) return join(dir, name);
  }
  return null;
}

// A .desktop file's program (Exec's first word), from the usual places; null for a Flatpak one.
async function execOf(desktopId) {
  const home = Deno.env.get("HOME") ?? "/";
  const dirs = [Deno.env.get("XDG_DATA_HOME") || join(home, ".local/share"), ...(Deno.env.get("XDG_DATA_DIRS") || "/usr/local/share:/usr/share").split(":")];
  for (const dir of dirs) {
    const text = await Deno.readTextFile(join(dir, "applications", desktopId)).catch(() => null);
    const exec = text?.match(/^Exec=(\S+)/m)?.[1];
    if (exec) return exec === "flatpak" || exec.includes("flatpak") ? null : exec.replace(/^"|"$/g, "");
  }
  return null;
}

/**
 * The engine's windows in `browser` (a path, from findBrowser). As
 * window.js's createApp, but run() resolves (rather than blocking) once it
 * quits. Also onPageMessage({id, message}): a window's page, through the
 * server ("ready…", "close").
 */
export function createApp({ name, browser, ephemeral = false, keepRunning = false, trustCertificate = null, trace = () => {} }) {
  const runtime = Deno.env.get("XDG_RUNTIME_DIR") || "/tmp";
  const stateHome = Deno.env.get("XDG_STATE_HOME") || join(Deno.env.get("HOME") ?? "/", ".local/state");
  const pipeDir = join(runtime, `phil-browser-${Deno.pid}`);
  const profile = ephemeral ? join(pipeDir, "profile") : join(stateHome, "phil", `browser-${basename(browser)}`);
  const ports = new Set(); // the servers' (their certificate errors let through)
  let session = null; // {send, close}: the browser running, over its pipe, once set up
  let link = null; // the same, from its start (for its events)
  let starting = null;
  let nextWindow = 1, retiring = false, stopped = false, idleTimer = 0;
  const cookies = new Set(); // "name=value" given to the browser (its servers' sessions)
  const windows = new Map(); // window id -> target id (null until the browser says it's there)
  const targetWindow = new Map(); // target id -> window id
  const { promise: done, resolve: finish } = Promise.withResolvers();

  // The browser, started when the first window opens (and again if it went).
  function start() {
    if (session) return Promise.resolve(session);
    starting ??= (async () => {
      await Deno.mkdir(pipeDir, { recursive: true, mode: 0o700 });
      await Deno.chmod(pipeDir, 0o700);
      await Deno.mkdir(profile, { recursive: true, mode: 0o700 }).catch(() => {});
      const fin = join(pipeDir, "in"), fout = join(pipeDir, "out");
      for (const f of [fin, fout]) {
        await Deno.remove(f).catch(() => {});
        const made = await new Deno.Command("mkfifo", { args: ["-m", "600", f], stderr: "null" }).output();
        if (!made.success) throw new Error("mkfifo failed");
      }
      const args = [
        `--user-data-dir=${profile}`, "--remote-debugging-pipe", "--no-startup-window", "--no-first-run",
        "--no-default-browser-check", "--password-store=basic", "--disable-sync", "--disable-extensions",
        "--disable-default-apps", "--disable-component-update", "--disable-background-networking",
        "--process-per-site", // every window of the engine's (one site) in one page process
      ];
      // fd 3: what the browser reads (the engine's commands), fd 4: what it writes.
      const child = new Deno.Command("sh", {
        args: ["-c", 'exec 3<"$1" 4>"$2"; shift 2; exec "$@"', "sh", fin, fout, browser, ...args],
        stdin: "null", stdout: "null", stderr: "null",
      }).spawn();
      const [toBrowser, fromBrowser] = await Promise.all([Deno.open(fin, { write: true }), Deno.open(fout, { read: true })]);
      trace(`browser started: ${basename(browser)}`);
      const s = connect(toBrowser, fromBrowser, () => {
        session = link = null;
        windows.clear();
        targetWindow.clear();
        cookies.clear();
        trace("browser gone");
        if (!keepRunning || retiring) stop();
      });
      s.exited = child.status.then(() => s.close());
      link = s; // (its events from here on: windows opening)
      await s.send("Target.setDiscoverTargets", { discover: true });
      // Every new window held until it's been told about certificate errors (onEvent).
      await s.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      session = s;
      return s;
    })().finally(() => (starting = null));
    return starting;
  }

  // The DevTools protocol over the pipe: JSON messages, each ended by a NUL.
  function connect(writer, reader, onClose) {
    const encoder = new TextEncoder(), decoder = new TextDecoder();
    const waiting = new Map();
    let id = 0, closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      for (const f of [writer, reader]) {
        try {
          f.close();
        } catch { /* closed */ }
      }
      for (const resolve of waiting.values()) resolve({ error: { message: "browser gone" } });
      onClose();
    };
    (async () => {
      let buffer = "";
      try {
        for await (const chunk of reader.readable) {
          buffer += decoder.decode(chunk, { stream: true });
          for (let end; (end = buffer.indexOf("\0")) !== -1;) {
            const message = JSON.parse(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
            if (message.id) waiting.get(message.id)?.(message), waiting.delete(message.id);
            else onEvent(message);
          }
        }
      } catch { /* gone */ }
      close();
    })();
    return {
      send(method, params = {}, sessionId = undefined) {
        if (closed) return Promise.resolve({ error: { message: "browser gone" } });
        const message = { id: ++id, method, params, ...(sessionId ? { sessionId } : {}) };
        const { promise, resolve } = Promise.withResolvers();
        waiting.set(message.id, resolve);
        writer.write(encoder.encode(JSON.stringify(message) + "\0")).catch(close);
        return promise;
      },
      close,
    };
  }

  // Windows coming and going (the browser's page targets): which of ours each is, by its ?philWindow.
  // A window opening (held): its certificate errors come here, then it goes on. One of them:
  // let through for the servers (by address and port: theirs), refused for the rest.
  async function onEvent({ method, params, sessionId }) {
    if (method === "Target.attachedToTarget") {
      const sid = params.sessionId;
      if (params.targetInfo.type === "page" && trustCertificate) {
        await link?.send("Security.enable", {}, sid);
        await link?.send("Security.setOverrideCertificateErrors", { override: true }, sid);
      }
      return void link?.send("Runtime.runIfWaitingForDebugger", {}, sid);
    }
    if (method === "Security.certificateError") {
      let ours = false;
      try {
        const u = new URL(params.requestURL);
        ours = (u.protocol === "https:" || u.protocol === "wss:") && u.hostname === "127.0.0.1" && ports.has(u.port); // (wss: the pages' WebSockets)
      } catch { /* not a URL */ }
      return void link?.send("Security.handleCertificateError", { eventId: params.eventId, action: ours ? "continue" : "cancel" }, sessionId);
    }
    if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") {
      const { targetId, type, url } = params.targetInfo;
      if (type !== "page" || targetWindow.has(targetId)) return;
      const id = /[?&]philWindow=(\d+)/.exec(url)?.[1];
      if (id && windows.has(id)) windows.set(id, targetId), targetWindow.set(targetId, id), trace(`window ${id} there`);
    } else if (method === "Target.targetDestroyed") {
      const id = targetWindow.get(params.targetId);
      if (!id) return;
      targetWindow.delete(params.targetId);
      windows.delete(id);
      if (windows.size > 0) return;
      if (!keepRunning || retiring) return void stop();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => windows.size === 0 && session?.send("Browser.close"), IDLE_MS);
    }
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(idleTimer);
    const s = session;
    session = null;
    if (s) {
      await s.send("Browser.close");
      await Promise.race([s.exited, new Promise((r) => setTimeout(r, 5000))]); // done with its profile
    }
    if (ephemeral) await Deno.remove(profile, { recursive: true }).catch(() => {});
    await Deno.remove(pipeDir, { recursive: true }).catch(() => {});
    finish();
  }

  // Stopped by a signal: the browser closed, the pipe's folder gone. (One an engine that
  // died left behind is gone at the next start: those of engines no longer running.)
  for (const signal of ["SIGTERM", "SIGINT"]) Deno.addSignalListener(signal, () => stop().then(() => Deno.exit(0)));
  (async () => {
    for await (const e of Deno.readDir(runtime)) {
      const pid = /^phil-browser-(\d+)$/.exec(e.name)?.[1];
      if (pid && pid !== String(Deno.pid) && !(await Deno.stat(`/proc/${pid}`).then(() => true, () => false))) {
        await Deno.remove(join(runtime, e.name), { recursive: true }).catch(() => {});
      }
    }
  })().catch(() => {});

  trace("app created");

  return {
    get windowCount() {
      return windows.size;
    },

    /**
     * Opens a window on `url` (an app's server's, with its session token: the
     * cookie server.js gives for it, `<app>-<port>`, is set in the browser
     * instead), at /<appId> (so its window class says which app it is), marked
     * with its window id.
     */
    async openWindow(url, { appId, app, startupId }) {
      if (stopped) return;
      let s;
      try {
        s = await start();
      } catch (err) {
        return console.error(`${name}: couldn't start ${browser}: ${err.message}`);
      }
      clearTimeout(idleTimer);
      const id = String(nextWindow++);
      windows.set(id, null);
      const u = new URL(url);
      ports.add(u.port);
      const token = u.searchParams.get("token");
      u.searchParams.delete("token");
      if (token && !cookies.has(`${app}-${u.port}=${token}`)) {
        const set = await s.send("Storage.setCookies", {
          cookies: [{ name: `${app}-${u.port}`, value: token, domain: "127.0.0.1", path: "/", httpOnly: true, secure: u.protocol === "https:", sameSite: "Strict" }],
        });
        if (set.error) console.error(`${name}: couldn't give the browser its session: ${set.error.message}`);
        else cookies.add(`${app}-${u.port}=${token}`);
      }
      u.pathname = `/${appId}`;
      u.searchParams.set("philWindow", id);
      // Handed to the running browser (its own profile's), which opens it as an app window.
      const handOff = new Deno.Command(browser, {
        args: [`--user-data-dir=${profile}`, `--app=${u.href}`],
        stdin: "null", stdout: "null", stderr: "null",
        env: startupId ? { XDG_ACTIVATION_TOKEN: startupId, DESKTOP_STARTUP_ID: startupId } : {},
      });
      const out = await handOff.output().catch((err) => ({ success: false, err }));
      trace(`window ${id} handed to the browser`);
      if (!out.success) console.error(`${name}: ${browser} didn't take the window${out.err ? `: ${out.err.message}` : ""}`);
    },

    /** A window's page, through the server: "ready…" (traced), "close". */
    async onPageMessage({ id, message }) {
      if (typeof message !== "string") return;
      if (message.startsWith("ready")) return trace(`page ${id} ready ${message.slice(6)}`);
      if (message === "close") {
        const targetId = windows.get(String(id));
        if (targetId && session) await session.send("Target.closeTarget", { targetId });
      }
    },

    /** Calls onLine(line) for each line written to `fd` (a non-blocking pipe), polling it. */
    watchPipe(fd, onLine) {
      const libc = Deno.dlopen("libc.so.6", { read: { parameters: ["i32", "buffer", "usize"], result: "isize", nonblocking: false } });
      const buf = new Uint8Array(4096), decoder = new TextDecoder();
      let pending = "";
      setInterval(() => {
        for (let n; (n = Number(libc.symbols.read(fd, buf, buf.length))) > 0;) pending += decoder.decode(buf.subarray(0, n), { stream: true });
        for (let nl; (nl = pending.indexOf("\n")) !== -1;) {
          const line = pending.slice(0, nl);
          pending = pending.slice(nl + 1);
          if (line) onLine(line);
        }
      }, POLL_PIPE_MS);
    },

    /** Stop once the open windows are closed (a newer phil takes over). */
    retire() {
      retiring = true;
      if (windows.size === 0) stop();
    },

    quit() {
      stop();
    },

    run() {
      return done;
    },
  };
}
