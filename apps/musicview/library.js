// musicview's library: the songs in the folders marked as music (a folder's
// Properties in phil: "A music folder"), every one in them and their
// subfolders, by their tags (title, artist, album...: ffprobe, phil's
// audio.js), and the radio stations; in an SQLite database
// (~/.local/state/phil/music.sqlite; node:sqlite, as mediaview's store.js).
//
// A scan walks the music folders: a song not seen before, or changed (its size
// or time), is read; one no longer there goes. A music folder that isn't there
// now (a drive unplugged) keeps its songs (shown as away) till it's back.
// Incognito: read, never written.
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "@std/path";
import { mediaKind } from "../../engine/media.js";
import { readAudio } from "../phil/audio.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS songs (
    path TEXT PRIMARY KEY, root TEXT NOT NULL, size INTEGER, mtime INTEGER, added INTEGER,
    title TEXT, artist TEXT, album TEXT, album_artist TEXT, track INTEGER, disc INTEGER,
    year INTEGER, genre TEXT, duration REAL, cover INTEGER);
  CREATE INDEX IF NOT EXISTS songs_root ON songs (root);
  CREATE TABLE IF NOT EXISTS stations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, description TEXT, genre TEXT,
    homepage TEXT, image TEXT, now_playing TEXT, pos REAL);
  CREATE TABLE IF NOT EXISTS kv (name TEXT PRIMARY KEY, value TEXT); -- view (how it was left), somafm (its stations added)
`;
const READ_AT_ONCE = 4; // songs' tags read at once while scanning

// Files added, moved or removed (phil's copies, moves and deletes; files sent from
// the phone): musicview's server reads its music folders again when they're in one.
// One list for both: they run in the same worker.
const changeListeners = new Set();
export function onFilesChanged(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}
export function filesChanged(paths) {
  for (const fn of changeListeners) fn(paths);
}

export class Library {
  #db;
  #write;

  constructor(file, { write = true } = {}) {
    this.#write = write;
    try {
      Deno.mkdirSync(dirname(file), { recursive: true });
      this.#db = new DatabaseSync(file);
      this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;" + SCHEMA);
    } catch {
      this.#db = new DatabaseSync(":memory:"); // (a state folder that can't be written: this session's)
      this.#db.exec(SCHEMA);
    }
  }

  // ---------------------------------------------------------------- songs

  /** Every song: [{path, root, title, artist, album, albumArtist, track, disc, year, genre, duration, cover, added, mtime}]. */
  songs() {
    return this.#db.prepare("SELECT * FROM songs").all().map((r) => ({
      path: r.path, root: r.root, title: r.title, artist: r.artist, album: r.album, albumArtist: r.album_artist,
      track: r.track, disc: r.disc, year: r.year, genre: r.genre, duration: r.duration, cover: !!r.cover, added: r.added, mtime: r.mtime,
    }));
  }

  /** path -> "size mtime", a music folder's songs as last read. */
  known(root) {
    return new Map(this.#db.prepare("SELECT path, size, mtime FROM songs WHERE root = ?").all(root).map((r) => [r.path, `${r.size} ${r.mtime}`]));
  }

  put(root, path, stat, info) {
    if (!this.#write) return;
    const t = info?.tags ?? {};
    const num = (v) => Number.parseInt(String(v ?? "").split("/")[0], 10) || null;
    const old = this.#db.prepare("SELECT added FROM songs WHERE path = ?").get(path);
    this.#db.prepare("INSERT OR REPLACE INTO songs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      path, root, stat.size, stat.mtime?.getTime() ?? 0, old?.added ?? Date.now(),
      t.title || null, t.artist || null, t.album || null, t.album_artist || null, num(t.track), num(t.disc),
      num(String(t.date ?? t.year ?? "").slice(0, 4)), t.genre || null, info?.duration ?? null, info?.cover ? 1 : 0,
    );
  }

  remove(paths) {
    if (!this.#write) return;
    const del = this.#db.prepare("DELETE FROM songs WHERE path = ?");
    for (const p of paths) del.run(p);
  }

  /** The songs of folders that are no longer music folders go. */
  keepRoots(roots) {
    if (!this.#write) return;
    for (const { root } of this.#db.prepare("SELECT DISTINCT root FROM songs").all()) {
      if (!roots.includes(root)) this.#db.prepare("DELETE FROM songs WHERE root = ?").run(root);
    }
  }

  // ---------------------------------------------------------------- radio

  stations() {
    return this.#db.prepare("SELECT * FROM stations ORDER BY pos, name COLLATE NOCASE").all().map((r) => ({
      id: r.id, name: r.name, url: r.url, description: r.description, genre: r.genre, homepage: r.homepage, image: r.image, nowPlaying: r.now_playing,
    }));
  }

  station(id) {
    return this.stations().find((s) => s.id === id) ?? null;
  }

  /** A station added (a new id) or changed (the same id). */
  putStation(s) {
    if (!this.#write) return;
    const pos = this.#db.prepare("SELECT pos FROM stations WHERE id = ?").get(s.id)?.pos ?? (this.#db.prepare("SELECT MAX(pos) AS m FROM stations").get()?.m ?? 0) + 1;
    this.#db.prepare("INSERT OR REPLACE INTO stations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      s.id, s.name, s.url, s.description ?? null, s.genre ?? null, s.homepage ?? null, s.image ?? null, s.nowPlaying ?? null, pos,
    );
  }

  removeStation(id) {
    if (this.#write) this.#db.prepare("DELETE FROM stations WHERE id = ?").run(id);
  }

  get(name) {
    return this.#db.prepare("SELECT value FROM kv WHERE name = ?").get(name)?.value ?? null;
  }

  set(name, value) {
    if (this.#write) this.#db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(name, value);
  }
}

/**
 * Scans the music folders `roots` into `library`: new and changed songs read,
 * ones gone removed. `progress({root, done, total})` as it reads. Resolves to
 * {read, removed}; stops early when `signal` aborts.
 */
export async function scan(library, roots, { progress = () => {}, signal } = {}) {
  library.keepRoots(roots);
  let read = 0, removed = 0;
  for (const root of roots) {
    if (!(await Deno.stat(root).then((s) => s.isDirectory, () => false))) continue; // (away: its songs kept)
    const known = library.known(root);
    const found = [];
    await walk(root, found, signal);
    const here = new Set(found.map((f) => f.path));
    const gone = [...known.keys()].filter((p) => !here.has(p));
    library.remove(gone);
    removed += gone.length;
    const todo = found.filter((f) => known.get(f.path) !== `${f.stat.size} ${f.stat.mtime?.getTime() ?? 0}`);
    let next = 0, done = 0;
    const worker = async () => {
      while (next < todo.length && !signal?.aborted) {
        const f = todo[next++];
        const info = await readAudio(f.path).catch(() => null);
        library.put(root, f.path, f.stat, info);
        done++;
        read++;
        if (done % 10 === 0 || done === todo.length) progress({ root, done, total: todo.length });
      }
    };
    if (todo.length) progress({ root, done: 0, total: todo.length });
    await Promise.all(Array.from({ length: READ_AT_ONCE }, worker));
  }
  return { read, removed };
}

// Every song under `dir` (hidden files and folders left out): {path, stat}.
async function walk(dir, out, signal) {
  let entries;
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch {
    return; // (can't be read)
  }
  for (const e of entries) {
    if (signal?.aborted) return;
    if (e.name.startsWith(".")) continue;
    const path = join(dir, e.name);
    if (e.isDirectory) await walk(path, out, signal);
    else if (mediaKind(e.name) === "audio") {
      const stat = await Deno.stat(path).catch(() => null);
      if (stat?.isFile) out.push({ path, stat });
    }
  }
}
