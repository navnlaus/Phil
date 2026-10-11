import { format, parse, position } from "/ui/json.js";

const $ = (sel) => document.querySelector(sel);
const textarea = $("#text");
const lines = $("#lines");
const gutter = $("#gutter");
const tree = $("#tree");
const stateEl = $("#state");
const LINE = 19; // px, --line in style.css
const TOP = 8; // px, the text's top padding
const CHUNK = 500; // tree rows rendered at a time per container

const doc = {
  path: null, // null: not saved anywhere yet
  mtime: null, // when the file was read or saved (null: new file)
  saved: "", // the text as on disk
  root: null, // parse tree of the current text, or null
  error: null, // { message, offset } when the text isn't valid JSON
  lineCount: 1,
};
const expanded = new Set(["$"]); // tree containers shown open, by path ("$", "$.a", "$.a[3]")

// ---------------------------------------------------------------- files

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw Object.assign(new Error((await res.text()) || res.statusText), { status: res.status });
  return res.json();
}

async function openFile(path) {
  const file = await api(`/api/file?path=${encodeURIComponent(path)}`);
  doc.path = file.path;
  doc.mtime = file.missing ? null : file.mtime;
  doc.saved = file.missing ? "" : file.text;
  textarea.value = doc.saved;
  textarea.setSelectionRange(0, 0);
  textarea.scrollTop = 0;
  expanded.clear();
  expanded.add("$");
  guessIndent(doc.saved);
  update({ expandDepth: 2 });
  showFile();
}

async function save({ as = false } = {}) {
  if (!doc.path || as) {
    const path = await askPath(as ? "Save as" : "Save to", doc.path ?? `${home}/untitled.json`);
    if (!path) return;
    return write(path, { isNew: path !== doc.path });
  }
  return write(doc.path, {});
}

async function write(path, { isNew = false, force = false }) {
  const text = textarea.value;
  try {
    const { mtime } = await api("/api/file", {
      method: "PUT",
      body: JSON.stringify({ path, text, mtime: isNew ? null : doc.mtime, force }),
    });
    Object.assign(doc, { path, mtime, saved: text });
    showFile();
  } catch (err) {
    if (err.status === 409 && !force && confirm(`${err.message}\n\nOverwrite it with what's here?`)) return write(path, { isNew, force: true });
    if (err.status !== 409) alert(`Couldn't save: ${err.message}`);
  }
}

function showFile() {
  const name = doc.path ? doc.path.split("/").pop() : "Untitled";
  $("#file-name").textContent = name;
  $("#file-dir").textContent = doc.path ? doc.path.slice(0, -name.length - 1).replace(home, "~") || "/" : "";
  const dirty = textarea.value !== doc.saved;
  $("#dirty").hidden = !dirty;
  document.title = `${dirty ? "● " : ""}${name} — jsonedit`;
}

// The path field under the bar, for Open and Save as. Resolves to an absolute
// path, or null when cancelled.
function askPath(label, value) {
  const form = $("#path-form"), input = $("#path-input");
  $("#path-label").textContent = label;
  $("#path-ok").textContent = label === "Open" ? "Open" : "Save";
  form.hidden = false;
  input.value = value.replace(home, "~");
  input.focus();
  const dot = input.value.lastIndexOf(".");
  const slash = input.value.lastIndexOf("/");
  input.setSelectionRange(slash + 1, dot > slash ? dot : input.value.length);
  return new Promise((resolve) => {
    const done = (path) => {
      form.hidden = true;
      form.onsubmit = $("#path-cancel").onclick = input.onkeydown = null;
      textarea.focus();
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
  if (textarea.value !== doc.saved && !confirm("Discard the unsaved changes?")) return;
  try {
    await openFile(path);
  } catch (err) {
    alert(`Couldn't open ${path}: ${err.message}`);
  }
}

// ---------------------------------------------------------------- editing

let parseTimer;
textarea.addEventListener("input", () => {
  showFile();
  updateGutter();
  clearTimeout(parseTimer);
  parseTimer = setTimeout(update, textarea.value.length > 200_000 ? 400 : 60);
});

// Re-parses the text and refreshes everything that depends on it.
function update({ expandDepth = 0 } = {}) {
  const text = textarea.value;
  const result = parse(text);
  doc.root = result.root ?? null;
  doc.error = result.error ?? null;
  if (doc.root && expandDepth) expandTo(doc.root, "$", expandDepth);
  showState();
  renderTree();
  updateGutter();
  followCaret();
}

function showState() {
  stateEl.className = doc.error ? "error" : doc.root ? "ok" : "";
  if (doc.error) {
    const { line, column } = position(textarea.value, doc.error.offset);
    stateEl.textContent = `Line ${line}, column ${column}: ${doc.error.message}`;
    stateEl.title = "Go there";
  } else {
    stateEl.textContent = `✓ Valid JSON · ${describe(doc.root)}`;
    stateEl.title = "";
  }
  for (const id of ["#btn-format", "#btn-minify", "#btn-sort"]) $(id).disabled = !doc.root;
}

stateEl.addEventListener("click", () => doc.error && select(doc.error.offset, doc.error.offset));

function describe(node) {
  const n = node.children?.length;
  if (node.type === "object") return `object with ${n} key${n === 1 ? "" : "s"}`;
  if (node.type === "array") return `array of ${n} item${n === 1 ? "" : "s"}`;
  return node.type;
}

// Replaces the whole text so that Ctrl+Z can undo it.
function replaceText(text) {
  if (text === textarea.value) return;
  textarea.focus();
  textarea.select();
  if (!document.execCommand("insertText", false, text)) {
    textarea.value = text;
    textarea.dispatchEvent(new Event("input"));
  }
  textarea.setSelectionRange(0, 0);
  textarea.scrollTop = 0;
}

const indentUnit = () => ({ 2: "  ", 4: "    ", tab: "\t" })[$("#indent").value];

function reformat({ minify = false, sortKeys = false } = {}) {
  if (!doc.root) return;
  replaceText(format(textarea.value, doc.root, { indent: minify ? "" : indentUnit(), sortKeys }) + (minify ? "" : "\n"));
}

// Picks the indentation the file already uses.
function guessIndent(text) {
  const m = /\n([ \t]+)\S/.exec(text);
  if (!m) return;
  $("#indent").value = m[1][0] === "\t" ? "tab" : m[1].length >= 4 ? "4" : "2";
}

textarea.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    document.execCommand("insertText", false, indentUnit());
  } else if (e.key === "Enter" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    // Keep the line's indentation; one level more after { or [, and a closing
    // } or ] right after the cursor goes on its own line.
    e.preventDefault();
    const v = textarea.value, at = textarea.selectionStart;
    const lineStart = v.lastIndexOf("\n", at - 1) + 1;
    const indent = /^[ \t]*/.exec(v.slice(lineStart, at))[0];
    const before = v.slice(lineStart, at).trimEnd().at(-1);
    const after = v.slice(textarea.selectionEnd).match(/^[ \t]*(.)?/)[1];
    if (before === "{" || before === "[") {
      const inner = indent + indentUnit();
      const closes = (before === "{" && after === "}") || (before === "[" && after === "]");
      document.execCommand("insertText", false, "\n" + inner + (closes ? "\n" + indent : ""));
      if (closes) textarea.setSelectionRange(at + 1 + inner.length, at + 1 + inner.length);
    } else {
      document.execCommand("insertText", false, "\n" + indent);
    }
  }
});

// ---------------------------------------------------------------- line numbers

// Only the visible line numbers exist, so huge files stay fast.
function updateGutter() {
  doc.lineCount = 1 + (textarea.value.match(/\n/g)?.length ?? 0);
  const top = textarea.scrollTop;
  const first = Math.max(0, Math.floor((top - TOP) / LINE));
  const count = Math.ceil(textarea.clientHeight / LINE) + 2;
  const errorLine = doc.error ? position(textarea.value, doc.error.offset).line : -1;
  const html = [];
  for (let n = first + 1; n <= Math.min(doc.lineCount, first + count); n++) {
    html.push(`<div${n === errorLine ? ' class="error"' : ""}>${n}</div>`);
  }
  lines.innerHTML = html.join("");
  lines.style.transform = `translateY(${first * LINE - top}px)`;
  gutter.style.width = `${Math.max(3, String(doc.lineCount).length) * 8 + 24}px`;
}
textarea.addEventListener("scroll", updateGutter, { passive: true });
new ResizeObserver(updateGutter).observe(textarea);

// ---------------------------------------------------------------- tree

const childPath = (parent, node, i) => (node.key !== undefined ? `${parent}.${JSON.stringify(node.key)}` : `${parent}[${i}]`);

function expandTo(node, path, depth) {
  if (!node.children || depth <= 0) return;
  expanded.add(path);
  node.children.forEach((c, i) => expandTo(c, childPath(path, c, i), depth - 1));
}

function renderTree() {
  if (!doc.root) {
    if (!tree.querySelector(".row")) tree.innerHTML = `<div class="empty">The structure shows here once the text is valid JSON.</div>`;
    tree.style.opacity = tree.querySelector(".row") ? "0.45" : ""; // the last good tree, dimmed
    return;
  }
  tree.style.opacity = "";
  const scroll = tree.scrollTop;
  const frag = document.createDocumentFragment();
  addRows(frag, doc.root, "$", 0, null);
  tree.replaceChildren(frag);
  tree.scrollTop = scroll;
}

// Rows for `node` and, if expanded, its children (CHUNK at a time).
function addRows(frag, node, path, depth, label) {
  const row = document.createElement("div");
  row.className = "row";
  row.style.paddingLeft = `${8 + depth * 14}px`;
  row.node = node;
  row.path = path;
  const open = expanded.has(path);
  const container = node.children !== undefined;
  row.innerHTML = `<span class="toggle">${container && node.children.length ? (open ? "▾" : "▸") : ""}</span>`;
  if (label) row.append(label);
  const value = document.createElement("span");
  if (container) {
    value.className = "count";
    const n = node.children.length;
    value.textContent = node.type === "object" ? `{${n}}` : `[${n}]`;
  } else {
    value.className = node.type;
    // Numbers as written: JS would turn 2.50 into 2.5 and round big ones.
    value.textContent = node.type === "string" ? JSON.stringify(node.value.length > 200 ? node.value.slice(0, 200) + "…" : node.value) : textarea.value.slice(node.start, node.end);
  }
  row.append(value);
  frag.append(row);
  if (!container || !open) return;
  const limit = shownMore.get(path) ?? CHUNK;
  node.children.slice(0, limit).forEach((c, i) => {
    const l = document.createElement("span");
    l.className = c.key !== undefined ? "key" : "index";
    l.textContent = c.key !== undefined ? `${JSON.stringify(c.key)}:` : `${i}:`;
    addRows(frag, c, childPath(path, c, i), depth + 1, l);
  });
  if (node.children.length > limit) {
    const more = document.createElement("div");
    more.className = "row";
    more.style.paddingLeft = `${22 + (depth + 1) * 14}px`;
    more.innerHTML = `<span class="count">… ${node.children.length - limit} more (show ${Math.min(CHUNK, node.children.length - limit)})</span>`;
    more.onclick = () => {
      shownMore.set(path, limit + CHUNK);
      renderTree();
    };
    frag.append(more);
  }
}
const shownMore = new Map(); // path -> how many children of a big container are shown

tree.addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (!row?.node) return;
  if (e.target.classList.contains("toggle") && row.node.children?.length) {
    if (!expanded.delete(row.path)) expanded.add(row.path);
    return renderTree();
  }
  select(row.node.start, row.node.end);
});
tree.addEventListener("dblclick", (e) => {
  const row = e.target.closest(".row");
  if (!row?.node?.children?.length) return;
  if (!expanded.delete(row.path)) expanded.add(row.path);
  renderTree();
});

// Selects text and scrolls it into view (a third of the way down).
function select(start, end) {
  textarea.focus();
  textarea.setSelectionRange(start, end);
  const { line } = position(textarea.value, start);
  const y = TOP + (line - 1) * LINE;
  if (y < textarea.scrollTop || y > textarea.scrollTop + textarea.clientHeight - LINE * 2) {
    textarea.scrollTop = Math.max(0, y - textarea.clientHeight / 3);
  }
  followCaret();
}

// The tree follows the cursor: the innermost value around it is highlighted,
// its containers opened.
let caretTimer;
function followCaret() {
  clearTimeout(caretTimer);
  caretTimer = setTimeout(() => {
    const at = textarea.selectionStart;
    const { line, column } = position(textarea.value, at);
    $("#caret").textContent = `Ln ${line}, Col ${column}`;
    if (!doc.root) return;
    let node = doc.root, path = "$";
    const opened = [];
    for (;;) {
      const i = node.children?.findIndex((c) => (c.keyStart ?? c.start) <= at && at <= c.end) ?? -1;
      if (i === -1) break;
      if (!expanded.has(path)) opened.push(path);
      path = childPath(path, node.children[i], i);
      node = node.children[i];
    }
    if (opened.length) {
      opened.forEach((p) => expanded.add(p));
      renderTree();
    }
    for (const row of tree.querySelectorAll(".row.current")) row.classList.remove("current");
    const row = [...tree.children].find((r) => r.path === path);
    row?.classList.add("current");
    row?.scrollIntoView({ block: "nearest" });
  }, 80);
}
for (const event of ["click", "keyup", "select"]) textarea.addEventListener(event, followCaret);

// ---------------------------------------------------------------- layout and keys

$("#split").addEventListener("pointerdown", (e) => {
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  const main = handle.parentElement.getBoundingClientRect();
  const move = (ev) => {
    const pct = Math.min(85, Math.max(20, ((ev.clientX - main.left) / main.width) * 100));
    document.documentElement.style.setProperty("--split", `${pct}%`);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", () => handle.removeEventListener("pointermove", move), { once: true });
});

$("#btn-open").onclick = openDialog;
$("#btn-save").onclick = () => save();
$("#btn-format").onclick = () => reformat();
$("#btn-minify").onclick = () => reformat({ minify: true });
$("#btn-sort").onclick = () => reformat({ sortKeys: true });
$("#indent").addEventListener("change", () => {
  try {
    localStorage.setItem("indent", $("#indent").value);
  } catch { /* storage unavailable */ }
});

document.addEventListener("keydown", (e) => {
  if (!e.ctrlKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === "s") save({ as: e.shiftKey });
  else if (key === "o") openDialog();
  else if (key === "f" && e.shiftKey) reformat();
  else return;
  e.preventDefault();
});

// ---------------------------------------------------------------- start

// The engine shows the window once the page is ready (engine/window.js).
globalThis.webkit?.messageHandlers?.phil?.postMessage("ready");
const { home } = await api("/api/init");
try {
  $("#indent").value = localStorage.getItem("indent") ?? "2";
} catch { /* storage unavailable */ }
const file = new URLSearchParams(location.search).get("file");
if (file) {
  try {
    await openFile(file);
  } catch (err) {
    alert(`Couldn't open ${file}: ${err.message}`);
  }
} else {
  update();
  showFile();
}
textarea.focus();
