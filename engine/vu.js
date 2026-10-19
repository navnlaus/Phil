// vu FILE...: files shown in the terminal as cat shows them, but to read:
// Markdown rendered (headings, emphasis, lists, quotes, tables, code
// highlighted, links), documents (Word, RTF, OpenDocument, ...: documents.js)
// converted to Markdown first, pictures drawn in the text (iTerm's inline
// image protocol, which phil's terminal draws: xterm.js's image addon), fitted
// to the terminal and never enlarged; other text highlighted as code. Into a
// pipe or a file: the text plain, pictures left out.
//
// phil's terminal runs it as `vu` (shell-init.bash): phil-engine --vu FILE...

import { dirname, extname, fromFileUrl, join, resolve } from "@std/path";
import { documentMarkdown, isDocument } from "./documents.js";

const PICTURES = new Set(["png", "jpg", "jpeg", "jpe", "jfif", "gif", "webp", "avif", "heic", "heif", "tif", "tiff", "bmp", "svg", "ico", "jxl", "qoi"]);
const MARKDOWN = new Set(["md", "markdown", "mdx", "mkd"]);
const MAX_BYTES = 3 << 20; // a picture with more is made again, smaller (vips)
const CELL = { w: 9, h: 18 }; // px, a terminal's cell, if it doesn't say
const MAX_WIDTH = 100; // columns text is wrapped at, at most

const USAGE = `Usage: vu FILE...

Shows files in the terminal, as cat does, but to read: Markdown rendered,
documents (Word, RTF, OpenDocument, ...) converted to Markdown and rendered,
pictures drawn, fitted to the terminal; other text highlighted.`;

/** `phil-engine --vu ...args`. */
export async function vu(args) {
  const files = args.filter((a) => a !== "--");
  if (!files.length || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    Deno.exit(files.length ? 0 : 2);
  }
  const tty = Deno.stdout.isTerminal();
  const out = new Output(tty);
  const width = Math.max(20, Math.min(MAX_WIDTH, tty ? Deno.consoleSize().columns : 80));
  // Where a picture goes, at most (px): the terminal's width, its height but for the line
  // with the command and the prompt after, each with a blank line before it as prompts often
  // have (asked once there's a picture).
  let asked = null;
  const box = () => (asked ??= cellSize().then((cell) => {
    const { columns, rows } = Deno.consoleSize();
    return { w: columns * (cell ?? CELL).w, h: Math.max(4, rows - 4) * (cell ?? CELL).h };
  }));
  let status = 0;
  for (const [n, path] of files.entries()) {
    try {
      if (files.length > 1) out.line((n ? "\n" : "") + paint([{ t: `── ${path} ──`, s: "2" }], tty));
      await show(path, { tty, width, out, box });
    } catch (err) {
      await out.flush();
      const why = err instanceof Deno.errors.NotFound ? "no such file" : err instanceof Deno.errors.PermissionDenied ? "not allowed to read it" : err.message;
      console.error(`vu: ${path}: ${why}`);
      status = 1;
    }
  }
  await out.flush();
  Deno.exit(status);
}

async function show(path, ctx) {
  const stat = await Deno.stat(path);
  if (stat.isDirectory) throw new Error("is a folder");
  const ext = extname(path).slice(1).toLowerCase();
  const base = dirname(resolve(path));
  if (isDocument(path)) {
    const incognito = !!Deno.env.get("PHIL_INCOGNITO");
    const cacheHome = Deno.env.get("XDG_CACHE_HOME") || join(Deno.env.get("HOME") ?? "/tmp", ".cache");
    const md = await documentMarkdown(path, { urgent: true, cacheDir: incognito ? null : join(cacheHome, "phil", "thumbnails", "documents") });
    return markdown(md, base, ctx);
  }
  const bytes = await Deno.readFile(path);
  if (PICTURES.has(ext) || sniff(bytes)) return ctx.out.picture(ctx.tty ? await picture(bytes, path, await ctx.box()) : {}, path, ctx);
  if (bytes.subarray(0, 8192).includes(0)) throw new Error("not text, a document or a picture");
  const text = new TextDecoder().decode(bytes);
  if (MARKDOWN.has(ext)) return markdown(text, base, ctx);
  const { detectLanguage, highlightRuns } = await import("./ui/syntax.js");
  for (const line of highlightRuns(clean(text).replace(/\n$/, ""), detectLanguage(path, text))) {
    ctx.out.line(paint(line.map(([t, role]) => ({ t, s: ROLE_STYLES[role] ?? "" })), ctx.tty));
  }
}

// ---- Output: lines, and pictures between them, in order (the pictures as they're ready).

class Output {
  constructor(tty) {
    this.tty = tty;
    this.text = "";
    this.writing = Promise.resolve();
  }
  line(s) {
    this.text += s + "\n";
    if (this.text.length > 1 << 16) this.flush();
  }
  // What's been given so far, written (in turn).
  flush() {
    const bytes = new TextEncoder().encode(this.text);
    this.text = "";
    return (this.writing = this.writing.then(async () => {
      try {
        for (let at = 0; at < bytes.length;) at += await Deno.stdout.write(bytes.subarray(at));
      } catch (err) {
        if (err instanceof Deno.errors.BrokenPipe) Deno.exit(0); // (vu ... | head)
        throw err;
      }
    }));
  }
  // `got`: picture()'s; `name` for saying what it was if it's not drawn.
  async picture(got, name, ctx, alt = "") {
    const label = alt || name.split("/").pop();
    if (!ctx.tty || !got.data) {
      const why = !ctx.tty ? "" : `: ${got.error}`;
      return this.line(paint([{ t: `[picture: ${label}${why}]`, s: "2" }], ctx.tty));
    }
    let b64 = "";
    for (let at = 0; at < got.data.length; at += 49152) b64 += btoa(String.fromCharCode(...got.data.subarray(at, at + 49152)));
    // (The addon puts the cursor on the picture's last row: the next line goes below it.)
    const width = got.width ? `;width=${got.width}px` : "";
    this.text += `\x1b]1337;File=inline=1;size=${got.data.length}${width};preserveAspectRatio=1:${b64}\x07\n`;
    await this.flush();
  }
}

// ---- Pictures

/** PNG, JPEG or GIF (what the terminal draws) with its size, or null. */
function sniff(d) {
  if (d.length < 24) return null;
  if (d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47) {
    return { type: "png", width: (d[16] << 24 | d[17] << 16 | d[18] << 8 | d[19]) >>> 0, height: (d[20] << 24 | d[21] << 16 | d[22] << 8 | d[23]) >>> 0 };
  }
  if (d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) {
    for (let i = 2; i + 9 < d.length;) {
      if (d[i] !== 0xff) return null;
      const marker = d[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: "jpeg", width: d[i + 7] << 8 | d[i + 8], height: d[i + 5] << 8 | d[i + 6] };
      }
      i += 2 + (d[i + 2] << 8 | d[i + 3]);
    }
    return { type: "jpeg", width: 0, height: 0 };
  }
  if (d[0] === 0x47 && d[1] === 0x49 && d[2] === 0x46) return { type: "gif", width: d[7] << 8 | d[6], height: d[9] << 8 | d[8] };
  return null;
}

/**
 * A picture, ready for the terminal, to fit in `box` (px; never made bigger): as it is if the
 * terminal draws it and it's not too big, else made by vips (a PNG, or a JPEG of a JPEG-like
 * photo). {data, width (px, shown)} or {error}.
 */
async function picture(bytes, name, box) {
  const fitted = (data) => {
    const { width = 0, height = 0 } = sniff(data) ?? {};
    return { data, width: width && height ? Math.max(1, Math.floor(width * Math.min(1, box.w / width, box.h / height))) : 0 };
  };
  const kind = sniff(bytes);
  if (kind && kind.width && kind.width <= box.w && kind.height <= box.h && bytes.length <= MAX_BYTES) return fitted(bytes);
  const ext = extname(name.split(/[?#]/)[0]).slice(1).toLowerCase();
  const photo = kind?.type === "jpeg" || ["jpg", "jpeg", "jpe", "jfif", "heic", "heif"].includes(ext);
  const dir = await Deno.makeTempDir({ prefix: "phil-vu-" });
  try {
    const input = join(dir, `in.${ext && PICTURES.has(ext) ? ext : kind?.type ?? "img"}`);
    const output = join(dir, photo ? "out.jpg" : "out.png");
    await Deno.writeFile(input, bytes);
    const run = await new Deno.Command("vipsthumbnail", {
      args: [input, "--size", `${box.w}x${box.h}>`, "-o", `${output}[${photo ? "Q=85," : ""}keep=none]`],
      stdin: "null", stdout: "null", stderr: "piped",
    }).output().catch((err) => (err instanceof Deno.errors.NotFound ? null : Promise.reject(err)));
    if (!run) return kind && bytes.length <= 15 << 20 ? fitted(bytes) : { error: "showing it needs vips (vipsthumbnail)" };
    if (!run.success) return { error: "not a picture vips can read" };
    return fitted(await Deno.readFile(output));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** A picture a document points to (`src`: a path from `base`, a file:, data: or http(s) URL), as picture() gives it. */
async function fetchPicture(src, base, box) {
  try {
    if (src.startsWith("data:")) {
      const comma = src.indexOf(",");
      const meta = src.slice(5, comma), body = src.slice(comma + 1);
      const bytes = meta.endsWith(";base64")
        ? Uint8Array.from(atob(body.replace(/\s/g, "")), (c) => c.charCodeAt(0))
        : new TextEncoder().encode(decodeURIComponent(body));
      return picture(bytes, `x.${/image\/([\w+]+)/.exec(meta)?.[1]?.replace("svg+xml", "svg").replace("jpeg", "jpg") ?? "img"}`, box);
    }
    if (/^https?:/i.test(src)) {
      const res = await fetch(src, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { error: `${res.status} from ${new URL(src).host}` };
      const type = res.headers.get("content-type") ?? "";
      const name = /svg/.test(type) ? "x.svg" : new URL(src).pathname;
      return picture(new Uint8Array(await res.arrayBuffer()), name, box);
    }
    const path = src.startsWith("file:") ? fromFileUrl(src) : resolve(base, safeDecode(src.split(/[?#]/)[0]));
    return picture(await Deno.readFile(path), path, box);
  } catch (err) {
    return { error: err instanceof Deno.errors.NotFound ? "not found" : err.name === "TimeoutError" ? "took too long to download" : err.message };
  }
}

/**
 * The terminal's cell size, px ({w, h}): its answer to CSI 16 t (phil's terminal's image addon
 * gives it), or null if it doesn't answer.
 */
async function cellSize() {
  if (!Deno.stdin.isTerminal()) return null;
  Deno.stdin.setRaw(true);
  try {
    await Deno.stdout.write(new TextEncoder().encode("\x1b[16t"));
    const answer = (async () => {
      const buf = new Uint8Array(256);
      let got = "";
      for (;;) {
        const n = await Deno.stdin.read(buf);
        if (n === null) return null;
        got += new TextDecoder().decode(buf.subarray(0, n));
        // deno-lint-ignore no-control-regex
        const m = /\x1b\[6;(\d+);(\d+)t/.exec(got);
        if (m) return { w: Number(m[2]), h: Number(m[1]) };
      }
    })();
    return await Promise.race([answer, new Promise((r) => setTimeout(() => r(null), 500))]);
  } catch {
    return null;
  } finally {
    Deno.stdin.setRaw(false);
  }
}

const safeDecode = (s) => {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
};

// ---- Markdown

async function markdown(md, base, ctx) {
  const lines = clean(md).split("\n").map((l) => l.replace(/^\t+/, (t) => "    ".repeat(t.length)));
  const refs = {};
  let blocks;
  // Front matter: shown as it is, dimmed.
  if (lines[0] === "---" && lines.indexOf("---", 1) > 0) {
    const end = lines.indexOf("---", 1);
    blocks = [{ type: "front", lines: lines.slice(0, end + 1) }, ...parseBlocks(lines.slice(end + 1), refs)];
  } else blocks = parseBlocks(lines, refs);
  const pictures = new Map(); // src -> fetchPicture()'s promise (all fetched at once, shown in order)
  // Code in it: highlighted (highlight.js, loaded only then).
  const highlight = /^ {0,3}(```|~~~)/m.test(md) ? (await import("./ui/syntax.js")).highlightRuns : null;
  const r = { ...ctx, refs, depth: 0, highlight, picture: (src) => pictures.get(src) ?? pictures.set(src, ctx.tty ? ctx.box().then((box) => fetchPicture(src, base, box)) : Promise.resolve({})).get(src) };
  for (const item of renderBlocks(blocks, ctx.width, r)) {
    if (typeof item === "string") ctx.out.line(item);
    else await ctx.out.picture(await item.got, item.src, ctx, item.alt);
  }
}

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const HTML_BLOCK = /^ {0,3}(?:<\/?[a-zA-Z][\w-]*(?:\s|\/?>|$)|<!--)/;
const REF = /^ {0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+["'(].*["')])?\s*$/;

const startsBlock = (line) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || HTML_BLOCK.test(line) || /^ {0,3}(?:[-*+]|1[.)])[ \t]+\S/.test(line);

function parseBlocks(lines, refs) {
  const blocks = [];
  let i = 0, m;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
    } else if ((m = FENCE.exec(line))) {
      const [, indent, fence, lang] = m;
      const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
      const body = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i].replace(new RegExp(`^ {0,${indent.length}}`), ""));
      i++;
      blocks.push({ type: "code", lang, lines: body });
    } else if ((m = HEADING.exec(line))) {
      blocks.push({ type: "heading", level: m[1].length, text: m[2] ?? "" });
      i++;
    } else if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
    } else if (QUOTE.test(line)) {
      const body = [];
      for (; i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !startsBlock(lines[i])); i++) body.push(lines[i].replace(QUOTE, ""));
      blocks.push({ type: "quote", children: parseBlocks(body, refs) });
    } else if (/^ {4}/.test(line)) {
      const body = [];
      for (; i < lines.length && (/^ {4}/.test(lines[i]) || !lines[i].trim()); i++) body.push(lines[i].slice(4));
      while (body.length && !body.at(-1).trim()) body.pop();
      blocks.push({ type: "code", lang: "", lines: body });
    } else if (LIST.test(line)) {
      i = parseList(lines, i, refs, blocks);
    } else if (line.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "") && lines[i + 1].includes("-")) {
      const align = cells(lines[i + 1]).map((c) => (c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : "left"));
      const header = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(cells(lines[i]));
      blocks.push({ type: "table", align, header, rows });
    } else if (HTML_BLOCK.test(line)) {
      const body = [];
      for (; i < lines.length && lines[i].trim(); i++) body.push(lines[i]);
      blocks.push({ type: "html", text: body.join("\n") });
    } else if ((m = REF.exec(line))) {
      refs[m[1].toLowerCase()] ??= m[2];
      i++;
    } else {
      const para = [line];
      for (i++; i < lines.length && lines[i].trim(); i++) {
        const setext = /^ {0,3}(=+|-+)\s*$/.exec(lines[i]);
        if (setext) {
          blocks.push({ type: "heading", level: setext[1][0] === "=" ? 1 : 2, text: para.join(" ") });
          para.length = 0;
          i++;
          break;
        }
        if (startsBlock(lines[i]) || (lines[i].includes("|") && TABLE_SEP.test(lines[i + 1] ?? "") && lines[i + 1].includes("-"))) break;
        para.push(lines[i]);
      }
      if (para.length) blocks.push({ type: "para", text: para.join("\n") });
    }
  }
  return blocks;
}

// A list from line `i`, into `blocks`; returns the line after it.
function parseList(lines, i, refs, blocks) {
  const ordered = /\d/.test(LIST.exec(lines[i])[2]);
  const list = { type: "list", ordered, start: ordered ? parseInt(LIST.exec(lines[i])[2]) : 1, items: [], loose: false };
  let m;
  while (i < lines.length && (m = LIST.exec(lines[i])) && /\d/.test(m[2]) === ordered) {
    const indent = m[3].length && m[3].length <= 4 ? m[0].length : m[1].length + m[2].length + 1;
    const body = [lines[i].slice(Math.min(indent, lines[i].length))];
    let blank = false;
    for (i++; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim()) {
        body.push("");
        blank = true;
      } else if (/^ */.exec(l)[0].length >= indent) {
        body.push(l.slice(indent));
        blank = false;
      } else if (blank || LIST.test(l) || startsBlock(l)) {
        break;
      } else body.push(l.trim()); // (a paragraph's lazy continuation)
    }
    while (body.length && !body.at(-1).trim()) body.pop();
    // A blank line between its blocks, or before the next item: a loose list (its items spaced).
    if (body.includes("") || (blank && /\d/.test(LIST.exec(lines[i] ?? "")?.[2] ?? "x") === ordered)) list.loose = true;
    const task = /^\[([ xX])\][ \t]+/.exec(body[0]);
    if (task) body[0] = body[0].slice(task[0].length);
    list.items.push({ task: task ? task[1] !== " " : null, children: parseBlocks(body, refs) });
  }
  blocks.push(list);
  return i;
}

function cells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replaceAll("\\|", "|"));
}

// ---- Rendering: lines (strings, painted), and {got, src, alt} for a picture between them.

const H_STYLES = ["1;35", "1;34", "1;36", "1", "1;3", "3"];
const CODE = "33";
const LINK = "4;34";
const ROLE_STYLES = {
  comment: "3;90", string: "32", number: "33", keyword: "35", literal: "33", type: "36",
  heading: "1", fn: "34", attr: "36", variable: "31", meta: "90",
};
const BULLETS = ["•", "◦", "▪"];
const ALERTS = { NOTE: ["34", "ⓘ Note"], TIP: ["32", "💡 Tip"], IMPORTANT: ["35", "❢ Important"], WARNING: ["33", "⚠ Warning"], CAUTION: ["31", "⛔ Caution"] };

function renderBlocks(blocks, width, ctx, gap = true) {
  const out = [];
  blocks.forEach((b, n) => {
    if (n && gap) out.push("");
    out.push(...renderBlock(b, width, ctx));
  });
  return out;
}

function renderBlock(b, width, ctx) {
  const p = (segs) => paint(segs, ctx.tty);
  switch (b.type) {
    case "front":
      return b.lines.map((l) => p([{ t: l, s: "2" }]));
    case "heading": {
      const style = H_STYLES[b.level - 1];
      const lines = wrap(inline(b.text, ctx, style), width);
      const out = lines.map((l) => p(l.segs));
      if (b.level <= 2) out.push(p([{ t: (b.level === 1 ? "━" : "─").repeat(Math.max(...lines.map((l) => l.w), 3)), s: b.level === 1 ? "35" : "2;34" }]));
      return out;
    }
    case "para":
      return paragraph(inline(b.text, ctx), width, ctx);
    case "code": {
      const text = b.lines.join("\n");
      const lang = HLJS_NAMES[b.lang.toLowerCase()] ?? b.lang.toLowerCase();
      const runs = ctx.highlight ? ctx.highlight(text, lang) : text.split("\n").map((l) => [[l, null]]);
      const bar = { t: "│ ", s: "2" };
      return runs.map((line) => p([bar, ...line.map(([t, role]) => ({ t: t.replaceAll("\t", "    "), s: ROLE_STYLES[role] ?? "" }))]));
    }
    case "quote": {
      let children = b.children, bar = "2", title = null;
      const alert = children[0]?.type === "para" && /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(children[0].text);
      if (alert) {
        const [color, label] = ALERTS[alert[1].toUpperCase()];
        bar = color;
        title = p([{ t: "▌ ", s: color }, { t: label, s: `1;${color}` }]);
        const rest = children[0].text.slice(alert[0].length);
        children = [...(rest.trim() ? [{ type: "para", text: rest }] : []), ...children.slice(1)];
      }
      const inner = renderBlocks(children, width - 2, ctx).map((l) => (typeof l === "string" ? p([{ t: l ? "▌ " : "▌", s: bar }]) + l : l));
      return title ? [title, ...inner] : inner;
    }
    case "list": {
      const markers = b.items.map((it, n) => (it.task !== null ? (it.task ? "✓" : "□") : b.ordered ? `${b.start + n}.` : BULLETS[ctx.depth % BULLETS.length]));
      const col = Math.max(...markers.map(strWidth)) + 1;
      const out = [];
      b.items.forEach((it, n) => {
        if (n && b.loose) out.push("");
        const lines = renderBlocks(it.children, width - col, { ...ctx, depth: ctx.depth + 1 }, b.loose);
        const style = it.task ? "32" : it.task === false ? "2" : "35";
        let first = true;
        for (const l of lines.length ? lines : [""]) {
          if (typeof l !== "string") out.push(l);
          else {
            if (!l && !first) out.push("");
            else out.push((first ? p([{ t: markers[n].padStart(b.ordered ? col - 1 : 1), s: style }]) + " ".repeat(col - (b.ordered ? col - 1 : 1)) : " ".repeat(col)) + l);
            first = false;
          }
        }
      });
      return out;
    }
    case "table":
      return table(b, width, ctx);
    case "rule":
      return [p([{ t: "─".repeat(width), s: "2" }])];
    case "html": {
      // Pictures it has, and its text (tags left out).
      const text = b.text.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
      const out = [];
      for (const img of text.matchAll(/<img\b[^>]*>/gi)) {
        const src = attr(img[0], "src");
        if (src) out.push({ got: ctx.picture(src), src, alt: attr(img[0], "alt") ?? "" });
      }
      const words = entities(text.replace(/<br\s*\/?>/gi, "\n").replace(/<\/?(p|div|h\d|li|tr|details|summary)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, ""));
      for (const part of words.split(/\n\s*\n/)) if (part.trim()) out.push(...wrap(inline(part.trim().replace(/\n\s*/g, "  \n"), ctx), width).map((l) => p(l.segs)));
      return out;
    }
  }
  return [];
}

// highlight.js's names for what code blocks are commonly marked as.
const HLJS_NAMES = { sh: "bash", shell: "bash", zsh: "bash", console: "bash", js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", rs: "rust", yml: "yaml", md: "markdown", html: "xml", svg: "xml", toml: "ini", jsonc: "json", "c++": "cpp", rb: "ruby", kt: "kotlin" };

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? entities(m[1] ?? m[2] ?? m[3]) : null;
};

// A paragraph's runs, its pictures on lines of their own.
function paragraph(runs, width, ctx) {
  const out = [];
  let text = [];
  const flush = () => {
    if (text.some((r) => r.t?.trim() || r.br)) out.push(...wrap(text, width).map((l) => paint(l.segs, ctx.tty)));
    text = [];
  };
  for (const r of runs) {
    if (!r.img) text.push(r);
    else {
      flush();
      out.push({ got: ctx.picture(r.img.src), src: r.img.src, alt: r.img.alt });
    }
  }
  flush();
  return out;
}

function table(b, width, ctx) {
  const n = Math.max(b.header.length, ...b.rows.map((r) => r.length));
  const rows = [b.header, ...b.rows].map((row, y) => Array.from({ length: n }, (_, x) => inline(row[x] ?? "", ctx, y ? "" : "1").filter((r) => !r.img && !r.br)));
  const natural = Array.from({ length: n }, (_, x) => Math.max(1, ...rows.map((row) => row[x].reduce((w, r) => w + strWidth(r.t), 0))));
  // Too wide: the widest columns narrowed, their text wrapped in them.
  const room = width - (3 * n + 1);
  const cols = [...natural];
  while (cols.reduce((a, c) => a + c, 0) > room && Math.max(...cols) > 4) cols[cols.indexOf(Math.max(...cols))]--;
  const line = (l, m, r) => paint([{ t: l + cols.map((c) => "─".repeat(c + 2)).join(m) + r, s: "2" }], ctx.tty);
  const bar = paint([{ t: "│", s: "2" }], ctx.tty);
  const out = [line("┌", "┬", "┐")];
  rows.forEach((row, y) => {
    const wrapped = row.map((runs, x) => wrap(runs, cols[x]));
    const height = Math.max(...wrapped.map((w) => w.length));
    for (let k = 0; k < height; k++) {
      out.push(bar + wrapped.map((w, x) => {
        const l = w[k] ?? { segs: [], w: 0 };
        const pad = cols[x] - l.w, align = b.align[x] ?? "left";
        const left = align === "right" ? pad : align === "center" ? pad >> 1 : 0;
        return " ".repeat(left + 1) + paint(l.segs, ctx.tty) + " ".repeat(pad - left + 1);
      }).join(bar) + bar);
    }
    if (y === 0) out.push(line("├", "┼", "┤"));
  });
  out.push(line("└", "┴", "┘"));
  return out;
}

// ---- Inline: runs of text, {t, s} (s: its SGR parameters), {br}, {img: {src, alt}}.

const PUNCT = /[!-/:-@[-`{-~]/;

function inline(src, ctx, style = "") {
  const runs = [];
  let buf = "";
  const flush = () => {
    if (buf) runs.push({ t: buf, s: style });
    buf = "";
  };
  const add = (more) => {
    flush();
    runs.push(...more);
  };
  const plus = (s) => (style ? `${style};${s}` : s);
  const at = (re, i) => {
    re.lastIndex = i;
    return re.exec(src);
  };
  for (let i = 0; i < src.length;) {
    const c = src[i];
    let m;
    if (c === "\\" && src[i + 1] === "\n") {
      add([{ br: true }]);
      i += 2;
    } else if (c === "\\" && PUNCT.test(src[i + 1] ?? "")) {
      buf += src[i + 1];
      i += 2;
    } else if (c === "\n") {
      if (/ {2,}$/.test(buf)) {
        buf = buf.trimEnd();
        add([{ br: true }]);
      } else buf = buf.trimEnd() + " ";
      i++;
      while (src[i] === " ") i++;
    } else if (c === "`") {
      const ticks = at(/`+/y, i)[0];
      const close = at(new RegExp(`(?<!\`)${ticks}(?!\`)`, "g"), i + ticks.length);
      if (close) {
        let code = src.slice(i + ticks.length, close.index).replaceAll("\n", " ");
        if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
        add([{ t: code, s: plus(CODE) }]);
        i = close.index + ticks.length;
      } else {
        buf += ticks;
        i += ticks.length;
      }
    } else if ((c === "!" && src[i + 1] === "[") || c === "[") {
      const link = linkAt(src, c === "!" ? i + 1 : i, ctx.refs);
      if (!link) {
        buf += c;
        i++;
      } else if (c === "!") {
        add([{ img: { src: link.href, alt: link.label } }]);
        i = link.end;
      } else {
        const inner = inline(link.label, ctx, plus(LINK));
        const shown = inner.filter((r) => !r.img).map((r) => r.t ?? "").join("");
        add(inner);
        if (/^(https?|ftp|mailto):/i.test(link.href) && !inner.some((r) => r.img) && shown.trim() && shown !== link.href && `mailto:${shown}` !== link.href) {
          add([{ t: " ", s: style }, { t: `(${link.href})`, s: plus("2") }]);
        }
        i = link.end;
      }
    } else if (c === "<" && (m = at(/<((?:https?|ftp|mailto):[^>\s]+)>/y, i))) {
      add([{ t: m[1].replace(/^mailto:/, ""), s: plus(LINK) }]);
      i += m[0].length;
    } else if (c === "<" && (m = at(/<!--[\s\S]*?-->/y, i))) {
      i += m[0].length;
    } else if (c === "<" && (m = at(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/y, i))) {
      const tag = m[2].toLowerCase();
      i += m[0].length;
      if (tag === "br") add([{ br: true }]);
      else if (tag === "img") {
        const src = attr(m[0], "src");
        if (src) add([{ img: { src, alt: attr(m[0], "alt") ?? "" } }]);
      } else if (!m[1] && !m[3] && INLINE_TAGS[tag]) {
        const close = at(new RegExp(`</${tag}\\s*>`, "gi"), i);
        if (close) {
          add(inline(src.slice(i, close.index), ctx, plus(INLINE_TAGS[tag])));
          i = close.index + close[0].length;
        }
      }
    } else if (c === "&" && (m = at(/&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|\w{2,31});/y, i))) {
      buf += entities(m[0]);
      i += m[0].length;
    } else if ((c === "*" || c === "_" || c === "~") && (m = emphasisAt(src, i))) {
      add(inline(src.slice(m.from, m.to), ctx, plus(m.style)));
      i = m.end;
    } else if (c === "h" && /(^|[\s(])$/.test(src.slice(Math.max(0, i - 1), i)) && (m = at(/https?:\/\/[^\s<]*[^\s<.,:;"')\]*_~]/y, i))) {
      add([{ t: m[0], s: plus(LINK) }]);
      i += m[0].length;
    } else {
      buf += c;
      i++;
    }
  }
  flush();
  return runs;
}

const INLINE_TAGS = { b: "1", strong: "1", i: "3", em: "3", u: "4", s: "9", del: "9", strike: "9", code: CODE, kbd: "7", mark: "7", sup: "", sub: "", span: "", a: LINK, small: "2" };

// `[label](href "title")`, `[label][ref]`, `[label]` (a reference) at `i`: {label, href, end}, or null.
function linkAt(src, i, refs) {
  let depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === "`") {
      const close = src.indexOf("`", j + 1);
      if (close > 0) j = close;
    } else if (src[j] === "[") depth++;
    else if (src[j] === "]" && --depth === 0) break;
  }
  if (j >= src.length) return null;
  const label = src.slice(i + 1, j);
  if (src[j + 1] === "(") {
    const m = /^\(\s*(<[^>]*>|(?:[^\s()\\]|\\.|\([^\s()]*\))*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/.exec(src.slice(j + 1));
    if (m) return { label, href: m[1].replace(/^<|>$/g, ""), end: j + 1 + m[0].length };
  }
  const ref = /^\[([^\]]*)\]/.exec(src.slice(j + 1));
  const key = (ref && ref[1] ? ref[1] : label).toLowerCase();
  if (refs[key] !== undefined) return { label, href: refs[key], end: j + 1 + (ref ? ref[0].length : 0) };
  return null;
}

// Emphasis at `i` (*, _, ~ runs): {from, to (its text), end, style}, or null.
function emphasisAt(src, i) {
  const ch = src[i];
  let n = 1;
  while (src[i + n] === ch) n++;
  if (ch === "~" ? n > 2 : n > 3) return null;
  const after = src[i + n] ?? " ", before = src[i - 1] ?? " ";
  if (/\s/.test(after)) return null;
  if (ch === "_" && /[\p{L}\p{N}]/u.test(before)) return null; // (snake_case)
  for (let j = i + n; j < src.length; j++) {
    if (src[j] === "\\") {
      j++;
      continue;
    }
    if (src[j] === "`") {
      const close = src.indexOf("`", j + 1);
      if (close > 0) j = close;
      continue;
    }
    if (src[j] !== ch) continue;
    let k = 1;
    while (src[j + k] === ch) k++;
    if (k === n && !/\s/.test(src[j - 1]) && !(ch === "_" && /[\p{L}\p{N}]/u.test(src[j + k] ?? " "))) {
      const style = ch === "~" ? "9" : n === 1 ? "3" : n === 2 ? "1" : "1;3";
      return { from: i + n, to: j, end: j + k, style };
    }
    j += k - 1;
  }
  return null;
}

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–", laquo: "«", raquo: "»", middot: "·", times: "×", rarr: "→", larr: "←", deg: "°", euro: "€", pound: "£", bull: "•" };

function entities(s) {
  return s.replace(/&(#\d{1,7}|#[xX][\da-fA-F]{1,6}|\w{2,31});/g, (all, e) => {
    if (e[0] !== "#") return NAMED[e] ?? all;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

// ---- Lines

// What the file has that would steer the terminal (escapes, other controls), made visible.
// deno-lint-ignore no-control-regex
const clean = (s) => s.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => String.fromCharCode(0x2400 + (c === "\x7f" ? 0x21 : c.charCodeAt(0))));

/** Runs as lines `width` wide at most, words kept whole (one longer than a line split): [{segs, w}]. */
function wrap(runs, width) {
  // The words, each its pieces in their styles (a word can go across runs: "**bold**,").
  const words = [];
  let word = null, space = null;
  for (const r of runs) {
    if (r.br) {
      words.push({ br: true });
      word = space = null;
      continue;
    }
    for (const part of r.t.split(/( +)/)) {
      if (!part) continue;
      if (part[0] === " ") {
        word = null;
        space = r.s;
        continue;
      }
      if (!word) {
        word = { segs: [], w: 0, space };
        words.push(word);
        space = null;
      }
      word.segs.push({ t: part, s: r.s });
      word.w += strWidth(part);
    }
  }
  const lines = [];
  let line = { segs: [], w: 0 };
  const next = () => {
    lines.push(line);
    line = { segs: [], w: 0 };
  };
  for (const wd of words) {
    if (wd.br) {
      next();
      continue;
    }
    const gap = line.w && wd.space !== null && wd.space !== undefined ? 1 : 0;
    if (line.w && line.w + gap + wd.w > width) next();
    else if (gap) {
      line.segs.push({ t: " ", s: wd.space });
      line.w++;
    }
    for (const seg of wd.segs) {
      let t = seg.t;
      while (line.w + strWidth(t) > width) { // (longer than a line: split)
        let cut = 0, w = 0;
        for (const ch of t) {
          if (line.w + w + strWidth(ch) > width) break;
          w += strWidth(ch);
          cut += ch.length;
        }
        if (!cut && !line.w) cut = t.codePointAt(0) > 0xffff ? 2 : 1; // (wider than the line)
        line.segs.push({ t: t.slice(0, cut), s: seg.s });
        line.w += w;
        next();
        t = t.slice(cut);
      }
      if (t) {
        line.segs.push({ t, s: seg.s });
        line.w += strWidth(t);
      }
    }
  }
  if (line.segs.length || !lines.length) lines.push(line);
  return lines;
}

/** Segments as text: in their styles (SGR) in a terminal, plain else. */
function paint(segs, tty) {
  if (!tty) return segs.map((s) => s.t).join("");
  let out = "", open = "";
  for (const { t, s } of segs) {
    if (!t) continue;
    if (s !== open) {
      out += open ? "\x1b[0m" : "";
      out += s ? `\x1b[${s}m` : "";
      open = s;
    }
    out += t;
  }
  return out + (open ? "\x1b[0m" : "");
}

/** Columns `s` takes in a terminal: wide (CJK, emoji) 2, combining marks 0. */
function strWidth(s) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x300) w += 1;
    else if ((c >= 0x300 && c <= 0x36f) || c === 0x200b || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) continue;
    else if (
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) ||
      (c >= 0x20000 && c <= 0x3fffd) || c === 0x231a || c === 0x231b || (c >= 0x23e9 && c <= 0x23f3) || (c >= 0x25fd && c <= 0x25fe) ||
      (c >= 0x2614 && c <= 0x2615) || (c >= 0x26aa && c <= 0x26ab) || c === 0x26a1 || c === 0x26d4 || c === 0x26f5 || c === 0x2705 || c === 0x274c || c === 0x2b50
    ) w += 2;
    else w += 1;
  }
  return w;
}
