// The Media view's library: the videos in the folders marked as media (their
// Properties), as movies and TV shows, matched against IMDb's datasets on this
// computer (imdb.js). A file's name says what it is, the way they're usually
// named: "Bugonia (2025) [1080p] [WEBRip]" (a folder, or the file) is a movie,
// "Bering.Sea.Gold.S19E10.1080p.HEVC" an episode; a season's folder lends its
// show's name to files that don't say it. Matches that aren't sure are marked,
// and any can be put right by hand (fixes, kept by what the name says, so they
// hold for every file named so, and where they're moved).
import { basename, dirname, extname, join } from "@std/path";
import { mediaKind } from "../../engine/media.js";
import * as imdb from "./imdb.js";

const DEPTH = 5; // folders deep, at most, under a media folder
const SKIP_DIRS = /^(subs?|subtitles|samples?|extras?|featurettes?|behind the scenes|deleted scenes|trailers?|other)$/i;
const SKIP_FILES = /(^|[^a-z])(sample|trailer)([^a-z]|$)/i;

// What follows a title in a release's name: its quality, source, codecs and the like.
const JUNK = new RegExp(
  "\\b(" + [
    "2160p", "1080p", "1080i", "720p", "576p", "480p", "4k", "uhd", "hdr10?", "dv", "web[ .-]?dl", "webrip", "web", "bluray", "blu[ .-]?ray", "brrip", "bdrip",
    "hdtv", "pdtv", "dvdrip", "dvdscr", "dvd", "hdrip", "dvb", "xvid", "divx", "x264", "x265", "h ?264", "h ?265", "hevc", "avc", "10bit", "aac\\d?", "ac3", "dts",
    "ddp?\\d", "atmos", "truehd", "mp3", "repack", "proper", "extended", "unrated", "remastered", "directors cut", "limited", "internal", "complete", "multi",
    "subbed", "dubbed", "nf", "amzn", "hulu", "dsnp", "atvp", "hmax", "yts", "yify", "eztv", "rarbg",
  ].join("|") + ")\\b", "i",
);
const QUALITY = /\b(2160p|1080p|720p|576p|480p)\b/i;
const SOURCE = /\b(blu[ .-]?ray|bdrip|brrip|web[ .-]?dl|webrip|web|hdtv|dvdrip|dvd)\b/i;
const EPISODE = /(?:^|[ ._\-[(])s(\d{1,2})[ ._-]?e(\d{1,3})(?:[ ._-]?e\d{1,3})*|(?:^|[ ._\-[(])(\d{1,2})x(\d{2,3})(?=[ ._\-\])]|$)/i;
const SEASON = /(?:^|[ ._\-[(])(?:s(\d{1,2})(?:[ ._-]?-?[ ._-]?s\d{1,2})?|season[ ._-]?(\d{1,2}))(?=[ ._\-\])]|$)/i;

/** What a name says: {title, year, season, episode, quality, source}. */
export function parse(name, { file = true } = {}) {
  let s = file ? name.slice(0, name.length - extname(name).length) : name;
  s = s.replace(/^(\[[^\]]*\]\s*)+/, ""); // "[group] Title..."
  s = s.replace(/^(www[ .])?[\w-]+[ .](com|org|net|to|cc|me|io|info|xyz|lol|bz|mx|ag|am|lt|gg|tv)\s*-\s*/i, ""); // "www.Torrenting.com - Title..."
  const out = { title: "", year: null, season: null, episode: null, quality: QUALITY.exec(s)?.[1]?.toLowerCase() ?? null, source: null };
  const source = SOURCE.exec(s)?.[1]?.toLowerCase().replace(/[ .-]/g, "");
  out.source = source ? ({ bluray: "BluRay", bdrip: "BluRay", brrip: "BluRay", webdl: "WEB-DL", webrip: "WEBRip", web: "WEB", hdtv: "HDTV", dvdrip: "DVD", dvd: "DVD" })[source] : null;
  let cut = s.length;
  const ep = EPISODE.exec(s);
  if (ep) {
    out.season = Number(ep[1] ?? ep[3]);
    out.episode = Number(ep[2] ?? ep[4]);
    cut = ep.index;
  } else {
    const season = SEASON.exec(s);
    if (season) (out.season = Number(season[1] ?? season[2])), (cut = season.index);
  }
  // A year: in brackets, or on its own after the title (not the title itself: "1917", "2012").
  const years = [...s.slice(0, cut + 12).matchAll(/(?:^|[ ._\-[(])((?:19|20)\d{2})(?=[ ._\-\])]|$)/g)].filter((m) => m.index > 0);
  const year = years.at(-1);
  if (year && year.index <= cut + 1) (out.year = Number(year[1])), (cut = Math.min(cut, year.index));
  const junk = JUNK.exec(s.slice(0, cut));
  if (junk && junk.index > 0) cut = junk.index;
  let title = s.slice(0, cut).replace(/\[[^\]]*\]|\([^)]*\)/g, " ");
  if (!/\s/.test(title.trim()) || /\w\.\w+\.\w/.test(title)) title = title.replace(/[._]/g, " "); // dots for spaces
  out.title = title.replace(/\s+-\s*$|^\s*-\s+/g, "").replace(/\s+/g, " ").replace(/[\s\-–:,]+$/, "").trim();
  return out;
}

/** What a video file in a media folder is, from its name and its folders': {kind: "movie" | "episode", title, year, season, episode, quality, source}. */
export function describe(path, root) {
  const own = parse(basename(path));
  const folders = [];
  for (let dir = dirname(path); dir.length > root.length && dir.startsWith(root); dir = dirname(dir)) folders.push(parse(basename(dir), { file: false }));
  if (own.episode !== null) {
    // An episode: its show's name from the file, or the nearest folder that has one (not "Season 1").
    const named = own.title ? own : folders.find((f) => f.title && !/^season \d+$/i.test(f.title)) ?? own;
    return { kind: "episode", title: named.title, year: named.year ?? folders.find((f) => f.year)?.year ?? null, season: own.season, episode: own.episode, quality: own.quality ?? folders.find((f) => f.quality)?.quality ?? null, source: own.source };
  }
  // A movie: its folder's name if that says more (it usually does: "Title (Year) [1080p]").
  const folder = folders[0];
  const best = folder && folder.title && folder.season === null && (folder.year || !own.year) ? folder : own;
  return { kind: "movie", title: best.title, year: best.year ?? own.year, season: null, episode: null, quality: own.quality ?? folder?.quality ?? null, source: own.source ?? folder?.source ?? null };
}

// ---------------------------------------------------------------- matching

const words = (s) => imdb.norm(s).split(" ").filter(Boolean).map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
const SMALL = new Set(["the", "a", "an", "and", "of"]);

// How alike two names are, 0 to 1 (by their words; "the", "and"... count for little).
function alike(a, b) {
  const wa = words(a), wb = words(b);
  const weight = (w) => (SMALL.has(w) || w.length === 1 ? 0.3 : 1);
  const sum = (ws) => ws.reduce((n, w) => n + weight(w), 0);
  const rest = [...wb];
  let common = 0;
  for (const w of wa) {
    const i = rest.indexOf(w);
    if (i !== -1) common += weight(w), rest.splice(i, 1);
  }
  return (2 * common) / (sum(wa) + sum(wb) || 1);
}

/**
 * The IMDb title a description is: {title, sure} or null. Candidates are
 * titles called the same, or starting with the same words; the best is the
 * most alike, of the right kind (a show for an episode), and year, then the
 * one most voted for.
 */
export function match(d) {
  // Two titles in one ("Ho perso la testa per un cervello - The Man With Two Brains"), or one also known as another: each.
  const names = [d.title, ...d.title.split(/\s+-\s+|\s+a\s?k\s?a\s+/i).filter((t) => t !== d.title && t.trim())];
  let found = null;
  for (const title of names) {
    const m = matchTitle({ ...d, title });
    if (m && (!found || m.score > found.score)) found = m;
  }
  return found && { title: found.title, sure: found.sure };
}

function matchTitle({ kind, title, year }) {
  if (!title) return null;
  const series = kind === "episode";
  const seen = new Map();
  const add = (list) => list.forEach((t) => seen.set(t.id, t));
  add(imdb.lookup(title));
  const ws = imdb.norm(title).split(" ").filter((w) => !SMALL.has(w));
  if (ws.length) add(imdb.withWords(ws, 40));
  if (ws.length > 1) add(imdb.withWords(ws.slice(1), 40)), add(imdb.withWords(ws.slice(0, -1), 40)); // "DCs Legends of Tomorrow": "Legends of Tomorrow"
  if (ws.length > 3) add(imdb.withWords(ws.slice(0, 3), 40)); // a subtitle after it
  let best = null;
  for (const t of seen.values()) {
    let like = alike(title, t.title);
    // The whole of its title, then more: a subtitle ("Wake Up Dead Man A Knives Out Mystery").
    const tw = words(t.title), qw = words(title);
    if (tw.filter((w) => !SMALL.has(w)).length >= 2 && tw.every((w, i) => qw[i] === w)) like = Math.max(like, 0.85);
    if (like < 0.8) continue;
    const isSeries = t.type === "tvSeries" || t.type === "tvMiniSeries";
    let score = like * 10 + Math.log10((t.votes ?? 0) + 1);
    if (series !== isSeries) score -= series ? 8 : 4; // a show for an episode; a movie for a movie, mostly
    if (year && t.year) score += t.year === year ? 6 : Math.abs(t.year - year) === 1 ? 3 : (isSeries && t.endYear && year >= t.year && year <= t.endYear) ? 4 : -3;
    if (!t.year) score -= year ? 6 : 2;
    if (!best || score > best.score) best = { title: t, score, like };
  }
  if (!best) return null;
  const t = best.title;
  const yearOk = !year || (t.year && (Math.abs(t.year - year) <= 1 || (t.endYear && year <= t.endYear && year >= t.year)));
  const kindOk = (kind === "episode") === (t.type === "tvSeries" || t.type === "tvMiniSeries");
  return { title: t, score: best.score, sure: best.like >= 0.95 && yearOk && kindOk };
}

// ---------------------------------------------------------------- the library

const matched = new Map(); // key -> match(), kept while the database is the same
let matchedWith = null;

/**
 * The library: `roots` (the folders marked as media) scanned, each file
 * described and matched, grouped into movies and shows. `fixes` (key ->
 * IMDb id, or 0: not a movie or show, left out) put matches right;
 * `watched` (path -> {t}, videoplayer's positions: t null when watched to
 * the end) says how far each was watched. Roots not there now (a drive
 * unplugged) come from `remembered` (root -> its files when last seen).
 */
export async function library(roots, { fixes = {}, watched = {}, remembered = {} } = {}) {
  const files = [], online = {};
  for (const root of roots) {
    const found = await scan(root).catch(() => null);
    online[root] = !!found;
    for (const f of found ?? remembered[root] ?? []) files.push({ ...f, root, offline: !found });
  }
  const scanned = Object.fromEntries(roots.filter((r) => online[r]).map((r) => [r, files.filter((f) => f.root === r).map(({ path, size, mtime }) => ({ path, size, mtime }))]));

  const movies = new Map(), shows = new Map(), cache = new Map();
  const built = imdb.status().built;
  if (built !== matchedWith) matched.clear(), (matchedWith = built); // a new database: matched again
  for (const f of files) {
    const d = describe(f.path, f.root);
    const key = `${d.kind === "episode" ? "show" : "movie"}|${imdb.norm(d.title)}|${d.kind === "episode" ? "" : d.year ?? ""}`;
    if (fixes[key] === 0) continue; // left out by hand
    if (!cache.has(key)) {
      const fixed = fixes[key] ? imdb.title(fixes[key]) : null;
      if (!fixed && !matched.has(key)) matched.set(key, match(d));
      cache.set(key, fixed ? { title: fixed, sure: true, fixed: true } : matched.get(key));
    }
    const m = cache.get(key);
    const pos = watched[f.path];
    const file = { path: f.path, size: f.size, mtime: f.mtime, quality: d.quality, source: d.source, offline: f.offline, watched: pos ? (pos.t === null ? "done" : pos.t) : null };
    if (d.kind === "movie") {
      const id = m ? `tt${m.title.id}` : key;
      if (!movies.has(id)) movies.set(id, { key, ...(m ? info(m) : { title: d.title, year: d.year }), match: m ? (m.sure ? "sure" : "guess") : "none", parsed: { title: d.title, year: d.year }, files: [] });
      movies.get(id).files.push(file);
    } else {
      const id = m ? `tt${m.title.id}` : key;
      if (!shows.has(id)) shows.set(id, { key, ...(m ? info(m) : { title: d.title, year: d.year }), match: m ? (m.sure ? "sure" : "guess") : "none", parsed: { title: d.title, year: d.year }, files: [] });
      shows.get(id).files.push({ ...file, season: d.season, episode: d.episode });
    }
  }
  // A show's seasons: the ones there are files of, every episode (what's there, and what isn't).
  for (const show of shows.values()) {
    const list = show.id ? imdb.episodes(show.id) : [];
    const seasons = new Map();
    for (const e of list) {
      if (!seasons.has(e.season)) seasons.set(e.season, []);
      seasons.get(e.season).push({ season: e.season, episode: e.episode, title: e.title, year: e.year, rating: e.rating, votes: e.votes, files: [] });
    }
    for (const f of show.files) {
      if (!seasons.has(f.season)) seasons.set(f.season, []);
      const eps = seasons.get(f.season);
      let ep = eps.find((e) => e.episode === f.episode);
      if (!ep) eps.push(ep = { season: f.season, episode: f.episode, title: null, files: [] });
      ep.files.push(f);
    }
    show.seasons = [...seasons].filter(([, eps]) => eps.some((e) => e.files.length)).sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))
      .map(([season, eps]) => ({ season, episodes: eps.sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0)) }));
    show.seasonCount = new Set(list.map((e) => e.season).filter((s) => s !== null)).size || show.seasons.length;
    show.added = Math.max(...show.files.map((f) => f.mtime ?? 0));
    delete show.files;
  }
  for (const movie of movies.values()) movie.added = Math.max(...movie.files.map((f) => f.mtime ?? 0));
  return { movies: [...movies.values()], shows: [...shows.values()], online, scanned };
}

const info = ({ title: t, fixed }) => ({ id: t.id, imdb: imdb.tconst(t.id), title: t.title, year: t.year, endYear: t.endYear, type: t.type, minutes: t.minutes, genres: t.genres ? t.genres.split(",") : [], rating: t.rating, votes: t.votes, ...(fixed ? { fixed: true } : {}) });

// The video files under `root` ([{path, size, mtime}]); throws if it isn't there.
async function scan(root) {
  const out = [];
  await Deno.stat(root);
  const walk = async (dir, depth) => {
    let entries;
    try {
      entries = await Array.fromAsync(Deno.readDir(dir));
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const path = join(dir, e.name);
      if (e.isDirectory) {
        if (depth < DEPTH && !SKIP_DIRS.test(e.name)) await walk(path, depth + 1);
      } else if (mediaKind(e.name) === "video" && !SKIP_FILES.test(e.name)) {
        const st = await Deno.stat(path).catch(() => null);
        if (st?.isFile) out.push({ path, size: st.size, mtime: st.mtime?.getTime() ?? 0 });
      }
    }
  };
  await walk(root, 0);
  return out;
}
