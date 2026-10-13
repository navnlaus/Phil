import { askPassword, clipboardKey, closeWindow, copyText, embedded, holdFocus, onCloseRequest, pasteText, ready, tooltips } from "../engine/ui/kit.js";
import { render as renderMarkdown, toMarkdown } from "./markdown.js";
import { commentOf, detectLanguage, escape, LANGUAGES } from "../engine/ui/syntax.js";

tooltips(); // the page's own, in the theme's style (kit.js)

const $ = (sel) => document.querySelector(sel);
const ta = $("#text");
const hlEl = $("#hl");
const linesEl = $("#lines");
const mdEl = $("#md");
const LINE = 20, PAD_TOP = 40, PAD_X = 12; // style.css: --line, --pad-top, --pad-x
const NO_HIGHLIGHT_OVER = 4_000_000; // characters

const doc = {
  path: null, // null: not saved anywhere yet
  mtime: null, // when the file was read or saved (null: new file)
  saved: "", // the text as on disk (its line breaks as the text box has them: \n)
  eol: "\n", // the file's line breaks: "\r\n" for a Windows file, kept when it's saved
  encoding: "utf-8", // the file's (engine/files.js: or "utf-16le", "utf-16be"), and whether it has a BOM: kept too
  bom: false,
  lang: "plaintext",
  mode: "code", // or "view": Markdown as it reads
  blocks: [], // the rendered Markdown's blocks (markdown.js)
  viewEdited: false, // changed in the view since it was turned into Markdown
  document: null, // "RTF", "DOCX", ...: a document, read as Markdown, read-only (engine/documents.js)
};

// ---------------------------------------------------------------- files

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw Object.assign(new Error((await res.text()) || res.statusText), { status: res.status });
  return res.json();
}

async function openFile(path) {
  let file;
  try {
    file = await api(`api/file?path=${encodeURIComponent(path)}`);
  } catch (err) {
    showMessage(`Can't open ${path}: ${err.message}`);
    return;
  }
  showMessage("");
  // The text box turns \r\n into \n (so a Windows file looked changed as soon
  // as it was opened): it's compared as that, and saved with \r\n again.
  const text = file.missing ? "" : file.text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  Object.assign(doc, { path: file.path, mtime: file.missing ? null : file.mtime, saved: text.replace(/\r\n?/g, "\n"), eol, encoding: file.encoding ?? "utf-8", bom: !!file.bom, document: file.document ?? null });
  showReadOnly();
  ta.value = doc.saved;
  ta.setSelectionRange(0, 0);
  ta.scrollTop = ta.scrollLeft = 0;
  guessIndent(doc.saved);
  setLanguage(doc.document ? "markdown" : detectLanguage(doc.path, doc.saved)); // a document comes as Markdown
  if (doc.lang === "markdown") showView();
  else showCode();
  showFile();
}

async function save({ as = false } = {}) {
  if (doc.document) { // its Markdown, beside it
    const path = await askPath("Save as", doc.path.replace(/\.[^./]*$/, "") + ".md");
    if (!path) return;
    return write(path, { isNew: true });
  }
  if (!doc.path || as) {
    const path = await askPath(as ? "Save as" : "Save to", doc.path ?? `${home}/untitled.txt`);
    if (!path) return;
    return write(path, { isNew: path !== doc.path });
  }
  flushView();
  if (isDirty()) return write(doc.path, {});
}

async function write(path, { isNew = false, force = false, sudo }) {
  flushView();
  const text = ta.value;
  try {
    const { mtime } = await api("api/file", {
      method: "PUT",
      body: JSON.stringify({ path, text: doc.eol === "\n" ? text : text.replaceAll("\n", doc.eol), encoding: doc.encoding, bom: doc.bom, mtime: isNew ? null : doc.mtime, force, sudo }),
    });
    const renamed = path !== doc.path;
    Object.assign(doc, { path, mtime, saved: text, document: null }); // a document's Markdown, saved: a file like any
    showReadOnly();
    if (renamed && doc.lang === "plaintext") setLanguage(detectLanguage(path, text));
    showFile();
  } catch (err) {
    if (err.status === 409 && !force && confirm(`${err.message}\n\nOverwrite it with what's here?`)) return write(path, { isNew, force: true });
    if (err.status === 401) { // a root file: sudo's password (engine/files.js)
      const password = await askPassword(`${err.message}\nPassword for sudo:`);
      if (password !== null) return write(path, { isNew, force, sudo: password });
      return;
    }
    if (err.status !== 409) alert(`Couldn't save: ${err.message}`);
  }
}

const isDirty = () => (doc.mode === "view" && doc.viewEdited) || ta.value !== doc.saved;

function close() {
  if (isDirty() && !confirm("Close without saving the changes?")) return;
  closeWindow();
}

function showFile() {
  const name = doc.path ? doc.path.split("/").pop() : "Untitled";
  $("#file-name").textContent = name;
  $("#file-dir").textContent = doc.path ? doc.path.slice(0, -name.length - 1).replace(home, "~") || "/" : "";
  $("#dirty").hidden = !isDirty();
  // How it's stored, when that's not plain UTF-8 with \n: saved the same way.
  const how = [{ "utf-16le": "UTF-16 LE", "utf-16be": "UTF-16 BE" }[doc.encoding] ?? (doc.bom ? "UTF-8" : ""), doc.bom && "BOM", doc.eol === "\r\n" && "CRLF"].filter(Boolean).join(" · ");
  $("#encoding").textContent = how;
  $("#encoding").hidden = !how;
  document.title = `${isDirty() ? "● " : ""}${name} — textedit`;
}

// A document (doc.document) is read-only: its Markdown can be saved as a new
// file, and the document itself edited in its own app.
function showReadOnly() {
  const ro = !!doc.document;
  ta.readOnly = ro;
  mdEl.contentEditable = ro ? "false" : "true";
  mdEl.tabIndex = 0; // focusable, for the keys that scroll, when not editable
  $("#doc-note").hidden = !ro;
  $("#doc-note").textContent = ro ? `${doc.document}, read-only` : "";
  $("#doc-note").title = ro ? `Converted to Markdown for reading: headings, emphasis, lists, tables, links and pictures, but not fonts, colors or layout` : "";
  $("#btn-original").hidden = !ro;
  $("#btn-save").textContent = ro ? "Save as Markdown…" : "Save";
  $("#btn-save").title = ro ? "Save what's shown as a Markdown file (Ctrl+S)" : "Save (Ctrl+S); Save as: Ctrl+Shift+S";
  $("#find-form").classList.toggle("read-only", ro);
}

function showMessage(text) {
  $("#message").textContent = text;
  $("#message").hidden = !text;
}

// The path field in the bar, for Open and Save as. Resolves to an absolute
// path, or null when cancelled.
function askPath(label, value) {
  const form = $("#path-form"), input = $("#path-input");
  $("#path-label").textContent = label;
  $("#path-ok").textContent = label === "Open" ? "Open" : "Save";
  form.hidden = false;
  input.value = value.replace(home, "~");
  input.focus();
  const dot = input.value.lastIndexOf("."), slash = input.value.lastIndexOf("/");
  input.setSelectionRange(slash + 1, dot > slash ? dot : input.value.length);
  return new Promise((resolve) => {
    const done = (path) => {
      form.hidden = true;
      form.onsubmit = $("#path-cancel").onclick = input.onkeydown = null;
      focusText();
      resolve(path);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const path = input.value.trim().replace(/^~(?=\/|$)/, home);
      done(path.startsWith("/") ? path : null);
    };
    $("#path-cancel").onclick = () => done(null);
    input.onkeydown = (e) => e.key === "Escape" && done(null);
  });
}

async function openDialog() {
  const dir = doc.path ? doc.path.slice(0, doc.path.lastIndexOf("/") + 1) : `${home}/`;
  const path = await askPath("Open", dir);
  if (!path) return;
  if (isDirty() && !confirm("Discard the unsaved changes?")) return;
  await openFile(path);
}

// ---------------------------------------------------------------- language and indentation

function setLanguage(lang) {
  if (doc.lang === "markdown" && lang !== "markdown" && doc.mode === "view") showCode();
  doc.lang = lang;
  $("#language").value = lang;
  $("#md-switch").hidden = lang !== "markdown";
  hl = { lines: [], html: [] };
  onText();
}

const indentUnit = () => ({ 2: "  ", 4: "    ", tab: "\t" })[$("#indent").value];

// Picks the indentation the text already uses.
function guessIndent(text) {
  const indents = text.match(/^[ \t]+(?=\S)/gm) ?? [];
  if (!indents.length) return;
  const tabs = indents.filter((i) => i[0] === "\t").length;
  if (tabs > indents.length / 2) return void ($("#indent").value = "tab");
  const widths = indents.filter((i) => i[0] === " ").map((i) => i.length);
  $("#indent").value = widths.some((w) => w % 4 !== 0) ? "2" : "4";
}

// ---------------------------------------------------------------- drawing the text

// The text is a <textarea> with transparent text; under it, the visible lines
// are drawn highlighted. Highlighting runs in a worker after a pause; until
// it's back, changed lines are drawn plain (never stale), the rest from the
// last result, matched up by the unchanged lines at the top and bottom.
let lines = [""];
let hl = { lines: [], html: [] };
let same = { top: 0, bottom: 0 };
const worker = new Worker(new URL("../engine/ui/syntax-worker.js", import.meta.url), { type: "module" });
let sent = null, hlTimer;

worker.onmessage = (e) => {
  if (e.data.id !== sent?.id) return; // an older request
  hl = { lines: sent.lines, html: e.data.lines };
  match();
  paint();
};

function onText() {
  lines = ta.value.split("\n");
  match();
  paint();
  clearTimeout(hlTimer);
  if (ta.value.length > NO_HIGHLIGHT_OVER || doc.lang === "plaintext") return;
  hlTimer = setTimeout(() => {
    sent = { id: (sent?.id ?? 0) + 1, lines };
    worker.postMessage({ id: sent.id, text: ta.value, lang: doc.lang });
  }, ta.value.length > 200_000 ? 400 : 40);
}

function match() {
  const n = lines.length, m = hl.lines.length;
  let top = 0, bottom = 0;
  while (top < n && top < m && lines[top] === hl.lines[top]) top++;
  while (bottom < n - top && bottom < m - top && lines[n - 1 - bottom] === hl.lines[m - 1 - bottom]) bottom++;
  same = { top, bottom };
}

function lineHtml(i) {
  const n = lines.length, m = hl.lines.length;
  if (i < same.top) return hl.html[i];
  if (i >= n - same.bottom) return hl.html[i + m - n];
  return escape(lines[i]);
}

let caretLine = 0;

function paint() {
  if (doc.mode !== "code") return;
  const top = ta.scrollTop, left = ta.scrollLeft;
  const first = Math.max(0, Math.floor((top - PAD_TOP) / LINE));
  const last = Math.min(lines.length, first + Math.ceil(ta.clientHeight / LINE) + 2);
  const html = [], numbers = [];
  for (let i = first; i < last; i++) {
    html.push(lineHtml(i));
    numbers.push(`<div${i === caretLine ? ' class="current"' : ""}>${i + 1}</div>`);
  }
  hlEl.innerHTML = html.join("\n");
  hlEl.style.transform = `translate(${PAD_X - left}px, ${PAD_TOP + first * LINE - top}px)`;
  linesEl.innerHTML = numbers.join("");
  linesEl.style.transform = `translateY(${PAD_TOP + first * LINE - top}px)`;
  $("#gutter").style.width = `${Math.max(3, String(lines.length).length) * 8 + 26}px`;
  $("#current-line").style.top = `${PAD_TOP + caretLine * LINE - top}px`;
  paintMatch();
}

ta.addEventListener("input", () => {
  onText();
  showCaret();
  showFile();
});
ta.addEventListener("scroll", paint, { passive: true });
new ResizeObserver(paint).observe(ta);

// The cursor's line and column, in the status bar and the line highlight.
function showCaret() {
  const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
  let line = 0;
  for (let i = v.indexOf("\n"); i !== -1 && i < s; i = v.indexOf("\n", i + 1)) line++;
  const col = s - v.lastIndexOf("\n", s - 1);
  if (doc.mode === "code") $("#where").textContent = `Ln ${line + 1}, Col ${col}${e > s ? `  ·  ${e - s} selected` : ""}`;
  if (line !== caretLine) {
    caretLine = line;
    paint();
  }
}
document.addEventListener("selectionchange", () => document.activeElement === ta && showCaret());

// ---------------------------------------------------------------- editing

// Replaces text[start, end) with `text` so that Ctrl+Z undoes it, then
// selects [selStart, selEnd).
function replace(start, end, text, selStart = start + text.length, selEnd = selStart) {
  if (doc.document) return; // read-only
  ta.focus();
  ta.setSelectionRange(start, end);
  const done = text ? document.execCommand("insertText", false, text) : start === end || document.execCommand("delete");
  if (!done) {
    ta.setRangeText(text, start, end, "end");
    ta.dispatchEvent(new Event("input"));
  }
  ta.setSelectionRange(selStart, selEnd);
  showCaret();
}

// The whole lines the selection touches: [start, end) without the last newline.
function selectedLines() {
  const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
  const start = v.lastIndexOf("\n", s - 1) + 1;
  const to = e > s && v[e - 1] === "\n" ? e - 1 : e; // a selection ending at a line's start leaves that line out
  let end = v.indexOf("\n", to);
  if (end === -1) end = v.length;
  return { start, end, text: v.slice(start, end), s, e };
}

function indentLines(by) {
  const { start, end, text } = selectedLines();
  const unit = indentUnit();
  const out = text.split("\n").map((l) => {
    if (by > 0) return l ? unit + l : l;
    return l.replace(unit === "\t" ? /^\t/ : new RegExp(`^ {1,${unit.length}}|^\\t`), "");
  }).join("\n");
  replace(start, end, out, start, start + out.length);
}

function toggleComment() {
  const comment = commentOf(doc.lang);
  if (!comment) return;
  const { start, end, text, s, e } = selectedLines();
  const ls = text.split("\n");
  const filled = ls.filter((l) => l.trim());
  const minIndent = Math.min(...filled.map((l) => /^\s*/.exec(l)[0].length));
  let out;
  if (comment.line) {
    const mark = comment.line;
    const commented = filled.length && filled.every((l) => l.trimStart().startsWith(mark));
    out = ls.map((l) => {
      if (!l.trim()) return l;
      if (commented) return l.replace(new RegExp(`^(\\s*)${mark.replace(/[/*]/g, "\\$&")} ?`), "$1");
      return l.slice(0, minIndent) + mark + " " + l.slice(minIndent);
    });
  } else {
    const [open, close] = comment.block;
    const commented = filled.length && filled.every((l) => l.trim().startsWith(open) && l.trim().endsWith(close));
    out = ls.map((l) => {
      if (!l.trim()) return l;
      if (commented) return l.replace(open + " ", "").replace(open, "").replace(new RegExp(` ?${close.replace(/[*]/g, "\\*")}\\s*$`), "");
      return l.slice(0, minIndent) + `${open} ${l.slice(minIndent)} ${close}`;
    });
  }
  const joined = out.join("\n");
  if (s === e) {
    const caret = Math.max(start, Math.min(start + joined.length, s + (joined.length - text.length)));
    replace(start, end, joined, caret, caret);
  } else {
    replace(start, end, joined, start, start + joined.length);
  }
}

function moveLines(dir) {
  const v = ta.value;
  const { start, end, text, s, e } = selectedLines();
  if (dir < 0) {
    if (start === 0) return;
    const prevStart = v.lastIndexOf("\n", start - 2) + 1;
    const prev = v.slice(prevStart, start - 1);
    replace(prevStart, end, text + "\n" + prev, s - prev.length - 1, e - prev.length - 1);
  } else {
    if (end >= v.length) return;
    let nextEnd = v.indexOf("\n", end + 1);
    if (nextEnd === -1) nextEnd = v.length;
    const next = v.slice(end + 1, nextEnd);
    replace(start, nextEnd, next + "\n" + text, s + next.length + 1, e + next.length + 1);
  }
}

function duplicateLines(dir) {
  const { start, end, text, s, e } = selectedLines();
  if (dir > 0) replace(end, end, "\n" + text, s + text.length + 1, e + text.length + 1);
  else replace(start, start, text + "\n", s, e);
}

function deleteLines() {
  const v = ta.value;
  const { start, end } = selectedLines();
  if (end < v.length) replace(start, end + 1, "", start, start);
  else replace(Math.max(0, start - 1), end, "", Math.max(0, start - 1), Math.max(0, start - 1));
}

// Copying with nothing selected copies the whole line (with its line break),
// which pastes in as a line above the cursor's, as in most code editors.
let copiedLine = null;

function copy({ cut = false } = {}) {
  const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
  if (s !== e) {
    copiedLine = null;
    copyText(v.slice(s, e));
    if (cut) replace(s, e, "");
    return;
  }
  const { start, end, text } = selectedLines();
  copiedLine = text + "\n";
  copyText(copiedLine);
  if (cut) {
    if (end < v.length) replace(start, end + 1, "", start, start);
    else replace(Math.max(0, start - 1), end, "", Math.max(0, start - 1));
  }
}

async function paste() {
  const text = await pasteText();
  if (!text) return;
  const s = ta.selectionStart, e = ta.selectionEnd;
  if (s === e && text === copiedLine) {
    const start = ta.value.lastIndexOf("\n", s - 1) + 1;
    replace(start, start, text, s + text.length, s + text.length);
  } else {
    replace(s, e, text);
  }
}

ta.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey, k = e.key;
  const clip = clipboardKey(e);
  if (clip === "copy") copy();
  else if (clip === "cut") copy({ cut: true });
  else if (clip === "paste") paste();
  else if (k === "Tab" && !ctrl && !e.altKey) {
    const multi = ta.value.slice(ta.selectionStart, ta.selectionEnd).includes("\n");
    if (e.shiftKey || multi) indentLines(e.shiftKey ? -1 : 1);
    else replace(ta.selectionStart, ta.selectionEnd, indentUnit());
  } else if (k === "Enter" && !ctrl && !e.altKey && !e.shiftKey) {
    // Keep the line's indentation; one more after an opening bracket (and a
    // colon in Python), with a closing one right after the cursor on its own line.
    const v = ta.value, s = ta.selectionStart;
    const lineStart = v.lastIndexOf("\n", s - 1) + 1;
    const indent = /^[ \t]*/.exec(v.slice(lineStart, s))[0];
    const before = v.slice(lineStart, s).trimEnd().at(-1);
    const after = v[ta.selectionEnd];
    const opens = "{[(".includes(before ?? "x") || (before === ":" && doc.lang === "python");
    if (opens) {
      const inner = indent + indentUnit();
      const closes = { "{": "}", "[": "]", "(": ")" }[before] === after;
      replace(s, ta.selectionEnd, "\n" + inner + (closes ? "\n" + indent : ""), s + 1 + inner.length);
    } else {
      replace(s, ta.selectionEnd, "\n" + indent);
    }
  } else if (ctrl && k === "/") toggleComment();
  else if (e.altKey && !ctrl && (k === "ArrowUp" || k === "ArrowDown")) (e.shiftKey ? duplicateLines : moveLines)(k === "ArrowUp" ? -1 : 1);
  else if (ctrl && e.shiftKey && k.toLowerCase() === "k") deleteLines();
  else if (ctrl && !e.shiftKey && k.toLowerCase() === "l") {
    const { start, end } = selectedLines();
    ta.setSelectionRange(start, Math.min(end + 1, ta.value.length));
  } else if (k === "Home" && !ctrl && !e.altKey) {
    // To the line's first character, then to its very start.
    const v = ta.value, s = ta.selectionDirection === "backward" ? ta.selectionStart : ta.selectionEnd;
    const lineStart = v.lastIndexOf("\n", s - 1) + 1;
    const first = lineStart + /^[ \t]*/.exec(v.slice(lineStart))[0].length;
    const to = s === first ? lineStart : first;
    if (e.shiftKey) {
      const anchor = ta.selectionDirection === "backward" ? ta.selectionEnd : ta.selectionStart;
      ta.setSelectionRange(Math.min(anchor, to), Math.max(anchor, to), to < anchor ? "backward" : "forward");
    } else ta.setSelectionRange(to, to);
    showCaret();
  } else return;
  e.preventDefault();
});

// ---------------------------------------------------------------- find and replace

const findInput = $("#find-input");
let found = null; // { start, end } of the current match, drawn while the field has focus

function openFind({ replacing = false } = {}) {
  if (doc.document) replacing = false; // read-only
  $("#find-form").hidden = false;
  $("#find-form").classList.toggle("replacing", replacing || $("#find-form").classList.contains("replacing"));
  const sel = doc.mode === "code" ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : String(getSelection());
  if (sel && !sel.includes("\n")) findInput.value = sel;
  (replacing ? $("#replace-input") : findInput).focus();
  findInput.select();
  countMatches();
}

function closeFind() {
  $("#find-form").hidden = true;
  found = null;
  paint();
  focusText();
}

function matches() {
  const q = findInput.value;
  if (!q) return [];
  const caseful = $("#find-case").checked;
  const hay = caseful ? ta.value : ta.value.toLowerCase();
  const needle = caseful ? q : q.toLowerCase();
  const out = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

function countMatches() {
  const all = matches();
  const i = found ? all.indexOf(found.start) : -1;
  $("#find-count").textContent = !findInput.value ? "" : !all.length ? "none" : i === -1 ? `${all.length}` : `${i + 1} of ${all.length}`;
  findInput.classList.toggle("none", !!findInput.value && !all.length);
  return all;
}

function findNext(dir = 1) {
  if (doc.mode !== "code") showCode();
  const all = matches();
  if (!all.length) return countMatches();
  const from = found ? found.start : ta.selectionStart;
  const i = dir > 0 ? all.find((p) => p > from) ?? all[0] : [...all].reverse().find((p) => p < from) ?? all.at(-1);
  found = { start: i, end: i + findInput.value.length };
  ta.setSelectionRange(found.start, found.end);
  scrollToOffset(i);
  showCaret();
  countMatches();
  paint();
}

function replaceOne() {
  if (!found || ta.value.slice(found.start, found.end).toLowerCase() !== findInput.value.toLowerCase()) return findNext();
  const r = $("#replace-input").value;
  replace(found.start, found.end, r);
  found = { start: found.start, end: found.start + r.length };
  findNext();
  $("#replace-input").focus();
}

function replaceAll() {
  const all = matches();
  if (!all.length) return;
  const q = findInput.value, r = $("#replace-input").value, v = ta.value;
  let out = "", last = 0;
  for (const i of all) (out += v.slice(last, i) + r), (last = i + q.length);
  out += v.slice(last);
  replace(0, v.length, out, 0, 0);
  found = null;
  $("#find-count").textContent = `${all.length} replaced`;
  $("#replace-input").focus();
}

// The current match, marked while the find field has focus (the text field's
// own selection doesn't show then).
const matchEl = Object.assign(document.createElement("div"), { id: "match" });
Object.assign(matchEl.style, { position: "absolute", height: `${LINE}px`, background: "var(--selection)", borderRadius: "2px", pointerEvents: "none" });
$("#code").insertBefore(matchEl, hlEl);
let charWidth = 0;
function paintMatch() {
  matchEl.hidden = !found || document.activeElement === ta;
  if (matchEl.hidden) return;
  if (!charWidth) {
    const probe = Object.assign(document.createElement("span"), { textContent: "x".repeat(100) });
    hlEl.append(probe);
    charWidth = probe.getBoundingClientRect().width / 100;
    probe.remove();
  }
  const v = ta.value;
  const lineStart = v.lastIndexOf("\n", found.start - 1) + 1;
  const line = v.slice(0, found.start).split("\n").length - 1;
  const col = (s) => s.replace(/[^\t]*\t/g, (m) => " ".repeat(Math.ceil(m.length / 4) * 4)).length; // tabs to the next multiple of 4
  const x = col(v.slice(lineStart, found.start)), w = col(v.slice(lineStart, found.end)) - x;
  Object.assign(matchEl.style, {
    left: `${PAD_X + x * charWidth - ta.scrollLeft}px`,
    top: `${PAD_TOP + line * LINE - ta.scrollTop}px`,
    width: `${Math.max(2, w * charWidth)}px`,
  });
}

function scrollToOffset(offset) {
  const v = ta.value;
  const line = v.slice(0, offset).split("\n").length - 1;
  const y = PAD_TOP + line * LINE;
  if (y < ta.scrollTop + PAD_TOP || y > ta.scrollTop + ta.clientHeight - LINE * 3) ta.scrollTop = Math.max(0, y - ta.clientHeight / 3);
}

findInput.addEventListener("input", () => {
  found = null;
  countMatches();
  if (findInput.value) {
    const start = ta.selectionStart;
    found = { start: start - 1, end: start - 1 }; // search from where the cursor is
    findNext();
  }
});
$("#find-form").addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeFind();
  else if (e.key === "Enter" && e.target === findInput) findNext(e.shiftKey ? -1 : 1);
  else if (e.key === "Enter" && e.target.id === "replace-input") replaceOne();
  else return;
  e.preventDefault();
  e.stopPropagation();
});
$("#find-next").onclick = () => findNext(1);
$("#find-prev").onclick = () => findNext(-1);
$("#find-case").onchange = () => countMatches();
$("#replace-one").onclick = replaceOne;
$("#replace-all").onclick = replaceAll;
$("#find-close").onclick = closeFind;
findInput.addEventListener("blur", () => setTimeout(paint));

function goToLine() {
  const answer = prompt(`Go to line (1–${lines.length})`);
  const n = parseInt(answer);
  if (!n) return;
  showCode();
  const v = ta.value;
  let offset = 0;
  for (let i = 1; i < Math.min(n, lines.length); i++) offset = v.indexOf("\n", offset) + 1;
  ta.setSelectionRange(offset, offset);
  scrollToOffset(offset);
  showCaret();
}

// ---------------------------------------------------------------- Markdown as it reads

// Image paths in the Markdown, relative to the file, as URLs that show them.
function resolveImage(src) {
  if (/^[a-z][\w+.-]*:/i.test(src)) return src;
  const dir = doc.path ? doc.path.slice(0, doc.path.lastIndexOf("/")) : home;
  const path = decodeURIComponent(new URL(src, `file://${dir}/`).pathname);
  return `file?path=${encodeURIComponent(path)}`;
}

function showView() {
  if (doc.lang !== "markdown") return;
  const { html, blocks } = renderMarkdown(ta.value, { resolve: resolveImage });
  mdEl.innerHTML = html;
  doc.blocks = blocks;
  doc.viewEdited = false;
  doc.mode = "view";
  $("#editor").hidden = true;
  mdEl.hidden = false;
  mdEl.focus();
  $("#where").textContent = "Markdown, as it reads";
  showSwitch();
}

function showCode() {
  const wasView = doc.mode === "view";
  $("#editor").hidden = false;
  mdEl.hidden = true;
  if (wasView) flushView();
  doc.mode = "code";
  focusText();
  showCaret();
  paint();
  showSwitch();
}

// What was edited in the view, into the text (undoable there).
function flushView() {
  if (doc.mode !== "view" || !doc.viewEdited) return;
  const md = toMarkdown(mdEl, doc.blocks);
  doc.viewEdited = false;
  if (md === ta.value) return;
  if ($("#editor").hidden) {
    ta.value = md;
    onText();
  } else {
    replace(0, ta.value.length, md, 0, 0);
  }
  // The view now stands for this text.
  doc.blocks = renderMarkdown(md, { resolve: resolveImage }).blocks;
  showFile();
}

function showSwitch() {
  $("#btn-view").classList.toggle("on", doc.mode === "view");
  $("#btn-source").classList.toggle("on", doc.mode === "code");
}

const focusText = () => (doc.mode === "view" ? mdEl : ta).focus({ preventScroll: true });

document.execCommand("defaultParagraphSeparator", false, "p");

mdEl.addEventListener("input", () => {
  doc.viewEdited = true;
  showFile();
});

// A checkbox's state lives in its attribute, so the edit shows in the HTML.
mdEl.addEventListener("change", (e) => {
  if (e.target.type !== "checkbox") return;
  e.target.toggleAttribute("checked", e.target.checked);
  doc.viewEdited = true;
  showFile();
});

mdEl.addEventListener("click", (e) => e.target.closest("a") && e.preventDefault());

// Pasting goes in as plain text; copying copies the text as it shows.
mdEl.addEventListener("paste", (e) => {
  e.preventDefault();
  document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
});

mdEl.addEventListener("keydown", async (e) => {
  const ctrl = e.ctrlKey || e.metaKey, k = e.key;
  const clip = clipboardKey(e);
  if (clip) {
    e.preventDefault();
    if (clip === "paste") {
      const text = await pasteText();
      if (text) document.execCommand("insertText", false, text);
    } else {
      copyText(String(getSelection()));
      if (clip === "cut") document.execCommand("delete");
    }
    return;
  }
  if (ctrl && k.toLowerCase() === "b") document.execCommand("bold");
  else if (ctrl && k.toLowerCase() === "i") document.execCommand("italic");
  else if (ctrl && k.toLowerCase() === "k") {
    const url = prompt("Link to");
    if (url) document.execCommand("createLink", false, url);
  } else if (k === "Enter" && getSelection().anchorNode?.parentElement?.closest("pre")) {
    document.execCommand("insertText", false, "\n"); // a new line inside a code block, not a new paragraph
  } else if (k === " " && markdownShortcut()) {
    // handled
  } else return;
  e.preventDefault();
});

// Typing a block's Markdown marker at its start (then a space) turns it into
// that block: "# " a heading, "- " a list, "1. " a numbered list, "> " a quote.
function markdownShortcut() {
  const sel = getSelection();
  if (!sel.isCollapsed || sel.anchorNode?.nodeType !== Node.TEXT_NODE) return false;
  const block = sel.anchorNode.parentElement.closest("p, div, h1, h2, h3, h4, h5, h6, li");
  if (!block || !mdEl.contains(block) || block.closest("pre")) return false;
  const range = document.createRange();
  range.setStart(block, 0);
  range.setEnd(sel.anchorNode, sel.anchorOffset);
  const before = range.toString();
  let command;
  if (/^#{1,6}$/.test(before)) command = ["formatBlock", `h${before.length}`];
  else if (/^[-*+]$/.test(before) && block.tagName !== "LI") command = ["insertUnorderedList"];
  else if (/^\d+[.)]$/.test(before) && block.tagName !== "LI") command = ["insertOrderedList"];
  else if (before === ">") command = ["formatBlock", "blockquote"];
  else return false;
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand("delete");
  document.execCommand(...command.length > 1 ? [command[0], false, command[1]] : [command[0]]);
  return true;
}

$("#btn-view").onclick = () => doc.mode !== "view" && showView();
$("#btn-source").onclick = () => doc.mode !== "code" && showCode();

// ---------------------------------------------------------------- keys for the whole window

document.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (k === "escape") {
    if (!$("#find-form").hidden) closeFind();
    else if (!$("#path-form").hidden) return;
    else if (embedded) close();
    else return;
  } else if (e.key === "F3") findNext(e.shiftKey ? -1 : 1);
  else if (!ctrl || e.altKey) return;
  else if (k === "s") save({ as: e.shiftKey });
  else if (k === "o") openDialog();
  else if (k === "f" && !e.shiftKey) openFind();
  else if (k === "h") openFind({ replacing: true });
  else if (k === "g") goToLine();
  else if (k === "m" && e.shiftKey && doc.lang === "markdown") doc.mode === "view" ? showCode() : showView();
  else return;
  e.preventDefault();
});

// ---------------------------------------------------------------- the rest of the bar

for (const [value, name] of LANGUAGES) $("#language").append(new Option(name, value));
$("#language").onchange = () => {
  setLanguage($("#language").value);
  focusText();
};
$("#indent").onchange = () => focusText();
$("#btn-find").onclick = () => openFind();
$("#btn-open").onclick = openDialog;
$("#btn-save").onclick = () => save();
$("#btn-original").onclick = () => api("api/open", { method: "POST", body: JSON.stringify({ path: doc.path }) }).catch((err) => alert(err.message));
$("#btn-close").onclick = close;
$("#btn-close").title = embedded ? "Close (Esc)" : "Close";
onCloseRequest(close);

// ---------------------------------------------------------------- start

const { home } = await api("api/init");
const file = new URLSearchParams(location.search).get("file");
if (file) await openFile(file);
else setLanguage("plaintext"), showFile();
holdFocus(() => (doc.mode === "view" ? mdEl : ta));
ready(); // with the file shown: the window appears (or, inside phil, gets the keyboard)
