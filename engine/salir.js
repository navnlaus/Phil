// Windows through salir (~/Projects/salir: github.com/navnlaus/salir): Chromium
// (CEF) drawing each page in a window of its own, driven through its --control
// channel (JSON lines on its stdin and stdout). One salir for all the engine's
// windows, started with the first, with a profile of its own
// (~/.local/state/phil/salir; a throwaway one for incognito, or while another
// engine's salir still has it). With no windows left for IDLE_MS, a background
// engine's salir is closed (it starts again with the next window).
//
// A window's address carries its server's session token (the server sets its
// cookie): it goes to salir over the pipe, not on a command line others can
// read. The servers' certificate (tls.js) is given to salir to trust, that one
// alone. Pages talk to the engine through window.salir (kit.js): "ready", "close",
// "open", "tell".
//
// A page can ask for another app's window over itself (kit.js openOver: phil's
// videos, in videoplayer's own window): on Hyprland it goes in the page's
// window's tile, as if inside it, till it's taken out (hyprland.js); the page
// hears what it tells (tellParent) and when it's closed.
//
// The window's class (Wayland app id), for window rules: the app's (phil,
// phil-choose, phil-incognito...). Windows are Chromium's own (salir's direct
// ones), but an app's that hold embeds (videoplayer: mpv under the page), which
// are composited; salir has phil's mpv plugin (native/salir-mpv) for those.

import { join } from "@std/path";
import { createPlacer } from "./hyprland.js";

const IDLE_MS = 10 * 60 * 1000; // salir, with no windows, closed after this (a background engine's)

// Whether process `pid` is running. (kill -0, not /proc/<pid>: Deno refuses that without
// every permission, and the engine hasn't them: it would seem never to be.)
const alive = (pid) => new Deno.Command("kill", { args: ["-0", String(pid)], stdin: "null", stdout: "null", stderr: "null" }).output().then((o) => o.success, () => false);
const isProgram = (path) => Deno.stat(path).then((s) => s.isFile && (s.mode ?? 0o111) & 0o111, () => false);

/** salir's program: PHIL_SALIR, else on PATH (install.sh's: ~/.local/bin/salir). Null when there's none. */
export async function findSalir() {
  const set = Deno.env.get("PHIL_SALIR");
  if (set) return (await isProgram(set)) ? set : null;
  const home = Deno.env.get("HOME") ?? "/";
  for (const dir of [...(Deno.env.get("PATH") ?? "").split(":"), join(home, ".local/bin")]) {
    if (dir && await isProgram(join(dir, "salir"))) return join(dir, "salir");
  }
  return null;
}

/** phil's mpv plugin for salir: PHIL_SALIR_MPV, else installed (~/.local/lib/phil), else built here. */
export async function findMpvPlugin() {
  const home = Deno.env.get("HOME") ?? "/";
  const candidates = [Deno.env.get("PHIL_SALIR_MPV"), join(home, ".local/lib/phil/salir-mpv.so"), new URL("../native/salir-mpv/salir-mpv.so", import.meta.url).pathname];
  for (const path of candidates) {
    if (path && await Deno.stat(path).then((s) => s.isFile, () => false)) return path;
  }
  return null;
}

/**
 * The engine's windows, in salir (`program`, from findSalir). run() resolves
 * once it quits.
 */
export function createApp({ name, program, ephemeral = false, keepRunning = false, trustCertificate = null, trace = () => {}, onOpenRequest = () => {} }) {
  const runtime = Deno.env.get("XDG_RUNTIME_DIR") || "/tmp";
  const stateHome = Deno.env.get("XDG_STATE_HOME") || join(Deno.env.get("HOME") ?? "/", ".local/state");
  const tempDir = join(runtime, `phil-salir-${Deno.pid}`);
  const ownProfile = ephemeral ? join(tempDir, "profile") : join(stateHome, "phil", "salir");
  let profile = ownProfile;
  let session = null; // {send, closed}: salir running, once it's said it's ready
  let starting = null;
  let nextWindow = 1, retiring = false, stopped = false, idleTimer = 0;
  const windows = new Map(); // id -> { appId, opener?, request? } of the windows open (opener: the window that asked for it)
  const placer = createPlacer();
  const { promise: done, resolve: finish } = Promise.withResolvers();

  // salir, started when the first window opens (and again if it went).
  function start() {
    if (session) return Promise.resolve(session);
    starting ??= (async () => {
      await Deno.mkdir(tempDir, { recursive: true, mode: 0o700 });
      // The profile in use by another engine's salir (one retired, its windows still open; or one
      // started at the same moment): a profile of its own then, for this run.
      profile = ownProfile;
      if (!ephemeral && await inUse(ownProfile)) {
        profile = join(tempDir, "profile");
        trace("profile in use by another salir: a temporary one");
      }
      await Deno.mkdir(profile, { recursive: true, mode: 0o700 }).catch(() => {});
      const plugin = await findMpvPlugin();
      trace(plugin ? `mpv plugin: ${plugin}` : "no mpv plugin");
      const args = ["--control", "--data", profile, ...(plugin ? ["--plugin", `mpv=${plugin}`] : [])];
      const child = new Deno.Command(program, { args, stdin: "piped", stdout: "piped", stderr: "inherit" }).spawn();
      const writer = child.stdin.getWriter();
      const encoder = new TextEncoder();
      const { promise: ready, resolve: isReady } = Promise.withResolvers();
      const s = {
        closed: false,
        send: (command) => (s.closed ? Promise.resolve() : writer.write(encoder.encode(JSON.stringify(command) + "\n")).catch(() => {})),
      };
      // Its events, a line each.
      (async () => {
        let pending = "";
        const decoder = new TextDecoder();
        try {
          for await (const chunk of child.stdout) {
            pending += decoder.decode(chunk, { stream: true });
            for (let nl; (nl = pending.indexOf("\n")) !== -1;) {
              const line = pending.slice(0, nl);
              pending = pending.slice(nl + 1);
              let event;
              try {
                event = JSON.parse(line);
              } catch {
                continue;
              }
              if (event.ready) isReady();
              else onEvent(event);
            }
          }
        } catch { /* gone */ }
      })();
      child.status.then(() => {
        s.closed = true;
        isReady();
        if (session === s) session = null;
        windows.clear();
        trace("salir gone");
        if (!keepRunning || retiring) stop();
      });
      s.exited = child.status;
      s.pid = child.pid;
      await ready;
      if (s.closed) throw new Error("it stopped as it started");
      if (trustCertificate) await s.send({ trust_certificate: trustCertificate });
      trace(`salir started: ${program}`);
      session = s;
      return s;
    })().finally(() => (starting = null));
    return starting;
  }

  // Whether a running salir has `dir` (CEF's SingletonLock in it: "<host>-<pid>", that pid alive).
  async function inUse(dir) {
    const lock = await Deno.readLink(join(dir, "SingletonLock")).catch(() => null);
    const pid = /-(\d+)$/.exec(lock ?? "")?.[1];
    return !!pid && await alive(pid);
  }

  function onEvent(event) {
    if (event.closed) {
      const w = windows.get(event.closed);
      windows.delete(event.closed);
      if (w?.request && windows.has(w.opener)) session?.send({ send: { window: w.opener, message: { phil: "closed", request: w.request } } });
      trace(`window ${event.closed} closed`);
      if (windows.size > 0) return;
      if (!keepRunning || retiring) return void stop();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => windows.size === 0 && session?.send({ quit: true }), IDLE_MS);
    } else if (event.message) {
      // A page's window.salir.send(): {phil: "ready", detail?} or {phil: "close"} (kit.js).
      const { window, message } = event.message;
      if (message?.phil === "ready") trace(`page ${window} ready ${message.detail ?? ""}`);
      else if (message?.phil === "close") session?.send({ close: window });
      else if (message?.phil === "open") onOpenRequest(window, message); // (another app's window over this one: kit.js openOver)
      else if (message?.phil === "tell") tellOpener(window, message.message); // (kit.js tellParent)
    } else if (event.error) console.error(`${name}: salir: ${event.error}`);
  }

  // To the window `id` was opened over (its page's openOver), what `id`'s page tells it.
  function tellOpener(id, message) {
    const w = windows.get(id);
    if (w?.request && windows.has(w.opener)) session?.send({ send: { window: w.opener, message: { phil: "told", request: w.request, message } } });
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(idleTimer);
    const s = session;
    session = null;
    if (s && !s.closed) {
      await s.send({ quit: true });
      await Promise.race([s.exited, new Promise((r) => setTimeout(r, 5000))]); // done with its profile
    }
    await Deno.remove(tempDir, { recursive: true }).catch(() => {}); // (incognito's profile, a borrowed one)
    finish();
  }

  // Stopped by a signal: salir closed, the temporary folder gone. (One an engine that
  // died left behind is gone at the next start: those of engines no longer running.)
  for (const signal of ["SIGTERM", "SIGINT"]) Deno.addSignalListener(signal, () => stop().then(() => Deno.exit(0)));
  (async () => {
    for await (const e of Deno.readDir(runtime)) {
      const pid = /^phil-salir-(\d+)$/.exec(e.name)?.[1];
      if (pid && pid !== String(Deno.pid) && !(await alive(pid))) {
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
     * Opens a window on `url` (an app's server's, with its session token), its class `appId`;
     * `embeds`: composited (its page can hold embeds), not Chromium's own; `over`: { opener,
     * request }, asked for by window `opener`'s page, over it (kit.js openOver).
     */
    async openWindow(url, { appId, embeds = false, over = null }) {
      if (stopped) return;
      let s;
      try {
        s = await start();
      } catch (err) {
        return console.error(`${name}: couldn't start salir (${program}): ${err.message}`);
      }
      clearTimeout(idleTimer);
      const id = String(nextWindow++);
      windows.set(id, { appId, opener: over?.opener, request: over?.request });
      const title = over ? await placer.attach({ pid: s.pid }) : null;
      // (files: its page may have local files as File objects, salir.files: phil's files dragged out as files.)
      await s.send({ open: { id, url, app_id: appId, direct: !embeds, files: true, ...(title ? { initial_title: title } : {}) } });
      trace(`window ${id} opened`);
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
