import { appUrl, askPassword, clipboardKey, closeWindow, copyText, embedOf, holdFocus, pasteText, ready, tooltips } from "/engine/ui/kit.js";
import { isFocusKey, isToggleKey, shellQuote, TerminalPanel } from "/ui/terminal.js";

tooltips(); // the page's own, in the theme's style (kit.js)

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
  space: {}, // the sidebar's drives: {path: {size, avail}}
  speeds: {}, // their last read speed tests: {path: {read, at}} (Properties → Run speed test)
  transfers: new Map(), // copies and moves under way: id -> their progress (the server's transfer())
  downloads: [], // downloads under way (panda-dl's; the server's downloads.js)
  stopped: [], // copies and moves cut off, anywhere: [{path, copying}] (the server's records of them)
  clip: null, // files copied or cut, in any phil window: {op, paths, text}
  settings: { sort: "name", showHidden: false, zoom: 224, sidebar: false, termHeight: 260, termOpen: false, theme: "overlay" },
};
const tiles = new Map(); // path -> tile element
const scrollPositions = new Map(); // path -> scrollTop, restored on back/up

// ---------------------------------------------------------------- helpers

// phil's own icons (index.html), and with "l:" in front, Lucide's (vendor/lucide-sprite.svg:
// what a folder's icon is picked from, in its Properties).
const LUCIDE = "/ui/vendor/lucide-sprite.svg";
const icon = (name, cls = "") => `<svg class="${cls}"><use href="#${name.startsWith("l:") ? lucideIcon(name.slice(2)) : `i-${name}`}"/></svg>`;

// Lucide's icons are copied into the page as they're first used (#l-<name>):
// pointing into the sprite file itself, WebKit loaded it again for every new
// element, so icons there blinked whenever the sidebar or a folder was redrawn.
const lucideDefs = document.createElementNS("http://www.w3.org/2000/svg", "svg");
lucideDefs.setAttribute("style", "position: absolute; width: 0; height: 0; overflow: hidden");
lucideDefs.setAttribute("aria-hidden", "true");
let lucideSprite = null; // the sprite, parsed, once fetched
const lucideWanted = new Set(); // asked for before that
function lucideIcon(name) {
  const id = `l-${name}`;
  if (!lucideDefs.isConnected) document.body.append(lucideDefs);
  if (lucideDefs.querySelector(`[id="${CSS.escape(id)}"]`)) return id;
  if (!lucideSprite) {
    if (!lucideWanted.size) {
      fetch(LUCIDE).then((r) => r.text()).then((text) => {
        lucideSprite = new DOMParser().parseFromString(text, "image/svg+xml");
        for (const n of lucideWanted) lucideIcon(n);
        lucideWanted.clear();
      }).catch(() => {});
    }
    lucideWanted.add(name);
    return id; // drawn once it's in
  }
  const symbol = lucideSprite.getElementById(name);
  if (symbol) {
    const copy = document.importNode(symbol, true);
    copy.id = id;
    lucideDefs.append(copy);
  }
  return id;
}
const fileUrl = (path) => `/file?path=${encodeURIComponent(path)}`;

// Elements are kept in step with their data rather than rebuilt: rebuilding a
// panel or a tile made everything in it blink (and lost a click landing on it).
// `put` writes a property only when it differs.
const put = (el, prop, value) => el[prop] !== value && (el[prop] = value);

// Keeps `container`'s children in step with `items` by key: an item's element
// is reused while its key and kind stay (made by `make(item)` otherwise, with
// `el.item` the item it shows now), brought up to date by `show(el, item)`
// (writing only what differs), moved only when out of place, and removed when
// its item is gone. Other children (not this list's) are left alone.
function keyed(container, items, { key, kind = () => "", make, show }) {
  const old = new Map();
  for (const el of container.children) if (el.dataset.keyed !== undefined) old.set(el.dataset.keyed, el);
  const els = items.map((item) => {
    const k = String(key(item)), kd = String(kind(item));
    let el = old.get(k);
    if (el?.dataset.kind === kd) old.delete(k);
    else {
      el = make(item);
      el.dataset.keyed = k;
      el.dataset.kind = kd;
    }
    el.item = item;
    show(el, item);
    return el;
  });
  for (const el of old.values()) el.remove(); // first: so the rest needn't move around them
  let prev = null;
  for (const el of els) {
    let next = prev ? prev.nextElementSibling : container.firstElementChild;
    while (next && next.dataset.keyed === undefined) next = next.nextElementSibling;
    if (next !== el) container.insertBefore(el, next);
    prev = el;
  }
}

// An element's icon (icon()), replaced only when it's another one.
function putIcon(el, name, cls = "") {
  if (el.dataset.icon === name + cls) return;
  el.dataset.icon = name + cls;
  const t = document.createElement("template");
  t.innerHTML = icon(name, cls);
  const svg = t.content.firstElementChild;
  const old = el.querySelector(":scope > svg");
  old ? old.replaceWith(svg) : el.prepend(svg);
}
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
  const asked = performance.now(); // TEMPORARY (slow first clicks): requests over 300 ms logged
  const res = await fetch(path, options).finally(() => performance.now() - asked > 300 && debug(`slow request: ${path.slice(0, 120)} ${Math.round(performance.now() - asked)} ms (asked at ${Math.round(asked)}ms)`));
  if (!res.ok) throw Object.assign(new Error((await res.text()) || res.statusText), { status: res.status });
  return res.json();
}

// Root access, the one way everywhere (apps/phil/sudo.js): sudo, which
// remembers a password a while; when it doesn't, `action` fails with a 401,
// and the password box asks (its message says what for), the password goes to
// sudo, and `action` runs again. Rejects with .cancelled when it's cancelled.
async function withSudo(action, { ok = "OK", onAsk = () => {}, onRetry = () => {} } = {}) {
  for (;;) {
    try {
      return await action();
    } catch (err) {
      if (err.status !== 401) throw err;
      let message = err.message;
      for (;;) {
        onAsk();
        const password = await askPassword(message, { ok });
        if (password === null) throw Object.assign(new Error("Cancelled"), { cancelled: true });
        try {
          await api("/api/sudo", { method: "POST", body: JSON.stringify({ password, why: err.message.split("\n")[0] }) });
          break;
        } catch (wrong) {
          if (wrong.status !== 401) throw wrong;
          message = wrong.message;
        }
      }
      onRetry();
    }
  }
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
  quiet: new Set(), // those asked for again, not counted in the status bar
  outWant: new Set(),
  outFolders: new Set(),
  outCancel: new Set(),
  scheduled: false,
  watching: null, // the folder the server watches for us

  connect() {
    this.ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    this.ws.onopen = () => {
      this.wanted.forEach((p) => (this.folders.has(p) ? this.outFolders : this.outWant).add(p));
      if (this.watching) this.watch(this.watching);
      if (this.tagging) this.tag(this.tagging);
      if (this.backgroundPaths?.length) this.background(this.backgroundPaths);
      if (this.totals.size) this.send({ totals: [...this.totals] }); // asked for before the connection was up
      loadTransfers();
      loadStoppedTransfers();
      api("/api/clipboard").then((c) => ((state.clip = c), markClipboard()), () => {});
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
      if (msg.downloads) return onDownloads(msg.downloads);
      if (msg.made) return onMadeInBackground(msg.made, msg.url);
      if (msg.hook) return onHookRan(msg.hook);
      if (msg.transfer) return onTransfer(msg.transfer);
      if (msg.stoppedTransfers) return loadStoppedTransfers();
      if (msg.places) return refreshPlaces(); // the sidebar arranged, in some window
      if (msg.cameras) return (state.cameras = msg.cameras), renderCameras(); // found, renamed, forgotten
      if ("clipboard" in msg) return (state.clip = msg.clipboard), markClipboard();
      const path = msg.folder ?? msg.path;
      if (!this.wanted.delete(path)) return;
      this.folders.delete(path);
      this.quiet.delete(path);
      if (msg.folder) onFolderSummary(path, msg.summary);
      else if ("text" in msg) onTextReady(path, msg.text);
      else onThumbReady(path, msg.url, msg.busy);
      updateProgress();
    };
    this.ws.onclose = () => setTimeout(() => this.connect(), 1000);
  },
  // `quiet`: asked again (it changed, or was being written), not counted in the
  // status bar (a download changes it every few seconds: "Reading 1 folder" blinked).
  want(path, { folder = false, quiet = false } = {}) {
    if (this.wanted.has(path)) return;
    this.wanted.add(path);
    if (folder) this.folders.add(path);
    if (quiet) this.quiet.add(path);
    this.outCancel.delete(path);
    (folder ? this.outFolders : this.outWant).add(path);
    this.schedule();
  },
  cancel(path) {
    if (!this.wanted.delete(path)) return;
    this.folders.delete(path);
    this.quiet.delete(path);
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
  // The shown folder's thumbnails not yet made, made in the background (top first).
  background(paths) {
    this.backgroundPaths = paths;
    this.send({ background: paths });
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
  thumbs.want(entry.path, { folder: true, quiet: !!s });
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
  if (summary.busy) wantLater(path, summary.busy, (t, e) => e?.path === path && wantSummary(t, e)); // a picture in it being written
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
  showFolderInfo(tile, entry); // with no summary yet, the size alone
  if (state.settings.sort === "size") resortSoon();
}

// Sorted by size, folders move as their totals come in: at most once a second
// (they can come in for a long while, a few at a time), only when the order
// changed, and gliding to their new places (resort).
function resortSoon() {
  if (resortSoon.timer) return;
  resortSoon.timer = setTimeout(() => ((resortSoon.timer = null), renaming ? resortSoon() : resort()), 1000); // moving a tile being renamed would end that
}

// The tiles in a new order without rebuilding the grid: each gets its place
// (CSS order), none is taken out of the page (WebKit blanks a text preview's
// canvas then, which flickered), and those on screen slide there from where
// they were. Searching (its own order) or anything else changed: render().
function resort() {
  if (filterInput.value.trim() || state.view.some((e) => !tiles.has(e.path))) return render();
  const view = [...state.view];
  sortEntries(view);
  if (view.every((e, i) => e === state.view[i])) return; // nothing moved
  const visible = grid.getBoundingClientRect();
  const onScreen = (r) => r.bottom > visible.top && r.top < visible.bottom;
  const before = new Map();
  for (const e of state.view) {
    const r = tiles.get(e.path).getBoundingClientRect();
    if (onScreen(r)) before.set(e.path, r);
  }
  const selected = state.view[state.selected]?.path;
  state.view = view;
  view.forEach((e, i) => {
    const tile = tiles.get(e.path);
    tile.dataset.index = i;
    tile.style.order = i;
  });
  if (selected) state.selected = view.findIndex((e) => e.path === selected);
  for (const e of view) {
    const tile = tiles.get(e.path), now = tile.getBoundingClientRect(), was = before.get(e.path);
    if (!was && !onScreen(now)) continue;
    // From where it was (or just below the view, coming in), to where it is.
    const from = was ?? { left: now.left, top: visible.bottom };
    const dx = from.left - now.left, dy = from.top - now.top;
    if (dx || dy) tile.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 250, easing: "ease-out" });
  }
}

function showThumb(tile, entry) {
  const box = tile.firstElementChild;
  if (typeof entry.thumb === "string") return setThumbImage(box, entry.thumb);
  if (entry.thumb === null && !askAgain.has(entry.path)) { // (not one being written: asked again when it may have settled)
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
  const shown = box.querySelector("img");
  if (shown) return swapImage(shown, url); // its file changed: the new one in its place, once loaded
  const img = new Image();
  img.decoding = "sync"; // small JPEGs: decoding while painting beats drawing an empty tile first
  img.alt = "";
  img.draggable = false; // dragging over thumbnails draws a selection rectangle instead
  img.onload = () => box.classList.add("has-img");
  img.src = url;
  box.prepend(img);
}

// The rest of the folder's thumbnails are made in the background, once the
// view has settled (a moment after it's drawn): those on screen are still
// made first (the server makes these only while none of those wait).
function makeRestSoon() {
  clearTimeout(makeRestSoon.timer);
  makeRestSoon.timer = setTimeout(() => {
    const paths = state.view.filter((e) => e.kind !== "dir" && e.thumb === null).map((e) => e.path);
    if (paths.length || thumbs.backgroundPaths?.length) thumbs.background(paths);
  }, 1500);
}

// One made in the background: kept for when its tile comes near (drawn now if
// it's waiting for it there).
function onMadeInBackground(path, url) {
  const tile = tiles.get(path);
  const entry = tile && state.view[tile.dataset.index];
  if (entry?.path !== path || entry.thumb) return;
  if (thumbs.wanted.has(path)) return; // its own answer comes too
  entry.thumb = url;
}

// A file being written (a download) gets no thumbnail till it's settled: asked
// again then (in `ms`, which the server says), if its tile is still near.
const askAgain = new Map(); // path -> timer
function wantLater(path, ms, ask) {
  if (askAgain.has(path)) return;
  askAgain.set(path, setTimeout(() => {
    askAgain.delete(path);
    const tile = tiles.get(path);
    if (tile && isNear(tile)) ask(tile, state.view[tile.dataset.index]);
  }, Math.min(Math.max(+ms || 2000, 500), 60_000)));
}

function isNear(tile) { // as nearObserver's zone
  const r = tile.getBoundingClientRect(), g = grid.getBoundingClientRect();
  return tile.isConnected && r.bottom > g.top - 800 && r.top < g.bottom + 800;
}

function onThumbReady(path, url, busy = false) {
  const tile = tiles.get(path);
  if (!tile) return;
  if (busy) {
    tile.firstElementChild.classList.remove("loading");
    return wantLater(path, busy, (t, e) => e?.path === path && thumbs.want(path, { quiet: true }));
  }
  state.view[tile.dataset.index].thumb = url;
  const box = tile.firstElementChild;
  box.classList.remove("loading");
  if (url) setThumbImage(box, url);
  else box.querySelector("img")?.remove(), box.classList.remove("has-img"); // its file changed, and the new one has none
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
  else box.querySelector(":scope > canvas")?.remove(), box.classList.remove("has-text"); // its file changed, and isn't text now
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

// TEMPORARY, looking into first clicks in the sidebar that do nothing: what
// happens to clicks there, the window's focus, and folder loads, timed from
// the page's start, to phil's log ($XDG_RUNTIME_DIR/phil/main.log), a batch a second.
const DEBUG_CLICKS = true;
const debugLines = [];
const debug = (text) => DEBUG_CLICKS && debugLines.push(`${Math.round(performance.now())}ms ${text}`);
if (DEBUG_CLICKS) {
  setInterval(() => debugLines.length && fetch("/api/debug-log", { method: "POST", body: JSON.stringify({ lines: debugLines.splice(0) }) }).catch(() => {}), 1000);
  const where = (e) => {
    const a = e.target.closest?.("#places a, #cameras a");
    return a ? (a.dataset.path ?? a.dataset.camera ?? a.textContent.trim()) : e.target.closest?.("#sidebar") ? "sidebar (no place)" : null;
  };
  for (const type of ["pointerdown", "pointerup", "click", "mousedown", "mouseup"]) {
    addEventListener(type, (e) => {
      const w = where(e);
      if (w) debug(`${type} on ${w} button=${e.button} focused=${document.hasFocus()} prevented=${e.defaultPrevented}`);
    }, true);
  }
  addEventListener("focus", () => debug("window focus"));
  // The page busy (nothing else runs then: a click waits): any stretch over 300 ms.
  let tick = performance.now();
  setInterval(() => {
    const now = performance.now();
    if (now - tick > 400) debug(`page busy for ${Math.round(now - tick - 100)} ms`);
    tick = now;
  }, 100);
  grid.addEventListener("dblclick", (e) => debug(`dblclick on tile ${e.target.closest?.(".tile")?.querySelector(".name")?.textContent ?? "(none)"}`), true);
  addEventListener("blur", () => debug("window blur"));
  addEventListener("hashchange", () => debug(`hashchange → ${decodeURIComponent(location.hash.slice(1))}`), true);
  debug(`page start, hash ${decodeURIComponent(location.hash.slice(1)) || "(none)"}`);
  setTimeout(() => debug(`protocols: ${[...new Set(performance.getEntriesByType("resource").map((r) => r.nextHopProtocol || "?"))].join(", ")} (page: ${performance.getEntriesByType("navigation")[0]?.nextHopProtocol || "?"})`), 3000);
}

function navigate(path) {
  closeTransfersView(); // a folder opened: shown
  if (path === loading) return; // clicked again while it opens (a drive waking up)
  const hash = "#" + encodePath(path);
  if (location.hash === hash) load(path);
  else location.hash = hash;
}

addEventListener("hashchange", () => (closeTransfersView(), load(decodeURIComponent(location.hash.slice(1)))));

// The folder being opened, while it's listed (a drive waking up can take seconds),
// and which load is the newest (an older one finishing later is dropped).
let loading = null, loads = 0;

async function load(path) {
  if (state.path) scrollPositions.set(state.path, grid.scrollTop);
  const previous = state.path;
  let listing;
  const started = performance.now();
  debug(`load ${path} (showing ${previous})`);
  // Taken at once: its place in the sidebar lit, and, when it takes a while, a word that it's coming.
  loading = path;
  const thisLoad = ++loads;
  markPlace(path);
  let slow = false;
  const slowTimer = setTimeout(() => ((slow = true), flashStatus(`Opening ${path.split("/").pop() || path}…`, 60_000)), 300);
  try {
    listing = await api(`/api/list?path=${encodeURIComponent(path)}&sort=${state.settings.sort}`);
  } catch (err) {
    debug(`load ${path} failed after ${Math.round(performance.now() - started)} ms: ${err.message}`);
    if (thisLoad !== loads) return; // another is shown by now
    showGridMessage(`Can't open ${path}: ${err.message}`);
    return;
  } finally {
    clearTimeout(slowTimer);
    if (slow) flashStatus("", 0);
    if (loading === path) loading = null;
  }
  if (thisLoad !== loads) return; // another was asked for meanwhile
  debug(`load ${path} listed in ${Math.round(performance.now() - started)} ms (${listing.entries.length} entries)`);
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
  markPlace(listing.path); // only the lit one changes: rebuilding the sidebar on every click made it blink
  refreshSpace(); // into a share that mounts on use: now it has its space
  $("#btn-up").disabled = !listing.parent;
  filterInput.value = "";

  // Coming up from a child folder: select it, like other file managers do.
  const selectPath = previous && parentOf(previous) === listing.path ? previous : null;
  const drawing = performance.now();
  render(selectPath);
  debug(`load ${listing.path}: grid drawn in ${Math.round(performance.now() - drawing)} ms (${state.view.length} tiles)`);
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

// A subfolder's summary, made again when it changes: at most every few
// seconds (a download into it changes it all the time), and once more after.
const summarizedAt = new Map(), summaryLater = new Map(); // path -> when; path -> timer
const SUMMARY_EVERY_MS = 5000;

function onFolderChanged({ changed, folders }) {
  for (const path of folders) {
    changedFolders.add(path);
    const since = performance.now() - (summarizedAt.get(path) ?? -Infinity);
    if (since < SUMMARY_EVERY_MS) {
      if (!summaryLater.has(path)) summaryLater.set(path, setTimeout(() => (summaryLater.delete(path), onFolderChanged({ changed: null, folders: [path] })), SUMMARY_EVERY_MS - since));
      continue;
    }
    summarizedAt.set(path, performance.now());
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
  // Every entry's tile is kept while it's the same kind of thing (keyed by
  // path), with its loaded picture or text, and brought up to date in place
  // (updateTile); tiles are moved only when out of place, as WebKitGTK blanks
  // a canvas taken out of the page (its text is drawn again then).
  const old = new Map(tiles);
  tiles.clear();
  const ordered = state.view.map((entry, i) => {
    let tile = old.get(entry.path);
    if (tile?.dataset.shape === tileShape(entry) && !tile.classList.contains("renaming")) {
      old.delete(entry.path);
      tile.dataset.index = i;
      tile.classList.remove("selected");
      updateTile(tile, entry);
    } else {
      tile = makeTile(entry, i);
    }
    put(tile.style, "order", ""); // in the page's order again (see resort)
    tiles.set(entry.path, tile);
    return tile;
  });
  for (const [path, tile] of old) thumbs.cancel(path), tile.remove(); // first: so the rest needn't move around them
  grid.querySelector(":scope > .empty")?.remove(); // "This folder is empty"
  const redraw = [];
  let prev = null;
  for (const tile of ordered) {
    let next = prev ? prev.nextElementSibling : grid.firstElementChild;
    while (next && !next.classList.contains("tile")) next = next.nextElementSibling;
    if (next !== tile) {
      if (tile.querySelector("canvas")) redraw.push(tile);
      grid.insertBefore(tile, next);
    }
    prev = tile;
  }
  for (const tile of redraw) {
    for (const canvas of tile.querySelectorAll("canvas")) {
      const box = canvas.parentElement;
      canvas.remove();
      drawText(box);
    }
  }
  for (const tile of contentChanged.splice(0)) refreshPreview(tile, state.view[tile.dataset.index]);
  if (!state.view.length) showGridMessage(q ? "No matches" : "This folder is empty");
  for (const tile of tiles.values()) {
    nearObserver.observe(tile);
    farObserver.observe(tile);
  }
  makeRestSoon();

  state.selected = -1;
  const marked = state.marked;
  state.marked = new Set();
  const idx = state.view.findIndex((e) => e.path === selectPath);
  if (idx !== -1) select(idx, { scroll: false });
  if (marked.size > 1) setMarked([...marked].filter((p) => tiles.has(p))); // survive re-sort/filter
  updateStatus();
  showTransfers();
  markClipboard();
}

// The extension, if the name has a short one ("md", "json"; not "tar.gz"'s "tar").
function fileType(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && name.length - dot <= 6 ? name.slice(dot + 1) : "";
}

// A tile is rebuilt when its file changed; a folder's tile is updated in place.
// A tile is made again only when it's another kind of thing (a picture where
// a text file was, say); otherwise it's updated (updateTile).
const tileShape = (e) => `${e.kind} ${e.name.startsWith(".")}`;
const tileContent = (e) => `${e.size} ${e.mtime}`;
const contentChanged = []; // tiles whose file changed: their preview is made again (render)

// A kept tile, up to date: its details, marks and title; a folder's face and
// contents; and when its file changed, its preview made again (the old one
// shows until the new one is in).
function updateTile(tile, entry) {
  if (entry.kind === "dir") return showFolderInfo(tile, entry);
  put(tile.querySelector(".label .meta"), "textContent", fileMeta(entry));
  put(tile, "title", fileTitle(entry));
  showMarks(tile, entry);
  if (tile.dataset.content === tileContent(entry)) return;
  tile.dataset.content = tileContent(entry);
  contentChanged.push(tile);
}

function refreshPreview(tile, entry) {
  if (!entry) return;
  const box = tile.firstElementChild;
  const near = isNear(tile);
  if (entry.kind === "file") {
    box.text = undefined; // its text read again (and drawn over the old)
    if (near) showText(tile, entry);
  } else if (typeof entry.thumb === "string") {
    if (box.querySelector("img") || near) setThumbImage(box, entry.thumb);
  } else if (entry.thumb === null && near && !askAgain.has(entry.path)) {
    thumbs.want(entry.path, { quiet: true }); // (no "loading" look: a file being written changes all the time, and that blinked)
  }
}

const fileMeta = (entry) => [fileType(entry.name).toUpperCase(), formatSize(entry.size), formatShortDate(entry.mtime)].filter(Boolean).join(" · ");

function makeTile(entry, index) {
  const tile = document.createElement("div");
  tile.className = `tile ${entry.kind}${entry.name.startsWith(".") ? " hidden-file" : ""}`;
  tile.dataset.index = index;
  tile.dataset.shape = tileShape(entry);
  tile.dataset.content = tileContent(entry);

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
    meta.textContent = fileMeta(entry);
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
  const folderMark = entry.icon ? [`l:${entry.icon}`, "folder line custom"] : ["folder", "folder fill"]; // its own icon, picked in Properties
  // ⚡: an on-change hook (Properties); ▶: a video; a folder's icon.
  const marks = [entry.onChange && ["bolt", "hook"], entry.kind === "video" && ["play", ""], entry.kind === "dir" && folderMark].filter(Boolean);
  const key = marks.flat().join(" ");
  let el = tile.querySelector(":scope > .marks");
  if (el?.dataset.key === key) return;
  el?.remove();
  tile.classList.toggle("has-marks", !!marks.length);
  if (!marks.length) return;
  el = document.createElement("span");
  el.className = "marks";
  el.dataset.key = key;
  el.innerHTML = marks.map(([name, cls]) => `<span class="badge ${cls}">${icon(name)}</span>`).join("");
  tile.append(el);
  tile.style.setProperty("--marks-n", marks.length); // the label's last line keeps clear of them
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
    (entry.icon ? `icon:${entry.icon}` : summary?.files ? "file" : summary?.dirs ? "folder" : "");
  if (box.dataset.look !== look || !box.firstChild) fillFolderFace(box, summary, previews, entry);
  box.dataset.look = look;
  const meta = tile.querySelector(".meta");
  // Before its summary (which waits for its pictures' thumbnails), its total size if that's in.
  meta.textContent = summary ? folderContents(summary, entry.total) : entry.total?.bytes !== undefined ? formatSize(entry.total.bytes) : "";
  tile.title = entry.name + (meta.textContent ? `\n${meta.textContent}` : "") + titleNotes(entry);
  showMarks(tile, entry);
  tile.classList.toggle("empty-dir", !!summary && !summary.files && !summary.dirs);
}

// Without pictures, a folder's own icon (Properties), else one for what it holds.
function fillFolderFace(box, summary, previews, entry) {
  let face = box.querySelector(":scope > .face");
  if (!face) box.replaceChildren(face = Object.assign(document.createElement("div"), { className: "face" }));
  if (previews.length) {
    if (face.dataset.mode !== "previews") face.replaceChildren(), delete face.dataset.icon, (face.dataset.mode = "previews");
    put(face, "className", `face previews n${previews.length}`);
    // Kept by place (the first picture, the second...): a picture that changed
    // shows the new one once it's loaded, so the face doesn't blink.
    keyed(face, previews.map((p, i) => ({ ...p, i })), {
      key: (p) => p.i,
      kind: (p) => (p.text ? "text" : "img"),
      make: (p) => {
        if (p.text) return Object.assign(document.createElement("div"), { className: "cell" }); // drawn once the tile is laid out (drawFolderTexts)
        const img = Object.assign(new Image(), { alt: "", draggable: false, loading: "lazy", decoding: "async" });
        img.onerror = () => img.remove(); // the thumbnail cache was cleared since
        return img;
      },
      show: (el, p) => {
        if (!p.text) return swapImage(el, p.url);
        if (JSON.stringify(el.text) === JSON.stringify(p.text)) return;
        el.text = p.text;
        if (el.querySelector("canvas")) drawText(el); // over the old (drawText keeps its canvas)
      },
    });
  } else {
    const [name, cls] = entry.icon ? [`l:${entry.icon}`, "kind custom"] : summary?.files || summary?.dirs ? [summary.files ? "file" : "folder", "kind"] : [];
    if (face.dataset.mode !== "icon") face.replaceChildren(), delete face.dataset.icon, (face.dataset.mode = "icon");
    put(face, "className", "face");
    if (name) putIcon(face, name, cls);
    else face.replaceChildren(), delete face.dataset.icon;
  }
}

// An image showing `url`: the first time at once, after that once the new one has loaded (no blank between).
function swapImage(img, url) {
  if (img.dataset.url === url) return;
  img.dataset.url = url;
  if (!img.getAttribute("src")) return void (img.src = url);
  const next = new Image();
  next.src = url;
  next.decode().then(() => img.dataset.url === url && (img.src = url), () => {});
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
  // "/", then each folder on the way, with a "/" between (keyed by the path it ends).
  const items = [{ path: "/", label: "/" }];
  parts.forEach((part, i) => {
    const path = "/" + parts.slice(0, i + 1).join("/");
    if (i > 0) items.push({ path, sep: true });
    items.push({ path, label: part });
  });
  keyed(crumbs, items, {
    key: (c) => (c.sep ? `sep:${c.path}` : c.path),
    kind: (c) => (c.sep ? "sep" : "crumb"),
    make: (c) => (c.sep ? Object.assign(document.createElement("span"), { className: "sep", textContent: "/" }) : makeCrumb()),
    show: (el, c) => c.sep || (put(el, "textContent", c.label), el.dataset.path !== c.path && (el.dataset.path = c.path)), // drop target
  });
  crumbs.scrollLeft = crumbs.scrollWidth;
}

function makeCrumb() {
  const b = document.createElement("button");
  b.onclick = (e) => {
    e.stopPropagation();
    navigate(b.item.path);
  };
  // Right-click: that folder's Properties (the way to the one you're in, whose tile isn't shown).
  b.oncontextmenu = (e) => {
    e.preventDefault();
    const { path, label } = b.item;
    showMenu(e.clientX, e.clientY, [["Properties", () => showProperties({ path, name: label, kind: "dir" })], ...newItemsIn(path, " inside")]);
  };
  return b;
}

// Drives and shares come and go (USB, mounts): the list is fetched again
// whenever the window gets focus.
// Once per focus: WebKit reports it a few times over as the window opens.
let focusedAt = 0;
addEventListener("focus", () => {
  if (performance.now() - focusedAt < 1000) return;
  focusedAt = performance.now();
  refreshPlaces();
});
// The sidebar's drives and shares (not home and its folders): their space is shown.
const isMount = (p) => !p.unmounted && (p.icon === "drive" || p.icon === "network");

// Their size and free space ({path: {size, avail}}), fetched after the places
// (df can take a moment), again with them, and after each folder opened (going
// into a share that mounts itself on use mounts it). A share that has unmounted
// itself again keeps what it last had.
async function refreshSpace() {
  const paths = state.init.places.filter(isMount).map((p) => p.path);
  if (!paths.length) return;
  const fresh = await api(`/api/space?${paths.map((p) => `path=${encodeURIComponent(p)}`).join("&")}`).catch(() => null);
  if (!fresh) return;
  const space = Object.fromEntries(paths.filter((p) => fresh[p] || state.space[p]).map((p) => [p, fresh[p] ?? state.space[p]]));
  if (JSON.stringify(space) === JSON.stringify(state.space)) return;
  state.space = space;
  showPlacesInfo();
}

// The drives' last speed tests, for their tooltips: at the start, with the places, after a test.
async function refreshSpeeds() {
  const paths = state.init.places.filter(isMount).map((p) => p.path);
  if (!paths.length) return;
  const speeds = await api(`/api/drive-speeds?${paths.map((p) => `path=${encodeURIComponent(p)}`).join("&")}`).catch(() => null);
  if (!speeds || JSON.stringify(speeds) === JSON.stringify(state.speeds)) return;
  state.speeds = speeds;
  showPlacesInfo();
}

async function refreshPlaces() {
  const fresh = await api("/api/places").catch(() => null);
  refreshSpace();
  refreshSpeeds();
  if (!fresh) return;
  state.init.mounts = fresh.mounts;
  if (JSON.stringify(fresh.places) === JSON.stringify(state.init.places)) return;
  state.init.places = fresh.places;
  renderPlaces();
}

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

// A press in the sidebar is a click on its way: rebuilding it now (a refresh
// that lands then, as the one when the window gets focus often does) would
// swap the element under the pointer and lose the click. So it waits until
// the button is up, and the click has gone to where it was pressed.
let sidebarPressed = false;
const heldRenders = new Set();
const holdWhilePressed = (render) => (sidebarPressed ? (heldRenders.add(render), true) : false);
$("#sidebar").addEventListener("pointerdown", () => (sidebarPressed = true), true);
for (const type of ["pointerup", "pointercancel", "dragend", "blur"]) {
  addEventListener(type, (e) => {
    if (!sidebarPressed || (type === "blur" && e.target !== window)) return; // the window's blur, not focus moving inside it
    sidebarPressed = false;
    setTimeout(() => { // after the click
      for (const render of heldRenders) render();
      heldRenders.clear();
    });
  }, true);
}

// A place's tooltip, and a drive's free space under its name: also updated
// alone (refreshSpace, refreshSpeeds), as free space changes all the time and
// rebuilding the sidebar for it made it blink.
function showPlaceInfo(a, p) {
  let title = p.path;
  if (isMount(p)) {
    const space = state.space[p.path], text = a.querySelector(".place-text");
    let free = text?.querySelector(".space");
    if (space && text) {
      if (!free) text.firstElementChild.after(free = Object.assign(document.createElement("span"), { className: "space" })); // under the name
      put(free, "textContent", `${formatSize(space.avail)} free of ${formatSize(space.size)}`);
      title += `\n${formatSize(space.avail)} free of ${formatSize(space.size)} (${Math.round((1 - space.avail / space.size) * 100)}% used)`;
    } else free?.remove();
    const speed = state.speeds[p.path], mbs = speed?.read ?? speed?.buffered;
    if (speed?.write) title += `\n${Math.round(speed.read).toLocaleString()} MB/s down, ${Math.round(speed.write).toLocaleString()} MB/s up`;
    else if (mbs) title += `\n${Math.round(mbs).toLocaleString()} MB/s`;
  }
  const remote = remoteOf(p.path);
  if (remote) title += `\nDouble-click: SSH to ${remote.host}`;
  put(a, "title", title);
}

// Every place's (refreshSpace, refreshSpeeds).
function showPlacesInfo() {
  for (const a of $("#places").querySelectorAll("a[data-path]")) {
    const p = state.init.places.find((p) => p.path === a.dataset.path);
    if (p) showPlaceInfo(a, p);
  }
}

// The sidebar's place for the folder shown (or being opened) lit, the others not.
function markPlace(path) {
  for (const a of $("#places").querySelectorAll("a[data-path]")) a.classList.toggle("active", a.dataset.path === path);
}

function renderPlaces() {
  if (holdWhilePressed(renderPlaces)) return;
  keyed($("#places"), state.init.places, {
    key: (p) => (p.unmounted ? `device:${p.device}` : p.path),
    kind: (p) => (p.unmounted ? "unmounted" : isMount(p) ? "mount" : "folder"),
    make: (p) => (p.unmounted ? makeUnmountedPlace() : makePlace(p)),
    show: (a, p) => (p.unmounted ? showUnmountedPlace(a, p) : showPlace(a, p)),
  });
  showTransfers();
}

// A place's row (its data: a.item, as it is now). Drives and shares have their
// free space under the name (and copies to them, see showTransfers).
function makePlace(p) {
  const a = document.createElement("a");
  a.draggable = true; // as an element, not as a link: WebKit starts those itself, and not always
  if (isMount(p)) {
    const text = Object.assign(document.createElement("span"), { className: "place-text" });
    text.append(Object.assign(document.createElement("span"), { className: "place-name" }));
    a.append(text);
  } else {
    a.append(document.createTextNode(""));
  }
  // A network share: double-click (or the menu) for a terminal on that machine.
  a.ondblclick = (e) => remoteOf(a.item.path) && (e.preventDefault(), sshTo(a.item.path));
  a.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation(); // not the sidebar's menu
    const p = a.item, remote = remoteOf(p.path);
    showMenu(e.clientX, e.clientY, [
      ["Open", () => navigate(p.path)],
      ["Properties", () => showProperties({ path: p.path, name: p.name, kind: "dir" })],
      ...(remote ? [[`SSH here (${remote.host})`, () => sshTo(p.path)]] : []),
      ["Paste into", () => pasteFiles(p.path)],
      ...newItemsIn(p.path, " inside"),
      ...(p.mounted ? [["Unmount", () => unmount(p)]] : []),
      ...(p.folder ? [["Remove from sidebar", () => removeFromSidebar(p)]] : []),
    ]);
  };
  return a;
}

function showPlace(a, p) {
  put(a, "href", new URL("#" + encodePath(p.path), location.href).href);
  if (a.dataset.path !== p.path) a.dataset.path = p.path; // drop target
  a.classList.toggle("folder", !!p.folder); // the user's (see placeGapAt)
  putIcon(a, p.customIcon ? `l:${p.customIcon}` : p.icon); // the icon picked in its Properties, if any
  const name = p.description || p.name; // its Properties' description, when it has one
  if (isMount(p)) put(a.querySelector(".place-name"), "textContent", name);
  else put(a.lastChild, "nodeValue", name);
  showPlaceInfo(a, p);
  a.classList.toggle("active", p.path === (loading ?? state.path)); // the one being opened, already
}

// A drive that isn't mounted (an internal one's partition: nothing mounts
// those by itself): dimmed; a click mounts it (udisks; a system drive asks
// for the password) and opens it.
function makeUnmountedPlace() {
  const a = document.createElement("a");
  a.href = "#";
  a.className = "unmounted";
  a.append(document.createTextNode(""));
  a.onclick = (e) => (e.preventDefault(), mount(a.item, a));
  a.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, [["Mount and open", () => mount(a.item, a)]]);
  };
  return a;
}

function showUnmountedPlace(a, p) {
  put(a, "title", `${p.device}: not mounted. Click to mount it`);
  putIcon(a, p.icon);
  put(a.lastChild, "nodeValue", p.name);
}

// A drive that wasn't closed properly (NTFS) can be mounted read-only: asked.
async function mount(p, a, readOnly = false) {
  if (a.classList.contains("busy")) return;
  a.classList.add("busy");
  flashStatus(`Mounting ${p.name}…`, 60_000);
  try {
    // A system drive's needs root: sudo (the password box when it wants it).
    const { path } = await withSudo(() => api("/api/mount", { method: "POST", body: JSON.stringify({ device: p.device, readOnly }) }), { ok: "Mount" });
    flashStatus(`Mounted ${p.name}${readOnly ? " (read-only)" : ""}`);
    await refreshPlaces();
    navigate(path);
  } catch (err) {
    flashStatus("", 0);
    if (err.cancelled) return;
    if (err.status !== 409) return alert(`Couldn't mount ${p.name}\n${err.message}`);
    a.classList.remove("busy");
    const ok = await askConfirm({ title: `${p.name} can only be mounted read-only`, detail: err.message, ok: "Mount read-only", danger: false, copyable: true });
    if (ok) return mount(p, a, true);
  } finally {
    a.classList.remove("busy");
  }
}

async function unmount(p) {
  // Out of it first: the terminal, which follows the view, would keep it busy.
  if (state.path === p.path || state.path.startsWith(p.path + "/")) {
    navigate(state.init.home);
    for (let i = 0; i < 20 && state.path !== state.init.home; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
  }
  try {
    await withSudo(() => api("/api/unmount", { method: "POST", body: JSON.stringify({ path: p.path }) }), { ok: "Unmount" });
  } catch (err) {
    if (err.cancelled) return;
    return alert(`Couldn't unmount ${p.name}: ${err.message}`);
  }
  flashStatus(`Unmounted ${p.name}`);
  await refreshPlaces();
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
  let folders = 0, files = 0;
  for (const path of thumbs.wanted) if (!thumbs.quiet.has(path)) thumbs.folders.has(path) ? folders++ : files++;
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

// Scripts and programs (a #! line, a shell script's name, an executable
// program) run in the terminal; text files (anything that reads as text:
// notes, code, configs, logs) open in textedit in this window; other files
// with their default app. The server checks.
async function openFile(entry) {
  const kind = await api(`/api/is-text?path=${encodeURIComponent(entry.path)}`).catch(() => ({}));
  if (kind.run) return runInTerminal(kind.run); // scripts and programs
  if (kind.text || tiles.get(entry.path)?.firstElementChild.text) openInApp("textedit", { file: entry.path });
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

// `cancel`: null for a message with only OK; `danger`: OK in red (deleting);
// `copyable`: a Copy button for the message.
// One at a time: another waits for this one to close.
let confirmShown = Promise.resolve();
// With `fields` ([{name, label, type, value, placeholder}]): text boxes, and it
// resolves to their values ({name: value}), or null when cancelled.
function askConfirm({ title, detail, ok, cancel = "Cancel", danger = true, copyable = false, fields = null }) {
  const shown = confirmShown.then(() => new Promise((resolve) => {
    confirmDialog.querySelector(".title").textContent = title;
    confirmDialog.querySelector(".detail").textContent = detail ?? "";
    const box = confirmDialog.querySelector(".fields");
    box.replaceChildren();
    box.hidden = !fields;
    const inputs = (fields ?? []).map((f) => {
      const label = Object.assign(document.createElement("label"), { textContent: f.label });
      const input = Object.assign(document.createElement("input"), { type: f.type ?? "text", value: f.value ?? "", placeholder: f.placeholder ?? "", spellcheck: false, autocomplete: "off" });
      input.name = f.name;
      input.onkeydown = (e) => {
        e.stopPropagation(); // typing here isn't the page's keys
        if (e.key === "Enter") e.preventDefault(), confirmDialog.close("ok");
      };
      label.htmlFor = input.id = `field-${f.name}`;
      box.append(label, input);
      return input;
    });
    const okButton = confirmDialog.querySelector("[value=ok]"), cancelButton = confirmDialog.querySelector("[value=cancel]");
    okButton.textContent = ok;
    okButton.classList.toggle("danger", danger);
    cancelButton.hidden = !cancel;
    cancelButton.textContent = cancel ?? "";
    // Copy: the message, for pasting somewhere (it stays open).
    const copy = confirmDialog.querySelector("[value=copy]");
    copy.hidden = !copyable;
    copy.innerHTML = `<svg><use href="#i-copy"/></svg>`;
    copy.title = "Copy the message";
    copy.onclick = (e) => {
      e.preventDefault();
      copyText(detail ? `${title}\n${detail}` : title);
      copy.innerHTML = `<svg><use href="#i-check"/></svg>`; // copied
      copy.title = "Copied";
    };
    confirmDialog.returnValue = "";
    confirmDialog.showModal();
    if (inputs.length) inputs[0].focus(), inputs[0].select();
    else okButton.focus(); // Enter: OK (not Copy, before it)
    confirmDialog.addEventListener("close", () => {
      const yes = confirmDialog.returnValue === "ok";
      resolve(fields ? (yes ? Object.fromEntries(inputs.map((i) => [i.name, i.value])) : null) : yes);
    }, { once: true });
  }));
  confirmShown = shown.catch(() => {});
  return shown;
}

// phil's messages in the page, not the webview's dialog: its text can be
// selected and copied. (In place of window.alert for this module.)
function alert(message) {
  const [title, ...rest] = String(message).split("\n");
  return askConfirm({ title, detail: rest.join("\n").trim(), ok: "OK", cancel: null, danger: false, copyable: true });
}

// Shift+Delete: permanent, no trash. Asks first; Enter confirms, Esc cancels.
const deletingHere = new Set(); // sent off from this window, not answered yet (before any progress comes)

async function deleteMarked() {
  // What a delete under way has already (it, or a folder it's in): not asked again.
  const underWay = [...state.transfers.values()].filter((t) => t.op === "delete").flatMap((t) => t.targets ?? []).concat([...deletingHere]);
  const all = markedEntries();
  const targets = all.filter((e) => !underWay.some((d) => e.path === d || e.path.startsWith(d + "/")));
  if (all.length && !targets.length) return flashStatus(all.length === 1 ? `${all[0].name} is being deleted already` : "They're being deleted already");
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
    for (const e of targets) deletingHere.add(e.path);
    result = await api("/api/delete", { method: "POST", body: JSON.stringify({ paths: targets.map((e) => e.path) }) });
  } catch (err) {
    result = { errors: [{ path: "", error: err.message }] };
  } finally {
    for (const e of targets) deletingHere.delete(e.path);
  }
  await load(state.path);
  select(Math.min(firstIndex, state.view.length - 1));
  if (result.cancelled) { // stopped (×): not an error
    result.errors = result.errors.filter((e) => e.error !== "cancelled");
    flashStatus("Deleting stopped: what's gone is gone, the rest is still there");
  }
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
  // Edit as text, Open with default app and Properties first; then what fits the kind.
  const items = [];
  if (entry.kind === "file") items.push(["Edit as text", () => openInApp("textedit", { file: entry.path })]);
  items.push(["Open with default app", () => openExternal(entry.path)]);
  items.push(["Properties", () => showProperties(entry)]);
  if (entry.kind === "dir") items.push(["Open", () => navigate(entry.path)], ...newItemsIn(entry.path, " inside"));
  if (entry.kind === "dir" && remoteOf(entry.path)) items.push([`SSH here (${remoteOf(entry.path).host})`, () => sshTo(entry.path)]);
  if (entry.kind === "image") items.push(["View", () => open(state.view.indexOf(entry))]);
  if (entry.kind === "image") items.push(["Resize, crop, compress…", () => openInApp("imageresize", { file: entry.path })]);
  if (entry.kind === "video") items.push(["Play in mpv", () => openExternal(entry.path, "mpv")]);
  if (entry.kind === "video") items.push(["Play here", () => viewer.open(state.view.indexOf(entry))]);
  if (isJson(entry)) items.push(["Edit in jsonedit", () => openInApp("jsonedit", { file: entry.path })]);
  if (isJson(entry) || tiles.get(entry.path)?.firstElementChild.text) items.push(["Add to Config", () => addToConfig(entry)]);
  items.push(...clipItems(entry));
  if (entry.kind === "dir") items.push(["Paste into", () => pasteFiles(entry.path)]);
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
  keyed($("#tags"), list, {
    key: ([tag]) => tag,
    make: () => {
      const b = document.createElement("button");
      b.append(document.createTextNode(""), Object.assign(document.createElement("span"), { className: "n" }));
      b.onclick = () => {
        const [tag] = b.item;
        tagFilter.has(tag) ? tagFilter.delete(tag) : tagFilter.add(tag);
        render();
        renderTags();
      };
      return b;
    },
    show: (b, [tag, n]) => {
      b.classList.toggle("active", tagFilter.has(tag));
      b.classList.toggle("mine", mine.has(tag));
      put(b, "title", `${n} here${mine.has(tag) ? ", some given by hand" : ""}. Click: only what has it (with any other tags picked)`);
      put(b.firstChild, "nodeValue", tag);
      put(b.lastChild, "textContent", String(n));
    },
  });
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
  // One of the sidebar's drives or shares: what it is, and how fast it reads.
  if (state.init.places.some((place) => isMount(place) && place.path === p.path)) showDrive(p.path, fact);

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
  // A folder's icon, for its tile and in the sidebar: picked from a list (pickIcon).
  let iconPick = p.meta?.icon ?? "";
  const iconButton = $p("#props-icon"), iconReset = $p("#props-icon-reset");
  $p(".icon-row").hidden = p.kind !== "folder";
  const showIcon = () => {
    iconButton.innerHTML = icon(iconPick ? `l:${iconPick}` : "folder") + `<span>${iconPick ? iconPick.replaceAll("-", " ") : "The usual folder"}</span>`;
    iconReset.hidden = !iconPick;
  };
  showIcon();
  iconButton.onclick = async () => {
    const picked = await pickIcon(iconPick, p.name);
    if (picked !== null) (iconPick = picked), showIcon();
  };
  iconReset.onclick = () => ((iconPick = ""), showIcon());
  output.hidden = true;
  $p(".run").onclick = async () => {
    const command = input.value.trim();
    if (!command) return input.focus();
    output.hidden = false;
    output.className = "output";
    output.textContent = `Running…`;
    const run = await runHookWithSudo(p.path, command);
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
    if (p.kind === "folder" && iconPick !== (p.meta?.icon ?? "")) changes.icon = iconPick;
    if (!Object.keys(changes).length) return;
    try {
      await api("/api/meta", { method: "PUT", body: JSON.stringify({ path: p.path, ...changes }) });
      if ("onChange" in changes) flashStatus(onChange ? `${p.name}: when it changes, phil runs ${onChange}` : `${p.name}: nothing runs when it changes`);
      refresh();
      if ("description" in changes || "icon" in changes) refreshPlaces(); // a place's description is its label in the sidebar, its icon its icon
      if ((changes.tags?.length || "autoTags" in changes) && state.autoTagged) thumbs.tag(state.path); // the tag list may have grown
    } catch (err) {
      alert(`Couldn't save: ${err.message}`);
    }
  }, { once: true });
}

// ---------------------------------------------------------------- cameras

// The network cameras (ONVIF) phil has found, at the bottom of the sidebar
// (the server looks for them: apps/camview/cameras.js). Double-click shows one
// in camview, in this window; right-click renames it, logs into it (a camera
// that wants a login says so), or forgets it.
state.cameras = [];

// `look`: and have the server look for new ones (it does at most every 10 minutes).
async function loadCameras() {
  const list = await api("/api/cameras").catch(() => null);
  if (!list || JSON.stringify(list) === JSON.stringify(state.cameras)) return;
  state.cameras = list;
  renderCameras();
}

function renderCameras() {
  if (holdWhilePressed(renderCameras)) return;
  $("#cameras-panel").hidden = !state.cameras.length;
  keyed($("#cameras"), state.cameras, { key: (c) => c.id, make: makeCamera, show: showCamera });
}

// A camera's row (its data: a.item, as it is now).
function makeCamera() {
  const a = document.createElement("a");
  a.tabIndex = 0;
  a.innerHTML = icon("camera");
  const text = Object.assign(document.createElement("span"), { className: "cam-text" });
  text.append(document.createElement("span"));
  a.append(text);
  a.ondblclick = () => openCamera(a.item);
  a.onkeydown = (e) => e.key === "Enter" && (e.preventDefault(), openCamera(a.item));
  a.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation(); // not the sidebar's menu
    const c = a.item;
    showMenu(e.clientX, e.clientY, [
      ["Show", () => openCamera(c)],
      ["Rename…", () => renameCamera(c)],
      [c.login ? "Change login…" : "Log in…", () => loginCamera(c)],
      ["Forget", () => forgetCamera(c)],
      ...cameraMenuItems(),
    ]);
  };
  return a;
}

function showCamera(a, c) {
  if (a.dataset.camera !== c.id) a.dataset.camera = c.id;
  const text = a.querySelector(".cam-text");
  put(text.firstElementChild, "textContent", c.name);
  let note = text.querySelector(".note");
  if (c.needsLogin && !note) text.append(note = Object.assign(document.createElement("span"), { className: "note", textContent: "needs a login" }));
  else if (!c.needsLogin) note?.remove();
  put(a, "title", [c.model, `${c.host}${c.port === 80 ? "" : `:${c.port}`}`, "Double-click: show it"].filter(Boolean).join("\n"));
}

// The Cameras heading: every camera, live (camview's wall; Esc comes back).
$("#btn-cameras").onclick = () => openInApp("camview", { wall: 1 });

async function openCamera(c) {
  if (c.page) return openInApp("camview", { wall: 1 }); // a web page: shown on the wall
  if (c.needsLogin && !(await loginCamera(c))) return;
  openInApp("camview", { camera: c.id });
}

// Looks for cameras now (the refresh button by "Cameras", or the menu): new
// ones are added, and ones not found are left out until they're back.
async function lookForCameras() {
  const button = $("#btn-cameras-refresh");
  if (button.classList.contains("busy")) return;
  button.classList.add("busy");
  flashStatus("Looking for cameras on the network…", 30_000);
  const before = new Set(state.cameras.map((c) => c.id));
  try {
    const list = await api("/api/cameras?look=now");
    state.cameras = list;
    renderCameras();
    const added = list.filter((c) => !before.has(c.id)).length, gone = [...before].filter((id) => !list.some((c) => c.id === id)).length;
    flashStatus(`${list.length} camera${list.length === 1 ? "" : "s"}` + (added ? `, ${added} new` : "") + (gone ? `, ${gone} not found` : ""));
  } catch {
    flashStatus("Couldn't look for cameras");
  } finally {
    button.classList.remove("busy");
  }
}
$("#btn-cameras-refresh").onclick = lookForCameras;

const cameraMenuItems = () => [
  ["Look for cameras", lookForCameras],
  ["Add camera…", addCamera],
];

async function renameCamera(c) {
  const answer = await askConfirm({ title: "Rename camera", ok: "Rename", danger: false, fields: [{ name: "name", label: "Name", value: c.name }] });
  if (!answer) return;
  await api("/api/camera", { method: "PUT", body: JSON.stringify({ id: c.id, name: answer.name }) }).catch((err) => alert(err.message));
}

// Resolves to whether it took (the camera is asked first).
async function loginCamera(c) {
  const answer = await askConfirm({
    title: `Log into ${c.name}`, detail: "Its user name and password (the camera's own, not this computer's). Kept in ~/.config/phil/cameras.json, readable only by you.",
    ok: "Log in", danger: false,
    fields: [{ name: "user", label: "User name", value: "admin" }, { name: "password", label: "Password", type: "password" }],
  });
  if (!answer) return false;
  try {
    await api("/api/camera", { method: "PUT", body: JSON.stringify({ id: c.id, ...answer }) });
    return true;
  } catch (err) {
    alert(err.message);
    return false;
  }
}

async function forgetCamera(c) {
  if (!(await askConfirm({ title: `Forget ${c.name}?`, detail: "It's no longer listed, even when it's found again. Add it back by its address.", ok: "Forget" }))) return;
  await api("/api/camera", { method: "PUT", body: JSON.stringify({ id: c.id, hidden: true }) }).catch((err) => alert(err.message));
}

async function addCamera() {
  const answer = await askConfirm({
    title: "Add a camera", detail: "An ONVIF camera, by its address (and port, if it isn't a usual one). A login only if it wants one.",
    ok: "Add", danger: false,
    fields: [{ name: "address", label: "Address", placeholder: "192.168.1.20 or camera.local:8899" }, { name: "user", label: "User name" }, { name: "password", label: "Password", type: "password" }],
  });
  if (!answer?.address) return;
  flashStatus(`Asking ${answer.address}…`, 20_000);
  try {
    const c = await api("/api/cameras", { method: "POST", body: JSON.stringify(answer) });
    flashStatus(`Added ${c.name}`);
  } catch (err) {
    flashStatus("");
    alert(err.message);
  }
}

// ---------------------------------------------------------------- folder icons

// Lucide's icons ({name: [tags]}), loaded when the picker first opens.
let lucideTags = null;
const loadLucideTags = async () => (lucideTags ??= await fetch("/ui/vendor/lucide-tags.json").then((r) => r.json()));

// Words in a folder's name, and the icons they usually mean (beyond Lucide's own names and tags).
const FOLDER_WORDS = {
  download: ["download", "hard-drive-download", "arrow-down-to-line"],
  document: ["file-text", "files", "folder-open"], doc: ["file-text", "files"], paper: ["file-text", "newspaper"],
  picture: ["image", "images", "camera"], photo: ["camera", "image", "images", "aperture"], pic: ["image", "camera"], wallpaper: ["image", "wallpaper", "mountain-snow"], screenshot: ["monitor", "scan", "camera"], dcim: ["camera", "image"], image: ["image", "images"],
  video: ["film", "clapperboard", "video", "tv"], movie: ["clapperboard", "film", "popcorn"], film: ["film", "clapperboard", "popcorn"], show: ["tv", "clapperboard"], series: ["tv", "tv-minimal-play"], tv: ["tv"], anime: ["tv", "sparkles"],
  music: ["music", "headphones", "disc-3", "guitar"], song: ["music", "music-2"], audio: ["audio-lines", "headphones", "music"], podcast: ["mic", "radio"], sound: ["volume-2", "audio-lines"],
  game: ["gamepad-2", "joystick", "dices", "swords"], steam: ["gamepad-2", "joystick"], rom: ["gamepad-2", "cpu"],
  project: ["folder-kanban", "code", "rocket"], code: ["code", "folder-code", "terminal"], src: ["code", "folder-code"], dev: ["code", "terminal", "bug"], repo: ["folder-git-2", "git-branch"], git: ["folder-git-2", "git-branch"],
  work: ["briefcase", "building"], job: ["briefcase"], office: ["building", "briefcase"], client: ["users", "handshake"],
  school: ["graduation-cap", "school", "book-open"], study: ["graduation-cap", "book-open"], course: ["graduation-cap", "presentation"], university: ["graduation-cap", "landmark"],
  book: ["book", "book-open", "library"], ebook: ["book-open", "tablet"], library: ["library", "book"], comic: ["book-open", "sparkles"],
  backup: ["archive", "database-backup", "save"], archive: ["archive", "package"], old: ["archive", "clock"],
  config: ["settings", "sliders-horizontal", "wrench"], setting: ["settings", "sliders-horizontal"], dotfile: ["settings", "file-cog"],
  desktop: ["monitor"], template: ["layout-template", "copy"], public: ["globe", "share-2"], share: ["share-2", "users"], shared: ["share-2", "users"],
  note: ["notebook-pen", "sticky-note", "notebook"], journal: ["notebook-pen", "book-heart"], diary: ["book-heart", "notebook-pen"],
  recipe: ["chef-hat", "utensils", "cooking-pot"], food: ["utensils", "apple"], cook: ["chef-hat", "cooking-pot"],
  money: ["wallet", "piggy-bank", "banknote"], finance: ["wallet", "landmark", "chart-line"], bank: ["landmark", "piggy-bank"], tax: ["receipt", "landmark"], invoice: ["receipt", "file-text"], receipt: ["receipt"], bill: ["receipt", "banknote"],
  travel: ["plane", "map", "luggage"], trip: ["plane", "map", "luggage"], vacation: ["tree-palm", "plane"], holiday: ["tree-palm", "sun"],
  trash: ["trash"], junk: ["trash"], temp: ["clock", "timer"], tmp: ["clock"],
  cloud: ["cloud"], sync: ["refresh-cw", "cloud"], drive: ["hard-drive"], disk: ["hard-drive", "disc"], iso: ["disc", "disc-3"],
  phone: ["smartphone"], mobile: ["smartphone"], android: ["smartphone"],
  font: ["type", "a-large-small"], script: ["terminal", "scroll"], bin: ["terminal", "binary"], app: ["app-window", "layout-grid"], program: ["app-window", "package"], software: ["package", "app-window"], driver: ["cpu", "package"], install: ["package", "download"],
  family: ["users", "heart", "house"], kid: ["baby", "toy-brick"], baby: ["baby"], friend: ["users", "heart"], people: ["users"], wedding: ["heart", "gem"],
  home: ["house"], house: ["house"], car: ["car"], bike: ["bike"], health: ["heart-pulse", "stethoscope"], medical: ["stethoscope", "pill"], fitness: ["dumbbell", "heart-pulse"], sport: ["trophy", "volleyball"],
  art: ["palette", "brush"], design: ["pen-tool", "palette"], drawing: ["pencil", "brush"], paint: ["paintbrush", "palette"], model: ["box", "boxes"], print: ["printer"], "3d": ["box", "printer"],
  mail: ["mail"], email: ["mail"], web: ["globe"], site: ["globe"], blog: ["rss", "pen-line"],
  log: ["scroll-text"], data: ["database"], db: ["database"], vm: ["server", "monitor"], server: ["server"], docker: ["container"], key: ["key-round", "lock"], secret: ["lock", "shield"], private: ["lock", "eye-off"], password: ["key-round", "lock"],
  fav: ["star", "heart"], favorite: ["star", "heart"], favourite: ["star", "heart"], best: ["star", "trophy"], todo: ["list-todo", "square-check"], inbox: ["inbox"], misc: ["shapes", "package"], stuff: ["shapes", "package"], other: ["shapes"],
  pet: ["paw-print", "dog", "cat"], dog: ["dog", "paw-print"], cat: ["cat", "paw-print"], garden: ["flower-2", "sprout", "trees"], plant: ["sprout", "leaf"], nature: ["trees", "mountain"],
  science: ["flask-conical", "atom"], research: ["microscope", "flask-conical"], math: ["sigma", "calculator"], ai: ["brain", "sparkles", "bot"], robot: ["bot"], electronics: ["cpu", "circuit-board"], arduino: ["cpu", "circuit-board"], tool: ["wrench", "hammer"], 
  map: ["map", "map-pinned"], gps: ["map-pin", "navigation"], weather: ["cloud-sun"], astro: ["telescope", "moon-star"], space: ["rocket", "orbit"], star: ["star"],
};
// What any folder might be: after the suggestions from its name.
const COMMON_FOLDER_ICONS = ["folder", "folder-open", "folder-heart", "folder-lock", "folder-code", "folder-git-2", "folder-kanban", "folder-archive", "folder-cog", "folder-search", "star", "heart", "bookmark", "house", "briefcase", "book-open", "code", "terminal", "music", "image", "camera", "film", "clapperboard", "tv", "gamepad-2", "download", "archive", "package", "cloud", "hard-drive", "database", "settings", "wrench", "lock", "key-round", "users", "graduation-cap", "file-text", "notebook-pen", "globe", "wallet", "receipt", "plane", "map", "palette", "pen-tool", "printer", "flask-conical", "rocket", "sparkles", "trophy", "flag", "zap", "trash"];

// Icons for a folder called `name`: its words, as Lucide names them (or tags
// them), and as FOLDER_WORDS has them; then the common ones.
function suggestIcons(name, current) {
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  const forms = [...new Set(words.flatMap((w) => [w, w.replace(/(ies)$/, "y"), w.replace(/s$/, "")]))].filter((w) => w.length >= 2);
  const out = [];
  const add = (n) => lucideTags[n] && !out.includes(n) && out.push(n);
  if (current) add(current);
  for (const w of forms) (FOLDER_WORDS[w] ?? []).forEach(add);
  for (const w of forms.filter((w) => w.length >= 3)) {
    for (const n of Object.keys(lucideTags)) if (n === w || n.startsWith(w + "-")) add(n);
  }
  for (const w of forms.filter((w) => w.length >= 3)) {
    for (const [n, tags] of Object.entries(lucideTags)) if (tags.includes(w)) add(n);
  }
  out.splice(30);
  COMMON_FOLDER_ICONS.forEach(add);
  return out.slice(0, 60);
}

// The picker (over Properties): resolves to the icon's name, or null when closed.
// Typing searches all of them by name and tags; Enter takes the best match.
const iconPicker = $("#icon-picker");
async function pickIcon(current, folderName) {
  await loadLucideTags();
  const button = (name) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.name = name;
    b.title = name.replaceAll("-", " ");
    b.innerHTML = icon(`l:${name}`);
    b.classList.toggle("current", name === current);
    return b;
  };
  const all = $("#icons-all");
  if (!all.firstChild) all.append(...Object.keys(lucideTags).map(button)); // once: they're the same every time
  for (const b of all.children) b.classList.toggle("current", b.dataset.name === current);
  $("#icons-suggested").replaceChildren(...suggestIcons(folderName, current).map(button));
  const search = $("#icon-search");
  search.value = "";
  // Searching: the matches, best first (the word as the name, or part of it,
  // or a tag; then names and tags that only contain it), in place of the lists.
  const suggested = $("#icons-suggested").children.length ? [...$("#icons-suggested").children] : [];
  const filter = () => {
    const words = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const searching = words.length > 0;
    iconPicker.querySelector("h3.suggested").textContent = searching ? "Matches" : "Suggested";
    iconPicker.querySelectorAll(".all, #icons-all").forEach((el) => (el.hidden = searching));
    if (!searching) {
      $("#icons-suggested").replaceChildren(...suggested);
      iconPicker.querySelector(".none").hidden = true;
      return;
    }
    const score = (name) => {
      const parts = name.split("-"), tags = lucideTags[name];
      let total = 0;
      for (const w of words) {
        const s = name === w ? 8 : parts.includes(w) ? 6 : tags.includes(w) ? 5 : parts.some((p) => p.startsWith(w)) ? 3 : tags.some((t) => t.split(" ").includes(w)) ? 3 : name.includes(w) ? 1 : tags.some((t) => t.includes(w)) ? 0.5 : 0;
        if (!s) return 0;
        total += s;
      }
      return total;
    };
    const found = Object.keys(lucideTags).map((n) => [n, score(n)]).filter(([, s]) => s).sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
    $("#icons-suggested").replaceChildren(...found.slice(0, 240).map(([n]) => button(n)));
    iconPicker.querySelector(".none").hidden = found.length > 0;
  };
  filter();
  search.oninput = filter;
  iconPicker.querySelector(".scroll").scrollTop = 0;
  return new Promise((resolve) => {
    let picked = null;
    iconPicker.onclick = (e) => {
      const b = e.target.closest(".grid button");
      if (!b) return;
      picked = b.dataset.name;
      iconPicker.close();
    };
    search.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key !== "Enter") return;
      e.preventDefault();
      const first = $("#icons-suggested").firstElementChild;
      if (first) (picked = first.dataset.name), iconPicker.close();
    };
    iconPicker.addEventListener("close", () => resolve(picked), { once: true });
    iconPicker.showModal();
    search.focus();
  });
}

// rwxr-xr-x, with a leading d for a folder, and setuid, setgid and sticky
// shown as ls does. (Of what a link points to: a link's own are always rwx.)
// The drive part of Properties: the disk (model, how it's connected), the file
// system, the space, and the read speed (hdparm, run on request, as root: it
// asks for the password; the last result is kept per disk).
async function showDrive(path, fact) {
  const pending = fact("Drive", { dim: "…" });
  const d = await api(`/api/drive?path=${encodeURIComponent(path)}`).catch(() => null);
  if (!d) return pending.replaceChildren("?");
  const space = state.space[path];
  if (d.network) {
    pending.previousElementSibling.textContent = "Share";
    pending.replaceChildren(d.source, Object.assign(document.createElement("span"), { className: "dim", textContent: `  ${d.fstype}` }));
    if (space) fact("Space", `${formatSize(space.avail)} free of ${formatSize(space.size)}`);
    return speedRow(path, fact("Speed"), d.speed, true);
  }
  const how = { nvme: "NVMe", usb: "USB", sata: "SATA", ata: "ATA", mmc: "SD card" }[d.disk?.transport] ?? d.disk?.transport;
  pending.replaceChildren(d.disk?.model ?? d.source, d.disk ? Object.assign(document.createElement("span"), { className: "dim", textContent: `  ${[d.disk.size, how, d.disk.rotational ? "spinning" : null].filter(Boolean).join(" · ")}` }) : "");
  fact("Device", { code: d.disk?.path ?? d.source }, { dim: `  ${d.source !== d.disk?.path ? d.source + " · " : ""}${d.fstype}` });
  if (space) fact("Space", `${formatSize(space.avail)} free of ${formatSize(space.size)}`, { dim: `  ${Math.round((1 - space.avail / space.size) * 100)}% used` });
  if (!d.disk) return;
  speedRow(path, fact("Read speed"), d.speed, false);
}

// "Run speed test" and its last result: a disk's read speed (as root), or a
// share's both ways (network: a test file written to it and read back).
function speedRow(path, speed, last, network) {
  const mb = (n) => `${Math.round(n).toLocaleString()} MB/s`;
  const show = (s, error) => {
    const text = document.createElement("span");
    const mbs = s?.read ?? s?.buffered; // .buffered: hdparm's, from before
    text.textContent = !mbs ? "not tested yet"
      : network ? `${mb(s.read)} down, ${mb(s.write)} up (a test file written and read back)`
      : `${mb(mbs)} reading from the disk`;
    const when = document.createElement("span");
    when.className = "dim";
    when.textContent = error ? `  ${error}` : s ? `  ${formatDate(s.at)}` : "";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "speed-test";
    button.textContent = mbs ? "Test again" : "Run speed test";
    button.title = network
      ? "Writes a test file to the share for up to 10 s, reads it back for up to 10 s, then removes it"
      : "Reads up to 4 GB straight from the disk, 15 s at most; as root, with sudo (it asks for the password unless sudo still remembers it)";
    button.onclick = async () => {
      button.disabled = true;
      // Until the password's given there's no telling; then the test takes up to 15 s.
      const spinner = Object.assign(document.createElement("span"), { className: "spinner" });
      const status = document.createElement("span");
      button.replaceChildren(spinner, status);
      let started = Date.now(), timer = null;
      const tick = () => (status.textContent = `Testing… ${Math.round((Date.now() - started) / 1000)} s`);
      const counting = () => (started = Date.now(), tick(), clearInterval(timer), (timer = setInterval(tick, 500)));
      try {
        counting();
        show(await withSudo(() => api("/api/drive-speed", { method: "POST", body: JSON.stringify({ path }) }), {
          ok: "Run",
          onAsk: () => (clearInterval(timer), (status.textContent = "Waiting for the password…")),
          onRetry: counting,
        }));
        refreshSpeeds(); // the sidebar's tooltip
      } catch (err) {
        show(s, err.message);
      } finally {
        clearInterval(timer);
      }
    };
    speed.replaceChildren(text, when, document.createElement("br"), button);
  };
  show(last);
}

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
// A hook (its `sudo`) wanting the password: asked for, then it runs again.
// Resolves to the last run, as /api/run-hook gives it.
async function runHookWithSudo(path, command, first = null) {
  const once = () => api("/api/run-hook", { method: "POST", body: JSON.stringify({ path, command }) })
    .catch((err) => ({ ok: false, code: -1, output: err.message }));
  const asSudo = async () => {
    const run = first ?? await once();
    first = null;
    if (!run.needsSudo) return run;
    throw Object.assign(new Error(`“${command}” (when ${path.split("/").pop()} changes) needs root.\nPassword for sudo:`), { status: 401 });
  };
  try {
    return await withSudo(asSudo, { ok: "Run" });
  } catch (err) {
    return { ok: false, code: -1, output: err.cancelled ? "Cancelled: it needs sudo's password" : err.message };
  }
}

async function onHookRan(ran) {
  // It ran while a phil window showed its folder; one whose sudo wanted the password asks for it.
  const { path, command } = ran;
  const { ok, code, output } = ran.needsSudo ? await runHookWithSudo(path, command, ran) : ran;
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

// A click on a place opens it here, not left to the link: WebKit doesn't always
// follow one (these can be dragged too), and then a click did nothing.
$("#places").addEventListener("click", (e) => {
  const a = e.target.closest("a[data-path]");
  if (!a || e.button !== 0 || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || e.defaultPrevented) return;
  e.preventDefault();
  debug(`opening ${a.dataset.path} (sidebar click)`);
  navigate(a.dataset.path);
});

// A place in the sidebar right- or middle-dragged: as a folder tile is (its
// menu, shown on the press, goes once it moves). See placeItem.
$("#places").addEventListener("pointerdown", (e) => {
  if (e.button !== 1 && e.button !== 2) return;
  const place = placeItem(e.target);
  if (!place) return;
  if (e.button === 1) e.preventDefault(); // no autoscroll
  drag = { id: e.pointerId, button: e.button, place, start: [e.clientX, e.clientY], client: [e.clientX, e.clientY] };
  addEventListener("pointermove", moveDrag);
  addEventListener("pointerup", endDrag);
  addEventListener("pointercancel", endDrag);
});

// The sidebar's place under `el`, as a dragged item: {item, fixed}. A drive,
// home or / (`fixed`) only moves within the sidebar: it isn't moved or copied.
function placeItem(el) {
  const a = el.closest?.("#places a[data-path]");
  const p = a && state.init.places.find((p) => p.path === a.dataset.path);
  if (!p) return null;
  return { item: { path: p.path, name: p.description || p.name, kind: "dir" }, fixed: isMount(p) || p.path === "/" || p.path === state.init.home };
}

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
  markTarget(d.target, null);
  fileDrag = { items: d.items, paths: d.paths, dirs: d.dirs, button: d.button };
  fileDrag.id = announceDrag([...d.paths], d.button);
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
  if (drag.place) drag.items = [drag.place.item], drag.fixed = drag.place.fixed;
  else {
    if (!state.marked.has(state.view[drag.index].path)) select(drag.index, { scroll: false });
    drag.items = markedEntries();
  }
  drag.paths = new Set(drag.items.map((e) => e.path));
  drag.dirs = drag.items.filter((e) => e.kind === "dir").map((e) => e.path + "/");
  const ghost = (drag.ghost = document.createElement("div"));
  ghost.className = "drag-ghost";
  drag.picture = dragPicture(drag.items, drag.place ? drag.items[0] : state.view[drag.index]);
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
// Where a drag would drop: a folder (its tile, a place, a part of the path).
// A right-drag can also go to the folder it came from (the tiles' empty space,
// a file's tile, that folder in the path), for copies there (`here`).
// Between the sidebar's folders, a folder goes in it (`gap`). A sidebar's drive
// (or home, or /) dragged goes only there (`fixed`: not moved or copied).
function dropTargetAt(x, y, drag) {
  const gap = drag.dirs.length ? placeGapAt(x, y) : null;
  if (gap) return gap;
  if (drag.fixed) return null;
  const el = document.elementFromPoint(x, y);
  const tile = el?.closest(".tile");
  const target = tile ? state.view[tile.dataset.index] : null;
  const path = target ? (target.kind === "dir" ? target.path : null) : el?.closest("[data-path]")?.dataset.path;
  if (drag.button === 2 && (path === state.path || (!path && el?.closest("#files")) || (target && drag.paths.has(target.path)))) {
    return { path: state.path, el: path === state.path ? el.closest("[data-path]") : $("#files"), here: true };
  }
  if (!path || path === state.path || drag.paths.has(path)) return null;
  if (drag.dirs.some((d) => (path + "/").startsWith(d))) return null; // into itself
  return { path, el: tile ?? el.closest("[data-path]") };
}

// Shows where a drag would drop (and stops showing where it was): a folder lit
// up, or a line between two of the sidebar's folders (`cls`).
function markTarget(old, next) {
  if (old?.el === next?.el && old?.cls === next?.cls) return;
  old?.el.classList.remove(old.cls ?? "drop-target");
  next?.el.classList.add(next.cls ?? "drop-target");
}

// Between two of the sidebar's folders, or after the last (within a few pixels
// of where they meet): a folder dropped there goes in the sidebar as a link,
// or moves there if it's in it already. {before: the folder after it, or null}.
function placeGapAt(x, y) {
  const nav = $("#places");
  const r = nav.getBoundingClientRect();
  if (x < r.left || x > r.right) return null;
  const folders = [...nav.querySelectorAll("a.folder")];
  for (const [i, a] of folders.entries()) {
    const b = a.getBoundingClientRect();
    if (y >= b.top - 4 && y < b.top + 5) return { gap: true, before: a.dataset.path, el: a, cls: "gap-before" };
    if (y >= b.bottom - 5 && y < b.bottom + 4) {
      const next = folders[i + 1];
      return next ? { gap: true, before: next.dataset.path, el: next, cls: "gap-before" } : { gap: true, before: null, el: a, cls: "gap-after" };
    }
  }
  return null;
}

// Folders dropped between the sidebar's: links to them there (`before` that one; null: last).
async function addToSidebar(paths, before) {
  try {
    await api("/api/sidebar", { method: "POST", body: JSON.stringify({ add: paths, before }) });
    await refreshPlaces();
  } catch (err) {
    alert(err.message);
  }
}

async function removeFromSidebar(p) {
  try {
    await api("/api/sidebar", { method: "POST", body: JSON.stringify({ remove: p.path }) });
    await refreshPlaces();
  } catch (err) {
    alert(err.message);
  }
}

function updateDrag() {
  const [x, y] = drag.client;
  drag.ghost.style.transform = `translate(${x - DRAG_HOTSPOT[0]}px, ${y - DRAG_HOTSPOT[1]}px)`;
  const target = dropTargetAt(x, y, drag);
  markTarget(drag.target, target);
  drag.target = target;
  const verb = drag.button === 1 ? "Move" : "Move or copy";
  drag.label.textContent = target?.gap ? (drag.place ? "Move it here" : "Add to the sidebar") : target?.here ? "Copy here" : target ? `${verb} to ${target.path.split("/").pop() || "/"}` : "";
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
  markTarget(d.target, null);
  if (e.type === "pointercancel") return;
  d.target = dropTargetAt(e.clientX, e.clientY, d); // where it's let go
  if (!d.target) return;
  if (d.target.gap) return addToSidebar(d.dirs.map((p) => p.slice(0, -1)), d.target.before);
  const name = d.target.path.split("/").pop() || "/";
  if (d.button === 1) return transfer("move", d.items, d.target.path);
  if (d.target.here) return showMenu(e.clientX, e.clientY, [["Copy here", () => transfer("copy", d.items, d.target.path)]]);
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
  fileDrag.id = announceDrag(items.map((m) => m.path), 0);
  e.dataTransfer.effectAllowed = "copyMove";
  e.dataTransfer.setData("text/uri-list", items.map((m) => fileUri(m.path)).join("\r\n"));
  e.dataTransfer.setData("text/plain", items.map((m) => m.path).join("\n"));
});

// A place in the sidebar dragged: to another spot among its folders, or (a
// folder, not a drive, home or /) onto a folder, as a tile is: moved or copied there.
$("#places").addEventListener("dragstart", (e) => {
  const place = placeItem(e.target);
  if (!place) return e.preventDefault();
  hideContextMenu();
  const { item, fixed } = place;
  const picture = dragPicture([item]);
  picture.style.cssText += `position: fixed; z-index: 30; left: ${e.clientX - DRAG_HOTSPOT[0]}px; top: ${e.clientY - DRAG_HOTSPOT[1]}px;`;
  document.body.append(picture);
  e.dataTransfer.setDragImage(picture, DRAG_HOTSPOT[0], DRAG_HOTSPOT[1]);
  setTimeout(() => picture.remove());
  fileDrag = { items: [item], paths: new Set([item.path]), dirs: [item.path + "/"], button: 0, fixed };
  fileDrag.id = announceDrag([item.path], 0);
  // (Moving it in the sidebar is a "move" too: WebKit drops nothing whose
  // effect the drag didn't allow, and a page's drags can't allow "link".)
  e.dataTransfer.effectAllowed = "copyMove";
  e.dataTransfer.setData("text/uri-list", fileUri(item.path));
  e.dataTransfer.setData("text/plain", item.path);
});

// Whatever is dragged over the window, nothing dropped on it loads in it (the
// webview would open a dropped file in place of phil).
// Drops from outside: another phil window, a file manager... Their files come
// as file:// URIs; onto a folder (a tile, a place, a part of the path) or the
// empty space (the folder shown), then "Move to" / "Copy to", as a drag here.
let outsideTarget = null;

// Files, or links (a magnet, a web link: downloaded there, see downloadLinks); plain text may be a link too.
const carriesFiles = (dt) => [...(dt?.types ?? [])].some((t) => t === "text/uri-list" || t === "Files" || t === "text/plain" || t === "text/x-moz-url");

function outsideTargetAt(x, y) {
  const gap = placeGapAt(x, y);
  if (gap) return gap;
  const el = document.elementFromPoint(x, y);
  const tile = el?.closest(".tile");
  const entry = tile ? state.view[tile.dataset.index] : null;
  const path = entry ? (entry.kind === "dir" ? entry.path : null) : el?.closest("[data-path]")?.dataset.path;
  if (path) return { path, el: tile ?? el.closest("[data-path]") };
  if (el?.closest("#files")) return { path: state.path, el: $("#files") }; // empty space, a file: the folder shown
  return null;
}

function setOutsideTarget(target) {
  markTarget(outsideTarget, target);
  outsideTarget = target;
}

// The files a drop carries: file:// URIs (text/uri-list), or paths one per line
// (text/plain: what phil's own drags carry too, and some programs only that), or
// links to them (text/html: a drag from another phil window comes with its
// text/uri-list empty, WebKit's doing, and the files only as links there).
function filePaths(dt) {
  const html = dt.getData("text/html");
  const links = html ? [...new DOMParser().parseFromString(html, "text/html").querySelectorAll("a[href]")].map((a) => a.getAttribute("href")) : [];
  const lines = [dt.getData("text/uri-list"), dt.getData("text/plain"), ...links].join("\n").split(/\r?\n/).map((l) => l.trim());
  const paths = lines.flatMap((l) => {
    if (l.startsWith("file://")) {
      try {
        return [decodeURIComponent(new URL(l).pathname)];
      } catch {
        return [];
      }
    }
    return l.startsWith("/") && !l.includes("\0") ? [l] : [];
  });
  return [...new Set(paths)];
}

// The links a drop carries that can be downloaded (panda-dl: magnet links and web links).
function downloadLinks(dt) {
  const html = dt.getData("text/html");
  const links = html ? [...new DOMParser().parseFromString(html, "text/html").querySelectorAll("a[href]")].map((a) => a.getAttribute("href")) : [];
  const lines = [dt.getData("text/uri-list"), dt.getData("text/x-moz-url"), dt.getData("text/plain"), ...links].join("\n").split(/\r?\n/).map((l) => l.trim());
  return [...new Set(lines.filter((l) => /^(magnet:\?|https?:\/\/)\S+$/i.test(l)))];
}

// Downloads of links or .torrent files into `dir` (panda-dl's; their bars show as they go).
async function download(uris, dir) {
  const name = dir.split("/").pop() || "/";
  let added = 0;
  for (const uri of uris) {
    try {
      await api("/api/download", { method: "POST", body: JSON.stringify({ action: "add", uri, dir }) });
      added++;
    } catch (err) {
      alert(`Couldn't download ${uri.length > 80 ? uri.slice(0, 77) + "…" : uri}\n${err.message}`);
    }
  }
  if (added) flashStatus(`Downloading ${added === 1 ? "it" : `${added} things`} into “${name}”`);
}

// A drag out of a phil window: its files (and button) for the window it's dropped
// on. Its id tells this window whether a drag it remembers is still the one
// going on (a right- or middle-drag out of it ends without telling it).
function announceDrag(paths, button) {
  const id = crypto.randomUUID();
  api("/api/drag", { method: "PUT", body: JSON.stringify({ paths, button, id }) }).catch(() => {});
  return id;
}

// This window's drag, still going on? Not when another (window) has started one since.
async function staleDrag() {
  if (!fileDrag || fileDrag.button === 0) return false; // a left drag's end is heard of
  const current = await api("/api/drag").catch(() => null);
  return current?.id !== fileDrag.id;
}

async function dropFromOutside(e, carried, links = []) {
  const target = outsideTarget;
  setOutsideTarget(null);
  if (!target) return;
  // Links (no files): downloaded into the folder they're dropped on.
  if (!carried.length && links.length) return target.gap ? flashStatus("Drop links on a folder to download them there") : download(links, target.path);
  let paths = carried;
  // From another phil window: what it said it's dragging (its files, when the drop lost them; its button).
  const phil = await api("/api/drag").catch(() => null);
  const fromPhil = phil && (!paths.length || paths.every((p) => phil.paths.includes(p)));
  if (fromPhil) {
    paths = phil.paths;
    api("/api/drag", { method: "DELETE" }).catch(() => {});
  }
  if (target.gap) return addToSidebar(paths, target.before);
  paths = paths.filter((p) => p !== target.path && !target.path.startsWith(p + "/")); // not into itself
  if (!paths.length) return flashStatus("Only files, folders and links can be dropped here");
  const items = paths.map((path) => ({ path }));
  const name = target.path.split("/").pop() || "/";
  // .torrent files: downloaded there, first of the choices.
  if (!fromPhil && paths.every((p) => /\.torrent$/i.test(p))) {
    return showMenu(e.clientX, e.clientY, [
      [`Download into “${name}”`, () => download(paths, target.path)],
      [`Move to “${name}”`, () => transfer("move", items, target.path)],
      [`Copy to “${name}”`, () => transfer("copy", items, target.path)],
    ]);
  }
  if (fromPhil && phil.button === 1 && !paths.every((p) => parentOf(p) === target.path)) return transfer("move", items, target.path); // middle: moves
  // All of it from that very folder (another window showing it): copies of them there.
  if (paths.every((p) => parentOf(p) === target.path)) return showMenu(e.clientX, e.clientY, [["Copy here", () => transfer("copy", items, target.path)]]);
  showMenu(e.clientX, e.clientY, [
    [`Move to “${name}”`, () => transfer("move", items, target.path)],
    [`Copy to “${name}”`, () => transfer("copy", items, target.path)],
  ]);
}
addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) setOutsideTarget(null); // out of the window
});

addEventListener("dragover", (e) => {
  e.preventDefault();
  if (!fileDrag) { // from outside
    setOutsideTarget(carriesFiles(e.dataTransfer) ? outsideTargetAt(e.clientX, e.clientY) : null);
    e.dataTransfer.dropEffect = outsideTarget ? "copy" : "none";
    return;
  }
  const target = dropTargetAt(e.clientX, e.clientY, fileDrag);
  markTarget(fileDrag.target, target);
  fileDrag.target = target;
  e.dataTransfer.dropEffect = target ? "move" : "none"; // between the sidebar's folders too (see its dragstart)
});
addEventListener("dragenter", () => staleDrag().then((stale) => stale && endFileDrag()));
addEventListener("drop", async (e) => {
  e.preventDefault();
  const carried = filePaths(e.dataTransfer), links = downloadLinks(e.dataTransfer); // the drop's data: gone once this handler awaits
  if (fileDrag && (await staleDrag())) endFileDrag(), setOutsideTarget(outsideTargetAt(e.clientX, e.clientY));
  if (!fileDrag) return dropFromOutside(e, carried, links);
  const target = fileDrag?.target;
  const { items, button, dirs } = fileDrag ?? {};
  endFileDrag();
  if (!target) return;
  if (target.gap) return addToSidebar(dirs.map((p) => p.slice(0, -1)), target.before);
  if (button === 1) return transfer("move", items, target.path);
  const name = target.path.split("/").pop() || "/";
  showMenu(e.clientX, e.clientY, [
    [`Move to “${name}”`, () => transfer("move", items, target.path)],
    [`Copy to “${name}”`, () => transfer("copy", items, target.path)],
  ]);
});
function endFileDrag() {
  markTarget(fileDrag?.target, null);
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

// A message in the status bar, for a few seconds.
function flashStatus(text, ms = 3500) {
  const el = $("#status-progress");
  el.textContent = text;
  clearTimeout(flashStatus.timer);
  flashStatus.until = Date.now() + ms;
  flashStatus.timer = setTimeout(() => {
    if (el.textContent === text) updateProgress();
  }, ms);
}

// `resume`: a stopped copy (its target has the record) goes on where it stopped.
async function transfer(op, items, dest, { resume = false, target = null } = {}) {
  let result;
  try {
    result = await api("/api/transfer", { method: "POST", body: JSON.stringify({ op, dest, paths: items.map((e) => e.path), resume, target }) });
  } catch (err) {
    result = { errors: [{ path: "", error: err.message }] };
  }
  if (result.cancelled) {
    result.errors = result.errors.filter((e) => e.error !== "cancelled");
    flashStatus(`${op === "move" ? "Moving" : "Copying"} stopped: what was done stays ${op === "move" ? "moved" : "copied"}; ↻ on the folder goes on`);
  }
  await load(state.path);
  // What's made here (copies in the same folder) is selected.
  const made = new Set(result.made ?? []);
  const first = state.view.findIndex((e) => made.has(e.path));
  if (first !== -1) {
    select(first);
    setMarked(state.view.filter((e) => made.has(e.path)).map((e) => e.path));
    updateStatus();
  }
  if (result.errors.length) {
    alert(`Couldn't ${op} ${result.errors.length} item(s):\n` +
      result.errors.map((e) => `${e.path.split("/").pop()}: ${e.error}`).join("\n"));
  }
}

// ---------------------------------------------------------------- cut, copy, paste

// Ctrl+C / Ctrl+X: the selection, to paste (Ctrl+V) here or in another phil
// window; the desktop's clipboard gets their paths as text, as before (a
// terminal, a chat...). Pasting goes by what that has now: still these, or
// files copied in another program (file:// URIs, or paths, one per line); text
// copied since means there's nothing to paste.
async function clipFiles(op, entries = markedEntries()) {
  const paths = entries.map((e) => e.path);
  const text = paths.join("\n");
  await copyText(text);
  await api("/api/clipboard", { method: "PUT", body: JSON.stringify({ op, paths, text }) }).catch(() => {});
  state.clip = { op, paths, text };
  markClipboard();
  flashStatus(`${op === "cut" ? "Cut" : "Copied"} ${paths.length === 1 ? paths[0].split("/").pop() : `${paths.length} items`}: Ctrl+V pastes`);
}

async function pasteFiles(dest) {
  const text = (await pasteText()).trim();
  const clip = await api("/api/clipboard").catch(() => null);
  let op = "copy", paths;
  if (clip && clip.text.trim() === text) {
    op = clip.op === "cut" ? "move" : "copy";
    paths = clip.paths;
  } else {
    paths = text.split(/\r?\n/).map((l) => l.trim()).flatMap((l) => {
      if (l.startsWith("file://")) {
        try {
          return [decodeURIComponent(new URL(l).pathname)];
        } catch {
          return [];
        }
      }
      return l.startsWith("/") ? [l] : [];
    });
  }
  // A cut pasted where it is stays; nothing goes into itself.
  paths = paths.filter((p) => !(op === "move" && parentOf(p) === dest) && dest !== p && !dest.startsWith(p + "/"));
  if (!paths.length) return flashStatus(text ? "Nothing to paste here" : "Nothing to paste: copy or cut files first (Ctrl+C, Ctrl+X)");
  await transfer(op, paths.map((path) => ({ path })), dest);
  if (op === "move") await api("/api/clipboard", { method: "DELETE" }).catch(() => {}); // moved: nothing left to paste
}

// Tiles of what's copied (outlined) or cut (outlined and faded).
function markClipboard() {
  document.querySelectorAll(".tile.clip-copy, .tile.clip-cut").forEach((t) => t.classList.remove("clip-copy", "clip-cut"));
  for (const path of state.clip?.paths ?? []) tiles.get(path)?.classList.add(state.clip.op === "cut" ? "clip-cut" : "clip-copy");
}

// The menus' Cut, Copy, Paste.
const clipItems = (entry) => {
  const many = state.marked.size > 1 && state.marked.has(entry.path);
  const entries = many ? markedEntries() : [entry];
  return [
    [many ? `Cut ${entries.length} items` : "Cut", () => clipFiles("cut", entries)],
    [many ? `Copy ${entries.length} items` : "Copy", () => clipFiles("copy", entries)],
  ];
};

// ---------------------------------------------------------------- copy and move progress

// Copies and moves already under way when this window opened (or its
// connection came back): a paused one sends nothing till it goes on.
async function loadTransfers() {
  const list = await api("/api/transfers").catch(() => null);
  if (!list) return;
  state.transfers = new Map(list.map((t) => [t.id, t]));
  showTransfers();
  if (list.length) onTransfer(list[0]);
}

// The server's progress for a copy or move ({id, op, dest, bytes, total,
// percent, speed, eta}, then {id, finished}): a bar on the folder it goes to
// (its tile, when it's shown) and in the sidebar's Transfers, each with ×
// to cancel it.
// Copies and moves cut off (a crash, phil closed, ×), wherever they are: in the
// Transfers list, with ↻ to go on and × to forget them. Asked for again when
// one stops, finishes or is forgotten (in any window).
async function loadStoppedTransfers() {
  const list = await api("/api/stopped-transfers").catch(() => null);
  if (!list) return;
  state.stopped = list;
  renderTransferList();
}

function onTransfer(p) {
  if (p.finished) state.transfers.delete(p.id);
  else state.transfers.set(p.id, p);
  showTransfers();
}

function showTransfers() {
  // Where each bar goes: element -> [{key, t, ofFile} or {key, stopped: entry}]. Bars are
  // kept and updated in place (keyed), so one being clicked isn't swapped out.
  const bars = new Map();
  const add = (host, bar) => host && (bars.get(host) ?? bars.set(host, []).get(host)).push(bar);
  const live = new Set();
  for (const t of state.transfers.values()) {
    if (t.op !== "delete") add(tiles.get(t.dest), { key: `${t.id} dest`, t }); // a delete's: on what's going
    for (const target of t.targets ?? []) { // what it's making: the folder (or file) being copied
      live.add(target);
      add(tiles.get(target), { key: `${t.id} target`, t });
    }
    if (t.file && t.file !== t.targets?.[0]) { // the file it's at: how far into it
      live.add(t.file);
      add(tiles.get(t.file), { key: `${t.id} file`, t: { ...t, percent: t.filePercent ?? 0 }, ofFile: true });
    }
  }
  // Downloads (panda-dl's): on what's being downloaded (once it's there), and the folder it goes to.
  // Finished ones still in its list (seeding, say): a quiet mark on what was downloaded, with × to take it off.
  for (const d of state.downloads) {
    // What it's writing, each with its own progress (a torrent finishes its files at different
    // times), and the folders in it with theirs together.
    for (const [path, part] of downloadParts(d)) add(tiles.get(path), { key: `download ${d.id}`, d, part: { ...part, path } });
    if (d.state === "completed") continue;
    add(tiles.get(d.dir), { key: `download ${d.id} folder`, d });
  }
  // Copies cut off (a crash, ×): their record says how far they got; ↻ goes on, × forgets it.
  for (const e of state.view) if (e.copying?.state === "stopped" && !live.has(e.path)) add(tiles.get(e.path), { key: "stopped", stopped: e });
  for (const bar of document.querySelectorAll(".transfer-bar")) if (!bars.has(bar.parentElement)) bars.set(bar.parentElement, []); // none there now
  for (const [host, list] of bars) {
    keyed(host, list, {
      key: (b) => b.key,
      kind: barKind,
      make: (b) => makeTransferBar(barKind(b)),
      show: (bar, b) => (b.d ? showDownloadBar(bar, b.d, b.part) : b.stopped ? showStoppedBar(bar, b.stopped) : showTransferBar(bar, b.t, b)),
    });
    // More than one on a tile (a copy into a folder a download goes to): one under the other.
    [...host.querySelectorAll(":scope > .transfer-bar")].forEach((bar, i) => put(bar.style, "top", i ? `${8 + i * 24}px` : ""));
  }
  renderTransferList();
}

// The sidebar's Transfers: every copy, move, delete and download (paused,
// or finished and still seeding, too), one row each: its name over its bar.
// Clicking one opens the folder it goes to, with what it's making selected.
function renderTransferList() {
  const live = new Set([...state.transfers.values()].flatMap((t) => t.targets ?? [])); // one gone on with (↻) is under way
  const list = [
    ...[...state.transfers.values()].map((t) => ({ key: `transfer ${t.id}`, t })),
    ...state.stopped.filter((e) => !live.has(e.path)).map((e) => ({ key: `stopped ${e.path}`, stopped: e })),
    ...state.downloads.map((d) => ({ key: `download ${d.id}`, d })),
  ];
  keyed($("#transfers"), list, { key: (b) => b.key, kind: barKind, make: makeTransferRow, show: showTransferRow });
  if (!transfersView.hidden) renderTransfersView(list);
}

function makeTransferRow(b) {
  const row = document.createElement("div");
  row.className = "transfer-row";
  row.append(Object.assign(document.createElement("span"), { className: "transfer-name" }), makeTransferBar(barKind(b)));
  row.addEventListener("click", () => goToTransfer(row.item));
  return row;
}

function showTransferRow(row, b) {
  const [name, bar] = row.children;
  bar.item = b;
  if (b.stopped) {
    const c = b.stopped.copying;
    showStoppedBar(bar, b.stopped);
    put(name, "textContent", `${c.op === "move" ? "Moving" : "Copying"} ${b.stopped.path.split("/").pop()}`);
    put(row, "title", `From ${c.from}\nTo ${parentOf(b.stopped.path)}\nClick: show it there`);
    return;
  }
  if (b.d) showDownloadBar(bar, b.d);
  else showTransferBar(bar, b.t);
  const what = b.d ? b.d.name : b.t.items > 1 ? `${b.t.items} items` : (b.t.targets?.[0] ?? b.t.dest).split("/").pop();
  put(name, "textContent", b.d ? what : `${{ move: "Moving", delete: "Deleting" }[b.t.op] ?? "Copying"} ${what}`);
  put(row, "title", b.d ? `${b.d.path ?? b.d.dir}\nClick: show it in ${b.d.dir}` : `${b.t.op === "delete" ? "Deleting in" : "To"} ${b.t.dest}\nClick: show it there`);
}

// The folder a transfer goes to (a delete's: the one it's deleting in), with what it's making selected.
function goToTransfer(b) {
  closeTransfersView();
  if (b.stopped) {
    initialSelect = [b.stopped.path];
    return navigate(parentOf(b.stopped.path));
  }
  const dir = b.d ? b.d.dir : b.t.dest;
  const made = b.d ? (b.d.files?.length ? b.d.files.map((f) => f.path) : [b.d.path]).filter((p) => p?.startsWith(dir + "/")).map((p) => topIn(dir, p))
    : b.t.op === "delete" ? [] : b.t.targets ?? [];
  initialSelect = made.length ? [...new Set(made)] : null;
  navigate(dir);
}

// The entry right in `dir` that `path` is in (or is).
const topIn = (dir, path) => dir + "/" + path.slice(dir.length + 1).split("/")[0];

// ---------------------------------------------------------------- the Transfers view

// The sidebar's Transfers heading: every transfer in full (what, where, how
// far, how fast; a torrent's files, each with its own progress and ×), and
// panda-dl's settings. Over the folder; Esc or × closes it, as does opening a folder.
const transfersView = $("#transfers-view");
let transfersFocus = null;

$("#btn-transfers").onclick = () => (transfersView.hidden ? openTransfersView() : closeTransfersView());
transfersView.querySelector(".tv-head .close").onclick = () => closeTransfersView();

function openTransfersView() {
  // Where the keyboard goes back to: the folder, or the terminal (not the heading clicked to open it).
  transfersFocus = document.activeElement?.closest?.("#sidebar") ? grid : document.activeElement;
  transfersView.hidden = false;
  $("#btn-transfers").setAttribute("aria-pressed", "true");
  renderTransferList();
  loadDownloadSettings();
  transfersView.querySelector(".tv-head .close").focus({ preventScroll: true });
}

function closeTransfersView() {
  if (transfersView.hidden) return;
  transfersView.hidden = true;
  $("#btn-transfers").setAttribute("aria-pressed", "false");
  const back = transfersFocus?.isConnected && transfersFocus !== document.body && !transfersView.contains(transfersFocus) ? transfersFocus : grid;
  back.focus({ preventScroll: true });
}

function renderTransfersView(list) {
  transfersView.querySelector(".tv-empty").hidden = list.length > 0;
  keyed($("#tv-items"), list, { key: (b) => b.key, kind: barKind, make: makeTransferCard, show: showTransferCard });
}

// One transfer: its name and what it is, where it goes (a click: there), its
// bar (with its buttons), the facts, and a torrent's files.
function makeTransferCard(b) {
  const card = document.createElement("article");
  card.className = "tv-card";
  card.innerHTML = `<div class="tv-title"><span class="tv-name"></span><span class="tv-state"></span></div>
    <button type="button" class="tv-where" title="Show it there"></button>
    <div class="tv-facts hint"></div>
    <details class="tv-files" hidden><summary></summary><div class="tv-file-list"></div></details>`;
  card.querySelector(".tv-where").after(makeTransferBar(barKind(b)));
  card.querySelector(".tv-where").onclick = () => goToTransfer(card.item);
  return card;
}

function showTransferCard(card, b) {
  const bar = card.querySelector(".transfer-bar");
  bar.item = b;
  if (b.stopped) showStoppedBar(bar, b.stopped);
  else if (b.d) showDownloadBar(bar, b.d);
  else showTransferBar(bar, b.t);
  const what = b.stopped ? b.stopped.path.split("/").pop() : b.d ? b.d.name : b.t.items > 1 ? `${b.t.items} items` : (b.t.targets?.[0] ?? b.t.dest).split("/").pop();
  put(card.querySelector(".tv-name"), "textContent", what);
  let state, where, facts;
  if (b.stopped) {
    const c = b.stopped.copying;
    state = `${c.op === "move" ? "Moving" : "Copying"} stopped at ${c.percent}%`;
    where = `To ${parentOf(b.stopped.path)}`;
    facts = [`from ${c.from}`, c.total ? `${formatSize(c.bytes)} of ${formatSize(c.total)}` : "", c.updated ? `stopped ${formatDate(c.updated)}` : "", "↻ goes on where it stopped"];
  } else if (b.d) {
    const d = b.d;
    state = d.checking != null ? `Checking its files: ${d.checking}%` : { completed: d.upSpeed > 0 ? "Seeding" : "Downloaded", paused: "Paused", error: "Failed", failed: "Failed", queued: "Queued", metadata: "Finding it", checking: "Checking" }[d.state] ?? "Downloading";
    where = `Into ${d.dir}`;
    const ratio = d.total ? ` (ratio ${(d.uploaded / d.total).toFixed(2)})` : "";
    facts = [
      d.state === "completed" ? formatSize(d.total) : `${formatSize(d.bytes)} of ${formatSize(d.total)}`,
      d.state === "downloading" && d.speed ? `↓ ${formatSize(d.speed)}/s` : "",
      d.state === "downloading" && d.eta ? `${formatDuration(d.eta)} left` : "",
      d.upSpeed ? `↑ ${formatSize(d.upSpeed)}/s` : "",
      d.peers !== null && d.state !== "paused" ? `${d.peers} peer${d.peers === 1 ? "" : "s"}${d.seeds !== null ? `, ${d.seeds} seed${d.seeds === 1 ? "" : "s"}` : ""}` : "",
      d.uploaded ? `${formatSize(d.uploaded)} uploaded${ratio}` : "",
      d.error && (d.state === "error" || d.state === "failed") ? d.error : "",
    ];
  } else {
    const t = b.t;
    state = t.op === "delete" ? (t.counting ? "Counting" : "Deleting") : `${t.paused ? "Paused" : t.op === "move" ? "Moving" : "Copying"}`;
    where = t.op === "delete" ? `In ${t.dest}` : `To ${t.dest}`;
    facts = t.op === "delete"
      ? [t.counting ? `${t.found.toLocaleString()} files and folders so far` : `${t.bytes.toLocaleString()} of ${t.total.toLocaleString()} files and folders gone`]
      : [`${formatSize(t.bytes)} of ${formatSize(t.total)}`, t.paused ? "" : copySpeed(t, " · ").slice(3), t.file ? `at ${t.file.split("/").pop()}` : ""];
  }
  put(card.querySelector(".tv-state"), "textContent", state);
  put(card.querySelector(".tv-where"), "textContent", where);
  put(card.querySelector(".tv-facts"), "textContent", facts.filter(Boolean).join(" · "));
  // A torrent's files (those still in it), each with how far it is, and × to drop it.
  const files = b.d?.files?.length > 1 && b.d.files[0].length !== null ? b.d.files : [];
  const box = card.querySelector(".tv-files");
  put(box, "hidden", !files.length);
  if (!files.length) return;
  const done = files.filter((f) => f.downloaded >= f.length).length;
  put(box.querySelector("summary"), "textContent", `${files.length} files${done && done < files.length ? `, ${done} done` : ""}`);
  keyed(box.querySelector(".tv-file-list"), files, { key: (f) => f.path, make: makeFileRow, show: (row, f) => showFileRow(row, f, b.d) });
}

function makeFileRow() {
  const row = document.createElement("div");
  row.className = "tv-file";
  row.innerHTML = `<span class="tv-file-name"></span><span class="tv-file-size"></span><span class="tv-file-bar"><span class="fill"></span></span><span class="tv-file-pct"></span>`;
  row.append(barButton("×", "", () => stopDownloadPart({ d: row.d, part: { path: row.item.path } })));
  return row;
}

function showFileRow(row, f, d) {
  row.d = d;
  const pct = f.length ? Math.floor((f.downloaded / f.length) * 1000) / 10 : 100;
  put(row.querySelector(".tv-file-name"), "textContent", f.path.slice(d.dir.length + 1));
  put(row.querySelector(".tv-file-name"), "title", f.path);
  put(row.querySelector(".tv-file-size"), "textContent", formatSize(f.length));
  put(row.querySelector(".fill").style, "width", `${pct}%`);
  put(row.querySelector(".tv-file-pct"), "textContent", pct >= 100 ? "Done" : `${pct}%`);
  row.classList.toggle("done", pct >= 100);
  put(row.querySelector(".cancel"), "title", d.state === "completed" || d.files.length === 1
    ? "Drop it (the last of it: the download is closed; the file stays)" : "Stop downloading this (the rest goes on; what's downloaded stays)");
}

// panda-dl's settings: shown as they are, each saved as it's changed.
const settingInputs = [...transfersView.querySelectorAll("[data-setting]")];

async function loadDownloadSettings() {
  const r = await api("/api/download-settings").catch((err) => ({ error: err.message }));
  showDownloadSettings(r);
}

function showDownloadSettings({ running, config, error }) {
  put(transfersView.querySelector(".tv-daemon"), "textContent", error ? `Couldn't read panda-dl's settings: ${error}`
    : !config ? "panda-dl isn't set up yet: these are its defaults, saved when changed."
    : running ? "panda-dl downloads web links and torrents; it's running."
    : "panda-dl downloads web links and torrents. It isn't running now (it starts when something is downloaded); changes are saved for when it does.");
  for (const input of settingInputs) {
    if (document.activeElement === input && input.type !== "checkbox") continue; // being typed in
    const value = config?.[input.dataset.setting];
    if (input.type === "checkbox") input.checked = value ?? true;
    else input.value = value ?? "";
  }
  showClipboardOptions();
}

const showClipboardOptions = () => transfersView.querySelector(".tv-sub").classList.toggle("off", !transfersView.querySelector('[data-setting="auto_capture_clipboard"]').checked);

async function saveDownloadSetting(input) {
  const value = input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value.trim();
  const error = transfersView.querySelector(".tv-error");
  try {
    showDownloadSettings(await api("/api/download-settings", { method: "PUT", body: JSON.stringify({ [input.dataset.setting]: value }) }));
    error.hidden = true;
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    loadDownloadSettings(); // back to what it is
  }
}

for (const input of settingInputs) {
  input.addEventListener("change", () => saveDownloadSetting(input));
  if (input.type === "checkbox") input.addEventListener("change", showClipboardOptions);
  else input.addEventListener("keydown", (e) => e.key === "Enter" && input.blur());
}
$("#tv-dir-here").onclick = () => {
  const input = $("#tv-dir");
  input.value = state.path;
  saveDownloadSetting(input);
};

const partDone = (b) => b.d.state === "completed" || (b.part?.length != null && b.part.downloaded >= b.part.length);
const barKind = (b) => (b.d ? (partDone(b) ? "downloaded" : "download") : b.stopped ? (b.stopped.copying.file ? "stopped-file" : "stopped") : b.t.op === "delete" ? "delete" : "copy");

// A download's files, and the folders in it (below the folder it goes to),
// each with how much of it there is and how much is downloaded: path ->
// {length, downloaded} (null for both: not known, the download's own then).
function downloadParts(d) {
  const parts = new Map();
  for (const f of d.files ?? []) {
    for (let path = f.path; path.length > d.dir.length && path.startsWith(d.dir + "/"); path = parentOf(path)) {
      const part = parts.get(path) ?? parts.set(path, { length: 0, downloaded: 0 }).get(path);
      if (f.length === null || part.length === null) part.length = part.downloaded = null;
      else part.length += f.length, part.downloaded += f.downloaded;
    }
  }
  return parts;
}

// What downloads under way are still writing (not finished files).
const writing = (list) => list.flatMap((d) => (d.state === "completed" ? [] : (d.files ?? []).filter((f) => f.length === null || f.downloaded < f.length).map((f) => f.path)));

// Downloads under way, changed. A file that's done (or stopped) gets its
// thumbnail now (none was made while it was being written), as do the folders it's in.
function onDownloads(list) {
  const still = new Set(writing(list));
  for (const path of writing(state.downloads).flatMap((p) => [p, parentOf(p)])) {
    if (still.has(path)) continue;
    clearTimeout(askAgain.get(path));
    askAgain.delete(path);
    const tile = tiles.get(path), entry = tile && state.view[tile.dataset.index];
    if (!entry || !isNear(tile)) continue;
    if (entry.kind === "dir") wantSummary(tile, entry);
    else if (entry.kind !== "file" && entry.thumb == null) thumbs.want(path, { quiet: true }); // a picture or video without one (not one that failed)
  }
  state.downloads = list;
  showTransfers();
}

// × on a download's bar: on one of its files (or a folder in it), that's no
// longer downloaded (the rest goes on; the last of it: the download is
// removed); on all of it (the folder it goes to, its drive, a finished one), it's
// removed. What's downloaded stays.
function stopDownloadPart({ d, part }) {
  const body = part?.path && d.state !== "completed" && d.files?.length > 1 ? { action: "skip", id: d.id, paths: [part.path] } : { action: "remove", id: d.id };
  api("/api/download", { method: "POST", body: JSON.stringify(body) }).catch((err) => alert(err.message));
}

// A download's bar: how far, its speed and time left (the tooltip), pause or
// go on, and × to stop it (what's downloaded stays).
function showDownloadBar(bar, d, part = null) {
  if (d.state === "completed") part = null; // all of it done: the seeding mark, below
  if (d.state !== "completed" && part?.length != null && part.downloaded >= part.length) { // this file's done, the rest isn't
    put(bar.querySelector(".seeding"), "hidden", true);
    put(bar, "title", `Downloaded (${formatSize(part.length)}); the rest of “${d.name}” is still downloading: ${d.percent}%`);
    put(bar.querySelector(".cancel"), "title", `Drop it from “${d.name}” (it's no longer shared from here; the file stays)`);
    return;
  }
  if (part?.length != null) { // one file (or folder) of it: its own progress
    const pct = part.length ? Math.floor((part.downloaded / part.length) * 1000) / 10 : 0;
    const paused = d.state === "paused", checking = d.checking != null;
    bar.classList.toggle("paused", paused || checking);
    bar.classList.remove("failed");
    put(bar.querySelector(".fill").style, "width", `${pct}%`);
    put(bar.querySelector(".pct"), "textContent", `${paused && !inSidebar(bar) ? "Paused " : checking ? "Checking… " : ""}${pct}%`);
    put(bar, "title", `${formatSize(part.downloaded)} of ${formatSize(part.length)} of this; “${d.name}”: ${d.percent}%` +
      (paused ? " (paused)" : `${d.speed ? `, ${formatSize(d.speed)}/s` : ""}${d.eta ? `, ${formatDuration(d.eta)} left` : ""}`));
    const [toggle, stop] = bar.querySelectorAll(".cancel");
    putIcon(toggle, paused ? "l:play" : "l:pause");
    put(toggle, "title", paused ? `Go on with “${d.name}”` : `Pause “${d.name}”`);
    put(stop, "title", d.files?.length > 1 ? "Stop downloading this (the rest goes on; what's downloaded stays)" : `Stop and forget “${d.name}” (what's downloaded stays)`);
    return;
  }
  if (d.state === "completed") { // still in panda-dl's list: seeding, maybe
    put(bar.querySelector(".cancel"), "title", "Take it off panda-dl's list (it stops seeding; the file stays)");
    const up = d.upSpeed > 0, seeding = bar.querySelector(".seeding");
    put(seeding, "hidden", !up);
    if (up) put(seeding.lastElementChild, "textContent", `${formatSize(d.upSpeed)}/s`);
    put(bar, "title", `Downloaded by panda-dl, still in its list${up ? ", seeding" : ""}: ${formatSize(d.uploaded)} uploaded to others` +
      (d.total ? ` (ratio ${(d.uploaded / d.total).toFixed(2)})` : "") + (d.peers ? `, ${d.peers} peer${d.peers === 1 ? "" : "s"}` : ""));
    return;
  }
  const waiting = d.checking != null ? `Checking ${d.checking}%` : { queued: "Queued", initializing: "Starting…", starting: "Starting…", metadata: "Finding it…", checking: "Checking…" }[d.state];
  const failed = d.state === "error" || d.state === "failed", paused = d.state === "paused";
  bar.classList.toggle("paused", paused || !!waiting);
  bar.classList.toggle("failed", failed);
  put(bar.querySelector(".fill").style, "width", `${d.percent}%`);
  put(bar.querySelector(".pct"), "textContent", failed ? "Failed" : waiting ?? `${paused && !inSidebar(bar) ? "Paused " : ""}${d.percent}%${!paused && d.speed ? ` · ${formatSize(d.speed)}/s` : ""}`);
  const peers = d.peers !== null && !paused ? `, ${d.peers} peer${d.peers === 1 ? "" : "s"}` : "";
  put(bar, "title", `Downloading ${d.name}: ${formatSize(d.bytes)} of ${formatSize(d.total)}` +
    (failed ? `\n${d.error || "it failed"}` : paused ? " (paused)" : `${d.speed ? `, ${formatSize(d.speed)}/s` : ""}${d.eta ? `, ${formatDuration(d.eta)} left` : ""}${peers}`));
  const [toggle, stop] = bar.querySelectorAll(".cancel");
  putIcon(toggle, paused || failed ? "l:play" : "l:pause");
  put(toggle, "title", paused || failed ? "Go on" : "Pause");
  put(stop, "title", "Stop and forget this download (what's downloaded stays)");
}

// A copy's speed and time left (server.js: bytes/s and seconds), after `sep`; "" when not known.
const copySpeed = (t, sep) => (t.speed ? `${sep}${formatSize(t.speed)}/s` : "") + (t.speed && t.eta != null ? `${sep}${formatDuration(t.eta)} left` : "");

function formatDuration(s) {
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

// A progress bar: a copy's or move's (pause, stop), a delete's (stop), or
// one cut off (↻ goes on, × forgets it; a file's only says so). Its data:
// bar.item, as it is now ({t} or {stopped: entry}).
function makeTransferBar(kind) {
  const bar = document.createElement("div");
  bar.className = "transfer-bar";
  const fill = Object.assign(document.createElement("div"), { className: "fill" });
  const label = Object.assign(document.createElement("span"), { className: "pct" }); // not .label: that's the tile's name
  bar.append(fill, label);
  const cancel = () => api("/api/transfer-cancel", { method: "POST", body: JSON.stringify({ id: bar.item.t.id }) }).catch(() => {});
  if (kind === "delete") {
    bar.classList.add("deleting");
    bar.append(barButton("×", "Stop deleting (what's gone is gone; the rest stays)", cancel));
  } else if (kind === "downloaded") {
    bar.classList.add("downloaded");
    // Downloaded (an icon), and while it's seeding, ↑ and how fast.
    label.innerHTML = `${icon("l:download")}<span class="seeding">${icon("l:arrow-up")}<span></span></span>`;
    bar.append(barButton("×", "", () => stopDownloadPart(bar.item)));
  } else if (kind === "download") {
    bar.classList.add("download");
    const act = (action) => api("/api/download", { method: "POST", body: JSON.stringify({ action, id: bar.item.d.id }) }).catch((err) => alert(err.message));
    bar.append(
      barButton("", "", () => act(["paused", "error", "failed"].includes(bar.item.d.state) ? "resume" : "pause")),
      barButton("×", "", () => stopDownloadPart(bar.item)),
    );
  } else if (kind === "copy") {
    const pause = barButton("", "", () => api("/api/transfer-pause", { method: "POST", body: JSON.stringify({ id: bar.item.t.id, pause: !bar.item.t.paused }) }).catch(() => {}));
    pause.classList.add("pause");
    bar.append(pause, barButton("×", "", cancel));
  } else {
    bar.classList.add("stopped");
    if (kind === "stopped") {
      const c = () => bar.item.stopped.copying;
      bar.append(
        barButton("↻", "", () => transfer(c().op, [{ path: c().from }], parentOf(bar.item.stopped.path), { resume: true, target: bar.item.stopped.path })),
        barButton("×", "Forget it (what was copied stays)", async () => {
          await api(`/api/transfer-forget?path=${encodeURIComponent(bar.item.stopped.path)}`, { method: "POST" }).catch(() => {});
          refresh();
        }),
      );
    }
  }
  return bar;
}

function showTransferBar(bar, t, { ofFile = false } = {}) {
  const fill = bar.querySelector(".fill"), label = bar.querySelector(".pct");
  if (t.op === "delete") {
    bar.classList.toggle("counting", !!t.counting); // first, how much there is: no percentage yet
    put(bar, "title", t.counting ? `Counting what's in it before deleting: ${t.found.toLocaleString()} files and folders so far`
      : `Deleting: ${t.bytes.toLocaleString()} of ${t.total.toLocaleString()} files and folders gone`);
    put(fill.style, "width", t.counting ? "100%" : `${t.percent}%`);
    put(label, "textContent", t.counting ? `Counting… ${t.found.toLocaleString()}` : `Deleting ${t.percent}%`);
    return;
  }
  put(bar, "title", (ofFile ? `${t.percent}% of this file; ` : "") +
    `${t.op === "move" ? "Moving" : "Copying"} to ${t.dest}: ${formatSize(t.bytes)} of ${formatSize(t.total)}` +
    (t.paused ? " (paused)" : copySpeed(t, ", ")));
  put(fill.style, "width", `${t.percent}%`);
  // As a download's: how far, and its speed (not on the file it's at: that's only how far into it).
  put(label, "textContent", `${t.paused && !inSidebar(bar) ? "Paused " : ""}${t.percent}%${!t.paused && !ofFile && t.speed ? ` · ${formatSize(t.speed)}/s` : ""}`);
  bar.classList.toggle("paused", !!t.paused);
  const [pause, cancel] = bar.querySelectorAll(".cancel");
  putIcon(pause, t.paused ? "l:play" : "l:pause");
  put(pause, "title", t.paused ? "Go on" : "Pause");
  put(cancel, "title", `Stop ${t.op === "move" ? "moving" : "copying"} (what's done stays; ↻ on the folder goes on)`);
}

// A bar in the sidebar's Transfers: just the percentage (paused or stopped: its buttons and tooltip say), so it fits.
const inSidebar = (bar) => !!bar.closest(".transfer-row");

function showStoppedBar(bar, e) {
  const c = e.copying;
  put(bar.querySelector(".fill").style, "width", `${c.percent}%`);
  if (c.file) { // a file cut off mid-copy (it has its name): ↻ on the folder goes on with it
    put(bar, "title", `${c.op === "move" ? "Moving" : "Copying"} it from ${c.from} stopped ${c.percent}% of the way in, ${formatDate(c.updated)}: ↻ on the folder it's in goes on with it`);
    put(bar.querySelector(".pct"), "textContent", inSidebar(bar) ? `${c.percent}%` : `Cut off at ${c.percent}%`);
    return;
  }
  put(bar, "title", `${c.op === "move" ? "Moving" : "Copying"} it from ${c.from} stopped at ${c.percent}% (${formatSize(c.bytes)} of ${formatSize(c.total)}), ${formatDate(c.updated)}`);
  put(bar.querySelector(".pct"), "textContent", inSidebar(bar) ? `${c.percent}%` : `Stopped at ${c.percent}%`);
  put(bar.querySelector(".cancel"), "title", `Go on ${c.op === "move" ? "moving" : "copying"} (what's there is skipped)`);
}

function barButton(text, title, action) {
  const b = document.createElement("button");
  b.className = "cancel";
  b.textContent = text;
  b.title = title;
  for (const type of ["pointerdown", "mousedown", "dblclick"]) b.addEventListener(type, (e) => e.stopPropagation());
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    action();
  });
  return b;
}

// `ofFile`: the bar on the file it's at: its percentage is that file's.
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
  if (i === -1) return showMenu(e.clientX, e.clientY, [["Paste", () => pasteFiles(state.path)], ...newItemsIn(state.path)]); // the empty space
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
  showMenu(e.clientX, e.clientY, [...newItemsIn(state.path), ...cameraMenuItems()]);
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
  onKey: terminalKey,
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
  else terminal.hide(), setTerminalCover(false), (scriptRun = null);
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

// The terminal covering the whole window (a double-clicked script runs like
// that; Ctrl+F in the terminal toggles it), or at its own height.
function setTerminalCover(on) {
  document.body.classList.toggle("term-cover", on);
}

// Double-clicked scripts and programs (what the server's runCommand picks) run
// in the terminal, covering the window. Esc stops it (Ctrl+C) and puts the
// terminal back as it was: its height, or closed.
let scriptRun = null; // { wasOpen }

async function runInTerminal(argv) {
  const wasOpen = terminal.isOpen;
  setTerminalCover(true);
  setTerminalOpen(true);
  // A new shell: wait for its prompt. Busy means a program runs there (Esc a script, or Ctrl+C).
  for (let i = 0; i < 100 && !(terminal.isRunning && terminal.cwd && !terminal.busy); i++) await new Promise((r) => setTimeout(r, 50));
  terminal.fitNow(); // its size covering the window, before the screen is cleared for the output
  // As you'd type it: ./name (bash name) when the shell is in its folder, quoted only when needed.
  const file = argv.at(-1), dir = parentOf(file), name = file.slice(dir === "/" ? 1 : dir.length + 1);
  const word = (s) => (/^[\w.+@%/:=-]+$/.test(s) ? s : shellQuote(s));
  const target = terminal.cwd === dir ? (argv.length === 1 ? "./" : "") + word(name) : word(file);
  const command = [...argv.slice(0, -1).map(word), target].join(" ");
  if (!terminal.run(command, { clear: true })) { // the output at the top, without the command line
    setTerminalCover(false);
    if (!wasOpen) setTerminalOpen(false);
    return alert("The terminal is busy: finish what's running there first.");
  }
  scriptRun = { wasOpen };
}

function endScriptRun() {
  if (terminal.busy) terminal.send("\x03"); // Ctrl+C
  const { wasOpen } = scriptRun;
  scriptRun = null;
  setTerminalCover(false);
  if (!wasOpen) setTerminalOpen(false);
}

// Keys in the terminal phil takes: Esc ends a double-clicked script's run,
// Ctrl+F toggles covering the window.
function terminalKey(e) {
  if (e.key === "Escape" && scriptRun && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return endScriptRun(), true;
  if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.key.toLowerCase() === "f") {
    return setTerminalCover(!document.body.classList.contains("term-cover")), true;
  }
  return false;
}

// Capture phase, so these work while the terminal has focus too: F4 / Ctrl+`
// toggle the panel, Alt+↓ / Alt+↑ move focus to the terminal (opening it) / the
// folder view.
document.addEventListener("keydown", (e) => {
  if (!appView.hidden && e.key === "Escape") return askAppToClose(), e.preventDefault(), e.stopPropagation();
  // Esc closes the Transfers view, wherever the keyboard is (not a menu or dialog over it).
  if (!transfersView.hidden && e.key === "Escape" && contextMenu.hidden && !dialogOpen()) return closeTransfersView(), e.preventDefault(), e.stopPropagation();
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

  // Files: Ctrl+C / Ctrl+X (and Super+C...) copy or cut the selection, Ctrl+V pastes here.
  const clip = clipboardKey(e);
  if (clip && (e.target === grid || e.target === document.body) && !(e.shiftKey && e.key === "Delete")) {
    if (clip === "paste") return pasteFiles(state.path), handled();
    if (state.marked.size) return clipFiles(clip), handled();
  }
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
  if (e.key === "Enter" || (e.key === " " && !typed)) return open(cur), handled();
  if (e.key.length === 1 && !ctrl && !e.altKey) return typeAhead(e.key), handled();
});

// ---------------------------------------------------------------- start

// phil keeps its window hidden until the page is styled and running (engine/window.js).
ready(JSON.stringify({ script: Math.round(performance.now()) }));
state.init = await api("/api/init");
Object.assign(state.settings, state.init.settings);
applySettings();
renderPlaces(); // once: after this, only when the places change (their space and speeds update in place)
refreshSpeeds(); // the drives' last speed tests, for their tooltips
loadCameras(); // the network cameras found so far (looked for again with the sidebar's refresh button)
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
