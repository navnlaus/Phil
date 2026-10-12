// Word processor documents (Word, RTF, OpenDocument and the like) as Markdown,
// for reading: textedit shows them rendered and read-only, phil draws their
// text on their tiles. LibreOffice converts them (soffice --convert-to md,
// its Markdown export), keeping headings, emphasis, lists, tables, links and
// pictures (embedded ones inline, as data: URLs), and dropping the rest
// (fonts, colors, layout).
//
// One conversion at a time: LibreOffice runs one per profile, and a second
// started meanwhile hands its work to the first, which drops it. phil's own
// profile, apart from the user's LibreOffice, is in $XDG_RUNTIME_DIR; another
// phil converting at the same moment is waited out (convert() retries).
import { basename, extname, join } from "@std/path";

const EXTENSIONS = new Set([
  ".rtf", ".doc", ".docx", ".docm", ".dot", ".dotx", ".odt", ".ott", ".fodt", ".wps", ".wpd", ".abw", ".pages",
]);
const TIMEOUT = 60_000; // ms, for one conversion
const KEEP = 32; // conversions kept in memory

/** Whether `path` is a document this converts (by its extension). */
export const isDocument = (path) => EXTENSIONS.has(extname(path).toLowerCase());

/** What kind of document, for saying so: "RTF", "DOCX", ... */
export const documentType = (path) => extname(path).slice(1).toUpperCase();

const memory = new Map(); // key -> Promise of the Markdown, the most recently used last
const queue = []; // conversions waiting their turn: { key, fn, resolve, reject, signal }
let busy = false;

/**
 * The document at `path` as Markdown. `urgent`: someone is waiting to read
 * it, so it goes before the tiles' conversions. `cacheDir`: also kept there,
 * across runs. `signal`: given up on (a tile scrolled away) before its turn.
 */
export async function documentMarkdown(path, { urgent = false, cacheDir = null, signal } = {}) {
  const stat = await Deno.stat(path);
  const key = await hash(`${path}\0${stat.size}\0${stat.mtime?.getTime() ?? 0}`);
  let job = memory.get(key);
  if (job && urgent) hurry(key);
  if (!job) {
    job = (async () => {
      const cached = cacheDir ? await Deno.readTextFile(join(cacheDir, `${key}.md`)).catch(() => null) : null;
      if (cached !== null) return cached;
      const md = await inTurn(key, () => convert(path), { urgent, signal });
      if (cacheDir) {
        await Deno.mkdir(cacheDir, { recursive: true });
        await Deno.writeTextFile(join(cacheDir, `${key}.md`), md);
      }
      return md;
    })();
    job.catch(() => memory.get(key) === job && memory.delete(key)); // tried again next time
  }
  memory.delete(key);
  memory.set(key, job);
  if (memory.size > KEEP) memory.delete(memory.keys().next().value);
  return job;
}

function inTurn(key, fn, { urgent, signal }) {
  return new Promise((resolve, reject) => {
    const task = { key, fn, resolve, reject, signal };
    if (urgent) queue.unshift(task);
    else queue.push(task);
    next();
  });
}

// A conversion a tile asked for, now wanted for reading: to the front, and
// done even if the tile gives up on it.
function hurry(key) {
  const i = queue.findIndex((t) => t.key === key);
  if (i < 0) return;
  const [task] = queue.splice(i, 1);
  task.signal = null;
  queue.unshift(task);
}

async function next() {
  if (busy) return;
  const task = queue.shift();
  if (!task) return;
  busy = true;
  try {
    if (task.signal?.aborted) throw task.signal.reason ?? new DOMException("Aborted", "AbortError");
    task.resolve(await task.fn());
  } catch (err) {
    task.reject(err);
  } finally {
    busy = false;
    next();
  }
}

async function convert(path) {
  const runtime = Deno.env.get("XDG_RUNTIME_DIR") || "/tmp";
  const profile = join(runtime, "phil-libreoffice");
  const out = await Deno.makeTempDir({ dir: runtime, prefix: "phil-document-" });
  try {
    for (let attempt = 0; ; attempt++) {
      let result;
      try {
        result = await new Deno.Command("soffice", {
          args: [`-env:UserInstallation=file://${encodeURI(profile)}`, "--headless", "--norestore", "--convert-to", "md", "--outdir", out, path],
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
          signal: AbortSignal.timeout(TIMEOUT),
        }).output();
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) throw new Error("Reading documents needs LibreOffice (soffice)");
        throw new Error(`LibreOffice didn't finish converting ${basename(path)}`);
      }
      const md = await Deno.readTextFile(join(out, basename(path, extname(path)) + ".md")).catch(() => null);
      if (md !== null) return absoluteLinks(md, out);
      const said = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
      if (/no export filter/i.test(said)) throw new Error("This LibreOffice can't write Markdown; a newer one can (its Markdown export)");
      if (/source file could not be loaded|general input\/output error/i.test(said) || attempt >= 4) {
        throw new Error(`LibreOffice couldn't read ${basename(path)}`);
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1))); // another phil's LibreOffice has the profile
    }
  } finally {
    await Deno.remove(out, { recursive: true }).catch(() => {});
  }
}

// LibreOffice writes links to files relative to where it wrote the Markdown
// (a temporary folder); made absolute, they point at the files themselves.
function absoluteLinks(md, out) {
  return md.replace(/(\]\(\s*<?)([^)\s>]+)/g, (m, open, target) => {
    if (/^([a-z][\w+.-]*:|#|\/)/i.test(target)) return m;
    return open + new URL(target, `file://${encodeURI(out)}/`).pathname;
  });
}

async function hash(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

