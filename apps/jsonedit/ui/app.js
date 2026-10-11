import { parse, position } from "/ui/json.js";
import { clone, displayPath, editText, follow, freshKey, fromParse, isContainer, literal, serialize, stepsTo } from "/ui/model.js";

const $ = (sel) => document.querySelector(sel);
const tree = $("#tree");
const menu = $("#menu");
const CHUNK = 500; // rows shown at a time for a big object or array
const INDENT = 18; // px per level

const doc = {
  path: null, // null: not saved anywhere yet
  mtime: null, // when the file was read or saved (null: new file)
  root: null, // the model (model.js); null while fixing a file that isn't JSON
  fixSaved: null, // the text on disk, while fixing it
};
let selected = null;
const expanded = new Set(); // open objects and arrays
const shown = new WeakMap(); // big containers: how many children are shown
let rowOf = new WeakMap(); // node -> its row, for the current render

// Undo: snapshots of the whole document with which items were open and
// selected. States have ids, so "unsaved changes" survives undo and redo.
const undoStack = [], redoStack = [];
let stateId = 0, savedId = 0, nextId = 1;

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
  undoStack.length = redoStack.length = 0;
  stateId = savedId = 0;
  load(file.missing ? "{}" : file.text);
}

// Shows `text` as a tree, or as text to fix if it isn't valid JSON.
function load(text) {
  const result = parse(text);
  guessIndent(text);
  expanded.clear();
  if (!result.root) {
    doc.root = null;
    doc.fixSaved = text;
    showFix(text);
  } else {
    doc.root = fromParse(text, result.root);
    doc.fixSaved = null;
    $("#fix").hidden = true;
    tree.hidden = false;
    expandTo(doc.root, 2);
    selected = doc.root;
    render();
    tree.focus();
  }
  showFile();
}

async function save({ as = false } = {}) {
  if (!doc.path || as) {
    const path = await askPath(as ? "Save as" : "Save to", doc.path ?? `${home}/untitled.json`);
    if (!path) return;
    return write(path, { isNew: path !== doc.path });
  }
  if (isDirty()) return write(doc.path, {});
}

async function write(path, { isNew = false, force = false }) {
  const text = doc.root ? serialize(doc.root, indentUnit()) + "\n" : $("#fix-text").value;
  try {
    const { mtime } = await api("/api/file", {
      method: "PUT",
      body: JSON.stringify({ path, text, mtime: isNew ? null : doc.mtime, force }),
    });
    Object.assign(doc, { path, mtime });
    savedId = stateId;
    if (!doc.root) doc.fixSaved = text;
    showFile();
  } catch (err) {
    if (err.status === 409 && !force && confirm(`${err.message}\n\nOverwrite it with what's here?`)) return write(path, { isNew, force: true });
    if (err.status !== 409) alert(`Couldn't save: ${err.message}`);
  }
}

const isDirty = () => (doc.root ? stateId !== savedId : $("#fix-text").value !== doc.fixSaved);

function showFile() {
  const name = doc.path ? doc.path.split("/").pop() : "Untitled";
  $("#file-name").textContent = name;
  $("#file-dir").textContent = doc.path ? doc.path.slice(0, -name.length - 1).replace(home, "~") || "/" : "";
  $("#dirty").hidden = !isDirty();
  document.title = `${isDirty() ? "● " : ""}${name} — jsonedit`;
  $("#btn-undo").disabled = !undoStack.length;
  $("#btn-redo").disabled = !redoStack.length;
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
      tree.focus();
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
  try {
    await openFile(path);
  } catch (err) {
    alert(`Couldn't open ${path}: ${err.message}`);
  }
}

const indentUnit = () => ({ 2: "  ", 4: "    ", tab: "\t" })[$("#indent").value];

// Picks the indentation the file already uses.
function guessIndent(text) {
  const m = /\n([ \t]+)\S/.exec(text);
  if (m) $("#indent").value = m[1][0] === "\t" ? "tab" : m[1].length >= 4 ? "4" : "2";
}

// ---------------------------------------------------------------- a file that isn't JSON

function showFix(text) {
  tree.hidden = true;
  $("#fix").hidden = false;
  $("#fix-text").value = text;
  checkFix();
}

function checkFix() {
  const text = $("#fix-text").value;
  const { error } = parse(text);
  if (error) {
    const { line, column } = position(text, error.offset);
    $("#fix-error").textContent = `This isn't valid JSON, so it can't be shown as a tree yet. Line ${line}, column ${column}: ${error.message}`;
  } else {
    $("#fix-error").textContent = "Valid JSON now.";
  }
  $("#fix-apply").disabled = !!error;
}

$("#fix-text").addEventListener("input", () => {
  checkFix();
  showFile();
});
$("#fix-error").addEventListener("click", () => {
  const { error } = parse($("#fix-text").value);
  if (!error) return;
  $("#fix-text").focus();
  $("#fix-text").setSelectionRange(error.offset, error.offset + 1);
});
$("#fix-apply").addEventListener("click", () => {
  const text = $("#fix-text").value;
  const fixed = text !== doc.fixSaved;
  load(text);
  if (fixed) stateId = nextId++; // the fix isn't saved yet
  showFile();
});

// ---------------------------------------------------------------- changes and undo

function snapshot() {
  return {
    text: serialize(doc.root, ""),
    id: stateId,
    selected: selected && stepsTo(selected),
    open: [...expanded].filter(attached).map(stepsTo),
  };
}

function attached(node) {
  let n = node;
  while (n.parent) n = n.parent;
  return n === doc.root;
}

// Makes a change to the document: undoable, redrawn, marked unsaved.
function change(fn) {
  undoStack.push(snapshot());
  if (undoStack.length > 300) undoStack.shift();
  redoStack.length = 0;
  fn();
  stateId = nextId++;
  render();
  showFile();
}

function restore(snap) {
  doc.root = fromParse(snap.text, parse(snap.text).root);
  expanded.clear();
  for (const steps of snap.open) expanded.add(follow(doc.root, steps));
  selected = snap.selected ? follow(doc.root, snap.selected) : doc.root;
  stateId = snap.id;
  render();
  reveal(selected);
  showFile();
}

function undo() {
  if (!doc.root || !undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
}

function redo() {
  if (!doc.root || !redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}

// ---------------------------------------------------------------- the tree

function expandTo(node, depth) {
  if (!isContainer(node) || depth <= 0) return;
  expanded.add(node);
  node.children.forEach((c) => expandTo(c, depth - 1));
}

function render() {
  if (!doc.root) return;
  const scroll = tree.scrollTop;
  rowOf = new WeakMap();
  const frag = document.createDocumentFragment();
  addRows(frag, doc.root, 0);
  tree.replaceChildren(frag);
  tree.scrollTop = scroll;
  if (!selected || !attached(selected)) selected = doc.root;
  rowOf.get(selected)?.classList.add("selected");
  for (const node of matches) rowOf.get(node)?.classList.add("match");
  showWhere();
}

function addRows(frag, node, depth) {
  frag.append(makeRow(node, depth));
  if (!isContainer(node) || !expanded.has(node)) return;
  const limit = shown.get(node) ?? CHUNK;
  for (const c of node.children.slice(0, limit)) addRows(frag, c, depth + 1);
  if (node.children.length > limit) {
    const more = el("div", "row");
    more.style.paddingLeft = `${8 + (depth + 1) * INDENT + 20}px`;
    const link = el("span", "more", `… ${node.children.length - limit} more: show ${Math.min(CHUNK, node.children.length - limit)}`);
    link.onclick = () => {
      shown.set(node, limit + CHUNK);
      render();
    };
    more.append(link);
    frag.append(more);
  }
}

function makeRow(node, depth) {
  const row = el("div", "row");
  row.style.paddingLeft = `${8 + depth * INDENT}px`;
  row.node = node;
  rowOf.set(node, row);
  const container = isContainer(node);
  row.append(el("span", "toggle", container && node.children.length ? (expanded.has(node) ? "▾" : "▸") : ""));
  if (node.parent) {
    const member = node.parent.type === "object";
    row.append(el("span", member ? "key" : "key index", member ? JSON.stringify(node.key) : String(node.parent.children.indexOf(node))));
    row.append(el("span", "colon", ":"));
  }
  row.append(valueSpan(node));
  const actions = el("span", "actions");
  if (container) actions.append(button(node.type === "object" ? "+ key" : "+ item", "add", "Add one inside (Ctrl+Enter)"));
  actions.append(button("⋯", "menu", "More (right-click)"));
  row.append(actions);
  return row;
}

function valueSpan(node) {
  if (isContainer(node)) {
    const n = node.children.length;
    return el("span", "value count", node.type === "object" ? `{${n}}` : `[${n}]`);
  }
  const text = node.type === "string" ? JSON.stringify(node.value.length > 300 ? node.value.slice(0, 300) + "…" : node.value) : String(node.value);
  return el("span", `value ${node.type}`, text);
}

function el(tag, className, text = "") {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}

function button(text, action, title) {
  const b = el("button", "", text);
  b.dataset.action = action;
  b.title = title;
  b.tabIndex = -1;
  return b;
}

function select(node, { scroll = true } = {}) {
  if (!node) return;
  rowOf.get(selected)?.classList.remove("selected");
  selected = node;
  const row = rowOf.get(node);
  row?.classList.add("selected");
  if (scroll) row?.scrollIntoView({ block: "nearest" });
  showWhere();
  showCount();
}

// Opens the containers around `node` (and shows enough of big ones), then
// selects it.
function reveal(node) {
  let changed = false;
  for (let n = node; n.parent; n = n.parent) {
    if (!expanded.has(n.parent)) expanded.add(n.parent), changed = true;
    const i = n.parent.children.indexOf(n);
    if (i >= (shown.get(n.parent) ?? CHUNK)) shown.set(n.parent, Math.ceil((i + 1) / CHUNK) * CHUNK), changed = true;
  }
  if (changed) render();
  select(node, { scroll: false });
  rowOf.get(node)?.scrollIntoView({ block: "nearest" });
}

function toggle(node, open = !expanded.has(node)) {
  if (!isContainer(node) || !node.children.length) return;
  if (open) expanded.add(node);
  else expanded.delete(node);
  render();
}

function showWhere() {
  if (!selected) return;
  const n = selected.children?.length;
  const what = selected.type === "object" ? `object, ${n} key${n === 1 ? "" : "s"}` : selected.type === "array" ? `array, ${n} item${n === 1 ? "" : "s"}` : selected.type;
  $("#where").textContent = `${displayPath(selected)}  ·  ${what}`;
}

// The rows in order on screen, for the arrow keys.
const visibleRows = () => [...tree.children].filter((r) => r.node);

// ---------------------------------------------------------------- editing in place

let editing = null; // { node, commit }

/**
 * Turns the node's key ("key") or value ("value"; an object or array is edited
 * as JSON text) into a text field. Enter keeps it (Ctrl+Enter for multi-line
 * JSON), Esc doesn't, clicking elsewhere keeps it. `then` runs once it's kept.
 */
function edit(node, what, { then } = {}) {
  if (editing) editing.commit();
  if (!doc.root || (what === "key" && node.parent?.type !== "object")) return;
  const json = what === "value" && isContainer(node);
  reveal(node);
  const row = rowOf.get(node);
  const target = row.querySelector(what === "key" ? ".key" : ".value");
  const initial = what === "key" ? node.key : json ? serialize(node, indentUnit()) : editText(node);
  const multiline = json || initial.includes("\n");
  const input = document.createElement(what === "key" ? "input" : "textarea");
  input.className = `editor${json ? " block" : ""}`;
  input.spellcheck = false;
  input.value = initial;
  const hint = el("span", "hint");
  target.replaceWith(input);
  if (what !== "key") input.after(hint);
  const how = json ? "Ctrl+Enter to keep" : multiline ? "Shift+Enter for a new line" : "";

  const fit = () => {
    const lines = input.value.split("\n");
    input.style.width = `${Math.max(6, ...lines.map((l) => l.length + 2))}ch`;
    if (input.tagName === "TEXTAREA") input.rows = Math.min(lines.length, 30);
  };
  // Says what the text will become, as you type. False if it can't be kept.
  const check = () => {
    fit();
    let problem = null, becomes = "";
    if (what === "key") {
      if (node.parent.children.some((c) => c !== node && c.key === input.value)) problem = "there's already a key with this name";
    } else {
      const { node: value, error } = literal(input.value);
      if (error) problem = error;
      else becomes = `→ ${value.type}`;
    }
    input.classList.toggle("invalid", !!problem);
    hint.classList.toggle("invalid", !!problem);
    hint.textContent = problem ?? [becomes, how].filter(Boolean).join("  ·  ");
    input.title = problem ?? "";
    return !problem;
  };

  let done = false;
  const finish = (keep) => {
    if (done) return;
    if (keep && !check()) return void input.focus();
    done = true;
    editing = null;
    if (keep && input.value !== initial) {
      change(() => {
        if (what === "key") node.key = input.value;
        else replaceValue(node, literal(input.value).node);
      });
    } else {
      render();
    }
    tree.focus({ preventScroll: true });
    if (keep) then?.();
  };
  editing = { node, commit: () => finish(true) };

  input.addEventListener("input", check);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // typing isn't navigating
    const keep = e.key === "Tab" || (e.key === "Enter" && (json ? e.ctrlKey : !e.shiftKey));
    if (keep) {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    } else if (e.key === "Enter") {
      setTimeout(fit); // a new line: grow
    }
  });
  input.addEventListener("blur", () => setTimeout(() => finish(true)));
  check();
  input.focus();
  if (multiline) input.setSelectionRange(0, 0);
  else input.select();
}

// Gives `node` the type and value of `value`, keeping its key and place.
function replaceValue(node, value) {
  delete node.value;
  delete node.children;
  node.type = value.type;
  if (value.children) {
    node.children = value.children;
    for (const c of node.children) c.parent = node;
    expanded.add(node);
  } else {
    node.value = value.value;
  }
}

// ---------------------------------------------------------------- commands

// Adds a new item inside `container` (at `index`, default the end) and starts
// editing it: the key first in an object.
function addInside(container, index = container.children.length) {
  const child = { type: "string", value: "", parent: container };
  if (container.type === "object") child.key = freshKey(container);
  change(() => {
    container.children.splice(index, 0, child);
    expanded.add(container);
  });
  select(child);
  if (container.type === "object") edit(child, "key", { then: () => edit(child, "value") });
  else edit(child, "value");
}

// Adds a new item after `node` (inside it for the top level).
function addAfter(node) {
  if (!node.parent) return isContainer(node) && addInside(node);
  addInside(node.parent, node.parent.children.indexOf(node) + 1);
}

function remove(node) {
  if (!node.parent) return;
  const siblings = node.parent.children;
  const i = siblings.indexOf(node);
  change(() => siblings.splice(i, 1));
  select(siblings[i] ?? siblings[i - 1] ?? node.parent);
}

function duplicate(node) {
  if (!node.parent) return;
  const copy = clone(node, node.parent);
  if (node.parent.type === "object") copy.key = freshKey(node.parent, node.key);
  change(() => node.parent.children.splice(node.parent.children.indexOf(node) + 1, 0, copy));
  select(copy);
}

function move(node, by) {
  const siblings = node.parent?.children;
  if (!siblings) return;
  const i = siblings.indexOf(node), j = i + by;
  if (j < 0 || j >= siblings.length) return;
  change(() => {
    siblings.splice(i, 1);
    siblings.splice(j, 0, node);
  });
  select(node);
}

// Converts the value to another type, keeping what can be kept: a number from
// a string that is one, an array's items as an object's values (keys "0",
// "1", ...) and the other way round, a single value wrapped in an array.
function convert(node, type) {
  if (node.type === type) return;
  const items = isContainer(node) ? node.children.map((c) => clone(c)) : [clone(node)];
  const number = Number(node.value);
  const falsy = node.value === false || node.value === null || node.value === "" || node.value === "0" || node.value === "false" || node.children?.length === 0;
  let value;
  if (type === "string") value = { type, value: isContainer(node) ? serialize(node, "") : String(node.value) };
  else if (type === "number") value = { type, value: !isContainer(node) && node.value !== null && node.value !== "" && Number.isFinite(number) ? String(number) : "0" };
  else if (type === "boolean") value = { type, value: !falsy };
  else if (type === "null") value = { type, value: null };
  else if (type === "array") value = { type, children: items.map((c) => (delete c.key, c)) };
  else value = { type, children: items.map((c, i) => Object.assign(c, { key: node.type === "object" ? c.key : String(i) })) };
  change(() => replaceValue(node, value));
}

async function copy(node) {
  const text = serialize(node, indentUnit());
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    tree.focus();
  }
}

// Pasted text: JSON goes in as such, anything else as a string. It goes into
// a selected object or array that's open, empty or the top level, else after
// the selection. Pasted into an object, an object's members keep their keys;
// anything else gets a key to fill in.
function paste(text) {
  const { node: value, error } = literal(text);
  if (error) return alert(`The pasted text isn't valid JSON: ${error}`);
  const into = isContainer(selected) && (!selected.parent || !selected.children.length || expanded.has(selected));
  const container = into ? selected : selected.parent;
  if (!container) return; // the whole document is a single value
  let index = into ? container.children.length : container.children.indexOf(selected) + 1;
  const items = container.type === "object" && value.type === "object" ? value.children : [value];
  change(() => {
    for (const item of items) {
      item.parent = container;
      if (container.type === "object") item.key = freshKey(container, item.key ?? "key");
      else delete item.key;
      container.children.splice(index++, 0, item);
    }
    expanded.add(container);
  });
  select(items.at(-1));
  if (container.type === "object" && value.type !== "object") edit(items[0], "key");
}

// ---------------------------------------------------------------- mouse

tree.addEventListener("mousedown", (e) => {
  const row = e.target.closest(".row");
  if (!row?.node || e.target.closest(".editor")) return;
  hideMenu();
  select(row.node, { scroll: false });
});

tree.addEventListener("click", (e) => {
  const node = e.target.closest(".row")?.node;
  if (!node || e.target.closest(".editor")) return;
  const action = e.target.closest("button")?.dataset.action;
  if (action === "add") return addInside(node);
  if (action === "menu") {
    const r = e.target.getBoundingClientRect();
    return showMenu(r.left, r.bottom, node);
  }
  if (e.target.classList.contains("toggle")) return toggle(node);
  if (!e.target.closest(".value") || isContainer(node)) return tree.focus({ preventScroll: true });
  if (node.type === "boolean") return change(() => (node.value = !node.value));
  edit(node, "value");
});

tree.addEventListener("dblclick", (e) => {
  const node = e.target.closest(".row")?.node;
  if (!node || e.target.closest(".editor, button")) return;
  if (e.target.closest(".key:not(.index)")) return edit(node, "key");
  if (isContainer(node)) toggle(node);
});

tree.addEventListener("contextmenu", (e) => {
  const node = e.target.closest(".row")?.node;
  if (!node || e.target.closest(".editor")) return;
  e.preventDefault();
  select(node, { scroll: false });
  showMenu(e.clientX, e.clientY, node);
});

// ---------------------------------------------------------------- menu

const TYPES = ["string", "number", "boolean", "null", "object", "array"];

function showMenu(x, y, node) {
  const container = isContainer(node);
  const items = [
    ["Edit value", container ? "" : "Enter", () => edit(node, "value")],
    node.parent?.type === "object" && ["Rename key", "F2", () => edit(node, "key")],
    container && [node.type === "object" ? "Add key" : "Add item", "Ctrl+Enter", () => addInside(node)],
    node.parent && ["Add after", "Insert", () => addAfter(node)],
    node.parent && ["Duplicate", "Ctrl+D", () => duplicate(node)],
    node.parent && ["Move up", "Ctrl+↑", () => move(node, -1)],
    node.parent && ["Move down", "Ctrl+↓", () => move(node, 1)],
    "-",
    ["Copy as JSON", "Ctrl+C", () => copy(node)],
    ["Copy path", "", () => navigator.clipboard.writeText(displayPath(node)).catch(() => {})],
    container && node.children.length && ["Expand everything inside", "*", () => (expandTo(node, Infinity), render())],
    "-",
    { label: "Change type to" },
    ...TYPES.filter((t) => t !== node.type).map((t) => [t, "", () => convert(node, t)]),
    node.parent && "-",
    node.parent && ["Delete", "Del", () => remove(node)],
  ].filter(Boolean);
  menu.replaceChildren(...items.map((item) => {
    if (item === "-") return document.createElement("hr");
    if (item.label) return el("div", "label", item.label);
    const [label, shortcut, action] = item;
    const b = el("button", "");
    b.append(el("span", "", label), el("span", "shortcut", shortcut));
    b.onclick = () => {
      hideMenu();
      action();
    };
    return b;
  }));
  menu.hidden = false;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - height - 4))}px`;
}

function hideMenu() {
  menu.hidden = true;
}
document.addEventListener("mousedown", (e) => !menu.contains(e.target) && hideMenu());

// ---------------------------------------------------------------- keys

tree.addEventListener("keydown", (e) => {
  if (editing || !selected || e.target !== tree) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const rows = visibleRows();
  const i = rows.indexOf(rowOf.get(selected));
  const go = (j) => select(rows[Math.max(0, Math.min(rows.length - 1, j))]?.node);
  const page = Math.max(1, Math.floor(tree.clientHeight / 24) - 1);
  const node = selected, k = e.key;
  if (ctrl && k === "ArrowUp") move(node, -1);
  else if (ctrl && k === "ArrowDown") move(node, 1);
  else if (k === "ArrowUp") go(i - 1);
  else if (k === "ArrowDown") go(i + 1);
  else if (k === "PageUp") go(i - page);
  else if (k === "PageDown") go(i + page);
  else if (k === "Home") go(0);
  else if (k === "End") go(rows.length - 1);
  else if (k === "ArrowLeft") expanded.has(node) && node.children.length ? toggle(node, false) : select(node.parent);
  else if (k === "ArrowRight") isContainer(node) && node.children.length && (expanded.has(node) ? select(node.children[0]) : toggle(node, true));
  else if (ctrl && k === "Enter") isContainer(node) ? addInside(node) : addAfter(node);
  else if (k === "Enter") isContainer(node) ? toggle(node) : edit(node, "value");
  else if (k === "F2") node.parent?.type === "object" ? edit(node, "key") : !isContainer(node) && edit(node, "value");
  else if (k === " ") node.type === "boolean" ? change(() => (node.value = !node.value)) : toggle(node);
  else if (k === "Insert") addAfter(node);
  else if (k === "Delete" || k === "Backspace") remove(node);
  else if (ctrl && k.toLowerCase() === "d") duplicate(node);
  else if (ctrl && k.toLowerCase() === "c") copy(node);
  else if (ctrl && k.toLowerCase() === "x") node.parent && (copy(node), remove(node));
  else if (k === "*") isContainer(node) && (expandTo(node, Infinity), render());
  else if (k === "ContextMenu") {
    const r = rowOf.get(node).getBoundingClientRect();
    showMenu(r.left + 40, r.bottom, node);
  } else return;
  e.preventDefault();
});

document.addEventListener("paste", (e) => {
  if (editing || !doc.root || e.target.closest?.("input, textarea")) return;
  e.preventDefault();
  paste(e.clipboardData.getData("text/plain"));
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideMenu();
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === "s") save({ as: e.shiftKey });
  else if (key === "o") openDialog();
  else if (key === "f") $("#search").focus(), $("#search").select();
  else if (e.target.closest?.("input, textarea")) return; // a field's own undo
  else if (key === "z" && !e.shiftKey) undo();
  else if ((key === "z" && e.shiftKey) || key === "y") redo();
  else return;
  e.preventDefault();
});

// ---------------------------------------------------------------- search

// Keys and values containing the search text (any case); Enter goes to the
// next one, Shift+Enter the previous.
let matches = [];

function findMatches(query) {
  const q = query.toLowerCase();
  const out = [];
  const walk = (node) => {
    const text = isContainer(node) ? "" : String(node.value).toLowerCase();
    if ((node.key ?? "").toLowerCase().includes(q) || text.includes(q)) out.push(node);
    node.children?.forEach(walk);
  };
  if (q && doc.root) walk(doc.root);
  return out;
}

function showCount() {
  const q = $("#search").value;
  const i = matches.indexOf(selected);
  $("#search-count").textContent = !q ? "" : !matches.length ? "none" : i === -1 ? `${matches.length}` : `${i + 1} of ${matches.length}`;
}

$("#search").addEventListener("input", () => {
  matches = findMatches($("#search").value);
  render();
  if (matches.length) reveal(matches[0]);
  showCount();
});
$("#search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    $("#search").value = "";
    matches = [];
    render();
    showCount();
    tree.focus();
  } else if (e.key === "Enter" && matches.length) {
    const i = matches.indexOf(selected);
    reveal(matches[(i + (e.shiftKey ? -1 : 1) + matches.length) % matches.length]);
  } else if (e.key === "ArrowDown") {
    tree.focus();
  } else return;
  e.preventDefault();
});

// ---------------------------------------------------------------- buttons

$("#btn-open").onclick = openDialog;
$("#btn-save").onclick = () => save();
$("#btn-undo").onclick = undo;
$("#btn-redo").onclick = redo;
$("#indent").addEventListener("change", () => {
  try {
    localStorage.setItem("indent", $("#indent").value);
  } catch { /* storage unavailable */ }
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
    load("{}");
  }
} else {
  load("{}");
}
