// Auto-tagging pictures (optional, per folder: turned on in its Properties):
// SigLIP 2 base, in a Python helper (tagging/tagger.py) that phil starts
// while there's tagging to do and stops when idle. scripts/install-tagging.sh
// sets up its environment; without it, tagging says what to run.
//
// A picture is embedded once (from the file; a video, or a format the
// helper can't read, from its thumbnail) and the embedding cached
// (per folder, next to the thumbnails). Its tags are scored from that against
// the tag list each time, so a tag added to the list tags every picture
// right away: the list is tagging/tags.txt plus ~/.config/phil/tags.txt,
// where tags added to pictures by hand go too. Keywords and a description
// the file carries itself (EXIF, XMP, IPTC) come along: keywords as tags.
// The same embeddings answer searches by description (search()).
import { basename, dirname, join } from "@std/path";
import { mediaKind } from "../../engine/media.js";

const CUTOFF = 0.05; // the probability a tag needs
const SEARCH_CUTOFF = 0.01; // and a picture, to match a search (what's there scores 0.04 and up, the rest under 0.003)
const SUMMARY = 12; // a folder's most common tags, kept for its tile
const MOST = 5; // tags per picture at most
const BATCH = 32;
const IDLE = 5 * 60 * 1000; // ms without work before the helper goes (it holds GPU memory)

const env = (name) => Deno.env.get(name) || null;
const dataHome = () => env("XDG_DATA_HOME") ?? join(env("HOME") ?? "/", ".local", "share");
/** The helper's Python: PHIL_TAGGING_PYTHON, or the environment the installer makes. */
export const taggingPython = () => env("PHIL_TAGGING_PYTHON") ?? join(dataHome(), "phil", "tagging", "venv", "bin", "python");

/** Pictures that can be tagged: images and videos (by a frame). */
export const taggable = (name) => ["image", "video"].includes(mediaKind(name));

export class Tagging {
  #helper = new Helper();
  #cacheDir; // null: in memory only (incognito)
  #userTags; // ~/.config/phil/tags.txt
  #persist;
  #memory = new Map(); // "texts" or "folder <dir>" -> its data (read once; incognito: only here)
  #extraTags = new Set(); // incognito: tags added this session
  #summaries = new Map(); // folder -> its most common tags

  constructor({ cacheDir, userTagsFile, persist = true }) {
    this.#cacheDir = cacheDir;
    this.#userTags = userTagsFile;
    this.#persist = persist;
  }

  /** Whether the helper's environment is there. */
  async available() {
    return await Deno.stat(taggingPython()).then((s) => s.isFile, () => false);
  }

  /** The tag list: phil's, then the user's (and tags added by hand). */
  async vocabulary() {
    const read = (text) => text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    const own = read(await Deno.readTextFile(new URL("./tagging/tags.txt", import.meta.url)));
    const theirs = read(await Deno.readTextFile(this.#userTags).catch(() => ""));
    return [...new Set([...own, ...theirs, ...this.#extraTags])];
  }

  /** Adds tags to the user's list (tags given to pictures by hand). */
  async addToVocabulary(tags) {
    const known = new Set(await this.vocabulary());
    const fresh = tags.filter((t) => !known.has(t));
    if (!fresh.length) return;
    if (!this.#persist) return void fresh.forEach((t) => this.#extraTags.add(t));
    const before = await Deno.readTextFile(this.#userTags).catch(() => null);
    const head = before === null
      ? "# Tags phil's auto-tagging looks for, besides its own (apps/phil/tagging/tags.txt).\n# One per line. Tags you add to pictures are added here.\n"
      : before && !before.endsWith("\n") ? "\n" : "";
    await Deno.mkdir(dirname(this.#userTags), { recursive: true });
    await Deno.writeTextFile(this.#userTags, head + fresh.join("\n") + "\n", { append: true });
  }

  /**
   * Tags the pictures in `files` ([{path, size, mtime}], one folder's): yields
   * {tags: {path: [[tag, probability], ...]}, descriptions: {path: text},
   * left} as it goes, first for the ones already embedded, then batch by
   * batch; then saves the folder's most common tags for its tile (summary()). `thumbnail(path, signal)`
   * gives a picture's thumbnail file (or null): what's looked at for videos,
   * and for pictures the helper can't read.
   */
  async *tag(dir, files, thumbnail, signal) {
    const vocab = await this.vocabulary();
    const { scale, bias, texts } = await this.#textEmbeddings(vocab);
    const tagEmb = vocab.map((t) => texts[t]);
    // A picture's tags: its own keywords, then the ones found.
    const score = (item) => {
      const own = (item.meta?.keywords ?? []).map((k) => [k, 1]);
      return [...own, ...scoreTags(decode(item.emb), vocab, tagEmb, scale, bias).filter(([t]) => !own.some(([k]) => k === t))];
    };
    const all = {}; // path -> tags, for the summary
    const described = (items) => Object.fromEntries(items.filter(([, it]) => it.meta?.description).map(([p, it]) => [p, it.meta.description]));

    const store = await this.#load(`folder ${dir}`, this.#folderFile(dir));
    store.items ??= {};
    const ready = {}, todo = [];
    for (const f of files) {
      const known = store.items[basename(f.path)];
      if (known?.sig === sig(f)) ready[f.path] = all[f.path] = score(known);
      else todo.push(f);
    }
    yield { tags: ready, descriptions: described(files.map((f) => [f.path, store.items[basename(f.path)]]).filter(([p, it]) => ready[p] && it)), left: todo.length };

    for (let i = 0; i < todo.length; i += BATCH) {
      signal?.throwIfAborted();
      const batch = todo.slice(i, i + BATCH);
      const thumb = (f) => thumbnail(f.path, signal).catch(() => null);
      // The pictures themselves, then thumbnails for what that didn't work for.
      const sources = await Promise.all(batch.map((f) => (mediaKind(f.path) === "image" ? f.path : thumb(f))));
      let { embeddings, meta } = await this.#helper.request("images", { paths: sources.map((s) => s ?? "") });
      const retry = batch.map((f, j) => (!embeddings[j] && sources[j] === f.path ? j : -1)).filter((j) => j !== -1);
      if (retry.length) {
        const thumbs = await Promise.all(retry.map((j) => thumb(batch[j])));
        const again = (await this.#helper.request("images", { paths: thumbs.map((t) => t ?? "") })).embeddings;
        embeddings = [...embeddings];
        retry.forEach((j, k) => (embeddings[j] = thumbs[k] ? again[k] : null));
      }
      signal?.throwIfAborted();
      const tags = {}, items = [];
      batch.forEach((f, j) => {
        if (!embeddings[j]) return;
        const item = { sig: sig(f), emb: embeddings[j], ...(meta?.[j] ? { meta: meta[j] } : {}) };
        store.items[basename(f.path)] = item;
        tags[f.path] = all[f.path] = score(item);
        items.push([f.path, item]);
      });
      await this.#save(this.#folderFile(dir), store);
      yield { tags, descriptions: described(items), left: Math.max(0, todo.length - i - BATCH) };
    }
    // Done: the folder's most common tags, for its tile.
    const counts = new Map();
    for (const list of Object.values(all)) for (const [t] of list) counts.set(t, (counts.get(t) ?? 0) + 1);
    const summary = [...counts].sort((a, b) => b[1] - a[1]).slice(0, SUMMARY);
    this.#summaries.set(dir, summary);
    if (this.#cacheDir && this.#persist) await this.#save(this.#summaryFile(dir), { tags: summary });
  }

  /** A tagged folder's most common tags, [[tag, count]] (empty if it wasn't tagged). */
  async summary(dir) {
    if (!this.#summaries.has(dir)) {
      const file = this.#summaryFile(dir);
      this.#summaries.set(dir, file ? (await Deno.readTextFile(file).then(JSON.parse, () => ({}))).tags ?? [] : []);
    }
    return this.#summaries.get(dir);
  }

  /**
   * Searching a tagged folder's pictures by description: {path: probability}
   * for the ones that match `text` (the helper embeds it), best first.
   */
  async search(dir, text) {
    const store = await this.#load(`folder ${dir}`, this.#folderFile(dir));
    const items = Object.entries(store.items ?? {});
    if (!items.length) return {};
    const { scale, bias } = await this.#textEmbeddings([]);
    const [query] = (await this.#helper.request("texts", { texts: [text] })).embeddings;
    const q = decode(query);
    const found = items.map(([name, item]) => {
      const e = decode(item.emb);
      let dot = 0;
      for (let k = 0; k < e.length; k++) dot += e[k] * q[k];
      return [join(dir, name), 1 / (1 + Math.exp(-(dot * scale + bias)))];
    }).filter(([, p]) => p >= SEARCH_CUTOFF).sort((a, b) => b[1] - a[1]);
    return Object.fromEntries(found.map(([p, s]) => [p, Math.round(s * 1000) / 1000]));
  }

  // The tags' embeddings, asking the helper for the ones not seen before.
  async #textEmbeddings(vocab) {
    const file = this.#cacheDir && join(this.#cacheDir, "texts.json");
    const store = await this.#load("texts", file);
    if (!store.scale) Object.assign(store, await this.#helper.request("info"), { texts: {} });
    const missing = vocab.filter((t) => !store.texts[t]);
    if (missing.length) {
      const { embeddings } = await this.#helper.request("texts", { texts: missing });
      missing.forEach((t, i) => (store.texts[t] = embeddings[i]));
      await this.#save(file, store);
    }
    return { scale: store.scale, bias: store.bias, texts: Object.fromEntries(vocab.map((t) => [t, decode(store.texts[t])])) };
  }

  /** A folder deleted: what's kept of its pictures (embeddings, its tag summary) goes. */
  async forget(dir) {
    this.#memory.delete(`folder ${dir}`);
    this.#summaries.delete(dir);
    if (!this.#cacheDir) return;
    for (const file of [this.#folderFile(dir), this.#summaryFile(dir)]) await Deno.remove(file).catch(() => {});
  }

  #folderFile(dir) {
    return this.#cacheDir && join(this.#cacheDir, `${hashOf(dir)}.json`);
  }

  #summaryFile(dir) {
    return this.#cacheDir && join(this.#cacheDir, `${hashOf(dir)}.summary.json`);
  }

  // `key`'s data, from `file` the first time (incognito: none, kept in memory).
  async #load(key, file) {
    if (!this.#memory.has(key)) {
      this.#memory.set(key, file ? await Deno.readTextFile(file).then(JSON.parse, () => ({})) : {});
    }
    return this.#memory.get(key);
  }

  async #save(file, data) {
    if (!file || !this.#persist) return;
    await Deno.mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(data));
    await Deno.rename(tmp, file);
  }
}

// A picture's version: a changed file is embedded again.
const sig = (f) => `${f.size} ${f.mtime}`;

const decode = (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Float32Array(bytes.buffer);
};

function scoreTags(emb, vocab, tagEmb, scale, bias) {
  const out = [];
  tagEmb.forEach((t, i) => {
    let dot = 0;
    for (let k = 0; k < emb.length; k++) dot += emb[k] * t[k];
    const p = 1 / (1 + Math.exp(-(dot * scale + bias)));
    if (p >= CUTOFF) out.push([vocab[i], Math.round(p * 1000) / 1000]);
  });
  return out.sort((a, b) => b[1] - a[1]).slice(0, MOST);
}

// FNV-1a: a folder's cache file name.
function hashOf(s) {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(s)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

// The Python helper: started on the first request, gone after IDLE without
// any. Answers arrive in order, one line each.
class Helper {
  #child = null;
  #ready = null;
  #pending = new Map();
  #id = 0;
  #idle = null;
  #writing = Promise.resolve(); // one request written at a time

  async request(op, args = {}) {
    await this.#start();
    clearTimeout(this.#idle);
    const id = ++this.#id;
    const answer = new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    const child = this.#child;
    this.#writing = this.#writing.then(async () => {
      const writer = child.stdin.getWriter();
      try {
        await writer.write(new TextEncoder().encode(JSON.stringify({ id, op, ...args }) + "\n"));
      } finally {
        writer.releaseLock();
      }
    }).catch((err) => this.#pending.get(id)?.reject(err));
    await this.#writing;
    try {
      const res = await answer;
      if (res.error) throw new Error(res.error);
      return res;
    } finally {
      if (!this.#pending.size) this.#idle = setTimeout(() => this.#stop(), IDLE);
    }
  }

  #start() {
    if (this.#ready) return this.#ready;
    this.#ready = (async () => {
      const script = await helperScript();
      const child = new Deno.Command(taggingPython(), {
        args: [script],
        stdin: "piped",
        stdout: "piped",
        stderr: "inherit", // into the engine's log
        env: { PYTHONUNBUFFERED: "1", TRANSFORMERS_VERBOSITY: "error" },
      }).spawn();
      this.#child = child;
      const { promise: started, resolve, reject } = Promise.withResolvers();
      (async () => {
        let buf = "";
        for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            let msg;
            try {
              msg = JSON.parse(line);
            } catch {
              continue; // something else printed
            }
            if (msg.ready) {
              console.log(`phil: tagger running (${msg.device})`);
              resolve();
            } else this.#pending.get(msg.id)?.resolve(msg), this.#pending.delete(msg.id);
          }
        }
      })().catch(() => {});
      child.status.then((s) => {
        const err = new Error(`the tagger stopped (exit code ${s.code}); see the engine's log`);
        reject(err);
        for (const p of this.#pending.values()) p.reject(err);
        this.#pending.clear();
        this.#child = this.#ready = null;
      });
      await started;
    })();
    this.#ready.catch(() => (this.#ready = null));
    return this.#ready;
  }

  #stop() {
    this.#child?.stdin.close().catch(() => {}); // it exits at the end of its input
  }
}

// python needs a real file, and under `deno compile` ours is in the binary:
// copied out, named after its contents (as the shell's init file is).
let scriptPath = null;
async function helperScript() {
  if (scriptPath) return scriptPath;
  const text = await Deno.readTextFile(new URL("./tagging/tagger.py", import.meta.url));
  const path = join(env("XDG_RUNTIME_DIR") ?? "/tmp", `phil-tagger-${hashOf(text)}.py`);
  const tmp = `${path}.${Deno.pid}`;
  await Deno.writeTextFile(tmp, text);
  await Deno.rename(tmp, path);
  return (scriptPath = path);
}
