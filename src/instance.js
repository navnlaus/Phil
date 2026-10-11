// One phil process ("instance") serves all windows of a kind; `phil ...`
// first asks a running instance over a Unix socket to open a window and only
// becomes the instance itself when there is none. Normal and incognito
// windows never share one: they have separate sockets, so separate servers,
// tokens and WebKit sessions. Instances started with non-default options
// (--thumb-dir, --thumb-size, --jobs, --port) get their own socket as well.
//
// Protocol: one JSON object per line, answered with one JSON line.
//   {"open": {"dir": path|null, "select": [paths]}, "startupId": str}
//   {"retire": true}   stop taking windows; exit once the open ones close
//   {"quit": true}     close all windows and exit

import { join } from "@std/path";

export function socketDir() {
  return join(Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp", "phil");
}

export function socketPath(config) {
  const base = config.incognito ? "incognito" : "main";
  const custom = { thumbDir: config.thumbDirOption, thumbSize: config.thumbSizeOption, jobs: config.jobsOption, port: config.portOption };
  const variant = Object.values(custom).some((v) => v !== undefined) ? `-${hash(JSON.stringify(custom))}` : "";
  return join(socketDir(), `${base}${variant}.sock`);
}

function hash(s) {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(s)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/**
 * Sends a request to the instance on `path`. Resolves to its reply, or null if
 * no instance is running there (a socket left by a crashed one is removed).
 */
export async function ask(path, message, timeoutMs = 5000) {
  let conn;
  try {
    conn = await Deno.connect({ transport: "unix", path });
  } catch (err) {
    if (err instanceof Deno.errors.ConnectionRefused) await Deno.remove(path).catch(() => {});
    if (err instanceof Deno.errors.NotFound || err instanceof Deno.errors.ConnectionRefused) return null;
    throw err;
  }
  try {
    await conn.write(new TextEncoder().encode(JSON.stringify(message) + "\n"));
    const timer = setTimeout(() => conn.close(), timeoutMs);
    const line = await readLine(conn);
    clearTimeout(timer);
    if (line === null) throw new Error("the running phil didn't answer");
    return JSON.parse(line);
  } finally {
    try {
      conn.close();
    } catch { /* closed by the timeout */ }
  }
}

async function readLine(conn) {
  const decoder = new TextDecoder();
  const buf = new Uint8Array(4096);
  let text = "";
  for (;;) {
    const n = await conn.read(buf).catch(() => null);
    if (n === null) return text || null;
    text += decoder.decode(buf.subarray(0, n), { stream: true });
    const nl = text.indexOf("\n");
    if (nl !== -1) return text.slice(0, nl);
  }
}

/**
 * Listens on `path` and calls onMessage(message) for each request (in the
 * server worker). Returns false if another instance already has the socket.
 */
export async function listen(path, onMessage) {
  await Deno.mkdir(socketDir(), { recursive: true, mode: 0o700 });
  let listener;
  try {
    listener = Deno.listen({ transport: "unix", path });
  } catch (err) {
    if (err instanceof Deno.errors.AddrInUse) return false;
    throw err;
  }
  // Retiring frees the socket for a newer phil, but only if it's still ours.
  const ownInode = (await Deno.lstat(path)).ino;
  async function stopListening() {
    listener.close();
    if ((await Deno.lstat(path).catch(() => null))?.ino === ownInode) await Deno.remove(path).catch(() => {});
  }
  (async () => {
    for await (const conn of listener) {
      (async () => {
        try {
          const line = await readLine(conn);
          const reply = line ? await onMessage(JSON.parse(line), { stopListening }) : { error: "empty request" };
          await conn.write(new TextEncoder().encode(JSON.stringify(reply ?? { ok: true }) + "\n"));
        } catch (err) {
          console.error(`phil: control request failed: ${err.message}`);
        } finally {
          try {
            conn.close();
          } catch { /* already closed */ }
        }
      })();
    }
  })();
  return true;
}
