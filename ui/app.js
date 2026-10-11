import { isToggleKey, shellQuote, TerminalPanel } from "/ui/terminal.js";

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

const KIND_ICON = { dir: "folder", image: "image", video: "video", file: "file" };
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const state = {
  init: null,
  path: null,
  entries: [], // everything in the folder, from the server
  view: [], // filtered + sorted, what the grid shows
  selected: -1, // index into view: the keyboard cursor
  marked: new Set(), // paths of the selected entries (one or more)
  anchor: -1, // where Shift+click / Shift+arrow ranges start
  settings: { sort: "name", showHidden: false, zoom: 224, sidebar: false, termHeight: 260, termOpen: false },
};
const tiles = new Map(); // path -> tile element
const scrollPositions = new Map(); // path -> scrollTop, restored on back/up

// ---------------------------------------------------------------- helpers

const icon = (name, cls = "") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const fileUrl = (path) => `/file?path=${encodeURIComponent(path)}`;
const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");
const parentOf = (path) => (path === "/" ? null : path.replace(/\/[^/]+$/, "") || "/");
const isMedia = (e) => e.kind === "image" || e.kind === "video";

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
// Tiles scrolling out of view cancel their request.
const thumbs = {
  ws: null,
  wanted: new Set(),
  outWant: new Set(),
  outCancel: new Set(),
  scheduled: false,

  connect() {
    this.ws = new WebSocket(`ws://${location.host}/ws`);
    this.ws.onopen = () => {
      this.wanted.forEach((p) => this.outWant.add(p));
      this.flush();
    };
    this.ws.onmessage = (e) => {
      const { path, url } = JSON.parse(e.data);
      if (!this.wanted.delete(path)) return;
      onThumbReady(path, url);
      updateProgress();
    };
    this.ws.onclose = () => setTimeout(() => this.connect(), 1000);
  },
  want(path) {
    if (this.wanted.has(path)) return;
    this.wanted.add(path);
    this.outCancel.delete(path);
    this.outWant.add(path);
    this.schedule();
  },
  cancel(path) {
    if (!this.wanted.delete(path)) return;
    if (!this.outWant.delete(path)) this.outCancel.add(path);
    this.schedule();
  },
  cancelAll() {
    [...this.wanted].forEach((p) => this.cancel(p));
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
    if (!this.outWant.size && !this.outCancel.size) return;
    // The server works through requests last-in-first-out, so send the top of the screen last.
    this.ws.send(JSON.stringify({ cancel: [...this.outCancel], want: [...this.outWant].reverse() }));
    this.outWant.clear();
    this.outCancel.clear();
  },
};

// Thumbnails load a bit ahead of the viewport. Pending requests are cancelled
// as soon as a tile leaves that zone, but loaded images are only dropped once
// they are far away, so scrolling back and forth doesn't re-decode them.
const observe = (margin, fn) =>
  new IntersectionObserver((records) => {
    for (const { target, isIntersecting } of records) {
      const entry = state.view[target.dataset.index];
      if (entry && isMedia(entry)) fn(target, entry, isIntersecting);
    }
  }, { root: grid, rootMargin: `${margin}px 0px` });

const nearObserver = observe(800, (tile, entry, near) => {
  if (near) showThumb(tile, entry);
  else if (entry.thumb === null) {
    tile.firstElementChild.classList.remove("loading");
    thumbs.cancel(entry.path);
  }
});
const farObserver = observe(4000, (tile, _entry, inRange) => {
  if (!inRange) unloadThumb(tile);
});

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
    listing = await api(`/api/list?path=${encodeURIComponent(path)}`);
  } catch (err) {
    showGridMessage(`Can't open ${path}: ${err.message}`);
    return;
  }
  state.path = listing.path;
  terminal.follow(listing.path);
  state.entries = listing.entries;
  document.title = (listing.path === "/" ? "/" : listing.path.split("/").pop()) + " — phil";
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
  thumbs.cancelAll();
  tiles.clear();
  const frag = document.createDocumentFragment();
  state.view.forEach((entry, i) => {
    const tile = makeTile(entry, i);
    tiles.set(entry.path, tile);
    frag.append(tile);
  });
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

function makeTile(entry, index) {
  const tile = document.createElement("div");
  tile.className = `tile ${entry.kind}${entry.name.startsWith(".") ? " hidden-file" : ""}`;
  tile.dataset.index = index;
  tile.title = entry.kind === "dir" ? entry.name : `${entry.name}\n${formatSize(entry.size)} · ${formatDate(entry.mtime)}`;

  const box = document.createElement("div");
  box.className = "thumb";
  box.innerHTML = icon(KIND_ICON[entry.kind], "kind") + (entry.kind === "video" ? `<span class="badge">${icon("play")}</span>` : "");
  if (entry.kind === "file") {
    const dot = entry.name.lastIndexOf(".");
    if (dot > 0 && entry.name.length - dot <= 6) {
      const ext = document.createElement("span");
      ext.className = "ext";
      ext.textContent = entry.name.slice(dot + 1);
      box.append(ext);
    }
  }
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = entry.name;
  tile.append(box, name);
  return tile;
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

function renderPlaces() {
  const nav = $("#places");
  nav.replaceChildren(...state.init.places.map((p) => {
    const a = document.createElement("a");
    a.href = "#" + encodePath(p.path);
    a.title = p.path;
    a.innerHTML = icon(p.icon);
    a.append(p.name);
    a.classList.toggle("active", p.path === state.path);
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
  const n = thumbs.wanted.size;
  $("#status-progress").textContent = n ? `Generating ${n} thumbnail${n === 1 ? "" : "s"}…` : "";
}

function applySettings() {
  const s = state.settings;
  document.documentElement.style.setProperty("--tile", `${s.zoom}px`);
  zoomInput.value = s.zoom;
  sortSelect.value = s.sort;
  hiddenButton.setAttribute("aria-pressed", String(s.showHidden));
  $("#btn-sidebar").setAttribute("aria-pressed", String(s.sidebar));
  document.body.classList.toggle("sidebar", s.sidebar);
  termPanel.style.height = `${s.termHeight}px`;
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
  else if (isMedia(entry)) viewer.open(index);
  else openExternal(entry.path);
}

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

// ---------------------------------------------------------------- context menu

function showContextMenu(x, y, entry) {
  const items = [];
  if (entry.kind === "dir") items.push(["Open", () => navigate(entry.path)]);
  if (isMedia(entry)) items.push(["View", () => open(state.view.indexOf(entry))]);
  if (entry.kind === "video") items.push(["Play in mpv", () => openExternal(entry.path, "mpv")]);
  items.push(["Open with default app", () => openExternal(entry.path)]);
  items.push(["Copy path", () => copyText(entry.path)]);
  items.push([state.marked.size > 1 ? `Delete ${state.marked.size} items permanently…` : "Delete permanently…", deleteMarked]);
  if (terminal.isRunning) {
    items.push(["Paste path in terminal", () => {
      if (!terminal.isOpen) toggleTerminal();
      terminal.insert(shellQuote(entry.path) + " ");
    }]);
  }

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

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

// ---------------------------------------------------------------- events

const tileIndex = (target) => {
  const tile = target.closest(".tile");
  return tile ? Number(tile.dataset.index) : -1;
};

grid.addEventListener("click", (e) => {
  if (suppressClick) return; // the click that ends a rubber-band drag
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
  if (e.button !== 0 || (e.target === grid && e.offsetX >= grid.clientWidth)) return;
  e.preventDefault();
  grid.focus({ preventScroll: true });
});
grid.addEventListener("dragstart", (e) => e.preventDefault());
grid.addEventListener("selectstart", (e) => e.preventDefault());

grid.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || (e.target === grid && e.offsetX >= grid.clientWidth)) return; // not the scrollbar
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
  const autoScroll = () => {
    if (!band?.active) return;
    const r = grid.getBoundingClientRect();
    const y = band.client[1];
    const edge = 40;
    const speed = y < r.top + edge ? -(r.top + edge - y) : y > r.bottom - edge ? y - (r.bottom - edge) : 0;
    if (speed) {
      grid.scrollTop += Math.max(-40, Math.min(40, speed / 2));
      updateBand();
    }
    requestAnimationFrame(autoScroll);
  };
  requestAnimationFrame(autoScroll);
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
grid.addEventListener("dblclick", (e) => open(tileIndex(e.target)));
grid.addEventListener("contextmenu", (e) => {
  const i = tileIndex(e.target);
  if (i === -1) return; // keep the webview's own menu (Inspect Element) on empty space
  e.preventDefault();
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
});

// Reopen the panel on startup if it was open when phil last quit (set below).
let restoreTerminal = false;

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

// Capture phase, so F4 / Ctrl+` work while the terminal has focus too.
document.addEventListener("keydown", (e) => {
  if (!isToggleKey(e) || !viewerEl.hidden) return;
  e.preventDefault();
  e.stopPropagation();
  toggleTerminal();
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

  if (confirmDialog.open) return; // the dialog handles its own keys
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
  if ((e.altKey && e.key === "ArrowUp") || (e.key === "Backspace" && e.target === grid)) {
    return $("#btn-up").click(), handled();
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
  if (ctrl && e.key === "a") return setMarked(state.view.map((v) => v.path)), updateStatus(), handled();
  if (e.key === "Escape") return select(-1), handled();
  if (e.key === "Enter" || (e.key === " " && !typed)) return open(cur), handled();
  if (e.key.length === 1 && !ctrl && !e.altKey) return typeAhead(e.key), handled();
});

// ---------------------------------------------------------------- start

state.init = await api("/api/init");
Object.assign(state.settings, state.init.settings);
applySettings();
const thumbDirEl = $("#status-thumbdir");
thumbDirEl.textContent = `Thumbnails: ${state.init.thumbDir}`;
thumbDirEl.title = `${state.init.thumbDir} (${state.init.thumbSize})`;
thumbs.connect();

restoreTerminal = state.settings.termOpen;
if (location.hash.length > 1) load(decodeURIComponent(location.hash.slice(1)));
else navigate(state.init.start);
