// Syntax highlighting with highlight.js (vendor/, BSD-3-Clause): which
// language a file is, and its text as highlighted HTML, a line at a time.
import hljs from "./vendor/highlight.min.mjs";
import dockerfile from "./vendor/hljs-dockerfile.min.mjs";
import nginx from "./vendor/hljs-nginx.min.mjs";
import properties from "./vendor/hljs-properties.min.mjs";

hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("nginx", nginx);
hljs.registerLanguage("properties", properties);

/** highlight.js names and display names, "plaintext" first. */
export const LANGUAGES = [["plaintext", "Plain text"], ...hljs.listLanguages()
  .filter((l) => !["plaintext", "php-template", "python-repl", "shell"].includes(l))
  .map((l) => [l, hljs.getLanguage(l).name ?? l])
  .sort((a, b) => a[1].localeCompare(b[1]))];

const EXTENSIONS = {
  javascript: "js mjs cjs jsx",
  typescript: "ts mts cts tsx",
  json: "json jsonc json5 geojson webmanifest",
  css: "css", scss: "scss sass", less: "less",
  xml: "html htm xhtml xml svg xsl plist vue svelte",
  markdown: "md markdown mdx",
  bash: "sh bash zsh ksh bashrc zshrc profile",
  python: "py pyw pyi",
  lua: "lua",
  ini: "toml ini conf cfg desktop service timer socket mount target path rules env editorconfig gitconfig hl",
  properties: "properties",
  yaml: "yaml yml",
  rust: "rs", go: "go", c: "c h", cpp: "cc cpp cxx hpp hh hxx ino",
  java: "java", kotlin: "kt kts", swift: "swift", csharp: "cs",
  ruby: "rb", perl: "pl pm", php: "php", r: "r", sql: "sql", graphql: "graphql gql",
  diff: "diff patch", makefile: "mk", dockerfile: "dockerfile containerfile",
};
const BY_EXTENSION = Object.fromEntries(Object.entries(EXTENSIONS).flatMap(([lang, exts]) => exts.split(" ").map((e) => [e, lang])));
const BY_NAME = {
  makefile: "makefile", gnumakefile: "makefile", dockerfile: "dockerfile", containerfile: "dockerfile", pkgbuild: "bash",
  ".bashrc": "bash", ".bash_profile": "bash", ".profile": "bash", ".zshrc": "bash", ".zprofile": "bash", ".xinitrc": "bash",
  ".gitconfig": "ini", ".editorconfig": "ini", ".env": "ini", "nginx.conf": "nginx",
};

/** A file's language, from its name, or else its first line or a guess from its start. */
export function detectLanguage(path, text = "") {
  const name = (path ?? "").split("/").pop().toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (BY_EXTENSION[ext]) return BY_EXTENSION[ext];
  const firstLine = text.slice(0, text.indexOf("\n") + 1 || undefined);
  const shebang = /^#!.*\b(bash|sh|zsh|dash|ksh|python3?|node|deno|lua|perl|ruby)\b/.exec(firstLine);
  if (shebang) return { python: "python", python3: "python", node: "javascript", deno: "typescript", lua: "lua", perl: "perl", ruby: "ruby" }[shebang[1]] ?? "bash";
  if (!text.trim() || ext === "txt" || ext === "log") return "plaintext";
  // A first real line like "[section]" or "key = value": an INI-style config.
  const first = text.split("\n").find((l) => l.trim() && !/^\s*[#;]/.test(l)) ?? "";
  if (/^\s*\[[^\]]+\]\s*$/.test(first) || /^\s*[\w.-]+\s*=/.test(first)) return "ini";
  // No name to go by (config files often have none): ask highlight.js, among
  // the likely ones.
  const guess = hljs.highlightAuto(text.slice(0, 4000), ["ini", "bash", "yaml", "json", "xml", "python", "lua", "css", "markdown"]);
  return guess.relevance >= 5 ? guess.language : "plaintext";
}

const COMMENTS = {
  "#": "bash python ruby perl r yaml ini properties makefile dockerfile nginx graphql",
  "//": "javascript typescript json c cpp java kotlin swift csharp go rust scss less php",
  "--": "lua sql",
};
const COMMENT_OF = Object.fromEntries(Object.entries(COMMENTS).flatMap(([mark, langs]) => langs.split(" ").map((l) => [l, mark])));
const BLOCK_COMMENT_OF = { css: ["/*", "*/"], xml: ["<!--", "-->"], markdown: ["<!--", "-->"] };

/** How a line is commented out: { line: "#" } or { block: ["/*", "*\/"] }; null if it can't be. */
export const commentOf = (lang) => (COMMENT_OF[lang] ? { line: COMMENT_OF[lang] } : BLOCK_COMMENT_OF[lang] ? { block: BLOCK_COMMENT_OF[lang] } : null);

const escape = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
export { escape };

/**
 * `text` highlighted as `lang`, as one HTML string per line: spans open at a
 * line break are closed at its end and opened again on the next line, so
 * any line can be shown on its own.
 */
export function highlightLines(text, lang) {
  if (lang === "plaintext" || !hljs.getLanguage(lang)) return text.split("\n").map(escape);
  const html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  const lines = [];
  const open = []; // the <span ...> tags open at this point
  let line = "";
  for (const [tok] of html.matchAll(/<span [^>]*>|<\/span>|\n|[^<\n]+/g)) {
    if (tok === "\n") {
      lines.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else {
      if (tok.startsWith("<span")) open.push(tok);
      else if (tok === "</span>") open.pop();
      line += tok;
    }
  }
  lines.push(line);
  return lines;
}
