// Auto-tagging pictures and documents (optional; per folder, turned on in its
// Properties, or every folder opened, in Preferences): pictures with SigLIP 2
// base, text and Markdown files with EmbeddingGemma 2 (its text part), in a
// Python helper (tagging/tagger.py) that phil starts while there's tagging to
// do and stops when idle. scripts/install-tagging.sh sets up its environment
// (--documents: EmbeddingGemma 2 too); without it, tagging says what to run.
// Each kind can be turned off in Preferences.
//
// A picture is embedded once (from the file; a video, or a format the
// helper can't read, from its thumbnail) and the embedding cached
// (per folder, next to the thumbnails). Its tags are scored from that against
// the tag list each time, so a tag added to the list tags every picture
// right away. Pictures' list: tagging/tags.txt plus ~/.config/phil/tags.txt
// (tags added by hand), or, once edited in Preferences, all of
// ~/.config/phil/picture-tags.txt; documents': tagging/document-tags.txt, or
// ~/.config/phil/document-tags.txt. Keywords and a description
// the file carries itself (EXIF, XMP, IPTC) come along: keywords as tags.
// A document's tags are the ones that fit it best compared with the rest of
// the list (its own z-scores), since every topic fits any text a little.
// The same embeddings answer searches by description (search()).
import { basename, dirname, extname, join } from "@std/path";
import { mediaKind } from "../../engine/media.js";

const CUTOFF = 0.05; // the probability a tag needs (a picture's)
const DOC_CUTOFF = 2; // a document's: standard deviations above the list's mean
const SEARCH_CUTOFF = 0.01; // and a picture, to match a search (what's there scores 0.04 and up, the rest under 0.003)
const DOC_SEARCH_CUTOFF = 0.02; // a document, to match a search: above how well it fits text about nothing (unrelated text scores below 0)
const SUMMARY = 12; // a folder's most common tags, kept for its tile
const MOST = 5; // tags per picture at most
const BATCH = 32;
const IDLE = 5 * 60 * 1000; // ms without work before the helper goes (it holds GPU memory)

const env = (name) => Deno.env.get(name) || null;
const dataHome = () => env("XDG_DATA_HOME") ?? join(env("HOME") ?? "/", ".local", "share");
/** The helper's Python: PHIL_TAGGING_PYTHON, or the environment the installer makes. */
export const taggingPython = () => env("PHIL_TAGGING_PYTHON") ?? join(dataHome(), "phil", "tagging", "venv", "bin", "python");

const DOCUMENT_EXT = new Set(["txt", "text", "md", "markdown", "mdown", "mkd", "org", "rst", "adoc"]);

/** What a file is to tagging: "pictures" (images, and videos by a frame), "documents" (text and Markdown files), or null. */
export function tagKind(name) {
  if (["image", "video"].includes(mediaKind(name))) return "pictures";
  return DOCUMENT_EXT.has(extname(name).slice(1).toLowerCase()) ? "documents" : null;
}

const hfHub = () => env("HF_HUB_CACHE") ?? join(env("HF_HOME") ?? join(env("XDG_CACHE_HOME") ?? join(env("HOME") ?? "/", ".cache"), "huggingface"), "hub");
const exists = (path) => Deno.stat(path).then(() => true, () => false);
const read = (text) => text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const LIST_HEAD = {
  pictures: "# The tags phil's auto-tagging looks for in pictures, one per line (lines starting with # are left out).\n",
  documents: "# The tags phil's auto-tagging looks for in text and Markdown files, one per line (lines starting with # are left out).\n",
};

export class Tagging {
  #helper = new Helper();
  #cacheDir; // null: in memory only (incognito)
  #configDir; // ~/.config/phil: the tag lists
  #persist;
  #memory = new Map(); // "texts", "queries" or "folder <dir>" -> its data (read once; incognito: only here)
  #extraTags = { pictures: new Set(), documents: new Set() }; // incognito: tags added this session
  #summaries = new Map(); // folder -> its most common tags

  constructor({ cacheDir, configDir, persist = true }) {
    this.#cacheDir = cacheDir;
    this.#configDir = configDir;
    this.#persist = persist;
  }

  /** What's set up: {pictures, documents} (the helper's environment; for documents, EmbeddingGemma 2 downloaded too). */
  async available() {
    const python = await Deno.stat(taggingPython()).then((s) => s.isFile, () => false);
    if (!python) return { pictures: false, documents: false };
    let library = false; // sentence-transformers, in the environment's lib/python3.x
    const lib = join(dirname(dirname(taggingPython())), "lib");
    try {
      for await (const d of Deno.readDir(lib)) library ||= await exists(join(lib, d.name, "site-packages", "sentence_transformers"));
    } catch { /* no lib folder */ }
    return { pictures: true, documents: library && await exists(join(hfHub(), "models--google--embeddinggemma-2", "snapshots")) };
  }

  #listFile(kind) {
    return join(this.#configDir, kind === "pictures" ? "picture-tags.txt" : "document-tags.txt");
  }

  /**
   * A kind's tag list, {tags, text, custom}: the file edited in Preferences
   * (custom), or phil's (and for pictures, ~/.config/phil/tags.txt: tags added
   * to it, by hand or before lists could be edited). `text`: the list as it's
   * edited, one tag per line, # comments and all.
   */
  async list(kind) {
    const edited = await Deno.readTextFile(this.#listFile(kind)).catch(() => null);
    let text = edited;
    if (text === null) {
      text = await Deno.readTextFile(new URL(kind === "pictures" ? "./tagging/tags.txt" : "./tagging/document-tags.txt", import.meta.url));
      text = text.replace(/^(#.*\n)+\n?/, LIST_HEAD[kind] + "\n"); // its own heading: about phil's source
      const added = kind === "pictures" ? read(await Deno.readTextFile(join(this.#configDir, "tags.txt")).catch(() => "")) : [];
      if (added.length) text += `\n# added\n${added.join("\n")}\n`;
    }
    const extra = [...this.#extraTags[kind]];
    return { tags: [...new Set([...read(text), ...extra])], text: extra.length ? `${text}\n${extra.join("\n")}\n` : text, custom: edited !== null };
  }

  /** The tag list for `kind` ("pictures" or "documents"). */
  async vocabulary(kind) {
    return (await this.list(kind)).tags;
  }

  /** Replaces a kind's whole list (Preferences: its text, one tag per line); null: phil's again. */
  async setList(kind, text) {
    if (!this.#persist) throw new Error("Not in an incognito window");
    const file = this.#listFile(kind);
    // Pictures: tags.txt's tags were part of the list, now in the file (or let go, back to phil's).
    const old = kind === "pictures" ? join(this.#configDir, "tags.txt") : null;
    if (text === null) {
      await Deno.remove(file).catch(() => {});
      if (old) await Deno.remove(old).catch(() => {});
      return;
    }
    text = text.split("\n").map((l) => l.trim().replace(/\s+/g, " ")).join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
    await Deno.mkdir(this.#configDir, { recursive: true });
    const tmp = `${file}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await Deno.writeTextFile(tmp, text);
    await Deno.rename(tmp, file);
    if (old) await Deno.remove(old).catch(() => {});
  }

  /** Adds tags given by hand to the list of `kind` ("pictures": also for folders and other files). */
  async addToVocabulary(tags, kind = "pictures") {
    const { tags: known, text, custom } = await this.list(kind);
    const fresh = tags.filter((t) => !known.includes(t) && !t.startsWith("#"));
    if (!fresh.length) return;
    if (!this.#persist) return void fresh.forEach((t) => this.#extraTags[kind].add(t));
    if (custom || kind === "documents") return await this.setList(kind, `${text}\n${fresh.join("\n")}\n`); // documents: no list of additions; the whole list
    const file = join(this.#configDir, "tags.txt");
    const before = await Deno.readTextFile(file).catch(() => null);
    const head = before === null
      ? "# Tags phil's auto-tagging looks for, besides the ones built into phil.\n# One per line. Tags you add to pictures are added here.\n"
      : before && !before.endsWith("\n") ? "\n" : "";
    await Deno.mkdir(this.#configDir, { recursive: true });
    await Deno.writeTextFile(file, head + fresh.join("\n") + "\n", { append: true });
  }

  /**
   * Tags the pictures and documents in `files` ([{path, size, mtime}], one
   * folder's; only those of `kinds`, {pictures, documents}): yields
   * {tags: {path: [[tag, score], ...]}, descriptions: {path: text},
   * left} as it goes, first for the ones already embedded, then batch by
   * batch; then saves the folder's most common tags for its tile (summary()). `thumbnail(path, signal)`
   * gives a picture's thumbnail file (or null): what's looked at for videos,
   * and for pictures the helper can't read.
   */
  async *tag(dir, files, thumbnail, signal, kinds = { pictures: true, documents: false }) {
    files = files.filter((f) => kinds[tagKind(f.path)]);
    const pictures = files.filter((f) => tagKind(f.path) === "pictures"), documents = files.filter((f) => tagKind(f.path) === "documents");
    // A picture's tags: its own keywords, then the ones found.
    let score = null;
    if (pictures.length) {
      const vocab = await this.vocabulary("pictures");
      const { scale, bias, texts } = await this.#textEmbeddings(vocab);
      const tagEmb = vocab.map((t) => texts[t]);
      score = (item) => {
        const own = (item.meta?.keywords ?? []).map((k) => [k, 1]);
        return [...own, ...scoreTags(decode(item.emb), vocab, tagEmb, scale, bias).filter(([t]) => !own.some(([k]) => k === t))];
      };
    }
    let scoreDoc = null;
    if (documents.length) {
      const vocab = await this.vocabulary("documents");
      const queries = await this.#queryEmbeddings(vocab);
      scoreDoc = (item) => scoreDocument(decode(item.doc), vocab, queries);
    }
    const tagsOf = (f, item) => (tagKind(f.path) === "pictures" ? score(item) : scoreDoc(item));
    const all = {}; // path -> tags, for the summary
    const described = (items) => Object.fromEntries(items.filter(([, it]) => it.meta?.description).map(([p, it]) => [p, it.meta.description]));

    const store = await this.#load(`folder ${dir}`, this.#folderFile(dir));
    store.items ??= {};
    const ready = {}, todo = [];
    for (const f of files) {
      const known = store.items[basename(f.path)];
      if (known?.sig === sig(f) && (tagKind(f.path) === "pictures" ? known.emb : known.doc)) ready[f.path] = all[f.path] = tagsOf(f, known);
      else todo.push(f);
    }
    yield { tags: ready, descriptions: described(files.map((f) => [f.path, store.items[basename(f.path)]]).filter(([p, it]) => ready[p] && it)), left: todo.length };

    // Documents first (quick), then pictures.
    todo.sort((a, b) => (tagKind(a.path) === "documents" ? 0 : 1) - (tagKind(b.path) === "documents" ? 0 : 1));
    for (let i = 0; i < todo.length;) {
      signal?.throwIfAborted();
      const kind = tagKind(todo[i].path);
      let batch = todo.slice(i, i + BATCH);
      const other = batch.findIndex((f) => tagKind(f.path) !== kind);
      if (other !== -1) batch = batch.slice(0, other); // a batch is of one kind
      i += batch.length;
      let embeddings, meta = null;
      if (kind === "documents") ({ embeddings } = await this.#helper.request("documents", { paths: batch.map((f) => f.path) }));
      else {
        const thumb = (f) => thumbnail(f.path, signal).catch(() => null);
        // The pictures themselves, then thumbnails for what that didn't work for.
        const sources = await Promise.all(batch.map((f) => (mediaKind(f.path) === "image" ? f.path : thumb(f))));
        ({ embeddings, meta } = await this.#helper.request("images", { paths: sources.map((s) => s ?? "") }));
        const retry = batch.map((f, j) => (!embeddings[j] && sources[j] === f.path ? j : -1)).filter((j) => j !== -1);
        if (retry.length) {
          const thumbs = await Promise.all(retry.map((j) => thumb(batch[j])));
          const again = (await this.#helper.request("images", { paths: thumbs.map((t) => t ?? "") })).embeddings;
          embeddings = [...embeddings];
          retry.forEach((j, k) => (embeddings[j] = thumbs[k] ? again[k] : null));
        }
      }
      signal?.throwIfAborted();
      const tags = {}, items = [];
      batch.forEach((f, j) => {
        if (!embeddings[j]) return;
        const item = kind === "documents" ? { sig: sig(f), doc: embeddings[j] } : { sig: sig(f), emb: embeddings[j], ...(meta?.[j] ? { meta: meta[j] } : {}) };
        store.items[basename(f.path)] = item;
        tags[f.path] = all[f.path] = tagsOf(f, item);
        items.push([f.path, item]);
      });
      await this.#save(this.#folderFile(dir), store);
      yield { tags, descriptions: described(items), left: todo.length - i };
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
   * Searching a tagged folder's pictures and documents (those of `kinds`) by
   * description: {path: score} for the ones that match `text` (the helper
   * embeds it), best first. A picture's score is how likely it shows it, a
   * document's how much better it fits than text about nothing.
   */
  async search(dir, text, kinds = { pictures: true, documents: false }) {
    const store = await this.#load(`folder ${dir}`, this.#folderFile(dir));
    const items = Object.entries(store.items ?? {});
    const dot = (a, b) => {
      let d = 0;
      for (let k = 0; k < a.length; k++) d += a[k] * b[k];
      return d;
    };
    const found = [];
    if (kinds.pictures && items.some(([, it]) => it.emb)) {
      const { scale, bias } = await this.#textEmbeddings([]);
      const q = decode((await this.#helper.request("texts", { texts: [text] })).embeddings[0]);
      for (const [name, item] of items) {
        if (!item.emb) continue;
        const p = 1 / (1 + Math.exp(-(dot(decode(item.emb), q) * scale + bias)));
        if (p >= SEARCH_CUTOFF) found.push([join(dir, name), p]);
      }
    }
    if (kinds.documents && items.some(([, it]) => it.doc)) {
      const { embeddings: [query], base: [base] } = await this.#helper.request("queries", { texts: [text] });
      const q = decode(query);
      for (const [name, item] of items) {
        if (!item.doc) continue;
        const s = dot(decode(item.doc), q) - base;
        if (s >= DOC_SEARCH_CUTOFF) found.push([join(dir, name), s]);
      }
    }
    found.sort((a, b) => b[1] - a[1]);
    return Object.fromEntries(found.map(([p, s]) => [p, Math.round(s * 1000) / 1000]));
  }

  // Document tags' embeddings and bases (EmbeddingGemma 2's), asking the helper for the ones not seen before.
  async #queryEmbeddings(vocab) {
    const file = this.#cacheDir && join(this.#cacheDir, "queries.json");
    const store = await this.#load("queries", file);
    store.texts ??= {};
    const missing = vocab.filter((t) => !store.texts[t]);
    if (missing.length) {
      const { embeddings, base } = await this.#helper.request("queries", { texts: missing });
      missing.forEach((t, i) => (store.texts[t] = { emb: embeddings[i], base: base[i] }));
      await this.#save(file, store);
    }
    return vocab.map((t) => ({ emb: decode(store.texts[t].emb), base: store.texts[t].base }));
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

// A document's tags: those that fit it well above the rest of the list (how
// well each fits, less how well it fits text about nothing, as standard
// deviations from the list's mean), best first.
function scoreDocument(emb, vocab, queries) {
  const scores = queries.map(({ emb: q, base }) => {
    let dot = 0;
    for (let k = 0; k < emb.length; k++) dot += emb[k] * q[k];
    return dot - base;
  });
  if (scores.length < 3) return [];
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const sd = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length) || 1;
  return scores.map((s, i) => [vocab[i], Math.round(((s - mean) / sd) * 100) / 100, s])
    .filter(([, z, s]) => z >= DOC_CUTOFF && s > 0).sort((a, b) => b[1] - a[1]).slice(0, MOST).map(([t, z]) => [t, z]);
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
        // Offline: the models are downloaded by the installer, and nothing goes out while tagging.
        env: { PYTHONUNBUFFERED: "1", TRANSFORMERS_VERBOSITY: "error", HF_HUB_OFFLINE: "1" },
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
