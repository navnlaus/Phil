import { appUrl, clipboardKey, closeWindow, copyText, embedOf, holdFocus, ready } from "/engine/ui/kit.js";
import { isFocusKey, isToggleKey, shellQuote, TerminalPanel } from "/ui/terminal.js";

const $ = (sel) => document.querySelector(sel);
const grid = $("#grid");
const crumbs = $("#crumbs");
const locationInput = $("#location");
const filterInput = $("#filter");
const sortSelect = $("#sort");
const hiddenButton = $("#btn-hidden");
const zoomInput = $("#zoom");
const viewerEl = $("#viewer");
const stage = viewerEl.querySelector(".stage");
const contextMenu = $("#context");

const KIND_ICON = { dir: "folder", image: "image", video: "video", pdf: "file", file: "file" };
// How names and details sit on the tiles: a theme, ~/.config/phil/themes/<theme>.css
// (engine/themes.js). Chosen with "theme" in ~/.config/phil/settings.json; phil
// only reads it.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const state = {
  init: null,
  path: null,
  entries: [], // everything in the folder, from the server
  view: [], // filtered + sorted, what the grid shows
  selected: -1, // index into view: the keyboard cursor
  marked: new Set(), // paths of the selected entries (one or more)
  anchor: -1, // where Shift+click / Shift+arrow ranges start
  settings: { sort: "name", showHidden: false, zoom: 224, sidebar: false, termHeight: 260, termOpen: false, theme: "overlay" },
};
const tiles = new Map(); // path -> tile element
const scrollPositions = new Map(); // path -> scrollTop, restored on back/up

// ---------------------------------------------------------------- helpers

const icon = (name, cls = "") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const fileUrl = (path) => `/file?path=${encodeURIComponent(path)}`;
const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");
const parentOf = (path) => (path === "/" ? null : path.replace(/\/[^/]+$/, "") || "/");
const hasThumb = (e) => e.kind === "image" || e.kind === "video" || e.kind === "pdf"; // a PDF's: its first page

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function formatDate(ms) {
  return ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json();
}

const openExternal = (path, app) =>
  api("/api/open", { method: "POST", body: JSON.stringify({ path, app }) }).catch((err) => alert(err.message));

let saveTimer;
function saveSettings(delay = 400) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch("/api/settings", { method: "PUT", body: JSON.stringify(state.settings) });
  }, delay);
}

// ---------------------------------------------------------------- thumbnails

// Thumbnails that aren't cached yet are requested over one WebSocket, so the
// browser's per-host connection limit doesn't cap how many generate in parallel.
// So are summaries for folder tiles (see src/folders.js). Tiles scrolling out
// of view cancel their request. The server also sends {theme} when the theme
// in the settings file changes.
const thumbs = {
  ws: null,
  wanted: new Set(), // files and folders waiting for an answer
  folders: new Set(), // the folders among them
  outWant: new Set(),
  outFolders: new Set(),
  outCancel: new Set(),
  scheduled: false,
  watching: null, // the folder the server watches for us

  connect() {
    this.ws = new WebSocket(`ws://${location.host}/ws`);
    this.ws.onopen = () => {
      this.wanted.forEach((p) => (this.folders.has(p) ? this.outFolders : this.outWant).add(p));
      if (this.watching) this.watch(this.watching);
      if (this.tagging) this.tag(this.tagging);
      if (this.totals.size) this.send({ totals: [...this.totals] }); // asked for before the connection was up
      this.totals.clear();
      this.flush();
    };
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if ("theme" in msg) return setTheme(msg.theme);
      if ("changed" in msg) return onFolderChanged(msg);
      if ("tagged" in msg) return onTagged(msg);
      if ("searched" in msg) return onSearched(msg);
      if ("totalOf" in msg) return onFolderTotal(msg.totalOf, msg.bytes);
      if (msg.hook) return onHookRan(msg.hook);
      const path = msg.folder ?? msg.path;
      if (!this.wanted.delete(path)) return;
      this.folders.delete(path);
      if (msg.folder) onFolderSummary(path, msg.summary);
      else if ("text" in msg) onTextReady(path, msg.text);
      else onThumbReady(path, msg.url);
      updateProgress();
    };
    this.ws.onclose = () => setTimeout(() => this.connect(), 1000);
  },
  want(path, { folder = false } = {}) {
    if (this.wanted.has(path)) return;
    this.wanted.add(path);
    if (folder) this.folders.add(path);
    this.outCancel.delete(path);
    (folder ? this.outFolders : this.outWant).add(path);
    this.schedule();
  },
  cancel(path) {
    if (!this.wanted.delete(path)) return;
    this.folders.delete(path);
    if (!this.outWant.delete(path) && !this.outFolders.delete(path)) this.outCancel.add(path);
    this.schedule();
  },
  watch(path) {
    this.watching = path;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ watch: path }));
  },
  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  },
  // Folders' total sizes (foldertotals.js), answered with {totalOf, bytes}.
  totals: new Set(),
  wantTotals(paths) {
    if (this.ws?.readyState === WebSocket.OPEN) this.send({ totals: paths });
    else paths.forEach((p) => this.totals.add(p));
  },
  // Auto-tagging: the folder whose pictures to tag (null: none).
  tag(path) {
    this.tagging = path;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ tag: path }));
  },
  schedule() {
    updateProgress();
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => this.flush());
  },
  flush() {
    this.scheduled = false;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (!this.outWant.size && !this.outFolders.size && !this.outCancel.size) return;
    // The server works through requests last-in-first-out, so send the top of the screen last.
    this.ws.send(JSON.stringify({
      cancel: [...this.outCancel],
      want: [...this.outWant].reverse(),
      folders: [...this.outFolders],
      sort: state.settings.sort,
    }));
    this.outWant.clear();
    this.outFolders.clear();
    this.outCancel.clear();
  },
};

// Thumbnails and folder summaries load a bit ahead of the viewport. Pending
// requests are cancelled as soon as a tile leaves that zone, but loaded images
// are only dropped once they are far away, so scrolling back and forth doesn't
// re-decode them.
const observe = (margin, fn) =>
  new IntersectionObserver((records) => {
    for (const { target, isIntersecting } of records) {
      const entry = state.view[target.dataset.index];
      if (entry) fn(target, entry, isIntersecting);
    }
  }, { root: grid, rootMargin: `${margin}px 0px` });

const nearObserver = observe(800, (tile, entry, near) => {
  if (near && entry.kind === "dir") return drawFolderTexts(tile), wantSummary(tile, entry), wantTotal(entry);
  if (near) return entry.kind === "file" ? showText(tile, entry) : showThumb(tile, entry);
  if (thumbs.wanted.has(entry.path)) {
    tile.firstElementChild.classList.remove("loading");
    thumbs.cancel(entry.path);
  }
});
const farObserver = observe(4000, (tile, entry, inRange) => {
  if (!inRange && hasThumb(entry)) unloadThumb(tile);
  if (!inRange && entry.kind === "file") tile.firstElementChild.querySelector("canvas")?.remove(); // its pixels, not its text
});

// A folder's summary is out of date when the folder changed since, or the view
// is sorted differently (its previews are its first images in that order).
function wantSummary(tile, entry) {
  const s = entry.summary;
  const upToDate = s && s.mtime === entry.mtime && s.sort === state.settings.sort && s.complete && !changedFolders.has(entry.path);
  if (entry.summaryFailed || upToDate) return;
  if (!s) tile.firstElementChild.classList.add("loading");
  thumbs.want(entry.path, { folder: true });
}

function onFolderSummary(path, summary) {
  const tile = tiles.get(path);
  if (!tile) return;
  const entry = state.view[tile.dataset.index];
  tile.firstElementChild.classList.remove("loading");
  if (!summary) return void (entry.summaryFailed = true); // e.g. no permission: don't ask again
  entry.summary = summary;
  entry.mtime = summary.mtime;
  changedFolders.delete(path);
  showFolderInfo(tile, entry);
  drawFolderTexts(tile);
}

// A folder's total size, with its subfolders' (foldertotals.js): asked for
// once its tile is near the view, unless the one known is recent.
const wantTotal = (entry) => wantTotals([entry]);

function wantTotals(entries) {
  const asked = entries.filter((e) => !(e.total && !e.total.stale) && !e.totalAsked);
  for (const e of asked) e.totalAsked = true;
  if (asked.length) thumbs.wantTotals(asked.map((e) => e.path));
}

function onFolderTotal(path, bytes) {
  const tile = tiles.get(path);
  const entry = tile && state.view[tile.dataset.index];
  if (entry?.path !== path) return;
  entry.total = bytes === null ? { failed: true } : { bytes, stale: false };
  if (entry.summary) showFolderInfo(tile, entry);
  if (state.settings.sort === "size") resortSoon();
}

// Sorted by size, folders move as their totals come in: once they stop for a moment.
function resortSoon() {
  clearTimeout(resortSoon.timer);
  resortSoon.timer = setTimeout(() => (renaming ? resortSoon() : render()), 300); // moving a tile being renamed would end that
}

function showThumb(tile, entry) {
  const box = tile.firstElementChild;
  if (typeof entry.thumb === "string") return setThumbImage(box, entry.thumb);
  if (entry.thumb === null) {
    box.classList.add("loading");
    thumbs.want(entry.path);
  }
}

function unloadThumb(tile) {
  const box = tile.firstElementChild;
  box.classList.remove("has-img");
  box.querySelector("img")?.remove(); // let far-away tiles drop their decoded images
}

function setThumbImage(box, url) {
  if (box.querySelector("img")) return;
  const img = new Image();
  img.decoding = "sync"; // small JPEGs: decoding while painting beats drawing an empty tile first
  img.alt = "";
  img.draggable = false; // dragging over thumbnails draws a selection rectangle instead
  img.onload = () => box.classList.add("has-img");
  img.src = url;
  box.prepend(img);
}

function onThumbReady(path, url) {
  const tile = tiles.get(path);
  if (!tile) return;
  state.view[tile.dataset.index].thumb = url;
  const box = tile.firstElementChild;
  box.classList.remove("loading");
  if (url) setThumbImage(box, url);
}

// ---------------------------------------------------------------- text files

// Other files that turn out to be text show their text, scaled to the file:
// a short file in readable type, a longer one smaller to fit more of it (down
// to type too small to read, drawn as bars; the rest is cut off). Markdown
// headings stay large enough to read either way. The text is kept on the tile's box; its canvas is dropped when far away
// and redrawn when tiles change size.
function showText(tile, entry) {
  const box = tile.firstElementChild;
  if (box.text) return box.querySelector(":scope > canvas") || drawText(box);
  if (box.text === null) return; // not text
  box.classList.add("loading");
  thumbs.want(entry.path);
}

function onTextReady(path, text) {
  const tile = tiles.get(path);
  if (!tile) return;
  const box = tile.firstElementChild;
  box.classList.remove("loading");
  box.text = text;
  if (text) drawText(box);
}

const HEADING = { h1: [2.2, 9], h2: [1.8, 7.5], h3: [1.5, 6.5], h4: [1.3, 6], h5: [1.15, 6], h6: [1.1, 6] }; // [× body size, minimum px]
const LINE_HEIGHT = 1.3;
const MIN_BODY = 1.6; // px, and at least a third of full width size: smaller leaves long files a grey haze

// Draws `box.text` on a canvas filling `box`: a file tile's thumbnail box, or
// a cell of a folder's face.
function drawText(box) {
  const { lines, prose } = box.text;
  const w = box.clientWidth, h = box.clientHeight;
  if (!w || !h) return;
  const dpr = devicePixelRatio || 1;
  const canvas = box.querySelector(":scope > canvas") ?? box.insertAdjacentElement("afterbegin", document.createElement("canvas"));
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  box.classList.add("has-text");

  const pad = Math.max(3, w * 0.04);
  const charW = prose ? 0.5 : 0.6; // average character width, in ems
  const sizeOf = (kind, body) => (HEADING[kind] ? Math.max(body * HEADING[kind][0], HEADING[kind][1]) : body);
  const rowOf = (kind, body) => (kind === "tsep" ? body * 0.6 : sizeOf(kind, body) * LINE_HEIGHT); // a table's header rule is a thin line
  const height = (body) => lines.reduce((sum, [kind]) => sum + rowOf(kind, body), 0);
  // As large as fits: at most 11px, and narrow enough for the typical line.
  const widths = lines.map(([, t]) => t.trimEnd().length).filter(Boolean).sort((a, b) => a - b);
  const cols = Math.max(30, Math.min(100, widths[Math.floor(widths.length * 0.9)] ?? 30));
  let body = Math.min(11, (w - 2 * pad) / (cols * charW));
  if (height(body) > h - pad) { // shrink to fit, down to the minimum
    let lo = Math.min(Math.max(MIN_BODY, body / 3), body), hi = body;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (height(mid) > h - pad) hi = mid;
      else lo = mid;
    }
    body = lo;
  }

  const css = getComputedStyle(box);
  const strong = css.getPropertyValue("--text").trim(), dim = css.getPropertyValue("--text-dim").trim();
  const colors = {}; // syntax roles (engine/ui/syntax.js) to --s-* colors
  const colorOf = (role, plain) => (role ? (colors[role] ??= css.getPropertyValue(`--s-${role}`).trim() || plain) : plain);
  const family = prose ? "system-ui, sans-serif" : "ui-monospace, monospace";
  // Code and configs are highlighted (once the worker has answered); prose
  // (Markdown, plain text) looks like a document instead.
  const runs = prose ? null : box.text.runs;
  if (!prose && !runs) highlightText(box);
  // Markdown tables: their cells in columns, as wide as each column's widest
  // cell; the header (the row over the "|---|" line) bold, the line a rule.
  const tables = new Map(); // a table row's index -> { cols: x of each column, width, header }
  if (prose) {
    ctx.font = `400 ${body}px ${family}`;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i][0].startsWith("t")) continue;
      const start = i;
      while (i < lines.length && lines[i][0].startsWith("t")) i++;
      const rows = lines.slice(start, i).map(([kind, t]) => (kind === "tr" ? cellsOf(t) : null));
      const widths = [];
      rows.forEach((cells) => cells?.forEach((c, j) => (widths[j] = Math.max(widths[j] ?? 0, ctx.measureText(c).width * 1.1)))); // bold is wider
      const gap = body * 1.4, cols = [];
      let x = pad;
      for (const cw of widths) cols.push(x), (x += cw + gap);
      rows.forEach((cells, k) => tables.set(start + k, { cells, cols, width: x - gap - pad, header: lines[start + k + 1]?.[0] === "tsep" }));
    }
  }
  let y = pad * 0.6;
  lines.forEach(([kind, text], i) => {
    const size = sizeOf(kind, body);
    y += rowOf(kind, body);
    if (y - size > h || !text.trim()) return;
    const table = tables.get(i);
    if (table) return drawRow(table, y, size);
    const heading = !!HEADING[kind];
    const plain = heading ? strong : dim;
    let line = runs?.[i] ?? [[text, null]];
    if (heading) line = [[text.replace(/^\s*#+\s*/, ""), null]]; // drawn large and bold instead of with its #
    ctx.globalAlpha = kind === "c" && !runs ? 0.55 : heading ? 1 : 0.9;
    if (size * dpr >= 3) {
      ctx.font = `${heading ? 700 : 400} ${size}px ${family}`;
      let x = pad;
      for (const [part, role] of line) {
        ctx.fillStyle = colorOf(role, plain);
        ctx.fillText(part, x, y - size * 0.3);
        x += ctx.measureText(part).width;
        if (x > w) break;
      }
    } else { // too small for letters: a bar for each run of words, in its color
      ctx.globalAlpha *= 0.8;
      const cw = size * charW;
      let col = 0;
      for (const [part, role] of line) {
        ctx.fillStyle = colorOf(role, plain);
        for (const m of part.matchAll(/\S+(?: \S+)*/g)) ctx.fillRect(pad + (col + m.index) * cw, y - size, m[0].length * cw, size * 0.75);
        col += part.length;
      }
    }
  });

  function drawRow({ cells, cols, width, header }, y, size) {
    if (!cells) { // the rule under the header
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = dim;
      ctx.fillRect(pad, y - size * 0.35, width, Math.max(0.5, size * 0.08));
      return;
    }
    ctx.globalAlpha = header ? 1 : 0.9;
    ctx.fillStyle = header ? strong : dim;
    cells.forEach((cell, j) => {
      if (cols[j] > w) return;
      if (size * dpr >= 3) {
        ctx.font = `${header ? 700 : 400} ${size}px ${family}`;
        ctx.fillText(cell, cols[j], y - size * 0.3);
      } else if (cell) ctx.fillRect(cols[j], y - size, cell.length * size * charW, size * 0.75);
    });
  }
}

// A Markdown table row's cells: "| a | b |" -> ["a", "b"] (an escaped \| stays).
const cellsOf = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));

// Text tiles are drawn plain at once, and again in color when the syntax
// worker (engine/ui/syntax-worker.js) has highlighted them, in the background.
const syntaxWorker = new Worker("/engine/ui/syntax-worker.js", { type: "module" });
const highlighting = new Map(); // request id -> { text, boxes }
let highlightId = 0;

function highlightText(box) {
  const text = box.text;
  for (const job of highlighting.values()) {
    if (job.text === text) return void job.boxes.add(box); // already asked
  }
  highlighting.set(++highlightId, { text, boxes: new Set([box]) });
  syntaxWorker.postMessage({ id: highlightId, runs: true, path: text.name ?? "", text: text.lines.map(([, t]) => t).join("\n") });
}

syntaxWorker.onmessage = (e) => {
  const job = highlighting.get(e.data.id);
  highlighting.delete(e.data.id);
  if (!job) return;
  job.text.runs = e.data.runs;
  for (const box of job.boxes) if (box.isConnected && box.text === job.text && box.querySelector(":scope > canvas")) drawText(box);
};

// Tiles change size with the window, and the zoom, theme and sidebar
// (applySettings).
let redrawTimer;
function redrawTexts() {
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(() => {
    for (const tile of tiles.values()) {
      for (const box of [tile.firstElementChild, ...tile.querySelectorAll(".face > .cell")]) {
        if (box.text && box.querySelector(":scope > canvas")) drawText(box);
      }
    }
  }, 150);
}
new ResizeObserver(redrawTexts).observe(grid);

// ---------------------------------------------------------------- navigation

function navigate(path) {
  const hash = "#" + encodePath(path);
  if (location.hash === hash) load(path);
  else location.hash = hash;
}

addEventListener("hashchange", () => load(decodeURIComponent(location.hash.slice(1))));

async function load(path) {
  if (state.path) scrollPositions.set(state.path, grid.scrollTop);
  const previous = state.path;
  let listing;
  try {
    listing = await api(`/api/list?path=${encodeURIComponent(path)}&sort=${state.settings.sort}`);
  } catch (err) {
    showGridMessage(`Can't open ${path}: ${err.message}`);
    return;
  }
  state.path = listing.path;
  terminal.follow(listing.path);
  state.entries = listing.entries;
  if (previous !== listing.path) changedFolders.clear(), autoTags.clear(), tagFilter.clear(), carried.clear(), searchScores.clear();
  state.autoTagged = !!listing.autoTags;
  thumbs.watch(listing.path);
  thumbs.tag(state.autoTagged ? listing.path : null);
  showTagStatus("");
  renderTags();
  document.title = (listing.path === "/" ? "/" : listing.path.split("/").pop()) + (state.init.incognito ? " — phil (incognito)" : " — phil");
  renderCrumbs();
  renderPlaces();
  $("#btn-up").disabled = !listing.parent;
  filterInput.value = "";

  // Coming up from a child folder: select it, like other file managers do.
  const selectPath = previous && parentOf(previous) === listing.path ? previous : null;
  render(selectPath);
  grid.scrollTop = selectPath ? grid.scrollTop : scrollPositions.get(listing.path) ?? 0;
  if (selectPath) tiles.get(selectPath)?.scrollIntoView({ block: "center" });
  // Don't steal focus from the terminal when the view follows a `cd` typed there.
  if (!document.activeElement?.closest("#term-panel")) grid.focus({ preventScroll: true });
  if (restoreTerminal) {
    restoreTerminal = false;
    setTerminalOpen(true, { focus: false });
  }
  if (initialSelect) { // files given on the command line, e.g. from "Show in folder"
    const indexes = initialSelect.map((p) => state.view.findIndex((e) => e.path === p)).filter((i) => i !== -1);
    initialSelect = null;
    if (indexes.length) {
      select(indexes[0], { scroll: false });
      setMarked(indexes.map((i) => state.view[i].path));
      updateStatus();
      tiles.get(state.view[indexes[0]].path).scrollIntoView({ block: "center" });
    }
  }
}

// ---------------------------------------------------------------- live updates

// The server watches the shown folder (see watchFolder in src/server.js). When
// something in it changes, the listing is read again and the grid updated in
// place: scroll position, selection and unchanged tiles stay. Subfolders whose
// contents changed get their tiles' summaries read again.
const changedFolders = new Set();
let refreshing = null;
let refreshAgain = false;
let refreshLater = null;

function onFolderChanged({ changed, folders }) {
  for (const path of folders) {
    changedFolders.add(path);
    const tile = tiles.get(path);
    if (tile) wantSummary(tile, state.view[tile.dataset.index]);
  }
  if (changed === state.path) refresh();
}

async function refresh() {
  if (refreshing) return void (refreshAgain = true);
  // Not while renaming, dragging or viewing (the viewer goes by position in
  // the list): try again in a moment.
  if (renaming || band?.active || drag?.active || !viewerEl.hidden) {
    refreshLater ??= setTimeout(() => (refreshLater = null, refresh()), 700);
    return;
  }
  const path = state.path;
  refreshing = api(`/api/list?path=${encodeURIComponent(path)}&sort=${state.settings.sort}`).catch(() => null);
  const listing = await refreshing;
  refreshing = null;
  if (listing && state.path === path && !renaming) {
    state.entries = listing.entries;
    const top = grid.scrollTop;
    render();
    grid.scrollTop = top;
    thumbs.watch(path); // new subfolders get watched too
    state.autoTagged = !!listing.autoTags;
    renderTags();
    thumbs.tag(state.autoTagged ? path : null); // new pictures get tagged (the rest come from the cache)
  } else if (!listing && state.path === path) {
    showGridMessage(`${path} is gone.`);
  }
  if (refreshAgain) {
    refreshAgain = false;
    refresh();
  }
}

// Folders first, then files, each in the chosen order. By size, a folder
// goes by everything in it (its total; until that's known, its files').
function sortEntries(list) {
  const by = {
    name: (a, b) => collator.compare(a.name, b.name),
    mtime: (a, b) => b.mtime - a.mtime,
    size: (a, b) => sizeOf(b) - sizeOf(a),
    kind: (a, b) => collator.compare(a.kind, b.kind) || collator.compare(ext(a.name), ext(b.name)),
  }[state.settings.sort];
  const ext = (name) => name.slice(name.lastIndexOf(".") + 1);
  list.sort((a, b) => folderFirst(a, b) || by(a, b) || collator.compare(a.name, b.name));
}

const folderFirst = (a, b) => (b.kind === "dir") - (a.kind === "dir");
const sizeOf = (e) => (e.kind === "dir" ? e.total?.bytes ?? e.summary?.size ?? 0 : e.size);

function render(selectPath = state.view[state.selected]?.path) {
  const q = filterInput.value.trim().toLowerCase();
  const named = (e) => e.name.toLowerCase().includes(q);
  state.view = state.entries.filter((e) =>
    (state.settings.showHidden || !e.name.startsWith(".")) && (!q || named(e) || searchScores.has(e.path)) &&
    (!tagFilter.size || [...tagFilter].every((t) => tagsOf(e).includes(t)))
  );
  sortEntries(state.view);
  // Searching a tagged folder: what has it in its name first, then the
  // pictures that look like it, best first.
  if (q && searchScores.size) state.view.sort((a, b) => folderFirst(a, b) || (named(b) ? 2 : searchScores.get(b.path) ?? 0) - (named(a) ? 2 : searchScores.get(a.path) ?? 0));
  // By size, every folder's total is wanted, not just those in view: they decide the order.
  if (state.settings.sort === "size") wantTotals(state.view.filter((e) => e.kind === "dir"));

  nearObserver.disconnect();
  farObserver.disconnect();
  // Tiles of entries that haven't changed are kept, with their loaded images.
  // Their text is drawn again: WebKitGTK blanks a canvas taken out of the page
  // and put back.
  const old = new Map(tiles);
  tiles.clear();
  const frag = document.createDocumentFragment();
  const redraw = [];
  state.view.forEach((entry, i) => {
    let tile = old.get(entry.path);
    if (tile?.dataset.sig === tileSig(entry) && !tile.classList.contains("renaming")) {
      tile.dataset.index = i;
      tile.classList.remove("selected");
      if (entry.kind === "dir") showFolderInfo(tile, entry);
      if (tile.querySelector("canvas")) redraw.push(tile);
      old.delete(entry.path);
    } else {
      tile = makeTile(entry, i);
    }
    tiles.set(entry.path, tile);
    frag.append(tile);
  });
  for (const path of old.keys()) thumbs.cancel(path);
  grid.replaceChildren(frag);
  for (const tile of redraw) {
    for (const canvas of tile.querySelectorAll("canvas")) {
      const box = canvas.parentElement;
      canvas.remove();
      drawText(box);
    }
  }
  if (!state.view.length) showGridMessage(q ? "No matches" : "This folder is empty");
  for (const tile of tiles.values()) {
    nearObserver.observe(tile);
    farObserver.observe(tile);
  }

  state.selected = -1;
  const marked = state.marked;
  state.marked = new Set();
  const idx = state.view.findIndex((e) => e.path === selectPath);
  if (idx !== -1) select(idx, { scroll: false });
  if (marked.size > 1) setMarked([...marked].filter((p) => tiles.has(p))); // survive re-sort/filter
  updateStatus();
}

// The extension, if the name has a short one ("md", "json"; not "tar.gz"'s "tar").
function fileType(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && name.length - dot <= 6 ? name.slice(dot + 1) : "";
}

// A tile is rebuilt when its file changed; a folder's tile is updated in place.
const tileSig = (e) => (e.kind === "dir" ? "dir" : `${e.kind} ${e.size} ${e.mtime} ${e.onChange ?? ""} ${e.writable} ${e.target} ${e.description ?? ""} ${e.tags ?? ""}`);

function makeTile(entry, index) {
  const tile = document.createElement("div");
  tile.className = `tile ${entry.kind}${entry.name.startsWith(".") ? " hidden-file" : ""}`;
  tile.dataset.index = index;
  tile.dataset.sig = tileSig(entry);

  const box = document.createElement("div");
  box.className = "thumb";
  if (entry.kind !== "dir") {
    box.innerHTML = icon(KIND_ICON[entry.kind], "kind");
    if ((entry.kind === "file" || entry.kind === "pdf") && fileType(entry.name)) { // under the icon, until text or a thumbnail covers it
      const ext = document.createElement("span");
      ext.className = "ext";
      ext.textContent = fileType(entry.name);
      box.append(ext);
    }
  }

  // Name, and what it is: size and date for files, contents for folders.
  const label = document.createElement("div");
  label.className = "label";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = entry.name;
  const meta = document.createElement("span");
  meta.className = "meta";
  const desc = document.createElement("span");
  desc.className = "desc";
  label.append(desc, name, meta);
  tile.append(box, label);
  if (entry.kind === "dir") showFolderInfo(tile, entry);
  else {
    meta.textContent = [fileType(entry.name).toUpperCase(), formatSize(entry.size), formatShortDate(entry.mtime)].filter(Boolean).join(" · ");
    tile.title = fileTitle(entry);
    showMarks(tile, entry);
  }
  return tile;
}

// What a tile shows besides its name and details: its description (from
// Properties) over the name; before the name, a link icon for a link, red
// (the link's, or a lock) when you can't change it without sudo (through a
// link, what it points to); ⚡ in the bottom right corner for an on-change
// hook; ▶ in the top right one for a video, and a folder icon for a folder
// (shown by themes that drop the folder's tab). (The top left is left alone.)
function showMarks(tile, entry) {
  const desc = tile.querySelector(".label .desc");
  const description = entry.description ?? carried.get(entry.path) ?? ""; // phil's, or the file's own
  desc.textContent = description;
  tile.classList.toggle("has-desc", !!description);
  showTileTags(tile, entry);
  showState(tile, entry);
  const label = tile.querySelector(".label");
  tile.classList.toggle("has-hook", !!entry.onChange);
  if (!entry.onChange) label.querySelector(".hook-mark")?.remove();
  else if (!label.querySelector(".hook-mark")) label.insertAdjacentHTML("beforeend", `<span class="hook-mark">${icon("bolt")}</span>`);
  const marks = [entry.kind === "video" && ["play", ""], entry.kind === "dir" && ["folder", "folder fill"]].filter(Boolean);
  const key = marks.flat().join(" ");
  let el = tile.querySelector(":scope > .marks");
  if (el?.dataset.key === key) return;
  el?.remove();
  if (!marks.length) return;
  el = document.createElement("span");
  el.className = "marks";
  el.dataset.key = key;
  el.innerHTML = marks.map(([name, cls]) => `<span class="badge ${cls}">${icon(name)}</span>`).join("");
  tile.append(el);
}

// A tile's tags, under its details; a folder's: its most common, as many as
// fit across the tile (the line ends in "…" where it's cut).
function showTileTags(tile, entry) {
  const label = tile.querySelector(".label");
  const tags = entry.kind === "dir" ? (entry.folderTags ?? []).map(([t]) => t) : tagsOf(entry);
  const text = entry.kind === "dir"
    ? tags.join(" · ")
    : tags.slice(0, 5).join(" · ") + (tags.length > 5 ? ` +${tags.length - 5}` : "");
  let el = label.querySelector(":scope > .tags");
  if (!el) el = label.appendChild(Object.assign(document.createElement("span"), { className: "tags" }));
  if (el.textContent !== text) el.textContent = text;
}

function showState(tile, entry) {
  const locked = entry.writable === false;
  const which = entry.symlink ? `link${locked ? " locked" : ""}` : locked ? "lock locked" : "";
  const name = tile.querySelector(".label .name");
  const el = name.querySelector(".state");
  if ((el?.dataset.which ?? "") === which) return;
  el?.remove();
  if (!which) return;
  name.insertAdjacentHTML("afterbegin", icon(which.split(" ")[0], `state ${which}`));
  name.firstChild.dataset.which = which;
}

// The hover text's lines about the description, links, permissions and hooks.
const fileTitle = (entry) => `${entry.name}\n${formatSize(entry.size)} · ${formatDate(entry.mtime)}` + titleNotes(entry);

function titleNotes(entry) {
  const notes = entry.description ? [entry.description] : [];
  if (!entry.description && carried.get(entry.path)) notes.push(carried.get(entry.path));
  const tags = entry.kind === "dir" ? (entry.folderTags ?? []).map(([t]) => t) : tagsOf(entry);
  if (tags.length) notes.push(`${entry.kind === "dir" ? "Mostly" : "Tags"}: ${tags.join(", ")}`);
  if (entry.symlink) notes.push(`Link to ${entry.target ?? "?"}`);
  if (entry.writable === false) notes.push(entry.kind === "dir" ? "You can't change what's in it without sudo" : "You can't change it without sudo");
  if (entry.onChange) notes.push(`When it changes: ${entry.onChange}`);
  return notes.map((n) => `\n${n}`).join("");
}

// A folder looks like one: a tab over a face that holds its first few
// thumbnails, or an icon for what it holds, and its label says what it holds.
// All from its summary (src/folders.js), which is fetched when the tile comes
// into view; until then the folder is plain.
function showFolderInfo(tile, entry) {
  const summary = entry.summary;
  const box = tile.firstElementChild;
  // {url} for an image or video thumbnail, {text} for a text file; a bare URL in older summaries.
  const previews = (summary?.previews ?? []).map((p) => (typeof p === "string" ? { url: p } : p));
  const look = previews.map((p) => p.url ?? `text:${p.text.lines.slice(0, 4).join("|")}`).join(" ") ||
    (summary?.files ? "file" : summary?.dirs ? "folder" : "");
  if (box.dataset.look !== look || !box.firstChild) fillFolderFace(box, summary, previews);
  box.dataset.look = look;
  const meta = tile.querySelector(".meta");
  meta.textContent = summary ? folderContents(summary, entry.total) : "";
  tile.title = entry.name + (meta.textContent ? `\n${meta.textContent}` : "") + titleNotes(entry);
  showMarks(tile, entry);
  tile.classList.toggle("empty-dir", !!summary && !summary.files && !summary.dirs);
}

function fillFolderFace(box, summary, previews) {
  const face = document.createElement("div");
  face.className = "face";
  if (previews.length) {
    face.classList.add("previews", `n${previews.length}`);
    for (const { url, text } of previews) {
      if (text) { // drawn once the tile is laid out (drawFolderTexts)
        const cell = Object.assign(document.createElement("div"), { className: "cell", text });
        face.append(cell);
        continue;
      }
      const img = Object.assign(new Image(), { src: url, alt: "", draggable: false, loading: "lazy", decoding: "async" });
      img.onerror = () => img.remove(); // the thumbnail cache was cleared since
      face.append(img);
    }
  } else if (summary?.files || summary?.dirs) {
    face.innerHTML = icon(summary.files ? "file" : "folder", "kind");
  }
  box.replaceChildren(face);
}

function drawFolderTexts(tile) {
  for (const cell of tile.querySelectorAll(".face > .cell")) if (!cell.querySelector("canvas")) drawText(cell);
}

function formatShortDate(ms) {
  if (!ms) return "";
  const date = new Date(ms);
  const thisYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, thisYear ? { month: "short", day: "numeric" } : { dateStyle: "medium" });
}

// "3 folders · 17 files · 56 MB / 1.2 GB": the size of the files in it, then
// of everything, subfolders too (… while it's worked out). Without
// subfolders the two are the same, so it's said once.
function folderContents({ files, dirs, size }, total) {
  const count = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
  const parts = [];
  if (dirs) parts.push(count(dirs, "folder"));
  if (files) parts.push(count(files, "file"));
  if (dirs && !total?.failed) parts.push(`${formatSize(files ? size : 0)} / ${total?.bytes !== undefined ? formatSize(total.bytes) : "…"}`);
  else if (files) parts.push(formatSize(size));
  return parts.join(" · ") || "Empty";
}

function showGridMessage(message) {
  const el = document.createElement("div");
  el.className = "empty";
  el.textContent = message;
  grid.replaceChildren(el);
}

function renderCrumbs() {
  const parts = state.path.split("/").filter(Boolean);
  crumbs.replaceChildren();
  const add = (label, path) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.dataset.path = path; // drop target
    b.onclick = (e) => {
      e.stopPropagation();
      navigate(path);
    };
    // Right-click: that folder's Properties (the way to the one you're in, whose tile isn't shown).
    b.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [["Properties", () => showProperties({ path, name: label, kind: "dir" })], ...newItemsIn(path, " inside")]);
    };
    crumbs.append(b);
  };
  add("/", "/");
  parts.forEach((part, i) => {
    if (i > 0) crumbs.insertAdjacentHTML("beforeend", `<span class="sep">/</span>`);
    add(part, "/" + parts.slice(0, i + 1).join("/"));
  });
  crumbs.scrollLeft = crumbs.scrollWidth;
}

// Drives and shares come and go (USB, mounts): the list is fetched again
// whenever the window gets focus.
addEventListener("focus", async () => {
  const fresh = await api("/api/places").catch(() => null);
  if (!fresh) return;
  state.init.mounts = fresh.mounts;
  if (JSON.stringify(fresh.places) === JSON.stringify(state.init.places)) return;
  state.init.places = fresh.places;
  renderPlaces();
});

// ---------------------------------------------------------------- ssh into network mounts

// The machine and folder behind a local path on a network mount
// (state.init.mounts: NFS and sshfs), or null.
function remoteOf(path) {
  const m = state.init.mounts.find((m) => path === m.target || path.startsWith(m.target + "/"));
  if (!m) return null;
  const rel = path.slice(m.target.length);
  return { host: m.host, dir: m.root ? (m.root === "/" ? "" : m.root) + rel || "/" : rel.replace(/^\//, "") };
}

// The local path of a folder on another machine, if it's on a mount of it.
function localOf(host, dir) {
  const name = (h) => h.replace(/^.*@/, "").split(".")[0].toLowerCase();
  for (const m of state.init.mounts) {
    if (name(m.host) !== name(host) || !m.root.startsWith("/")) continue;
    const root = m.root === "/" ? "" : m.root;
    if (dir === m.root || dir.startsWith(root + "/")) return m.target + dir.slice(root.length);
  }
  return null;
}

// "SSH here": the terminal panel goes to `path` (on a network mount), then
// runs phil's ssh there, which lands in the same folder on that machine.
async function sshTo(path) {
  if (!remoteOf(path)) return;
  const until = async (ready) => {
    for (let i = 0; i < 50 && !ready(); i++) await new Promise((r) => setTimeout(r, 100));
  };
  // The view first (a shell started before it would pull it back), then the
  // shell, which follows it, at its prompt.
  if (state.path !== path) navigate(path);
  await until(() => state.path === path);
  setTerminalOpen(true);
  await until(() => terminal.cwd === path && terminal.atEmptyPrompt);
  if (terminal.remote || !terminal.run("ssh")) alert("The terminal is busy: finish what's running there first.");
}

function renderPlaces() {
  const nav = $("#places");
  nav.replaceChildren(...state.init.places.map((p) => {
    const a = document.createElement("a");
    a.href = "#" + encodePath(p.path);
    a.dataset.path = p.path; // drop target
    a.title = p.path;
    a.innerHTML = icon(p.icon);
    a.append(p.name);
    a.classList.toggle("active", p.path === state.path);
    // A network share: double-click (or the menu) for a terminal on that machine.
    const remote = remoteOf(p.path);
    if (remote) {
      a.title += `\nDouble-click: SSH to ${remote.host}`;
      a.ondblclick = (e) => (e.preventDefault(), sshTo(p.path));
    }
    a.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation(); // not the sidebar's menu
      showMenu(e.clientX, e.clientY, [
        ["Open", () => navigate(p.path)],
        ...(remote ? [[`SSH here (${remote.host})`, () => sshTo(p.path)]] : []),
        ...newItemsIn(p.path, " inside"),
      ]);
    };
    return a;
  }));
}

function editLocation() {
  crumbs.hidden = true;
  locationInput.hidden = false;
  locationInput.value = state.path;
  locationInput.focus();
  locationInput.select();
}

function closeLocation() {
  locationInput.hidden = true;
  crumbs.hidden = false;
}

// ---------------------------------------------------------------- selection & status

/**
 * Moves the cursor to `index`. Plain: selects just that entry. `toggle`
 * (Ctrl+click) adds/removes it; `extend` (Shift) selects the range from the
 * anchor. An index of -1 clears the selection.
 */
function select(index, { scroll = true, toggle = false, extend = false } = {}) {
  const entry = state.view[index];
  if (!entry) {
    setMarked([]);
    state.selected = state.anchor = -1;
    return updateStatus();
  }
  if (extend && state.anchor !== -1) {
    const [from, to] = [Math.min(state.anchor, index), Math.max(state.anchor, index)];
    setMarked(state.view.slice(from, to + 1).map((e) => e.path));
  } else if (toggle) {
    const marked = new Set(state.marked);
    if (!marked.delete(entry.path)) marked.add(entry.path);
    setMarked(marked);
    state.anchor = index;
  } else {
    setMarked([entry.path]);
    state.anchor = index;
  }
  state.selected = index;
  if (scroll) tiles.get(entry.path)?.scrollIntoView({ block: "nearest" });
  updateStatus();
}

function setMarked(paths) {
  const next = new Set(paths);
  for (const p of state.marked) if (!next.has(p)) tiles.get(p)?.classList.remove("selected");
  for (const p of next) if (!state.marked.has(p)) tiles.get(p)?.classList.add("selected");
  state.marked = next;
}

const markedEntries = () => state.view.filter((e) => state.marked.has(e.path));

// Typing a name jumps to the next entry starting with what was typed. Letters
// typed within a second build up the prefix; repeating one letter cycles.
let typed = "";
let typedTimer;
function typeAhead(ch) {
  clearTimeout(typedTimer);
  typedTimer = setTimeout(() => (typed = ""), 1000);
  ch = ch.toLowerCase();
  const cycling = typed === ch;
  if (!cycling) typed += ch;
  const n = state.view.length;
  const start = state.selected + (typed.length === 1 ? 1 : 0); // a new search looks past the current entry
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    if (state.view[i].name.toLowerCase().startsWith(typed)) return select(i);
  }
}

function columns() {
  return getComputedStyle(grid).gridTemplateColumns.split(" ").length;
}

function updateStatus() {
  const dirs = state.view.filter((e) => e.kind === "dir").length;
  const files = state.view.length - dirs;
  const sel = state.marked.size === 1 ? markedEntries()[0] : null;
  let text = `${dirs} folder${dirs === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"}`;
  if (state.marked.size > 1) {
    const size = markedEntries().reduce((sum, e) => sum + (e.kind === "dir" ? 0 : e.size), 0);
    text += `  ·  ${state.marked.size} selected  ${formatSize(size)}`;
  } else if (sel) {
    text += `  ·  ${sel.name}` + (sel.kind === "dir" ? "" : `  ${formatSize(sel.size)}  ${formatDate(sel.mtime)}`);
  }
  $("#status-count").textContent = text;
}

function updateProgress() {
  const folders = thumbs.folders.size, files = thumbs.wanted.size - folders;
  const parts = [];
  if (files) parts.push(`Generating ${files} thumbnail${files === 1 ? "" : "s"}`);
  if (folders) parts.push(`${parts.length ? "reading" : "Reading"} ${folders} folder${folders === 1 ? "" : "s"}`);
  if (flashStatus.until > Date.now()) return; // a message showing for a while (it updates this after)
  $("#status-progress").textContent = parts.length ? parts.join(", ") + "…" : "";
}

function applySettings() {
  const s = state.settings;
  document.documentElement.style.setProperty("--tile", `${s.zoom}px`);
  zoomInput.value = s.zoom;
  sortSelect.value = s.sort;
  hiddenButton.setAttribute("aria-pressed", String(s.showHidden));
  $("#btn-sidebar").setAttribute("aria-pressed", String(s.sidebar));
  document.body.classList.toggle("sidebar", s.sidebar);
  const theme = /^[\w-]+$/.test(s.theme ?? "") ? s.theme : "overlay";
  document.body.dataset.theme = theme;
  if (themePick.value !== theme) themePick.value = theme;
  const link = $("#theme");
  if (new URL(link.href).pathname !== `/themes/${theme}.css`) link.href = `/themes/${theme}.css`;
  redrawTexts();
  termPanel.style.height = `${s.termHeight}px`;
}

function setTheme(theme) {
  state.settings.theme = theme;
  applySettings();
}

function toggleSidebar() {
  state.settings.sidebar = !state.settings.sidebar;
  document.body.classList.remove("peek");
  applySettings();
  saveSettings();
}

// Hovering the sidebar button slides the sidebar out over the folder, until
// the pointer has left both (clicking keeps it open, beside the folder).
{
  let leaving = null;
  const peek = (on) => {
    clearTimeout(leaving);
    if (on) return void (!state.settings.sidebar && document.body.classList.add("peek"));
    leaving = setTimeout(() => document.body.classList.remove("peek"), 250);
  };
  for (const el of [$("#btn-sidebar"), $("#sidebar")]) {
    el.addEventListener("pointerenter", () => peek(true));
    el.addEventListener("pointerleave", () => peek(false));
  }
}

function setZoom(zoom) {
  state.settings.zoom = Math.max(128, Math.min(480, zoom));
  applySettings();
  saveSettings();
}

// ---------------------------------------------------------------- opening things

function open(index) {
  const entry = state.view[index];
  if (!entry) return;
  if (entry.kind === "dir") navigate(entry.path);
  else if (entry.kind === "image") openInApp("imageview", { file: entry.path, sort: state.settings.sort });
  // mpv plays everything; WebKit's player stalls on some files (NVIDIA decoding).
  else if (entry.kind === "video") openExternal(entry.path, "mpv");
  else if (entry.kind === "pdf") openExternal(entry.path);
  else if (isJson(entry)) openInApp("jsonedit", { file: entry.path });
  else if (isDocument(entry)) openInApp("textedit", { file: entry.path }); // to read, as Markdown; "Open with default app" to edit
  else openFile(entry);
}

const isJson = (entry) => entry.kind === "file" && /\.json$/i.test(entry.name);
// Word, RTF, OpenDocument...: what engine/documents.js converts.
const isDocument = (entry) => entry.kind === "file" && /\.(rtf|docx?|docm|dotx?|odt|ott|fodt|wps|wpd|abw|pages)$/i.test(entry.name);

// Text files (anything that reads as text: notes, code, configs, logs) open in
// textedit in this window, other files with their default app. A tile that
// drew the file's text knows; otherwise (not drawn yet, or empty) the server
// checks.
async function openFile(entry) {
  const isText = !!tiles.get(entry.path)?.firstElementChild.text ||
    await api(`/api/is-text?path=${encodeURIComponent(entry.path)}`).then((r) => r.text, () => false);
  if (isText) openInApp("textedit", { file: entry.path });
  else openExternal(entry.path);
}

// Another app (jsonedit) shown in this window, over the folder, like the
// viewer. Its close button (or Esc) comes back here.
const appView = $("#app-view");

let focusBeforeApp = null; // where the keyboard goes back to: the grid, or the terminal it was opened from

function openInApp(app, params) {
  focusBeforeApp = document.activeElement;
  const src = appUrl(app, params);
  const frame = Object.assign(document.createElement("iframe"), { src, title: app, allow: "fullscreen" });
  frame.dataset.embed = embedOf(src);
  appView.replaceChildren(frame);
  appView.hidden = false;
  frame.focus();
}

// Esc while the keyboard is still here: the app closes itself (it may ask
// about unsaved changes first).
function askAppToClose() {
  const frame = appView.querySelector("iframe");
  frame?.contentWindow.postMessage({ engine: "close-request" }, "*");
  frame?.focus();
}

function closeApp() {
  appView.hidden = true;
  appView.replaceChildren();
  const back = focusBeforeApp?.isConnected && focusBeforeApp !== document.body ? focusBeforeApp : grid;
  back.focus({ preventScroll: true });
}

// The app in the frame says it's ready (kit.js ready()): give it the keyboard,
// which it can't take itself; or it closes.
// (Which frame it's from: by its id, not e.source; see kit.js.)
addEventListener("message", (e) => {
  const frame = appView.querySelector("iframe");
  if (!frame || e.origin !== location.origin || e.data?.embed !== frame.dataset.embed) return;
  if (e.data?.engine === "ready") {
    frame.focus();
    frame.contentWindow.focus();
    frame.contentWindow.postMessage({ engine: "focus" }, "*"); // now it can focus its view (kit.js holdFocus)
  } else if (e.data?.engine === "close") {
    closeApp();
  } else if (e.data?.app === "imageview" && e.data.showing) { // the image it shows: selected here, for when it closes
    const i = state.view.findIndex((v) => v.path === e.data.showing);
    if (i !== -1) select(i);
  }
});

// "Play here": a video in this window (mpv plays everything else; images open
// in imageview).
const viewer = {
  index: -1,

  open(index) {
    viewerEl.hidden = false;
    this.show(index);
  },

  close() {
    stage.replaceChildren(); // stops video playback
    viewerEl.hidden = true;
    if (document.fullscreenElement) document.exitFullscreen();
    grid.focus({ preventScroll: true });
  },

  step(dir) {
    for (let i = this.index + dir; i >= 0 && i < state.view.length; i += dir) {
      if (state.view[i].kind === "video") return this.show(i);
    }
  },

  show(index) {
    const entry = state.view[index];
    this.index = index;
    select(index);
    stage.replaceChildren();
    const failed = (msg) => {
      const el = document.createElement("div");
      el.className = "message";
      el.textContent = msg;
      stage.replaceChildren(el);
    };

    const video = document.createElement("video");
    video.controls = true;
    video.autoplay = true;
    video.onerror = () =>
      failed("This video can't be played here — GStreamer is probably missing a codec\n(gst-plugins-good / gst-libav). Use mpv instead.");
    // WebKit's player waits forever on some files instead of failing, e.g.
    // Matroska files with embedded subtitles.
    setTimeout(() => {
      if (video.isConnected && video.readyState === 0) failed("This video doesn't load in the built-in player (files with embedded\nsubtitles don't). Use mpv instead.");
    }, 6000);
    video.src = fileUrl(entry.path);
    stage.append(video);
    video.focus();

    viewerEl.querySelector(".caption").textContent =
      `${entry.name}   ·   ${formatSize(entry.size)}   ·   ${formatDate(entry.mtime)}`;
  },
};

viewerEl.querySelector(".close").onclick = () => viewer.close();
viewerEl.querySelector(".prev").onclick = () => viewer.step(-1);
viewerEl.querySelector(".next").onclick = () => viewer.step(1);
viewerEl.querySelector(".open-ext").onclick = () => openExternal(state.view[viewer.index].path);
viewerEl.querySelector(".open-mpv").onclick = () => {
  const path = state.view[viewer.index].path;
  viewer.close();
  openExternal(path, "mpv");
};

// ---------------------------------------------------------------- deleting

const confirmDialog = $("#confirm");

function askConfirm({ title, detail, ok }) {
  confirmDialog.querySelector(".title").textContent = title;
  confirmDialog.querySelector(".detail").textContent = detail;
  confirmDialog.querySelector("[value=ok]").textContent = ok;
  confirmDialog.returnValue = "";
  confirmDialog.showModal();
  return new Promise((resolve) => {
    confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue === "ok"), { once: true });
  });
}

// Shift+Delete: permanent, no trash. Asks first; Enter confirms, Esc cancels.
async function deleteMarked() {
  const targets = markedEntries();
  if (!targets.length) return;
  const dirs = targets.filter((e) => e.kind === "dir").length;
  const names = targets.slice(0, 4).map((e) => e.name).join(", ") + (targets.length > 4 ? `, … (${targets.length - 4} more)` : "");
  const confirmed = await askConfirm({
    title: targets.length === 1 ? `Permanently delete “${targets[0].name}”?` : `Permanently delete ${targets.length} items?`,
    detail: (targets.length > 1 ? names + "\n\n" : "") +
      (dirs ? "Folders are deleted with everything in them. " : "") + "This can't be undone.",
    ok: "Delete",
  });
  grid.focus({ preventScroll: true });
  if (!confirmed) return;

  const firstIndex = state.view.indexOf(targets[0]);
  let result;
  try {
    result = await api("/api/delete", { method: "POST", body: JSON.stringify({ paths: targets.map((e) => e.path) }) });
  } catch (err) {
    result = { errors: [{ path: "", error: err.message }] };
  }
  await load(state.path);
  select(Math.min(firstIndex, state.view.length - 1));
  if (result.errors.length) {
    alert(`Couldn't delete ${result.errors.length} item(s):\n` +
      result.errors.map((e) => `${e.path.split("/").pop()}: ${e.error}`).join("\n"));
  }
}

// ---------------------------------------------------------------- renaming

// F2: the name becomes a text field, like in Windows. Enter (or clicking
// elsewhere) renames, Esc cancels. A file's name starts selected without its
// extension.
let renaming = null;

// `whole`: all of the name selected, the extension too (a new item's); `typed`:
// typed already, in place of it.
function startRename(index, { whole = false, typed = "" } = {}) {
  const entry = state.view[index];
  const tile = entry && tiles.get(entry.path);
  if (!tile || renaming) return;
  hideContextMenu();
  const input = Object.assign(document.createElement("input"), { className: "rename", value: entry.name, spellcheck: false });
  tile.classList.add("renaming");
  tile.querySelector(".label").append(input);
  tile.scrollIntoView({ block: "nearest" });
  input.focus();
  const dot = entry.kind === "dir" || whole ? -1 : entry.name.lastIndexOf(".");
  if (typed) input.value = typed;
  else input.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  renaming = { entry, input };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // typing a name isn't navigating
    if (e.key === "Enter") finishRename(true, { refocus: true }), e.preventDefault();
    else if (e.key === "Escape") finishRename(false, { refocus: true }), e.preventDefault();
  });
  input.addEventListener("blur", () => finishRename(true));
}

async function finishRename(commit, { refocus = false } = {}) {
  if (!renaming) return;
  const { entry, input } = renaming;
  renaming = null;
  const name = input.value.trim();
  input.closest(".tile")?.classList.remove("renaming");
  input.remove();
  if (refocus) grid.focus({ preventScroll: true });
  if (!commit || !name || name === entry.name) return;
  try {
    const { path } = await api("/api/rename", { method: "POST", body: JSON.stringify({ path: entry.path, name }) });
    await load(state.path);
    const i = state.view.findIndex((e) => e.path === path);
    if (i !== -1) select(i);
  } catch (err) {
    alert(`Couldn't rename “${entry.name}”: ${err.message}`);
  }
}

const inRename = (e) => e.target.closest?.(".rename");

// ---------------------------------------------------------------- context menu

function showContextMenu(x, y, entry) {
  const items = [["Properties", () => showProperties(entry)]];
  if (entry.kind === "dir") items.push(["Open", () => navigate(entry.path)], ...newItemsIn(entry.path, " inside"));
  if (entry.kind === "dir" && remoteOf(entry.path)) items.push([`SSH here (${remoteOf(entry.path).host})`, () => sshTo(entry.path)]);
  if (entry.kind === "image") items.push(["View", () => open(state.view.indexOf(entry))]);
  if (entry.kind === "image") items.push(["Resize, crop, compress…", () => openInApp("imageresize", { file: entry.path })]);
  if (entry.kind === "video") items.push(["Play in mpv", () => openExternal(entry.path, "mpv")]);
  if (entry.kind === "video") items.push(["Play here", () => viewer.open(state.view.indexOf(entry))]);
  if (isJson(entry)) items.push(["Edit in jsonedit", () => openInApp("jsonedit", { file: entry.path })]);
  if (entry.kind === "file") items.push(["Edit as text", () => openInApp("textedit", { file: entry.path })]);
  if (isJson(entry) || tiles.get(entry.path)?.firstElementChild.text) items.push(["Add to Config", () => addToConfig(entry)]);
  items.push(["Open with default app", () => openExternal(entry.path)]);
  items.push(["Rename…", () => startRename(state.view.indexOf(entry))]);
  items.push(["Copy path", () => copyText(entry.path)]);
  items.push([state.marked.size > 1 ? `Add tags to ${state.marked.size} items…` : "Add tags…", addTags]);
  items.push([state.marked.size > 1 ? `Delete ${state.marked.size} items permanently…` : "Delete permanently…", deleteMarked]);
  if (terminal.isRunning) {
    items.push(["Paste path in terminal", () => {
      if (!terminal.isOpen) toggleTerminal();
      terminal.insert(shellQuote(entry.path) + " ");
    }]);
  }
  showMenu(x, y, items);
}

function showMenu(x, y, items) {
  contextMenu.replaceChildren(...items.map(([label, action]) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => {
      hideContextMenu();
      action();
    };
    li.append(b);
    return li;
  }));
  contextMenu.hidden = false;
  const { width, height } = contextMenu.getBoundingClientRect();
  contextMenu.style.left = `${Math.min(x, innerWidth - width - 4)}px`;
  contextMenu.style.top = `${Math.min(y, innerHeight - height - 4)}px`;
}

function hideContextMenu() {
  contextMenu.hidden = true;
}

// ---------------------------------------------------------------- new folders and files

// The + button and Insert: a new folder, "Folder" (numbered when there's one
// already); Super+Insert: a new file, "File.txt". In the folder shown, it's
// selected with its name ready to type over (Enter keeps it); in another (a
// folder's menu), the status bar says so. What's typed before its name field
// is there (Insert, then the name straight away) goes in the field.
let typedAhead = null; // the keys typed meanwhile, while a new item is being made here
async function createIn(dir, kind) {
  const here = dir === state.path;
  if (here) typedAhead = "";
  let made;
  try {
    made = await api("/api/create", { method: "POST", body: JSON.stringify({ dir, kind }) });
    if (!here) return flashStatus(`Made “${made.name}” in ${dir.split("/").pop() || "/"}`);
    await load(state.path);
  } catch (err) {
    typedAhead = null;
    return alert(`Couldn't make a new ${kind === "dir" ? "folder" : "file"}: ${err.message}`);
  }
  const typed = typedAhead ?? "";
  typedAhead = null;
  const i = state.view.findIndex((e) => e.path === made.path);
  if (i === -1) return flashStatus(`Made “${made.name}”`); // filtered out
  select(i);
  startRename(i, { whole: true, typed });
}

// The menu's items for that: "New folder" and "New file" (+ `where`).
const newItemsIn = (dir, where = "") => [
  [`New folder${where}`, () => createIn(dir, "dir")],
  [`New file${where}`, () => createIn(dir, "file")],
];

// ---------------------------------------------------------------- themes

// The bottom bar's theme picker: the themes (stylesheets in
// ~/.config/phil/themes, listed again whenever one is added or removed there),
// then a new one, and the folder. Picking one saves it in the settings, so
// every phil window follows.
const themePick = $("#theme-pick");
const NEW_THEME = "\u0000new", THEME_FOLDER = "\u0000folder";
let themesFolder = null;

async function listThemes() {
  const r = await api("/api/themes").catch(() => null);
  if (!r) return;
  themesFolder = r.dir;
  if (r.theme !== state.settings.theme) setTheme(r.theme); // the one in use was deleted: the default
  const names = r.themes.includes(state.settings.theme) ? r.themes : [...r.themes, state.settings.theme];
  themePick.replaceChildren(
    ...names.map((t) => new Option(t, t)),
    new Option("New theme…", NEW_THEME),
    new Option("Open the themes folder", THEME_FOLDER),
  );
  themePick.value = state.settings.theme;
}

themePick.onchange = async () => {
  const picked = themePick.value;
  themePick.value = state.settings.theme; // until the settings say otherwise
  grid.focus({ preventScroll: true });
  if (picked === THEME_FOLDER) return themesFolder && navigate(themesFolder);
  if (picked !== NEW_THEME) {
    return api("/api/theme", { method: "PUT", body: JSON.stringify({ theme: picked }) }).catch((err) => alert(err.message));
  }
  const name = prompt(`A name for the new theme (a stylesheet in ${themesFolder}; it starts from a template with notes on what to change):`);
  if (!name?.trim()) return;
  try {
    const { theme, file } = await api("/api/themes", { method: "POST", body: JSON.stringify({ name }) });
    openExternal(file); // in its own window, next to this one: every save shows here
    flashStatus(`New theme ${theme}: ${file}`, 8000);
  } catch (err) {
    alert(`Couldn't make the theme: ${err.message}`);
  }
};
document.addEventListener("themes-changed", listThemes);

// ---------------------------------------------------------------- tags

// Tags: given by hand (Properties, "Add tags…": entry.tags, kept with a
// file's description) and, in folders set to (in their Properties: the
// listing's autoTags), found by auto-tagging (SigLIP 2, apps/phil/tagging.js;
// the server sends them as pictures get tagged), with the keywords and
// descriptions the files carry. The sidebar lists the folder's; clicking tags
// shows only what has all of them. The filter box also finds a tagged
// folder's pictures by what they show (searchPictures).
const autoTags = new Map(); // path -> [[tag, probability]], this folder's
const carried = new Map(); // path -> the description the file carries (EXIF, XMP, IPTC)
const searchScores = new Map(); // path -> how well it matches the filter text, by what it shows
const tagFilter = new Set();
const tagsOf = (e) => [...new Set([...(e.tags ?? []), ...(autoTags.get(e.path) ?? []).map(([t]) => t)])];
const splitTags = (text) => [...new Set(text.split(",").map((t) => t.trim().replace(/\s+/g, " ")).filter(Boolean))];

function onTagged({ tagged, tags = {}, descriptions = {}, left = 0, error }) {
  if (tagged !== state.path) return;
  if (error) {
    return showTagStatus(error === "setup"
      ? "Auto-tagging isn't set up yet: run scripts/install-tagging.sh in phil's source folder (several GB: PyTorch and the model)."
      : `Tagging stopped: ${error}`);
  }
  for (const [path, text] of Object.entries(descriptions)) carried.set(path, text);
  for (const [path, t] of Object.entries(tags)) {
    autoTags.set(path, t);
    const tile = tiles.get(path), entry = tile && state.view[tile.dataset.index];
    if (entry && entry.kind !== "dir") tile.title = fileTitle(entry), showMarks(tile, entry);
  }
  showTagStatus(left ? `Tagging… ${left} to go` : "");
  renderTags();
  if (tagFilter.size && Object.keys(tags).length) render(); // more may match now
}

function showTagStatus(text) {
  $("#tags-status").textContent = text;
  $("#tags-status").hidden = !text;
  $("#tags-panel").hidden = !text && !$("#tags").childElementCount;
}

function renderTags() {
  const counts = new Map(), mine = new Set();
  for (const e of state.entries) {
    for (const t of tagsOf(e)) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const t of e.tags ?? []) mine.add(t);
  }
  for (const t of tagFilter) if (!counts.has(t)) counts.set(t, 0);
  const list = [...counts].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]));
  $("#tags").replaceChildren(...list.map(([tag, n]) => {
    const b = document.createElement("button");
    b.className = (tagFilter.has(tag) ? "active " : "") + (mine.has(tag) ? "mine" : "");
    b.title = `${n} here${mine.has(tag) ? ", some given by hand" : ""}. Click: only what has it (with any other tags picked)`;
    b.append(tag, Object.assign(document.createElement("span"), { className: "n", textContent: n }));
    b.onclick = () => {
      tagFilter.has(tag) ? tagFilter.delete(tag) : tagFilter.add(tag);
      render();
      renderTags();
    };
    return b;
  }));
  $("#tags-panel").hidden = !list.length && $("#tags-status").hidden;
}

// The filter box in a tagged folder: after a moment's pause in typing, the
// server says which pictures look like what's typed (searchScores).
let searchTimer = null;
function searchPictures() {
  clearTimeout(searchTimer);
  const text = filterInput.value.trim();
  if (!text || !state.autoTagged) {
    if (searchScores.size) searchScores.clear(), render();
    return;
  }
  searchTimer = setTimeout(() => thumbs.send({ search: { dir: state.path, text } }), 300);
}

function onSearched({ searched, text, scores = {} }) {
  if (searched !== state.path || text !== filterInput.value.trim()) return; // typed on since
  searchScores.clear();
  for (const [p, s] of Object.entries(scores)) searchScores.set(p, s);
  render();
}

// Right-click → "Add tags…": to the selected items; new tags join the list
// auto-tagging looks for (~/.config/phil/tags.txt), so it finds them in other
// pictures too.
async function addTags() {
  const targets = markedEntries();
  if (!targets.length) return;
  const text = prompt(targets.length > 1 ? `Tags for these ${targets.length} items (separated by commas):` : `Tags for ${targets[0].name} (separated by commas):`);
  const tags = splitTags(text ?? "");
  if (!tags.length) return;
  try {
    await api("/api/tags", { method: "POST", body: JSON.stringify({ paths: targets.map((e) => e.path), tags }) });
    flashStatus(`Tagged ${targets.length === 1 ? targets[0].name : `${targets.length} items`}: ${tags.join(", ")}`);
    refresh();
    if (state.autoTagged) thumbs.tag(state.path); // the list grew: everything again (from the saved embeddings)
  } catch (err) {
    alert(`Couldn't add the tags: ${err.message}`);
  }
}

// ---------------------------------------------------------------- properties

const propsDialog = $("#props");
const dialogOpen = () => confirmDialog.open || propsDialog.open;

// Right-click → Properties (Alt+Enter): what it is, size, dates, owner and
// permissions, and phil's own: a command to run when the file changes (see
// apps/phil/hooks.js).
async function showProperties(entry) {
  let p;
  try {
    p = await api(`/api/properties?path=${encodeURIComponent(entry.path)}`);
  } catch (err) {
    return alert(`Couldn't read “${entry.name}”: ${err.message}`);
  }
  const $p = (sel) => propsDialog.querySelector(sel);
  $p(".title").textContent = p.name;
  $p(".where").textContent = p.folder;
  const facts = $p(".facts");
  facts.replaceChildren();
  const fact = (label, ...parts) => {
    const dt = document.createElement("dt"), dd = document.createElement("dd");
    dt.textContent = label;
    for (const part of parts) {
      if (part == null || part === "") continue;
      if (typeof part === "string") dd.append(part);
      else {
        const span = document.createElement(part.code ? "code" : "span");
        if (part.dim) span.className = "dim";
        span.textContent = part.code ?? part.dim;
        dd.append(span);
      }
    }
    facts.append(dt, dd);
    return dd;
  };
  const kind = p.kind === "folder" ? "Folder" : p.kind === "file" ? (p.description ?? "File") : p.kind === "broken link" ? "Link to nothing" : "Special file";
  fact("Type", kind);
  if (p.link) {
    fact("Link to", { code: p.link.target ?? "?" }, p.link.real && p.link.real !== p.link.target ? { dim: `  → ${p.link.real}` } : null);
  }
  let contents = null;
  if (p.kind === "folder") contents = fact("Contains", { dim: "counting…" });
  else fact("Size", formatSize(p.size), p.size >= 1024 ? { dim: `  (${p.size.toLocaleString()} bytes)` } : null);
  fact("Modified", formatDate(p.modified));
  if (p.created) fact("Created", formatDate(p.created));
  fact("Accessed", formatDate(p.accessed));
  fact("Owner", p.owner, { dim: `  group ${p.group}` });
  fact("Permissions", { code: permissionString(p) }, { dim: `  ${p.mode.toString(8).padStart(3, "0")}` });
  if (p.access) fact("You", accessText(p));

  const input = $p("#props-hook"), output = $p(".output"), descInput = $p("#props-desc"), tagsInput = $p("#props-tags");
  tagsInput.value = (p.meta?.tags ?? []).join(", ");
  const found = (autoTags.get(p.path) ?? []).map(([t]) => t).filter((t) => !(p.meta?.tags ?? []).includes(t));
  const ownText = carried.get(p.path);
  $p("#props-found").textContent = [found.length && `Found by auto-tagging: ${found.join(", ")}`, ownText && `The file's own description: ${ownText}`].filter(Boolean).join("\n");
  $p("#props-found").hidden = !found.length && !ownText;
  $p(".hook").hidden = p.kind !== "file"; // hooks are for files
  // A folder: auto-tagging its pictures (tagging.js), if set up.
  const autoBox = $p("#props-autotag");
  $p(".autotag").hidden = p.kind !== "folder";
  autoBox.checked = !!p.meta?.autoTags;
  $p("#props-autotag-hint").textContent = state.init.tagging?.available
    ? "With SigLIP 2, on this computer: it stores what each picture shows, so typing a description in the filter box (\u201cfoggy forest\u201d) finds them. Keywords and descriptions saved in the files show too."
    : "Set it up first: run scripts/install-tagging.sh in phil's source folder (several GB: PyTorch and the model).";
  autoBox.disabled = !state.init.tagging?.available && !autoBox.checked;
  descInput.value = p.meta?.description ?? "";
  input.value = p.meta?.onChange ?? "";
  output.hidden = true;
  $p(".run").onclick = async () => {
    const command = input.value.trim();
    if (!command) return input.focus();
    output.hidden = false;
    output.className = "output";
    output.textContent = `Running…`;
    const run = await api("/api/run-hook", { method: "POST", body: JSON.stringify({ path: p.path, command }) })
      .catch((err) => ({ ok: false, code: -1, output: err.message }));
    output.classList.toggle("failed", !run.ok);
    output.textContent = (run.output || "(no output)") + (run.ok ? "" : `\n\nFailed (exit code ${run.code})`);
  };
  input.onkeydown = descInput.onkeydown = tagsInput.onkeydown = (e) => {
    if (e.key === "Enter") e.preventDefault(), propsDialog.close("save");
  };

  propsDialog.returnValue = "";
  propsDialog.showModal();
  descInput.focus();
  if (contents) {
    api(`/api/folder-size?path=${encodeURIComponent(p.path)}`).then((t) => {
      const count = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
      contents.replaceChildren(`${t.complete ? "" : "at least "}${count(t.files, "file")}, ${count(t.dirs, "folder")} · ${formatSize(t.bytes)}`);
    }, () => contents.replaceChildren("?"));
  }
  propsDialog.addEventListener("close", async () => {
    grid.focus({ preventScroll: true });
    if (propsDialog.returnValue !== "save") return;
    const changes = {};
    const description = descInput.value.trim(), onChange = input.value.trim();
    if (description !== (p.meta?.description ?? "")) changes.description = description;
    const tags = splitTags(tagsInput.value);
    if (tags.join("\n") !== (p.meta?.tags ?? []).join("\n")) changes.tags = tags;
    if (p.kind === "file" && onChange !== (p.meta?.onChange ?? "")) changes.onChange = onChange;
    if (p.kind === "folder" && autoBox.checked !== !!p.meta?.autoTags) changes.autoTags = autoBox.checked;
    if (!Object.keys(changes).length) return;
    try {
      await api("/api/meta", { method: "PUT", body: JSON.stringify({ path: p.path, ...changes }) });
      if ("onChange" in changes) flashStatus(onChange ? `${p.name}: when it changes, phil runs ${onChange}` : `${p.name}: nothing runs when it changes`);
      refresh();
      if ((changes.tags?.length || "autoTags" in changes) && state.autoTagged) thumbs.tag(state.path); // the tag list may have grown
    } catch (err) {
      alert(`Couldn't save: ${err.message}`);
    }
  }, { once: true });
}

// rwxr-xr-x, with a leading d for a folder, and setuid, setgid and sticky
// shown as ls does. (Of what a link points to: a link's own are always rwx.)
function permissionString({ mode, kind }) {
  const type = kind === "folder" ? "d" : "-";
  let out = "";
  for (const [shift, special, letter] of [[6, 0o4000, "s"], [3, 0o2000, "s"], [0, 0o1000, "t"]]) {
    const bits = (mode >> shift) & 7, x = bits & 1, sp = mode & special;
    out += (bits & 4 ? "r" : "-") + (bits & 2 ? "w" : "-") + (sp ? (x ? letter : letter.toUpperCase()) : x ? "x" : "-");
  }
  return type + out;
}

function accessText({ access, owner, kind }) {
  const folder = kind === "folder";
  if (access.write) return folder ? "can change what's in it" : "can read and change it";
  if (!access.read) return `can't ${folder ? "open" : "read"} it`;
  if (folder) return "can look inside, not change what's in it";
  return `can read it; saving it in the editors asks for your sudo password${owner === "root" ? " (it's root's)" : ""}`;
}

// A hook ran (the server sends it to the windows showing the folder).
function onHookRan({ path, command, ok, code, output }) {
  const name = path.split("/").pop();
  if (ok) return flashStatus(`${name} changed: ran ${command}`);
  const why = output.trim().split("\n").at(-1) || `exit code ${code}`;
  flashStatus(`${name} changed: ${command} failed: ${why}`, 10000);
}

// ---------------------------------------------------------------- events

const tileIndex = (target) => {
  const tile = target.closest(".tile");
  return tile ? Number(tile.dataset.index) : -1;
};

grid.addEventListener("click", (e) => {
  if (suppressClick || inRename(e)) return; // suppressClick: the click that ends a rubber-band drag
  select(tileIndex(e.target), { scroll: false, toggle: e.ctrlKey || e.metaKey, extend: e.shiftKey });
});

// Rubber-band selection: dragging anywhere in the grid (on tiles too, since
// they fill it) draws a rectangle and selects what it touches. It only starts
// after the pointer moves a few pixels, so clicks and double-clicks are
// unaffected. Ctrl/Shift add to the existing selection. Near the top or bottom
// edge the grid scrolls.
let band = null;
let suppressClick = false;

function contentPoint(clientX, clientY) {
  const r = grid.getBoundingClientRect();
  return { x: clientX - r.left + grid.scrollLeft, y: clientY - r.top + grid.scrollTop };
}

// WebKit starts its own gestures on a mouse press: dragging the thumbnail
// image, or a selection drag on empty space (during which the page isn't
// repainted, so the rectangle never shows). Cancelling the press's default
// action stops both; the grid then has to take focus itself.
grid.addEventListener("mousedown", (e) => {
  if (inRename(e)) return; // clicks in the name field place the cursor
  if (startsFileDrag(e)) return void grid.focus({ preventScroll: true }); // the native drag, of files (below)
  if (e.target === grid && e.offsetX >= grid.clientWidth) return; // the scrollbar
  if (e.button === 0 || e.button === 1) e.preventDefault(); // no native drag; middle: no autoscroll or paste
  if (e.button !== 2) grid.focus({ preventScroll: true });
});
grid.addEventListener("selectstart", (e) => inRename(e) || e.preventDefault());

grid.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || inRename(e) || (e.target === grid && e.offsetX >= grid.clientWidth)) return; // not the scrollbar
  if (startsFileDrag(e)) return;
  addEventListener("pointermove", moveBand);
  addEventListener("pointerup", endBand);
  addEventListener("pointercancel", endBand);
  band = {
    id: e.pointerId,
    start: contentPoint(e.clientX, e.clientY),
    startClient: [e.clientX, e.clientY],
    client: [e.clientX, e.clientY],
    additive: e.ctrlKey || e.metaKey || e.shiftKey,
    active: false,
  };
});

// Followed on the window rather than with pointer capture, so the drag keeps
// working outside the grid in every engine.
function moveBand(e) {
  if (!band || e.pointerId !== band.id) return;
  band.client = [e.clientX, e.clientY];
  if (!band.active) {
    if (Math.hypot(e.clientX - band.startClient[0], e.clientY - band.startClient[1]) < 5) return;
    startBand();
  }
  updateBand();
}

function startBand() {
  band.active = true;
  hideContextMenu();
  band.base = band.additive ? new Set(state.marked) : new Set();
  band.tiles = [...tiles.values()].map((t) => ({
    index: Number(t.dataset.index),
    x: t.offsetLeft,
    y: t.offsetTop,
    w: t.offsetWidth,
    h: t.offsetHeight,
  }));
  band.el = Object.assign(document.createElement("div"), { className: "rubber-band" });
  grid.append(band.el);
  edgeScroll(() => band?.active && band.client[1], updateBand);
}

// While a drag is near the grid's top or bottom edge, scroll it (faster the
// closer to the edge). `clientY()` returns false once the drag is over.
function edgeScroll(clientY, onScroll) {
  const step = () => {
    const y = clientY();
    if (y === false || y === undefined) return;
    const r = grid.getBoundingClientRect();
    const edge = 40;
    const speed = y < r.top + edge ? -(r.top + edge - y) : y > r.bottom - edge ? y - (r.bottom - edge) : 0;
    if (speed) {
      grid.scrollTop += Math.max(-40, Math.min(40, speed / 2));
      onScroll();
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------- drag and drop

// Right-drag or middle-drag a selection onto a folder (a folder tile, a path
// segment in the top bar, or a place in the sidebar). Dropping a right-drag
// asks "Move to / Copy to"; a middle-drag moves right away.
let drag = null;

grid.addEventListener("pointerdown", (e) => {
  if ((e.button !== 1 && e.button !== 2) || inRename(e)) return;
  const i = tileIndex(e.target);
  if (i === -1) return;
  drag = { id: e.pointerId, button: e.button, index: i, start: [e.clientX, e.clientY], client: [e.clientX, e.clientY] };
  addEventListener("pointermove", moveDrag);
  addEventListener("pointerup", endDrag);
  addEventListener("pointercancel", endDrag);
});

function moveDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  drag.client = [e.clientX, e.clientY];
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.start[0], e.clientY - drag.start[1]) < 6) return;
    startDrag();
  }
  if (outsideWindow(e) && native) return dragOut();
  updateDrag();
}

const native = window.webkit?.messageHandlers?.phil; // the engine's window (not --browser)
document.documentElement.addEventListener("mouseleave", () => drag?.active && native && dragOut()); // in case moves outside aren't reported
const outsideWindow = (e) => e.clientX < 0 || e.clientY < 0 || e.clientX >= innerWidth || e.clientY >= innerHeight;

// A right- or middle-drag leaving the window goes on as the desktop's drag of
// the files (the engine starts it: engine/window.js), like a left-drag (see
// fileDrag below): a middle-drag lets the place it's dropped on move them, a
// right-drag lets it ask (or copy, or move).
function dragOut() {
  const d = drag;
  removeEventListener("pointermove", moveDrag);
  removeEventListener("pointerup", endDrag);
  removeEventListener("pointercancel", endDrag);
  drag = null;
  d.ghost.remove();
  document.body.classList.remove("dragging");
  d.target?.el.classList.remove("drop-target");
  fileDrag = { items: d.items, paths: d.paths, dirs: d.dirs, button: d.button };
  native.postMessage("drag:" + JSON.stringify({
    uris: d.items.map((m) => fileUri(m.path)),
    paths: d.items.map((m) => m.path),
    button: d.button + 1, // GTK's numbering: 2 middle, 3 right
    actions: d.button === 1 ? ["move", "copy"] : ["ask", "copy", "move"],
    image: d.picture.toDataURL("image/png"), // the same picture as inside the window
    scale: d.picture.scale,
    hotspot: DRAG_HOTSPOT,
  }));
}

function startDrag() {
  drag.active = true;
  hideContextMenu();
  if (!state.marked.has(state.view[drag.index].path)) select(drag.index, { scroll: false });
  drag.items = markedEntries();
  drag.paths = new Set(drag.items.map((e) => e.path));
  drag.dirs = drag.items.filter((e) => e.kind === "dir").map((e) => e.path + "/");
  const ghost = (drag.ghost = document.createElement("div"));
  ghost.className = "drag-ghost";
  drag.picture = dragPicture(drag.items, state.view[drag.index]);
  drag.label = Object.assign(document.createElement("span"), { className: "drag-action" });
  ghost.append(drag.picture, drag.label);
  document.body.append(ghost);
  document.body.classList.add("dragging");
  edgeScroll(() => drag?.active && drag.client[1], updateDrag);
}

// What a drag of `items` looks like, whichever button and wherever it goes (in
// the window, or out as files: then WebKit or the engine shows it): up to
// three of their pictures stacked, with how many there are, and the name (or
// "4 items") on a card. A canvas, drawn at the screen's scale (`.scale`), so
// the engine gets the same pixels.
const DRAG_HOTSPOT = [-12, -12]; // the pointer, from the picture's top left corner
const STACK = { w: 96, h: 54, step: 7, most: 3 };

// `front`: the item the drag started on, shown in front.
function dragPicture(items, front = items[0]) {
  const css = getComputedStyle(document.body);
  const color = (name) => css.getPropertyValue(name).trim();
  const scale = Math.max(1, Math.round(devicePixelRatio));
  const font = `600 13px ${css.fontFamily}`;
  const label = items.length === 1 ? items[0].name : `${items.length} items`;
  const shown = [front, ...items.filter((m) => m !== front)].slice(0, STACK.most);
  const pad = 6, gap = 10;
  const stackW = STACK.w + (shown.length - 1) * STACK.step, stackH = STACK.h + (shown.length - 1) * STACK.step;
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = font;
  const text = fitText(measure, label, 220);
  const width = Math.ceil(pad + stackW + gap + measure.measureText(text).width + 12);
  const height = stackH + 2 * pad;
  const canvas = Object.assign(document.createElement("canvas"), { width: width * scale, height: height * scale });
  canvas.style.cssText = `width: ${width}px; height: ${height}px;`;
  canvas.scale = scale;
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  roundRect(ctx, 0.5, 0.5, width - 1, height - 1, 8);
  ctx.fillStyle = color("--bg-raised");
  ctx.fill();
  ctx.strokeStyle = color("--border");
  ctx.stroke();

  // The stack: the first item in front, at the bottom left; the others behind, up and to the right.
  for (let j = shown.length - 1; j >= 0; j--) {
    const x = pad + j * STACK.step, y = pad + (shown.length - 1 - j) * STACK.step;
    ctx.save();
    roundRect(ctx, x, y, STACK.w, STACK.h, 4);
    ctx.clip();
    ctx.fillStyle = shown[j].kind === "dir" ? color("--folder") : color("--thumb-bg");
    ctx.fillRect(x, y, STACK.w, STACK.h);
    const source = pictureOf(shown[j]);
    if (source) drawCover(ctx, source, x, y, STACK.w, STACK.h);
    else drawKind(ctx, shown[j], x, y, color, css.fontFamily);
    ctx.restore();
    roundRect(ctx, x + 0.5, y + 0.5, STACK.w - 1, STACK.h - 1, 4);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
    ctx.stroke();
  }
  if (items.length > 1) { // how many, on the stack's top right corner
    const r = 10, cx = pad + stackW - 4, cy = pad + 4;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.fillStyle = color("--accent");
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `700 ${items.length > 99 ? 9 : 11}px ${css.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(items.length), cx, cy + 0.5);
  }
  ctx.font = font;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color("--text");
  ctx.fillText(text, pad + stackW + gap, height / 2);
  return canvas;
}

// What a tile shows of the item: its thumbnail, its drawn text, or its folder's first preview.
function pictureOf(item) {
  const tile = tiles.get(item.path);
  const el = tile?.querySelector(":scope > .thumb > img, :scope > .thumb > canvas, .face > img, .face > .cell > canvas");
  if (el instanceof HTMLImageElement) return el.complete && el.naturalWidth ? el : null;
  return el?.width ? el : null;
}

// No picture: what kind it is, as on a tile without one (a folder, or the file's extension).
function drawKind(ctx, item, x, y, color, family) {
  const cx = x + STACK.w / 2, cy = y + STACK.h / 2;
  if (item.kind === "dir") { // a folder: its tab, and its front
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.beginPath();
    ctx.roundRect(cx - 12, cy - 9, 10, 4, 1.5);
    ctx.roundRect(cx - 12, cy - 6, 24, 15, 2);
    ctx.fill();
    return;
  }
  ctx.fillStyle = color("--text-dim");
  ctx.font = `700 10px ${family}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText((item.name.match(/\.([^.]{1,5})$/)?.[1] ?? "file").toUpperCase(), cx, cy);
}

function drawCover(ctx, source, x, y, w, h) {
  const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
  const k = Math.max(w / sw, h / sh);
  const cw = w / k, ch = h / k;
  ctx.drawImage(source, (sw - cw) / 2, (sh - ch) / 2, cw, ch, x, y, w, h);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function fitText(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  while (text.length > 1 && ctx.measureText(text + "…").width > max) text = text.slice(0, -1);
  return text + "…";
}

// The folder under the pointer, if the dragged items (`drag`, or a file drag
// below) can go there.
function dropTargetAt(x, y, drag) {
  const el = document.elementFromPoint(x, y);
  const tile = el?.closest(".tile");
  const target = tile ? state.view[tile.dataset.index] : null;
  const path = target ? (target.kind === "dir" ? target.path : null) : el?.closest("[data-path]")?.dataset.path;
  if (!path || path === state.path || drag.paths.has(path)) return null;
  if (drag.dirs.some((d) => (path + "/").startsWith(d))) return null; // into itself
  return { path, el: tile ?? el.closest("[data-path]") };
}

function updateDrag() {
  const [x, y] = drag.client;
  drag.ghost.style.transform = `translate(${x - DRAG_HOTSPOT[0]}px, ${y - DRAG_HOTSPOT[1]}px)`;
  const target = dropTargetAt(x, y, drag);
  if (target?.el !== drag.target?.el) {
    drag.target?.el.classList.remove("drop-target");
    target?.el.classList.add("drop-target");
  }
  drag.target = target;
  const verb = drag.button === 1 ? "Move" : "Move or copy";
  drag.label.textContent = target ? `${verb} to ${target.path.split("/").pop() || "/"}` : "";
}

function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  removeEventListener("pointermove", moveDrag);
  removeEventListener("pointerup", endDrag);
  removeEventListener("pointercancel", endDrag);
  const d = drag;
  drag = null;
  if (!d.active) {
    if (d.wantsMenu) { // a plain right click
      if (!state.marked.has(state.view[d.index].path)) select(d.index, { scroll: false });
      showContextMenu(e.clientX, e.clientY, state.view[d.index]);
    }
    return;
  }
  d.ghost.remove();
  document.body.classList.remove("dragging");
  d.target?.el.classList.remove("drop-target");
  if (e.type === "pointercancel") return;
  d.target = dropTargetAt(e.clientX, e.clientY, d); // where it's let go
  if (!d.target) return;
  const name = d.target.path.split("/").pop() || "/";
  if (d.button === 1) return transfer("move", d.items, d.target.path);
  showMenu(e.clientX, e.clientY, [
    [`Move to “${name}”`, () => transfer("move", d.items, d.target.path)],
    [`Copy to “${name}”`, () => transfer("copy", d.items, d.target.path)],
  ]);
}

// Dragging files out of phil: a left-drag that starts on a selected tile (no
// Ctrl or Shift) is the webview's own drag, carrying the selection as files
// (their file:// URIs), for a browser's page, another file manager, a chat...
// to take. A right- or middle-drag becomes one when it leaves the window
// (dragOut). Dropped on a folder in phil itself, a middle-drag moves there
// and the others ask "Move to / Copy to". (Started anywhere else, a left-drag
// draws the selection rectangle.)
let fileDrag = null; // { items, paths, dirs, button, target }

function startsFileDrag(e) {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || inRename(e)) return false;
  const i = tileIndex(e.target);
  return i !== -1 && state.marked.has(state.view[i].path);
}

const fileUri = (path) => "file://" + path.split("/").map(encodeURIComponent).join("/");

grid.addEventListener("dragstart", (e) => {
  const i = tileIndex(e.target);
  if (i === -1 || !state.marked.has(state.view[i].path)) return e.preventDefault();
  hideContextMenu();
  const items = markedEntries();
  // The drag's picture, the same as a right-drag's: WebKit takes it from the
  // page, so it's put there (where it shows during the drag anyway) for now.
  const picture = dragPicture(items, state.view[i]);
  picture.style.cssText += `position: fixed; z-index: 30; left: ${e.clientX - DRAG_HOTSPOT[0]}px; top: ${e.clientY - DRAG_HOTSPOT[1]}px;`;
  document.body.append(picture);
  e.dataTransfer.setDragImage(picture, DRAG_HOTSPOT[0], DRAG_HOTSPOT[1]);
  setTimeout(() => picture.remove());
  fileDrag = { items, paths: new Set(items.map((m) => m.path)), dirs: items.filter((m) => m.kind === "dir").map((m) => m.path + "/"), button: 0 };
  e.dataTransfer.effectAllowed = "copyMove";
  e.dataTransfer.setData("text/uri-list", items.map((m) => fileUri(m.path)).join("\r\n"));
  e.dataTransfer.setData("text/plain", items.map((m) => m.path).join("\n"));
});

// Whatever is dragged over the window, nothing dropped on it loads in it (the
// webview would open a dropped file in place of phil).
addEventListener("dragover", (e) => {
  e.preventDefault();
  const target = fileDrag && dropTargetAt(e.clientX, e.clientY, fileDrag);
  if (target?.el !== fileDrag?.target?.el) {
    fileDrag.target?.el.classList.remove("drop-target");
    target?.el.classList.add("drop-target");
  }
  if (fileDrag) fileDrag.target = target;
  e.dataTransfer.dropEffect = target ? "move" : "none";
});
addEventListener("drop", (e) => {
  e.preventDefault();
  const target = fileDrag?.target;
  const { items, button } = fileDrag ?? {};
  endFileDrag();
  if (!target) return;
  if (button === 1) return transfer("move", items, target.path);
  const name = target.path.split("/").pop() || "/";
  showMenu(e.clientX, e.clientY, [
    [`Move to “${name}”`, () => transfer("move", items, target.path)],
    [`Copy to “${name}”`, () => transfer("copy", items, target.path)],
  ]);
});
function endFileDrag() {
  fileDrag?.target?.el.classList.remove("drop-target");
  fileDrag = null;
}
addEventListener("dragend", endFileDrag);
// A drag the engine started ends without telling the page: the pointer
// moving in the window again means it's over.
addEventListener("pointermove", (e) => fileDrag && fileDrag.button !== 0 && !outsideWindow(e) && endFileDrag());

// A link to the file in Documents/Config (see addToConfig in server.js).
async function addToConfig(entry) {
  try {
    const { name, existed } = await api("/api/add-to-config", { method: "POST", body: JSON.stringify({ path: entry.path }) });
    flashStatus(existed ? `${entry.name} is already in Documents/Config (as ${name})` : `Added to Documents/Config as ${name}`);
  } catch (err) {
    alert(`Couldn't add ${entry.name} to Config: ${err.message}`);
  }
}

// A message in the status bar, shown for a few seconds even if the bar is hidden.
function flashStatus(text, ms = 3500) {
  const bar = $("#status"), el = $("#status-progress");
  el.textContent = text;
  bar.classList.add("show");
  clearTimeout(flashStatus.timer);
  flashStatus.until = Date.now() + ms;
  flashStatus.timer = setTimeout(() => {
    bar.classList.remove("show");
    if (el.textContent === text) updateProgress();
  }, ms);
}

async function transfer(op, items, dest) {
  const progress = $("#status-progress");
  progress.textContent = `${op === "move" ? "Moving" : "Copying"} ${items.length} item${items.length === 1 ? "" : "s"}…`;
  let result;
  try {
    result = await api("/api/transfer", { method: "POST", body: JSON.stringify({ op, dest, paths: items.map((e) => e.path) }) });
  } catch (err) {
    result = { errors: [{ path: "", error: err.message }] };
  }
  progress.textContent = "";
  updateProgress();
  await load(state.path);
  if (result.errors.length) {
    alert(`Couldn't ${op} ${result.errors.length} item(s):\n` +
      result.errors.map((e) => `${e.path.split("/").pop()}: ${e.error}`).join("\n"));
  }
}

function updateBand() {
  const end = contentPoint(...band.client);
  const left = Math.min(band.start.x, end.x), top = Math.min(band.start.y, end.y);
  const right = Math.max(band.start.x, end.x), bottom = Math.max(band.start.y, end.y);
  Object.assign(band.el.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
  const hits = band.tiles.filter((t) => t.x < right && t.x + t.w > left && t.y < bottom && t.y + t.h > top);
  setMarked([...band.base, ...hits.map((t) => state.view[t.index].path)]);
  band.first = hits.length ? Math.min(...hits.map((t) => t.index)) : -1;
  updateStatus();
}

function endBand(e) {
  if (!band || e.pointerId !== band.id) return;
  removeEventListener("pointermove", moveBand);
  removeEventListener("pointerup", endBand);
  removeEventListener("pointercancel", endBand);
  if (band.active) {
    band.el.remove();
    if (band.first !== -1) state.selected = state.anchor = band.first; // keyboard continues from here
    suppressClick = true;
    setTimeout(() => (suppressClick = false));
    updateStatus();
  }
  band = null;
}
grid.addEventListener("dblclick", (e) => inRename(e) || open(tileIndex(e.target)));
grid.addEventListener("contextmenu", (e) => {
  const i = tileIndex(e.target);
  // The webview's own menu: Paste in the name field; Shift+right-click on empty space for Inspect Element.
  if (inRename(e) || (i === -1 && e.shiftKey)) return;
  e.preventDefault();
  if (i === -1) return showMenu(e.clientX, e.clientY, newItemsIn(state.path)); // the empty space
  // On Linux this fires when the button goes down. A right press may become a
  // drag, so the menu waits for the release (see endDrag).
  if (drag?.button === 2) return void (drag.wantsMenu = true);
  if (!state.marked.has(state.view[i].path)) select(i, { scroll: false });
  showContextMenu(e.clientX, e.clientY, state.view[i]);
});
grid.addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(state.settings.zoom - Math.sign(e.deltaY) * 16);
}, { passive: false });
grid.addEventListener("scroll", hideContextMenu, { passive: true });
document.addEventListener("mousedown", (e) => {
  if (!contextMenu.contains(e.target)) hideContextMenu();
});

$("#btn-back").onclick = () => history.back();
$("#btn-close").onclick = closeWindow;
$("#btn-forward").onclick = () => history.forward();
$("#btn-up").onclick = () => parentOf(state.path) && navigate(parentOf(state.path));
$("#btn-new").onclick = () => createIn(state.path, "dir");
// The sidebar's empty space (the places have their own menu): new in the folder shown.
$("#sidebar").addEventListener("contextmenu", (e) => {
  if (e.target.closest("a, button, input") || e.shiftKey) return;
  e.preventDefault();
  showMenu(e.clientX, e.clientY, newItemsIn(state.path));
});

crumbs.addEventListener("click", editLocation);
locationInput.addEventListener("blur", closeLocation);
locationInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const value = locationInput.value.trim().replace(/^~(?=\/|$)/, state.init.home);
    closeLocation();
    if (value.startsWith("/")) navigate(value.replace(/(.)\/+$/, "$1"));
    grid.focus();
  } else if (e.key === "Escape") {
    closeLocation();
    grid.focus();
  }
});

filterInput.addEventListener("input", () => {
  render();
  searchPictures();
});
filterInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    filterInput.value = "";
    render();
    grid.focus();
  } else if (e.key === "Enter" || e.key === "ArrowDown") {
    if (state.selected === -1 && state.view.length) select(0);
    grid.focus();
    e.preventDefault();
  }
});

sortSelect.addEventListener("change", () => {
  state.settings.sort = sortSelect.value;
  saveSettings();
  render();
});

hiddenButton.addEventListener("click", toggleHidden);
function toggleHidden() {
  state.settings.showHidden = !state.settings.showHidden;
  applySettings();
  saveSettings();
  render();
}

$("#btn-sidebar").addEventListener("click", toggleSidebar);
$("#btn-terminal").addEventListener("click", toggleTerminal);

// ---------------------------------------------------------------- terminal panel

const termPanel = $("#term-panel");
const terminal = new TerminalPanel({
  panel: termPanel,
  container: $("#term"),
  onCwd: (path) => path !== state.path && navigate(path),
  onBack: () => terminal.follow(state.path),
  onOpen: ({ app, params }) => openInApp(app, params), // phil-editor (ed) typed in the panel
  isLocal: (host) => ["localhost", state.init.hostname.toLowerCase()].includes(host.toLowerCase()),
  toLocal: (host, dir) => localOf(host, dir),
  toRemote: (path) => remoteOf(path),
});

// Reopen the panel on startup if it was open when phil last quit, and select
// files phil was started with (both set at startup, applied after the first load).
let restoreTerminal = false;
let initialSelect = null;

function setTerminalOpen(open, { focus = true } = {}) {
  if (open) terminal.show(state.path, { focus });
  else terminal.hide();
  $("#btn-terminal").setAttribute("aria-pressed", String(open));
  if (!open) grid.focus({ preventScroll: true });
  if (state.settings.termOpen !== open) {
    state.settings.termOpen = open;
    saveSettings(0); // right away: quitting is often the next thing that happens
  }
}

function toggleTerminal() {
  setTerminalOpen(!terminal.isOpen);
}

// Capture phase, so these work while the terminal has focus too: F4 / Ctrl+`
// toggle the panel, Alt+↓ / Alt+↑ move focus to the terminal (opening it) / the
// folder view.
document.addEventListener("keydown", (e) => {
  if (!appView.hidden && e.key === "Escape") return askAppToClose(), e.preventDefault(), e.stopPropagation();
  if (!viewerEl.hidden || !appView.hidden || dialogOpen()) return;
  if (isToggleKey(e)) toggleTerminal();
  else if (isFocusKey(e) && e.key === "ArrowDown") setTerminalOpen(true);
  else if (isFocusKey(e)) grid.focus({ preventScroll: true });
  else return;
  e.preventDefault();
  e.stopPropagation();
}, true);

$("#term-resize").addEventListener("pointerdown", (e) => {
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  const bottom = termPanel.getBoundingClientRect().bottom;
  const move = (ev) => {
    state.settings.termHeight = Math.round(Math.max(80, Math.min(innerHeight - 120, bottom - ev.clientY)));
    termPanel.style.height = `${state.settings.termHeight}px`;
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", () => {
    handle.removeEventListener("pointermove", move);
    saveSettings();
  }, { once: true });
});
zoomInput.addEventListener("input", () => setZoom(Number(zoomInput.value)));

document.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  const handled = () => e.preventDefault();

  if (dialogOpen()) return; // a dialog handles its own keys
  if (typedAhead !== null && !e.ctrlKey && !e.metaKey && !e.altKey) { // a new item's name, before its field is there
    if (e.key.length === 1) return (typedAhead += e.key), handled();
    if (e.key === "Backspace") return (typedAhead = typedAhead.slice(0, -1)), handled();
  }
  if (!contextMenu.hidden && e.key === "Escape") return hideContextMenu(), handled();
  if (e.target.closest?.("#term-panel")) return; // keys typed into the shell are the shell's

  if (!viewerEl.hidden) {
    const inVideo = e.target.tagName === "VIDEO";
    if (e.key === "Escape") viewer.close();
    else if (e.key === "ArrowRight" && !inVideo) viewer.step(1);
    else if (e.key === "ArrowLeft" && !inVideo) viewer.step(-1);
    else if (e.key === "PageDown") viewer.step(1);
    else if (e.key === "PageUp") viewer.step(-1);
    else if (e.key === "f") document.fullscreenElement ? document.exitFullscreen() : viewerEl.requestFullscreen();
    else return;
    return handled();
  }

  if (e.altKey && e.key === "ArrowLeft") return history.back(), handled();
  if (e.altKey && e.key === "ArrowRight") return history.forward(), handled();
  if ((e.key === "Backspace" || e.key === "Escape") && e.target === grid) return $("#btn-up").click(), handled();
  // Insert: a new folder; Super+Insert: a new file (Ctrl+ and Shift+Insert are the clipboard's).
  if (e.key === "Insert" && !e.ctrlKey && !e.shiftKey && !e.altKey && (e.target === grid || e.target === document.body)) {
    return createIn(state.path, e.metaKey ? "file" : "dir"), handled();
  }
  if (ctrl && e.key === "l") return editLocation(), handled();
  if ((ctrl && e.key === "f") || (e.key === "/" && e.target === grid)) return filterInput.focus(), filterInput.select(), handled();
  if (ctrl && e.key === "h") return toggleHidden(), handled();
  if (e.key === "F9") return toggleSidebar(), handled();
  if (ctrl && (e.key === "=" || e.key === "+")) return setZoom(state.settings.zoom + 16), handled();
  if (ctrl && e.key === "-") return setZoom(state.settings.zoom - 16), handled();
  if (e.key === "F5" || (ctrl && e.key === "r")) return load(state.path), handled();

  if (e.target !== grid || !state.view.length) return;
  const cols = columns();
  const last = state.view.length - 1;
  const cur = state.selected;
  const rowsPerPage = Math.max(1, Math.floor(grid.clientHeight / (grid.firstElementChild.offsetHeight + 2)));
  const move = {
    ArrowRight: cur + 1,
    ArrowLeft: cur - 1,
    ArrowDown: cur === -1 ? 0 : cur + cols,
    ArrowUp: cur - cols,
    Home: 0,
    End: last,
    PageDown: cur + cols * rowsPerPage,
    PageUp: cur - cols * rowsPerPage,
  }[e.key];
  if (move !== undefined) {
    select(Math.max(0, Math.min(last, move)), { extend: e.shiftKey });
    return handled();
  }
  if (e.shiftKey && e.key === "Delete") return deleteMarked(), handled();
  if (e.key === "F2") return startRename(cur), handled();
  if (e.altKey && e.key === "Enter" && cur !== -1) return showProperties(state.view[cur]), handled();
  if (ctrl && e.key === "a") return setMarked(state.view.map((v) => v.path)), updateStatus(), handled();
  // Ctrl+C / Ctrl+Insert / Super+C: the selected files' paths, one per line.
  if (clipboardKey(e) === "copy" && state.marked.size) return copyText(markedEntries().map((m) => m.path).join("\n")), handled();
  if (e.key === "Enter" || (e.key === " " && !typed)) return open(cur), handled();
  if (e.key.length === 1 && !ctrl && !e.altKey) return typeAhead(e.key), handled();
});

// ---------------------------------------------------------------- start

// phil keeps its window hidden until the page is styled and running (engine/window.js).
ready(JSON.stringify({ script: Math.round(performance.now()) }));
state.init = await api("/api/init");
Object.assign(state.settings, state.init.settings);
applySettings();
listThemes();
const thumbDirEl = $("#status-thumbdir");
thumbDirEl.textContent = (state.init.incognito ? "Incognito · " : "") + `Thumbnails: ${state.init.thumbDir}`;
thumbDirEl.title = `${state.init.thumbDir} (${state.init.thumbSize})`;
thumbs.connect();

restoreTerminal = state.settings.termOpen;
// Files to select, from ?select= (phil file..., "Show in folder"); dropped from
// the URL so they aren't reselected later.
const selectParams = new URLSearchParams(location.search).getAll("select");
initialSelect = selectParams.length ? selectParams : null;
if (location.search) history.replaceState(null, "", location.pathname + location.hash);
document.body.classList.toggle("incognito", state.init.incognito);
if (location.hash.length > 1) load(decodeURIComponent(location.hash.slice(1)));
else navigate(state.init.start);
holdFocus(grid);
