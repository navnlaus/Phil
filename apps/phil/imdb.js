// IMDb's datasets (https://developer.imdb.com/non-commercial-datasets/, for
// personal and non-commercial use), downloaded and kept as an SQLite
// database in ~/.cache/phil/imdb, for the Media view (media.js): what a
// video file is, matched on this computer, so nothing says what's in the
// library. Titles, years, runtimes, genres, IMDb ratings and votes, and every
// episode of every show. Downloaded when asked (Media view → Update), built in a
// worker (imdb-build.js) so the server keeps answering meanwhile.
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";

const env = (name) => Deno.env.get(name) || null;
export const imdbDir = () => join(env("XDG_CACHE_HOME") ?? join(env("HOME") ?? "/", ".cache"), "phil", "imdb");
const dbFile = () => join(imdbDir(), "imdb.sqlite");

// Titles as they're compared: lower case, no accents or punctuation, "&" as "and".
export function norm(s) {
  return String(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

let db = null;
let building = null; // {phase, done, total} while updating
let failed = null;

function open() {
  if (db) return db;
  try {
    Deno.statSync(dbFile());
  } catch {
    return null;
  }
  db = new DatabaseSync(dbFile(), { readOnly: true });
  return db;
}

/** {ready, built (ms), building: {phase, done, total} | null, error} */
export function status() {
  let built = null;
  try {
    built = Deno.statSync(dbFile()).mtime?.getTime() ?? null;
  } catch { /* none yet */ }
  return { ready: built !== null, built, building, error: failed };
}

/** Downloads the datasets and builds the database again; `onChange()` as it goes. */
export function update(onChange = () => {}) {
  if (building) return;
  building = { phase: "download", done: 0, total: 0 };
  failed = null;
  onChange();
  const worker = new Worker(new URL("./imdb-build.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.progress) return (building = m.progress), onChange();
    worker.terminate();
    building = null;
    if (m.error) failed = m.error;
    else {
      db?.close();
      db = null; // the new one
    }
    onChange();
  };
  worker.onerror = (e) => {
    e.preventDefault();
    worker.terminate();
    building = null;
    failed = e.message;
    onChange();
  };
  worker.postMessage({ dir: imdbDir() });
}

const TITLE = `SELECT t.id, t.type, t.title, t.year, t.end_year AS endYear, t.minutes, t.genres, r.rating, r.votes
  FROM titles t LEFT JOIN ratings r ON r.id = t.id`;

/** Titles called `name` (normalized; their own or original title), most voted first. */
export function lookup(name, { series = null } = {}) {
  const d = open();
  if (!d) return [];
  const types = series === null ? "" : series ? " AND t.type IN ('tvSeries', 'tvMiniSeries')" : " AND t.type NOT IN ('tvSeries', 'tvMiniSeries')";
  return d.prepare(`${TITLE} WHERE t.id IN (SELECT id FROM names WHERE norm = ?)${types} ORDER BY coalesce(r.votes, 0) DESC LIMIT 30`).all(norm(name));
}

/**
 * Titles with all of `words` (normalized) in their name, most voted first:
 * candidates for matching, and picking one by hand. The words are looked up
 * in names_fts, the best few hundred by how well they match.
 */
export function withWords(words, limit = 30) {
  const d = open();
  words = words.map((w) => norm(w)).filter(Boolean);
  if (!d || !words.length) return [];
  const query = words.map((w) => (w.length > 2 ? `"${w}"*` : `"${w}"`)).join(" "); // ("fred" finds "freds")
  return d.prepare(`${TITLE} WHERE t.id IN (SELECT id FROM names WHERE rowid IN
    (SELECT rowid FROM names_fts WHERE names_fts MATCH ? ORDER BY rank LIMIT 400)) ORDER BY coalesce(r.votes, 0) DESC LIMIT ?`).all(query, limit);
}

/** Titles found by what's typed (picking one by hand): its words, the last one a prefix. */
export function search(text, limit = 30) {
  const words = norm(text).split(" ").filter(Boolean);
  const d = open();
  if (!d || !words.length) return [];
  const query = words.map((w, i) => (i === words.length - 1 ? `"${w}"*` : `"${w}"`)).join(" ");
  return d.prepare(`${TITLE} WHERE t.id IN (SELECT id FROM names WHERE rowid IN
    (SELECT rowid FROM names_fts WHERE names_fts MATCH ? ORDER BY rank LIMIT 2000)) ORDER BY coalesce(r.votes, 0) DESC LIMIT ?`).all(query, limit);
}

export function title(id) {
  return open()?.prepare(`${TITLE} WHERE t.id = ?`).get(id) ?? null;
}

/** A show's episodes: [{id, season, episode, title, year, rating, votes}], in order. */
export function episodes(seriesId) {
  const d = open();
  if (!d) return [];
  return d.prepare(`SELECT e.id, e.season, e.episode, n.title, n.year, r.rating, r.votes FROM episodes e
    LEFT JOIN episode_titles n ON n.id = e.id LEFT JOIN ratings r ON r.id = e.id
    WHERE e.parent = ? ORDER BY e.season, e.episode`).all(seriesId);
}

/** "tt0111161" for an id. */
export const tconst = (id) => `tt${String(id).padStart(7, "0")}`;
