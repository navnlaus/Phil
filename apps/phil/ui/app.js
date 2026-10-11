import { appUrl, clipboardKey, closeWindow, copyText, holdFocus, ready } from "/engine/ui/kit.js";
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
// How names and details sit on the tiles (ui/style.css). Chosen with "theme" in
// ~/.config/phil/settings.json; phil only reads it.
const THEMES = ["overlay", "strip", "below", "chips"];
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
const isMedia = (e) => e.kind === "image" || e.kind === "video"; // what the viewer shows
const hasThumb = (e) => isMedia(e) || e.kind === "pdf"; // its first page

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
      this.flush();
    };
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if ("theme" in msg) return setTheme(msg.theme);
      if ("changed" in msg) return onFolderChanged(msg);
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
  if (near && entry.kind === "dir") return drawFolderTexts(tile), wantSummary(tile, entry);
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
  const height = (body) => lines.reduce((sum, [kind]) => sum + sizeOf(kind, body) * LINE_HEIGHT, 0);
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
  let y = pad * 0.6;
  lines.forEach(([kind, text], i) => {
    const size = sizeOf(kind, body);
    y += size * LINE_HEIGHT;
    if (y - size > h || !text.trim()) return;
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
}

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
  if (previous !== listing.path) changedFolders.clear();
  thumbs.watch(listing.path);
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
  } else if (!listing && state.path === path) {
    showGridMessage(`${path} is gone.`);
  }
  if (refreshAgain) {
    refreshAgain = false;
    refresh();
  }
}

function sortEntries(list) {
  const by = {
    name: (a, b) => collator.compare(a.name, b.name),
    mtime: (a, b) => b.mtime - a.mtime,
    size: (a, b) => b.size - a.size,
    kind: (a, b) => collator.compare(a.kind, b.kind) || collator.compare(ext(a.name), ext(b.name)),
  }[state.settings.sort];
  const ext = (name) => name.slice(name.lastIndexOf(".") + 1);
  list.sort((a, b) => (b.kind === "dir") - (a.kind === "dir") || by(a, b) || collator.compare(a.name, b.name));
}

function render(selectPath = state.view[state.selected]?.path) {
  const q = filterInput.value.trim().toLowerCase();
  state.view = state.entries.filter((e) =>
    (state.settings.showHidden || !e.name.startsWith(".")) && (!q || e.name.toLowerCase().includes(q))
  );
  sortEntries(state.view);

  nearObserver.disconnect();
  farObserver.disconnect();
  // Tiles of entries that haven't changed are kept, with their loaded images.
  const old = new Map(tiles);
  tiles.clear();
  const frag = document.createDocumentFragment();
  state.view.forEach((entry, i) => {
    let tile = old.get(entry.path);
    if (tile?.dataset.sig === tileSig(entry) && !tile.classList.contains("renaming")) {
      tile.dataset.index = i;
      tile.classList.remove("selected");
      if (entry.kind === "dir") showFolderInfo(tile, entry);
      old.delete(entry.path);
    } else {
      tile = makeTile(entry, i);
    }
    tiles.set(entry.path, tile);
    frag.append(tile);
  });
  for (const path of old.keys()) thumbs.cancel(path);
  grid.replaceChildren(frag);
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
const tileSig = (e) => (e.kind === "dir" ? "dir" : `${e.kind} ${e.size} ${e.mtime} ${e.onChange ?? ""}`);

function makeTile(entry, index) {
  const tile = document.createElement("div");
  tile.className = `tile ${entry.kind}${entry.name.startsWith(".") ? " hidden-file" : ""}`;
  tile.dataset.index = index;
  tile.dataset.sig = tileSig(entry);

  const box = document.createElement("div");
  box.className = "thumb";
  if (entry.kind !== "dir") {
    box.innerHTML = icon(KIND_ICON[entry.kind], "kind") + (entry.kind === "video" ? `<span class="badge">${icon("play")}</span>` : "") +
      (entry.onChange ? `<span class="badge hook">${icon("bolt")}</span>` : "");
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
  label.append(name, meta);
  tile.append(box, label);
  if (entry.kind === "dir") showFolderInfo(tile, entry);
  else {
    meta.textContent = [fileType(entry.name).toUpperCase(), formatSize(entry.size), formatShortDate(entry.mtime)].filter(Boolean).join(" · ");
    tile.title = `${entry.name}\n${formatSize(entry.size)} · ${formatDate(entry.mtime)}` + (entry.onChange ? `\nWhen it changes: ${entry.onChange}` : "");
  }
  return tile;
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
  meta.textContent = summary ? folderContents(summary) : "";
  tile.title = entry.name + (meta.textContent ? `\n${meta.textContent}` : "");
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

function folderContents({ files, dirs, size }) {
  const count = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
  const parts = [];
  if (dirs) parts.push(count(dirs, "folder"));
  if (files) parts.push(count(files, "file"), formatSize(size));
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
    if (remoteOf(p.path)) {
      a.title += `\nDouble-click: SSH to ${remoteOf(p.path).host}`;
      a.ondblclick = (e) => (e.preventDefault(), sshTo(p.path));
      a.oncontextmenu = (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [["Open", () => navigate(p.path)], [`SSH here (${remoteOf(p.path).host})`, () => sshTo(p.path)]]);
      };
    }
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
  document.body.dataset.theme = THEMES.includes(s.theme) ? s.theme : "overlay";
  redrawTexts();
  termPanel.style.height = `${s.termHeight}px`;
}

function setTheme(theme) {
  state.settings.theme = theme;
  applySettings();
}

function toggleSidebar() {
  state.settings.sidebar = !state.settings.sidebar;
  applySettings();
  saveSettings();
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
  else if (entry.kind === "image") viewer.open(index);
  // mpv plays everything; WebKit's player stalls on some files (NVIDIA decoding).
  else if (entry.kind === "video") openExternal(entry.path, "mpv");
  else if (entry.kind === "pdf") openExternal(entry.path);
  else if (isJson(entry)) openInApp("jsonedit", { file: entry.path });
  else openFile(entry);
}

const isJson = (entry) => entry.kind === "file" && /\.json$/i.test(entry.name);

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
  const frame = Object.assign(document.createElement("iframe"), { src: appUrl(app, params), title: app });
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
addEventListener("message", (e) => {
  const frame = appView.querySelector("iframe");
  if (!frame || e.source !== frame.contentWindow) return;
  if (e.data?.engine === "ready") {
    frame.focus();
    frame.contentWindow.focus();
    frame.contentWindow.postMessage({ engine: "focus" }, "*"); // now it can focus its view (kit.js holdFocus)
  } else if (e.data?.engine === "close") {
    closeApp();
  }
});

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
      if (isMedia(state.view[i])) return this.show(i);
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

    if (entry.kind === "image") {
      const img = new Image();
      img.decoding = "async";
      let triedPreview = false;
      img.onerror = () => {
        // Formats the webview can't decode (HEIC, TIFF, ...) get converted by vips on the server.
        if (triedPreview) return failed("Can't display this image.");
        triedPreview = true;
        img.src = `/preview?path=${encodeURIComponent(entry.path)}&size=${Math.round(screen.width * devicePixelRatio)}`;
      };
      img.src = fileUrl(entry.path);
      stage.append(img);
    } else {
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
    }

    viewerEl.querySelector(".caption").textContent =
      `${entry.name}   ·   ${formatSize(entry.size)}   ·   ${formatDate(entry.mtime)}`;
    viewerEl.querySelector(".open-mpv").hidden = entry.kind !== "video";

    // Warm the cache for the next image.
    const next = state.view.slice(index + 1).find(isMedia);
    if (next?.kind === "image") new Image().src = fileUrl(next.path);
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

function startRename(index) {
  const entry = state.view[index];
  const tile = entry && tiles.get(entry.path);
  if (!tile || renaming) return;
  hideContextMenu();
  const input = Object.assign(document.createElement("input"), { className: "rename", value: entry.name, spellcheck: false });
  tile.classList.add("renaming");
  tile.querySelector(".label").append(input);
  tile.scrollIntoView({ block: "nearest" });
  input.focus();
  const dot = entry.kind === "dir" ? -1 : entry.name.lastIndexOf(".");
  input.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
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
  if (entry.kind === "dir") items.push(["Open", () => navigate(entry.path)]);
  if (entry.kind === "dir" && remoteOf(entry.path)) items.push([`SSH here (${remoteOf(entry.path).host})`, () => sshTo(entry.path)]);
  if (entry.kind === "image") items.push(["View", () => open(state.view.indexOf(entry))]);
  if (entry.kind === "video") items.push(["Play in mpv", () => openExternal(entry.path, "mpv")]);
  if (entry.kind === "video") items.push(["Play here", () => viewer.open(state.view.indexOf(entry))]);
  if (isJson(entry)) items.push(["Edit in jsonedit", () => openInApp("jsonedit", { file: entry.path })]);
  if (entry.kind === "file") items.push(["Edit as text", () => openInApp("textedit", { file: entry.path })]);
  if (isJson(entry) || tiles.get(entry.path)?.firstElementChild.text) items.push(["Add to Config", () => addToConfig(entry)]);
  items.push(["Open with default app", () => openExternal(entry.path)]);
  items.push(["Rename…", () => startRename(state.view.indexOf(entry))]);
  items.push(["Copy path", () => copyText(entry.path)]);
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

  const phil = $p(".phil"), input = $p("#props-hook"), output = $p(".output");
  phil.hidden = p.kind !== "file"; // hooks are for files
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
  input.onkeydown = (e) => {
    if (e.key === "Enter") e.preventDefault(), propsDialog.close("save");
  };

  propsDialog.returnValue = "";
  propsDialog.showModal();
  (phil.hidden ? $p("[value=cancel]") : input).focus();
  if (contents) {
    api(`/api/folder-size?path=${encodeURIComponent(p.path)}`).then((t) => {
      const count = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
      contents.replaceChildren(`${t.complete ? "" : "at least "}${count(t.files, "file")}, ${count(t.dirs, "folder")} · ${formatSize(t.bytes)}`);
    }, () => contents.replaceChildren("?"));
  }
  propsDialog.addEventListener("close", async () => {
    grid.focus({ preventScroll: true });
    const onChange = input.value.trim();
    if (propsDialog.returnValue !== "save" || onChange === (p.meta?.onChange ?? "")) return;
    try {
      await api("/api/meta", { method: "PUT", body: JSON.stringify({ path: p.path, onChange }) });
      flashStatus(onChange ? `${p.name}: when it changes, phil runs ${onChange}` : `${p.name}: nothing runs when it changes`);
      refresh();
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
  if (e.target === grid && e.offsetX >= grid.clientWidth) return; // the scrollbar
  if (e.button === 0 || e.button === 1) e.preventDefault(); // no native drag; middle: no autoscroll or paste
  if (e.button !== 2) grid.focus({ preventScroll: true });
});
grid.addEventListener("dragstart", (e) => e.preventDefault());
grid.addEventListener("selectstart", (e) => inRename(e) || e.preventDefault());

grid.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || inRename(e) || (e.target === grid && e.offsetX >= grid.clientWidth)) return; // not the scrollbar
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
  updateDrag();
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
  const first = drag.items[0];
  if (typeof first.thumb === "string") ghost.append(Object.assign(new Image(), { src: first.thumb, draggable: false }));
  else ghost.insertAdjacentHTML("beforeend", icon(KIND_ICON[first.kind]));
  drag.label = document.createElement("span");
  ghost.append(drag.label);
  document.body.append(ghost);
  document.body.classList.add("dragging");
  edgeScroll(() => drag?.active && drag.client[1], updateDrag);
}

// The folder under the pointer, if the dragged items can go there.
function dropTargetAt(x, y) {
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
  drag.ghost.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
  const target = dropTargetAt(x, y);
  if (target?.el !== drag.target?.el) {
    drag.target?.el.classList.remove("drop-target");
    target?.el.classList.add("drop-target");
  }
  drag.target = target;
  const what = drag.items.length === 1 ? drag.items[0].name : `${drag.items.length} items`;
  const verb = drag.button === 1 ? "Move" : "Move or copy";
  drag.label.textContent = target ? `${verb} ${what} to ${target.path.split("/").pop() || "/"}` : what;
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
  if (!d.target || e.type === "pointercancel") return;
  const name = d.target.path.split("/").pop() || "/";
  if (d.button === 1) return transfer("move", d.items, d.target.path);
  showMenu(e.clientX, e.clientY, [
    [`Move to “${name}”`, () => transfer("move", d.items, d.target.path)],
    [`Copy to “${name}”`, () => transfer("copy", d.items, d.target.path)],
  ]);
}

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
  if (i === -1 || inRename(e)) return; // keep the webview's own menu (Inspect Element, or Paste in the name field)
  e.preventDefault();
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

filterInput.addEventListener("input", () => render());
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
