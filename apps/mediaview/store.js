// mediaview's own data, in an SQLite database (~/.local/state/phil/media.sqlite;
// node:sqlite, as IMDb's in imdb.js): what's been put right by hand (fixes),
// the media folders' files when last seen (for a drive unplugged), the titles
// matched (media.js), the library as last shown (opened again, it shows at
// once), and the titles taken off Continue watching. Each change writes what changed, not the whole. The JSON files it
// replaces (media.json, media-matches.json, media-library.json, next to it)
// are read in once and removed. Incognito: read, never written.
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "@std/path";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS fixes (key TEXT PRIMARY KEY, id INTEGER NOT NULL); -- 0: not a movie or show
  CREATE TABLE IF NOT EXISTS files (root TEXT NOT NULL, path TEXT PRIMARY KEY, size INTEGER, mtime INTEGER);
  CREATE INDEX IF NOT EXISTS files_root ON files (root);
  CREATE TABLE IF NOT EXISTS matches (key TEXT PRIMARY KEY, id INTEGER, sure INTEGER); -- id null: none found
  CREATE TABLE IF NOT EXISTS dismissed (key TEXT PRIMARY KEY, at INTEGER NOT NULL); -- off Continue watching, as of when it was last watched
  CREATE TABLE IF NOT EXISTS kv (name TEXT PRIMARY KEY, value TEXT); -- built (the IMDb database matches are from), last (the library), view (how it was left)
`;

export class Store {
  #db;
  #write;
  #last = null; // the library as last written (JSON), so it's written only when it changed

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
    if (write) this.#importJson(dirname(file));
  }

  /** key -> IMDb id (0: left out). */
  fixes() {
    return Object.fromEntries(this.#db.prepare("SELECT key, id FROM fixes").all().map((r) => [r.key, r.id]));
  }

  /** What files named so are, by hand (an IMDb id; 0: none, left out); null: matched again. */
  setFix(key, id) {
    if (!this.#write) return;
    if (id === null) this.#db.prepare("DELETE FROM fixes WHERE key = ?").run(key);
    else this.#db.prepare("INSERT OR REPLACE INTO fixes VALUES (?, ?)").run(key, id);
  }

  /** root -> its files when last seen ([{path, size, mtime}]). */
  remembered() {
    const out = {};
    for (const r of this.#db.prepare("SELECT root, path, size, mtime FROM files").all()) (out[r.root] ??= []).push({ path: r.path, size: r.size, mtime: r.mtime });
    return out;
  }

  /** A media folder's files as they are now (what isn't there any more goes; what's new comes). */
  remember(root, files) {
    if (!this.#write) return;
    const now = new Map(files.map((f) => [f.path, f]));
    const had = new Map(this.#db.prepare("SELECT path, size, mtime FROM files WHERE root = ?").all(root).map((r) => [r.path, r]));
    const gone = [...had.keys()].filter((p) => !now.has(p));
    const changed = files.filter((f) => had.get(f.path)?.size !== f.size || had.get(f.path)?.mtime !== f.mtime);
    if (!gone.length && !changed.length) return;
    this.#transaction(() => {
      const del = this.#db.prepare("DELETE FROM files WHERE path = ?"), put = this.#db.prepare("INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?)");
      for (const p of gone) del.run(p);
      for (const f of changed) put.run(root, f.path, f.size ?? 0, f.mtime ?? 0);
    });
  }

  /** A media folder no longer one: what was remembered of it goes. */
  forget(root) {
    if (this.#write) this.#db.prepare("DELETE FROM files WHERE root = ?").run(root);
  }

  /** The titles matched, as media.js keeps them: {built, items: key -> [id, sure] | 0}. */
  matches() {
    const built = this.#get("built");
    const items = {};
    for (const r of this.#db.prepare("SELECT key, id, sure FROM matches").all()) items[r.key] = r.id === null ? 0 : [r.id, !!r.sure];
    return { built: built === null ? null : Number(built), items };
  }

  /** The titles matched now (all of them; only what changed is written). */
  saveMatches({ built, items }) {
    if (!this.#write) return;
    const had = this.matches();
    this.#transaction(() => {
      if (had.built !== built) this.#db.exec("DELETE FROM matches"), this.#set("built", String(built));
      const put = this.#db.prepare("INSERT OR REPLACE INTO matches VALUES (?, ?, ?)");
      for (const [key, m] of Object.entries(items)) {
        const old = had.built === built ? had.items[key] : undefined;
        if (old !== undefined && JSON.stringify(old) === JSON.stringify(m)) continue;
        put.run(key, m ? m[0] : null, m ? (m[1] ? 1 : 0) : null);
      }
    });
  }

  /** Titles taken off Continue watching: key -> when they'd last been watched then (watched again since: back on it). */
  dismissed() {
    return Object.fromEntries(this.#db.prepare("SELECT key, at FROM dismissed").all().map((r) => [r.key, r.at]));
  }

  dismiss(key, at) {
    if (this.#write) this.#db.prepare("INSERT OR REPLACE INTO dismissed VALUES (?, ?)").run(key, at);
  }

  /** How mediaview was left: {tab, genre: {movies, shows}, sort, reverse, layout}. */
  view() {
    try {
      return JSON.parse(this.#get("view") ?? "{}");
    } catch {
      return {};
    }
  }

  setView(view) {
    if (this.#write) this.#set("view", JSON.stringify(view));
  }

  /** The library as last shown, or null. */
  last() {
    const json = this.#get("last");
    this.#last = json;
    try {
      return json ? JSON.parse(json) : null;
    } catch {
      return null;
    }
  }

  setLast(library) {
    if (!this.#write) return;
    const json = JSON.stringify(library);
    if (json === this.#last) return;
    this.#last = json;
    this.#set("last", json);
  }

  #get(name) {
    return this.#db.prepare("SELECT value FROM kv WHERE name = ?").get(name)?.value ?? null;
  }

  #set(name, value) {
    this.#db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(name, value);
  }

  #transaction(fn) {
    this.#db.exec("BEGIN");
    try {
      fn();
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  // The JSON files this replaces (an earlier mediaview's): read in, then removed.
  #importJson(dir) {
    const read = (name) => {
      try {
        return JSON.parse(Deno.readTextFileSync(join(dir, name)));
      } catch {
        return null;
      }
    };
    const state = read("media.json"), matches = read("media-matches.json"), last = read("media-library.json");
    if (state) {
      for (const [key, id] of Object.entries(state.fixes ?? {})) this.setFix(key, id);
      for (const [root, files] of Object.entries(state.remembered ?? {})) this.remember(root, files);
    }
    if (matches?.items) this.saveMatches(matches);
    if (last) this.setLast(last);
    for (const name of ["media.json", "media-matches.json", "media-library.json"]) {
      try {
        Deno.removeSync(join(dir, name));
      } catch { /* not there */ }
    }
  }
}
