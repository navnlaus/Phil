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
// alone. Pages talk to the engine through window.salir (kit.js): "ready", "close".
//
// The window's class (Wayland app id), for window rules: the app's (phil,
// phil-choose, phil-incognito...).

import { join } from "@std/path";

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

/**
 * The engine's windows, in salir (`program`, from findSalir). run() resolves
 * once it quits.
 */
export function createApp({ name, program, ephemeral = false, keepRunning = false, trustCertificate = null, trace = () => {} }) {
  const runtime = Deno.env.get("XDG_RUNTIME_DIR") || "/tmp";
  const stateHome = Deno.env.get("XDG_STATE_HOME") || join(Deno.env.get("HOME") ?? "/", ".local/state");
  const tempDir = join(runtime, `phil-salir-${Deno.pid}`);
  const ownProfile = ephemeral ? join(tempDir, "profile") : join(stateHome, "phil", "salir");
  let profile = ownProfile;
  let session = null; // {send, closed}: salir running, once it's said it's ready
  let starting = null;
  let nextWindow = 1, retiring = false, stopped = false, idleTimer = 0;
  const windows = new Set(); // ids of the windows open
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
      const child = new Deno.Command(program, { args: ["--control", "--data", profile], stdin: "piped", stdout: "piped", stderr: "inherit" }).spawn();
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
      windows.delete(event.closed);
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
    } else if (event.error) console.error(`${name}: salir: ${event.error}`);
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

    /** Opens a window on `url` (an app's server's, with its session token), its class `appId`. */
    async openWindow(url, { appId }) {
      if (stopped) return;
      let s;
      try {
        s = await start();
      } catch (err) {
        return console.error(`${name}: couldn't start salir (${program}): ${err.message}`);
      }
      clearTimeout(idleTimer);
      const id = String(nextWindow++);
      windows.add(id);
      await s.send({ open: { id, url, app_id: appId, direct: true } });
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
