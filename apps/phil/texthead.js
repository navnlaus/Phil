import { extname } from "@std/path";

const HEAD = 32 * 1024; // bytes read from the start of a file
const MAX_LINES = 400;
const MAX_CHARS = 200; // per line

/**
 * The start of a text file, for drawing on its tile (ui/app.js): up to 400
 * lines (`maxLines`, of up to `maxChars` characters), each [kind, text] where kind is "h1".."h6" for a Markdown heading,
 * "c" for a comment line and "" otherwise. `prose`: Markdown or plain text,
 * drawn in a proportional font. null for files that aren't text (binary, or
 * not UTF-8) or are empty.
 */
export async function textHead(path, { maxLines = MAX_LINES, maxChars = MAX_CHARS } = {}) {
  const bytes = await head(path);
  if (!bytes.length || bytes.includes(0)) return null;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true }); // stream: a character cut off at the end is fine
  } catch {
    return null;
  }
  // Text has few control characters besides tab, newline, carriage return, form feed and escape.
  const controls = text.match(/[\x01-\x08\x0e-\x1a\x1c-\x1f\x7f]/g)?.length ?? 0;
  if (controls > text.length / 100) return null;

  const ext = extname(path).toLowerCase();
  const markdown = ext === ".md" || ext === ".markdown";
  const comment = markdown ? null : commentPrefix(ext);
  let fenced = false; // inside a Markdown ``` block, where # isn't a heading
  const lines = text.split(/\r?\n/, maxLines).map((line) => {
    line = line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\t/g, "    ").slice(0, maxChars); // colored logs, tabs
    const trimmed = line.trimStart();
    if (markdown && trimmed.startsWith("```")) fenced = !fenced;
    const heading = markdown && !fenced && /^(#{1,6})\s/.exec(trimmed);
    const kind = heading ? `h${heading[1].length}` : comment?.test(trimmed) ? "c" : "";
    return [kind, line];
  });
  if (!lines.some(([, l]) => l.trim())) return null;
  return { lines, prose: markdown || ext === ".txt" || ext === "" };
}

async function head(path) {
  const file = await Deno.open(path);
  try {
    const buf = new Uint8Array(HEAD);
    let n = 0;
    while (n < HEAD) {
      const got = await file.read(buf.subarray(n));
      if (!got) break;
      n += got;
    }
    return buf.subarray(0, n);
  } finally {
    file.close();
  }
}

// Lines starting with this are comments, by file type (a guess; it only dims them).
function commentPrefix(ext) {
  if ([".js", ".mjs", ".ts", ".jsx", ".tsx", ".c", ".h", ".cpp", ".hpp", ".cc", ".rs", ".go", ".java", ".kt", ".swift", ".css", ".scss", ".jsonc", ".zig", ".dart", ".cs"].includes(ext)) {
    return /^(\/\/|\/\*|\*)/;
  }
  if ([".lua", ".sql", ".hs"].includes(ext)) return /^--/;
  if ([".ini", ".lisp", ".el", ".clj", ".asm", ".s"].includes(ext)) return /^;/;
  if ([".vim"].includes(ext)) return /^"/;
  return /^#(?!!)/; // shell, Python, YAML, TOML, conf files, ... (not a #! line)
}

/** A shorter start, for a folder's preview: a quarter of a tile shows less. */
export const textPreview = (path) => textHead(path, { maxLines: 40, maxChars: 100 });
