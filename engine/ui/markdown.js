// Markdown to HTML (render) and back (toMarkdown), for editing Markdown as it
// reads. Covers CommonMark's and GitHub's: headings (# and underlined, with
// GitHub's anchors), paragraphs, emphasis, code spans and blocks (fenced and
// indented), links and pictures (inline, by reference, bare web addresses),
// lists (nested, ordered, task), quotes and GitHub's alerts (> [!NOTE]),
// tables, rules, strikethrough, footnotes, entities, and HTML (made safe:
// sanitize(), only what shows, nothing that runs).
//
// Each top-level block keeps its source: toMarkdown writes the source of a
// block that's unchanged (same HTML as rendered) as it was, and Markdown made
// from the HTML only for blocks that were edited or are new, so editing one
// paragraph doesn't reformat the rest of the file. HTML, reference definitions
// and footnotes can't be edited in place (their source stays as it is).
//
// textedit shows Markdown with it, and phil's terminal vu's pages (apps/phil/ui/blocks.js).

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * Renders `md`. `resolve(src)` turns a picture's path into a URL to show it.
 * Returns { html, blocks }: the blocks' sources, for toMarkdown.
 */
export function render(md, { resolve = (s) => s } = {}) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let html = "";
  let i = 0;
  const ctx = { resolve, ...definitions(lines), slugs: new Map(), cited: [] };
  // Front matter: kept as it is, shown but not editable.
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      const src = lines.slice(0, end + 1).join("\n");
      html += addBlock(blocks, src, `<pre class="frontmatter" contenteditable="false">${esc(src)}</pre>`, ctx);
      i = end + 1;
    }
  }
  while (i < lines.length) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    const start = i;
    const block = parseBlock(lines, i, ctx);
    i = block.next;
    html += addBlock(blocks, lines.slice(start, i).join("\n").replace(/\n+$/, ""), block.html, ctx);
  }
  // The footnotes cited, at the end (made here: toMarkdown leaves them out).
  if (ctx.cited.length) {
    const items = ctx.cited.map(({ id, slug }) => `<li id="fn-${slug}">${inline(ctx.notes.get(id), ctx)} <a href="#fnref-${slug}" class="back">↩</a></li>`);
    html += safe(`<section class="footnotes" data-made="1" contenteditable="false"><ol>${items.join("")}</ol></section>`, ctx);
  }
  return { html, blocks };
}

// Marks a top-level element with its block number; remembers its source and
// rendered HTML (made safe, as the browser writes it).
function addBlock(blocks, src, html, ctx) {
  const out = safe(html.replace(/^<(\w+)/, `<$1 data-block="${blocks.length}"`), ctx);
  blocks.push({ src, html: out });
  return out;
}

// ---------------------------------------------------------------- HTML, made safe

// What HTML may have in it: the elements that show (the others' content stays,
// but those below, which run, load or ask, go with theirs), and attributes that
// say how they show.
const ELEMENTS = new Set(("a abbr article aside b bdi bdo blockquote br caption center cite code col colgroup dd del details dfn div dl dt em " +
  "figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img input ins kbd li main mark nav ol p picture pre q rp rt ruby s samp " +
  "section small span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var wbr").split(" "));
const GONE = new Set(("script style iframe frame frameset object embed applet template noscript form button textarea select option " +
  "link meta base title head svg math video audio source track canvas dialog portal slot").split(" "));
const ATTRIBUTES = new Set(("align alt cite colspan dir height hidden id lang name open rowspan scope span start title valign width " +
  "class contenteditable reversed type checked disabled datetime").split(" "));
const OURS = new Set(["data-block", "data-src", "data-lang", "data-auto", "data-ref", "data-note", "data-made", "data-alert"]);

// deno-lint-ignore no-control-regex
const UNSEEN = /[\s\x00-\x1f]/g; // (what a browser skips in a link's scheme)

let inert; // a document where nothing loads or runs: HTML is taken apart there
const scratch = () => (inert ??= document.implementation.createHTMLDocument("")).createElement("div");

/** `html` with only what shows: no scripts, handlers, frames, forms or styles; links to pages, pictures through resolve(). */
function safe(html, ctx = null) {
  const box = scratch();
  box.innerHTML = html;
  sanitize(box, ctx);
  return box.innerHTML;
}

function sanitize(node, ctx) {
  for (const el of [...node.children]) {
    const tag = el.localName;
    if (GONE.has(tag) || !/^[a-z][a-z0-9]*$/.test(tag)) {
      el.remove();
      continue;
    }
    sanitize(el, ctx);
    if (!ELEMENTS.has(tag)) {
      el.replaceWith(...el.childNodes); // (what's in it stays)
      continue;
    }
    for (const { name, value } of [...el.attributes]) {
      const keep = ATTRIBUTES.has(name) || OURS.has(name) ||
        (name === "href" && tag === "a" && !/^(javascript|vbscript|data|file):/i.test(value.replace(UNSEEN, ""))) ||
        (name === "src" && tag === "img") ||
        (name === "style" && /^text-align:\s*(left|right|center);?$/.test(value.trim()));
      if (!keep) el.removeAttribute(name);
    }
    if (tag === "input" && el.getAttribute("type") !== "checkbox") el.remove();
    if (tag === "img" && el.hasAttribute("src") && !el.hasAttribute("data-src") && ctx) {
      // A picture written in HTML: shown through resolve(), as Markdown's are.
      const src = el.getAttribute("src");
      el.setAttribute("data-src", src);
      el.setAttribute("src", ctx.resolve(src));
    }
    if (tag === "img" && /^(javascript|vbscript):/i.test(el.getAttribute("src") ?? "")) el.removeAttribute("src");
  }
}

// ---------------------------------------------------------------- blocks

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])(\s+|$)/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const HTML_BLOCK = /^ {0,3}<\/?(?:[a-zA-Z][\w-]*)(?:\s|\/?>|$)|^ {0,3}<!--/;
const INDENTED = /^(?: {4}|\t)/;
const SETEXT = /^ {0,3}(=+|-+)\s*$/;
// [label]: url "title" (a reference), [^id]: text (a footnote)
const DEFINITION = /^ {0,3}\[([^\]^][^\]]*)\]:\s*<?([^\s>]*)>?(?:\s+("[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
const NOTE = /^ {0,3}\[\^([^\]\s]+)\]:\s?(.*)$/;
const ALERT = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i;
// Elements whose content can be Markdown, when the HTML block that opens one is apart from the one that closes it.
const CONTAINERS = ["details", "div", "section", "center", "blockquote", "article", "aside", "figure", "p", "span", "dd", "li", "td"];

const startsBlock = (line, next) =>
  FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST.test(line) || HTML_BLOCK.test(line) ||
  DEFINITION.test(line) || NOTE.test(line) || (line.includes("|") && next !== undefined && TABLE_SEP.test(next));

const label = (s) => s.trim().replace(/\s+/g, " ").toLowerCase();

// The references and footnotes defined anywhere (not in code): {refs: label -> {href, title}, notes: id -> text}.
function definitions(lines) {
  const refs = new Map(), notes = new Map();
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (f && (!fence || (f[1][0] === fence[0] && f[1].length >= fence.length && !f[2]))) {
      fence = fence ? null : f[1];
      continue;
    }
    if (fence) continue;
    let m;
    if ((m = NOTE.exec(line))) {
      const text = [m[2]];
      while (i + 1 < lines.length && /^(?: {2,}|\t)\S/.test(lines[i + 1])) text.push(lines[++i].trim());
      if (!notes.has(m[1])) notes.set(m[1], text.join("\n"));
    } else if ((m = DEFINITION.exec(line)) && !refs.has(label(m[1]))) {
      refs.set(label(m[1]), { href: m[2], title: m[3]?.slice(1, -1) });
    }
  }
  return { refs, notes };
}

function parseBlock(lines, i, ctx) {
  const line = lines[i];
  let m;
  if ((m = FENCE.exec(line))) {
    const close = new RegExp(`^ {0,3}${m[1][0] === "`" ? "`" : "~"}{${m[1].length},}\\s*$`);
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j])) j++;
    const code = lines.slice(i + 1, j).join("\n");
    return { next: Math.min(j + 1, lines.length), html: `<pre data-lang="${esc(m[2])}"><code>${esc(code)}</code></pre>` };
  }
  if (INDENTED.test(line)) {
    let j = i;
    while (j < lines.length && (INDENTED.test(lines[j]) || !lines[j].trim())) j++;
    while (j > i && !lines[j - 1].trim()) j--;
    const code = lines.slice(i, j).map((l) => l.replace(INDENTED, "")).join("\n");
    return { next: j, html: `<pre data-lang=""><code>${esc(code)}</code></pre>` };
  }
  if ((m = HEADING.exec(line))) return { next: i + 1, html: heading(m[1].length, m[2] ?? "", ctx) };
  if (RULE.test(line)) return { next: i + 1, html: "<hr>" };
  if (QUOTE.test(line)) {
    let j = i;
    const inner = [];
    while (j < lines.length && lines[j].trim() && (QUOTE.test(lines[j]) || !startsBlock(lines[j], lines[j + 1]))) inner.push(lines[j++].replace(QUOTE, ""));
    // GitHub's alerts: > [!NOTE] on its first line.
    const alert = ALERT.exec(inner[0] ?? "");
    if (alert) {
      const kind = alert[1].toLowerCase();
      const body = render_([alert[2], ...inner.slice(1)], ctx);
      return { next: j, html: `<blockquote class="alert alert-${kind}" data-alert="${alert[1].toUpperCase()}"><p class="alert-title" contenteditable="false">${kind[0].toUpperCase() + kind.slice(1)}</p>${body}</blockquote>` };
    }
    return { next: j, html: `<blockquote>${render_(inner, ctx)}</blockquote>` };
  }
  if (LIST.test(line)) return list(lines, i, ctx);
  if (line.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "")) return table(lines, i, ctx);
  if (HTML_BLOCK.test(line)) return htmlBlock(lines, i, ctx);
  if (DEFINITION.test(line) || NOTE.test(line)) {
    // References and footnotes: not shown where they are (footnotes: at the end).
    let j = i;
    while (j < lines.length && (DEFINITION.test(lines[j]) || NOTE.test(lines[j]) || (j > i && /^(?: {2,}|\t)\S/.test(lines[j]) && NOTE.test(lines[i])))) j++;
    return { next: j, html: `<div class="definitions" hidden contenteditable="false"></div>` };
  }
  // A paragraph: up to a blank line or the start of another block; underlined (= or -), a heading.
  let j = i + 1;
  while (j < lines.length && lines[j].trim() && !SETEXT.test(lines[j]) && !startsBlock(lines[j], lines[j + 1])) j++;
  const text = lines.slice(i, j).map((l) => l.replace(/^ +/, "")).join("\n");
  if (j < lines.length && (m = SETEXT.exec(lines[j]))) return { next: j + 1, html: heading(m[1][0] === "=" ? 1 : 2, text, ctx) };
  return { next: j, html: `<p>${inline(text, ctx)}</p>` };
}

// A heading, with GitHub's anchor (its text, lowercase, dashes for spaces; a second one -1...).
function heading(n, text, ctx) {
  const html = inline(text, ctx);
  const box = scratch();
  box.innerHTML = html;
  let slug = box.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
  const seen = ctx.slugs.get(slug) ?? 0;
  ctx.slugs.set(slug, seen + 1);
  if (seen) slug += `-${seen}`;
  return `<h${n} id="${esc(slug)}">${html}</h${n}>`;
}

// HTML: shown (safe()), not editable. One that opens a container (<details>, <div>...) closed
// further down, past blank lines, has the Markdown between rendered in it.
function htmlBlock(lines, i, ctx) {
  let j = i;
  while (j < lines.length && lines[j].trim()) j++;
  let html = lines.slice(i, j).join("\n");
  const open = CONTAINERS.find((t) => (html.match(new RegExp(`<${t}\\b`, "gi"))?.length ?? 0) > (html.match(new RegExp(`</${t}\\s*>`, "gi"))?.length ?? 0));
  if (open) {
    const close = new RegExp(`</${open}\\s*>`, "i");
    let k = j;
    while (k < lines.length && !close.test(lines[k])) k++;
    if (k < lines.length) {
      let from = k; // (the block the closing tag's in)
      while (from > j && lines[from - 1].trim()) from--;
      let end = k;
      while (end < lines.length && lines[end].trim()) end++;
      html += render_(lines.slice(j, from), ctx) + lines.slice(from, end).join("\n");
      j = end;
    }
  }
  return { next: j, html: `<div class="html" contenteditable="false">${html}</div>` };
}

// Blocks of nested content (a quote's or a list item's).
function render_(lines, ctx) {
  let html = "", i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    const block = parseBlock(lines, i, ctx);
    html += block.html;
    i = block.next;
  }
  return html;
}

function list(lines, i, ctx) {
  const first = LIST.exec(lines[i]);
  const ordered = /\d/.test(first[2]);
  const indent = first[1].length;
  const items = [];
  let j = i;
  while (j < lines.length) {
    const m = LIST.exec(lines[j]);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
    const width = m[1].length + m[2].length + Math.max(1, Math.min(m[3].length, 4));
    const body = [lines[j].slice(m[0].length)];
    j++;
    // The item's other lines: indented under it, or a lazy continuation.
    while (j < lines.length) {
      const l = lines[j];
      if (!l.trim()) {
        const next = lines[j + 1] ?? "";
        if (next.trim() && /^ */.exec(next)[0].length >= width) {
          body.push("");
          j++;
          continue;
        }
        break;
      }
      const lead = /^ */.exec(l)[0].length;
      if (lead >= width) body.push(l.slice(width));
      else if (LIST.test(l) || startsBlock(l, lines[j + 1])) break;
      else body.push(l.trim());
      j++;
    }
    items.push(body);
    while (j < lines.length && !lines[j].trim() && LIST.exec(lines[j + 1] ?? "")?.[1].length === indent) j++;
  }
  const start = ordered ? parseInt(first[2]) : 1;
  const tag = ordered ? "ol" : "ul";
  const lis = items.map((body) => {
    const task = /^\[([ xX])\]\s/.exec(body[0]);
    if (task) body[0] = body[0].slice(task[0].length);
    // A single paragraph shows without <p>, so the list stays tight.
    let content = render_(body, ctx).replace(/^<p>([\s\S]*?)<\/p>(?=<|$)/, "$1");
    if (task) content = `<input type="checkbox"${task[1] === " " ? "" : " checked"}> ` + content;
    return `<li${task ? ' class="task"' : ""}>${content}</li>`;
  });
  return { next: j, html: `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}>${lis.join("")}</${tag}>` };
}

function table(lines, i, ctx) {
  // A row's cells: split at its pipes, but not escaped ones or those in code.
  const cells = (l) => {
    const s = l.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
    const out = [];
    let cell = "", ticks = 0;
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (c === "\\" && s[k + 1] === "|") (cell += "|"), k++;
      else if (c === "`") {
        let n = 1;
        while (s[k + n] === "`") n++;
        ticks = ticks === n ? 0 : ticks || n;
        cell += "`".repeat(n);
        k += n - 1;
      } else if (c === "|" && !ticks) (out.push(cell.trim()), (cell = ""));
      else cell += c;
    }
    out.push(cell.trim());
    return out;
  };
  const aligns = cells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
  const row = (l, tag) => `<tr>${cells(l).map((c, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${inline(c, ctx)}</${tag}>`).join("")}</tr>`;
  let j = i + 2;
  const body = [];
  while (j < lines.length && lines[j].includes("|") && lines[j].trim()) body.push(row(lines[j++], "td"));
  return { next: j, html: `<table><thead>${row(lines[i], "th")}</thead><tbody>${body.join("")}</tbody></table>` };
}

// ---------------------------------------------------------------- inline

// [label]... at `i` (text[i] === "["): its label, and what follows it: (url "title"), [ref], [] or
// nothing (a reference by its label). {label, href, title, ref (how it was referred to), end}, or null.
function linkAt(text, i, ctx) {
  let depth = 0, close = -1;
  for (let k = i; k < text.length; k++) {
    const c = text[k];
    if (c === "\\") k++;
    else if (c === "`") {
      const n = /^`+/.exec(text.slice(k))[0].length;
      const end = text.indexOf("`".repeat(n), k + n);
      if (end > 0) k = end + n - 1;
    } else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) {
      close = k;
      break;
    }
  }
  if (close < 0) return null;
  const label_ = text.slice(i + 1, close), after = text.slice(close + 1);
  let m = /^\(\s*(?:<([^>\n]*)>|((?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))*))(?:\s+("[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/.exec(after);
  if (m) return { label: label_, href: (m[1] ?? m[2]).replace(/\\([!-/:-@[-`{-~])/g, "$1"), title: m[3]?.slice(1, -1), end: close + 1 + m[0].length };
  m = /^\[([^\]]*)\]/.exec(after);
  const ref = ctx.refs.get(label(m?.[1] || label_));
  if (ref && (m || !/^[(:]/.test(after))) return { label: label_, ...ref, ref: m ? m[0] : "", end: close + 1 + (m ? m[0].length : 0) };
  return null;
}

const ENTITY = /^&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/;
const INLINE_HTML = /^(?:<!--[\s\S]*?-->|<\/?[a-zA-Z][\w-]*(?:\s+[a-zA-Z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>)/;
const BARE_URL = /^(?:https?:\/\/|www\.)[^\s<]*[^\s<.,:;"')\]*_~?!]/;

// Inline Markdown to HTML.
function inline(text, ctx) {
  let out = "", i = 0;
  const title = (t) => (t ? ` title="${esc(t)}"` : "");
  const rules = [
    [/^\\([!-/:-@[-`{-~])/, (m) => esc(m[1])],
    [/^(`+)([\s\S]*?[^`])\1(?!`)/, (m) => `<code>${esc(m[2].replace(/^ (.*) $/, "$1"))}</code>`],
    [/^<(https?:\/\/[^>\s]+|mailto:[^>\s]+)>/, (m) => `<a href="${esc(m[1])}" data-auto="1">${esc(m[1].replace(/^mailto:/, ""))}</a>`],
    [INLINE_HTML, (m) => m[0]], // (made safe with the block: safe())
    [ENTITY, (m) => m[0]],
    [/^(\*\*|__)(?=\S)([\s\S]*?\S)\1(?![*_])/, (m) => `<strong>${inline(m[2], ctx)}</strong>`],
    [/^\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/, (m) => `<em>${inline(m[1], ctx)}</em>`],
    [/^_(?=[^\s_])([\s\S]*?[^\s_])_(?![\w])/, (m) => `<em>${inline(m[1], ctx)}</em>`],
    [/^~~(?=\S)([\s\S]*?\S)~~/, (m) => `<del>${inline(m[1], ctx)}</del>`],
    [/^(?: {2,}|\\)\n/, () => "<br>"],
  ];
  outer: while (i < text.length) {
    const rest = text.slice(i);
    const before = i ? text[i - 1] : " ";
    // _ inside a word isn't emphasis (snake_case).
    if (rest[0] === "_" && /\w/.test(before)) {
      out += "_";
      i++;
      continue;
    }
    // A footnote cited: its number, linked to it (at the end).
    let m;
    if ((m = /^\[\^([^\]\s]+)\]/.exec(rest)) && ctx.notes.has(m[1])) {
      let note = ctx.cited.find((c) => c.id === m[1]);
      if (!note) ctx.cited.push((note = { id: m[1], n: ctx.cited.length + 1, slug: esc(m[1].replace(/[^\w-]/g, "_")) }));
      out += `<sup class="fnref" data-note="${esc(m[1])}"><a href="#fn-${note.slug}" id="fnref-${note.slug}">${note.n}</a></sup>`;
      i += m[0].length;
      continue;
    }
    // Pictures and links: inline, by reference.
    if (rest[0] === "[" || (rest[0] === "!" && rest[1] === "[")) {
      const img = rest[0] === "!";
      const link = linkAt(text, img ? i + 1 : i, ctx);
      if (link) {
        const ref = link.ref !== undefined ? ` data-ref="${esc(link.ref)}"` : "";
        out += img
          ? `<img src="${esc(ctx.resolve(link.href))}" data-src="${esc(link.href)}" alt="${esc(link.label.replace(/\\(.)/g, "$1"))}"${title(link.title)}${ref}>`
          : `<a href="${esc(link.href)}"${title(link.title)}${ref}>${inline(link.label, ctx)}</a>`;
        i = link.end;
        continue;
      }
    }
    // A web address by itself (GitHub's): a link.
    if (/[\s(*_~]/.test(before) && (m = BARE_URL.exec(rest))) {
      out += `<a href="${esc(/^www\./i.test(m[0]) ? `http://${m[0]}` : m[0])}" data-auto="bare">${esc(m[0])}</a>`;
      i += m[0].length;
      continue;
    }
    for (const [re, fn] of rules) {
      const m = re.exec(rest);
      if (m) {
        out += fn(m);
        i += m[0].length;
        continue outer;
      }
    }
    out += esc(text[i]);
    i++;
  }
  return out;
}

// ---------------------------------------------------------------- back to Markdown

/** The Markdown for the rendered (and maybe edited) `root`; `blocks` from render(). */
export function toMarkdown(root, blocks) {
  const out = [];
  for (const node of root.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent.trim()) out.push(escapeText(node.textContent.trim(), true));
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || node.dataset.made) continue; // (footnotes: made from their definitions)
    const original = blocks[node.dataset.block];
    // (One not editable: as it was. HTML, references, front matter.)
    if (original && (node.outerHTML === original.html || node.getAttribute("contenteditable") === "false")) out.push(original.src);
    else {
      const md = block(node, true);
      if (md.trim()) out.push(md);
    }
  }
  return out.join("\n\n") + "\n";
}

function block(el, top = false) {
  const tag = el.tagName;
  if (/^H[1-6]$/.test(tag)) return "#".repeat(Number(tag[1])) + " " + inlineMd(el).trim();
  if (tag === "HR") return "---";
  if (tag === "PRE") {
    if (el.classList.contains("frontmatter") || el.classList.contains("raw")) return el.textContent;
    const code = el.innerText.replace(/\n$/, "");
    const fence = code.includes("```") ? "~~~" : "```";
    return `${fence}${el.dataset.lang ?? ""}\n${code}\n${fence}`;
  }
  if (tag === "UL" || tag === "OL") return listMd(el);
  if (tag === "BLOCKQUOTE") {
    const quoted = childBlocks(el).split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
    return el.dataset.alert ? `> [!${el.dataset.alert}]\n${quoted}` : quoted;
  }
  if (el.classList.contains("html")) return el.innerHTML;
  if (el.classList.contains("definitions")) return "";
  if (tag === "TABLE") return tableMd(el);
  // A paragraph, or a <div> that the editing made; it may hold blocks itself.
  if ([...el.children].some((c) => /^(P|DIV|UL|OL|BLOCKQUOTE|PRE|H[1-6]|TABLE|HR)$/.test(c.tagName))) return childBlocks(el);
  return escapeText(inlineMd(el).trim(), top);
}

function childBlocks(el) {
  const parts = [];
  let run = "";
  const flush = () => (run.trim() && parts.push(escapeText(run.trim(), true)), (run = ""));
  for (const c of el.childNodes) {
    if (c.nodeType === Node.ELEMENT_NODE && c.classList.contains("alert-title")) continue; // (an alert's: its [!KIND])
    if (c.nodeType === Node.ELEMENT_NODE && /^(P|DIV|UL|OL|BLOCKQUOTE|PRE|H[1-6]|TABLE|HR)$/.test(c.tagName)) {
      flush();
      parts.push(block(c));
    } else {
      run += c.nodeType === Node.TEXT_NODE ? escapeInline(c.textContent) : inlineMd(c, true);
    }
  }
  flush();
  return parts.join("\n\n");
}

function listMd(el, depth = 0) {
  const ordered = el.tagName === "OL";
  let n = Number(el.getAttribute("start") ?? 1);
  const items = [];
  for (const li of el.children) {
    if (li.tagName !== "LI") continue;
    const marker = ordered ? `${n++}. ` : "- ";
    const pad = " ".repeat(marker.length);
    const box = li.querySelector(":scope > input[type=checkbox]");
    let text = "";
    const nested = [];
    for (const c of li.childNodes) {
      if (c === box) continue;
      if (c.nodeType === Node.ELEMENT_NODE && (c.tagName === "UL" || c.tagName === "OL")) nested.push(listMd(c, depth + 1));
      else if (c.nodeType === Node.ELEMENT_NODE && /^(P|DIV)$/.test(c.tagName)) text += (text ? "\n" : "") + inlineMd(c);
      else text += c.nodeType === Node.TEXT_NODE ? escapeInline(c.textContent) : inlineMd(c, true);
    }
    text = text.trim().replace(/\n/g, "\n" + pad);
    if (box) text = `[${box.checked ? "x" : " "}] ` + text;
    items.push(marker + text + nested.map((l) => "\n" + l.replace(/^/gm, pad)).join(""));
  }
  return items.join("\n");
}

function tableMd(el) {
  const rows = [...el.querySelectorAll("tr")].map((tr) => [...tr.children].map((c) => inlineMd(c).trim().replace(/\|/g, "\\|")));
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const aligns = [...(el.querySelector("tr")?.children ?? [])].map((c) => c.style.textAlign);
  const sep = Array.from({ length: width }, (_, k) => ({ center: ":---:", right: "---:", left: ":---" })[aligns[k]] ?? "---");
  const line = (cells) => `| ${Array.from({ length: width }, (_, k) => cells[k] ?? "").join(" | ")} |`;
  return [line(rows[0]), line(sep), ...rows.slice(1).map(line)].join("\n");
}

// Inline HTML to Markdown.
function inlineMd(node, self = false) {
  if (self) return inlineNode(node);
  let out = "";
  for (const c of node.childNodes) out += inlineNode(c);
  return out;
}

function inlineNode(c) {
  if (c.nodeType === Node.TEXT_NODE) return escapeInline(c.textContent);
  if (c.nodeType !== Node.ELEMENT_NODE) return "";
  const inner = () => inlineMd(c);
  const wrap = (mark) => {
    const s = inner();
    if (!s.trim()) return s;
    const lead = /^\s*/.exec(s)[0], trail = /\s*$/.exec(s)[0]; // markers hug the text
    return `${lead}${mark}${s.trim()}${mark}${trail}`;
  };
  switch (c.tagName) {
    case "STRONG": case "B": return wrap("**");
    case "EM": case "I": return wrap("*");
    case "DEL": case "S": case "STRIKE": return wrap("~~");
    case "CODE": {
      const t = c.textContent;
      const ticks = "`".repeat((t.match(/`+/g) ?? [""]).reduce((a, b) => Math.max(a, b.length), 0) + 1);
      return ticks.length > 1 && t.includes("`") ? `${ticks} ${t} ${ticks}` : `${ticks}${t}${ticks}`;
    }
    case "A": {
      const href = c.getAttribute("href") ?? "";
      if (c.dataset.auto === "bare" && (c.textContent === href || `http://${c.textContent}` === href)) return c.textContent;
      if (c.dataset.auto && c.textContent === href.replace(/^mailto:/, "")) return `<${href}>`;
      if (c.dataset.ref !== undefined) return `[${inner()}]${c.dataset.ref}`;
      return `[${inner()}](${href}${c.title ? ` "${c.title}"` : ""})`;
    }
    case "IMG":
      if (c.dataset.ref !== undefined) return `![${c.alt ?? ""}]${c.dataset.ref}`;
      if (c.hasAttribute("width") || c.hasAttribute("height")) { // (one written in HTML, its size kept)
        const size = ["width", "height"].filter((a) => c.hasAttribute(a)).map((a) => ` ${a}="${c.getAttribute(a)}"`).join("");
        return `<img src="${c.dataset.src ?? c.getAttribute("src") ?? ""}"${c.alt ? ` alt="${c.alt}"` : ""}${size}>`;
      }
      return `![${c.alt ?? ""}](${c.dataset.src ?? c.getAttribute("src") ?? ""}${c.title ? ` "${c.title}"` : ""})`;
    case "SUP":
      if (c.dataset.note) return `[^${c.dataset.note}]`;
      return `<sup>${inner()}</sup>`;
    case "KBD": case "SUB": case "U": case "MARK": case "INS": case "SMALL": case "ABBR": {
      const tag = c.tagName.toLowerCase();
      return `<${tag}>${inner()}</${tag}>`;
    }
    case "BR": return c.nextSibling ? "\\\n" : ""; // the editing leaves a <br> at the end of blocks
    case "INPUT": return "";
    default: return inner();
  }
}

// Characters that would otherwise read as Markdown.
function escapeInline(text) {
  return text.replace(/\u00a0/g, " ").replace(/[\\`*[\]<]/g, "\\$&").replace(/(^|\W)_|_(?=\W|$)/g, (m) => m.replace("_", "\\_"));
}

// At the start of a block, also what would start another kind of block.
function escapeText(text, top) {
  if (!top) return text;
  return text.replace(/^(#{1,6}\s|>|[-+]\s|\d+[.)]\s|(?:[-*_]\s*){3,}$)/, (m) => "\\" + m);
}
