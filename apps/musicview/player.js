// musicview's player: in the engine, not in a page, so music goes on with no
// window open (the engine keeps running after its windows close). mpv plays
// (no video; driven over its JSON IPC socket); its MPRIS script, where it's
// installed, gives the media keys and the desktop's "now playing" too. The
// queue (Next up), shuffle and repeat are here; musicview's page, phil's
// sidebar player and `musicview` on the command line all drive this one.
//
// mpv is started with the first song, through a shell that kills it when the
// engine's end of its stdin closes: the engine gone, however it went, the music
// stops with it.
import { join } from "@std/path";
import { nowPlaying } from "./radio.js";

const RADIO_NOW_MS = 20_000; // what's playing on a station, asked again after
const TELL_MS = 1000; // the position told at most this often

export class Player {
  queue = []; // [{song}|{station}]: song {path, title, artist, album, cover, duration}
  at = -1;
  paused = false;
  position = 0;
  duration = null;
  volume = 80;
  shuffle = false;
  repeat = "off"; // off, all, one
  radioNow = null; // what's playing on the station: {title, artist, album}

  #onChange;
  #mpv = null; // {child, conn, writer}
  #requests = new Map();
  #nextId = 1;
  #told = 0;
  #tellTimer = null;
  #radioTimer = null;

  constructor({ onChange, runtimeDir, volume = 80, shuffle = false, repeat = "off" }) {
    this.#onChange = onChange;
    this.runtimeDir = runtimeDir;
    Object.assign(this, { volume, shuffle, repeat });
  }

  /** What every page shows. */
  state() {
    const item = this.queue[this.at] ?? null;
    return {
      now: item ? (item.song ? { song: item.song } : { station: item.station, playing: this.radioNow }) : null,
      at: this.at,
      queue: this.queue.map((q) => (q.song ? { song: { path: q.song.path, title: q.song.title, artist: q.song.artist } } : { station: { id: q.station.id, name: q.station.name } })),
      paused: this.paused, position: this.position, duration: this.duration,
      volume: this.volume, shuffle: this.shuffle, repeat: this.repeat,
    };
  }

  #changed(now = true) {
    clearTimeout(this.#tellTimer);
    const tell = () => {
      this.#told = Date.now();
      this.#onChange(this.state());
    };
    if (now || Date.now() - this.#told >= TELL_MS) tell();
    else this.#tellTimer = setTimeout(tell, TELL_MS - (Date.now() - this.#told));
  }

  // ---------------------------------------------------------------- what's played

  playList(items, i = 0) {
    this.queue = items.map((x) => (x.station ? { station: x.station } : { song: x }));
    if (this.shuffle && this.queue.length > 1) {
      const first = this.queue[i];
      this.queue = [first, ...shuffled(this.queue.filter((q) => q !== first))];
      i = 0;
    }
    return this.playAt(i);
  }

  playStation(station) {
    return this.playList([{ station }], 0);
  }

  async playAt(i) {
    const item = this.queue[i];
    if (!item) return this.stop();
    this.at = i;
    this.position = 0;
    this.duration = item.song?.duration ?? null;
    this.paused = false;
    this.radioNow = null;
    clearInterval(this.#radioTimer);
    this.#changed();
    await this.#command(["loadfile", item.song ? item.song.path : item.station.url, "replace"]);
    await this.#command(["set_property", "pause", false]);
    if (item.station) {
      const ask = async () => {
        const now = await nowPlaying(item.station).catch(() => null);
        if (this.queue[this.at] !== item) return;
        this.radioNow = now;
        this.#changed();
      };
      ask();
      this.#radioTimer = setInterval(ask, RADIO_NOW_MS);
    }
  }

  queueNext(songs) {
    if (this.at < 0) return this.playList(songs, 0);
    this.queue.splice(this.at + 1, 0, ...songs.map((song) => ({ song })));
    this.#changed();
  }

  queueAdd(songs) {
    if (this.at < 0) return this.playList(songs, 0);
    this.queue.push(...songs.map((song) => ({ song })));
    this.#changed();
  }

  remove(i) {
    if (i <= this.at || i >= this.queue.length) return;
    this.queue.splice(i, 1);
    this.#changed();
  }

  clearNext() {
    this.queue.splice(this.at + 1);
    this.#changed();
  }

  // ---------------------------------------------------------------- controls

  toggle() {
    return this.at < 0 ? Promise.resolve(false) : this.#setPause(!this.paused);
  }

  play() {
    return this.at < 0 ? Promise.resolve(false) : this.#setPause(false);
  }

  pause() {
    return this.at < 0 ? Promise.resolve(false) : this.#setPause(true);
  }

  async #setPause(pause) {
    await this.#command(["set_property", "pause", pause]);
    this.paused = pause;
    this.#changed();
    return true;
  }

  /** The next one (a song's end: `ended`, as repeat says). */
  async next({ ended = false } = {}) {
    const item = this.queue[this.at];
    if (!item) return false;
    if (item.station && !ended) return false; // (a station plays on)
    if (ended && this.repeat === "one") return this.playAt(this.at);
    let i = this.at + 1;
    if (i >= this.queue.length) {
      if (this.repeat !== "all") return ended ? this.stop() : false;
      i = 0;
    }
    await this.playAt(i);
    return true;
  }

  /** Back to the start of this one, a few seconds in; else the one before. */
  async previous() {
    if (this.at < 0) return false;
    if (this.position > 4 && this.queue[this.at]?.song) return this.seek(0);
    const i = this.at - 1 >= 0 ? this.at - 1 : this.repeat === "all" ? this.queue.length - 1 : 0;
    await this.playAt(i);
    return true;
  }

  async seek(seconds) {
    if (!this.queue[this.at]?.song) return false;
    await this.#command(["seek", Math.max(0, seconds), "absolute"]);
    this.position = Math.max(0, seconds);
    this.#changed();
    return true;
  }

  async setVolume(v) {
    this.volume = Math.max(0, Math.min(100, Math.round(v)));
    if (this.#mpv) await this.#command(["set_property", "volume", this.volume]);
    this.#changed();
  }

  setShuffle(on) {
    this.shuffle = !!on;
    // On: what's after this one, shuffled.
    if (this.shuffle && this.at >= 0) this.queue = [...this.queue.slice(0, this.at + 1), ...shuffled(this.queue.slice(this.at + 1))];
    this.#changed();
  }

  setRepeat(mode) {
    if (["off", "all", "one"].includes(mode)) this.repeat = mode;
    this.#changed();
  }

  async stop() {
    clearInterval(this.#radioTimer);
    this.queue = [];
    this.at = -1;
    this.position = 0;
    this.duration = null;
    this.radioNow = null;
    if (this.#mpv) await this.#command(["stop"]).catch(() => {});
    this.#changed();
    return true;
  }

  // ---------------------------------------------------------------- mpv

  // mpv's IPC socket: in the runtime folder, or (its path too long for a socket's: about 108 bytes) a folder of its own in /tmp.
  async #socketPath() {
    let path = join(this.runtimeDir, `musicview-mpv-${Deno.pid}.sock`);
    await Deno.mkdir(this.runtimeDir, { recursive: true, mode: 0o700 }).catch(() => {});
    if (new TextEncoder().encode(path).length > 100) path = join(await Deno.makeTempDir({ prefix: "phil-mpv-" }), "mpv.sock");
    return path;
  }

  async #start() {
    if (this.#mpv) return this.#mpv;
    this.socketPath ??= await this.#socketPath();
    await Deno.remove(this.socketPath).catch(() => {});
    const args = ["--idle=yes", "--no-video", "--no-terminal", "--audio-display=no", "--force-window=no", `--volume=${this.volume}`,
      `--input-ipc-server=${this.socketPath}`, "--title=phil music", "--msg-level=all=error"];
    // (the shell: mpv killed when the engine's end of stdin closes, however the engine went)
    const child = new Deno.Command("sh", { args: ["-c", 'mpv "$@" </dev/null & m=$!; cat >/dev/null; kill $m 2>/dev/null', "sh", ...args], stdin: "piped", stdout: "null", stderr: "null" }).spawn();
    let conn = null;
    for (let i = 0; i < 100 && !conn; i++) {
      await new Promise((r) => setTimeout(r, 50));
      conn = await Deno.connect({ transport: "unix", path: this.socketPath }).catch(() => null);
    }
    const stdin = child.stdin.getWriter();
    if (!conn) {
      await stdin.close().catch(() => {});
      throw new Error("mpv didn't start (is it installed?)");
    }
    const writer = conn.writable.getWriter();
    this.#mpv = { child, conn, writer, stdin };
    child.status.then(() => (this.#mpv?.child === child) && (this.#mpv = null));
    this.#read(conn);
    for (const [i, name] of ["time-pos", "duration", "pause"].entries()) await this.#send({ command: ["observe_property", i + 1, name] });
    return this.#mpv;
  }

  async #command(command) {
    await this.#start();
    return await this.#send({ command });
  }

  #send(message) {
    const id = this.#nextId++;
    const { promise, resolve } = Promise.withResolvers();
    this.#requests.set(id, resolve);
    this.#mpv.writer.write(new TextEncoder().encode(JSON.stringify({ ...message, request_id: id }) + "\n")).catch(() => resolve(null));
    setTimeout(() => this.#requests.delete(id) && resolve(null), 5000);
    return promise;
  }

  async #read(conn) {
    let buf = "";
    try {
      for await (const chunk of conn.readable.pipeThrough(new TextDecoderStream())) {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line) this.#onMessage(JSON.parse(line));
        }
      }
    } catch { /* closed */ }
  }

  #onMessage(m) {
    if (m.request_id && this.#requests.has(m.request_id)) {
      this.#requests.get(m.request_id)(m);
      this.#requests.delete(m.request_id);
      return;
    }
    if (m.event === "property-change") {
      if (m.name === "time-pos" && typeof m.data === "number") (this.position = m.data), this.#changed(false);
      else if (m.name === "duration" && typeof m.data === "number" && this.queue[this.at]?.song) (this.duration = m.data), this.#changed(false);
      else if (m.name === "pause" && typeof m.data === "boolean" && m.data !== this.paused) (this.paused = m.data), this.#changed();
    } else if (m.event === "end-file") { // ("stop": the one another replaced)
      if (m.reason === "eof") this.next({ ended: true });
      else if (m.reason === "error") {
        // A song that can't be played: the next; a station that doesn't answer: stopped there.
        if (this.queue[this.at]?.song) this.next({ ended: true });
        else (this.paused = true), this.#changed();
      }
    }
  }
}

const shuffled = (list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
