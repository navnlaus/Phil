// A worker (imdb.js update()): downloads IMDb's datasets and builds the
// database from them, telling how far it is ({progress: {phase, done,
// total}}), then {ok} or {error}. Built next to the old one and swapped in.
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { norm } from "./imdb.js";

const BASE = "https://datasets.imdbws.com/";
const FILES = ["title.ratings.tsv.gz", "title.episode.tsv.gz", "title.basics.tsv.gz"];
// What's kept of title.basics (episodes go to their own table; shorts, games and the like aren't).
const KINDS = new Set(["movie", "tvMovie", "tvSeries", "tvMiniSeries", "tvSpecial", "video"]);

self.onmessage = async ({ data: { dir } }) => {
  try {
    await build(dir);
    self.postMessage({ ok: true });
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};

const progress = (phase, done, total) => self.postMessage({ progress: { phase, done, total } });

async function build(dir) {
  await Deno.mkdir(dir, { recursive: true });
  // Downloaded again only when IMDb has newer ones (the dates of the last, in
  // downloaded.json; the files themselves go once they're read).
  const datesFile = join(dir, "downloaded.json");
  const dates = await Deno.readTextFile(datesFile).then(JSON.parse, () => ({}));
  const fresh = {};
  for (const name of FILES) {
    const res = await fetch(BASE + name, { method: "HEAD" });
    if (!res.ok) throw new Error(`${name}: ${res.status} ${res.statusText}`);
    fresh[name] = res.headers.get("last-modified") ?? "";
  }
  const built = await Deno.stat(join(dir, "imdb.sqlite")).then(() => true, () => false);
  // (Newer, not just different: IMDb's servers don't all have the latest at once, and some answer with older ones.)
  const newer = (name) => !dates[name] || !fresh[name] || Date.parse(fresh[name]) > Date.parse(dates[name]);
  if (built && !FILES.some(newer)) return; // up to date
  for (const name of FILES) {
    const res = await fetch(BASE + name);
    if (!res.ok) throw new Error(`${name}: ${res.status} ${res.statusText}`);
    fresh[name] = res.headers.get("last-modified") ?? fresh[name]; // (what was downloaded: maybe not what was asked about)
    const total = Number(res.headers.get("content-length")) || 0;
    const file = join(dir, name), tmp = `${file}.part`;
    const out = await Deno.open(tmp, { write: true, create: true, truncate: true });
    let done = 0, last = 0;
    for await (const chunk of res.body) {
      await out.write(chunk);
      done += chunk.length;
      if (Date.now() - last > 300) (last = Date.now()), progress(`Downloading ${name}`, done, total);
    }
    out.close();
    await Deno.rename(tmp, file);
  }

  const dbFile = join(dir, "imdb.sqlite"), tmp = `${dbFile}.building`;
  await Deno.remove(tmp).catch(() => {});
  const db = new DatabaseSync(tmp);
  db.exec(`PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;
    CREATE TABLE titles (id INTEGER PRIMARY KEY, type TEXT, title TEXT, year INTEGER, end_year INTEGER, minutes INTEGER, genres TEXT);
    CREATE TABLE names (norm TEXT, id INTEGER);
    CREATE TABLE ratings (id INTEGER PRIMARY KEY, rating REAL, votes INTEGER);
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, parent INTEGER, season INTEGER, episode INTEGER);
    CREATE TABLE episode_titles (id INTEGER PRIMARY KEY, title TEXT, year INTEGER);`);
  const id = (t) => Number(t.slice(2));
  const int = (v) => (v === "\\N" ? null : Number(v));

  db.exec("BEGIN");
  const rating = db.prepare("INSERT INTO ratings VALUES (?, ?, ?)");
  await rows(join(dir, "title.ratings.tsv.gz"), "Reading ratings", (c) => rating.run(id(c[0]), Number(c[1]), Number(c[2])));
  const episode = db.prepare("INSERT INTO episodes VALUES (?, ?, ?, ?)");
  await rows(join(dir, "title.episode.tsv.gz"), "Reading episodes", (c) => episode.run(id(c[0]), id(c[1]), int(c[2]), int(c[3])));
  const titleRow = db.prepare("INSERT INTO titles VALUES (?, ?, ?, ?, ?, ?, ?)");
  const name = db.prepare("INSERT INTO names VALUES (?, ?)");
  const episodeTitle = db.prepare("INSERT INTO episode_titles VALUES (?, ?, ?)");
  // tconst titleType primaryTitle originalTitle isAdult startYear endYear runtimeMinutes genres
  await rows(join(dir, "title.basics.tsv.gz"), "Reading titles", (c) => {
    if (c[1] === "tvEpisode") return void episodeTitle.run(id(c[0]), c[2], int(c[5]));
    if (!KINDS.has(c[1]) || c[4] === "1") return;
    const n = id(c[0]);
    titleRow.run(n, c[1], c[2], int(c[5]), int(c[6]), int(c[7]), c[8] === "\\N" ? "" : c[8]);
    const a = norm(c[2]), b = norm(c[3]);
    name.run(a, n);
    if (b && b !== a) name.run(b, n);
  });
  db.exec("COMMIT");
  progress("Indexing", 0, 0);
  db.exec(`CREATE INDEX names_norm ON names (norm); CREATE INDEX episodes_parent ON episodes (parent);
    CREATE VIRTUAL TABLE names_fts USING fts5(norm, content='names', content_rowid='rowid', detail=none);
    INSERT INTO names_fts(names_fts) VALUES('rebuild'); ANALYZE;`); // names_fts: titles by the words in them (media.js's matching)
  db.close();
  await Deno.rename(tmp, dbFile);
  await Deno.writeTextFile(datesFile, JSON.stringify(fresh));
  for (const name of FILES) await Deno.remove(join(dir, name)).catch(() => {});
}

// Each line of a gzipped TSV file but the header, split into columns.
async function rows(file, phase, each) {
  const size = (await Deno.stat(file)).size;
  let read = 0, last = 0, buf = "", header = true;
  const f = await Deno.open(file);
  const counted = f.readable.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      read += chunk.length;
      ctl.enqueue(chunk);
    },
  }));
  for await (const text of counted.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream())) {
    buf += text;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (header) {
        header = false;
        continue;
      }
      if (line) each(line.split("\t"));
    }
    if (Date.now() - last > 300) (last = Date.now()), progress(phase, read, size);
  }
  if (buf) each(buf.split("\t"));
}
