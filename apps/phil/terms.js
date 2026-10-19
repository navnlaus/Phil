// The terminal panels' shells, each in a host of its own apart from the engine
// (engine/termhost.js), so one put in the background (Super+°) goes on without
// the window, and the engine: the sidebar's Processes list those, a click
// shows one in a terminal panel again. A restarted engine finds them by their
// sockets, in the profile's folder (its instance socket's, ".terms": incognito
// windows' and a --standalone or --browser run's go with them, never in the
// background).

import { join } from "@std/path";
import { engineCommand } from "../../engine/instance.js";
import { DATA, frame, frames, JSON_FRAME } from "../../engine/termhost.js";

const POLL_MS = 3000; // how often the ones in the background are looked at (what they run, still there)

/**
 * `controlSocket`: the engine's (null: no instance, a --standalone or --browser run);
 * `onChange(list)`: the background ones changed (see list()).
 */
export function createTerms({ controlSocket, incognito, onChange = () => {} }) {
  const runtime = Deno.env.get("XDG_RUNTIME_DIR") || "/tmp";
  const persistent = !!controlSocket && !incognito;
  const dir = persistent ? controlSocket.replace(/\.sock$/, ".terms") : join(runtime, "phil", `terms-${Deno.pid}`);
  let background = []; // [{id, command, cwd, started}]
  let timer = 0;

  const socketOf = (id) => join(dir, `${id}.sock`);

  // A message to a host, and its answer (info), or null if it's not there.
  async function ask(id, message) {
    let conn;
    try {
      conn = await Deno.connect({ transport: "unix", path: socketOf(id) });
    } catch (err) {
      if (err instanceof Deno.errors.ConnectionRefused) await Deno.remove(socketOf(id)).catch(() => {}); // (its host died)
      return null;
    }
    try {
      const writer = conn.writable.getWriter();
      await writer.write(frame(JSON_FRAME, message));
      if (!message.info) return {};
      for await (const { type, data } of frames(conn)) if (type === JSON_FRAME && data.info) return data.info;
      return null;
    } catch {
      return null;
    } finally {
      try {
        conn.close();
      } catch { /* closed */ }
    }
  }

  // The hosts kept in the background with no one showing them.
  async function look() {
    timer = 0;
    if (!persistent) return;
    const ids = [];
    try {
      for await (const e of Deno.readDir(dir)) if (e.name.endsWith(".sock")) ids.push(e.name.slice(0, -5));
    } catch { /* none yet */ }
    const infos = await Promise.all(ids.map((id) => ask(id, { info: true })));
    const now = infos.filter((i) => i && i.keep && !i.attached).map(({ id, command, cwd, started }) => ({ id, command, cwd, started })).sort((a, b) => a.started - b.started);
    if (JSON.stringify(now) !== JSON.stringify(background)) {
      background = now;
      onChange(background);
    }
    if (background.length) timer = setTimeout(look, POLL_MS);
  }
  const lookSoon = (ms = 200) => {
    clearTimeout(timer);
    timer = setTimeout(look, ms);
  };
  look();

  return {
    persistent,
    dir,

    /** The ones in the background: [{id, command (what runs there now), cwd, started}]. */
    list: () => background,

    /**
     * A new host for a shell (`job`: termhost.js's, but its id and dir); resolves to its id
     * once it's listening.
     */
    async start(job) {
      const id = job.id ?? crypto.randomUUID();
      await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
      // Detached (setsid: its own session, no signal of the engine's reaches it), on its own.
      const child = new Deno.Command("setsid", {
        args: [...engineCommand(), "--term-host", JSON.stringify({ ...job, id, dir })],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      child.unref();
      for (let i = 0; i < 100; i++) {
        if (await Deno.stat(socketOf(id)).then(() => true, () => false)) return id;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error("the terminal's host didn't start");
    },

    /**
     * Connected to host `id`'s terminal: `onData(bytes)`, `onMessage(msg)` ({replayed},
     * {exited}), `onClose()`. Returns { write(bytes), send(msg), close() }, or null if
     * there's no such host.
     */
    async attach(id, { onData, onMessage, onClose }) {
      let conn;
      try {
        conn = await Deno.connect({ transport: "unix", path: socketOf(id) });
      } catch {
        return null;
      }
      const writer = conn.writable.getWriter();
      let writing = Promise.resolve();
      const put = (bytes) => (writing = writing.then(() => writer.write(bytes)).catch(() => {}));
      put(frame(JSON_FRAME, { attach: true }));
      (async () => {
        try {
          for await (const { type, data } of frames(conn)) type === DATA ? onData(data) : onMessage(data);
        } catch { /* gone */ }
        onClose();
        lookSoon();
      })();
      lookSoon();
      return {
        write: (bytes) => put(frame(DATA, bytes)),
        send: (message) => put(frame(JSON_FRAME, message)),
        close() {
          writing.then(() => {
            try {
              conn.close();
            } catch { /* closed */ }
            lookSoon();
          });
        },
      };
    },

    /** Ends one in the background (its shell hung up). */
    async kill(id) {
      await ask(id, { kill: true });
      lookSoon();
    },

    /** Looked at again soon (one was just put in the background). */
    refresh: lookSoon,
  };
}
