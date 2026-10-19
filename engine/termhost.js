// A terminal kept apart from the engine (phil's terminal panel): its shell on a
// pseudo-terminal, in a process of its own (phil-engine --term-host), detached,
// on a Unix socket in a folder of the profile's (instance.js). The engine
// connects to it to show it; one that's been put in the background (Super+°)
// goes on running with no one connected, through the engine's restarts too, as
// screen's and tmux's sessions do, and a restarted engine finds it by its
// socket. What it last wrote (up to MAX_REPLAY) is kept, and given to whoever
// connects, before what follows: the screen as it was, the scrollback too.
//
// Frames both ways: a type byte (DATA: terminal bytes; JSON: a message) and a
// length (u32, big-endian). The first from a client says what it wants:
//   {attach: true}  the terminal: the replay, {replayed: true, atPrompt, keep}
//                   (atPrompt: the shell's at its prompt, nothing else runs
//                   there; keep: it's one in the background), then the rest;
//                   then {resize: [cols, rows]}, {keep: true} (in the background:
//                   goes on when this client goes), and DATA as input. Another
//                   client that attaches takes it over (the one before hears
//                   {taken: true}).
//   {info: true}    {info: {id, pid, command, cwd, started, attached, keep, keptAt,
//                   title}} (title: the last one a program set, OSC 0/2: Claude
//                   Code's is its session's name)
//   {kill: true}    the shell hung up, the host gone
// Not kept, the host ends when its client goes (the panel closed, the window,
// the engine); in any case when the shell does.

import { join } from "@std/path";
import { Pty } from "./pty.js";

export const DATA = 0;
export const JSON_FRAME = 1;
const MAX_REPLAY = 1 << 20; // bytes of output kept for a client that attaches

/** A frame's bytes. */
export function frame(type, payload) {
  const body = type === JSON_FRAME ? new TextEncoder().encode(JSON.stringify(payload)) : payload;
  const out = new Uint8Array(5 + body.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, body.length);
  out.set(body, 5);
  return out;
}

/** The frames read from `conn`, as {type, data} (data: bytes, or the message). */
export async function* frames(conn) {
  let pending = new Uint8Array(0);
  for await (const chunk of conn.readable) {
    const joined = new Uint8Array(pending.length + chunk.length);
    joined.set(pending);
    joined.set(chunk, pending.length);
    pending = joined;
    while (pending.length >= 5) {
      const length = new DataView(pending.buffer, pending.byteOffset).getUint32(1);
      if (pending.length < 5 + length) break;
      const type = pending[0], body = pending.slice(5, 5 + length);
      pending = pending.slice(5 + length);
      yield { type, data: type === JSON_FRAME ? JSON.parse(new TextDecoder().decode(body)) : body };
    }
  }
}

// What a process runs and where (ps, readlink: Deno reads no /proc/<pid> of
// another process without every permission).
async function run(cmd, args) {
  const out = await new Deno.Command(cmd, { args, stdin: "null", stdout: "piped", stderr: "null" }).output().catch(() => null);
  return out?.success ? new TextDecoder().decode(out.stdout).trim() : "";
}

/** The host itself: `job` from the engine (apps/phil/server.js). Runs till the shell's gone. */
export async function termHost({ id, dir, command, cwd, env = {}, cols = 80, rows = 24 }) {
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${id}.sock`);
  const pty = new Pty(command, { cwd, env, cols, rows });
  const started = Date.now();
  const listener = Deno.listen({ transport: "unix", path });
  await Deno.chmod(path, 0o600).catch(() => {});
  let client = null; // { conn, send }
  let keep = false, keptAt = 0; // (keptAt: when first put in the background, its place among them)
  const replay = [];
  let replaySize = 0;
  // The terminal's title, as programs set it (ESC ] 0 or 2 ; title BEL or ESC \), across chunks.
  let title = "", titleAt = 0, titleCarry = "";
  const decoder = new TextDecoder();
  const noteTitle = (chunk) => {
    const text = titleCarry + decoder.decode(chunk, { stream: true });
    // deno-lint-ignore no-control-regex
    for (const m of text.matchAll(/\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) (title = m[1]), (titleAt = Date.now());
    const open = text.lastIndexOf("\x1b]");
    // deno-lint-ignore no-control-regex
    titleCarry = open !== -1 && !/\x07|\x1b\\/.test(text.slice(open)) ? text.slice(open).slice(-1024) : "";
  };

  const end = async () => {
    try {
      listener.close();
    } catch { /* closed */ }
    await Deno.remove(path).catch(() => {});
    if (env.PHIL_CD_FILE) await Deno.remove(env.PHIL_CD_FILE).catch(() => {});
    Deno.exit(0);
  };

  // The shell's output: kept (the last MAX_REPLAY bytes), and to the client.
  (async () => {
    for await (const chunk of pty.output()) {
      noteTitle(chunk);
      replay.push(chunk);
      replaySize += chunk.length;
      while (replaySize > MAX_REPLAY && replay.length > 1) replaySize -= replay.shift().length;
      client?.send(frame(DATA, chunk));
    }
    client?.send(frame(JSON_FRAME, { exited: true }));
    await client?.flushed;
    await end();
  })();

  for await (const conn of listener) {
    const writer = conn.writable.getWriter();
    const c = {
      conn,
      flushed: Promise.resolve(),
      send(bytes) {
        this.flushed = this.flushed.then(() => writer.write(bytes)).catch(() => {});
      },
    };
    (async () => {
      let attached = false;
      try {
        for await (const { type, data } of frames(conn)) {
          if (type === DATA) {
            if (attached) await pty.write(data);
            continue;
          }
          if (data.info) {
            const pid = pty.child.pid;
            const fg = Number(await run("ps", ["-o", "tpgid=", "-p", String(pid)])) || pid; // the terminal's foreground process
            // The title, if it's the program's in the foreground: set since it started (not one the
            // shell set before it, at its prompt: ssh running a command there sets none).
            const [uptime, stat] = (await run("cat", ["/proc/uptime", `/proc/${fg}/stat`])).split("\n");
            const ticks = Number(stat?.slice(stat.lastIndexOf(")") + 2).split(" ")[19]); // (starttime, in 1/100 s since boot)
            const fgStarted = Date.now() - (parseFloat(uptime) - ticks / 100) * 1000;
            const current = !Number.isFinite(fgStarted) || titleAt >= fgStarted;
            const info = { id, pid, command: await run("ps", ["-o", "args=", "-p", String(fg)]), cwd: await run("readlink", [`/proc/${fg}/cwd`]), started, attached: !!client, keep, keptAt, title: current ? title : "" };
            c.send(frame(JSON_FRAME, { info }));
            await c.flushed;
            return conn.close();
          }
          if (data.kill) return void pty.close();
          if (data.attach) {
            if (client) {
              const before = client;
              before.send(frame(JSON_FRAME, { taken: true }));
              before.flushed.then(() => {
                try {
                  before.conn.close(); // (taken over)
                } catch { /* gone */ }
              });
            }
            client = c;
            attached = true;
            for (const chunk of replay) c.send(frame(DATA, chunk));
            const pid = pty.child.pid;
            const fg = Number(await run("ps", ["-o", "tpgid=", "-p", String(pid)])) || pid;
            c.send(frame(JSON_FRAME, { replayed: true, atPrompt: fg === pid, keep }));
          }
          if (data.resize) pty.resize(data.resize[0], data.resize[1]);
          if (data.keep !== undefined) {
            keep = !!data.keep;
            if (keep && !keptAt) keptAt = Date.now();
          }
        }
      } catch { /* gone */ }
      if (client !== c) return;
      client = null;
      if (!keep) pty.close(); // (its output ends, and with it the host)
    })();
  }
}
