// Markdown to HTML (render) and back (toMarkdown), for editing Markdown as it
// reads. Covers the common parts of CommonMark and GitHub's: headings,
// paragraphs, emphasis, code spans and blocks, links, images, lists (nested,
// ordered, task), quotes, tables, rules, strikethrough.
//
// Each top-level block keeps its source: toMarkdown writes the source of a
// block that's unchanged (same HTML as rendered) as it was, and Markdown made
// from the HTML only for blocks that were edited or are new, so editing one
// paragraph doesn't reformat the rest of the file.
//
// textedit shows Markdown with it, and phil's terminal vu's pages (apps/phil/ui/blocks.js).

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * Renders `md`. `resolve(src)` turns an image path into a URL to show it.
 * Returns { html, blocks }: the blocks' sources, for toMarkdown.
 */
export function render(md, { resolve = (s) => s } = {}) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let html = "";
  let i = 0;
  // Front matter: kept as it is, shown but not editable.
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      const src = lines.slice(0, end + 1).join("\n");
      html += addBlock(blocks, src, `<pre class="frontmatter" contenteditable="false">${esc(src)}</pre>`);
      i = end + 1;
    }
  }
  const ctx = { resolve };
  while (i < lines.length) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    const start = i;
    const block = parseBlock(lines, i, ctx);
    i = block.next;
    html += addBlock(blocks, lines.slice(start, i).join("\n").replace(/\n+$/, ""), block.html);
  }
  return { html, blocks };
}

// Marks a top-level element with its block number; remembers its source and
// rendered HTML (as the browser writes it: parsed in a document of its own, where
// nothing loads, its pictures neither).
let inert;
function addBlock(blocks, src, html) {
  const marked = html.replace(/^<(\w+)/, `<$1 data-block="${blocks.length}"`);
  const box = (inert ??= document.implementation.createHTMLDocument("")).createElement("div");
  box.innerHTML = marked;
  blocks.push({ src, html: box.firstElementChild?.outerHTML ?? marked });
  return marked;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])(\s+|$)/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const HTML_BLOCK = /^ {0,3}<\/?(?:[a-zA-Z][\w-]*)(?:\s|\/?>|$)|^ {0,3}<!--/;

const startsBlock = (line, next) =>
  FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST.test(line) || HTML_BLOCK.test(line) ||
  (line.includes("|") && next !== undefined && TABLE_SEP.test(next));

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
  if ((m = HEADING.exec(line))) {
    const n = m[1].length;
    return { next: i + 1, html: `<h${n}>${inline(m[2] ?? "", ctx)}</h${n}>` };
  }
  if (RULE.test(line)) return { next: i + 1, html: "<hr>" };
  if (QUOTE.test(line)) {
    let j = i;
    const inner = [];
    while (j < lines.length && lines[j].trim() && (QUOTE.test(lines[j]) || !startsBlock(lines[j], lines[j + 1]))) inner.push(lines[j++].replace(QUOTE, ""));
    return { next: j, html: `<blockquote>${render_(inner, ctx)}</blockquote>` };
  }
  if (LIST.test(line)) return list(lines, i, ctx);
  if (line.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "")) return table(lines, i, ctx);
  if (HTML_BLOCK.test(line)) {
    let j = i;
    while (j < lines.length && lines[j].trim()) j++;
    return { next: j, html: `<pre class="raw" contenteditable="false">${esc(lines.slice(i, j).join("\n"))}</pre>` };
  }
  // A paragraph: up to a blank line or the start of another block.
  let j = i + 1;
  while (j < lines.length && lines[j].trim() && !startsBlock(lines[j], lines[j + 1])) j++;
  return { next: j, html: `<p>${inline(lines.slice(i, j).map((l) => l.replace(/^ +/, "")).join("\n"), ctx)}</p>` };
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
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim());
  const aligns = cells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
  const row = (l, tag) => `<tr>${cells(l).map((c, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${inline(c, ctx)}</${tag}>`).join("")}</tr>`;
  let j = i + 2;
  const body = [];
  while (j < lines.length && lines[j].includes("|") && lines[j].trim()) body.push(row(lines[j++], "td"));
  return { next: j, html: `<table><thead>${row(lines[i], "th")}</thead><tbody>${body.join("")}</tbody></table>` };
}

// Inline Markdown to HTML.
function inline(text, ctx) {
  let out = "", i = 0;
  const rules = [
    [/^\\([!-/:-@[-`{-~])/, (m) => esc(m[1])],
    [/^(`+)([\s\S]*?[^`])\1(?!`)/, (m) => `<code>${esc(m[2].replace(/^ (.*) $/, "$1"))}</code>`],
    [/^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/, (m) => `<img src="${esc(ctx.resolve(m[2]))}" data-src="${esc(m[2])}" alt="${esc(m[1])}"${m[3] ? ` title="${esc(m[3])}"` : ""}>`],
    [/^\[((?:[^\]\\]|\\.)+)\]\(\s*<?([^)\s>]*)>?(?:\s+"([^"]*)")?\s*\)/, (m) => `<a href="${esc(m[2])}"${m[3] ? ` title="${esc(m[3])}"` : ""}>${inline(m[1], ctx)}</a>`],
    [/^<(https?:\/\/[^>\s]+|mailto:[^>\s]+)>/, (m) => `<a href="${esc(m[1])}" data-auto="1">${esc(m[1])}</a>`],
    [/^(\*\*|__)(?=\S)([\s\S]*?\S)\1(?![*_])/, (m) => `<strong>${inline(m[2], ctx)}</strong>`],
    [/^\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/, (m) => `<em>${inline(m[1], ctx)}</em>`],
    [/^_(?=[^\s_])([\s\S]*?[^\s_])_(?![\w])/, (m) => `<em>${inline(m[1], ctx)}</em>`],
    [/^~~(?=\S)([\s\S]*?\S)~~/, (m) => `<del>${inline(m[1], ctx)}</del>`],
    [/^(?: {2,}|\\)\n/, () => "<br>"],
  ];
  outer: while (i < text.length) {
    const rest = text.slice(i);
    // _ inside a word isn't emphasis (snake_case).
    if (rest[0] === "_" && i > 0 && /\w/.test(text[i - 1])) {
      out += "_";
      i++;
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
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const original = blocks[node.dataset.block];
    if (original && node.outerHTML === original.html) out.push(original.src);
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
  if (tag === "BLOCKQUOTE") return childBlocks(el).split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
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
      if (c.dataset.auto && c.textContent === href) return `<${href}>`;
      return `[${inner()}](${href}${c.title ? ` "${c.title}"` : ""})`;
    }
    case "IMG": return `![${c.alt ?? ""}](${c.dataset.src ?? c.getAttribute("src") ?? ""}${c.title ? ` "${c.title}"` : ""})`;
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
