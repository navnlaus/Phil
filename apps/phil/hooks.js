// phil's own metadata for files and folders, set in their Properties: a
// description (shown on the tile) and, for files, an on-change hook: a command
// run when the file changes while a phil window shows its folder, and only
// then. Through a link, it's the file the link points to that's watched. Kept
// with phil's settings in metadata.json:
// {"<path>": {"description": "...", "onChange": "<command>"}}, which is read
// again whenever it's needed, so editing it by hand works too.
import { dirname, join } from "@std/path";

const OUTPUT_LIMIT = 4000; // of a run's output, the end is kept

export class Hooks {
  #file;
  #persist;
  #memory = null; // incognito: changes are kept here, not saved
  #onRun;
  #watched = new Map(); // folder -> { count, close, generation }
  #running = new Set();

  /**
   * `file`: metadata.json. `persist`: false for incognito (changes last the
   * session). `onRun({path, command, ok, code, output})` after every run.
   */
  constructor(file, { persist = true, onRun = () => {} } = {}) {
    this.#file = file;
    this.#persist = persist;
    this.#onRun = onRun;
  }

  /** Every path's metadata. */
  async all() {
    if (this.#memory) return structuredClone(this.#memory);
    try {
      const all = JSON.parse(await Deno.readTextFile(this.#file));
      return all && typeof all === "object" ? all : {};
    } catch {
      return {};
    }
  }

  async get(path) {
    return (await this.all())[path] ?? {};
  }

  /** Changes `path`'s metadata; empty values remove keys (and the path, when none are left). */
  async set(path, changes) {
    const all = await this.all();
    const meta = Object.fromEntries(Object.entries({ ...all[path], ...changes }).filter(([, v]) => v));
    if (Object.keys(meta).length) all[path] = meta;
    else delete all[path];
    await this.#save(all);
    this.#rewatch(dirname(path));
  }

  /** After a rename or move (`to`), or a delete (`to` null): the metadata goes along, or away. */
  async moved(from, to) {
    const all = await this.all();
    let changed = false;
    for (const path of Object.keys(all)) {
      if (path !== from && !path.startsWith(from + "/")) continue;
      if (to) all[to + path.slice(from.length)] = all[path];
      delete all[path];
      changed = true;
    }
    if (!changed) return;
    await this.#save(all);
    for (const dir of [dirname(from), to && dirname(to)]) if (dir) this.#rewatch(dir);
  }

  async #save(all) {
    if (!this.#persist) return void (this.#memory = all);
    await Deno.mkdir(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(all, null, 2) + "\n");
    await Deno.rename(tmp, this.#file);
  }

  /**
   * A window shows `dir`: its files' hooks are live until close(). Several
   * windows showing it share one watcher, so a change runs a hook once.
   */
  watch(dir) {
    let w = this.#watched.get(dir);
    if (!w) {
      this.#watched.set(dir, w = { count: 0, close() {}, generation: 0 });
      this.#rewatch(dir);
    }
    w.count++;
    let closed = false;
    return {
      close: () => {
        if (closed) return;
        closed = true;
        if (--w.count) return;
        w.close();
        this.#watched.delete(dir);
      },
    };
  }

  // (Re)starts the watcher for a shown folder's hooked files: their real
  // folders are watched, and a hook runs when its file's contents changed
  // (not when it was only opened or touched), 300ms after the last event.
  async #rewatch(dir) {
    const w = this.#watched.get(dir);
    if (!w) return;
    const generation = ++w.generation;
    const files = new Map(); // real path -> { path, sig }
    for (const [path, meta] of Object.entries(await this.all())) {
      if (dirname(path) !== dir || !meta.onChange) continue;
      const real = await Deno.realPath(path).catch(() => null);
      if (real) files.set(real, { path, sig: await signature(real) });
    }
    if (w.generation !== generation || this.#watched.get(dir) !== w) return; // superseded, or no longer shown
    w.close();
    w.close = () => {};
    if (!files.size) return;
    let watcher;
    try {
      watcher = Deno.watchFs([...new Set([...files.keys()].map(dirname))], { recursive: false });
    } catch (err) {
      return console.error(`phil: can't watch for hooks in ${dir}: ${err.message}`);
    }
    const timers = new Map();
    w.close = () => (timers.forEach(clearTimeout), watcher.close());
    (async () => {
      for await (const event of watcher) {
        if (event.kind === "access") continue;
        for (const real of event.paths) {
          const file = files.get(real);
          if (!file) continue;
          clearTimeout(timers.get(real));
          timers.set(real, setTimeout(() => (timers.delete(real), this.#changed(real, file)), 300));
        }
      }
    })().catch(() => {});
  }

  // Changes the hook makes to its own file don't run it again.
  async #changed(real, file) {
    const now = await signature(real);
    if (!now || now === file.sig || this.#running.has(file.path)) return;
    const { onChange } = await this.get(file.path);
    if (!onChange) return;
    this.#running.add(file.path);
    try {
      const result = await runHook(file.path, onChange);
      console.log(`phil: ${file.path} changed, ran ${JSON.stringify(onChange)}: ${result.ok ? "ok" : `failed (${result.code})`}${result.output ? `\n${result.output}` : ""}`);
      this.#onRun({ path: file.path, command: onChange, ...result });
    } finally {
      file.sig = await signature(real);
      this.#running.delete(file.path);
    }
  }
}

/**
 * Runs a hook: `command` in bash, in the file's folder, with the file as $1
 * and $PHIL_FILE. Resolves to {ok, code, output} (stdout then stderr, the end).
 * A plain command is run by bash directly, so `sudo ...` is phil's child and
 * goes without a password while sudo remembers the one given to save a file.
 */
export async function runHook(path, command) {
  try {
    const out = await new Deno.Command("bash", {
      args: ["-c", command, "phil-hook", path],
      cwd: dirname(path),
      env: { PHIL_FILE: path },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const decode = (bytes) => new TextDecoder().decode(bytes).trimEnd();
    const output = [decode(out.stdout), decode(out.stderr)].filter(Boolean).join("\n");
    return { ok: out.success, code: out.code, output: output.length > OUTPUT_LIMIT ? "…" + output.slice(-OUTPUT_LIMIT) : output };
  } catch (err) {
    return { ok: false, code: -1, output: err.message };
  }
}

// What tells a change: contents (size, time) or a new file in its place.
async function signature(path) {
  try {
    const s = await Deno.stat(path);
    return `${s.size} ${s.mtime?.getTime()} ${s.ino}`;
  } catch {
    return null;
  }
}

export const metadataFile = (settingsFile) => join(dirname(settingsFile), "metadata.json");
