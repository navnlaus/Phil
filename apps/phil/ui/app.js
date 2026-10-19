import { appUrl, askPassword, clipboardKey, closeWindow, copyText, embedOf, holdFocus, openOver, pasteText, ready, tooltips } from "/engine/ui/kit.js";
import { isBackgroundKey, isFocusKey, isToggleKey, shellQuote, switchKey, TerminalPanel } from "/ui/terminal.js";
import "/ui/vendor/dayjs.min.js"; // (UMD: globalThis.dayjs; MIT)
import "/ui/vendor/dayjs-relativeTime.js";

const dayjs = globalThis.dayjs;
dayjs.extend(globalThis.dayjs_plugin_relativeTime);

tooltips(); // the page's own, in the theme's style (kit.js)

const $ = (sel) => document.querySelector(sel);
const grid = $("#grid");
const crumbs = $("#crumbs");
const locationInput = $("#location");
const filterInput = $("#filter");
const sortSelect = $("#sort");
const hiddenButton = $("#btn-hidden");
const zoomInput = $("#zoom");
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
  browserDownloads: [], // others' (a browser's partial file growing; browserdownloads.js)
  stopped: [], // copies and moves cut off, anywhere: [{path, copying}] (the server's records of them)
  clip: null, // files copied or cut, in any phil window: {op, paths, text}
  settings: { sort: "name", showHidden: false, zoom: 224, sidebar: false, termHeight: 260, termOpen: false, theme: "overlay", showTransfers: true, showCameras: true },
};
const tiles = new Map(); // path -> tile element
const scrollPositions = new Map(); // path -> scrollTop, restored on back/up

// ---------------------------------------------------------------- helpers

// phil's own icons (index.html), and with "l:" in front, Lucide's (vendor/lucide-sprite.svg:
// what a folder's icon is picked from, in its Properties).
const LUCIDE = "/ui/vendor/lucide-sprite.svg";
const icon = (name, cls = "") => `<svg class="${cls}"><use href="#${name.startsWith("l:") ? lucideIcon(name.slice(2)) : `i-${name}`}"/></svg>`;

// Lucide's icons are copied into the page as they're first used (#l-<name>):
// pointing into the sprite file itself had it loaded again for every new
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
  const res = await fetch(path, options);
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
// A file chooser's window keeps its own (CHOOSER_SETTINGS: sort, tile size, sidebar, the
// terminal's height), apart from phil's windows'; it starts with hidden files hidden.
const CHOOSER_SETTINGS = ["sort", "zoom", "sidebar", "termHeight"];
function saveSettings(delay = 400) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (choosing) {
      const own = Object.fromEntries(CHOOSER_SETTINGS.map((k) => [k, state.settings[k]]));
      return void fetch("/api/settings?chooser=1", { method: "PUT", body: JSON.stringify(own) });
    }
    const { chooser: _, ...settings } = state.settings; // (the chooser's: the server keeps them)
    fetch("/api/settings", { method: "PUT", body: JSON.stringify(settings) });
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
      for (const check of [false, true]) { // asked for before the connection was up
        const paths = [...this.totals].filter(([, c]) => c === check).map(([p]) => p);
        if (paths.length) this.send({ totals: paths, check });
      }
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
      if ("totalOf" in msg) return onFolderTotal(msg.totalOf, msg.bytes, msg.partial);
      if (msg.downloads) return onDownloads(msg.downloads);
      if (msg.processes) return (state.processes = msg.processes), renderProcesses();
      if (msg.browserDownloads) return (state.browserDownloads = msg.browserDownloads), showTransfers();
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
  // Folders' total sizes (foldertotals.js), answered with {totalOf, bytes}; `check` (F5): the time of every folder in them looked at.
  totals: new Map(), // path -> check
  wantTotals(paths, check = false) {
    if (this.ws?.readyState === WebSocket.OPEN) this.send({ totals: paths, check });
    else paths.forEach((p) => this.totals.set(p, check || !!this.totals.get(p)));
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
  if (near && entry.icon) return; // (a file given an icon: that, no preview)
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
// once its tile is near the view, unless the one known is current (the folder
// unchanged since); after F5 (`check`), always. Incognito: only after F5 (what's
// known is shown, out of date or not).
const wantTotal = (entry) => wantTotals([entry]);

// The status bar says how many are being added up (totalsPending).
const totalsPending = new Set();
function wantTotals(entries) {
  if (state.settings.folderSizes === "off") return;
  const wanted = (e) => e.check || (!state.init.incognito && !(e.total && !e.total.stale));
  const asked = entries.filter((e) => wanted(e) && !e.totalAsked && !("space" in e)); // (a drive mounted there: its space instead)
  for (const e of asked) e.totalAsked = true, totalsPending.add(e.path);
  if (!asked.length) return;
  for (const check of [false, true]) {
    const paths = asked.filter((e) => !!e.check === check).map((e) => e.path);
    if (paths.length) thumbs.wantTotals(paths, check);
  }
  updateProgress();
  for (const e of asked) {
    const tile = tiles.get(e.path);
    if (tile) showFolderInfo(tile, e); // its spinner
  }
}

// `partial`: added up so far (a walk going on): shown, its spinner still there.
function onFolderTotal(path, bytes, partial = false) {
  if (!partial && totalsPending.delete(path)) updateProgress(); // (its tile's spinner: showFolderInfo, below)
  if (state.settings.folderSizes === "off") return; // (phil's own changes tell every page)
  const tile = tiles.get(path);
  const entry = tile && state.view[tile.dataset.index];
  if (entry?.path !== path) return;
  entry.total = bytes === null ? { failed: true } : { bytes, stale: false, partial };
  showFolderInfo(tile, entry); // with no summary yet, the size alone
  if (state.settings.sort === "size" && !partial) resortSoon();
}

// Sorted by size, folders move as their totals come in: at most once a second
// (they can come in for a long while, a few at a time), only when the order
// changed, and gliding to their new places (resort).
function resortSoon() {
  if (resortSoon.timer) return;
  resortSoon.timer = setTimeout(() => ((resortSoon.timer = null), renaming ? resortSoon() : resort()), 1000); // moving a tile being renamed would end that
}

// The tiles in a new order without rebuilding the grid: each gets its place
// (CSS order), none is taken out of the page (a text preview's canvas can be
// blanked then, which flickered), and those on screen slide there from where
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
// `again`: its file changed: read again quietly (the old text stays till the new one's
// there; not counted in the status bar), not shown as loading.
function showText(tile, entry, { again = false } = {}) {
  const box = tile.firstElementChild;
  if (box.text) return box.querySelector(":scope > canvas") || drawText(box);
  if (box.text === null) return; // not text
  if (thumbs.wanted.has(entry.path)) return; // asked for already (read again: no loading look)
  if (!again) box.classList.add("loading");
  thumbs.want(entry.path, { quiet: again });
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

function navigate(path) {
  closeTransfersView({ resume: false }), closePrefsView(); // a folder opened: shown
  if (path === loading) return; // clicked again while it opens (a drive waking up)
  const hash = "#" + encodePath(path);
  if (location.hash === hash) load(path);
  else location.hash = hash;
}

addEventListener("hashchange", () => (closeTransfersView({ resume: false }), closePrefsView(), load(decodeURIComponent(location.hash.slice(1)))));

// The folder being opened, while it's listed (a drive waking up can take seconds),
// and which load is the newest (an older one finishing later is dropped).
let loading = null, loads = 0;

// `recount` (F5): its folders' totals are looked at again, every folder in them, not only those whose own folder changed.
async function load(path, { recount = false } = {}) {
  if (state.path) scrollPositions.set(state.path, grid.scrollTop);
  const previous = state.path;
  let listing;
  // Taken at once: its place in the sidebar lit, and, when it takes a while, a word that it's coming.
  loading = path;
  const thisLoad = ++loads;
  markPlace(path);
  let slow = false;
  const slowTimer = setTimeout(() => ((slow = true), flashStatus(`Opening ${path.split("/").pop() || path}…`, 60_000)), 300);
  try {
    listing = await api(`/api/list?path=${encodeURIComponent(path)}&sort=${state.settings.sort}${choosing ? "&remember=0" : ""}`);
  } catch (err) {
    if (thisLoad !== loads) return; // another is shown by now
    showGridMessage(`Can't open ${path}: ${err.message}`);
    return;
  } finally {
    clearTimeout(slowTimer);
    if (slow) flashStatus("", 0);
    if (loading === path) loading = null;
  }
  if (thisLoad !== loads) return; // another was asked for meanwhile
  state.path = listing.path;
  terminal.follow(listing.path);
  state.entries = listing.entries;
  if (recount) for (const e of listing.entries) if (e.kind === "dir") e.check = true;
  if (previous !== listing.path) changedFolders.clear(), autoTags.clear(), tagFilter.clear(), carried.clear(), searchScores.clear(), totalsPending.clear(); // (the server drops those totals)
  state.listingAutoTags = !!listing.autoTags;
  state.autoTagged = autoTagging(listing);
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
  render(selectPath);
  grid.scrollTop = selectPath ? grid.scrollTop : scrollPositions.get(listing.path) ?? 0;
  if (selectPath) tiles.get(selectPath)?.scrollIntoView({ block: "center" });
  // Don't steal focus from the terminal when the view follows a `cd` typed there.
  if (!document.activeElement?.closest("#term-panel")) grid.focus({ preventScroll: true });
  if (restoreTerminal) {
    restoreTerminal = false;
    if (startCovered) setTerminalCover(true);
    setTerminalOpen(true, { focus: startCovered });
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
  // Not while renaming or dragging: try again in a moment.
  if (renaming || band?.active || drag?.active) {
    refreshLater ??= setTimeout(() => (refreshLater = null, refresh()), 700);
    return;
  }
  const path = state.path;
  refreshing = api(`/api/list?path=${encodeURIComponent(path)}&sort=${state.settings.sort}${choosing ? "&remember=0" : ""}`).catch(() => null);
  const listing = await refreshing;
  refreshing = null;
  if (listing && state.path === path && !renaming) {
    state.entries = listing.entries;
    const top = grid.scrollTop;
    render();
    grid.scrollTop = top;
    thumbs.watch(path); // new subfolders get watched too
    state.listingAutoTags = !!listing.autoTags;
    state.autoTagged = autoTagging(listing);
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
const sizeOf = (e) => (e.kind === "dir" ? (e.space ? e.space.size - e.space.avail : e.total?.bytes ?? e.summary?.size ?? 0) : e.size); // (a mounted drive: what's used)

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
  // (updateTile); tiles are moved only when out of place, as a canvas taken
  // out of the page can be blanked (its text is drawn again then).
  const old = new Map(tiles);
  tiles.clear();
  const ordered = state.view.map((entry, i) => {
    let tile = old.get(entry.path);
    if (tile?.dataset.shape === tileShape(entry) && !tile.classList.contains("renaming")) {
      old.delete(entry.path);
      put(tile.dataset, "index", String(i));
      if (tile.classList.contains("selected")) tile.classList.remove("selected");
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

const WRITTEN_MS = 30_000; // a file changing again within this: being written (see refreshPreview)
const lastChanged = new Map(); // path -> when its tile last saw it change

// A file being written, looked at again: quiet for WRITTEN_MS, redrawn; otherwise, later.
function whenQuiet(tile, entry) {
  if (!entry) return;
  const quiet = Date.now() - (lastChanged.get(entry.path) ?? 0);
  if (quiet < WRITTEN_MS) return void wantLater(entry.path, WRITTEN_MS - quiet + 500, whenQuiet);
  lastChanged.delete(entry.path);
  refreshPreview(tile, entry);
}

function refreshPreview(tile, entry) {
  if (!entry) return;
  // A file changing again within WRITTEN_MS of its last change: being written (a download,
  // a torrent, a copy, a program's output): left as it is (redrawn on every change, it
  // flashed), and redrawn once it's been quiet that long. (One change, a file saved: at once.)
  const now = Date.now(), before = lastChanged.get(entry.path);
  lastChanged.set(entry.path, now);
  if (lastChanged.size > 500) lastChanged.delete(lastChanged.keys().next().value);
  if (before && now - before < WRITTEN_MS) return void wantLater(entry.path, WRITTEN_MS + 500, whenQuiet);
  const box = tile.firstElementChild;
  const near = isNear(tile);
  if (entry.kind === "file") {
    box.text = undefined; // its text read again (and drawn over the old)
    if (near && !entry.icon) showText(tile, entry, { again: true });
  } else if (typeof entry.thumb === "string") {
    if (box.querySelector("img") || near) setThumbImage(box, entry.thumb);
  } else if (entry.thumb === null && near && !askAgain.has(entry.path)) {
    thumbs.want(entry.path, { quiet: true }); // (no "loading" look: a file being written changes all the time, and that blinked)
  }
}

// A file's icon given it (its metadata's: a background terminal's script, say): Lucide's, or
// "claude", claude.ai's.
const fileIcon = (name) => (name === "claude" ? `<img class="kind claude-icon" src="/api/icon/claude" alt="">` : icon(`l:${name}`, "kind"));

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
    box.innerHTML = entry.icon ? fileIcon(entry.icon) : icon(KIND_ICON[entry.kind], "kind");
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
// A folder's icon of its own: picked in its Properties, or a media folder's (while mediaview's on).
const folderIcon = (entry) => entry.icon ?? (entry.mediaFolder && mediaViewOn() ? "clapperboard" : null);

function showMarks(tile, entry) {
  const desc = tile.querySelector(".label .desc");
  const description = entry.description ?? carried.get(entry.path) ?? ""; // phil's, or the file's own
  put(desc, "textContent", description);
  tile.classList.toggle("has-desc", !!description);
  showTileTags(tile, entry);
  showState(tile, entry);
  const own = folderIcon(entry); // its own icon, picked in Properties; a media folder's
  const folderMark = own ? [`l:${own}`, "folder line custom"] : ["folder", "folder fill"];
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
    (folderIcon(entry) ? `icon:${folderIcon(entry)}` : summary?.files ? "file" : summary?.dirs ? "folder" : "");
  if (box.dataset.look !== look || !box.firstChild) fillFolderFace(box, summary, previews, entry);
  box.dataset.look = look;
  const meta = tile.querySelector(".meta");
  // Before its summary (which waits for its pictures' thumbnails), its total size if that's in;
  // being copied into, its size as the copy goes (copySize).
  const live = copySize(entry);
  const total = live?.total ?? entry.total;
  const sizing = !live && (total?.bytes === undefined || !!total.partial) && totalsPending.has(entry.path); // a walk at it: a spinner where it goes (after what's added up so far)
  const space = entry.space ? `${formatSize(entry.space.avail)} free of ${formatSize(entry.space.size)}` : ""; // a drive mounted there
  put(meta, "textContent", live?.text ?? (space ? [summary && folderContents(summary, null, false, { counts: true }), space].filter(Boolean).join(" · ")
    : summary ? folderContents(summary, total, sizing) : total?.bytes !== undefined ? formatSize(total.bytes) : ""));
  meta.classList.toggle("sizing", sizing && !!summary?.dirs);
  put(tile, "title", entry.name + (meta.textContent ? `\n${meta.textContent}${meta.classList.contains("sizing") ? " (adding it up…)" : ""}` : "") + titleNotes(entry));
  showMarks(tile, entry);
  tile.classList.toggle("empty-dir", !!summary && !summary.files && !summary.dirs);
}

// A folder being copied into, its size from the copy's progress: the folder a copy (of
// one item) is making, "120 GB of 289 GB"; the folder it goes into, its size when the
// copy was first seen here and what's been copied since. Null: not being copied into.
const copyBases = new Map(); // transfer id -> {base: the folder's size then, bytes: the copy's then}
function copySize(entry) {
  for (const t of state.transfers.values()) {
    if (t.op === "delete" || t.preparing) continue;
    if (t.targets?.length === 1 && t.targets[0] === entry.path) {
      return { text: `${formatSize(t.bytes)} of ${formatSize(t.total)}${t.paused ? " (paused)" : ""}` };
    }
    if (t.dest === entry.path && entry.total?.bytes !== undefined) {
      const seen = copyBases.get(t.id) ?? copyBases.set(t.id, { base: entry.total.bytes, bytes: t.bytes }).get(t.id);
      return { total: { bytes: seen.base + Math.max(0, t.bytes - seen.bytes) } };
    }
  }
  return null;
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
    const [name, cls] = folderIcon(entry) ? [`l:${folderIcon(entry)}`, "kind custom"] : summary?.files || summary?.dirs ? [summary.files ? "file" : "folder", "kind"] : [];
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
// of everything, subfolders too (`sizing`: while du works it out, "56 MB /",
// and the tile's spinner after). Without subfolders the two are the same, so
// it's said once; without the total (not worked out there), the files' alone.
// `counts`: only how many folders and files (a mounted drive's: its space follows).
function folderContents({ files, dirs, size }, total, sizing = false, { counts = false } = {}) {
  const count = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
  const parts = [];
  if (dirs) parts.push(count(dirs, "folder"));
  if (files) parts.push(count(files, "file"));
  if (counts) return parts.join(" · ");
  if (dirs && total?.bytes !== undefined) parts.push(`${formatSize(files ? size : 0)} / ${formatSize(total.bytes)}`);
  else if (dirs && sizing) parts.push(`${formatSize(files ? size : 0)} /`);
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
// Once per focus: it can come a few times over as the window opens.
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
  keyed($("#places"), state.init.places.filter((p) => !p.media || mediaViewOn()), {
    key: (p) => (p.media ? "media" : p.unmounted ? `device:${p.device}` : p.path),
    kind: (p) => (p.media ? "media" : p.unmounted ? "unmounted" : isMount(p) ? "mount" : "folder"),
    make: (p) => (p.media ? makeMediaPlace() : p.unmounted ? makeUnmountedPlace() : makePlace(p)),
    show: (a, p) => (p.media ? showMediaPlaceRow(a) : p.unmounted ? showUnmountedPlace(a, p) : showPlace(a, p)),
  });
  showTransfers();
}

// A place's row (its data: a.item, as it is now). Drives and shares have their
// free space under the name (and copies to them, see showTransfers).
function makePlace(p) {
  const a = document.createElement("a");
  a.draggable = true; // as an element, not as a link: a link's own drag starts by itself, and not always
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
  if (a.dataset.path !== p.path) a.dataset.path = p.path; // drop target
  a.classList.toggle("folder", !!p.folder); // the user's (see placeGapAt)
  // The icon picked in its Properties, if any; a media folder's (not a drive's).
  putIcon(a, p.customIcon ? `l:${p.customIcon}` : p.mediaFolder && !isMount(p) && mediaViewOn() ? "l:clapperboard" : p.icon);
  const name = p.description || p.name; // its Properties' description, when it has one
  if (isMount(p)) put(a.querySelector(".place-name"), "textContent", name);
  else put(a.lastChild, "nodeValue", name);
  showPlaceInfo(a, p);
  a.classList.toggle("active", p.path === (loading ?? state.path)); // the one being opened, already
}

// The Media view's row: among the folders (after them, unless they were
// arranged around it), not a folder itself (no data-path: nothing's dropped on
// it or dragged from it; data-place says where folders dropped beside it go).
function makeMediaPlace() {
  const a = document.createElement("a");
  a.className = "folder media-place";
  a.dataset.place = "phil:media";
  a.title = "Your media folders' movies and TV shows (Esc comes back)";
  a.append(document.createTextNode("Media"));
  a.onclick = (e) => (e.preventDefault(), openMediaView());
  a.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, [
      ["Open", () => openMediaView()],
      ["Hide it (Preferences shows it again)", () => setMediaViewOn(false)],
    ]);
  };
  return a;
}

function showMediaPlaceRow(a) {
  putIcon(a, "l:clapperboard");
  a.classList.toggle("active", mediaOpen());
}

function setMediaViewOn(on) {
  state.settings.mediaView = on;
  saveSettings(0);
  if (!on && mediaOpen()) closeApp();
  renderPlaces();
  render(); // (media folders' icons)
}

// A drive that isn't mounted (an internal one's partition: nothing mounts
// those by itself): dimmed; a click mounts it (udisks; a system drive asks
// for the password) and opens it.
function makeUnmountedPlace() {
  const a = document.createElement("a");
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
// `clearDirty`: an NTFS drive's "not closed properly" flag cleared first (ntfsfix -d, as root), asked.
async function mount(p, a, readOnly = false, clearDirty = false) {
  if (a.classList.contains("busy")) return;
  a.classList.add("busy");
  flashStatus(clearDirty ? `Clearing ${p.name}'s flag, and mounting it…` : `Mounting ${p.name}…`, 60_000);
  try {
    // A system drive's needs root: sudo (the password box when it wants it).
    const { path } = await withSudo(() => api("/api/mount", { method: "POST", body: JSON.stringify({ device: p.device, readOnly, clearDirty }) }), { ok: clearDirty ? "Clear and mount" : "Mount" });
    flashStatus(`Mounted ${p.name}${readOnly ? " (read-only)" : ""}`);
    await refreshPlaces();
    navigate(path);
  } catch (err) {
    flashStatus("", 0);
    if (err.cancelled) return;
    if (err.status !== 409) return alert(`Couldn't mount ${p.name}\n${err.message}`);
    a.classList.remove("busy");
    const ok = await askConfirm({ title: `${p.name} can only be mounted read-only`, detail: err.message, ok: "Mount read-only", danger: false, copyable: true, extra: "Clear the flag and mount\u2026" });
    if (ok === "extra") {
      // Linux can't check NTFS: clearing the flag only lets it be written again. Said first.
      const sure = await askConfirm({
        title: `Clear ${p.name}'s "not closed properly" flag?`,
        detail: "This doesn't check or repair anything: it only lets Linux mount it writable again (ntfsfix -d, as root). " +
          "If it was left that way by a crash, a file being written then may be damaged, and writing to it before it's checked can make that worse. " +
          "Only Windows' chkdsk checks and repairs NTFS; run it on this drive when you can.\n\n" +
          "A Windows system drive (C:) may also hold Windows' unfinished changes (hibernation, Fast Startup): don't clear it then, shut Windows down fully instead.",
        ok: "Clear and mount", danger: true,
      });
      if (sure) return mount(p, a, false, true);
      return;
    }
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
  updateChooser();
}

function updateProgress() {
  let folders = 0, files = 0;
  for (const path of thumbs.wanted) if (!thumbs.quiet.has(path)) thumbs.folders.has(path) ? folders++ : files++;
  const parts = [];
  if (files) parts.push(`Generating ${files} thumbnail${files === 1 ? "" : "s"}`);
  if (folders) parts.push(`${parts.length ? "reading" : "Reading"} ${folders} folder${folders === 1 ? "" : "s"}`);
  const sizing = totalsPending.size;
  if (sizing) parts.push(`${parts.length ? "adding" : "Adding"} up ${sizing} folder${sizing === 1 ? "'s" : "s'"} size${sizing === 1 ? "" : "s"}`);
  if (flashStatus.until > Date.now()) return; // a message showing for a while (it updates this after)
  $("#status-progress").textContent = parts.length ? parts.join(", ") + "…" : "";
}

function applySettings() {
  const s = state.settings;
  // What the sidebar shows (the settings; a file chooser's window: neither).
  document.body.classList.toggle("no-transfers", !!choosing || s.showTransfers === false);
  document.body.classList.toggle("no-cameras", !!choosing || s.showCameras === false);
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

// ---------------------------------------------------------------- the Media view

// The sidebar's Media: mediaview (apps/mediaview), the movies and TV shows in
// the folders marked as media (their Properties), over the whole window as
// other apps are. Preferences turns it off.
const mediaViewOn = () => !choosing && state.settings.mediaView !== false;
// (Set aside behind the Transfers view: that one, as it was.)
const openMediaView = () => (appAside && appView.querySelector("iframe")?.title === "mediaview" ? closeTransfersView() : openInApp("mediaview", {}));
const mediaOpen = () => !appView.hidden && appView.querySelector("iframe")?.title === "mediaview";
const showMediaPlace = () => $("#places .media-place")?.classList.toggle("active", mediaOpen());

// A folder just marked as media: mediaview makes it ready (its videos found,
// matched with IMDb's titles, their pictures made: apps/mediaview/media.js
// prepare()), with a bar on its tile and the title it's at in the status bar
// meanwhile, so the Media view shows it at once.
const mediaPreparing = new Map(); // folder -> {phase, done, total, title}

async function prepareMediaFolder(path, name) {
  if (mediaPreparing.has(path)) return;
  mediaPreparing.set(path, { phase: "Starting", done: 0, total: 0 });
  showTransfers();
  let total = 0;
  try {
    const res = await fetch("/engine/embed/mediaview/api/media/prepare", { method: "POST", body: JSON.stringify({ path }) });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    let buf = "";
    for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
      buf += chunk;
      for (let nl; (nl = buf.indexOf("\n")) !== -1;) {
        const m = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (m.error) throw new Error(m.error);
        if (m.finished) total = m.total;
        else {
          mediaPreparing.set(path, m);
          showTransfers();
          flashStatus(m.total ? `Adding ${name} to Media: ${m.done} of ${m.total}${m.title ? ` \u00b7 ${m.title}` : ""}` : `Adding ${name} to Media: ${m.phase.toLowerCase()}\u2026`, 60_000);
        }
      }
    }
    flashStatus(`${name}: in Media, ${total} title${total === 1 ? "" : "s"} (sidebar \u2192 Media)`);
  } catch (err) {
    flashStatus(`Couldn't add ${name} to Media: ${err.message}`, 8000);
  } finally {
    mediaPreparing.delete(path);
    showTransfers();
  }
}

function showMediaPrepareBar(bar, m) {
  const pct = m.total ? Math.round((m.done / m.total) * 100) : 0;
  bar.classList.toggle("unknown", !m.total); // looking for its videos: how many isn't known yet
  put(bar.querySelector(".fill").style, "width", m.total ? `${pct}%` : "100%");
  put(bar.querySelector(".pct"), "textContent", m.total ? `Media ${m.done}/${m.total}` : `${m.phase}\u2026`);
  put(bar, "title", `Adding it to Media: ${m.phase.toLowerCase()}${m.total ? `, ${m.done} of ${m.total} titles` : ""}${m.title ? `\n${m.title}` : ""}`);
}

// ---------------------------------------------------------------- the Preferences view

// The gear at the bottom of the sidebar: what the sidebar shows (Transfers, Cameras),
// the theme (the stylesheets in ~/.config/phil/themes; every window follows) and
// the log (the engine's, read when it starts). Over the folder,
// as the Transfers view is; Esc or × closes it, as does opening a folder.
const prefsView = $("#prefs-view"), settingsButton = $("#btn-settings"), themeSelect = $("#prefs-theme");
settingsButton.innerHTML = icon("l:settings");
let prefsFocus = null;

settingsButton.onclick = () => (prefsView.hidden ? openPrefsView() : closePrefsView());
prefsView.querySelector(".tv-head .close").onclick = () => closePrefsView();

async function openPrefsView() {
  closeTransfersView({ resume: false });
  prefsFocus = document.activeElement?.closest?.("#sidebar") ? grid : document.activeElement;
  prefsView.hidden = false;
  settingsButton.setAttribute("aria-pressed", "true");
  prefsView.querySelector(".tv-head .close").focus({ preventScroll: true });
  const s = state.settings;
  $("#prefs-media-search").value = s.mediaSearchUrl ?? "";
  for (const el of prefsView.querySelectorAll(".prefs-media-search")) el.hidden = !mediaViewOn();
  for (const input of prefsView.querySelectorAll("[data-pref]")) input.checked = "off" in input.dataset ? s[input.dataset.pref] === true : s[input.dataset.pref] !== false;
  showTaggingPrefs();
  folderSizesSelect.value = ["all", "off"].includes(s.folderSizes) ? s.folderSizes : "";
  showVersion();
  const r = await api("/api/themes").catch(() => null);
  if (r) {
    const names = r.themes.includes(s.theme) ? r.themes : [...r.themes, s.theme];
    themeSelect.replaceChildren(...names.map((t) => new Option(t, t)));
    themeSelect.value = s.theme;
    prefsView.querySelector(".prefs-theme-dir").textContent = `The stylesheets in ${r.dir}. Every window follows.`;
  }
}

// The commit this phil is built from (engine/version.js), as git's short id.
async function showVersion() {
  const v = await api("/api/version").catch(() => null);
  const el = prefsView.querySelector(".prefs-version");
  if (!v?.commit) return void (el.textContent = "Unknown (not built from a git checkout)");
  const when = v.built ? `built ${dayjs(v.built).format("MMM D, YYYY HH:mm")}` : "running from the source";
  el.textContent = `${v.commit} on ${v.branch}${v.dirty ? ", with changes not committed" : ""}, ${when}`;
}

function closePrefsView() {
  if (prefsView.hidden) return;
  prefsView.hidden = true;
  settingsButton.setAttribute("aria-pressed", "false");
  const back = prefsFocus?.isConnected && prefsFocus !== document.body && !prefsView.contains(prefsFocus) ? prefsFocus : grid;
  back.focus({ preventScroll: true });
}

for (const input of prefsView.querySelectorAll("[data-pref]")) {
  input.onchange = async () => {
    const key = input.dataset.pref;
    if ("off" in input.dataset) input.checked ? (state.settings[key] = true) : delete state.settings[key]; // (off unless set)
    else state.settings[key] = input.checked;
    applySettings();
    if (key === "mediaView") {
      for (const el of prefsView.querySelectorAll(".prefs-media-search")) el.hidden = !input.checked;
      return setMediaViewOn(input.checked);
    }
    if (!/^tag|^autoTag/.test(key)) return saveSettings(0);
    await saveSettingsNow(); // the server reads them when it tags
    showTaggingPrefs();
    retag();
  };
}

// Where mediaview's links for missing episodes search (mediaSearchUrl): a web address, %s for what's searched.
const mediaSearchInput = $("#prefs-media-search");
function saveMediaSearch() {
  const url = mediaSearchInput.value.trim();
  const error = mediaSearchInput.parentElement.querySelector(".error");
  error.hidden = !url || /^https?:\/\/\S+$/.test(url);
  error.textContent = "A web address, starting with https:// (or http://)";
  if (!error.hidden || url === (state.settings.mediaSearchUrl ?? "")) return;
  if (url) state.settings.mediaSearchUrl = url;
  else delete state.settings.mediaSearchUrl;
  saveSettings(0);
}
mediaSearchInput.onchange = saveMediaSearch;
// (void: an on-handler that returns false cancels the key: nothing could be typed.)
mediaSearchInput.onkeydown = (e) => void (e.key === "Enter" && (e.preventDefault(), mediaSearchInput.blur()));

// Auto-tagging, if it's set up (scripts/install-tagging.sh; --documents for
// text and Markdown files): what's tagged, which folders, and the tag lists.
const taggingAvailable = () => state.init.tagging?.available ?? { pictures: false, documents: false };

async function showTaggingPrefs() {
  const available = taggingAvailable();
  const rows = [...prefsView.querySelectorAll(".prefs-tagging, .prefs-list, .prefs-list-label")];
  rows.forEach((el) => (el.hidden = !available.pictures));
  prefsView.querySelector('[data-pref="tagDocuments"]').disabled = !available.documents;
  const off = !state.settings.autoTagAll ? " Otherwise, the folders it's turned on for in their Properties." : "";
  prefsView.querySelector(".prefs-tagging-hint").textContent = !available.pictures
    ? "Not set up: run scripts/install-tagging.sh in phil's source folder (several GB: PyTorch and the model; --documents for text and Markdown files too)."
    : !available.documents
    ? `For text and Markdown files, run scripts/install-tagging.sh --documents in phil's source folder (EmbeddingGemma 2, about 1.5 GB).${off}`
    : `It stores what each file shows or is about, so describing it in the filter box finds it.${off}`;
  if (!available.pictures) return;
  const lists = await api("/api/tag-lists").catch(() => null);
  for (const box of prefsView.querySelectorAll(".prefs-list")) {
    const list = lists?.[box.dataset.kind], area = box.querySelector("textarea");
    box.hidden = box.previousElementSibling.hidden = box.dataset.kind === "documents" && !lists?.available.documents;
    if (!list || document.activeElement === area || box.querySelector(".save").disabled === false) continue; // being edited
    showTagList(box, list);
  }
}

function showTagList(box, list) {
  box.querySelector("textarea").value = list.text;
  box.querySelector(".save").disabled = true;
  box.querySelector(".reset").disabled = !list.custom;
  box.querySelector(".status").textContent = `${list.tags.length} tags${list.custom ? ", yours" : ", phil's"}`;
}

for (const box of prefsView.querySelectorAll(".prefs-list")) {
  const area = box.querySelector("textarea"), save = box.querySelector(".save"), reset = box.querySelector(".reset");
  const put = async (text) => {
    try {
      showTagList(box, await api("/api/tag-lists", { method: "PUT", body: JSON.stringify({ kind: box.dataset.kind, text }) }));
      retag(); // the new list, from the saved embeddings
    } catch (err) {
      box.querySelector(".status").textContent = err.message;
    }
  };
  area.oninput = () => (save.disabled = false, box.querySelector(".status").textContent = "Not saved");
  area.onkeydown = (e) => void ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && (e.preventDefault(), save.disabled || save.click()));
  save.onclick = () => put(area.value);
  reset.onclick = () => confirm(`Go back to phil's list of ${box.dataset.kind === "pictures" ? "picture" : "document"} tags? Tags of your own in it go.`) && put(null);
}

// Whether this folder's pictures and documents are tagged: it's set to be
// (its Properties), or every folder is (Preferences).
const autoTagging = (listing) => !!listing?.autoTags || (!choosing && state.settings.autoTagAll === true && taggingAvailable().pictures);

// What's tagged changed (the kinds, every folder or not, a list): the folder again.
function retag() {
  autoTags.clear();
  state.autoTagged = autoTagging({ autoTags: state.listingAutoTags });
  thumbs.tag(state.autoTagged ? state.path : null);
  renderTags();
  render();
}

function saveSettingsNow() {
  clearTimeout(saveTimer);
  const { chooser: _, ...settings } = state.settings;
  return fetch("/api/settings", { method: "PUT", body: JSON.stringify(settings) }).catch(() => {});
}
const folderSizesSelect = $("#prefs-folder-sizes");
folderSizesSelect.onchange = async () => {
  if (folderSizesSelect.value) state.settings.folderSizes = folderSizesSelect.value;
  else delete state.settings.folderSizes;
  await saveSettingsNow(); // the server reads it when it lists a folder
  totalsPending.clear(), updateProgress();
  load(state.path); // the totals shown, or not
};

themeSelect.onchange = () => api("/api/theme", { method: "PUT", body: JSON.stringify({ theme: themeSelect.value }) }).catch((err) => alert(err.message));
$("#prefs-transfers").onclick = () => openTransfersView();

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
  // Choosing (phil --choose): a file opened is the answer (to save: its name, replacing it);
  // a folder opens as ever.
  if (choosing && entry.kind !== "dir") {
    if (choosing.mode === "open") return answerChoice(choosing.multiple && state.marked.has(entry.path) ? chosenPaths() : [entry.path]);
    if (choosing.mode === "save") return (chooser.querySelector(".ch-name").value = entry.name), answerChoice(chosenPaths());
    return; // (folders asked for)
  }
  if (entry.kind === "dir") navigate(entry.path);
  else if (entry.kind === "image") openInApp("imageview", { file: entry.path, sort: state.settings.sort });
  else if (entry.kind === "video") openInApp("videoplayer", { file: entry.path, sort: state.settings.sort });
  else if (entry.kind === "pdf") openExternal(entry.path);
  else if (isJson(entry)) openInApp("jsonedit", { file: entry.path });
  else if (isDocument(entry)) openInApp("textedit", { file: entry.path }); // to read, as Markdown; "Open with default app" to edit
  else openFile(entry);
}

// ---------------------------------------------------------------- choosing (phil --choose)

// An app's Open or Save dialog (through xdg-desktop-portal-termfilechooser: phil
// --choose): phil as ever, with a bar at the bottom saying what's asked. The answer
// goes to the server (POST /api/choose), which hands it to the waiting command;
// closing the window, any way, is cancelling.
const choosing = (() => {
  const p = new URLSearchParams(location.search);
  const mode = p.get("choose");
  return ["open", "dir", "save"].includes(mode) ? { mode, multiple: p.get("multiple") === "1", out: p.get("out"), name: p.get("name") ?? "", answered: false, picked: null } : null;
})();
const chooser = $("#chooser");
const inFolder = (name) => (state.path === "/" ? "/" : state.path + "/") + name;

// What would be chosen now: to save, the name in this folder; files (or folders)
// selected; folders asked for, none selected: the folder shown.
function chosenPaths() {
  if (!choosing) return [];
  if (choosing.mode === "save") {
    const name = chooser.querySelector(".ch-name").value.trim();
    return name && !name.includes("/") && state.path ? [inFolder(name)] : [];
  }
  const marked = markedEntries();
  if (choosing.mode === "dir") {
    const dirs = marked.filter((e) => e.kind === "dir").map((e) => e.path);
    return dirs.length ? (choosing.multiple ? dirs : dirs.slice(0, 1)) : state.path ? [state.path] : [];
  }
  const files = marked.filter((e) => e.kind !== "dir").map((e) => e.path);
  return choosing.multiple ? files : files.slice(0, 1);
}

// The bar as the selection is: its button, what it would choose; to save, a file
// clicked gives its name.
function updateChooser() {
  if (!choosing) return;
  const marked = markedEntries();
  const one = marked.length === 1 && marked[0].kind !== "dir" ? marked[0] : null;
  if (choosing.mode === "save" && one && one.path !== choosing.picked) chooser.querySelector(".ch-name").value = one.name;
  choosing.picked = one?.path ?? null;
  const paths = chosenPaths();
  chooser.querySelector(".ch-ok").disabled = !paths.length;
  chooser.querySelector(".ch-picked").textContent = choosing.mode === "save" ? `in ${state.path ?? ""}`
    : paths.length > 1 ? `${paths.length} chosen` : paths[0] ? (paths[0].split("/").pop() || "/") : "";
}

async function answerChoice(paths) {
  if (!choosing || choosing.answered) return;
  if (choosing.mode === "save" && paths.length) {
    const name = paths[0].split("/").pop();
    const there = state.entries.find((e) => e.name === name);
    if (there?.kind === "dir") return void askConfirm({ title: `${name} is a folder`, detail: "Give the file another name.", ok: "OK", cancel: null, danger: false });
    if (there && !(await askConfirm({ title: `Replace ${name}?`, detail: `There's a file called that in ${state.path} already.`, ok: "Replace" }))) return;
  }
  choosing.answered = true;
  // (Saved: the app's download there is in the Transfers list: browserdownloads.js.)
  await api("/api/choose", { method: "POST", body: JSON.stringify({ out: choosing.out, paths, save: choosing.mode === "save" }) }).catch(() => {});
  closeWindow();
}

if (choosing) {
  document.body.classList.add("choosing");
  chooser.hidden = false;
  const name = chooser.querySelector(".ch-name"), ok = chooser.querySelector(".ch-ok");
  chooser.querySelector(".ch-what").textContent = { open: choosing.multiple ? "Choose files" : "Choose a file", dir: choosing.multiple ? "Choose folders" : "Choose a folder", save: "Save as" }[choosing.mode];
  ok.textContent = choosing.mode === "save" ? "Save" : "Open";
  name.hidden = choosing.mode !== "save";
  name.value = choosing.name;
  name.addEventListener("input", updateChooser);
  name.addEventListener("keydown", (e) => e.stopPropagation()); // the name's keys, not the folder's (Enter saves)
  // Esc cancels, as a dialog's: anywhere in the window, unless something over it takes it
  // first (a menu, a dialog, an app shown, renaming, the filter cleared).
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented || choosing.answered) return;
    if (!contextMenu.hidden || dialogOpen() || !appView.hidden || renaming) return;
    e.preventDefault();
    answerChoice([]);
  });
  // In the bar (its name field keeps its keys to itself): the same.
  chooser.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    answerChoice([]);
  }, true); // (first: the name's keys go no further)
  chooser.onsubmit = (e) => (e.preventDefault(), answerChoice(chosenPaths()));
  chooser.querySelector(".ch-cancel").onclick = () => answerChoice([]);
  // Closed some other way (its X, Super+W): cancelled.
  addEventListener("pagehide", () => {
    if (!choosing.answered) navigator.sendBeacon("/api/choose", new Blob([JSON.stringify({ out: choosing.out, paths: [] })], { type: "application/json" }));
  });
  if (choosing.mode === "save") {
    setTimeout(() => { // the name ready to type over (not its extension)
      name.focus();
      const dot = name.value.lastIndexOf(".");
      name.setSelectionRange(0, dot > 0 ? dot : name.value.length);
    }, 400);
  }
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
// Transfers view. Its close button (or Esc) comes back here.
const appView = $("#app-view");

let focusBeforeApp = null; // where the keyboard goes back to: the grid, or the terminal it was opened from

function openInApp(app, params) {
  // A video, the cameras: in videoplayer's or camview's own window (mpv plays them there,
  // under its page), over this one as if it were in it (kit.js openOver); in a browser
  // (--browser), here.
  if ((app === "videoplayer" || app === "camview") && openOver(app, params, { onMessage: selectShowing })) return;
  focusBeforeApp = document.activeElement;
  const src = appUrl(app, params);
  const frame = Object.assign(document.createElement("iframe"), { src, title: app, allow: "fullscreen" });
  frame.dataset.embed = embedOf(src);
  appView.replaceChildren(frame);
  appView.hidden = false;
  frame.focus();
  showMediaPlace();
}

// Esc while the keyboard is still here: the app closes itself (it may ask
// about unsaved changes first).
function askAppToClose() {
  const frame = appView.querySelector("iframe");
  frame?.contentWindow.postMessage({ engine: "close-request" }, "*");
  frame?.focus();
}

// An app set aside, not closed (mediaview, while the Transfers view shows one of its downloads):
// hidden, its page as it was; back when that view's closed (bringAppBack), or closed with it.
let appAside = false;
function setAppAside() {
  appAside = true;
  appView.hidden = true;
  showMediaPlace();
}

function bringAppBack() {
  appAside = false;
  const frame = appView.querySelector("iframe");
  if (!frame) return;
  appView.hidden = false;
  frame.focus();
  frame.contentWindow.focus();
  frame.contentWindow.postMessage({ engine: "focus" }, "*"); // (kit.js holdFocus: its view)
  showMediaPlace();
}

function closeApp() {
  appAside = false;
  appView.hidden = true;
  appView.replaceChildren();
  document.body.classList.remove("term-over-app"); // (the terminal back in its place, if it's open)
  showMediaPlace();
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
  } else if (e.data?.engine === "terminal") { // the terminal's keys, pressed in the app (kit.js)
    if (e.data.key === "background") backgroundTerminal();
    else if (e.data.key === "switch") switchTerminal(e.data.which);
    else toggleTerminal();
  } else if (e.data?.engine === "close") {
    closeApp();
  } else if (e.data?.app === "mediaview" && e.data.transfer) { // a download's %: it in the Transfers view, mediaview behind it
    setAppAside();
    openTransfersView(e.data.transfer);
  } else if (e.data?.app === "mediaview" && e.data.show) { // "Show it in its folder": here, the media view closed
    closeApp();
    initialSelect = [e.data.show];
    navigate(parentOf(e.data.show));
  } else selectShowing(e.data);
});

// The image or video an app shows (imageview's, videoplayer's {app, showing}): selected here, for when it closes.
function selectShowing(m) {
  if ((m?.app !== "imageview" && m?.app !== "videoplayer") || !m.showing) return;
  const i = state.view.findIndex((v) => v.path === m.showing);
  if (i !== -1) select(i);
}

// ---------------------------------------------------------------- deleting

const confirmDialog = $("#confirm");

// `cancel`: null for a message with only OK; `danger`: OK in red (deleting);
// `copyable`: a Copy button for the message.
// One at a time: another waits for this one to close.
let confirmShown = Promise.resolve();
// With `fields` ([{name, label, type, value, placeholder}]): text boxes, and it
// resolves to their values ({name: value}), or null when cancelled.
// `extra`: a third choice's label: it resolves to "extra" when that's picked.
function askConfirm({ title, detail, ok, cancel = "Cancel", danger = true, copyable = false, fields = null, extra = null }) {
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
    const extraButton = confirmDialog.querySelector("[value=extra]");
    extraButton.hidden = !extra;
    extraButton.textContent = extra ?? "";
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
      if (extra && confirmDialog.returnValue === "extra") return resolve("extra");
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
  if (entry.kind === "video") items.push(["Play here", () => openInApp("videoplayer", { file: entry.path, sort: state.settings.sort })]);
  if (entry.kind === "video") items.push(["Play in mpv", () => openExternal(entry.path, "mpv")]);
  if (isJson(entry)) items.push(["Edit in jsonedit", () => openInApp("jsonedit", { file: entry.path })]);
  if (isJson(entry) || tiles.get(entry.path)?.firstElementChild.text) items.push(["Add to Config", () => addToConfig(entry)]);
  // Those of the selected that a torrent's downloading: paused, or resumed, by themselves.
  const torrents = torrentsOf(markedEntries().map((e) => e.path));
  const pausable = torrents.reduce((n, t) => n + t.pausable.length, 0), resumable = torrents.reduce((n, t) => n + t.resumable.length, 0);
  if (pausable) items.push([pausable > 1 ? `Pause downloading ${pausable} items` : "Pause downloading", () => pauseDownloadFiles("pause_files", torrents)]);
  if (resumable) items.push([resumable > 1 ? `Resume downloading ${resumable} items` : "Resume downloading", () => pauseDownloadFiles("resume_files", torrents)]);
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
  // One of the sidebar's drives or shares (or a drive's top folder): what it is, how fast it reads, and what phil does on it.
  const thumbBox = $p("#props-thumbnails"), sizesBox = $p("#props-foldersizes");
  const isDrive = p.mountPoint || state.init.places.some((place) => isMount(place) && place.path === p.path);
  $p(".drive-options").hidden = true;
  let driveWas = null; // {thumbnails, folderSizes} as they were
  if (isDrive) {
    showDrive(p.path, fact).then((d) => {
      if (!d?.options) return;
      driveWas = d.options;
      thumbBox.checked = d.options.thumbnails;
      sizesBox.checked = d.options.folderSizes;
      $p(".drive-options").hidden = false;
    });
  }

  const input = $p("#props-hook"), output = $p(".output"), descInput = $p("#props-desc"), tagsInput = $p("#props-tags");
  tagsInput.value = (p.meta?.tags ?? []).join(", ");
  const found = (autoTags.get(p.path) ?? []).map(([t]) => t).filter((t) => !(p.meta?.tags ?? []).includes(t));
  const ownText = carried.get(p.path);
  $p("#props-found").textContent = [found.length && `Found by auto-tagging: ${found.join(", ")}`, ownText && `The file's own description: ${ownText}`].filter(Boolean).join("\n");
  $p("#props-found").hidden = !found.length && !ownText;
  $p(".hook").hidden = p.kind !== "file"; // hooks are for files
  // A folder: a media folder (its videos in the Media view).
  const mediaBox = $p("#props-media");
  $p(".media-folder").hidden = p.kind !== "folder" || !mediaViewOn();
  mediaBox.checked = !!p.meta?.media;
  // A folder: auto-tagging its pictures (tagging.js), if set up.
  const autoBox = $p("#props-autotag");
  $p(".autotag").hidden = p.kind !== "folder";
  autoBox.checked = !!p.meta?.autoTags;
  const available = taggingAvailable();
  $p("#props-autotag-hint").textContent = !available.pictures
    ? "Set it up first: run scripts/install-tagging.sh in phil's source folder (several GB: PyTorch and the model)."
    : state.settings.autoTagAll === true
    ? "Every folder opened is tagged already (Preferences)."
    : `On this computer (SigLIP 2${available.documents ? "; text and Markdown files with EmbeddingGemma 2" : ""}): it stores what each picture shows${available.documents ? " and each document is about" : ""}, so typing a description in the filter box (\u201cfoggy forest\u201d) finds them. Keywords and descriptions saved in the files show too. What's tagged: Preferences.`;
  autoBox.disabled = !available.pictures && !autoBox.checked;
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
    if (p.kind === "folder" && mediaBox.checked !== !!p.meta?.media) changes.media = mediaBox.checked;
    if (p.kind === "folder" && iconPick !== (p.meta?.icon ?? "")) changes.icon = iconPick;
    const drive = {};
    if (driveWas && thumbBox.checked !== driveWas.thumbnails) drive.thumbnails = thumbBox.checked;
    if (driveWas && sizesBox.checked !== driveWas.folderSizes) drive.folderSizes = sizesBox.checked;
    if (Object.keys(drive).length) {
      try {
        await api("/api/drive-options", { method: "PUT", body: JSON.stringify({ path: p.path, ...drive }) });
        flashStatus(`${p.name}: ${[`thumbnails ${thumbBox.checked ? "on" : "off"}`, `folder sizes ${sizesBox.checked ? "on" : "off"}`].join(", ")}`);
        load(state.path); // its tiles as it now says
      } catch (err) {
        alert(`Couldn't save: ${err.message}`);
      }
    }
    if (!Object.keys(changes).length) return;
    try {
      await api("/api/meta", { method: "PUT", body: JSON.stringify({ path: p.path, ...changes }) });
      if ("onChange" in changes) flashStatus(onChange ? `${p.name}: when it changes, phil runs ${onChange}` : `${p.name}: nothing runs when it changes`);
      refresh();
      if ("description" in changes || "icon" in changes) refreshPlaces(); // a place's description is its label in the sidebar, its icon its icon
      if ((changes.tags?.length || "autoTags" in changes) && state.autoTagged) thumbs.tag(state.path); // the tag list may have grown
      if ("media" in changes) {
        if (changes.media) prepareMediaFolder(p.path, p.name);
        refreshPlaces(); // (its icon, if it's there)
      }
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
  a.onkeydown = (e) => void (e.key === "Enter" && (e.preventDefault(), openCamera(a.item)));
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
// The drive's details, as the server gives them (null if it can't).
async function showDrive(path, fact) {
  const pending = fact("Drive", { dim: "…" });
  const d = await api(`/api/drive?path=${encodeURIComponent(path)}`).catch(() => null);
  if (!d) return pending.replaceChildren("?"), null;
  const space = state.space[path];
  if (d.network) {
    pending.previousElementSibling.textContent = "Share";
    pending.replaceChildren(d.source, Object.assign(document.createElement("span"), { className: "dim", textContent: `  ${d.fstype}` }));
    if (space) fact("Space", `${formatSize(space.avail)} free of ${formatSize(space.size)}`);
    speedRow(path, fact("Speed"), d.speed, true);
    return d;
  }
  const how = { nvme: "NVMe", usb: "USB", sata: "SATA", ata: "ATA", mmc: "SD card" }[d.disk?.transport] ?? d.disk?.transport;
  pending.replaceChildren(d.disk?.model ?? d.source, d.disk ? Object.assign(document.createElement("span"), { className: "dim", textContent: `  ${[d.disk.size, how, d.disk.rotational ? "spinning" : null].filter(Boolean).join(" · ")}` }) : "");
  fact("Device", { code: d.disk?.path ?? d.source }, { dim: `  ${d.source !== d.disk?.path ? d.source + " · " : ""}${d.fstype}` });
  if (space) fact("Space", `${formatSize(space.avail)} free of ${formatSize(space.size)}`, { dim: `  ${Math.round((1 - space.avail / space.size) * 100)}% used` });
  if (d.disk) speedRow(path, fact("Read speed"), d.speed, false);
  return d;
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

// The browser starts its own gestures on a mouse press: dragging the thumbnail
// image, or a selection drag on empty space (during which the page isn't
// repainted, so the rectangle never shows). Cancelling the press's default
// action stops both; the grid then has to take focus itself.
grid.addEventListener("mousedown", (e) => {
  if (inRename(e)) return; // clicks in the name field place the cursor
  if (startsFileDrag(e)) {
    prepareDragFiles(markedEntries().map((m) => m.path)); // (for the drag that may follow)
    return void grid.focus({ preventScroll: true }); // the native drag, of files (below)
  }
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

// A click on a place opens it here, not left to the link: one isn't always
// followed (these can be dragged too), and then a click did nothing.
// (The rows are <a> without an href: a browser window shows a link's address,
// an internal one, at the bottom while the pointer's on it.)
new MutationObserver(() => {
  for (const a of $("#places").children) if (!a.hasAttribute("tabindex")) a.tabIndex = 0, a.setAttribute("role", "link");
}).observe($("#places"), { childList: true });
$("#places").addEventListener("keydown", (e) => {
  const a = e.target.closest("#places > a");
  if (a && e.key === "Enter") e.preventDefault(), a.click();
});
$("#places").addEventListener("click", (e) => {
  const a = e.target.closest("a[data-path]");
  if (!a || e.button !== 0 || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || e.defaultPrevented) return;
  e.preventDefault();
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
  updateDrag();
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
// the window, or out as files: then the browser shows it): up to three of
// their pictures stacked, with how many there are, and the name (or "4
// items") on a card. A canvas, drawn at the screen's scale (`.scale`).
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
    const at = (el) => el.dataset.path ?? el.dataset.place; // (the Media view's row: its place)
    if (y >= b.top - 4 && y < b.top + 5) return { gap: true, before: at(a), el: a, cls: "gap-before" };
    if (y >= b.bottom - 5 && y < b.bottom + 4) {
      const next = folders[i + 1];
      return next ? { gap: true, before: at(next), el: next, cls: "gap-before" } : { gap: true, before: null, el: a, cls: "gap-after" };
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
// Ctrl or Shift) is the page's own drag, carrying the selection as files
// (their file:// URIs), for a browser's page, another file manager, a chat...
// to take. (A right- or middle-drag stays in the window.) Dropped on a folder
// in phil itself, it asks "Move to / Copy to". (Started anywhere else, a
// left-drag draws the selection rectangle.)
let fileDrag = null; // { items, paths, dirs, button, target }

function startsFileDrag(e) {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || inRename(e)) return false;
  const i = tileIndex(e.target);
  return i !== -1 && state.marked.has(state.view[i].path);
}

const fileUri = (path) => "file://" + path.split("/").map(encodeURIComponent).join("/");

// Files dragged out of the window as files (onto a browser's page: an upload; a file manager,
// a chat). A page's file:// URIs are blanked by Chromium as they leave it, so in salir they go
// as File objects, salir.files' (the engine's windows may have them), asked for on the press
// that may start the drag (a file dialog's rule: in an input event): by the drag, they're
// there. A drag before they are carries the URIs, as elsewhere.
let dragFiles = null; // { key (the paths), files (once given) }
// When this window last started a drag of files. Dropped back on it, a drag that carries File
// objects comes with no data at all (Chromium's), and its dragend may come first (phil forgets
// the drag): a drag with nothing in it, soon after, is taken for that one (its paths: what
// it announced, see dropFromOutside).
let ownDragAt = 0;
const isOwnEmptyDrag = (dt) => !dt?.types?.length && Date.now() - ownDragAt < 60_000;

function prepareDragFiles(paths) {
  if (!globalThis.salir?.files) return;
  const key = paths.join("\n");
  if (dragFiles?.key === key) return;
  const entry = (dragFiles = { key, files: null });
  globalThis.salir.files(paths).then((files) => (entry.files = files), () => {});
}

// The files for `paths` into the drag; false if they aren't there (yet).
function addDragFiles(dt, paths) {
  if (dragFiles?.key !== paths.join("\n") || !dragFiles.files) return false;
  for (const f of dragFiles.files) dt.items.add(f);
  return true;
}

grid.addEventListener("dragstart", (e) => {
  const i = tileIndex(e.target);
  if (i === -1 || !state.marked.has(state.view[i].path)) return e.preventDefault();
  hideContextMenu();
  const items = markedEntries();
  // The drag's picture, the same as a right-drag's: the browser takes it from the
  // page, so it's put there (where it shows during the drag anyway) for now.
  const picture = dragPicture(items, state.view[i]);
  picture.style.cssText += `position: fixed; z-index: 30; left: ${e.clientX - DRAG_HOTSPOT[0]}px; top: ${e.clientY - DRAG_HOTSPOT[1]}px;`;
  document.body.append(picture);
  e.dataTransfer.setDragImage(picture, DRAG_HOTSPOT[0], DRAG_HOTSPOT[1]);
  setTimeout(() => picture.remove());
  fileDrag = { items, paths: new Set(items.map((m) => m.path)), dirs: items.filter((m) => m.kind === "dir").map((m) => m.path + "/"), button: 0 };
  fileDrag.id = announceDrag(items.map((m) => m.path), 0);
  ownDragAt = Date.now();
  e.dataTransfer.effectAllowed = "copyMove";
  const paths = items.map((m) => m.path);
  if (!addDragFiles(e.dataTransfer, paths)) e.dataTransfer.setData("text/uri-list", paths.map(fileUri).join("\r\n"));
  e.dataTransfer.setData("text/plain", paths.join("\n"));
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
  ownDragAt = Date.now();
  // (Moving it in the sidebar is a "move" too: the browser drops nothing whose
  // effect the drag didn't allow, and a page's drags can't allow "link".)
  e.dataTransfer.effectAllowed = "copyMove";
  if (!addDragFiles(e.dataTransfer, [item.path])) e.dataTransfer.setData("text/uri-list", fileUri(item.path));
  e.dataTransfer.setData("text/plain", item.path);
});
// (A left press on a place: its file, ready for the drag that may follow. See prepareDragFiles.)
$("#places").addEventListener("mousedown", (e) => {
  const place = e.button === 0 && placeItem(e.target);
  if (place) prepareDragFiles([place.item.path]);
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
// links to them (text/html: a drag from another phil window may come with its
// text/uri-list empty, and the files only as links there).
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

// A drag out of a phil window: its files for the window it's dropped on (the
// drop itself may not carry them).
function announceDrag(paths, button) {
  const id = crypto.randomUUID();
  api("/api/drag", { method: "PUT", body: JSON.stringify({ paths, button, id }) }).catch(() => {});
  return id;
}

async function dropFromOutside(e, carried, links = []) {
  const target = outsideTarget;
  setOutsideTarget(null);
  if (!target) return;
  // Links (no files): downloaded into the folder they're dropped on.
  if (!carried.length && links.length) return target.gap ? flashStatus("Drop links on a folder to download them there") : download(links, target.path);
  let paths = carried;
  // From another phil window: what it said it's dragging (its files, when the drop lost them).
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
    setOutsideTarget(carriesFiles(e.dataTransfer) || isOwnEmptyDrag(e.dataTransfer) ? outsideTargetAt(e.clientX, e.clientY) : null);
    e.dataTransfer.dropEffect = outsideTarget ? "copy" : "none";
    return;
  }
  const target = dropTargetAt(e.clientX, e.clientY, fileDrag);
  markTarget(fileDrag.target, target);
  fileDrag.target = target;
  e.dataTransfer.dropEffect = target ? "move" : "none"; // between the sidebar's folders too (see its dragstart)
});
addEventListener("drop", (e) => {
  e.preventDefault();
  const carried = filePaths(e.dataTransfer), links = downloadLinks(e.dataTransfer); // the drop's data: gone once this handler awaits
  ownDragAt = 0;
  if (!fileDrag) return dropFromOutside(e, carried, links);
  const target = fileDrag?.target;
  const { items, dirs } = fileDrag ?? {};
  endFileDrag();
  if (!target) return;
  if (target.gap) return addToSidebar(dirs.map((p) => p.slice(0, -1)), target.before);
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
    flashStatus(`${op === "move" ? "Moving" : "Copying"} stopped: what was done stays ${op === "move" ? "moved" : "copied"}; ↻ on the folder resumes it`);
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
  const was = state.transfers.get(p.id);
  if (p.finished) state.transfers.delete(p.id), copyBases.delete(p.id);
  else state.transfers.set(p.id, p);
  showTransfers();
  // The folders it's copying into: their size lines as it goes (copySize).
  const t = p.finished ? was : p;
  for (const path of t ? [...(t.targets ?? []), t.dest] : []) {
    const tile = tiles.get(path), entry = tile && state.view[tile.dataset.index];
    if (entry?.kind === "dir" && entry.path === path) showFolderInfo(tile, entry);
  }
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
  // Others' downloads (a browser's): a bar on its partial file.
  for (const w of state.browserDownloads) add(tiles.get(w.path), { key: `web ${w.id}`, w });
  // Folders being added to Media (prepareMediaFolder): how far.
  for (const [path, m] of mediaPreparing) add(tiles.get(path), { key: "media", m });
  // Copies cut off (a crash, ×): their record says how far they got; ↻ goes on, × forgets it.
  for (const e of state.view) if (e.copying?.state === "stopped" && !live.has(e.path)) add(tiles.get(e.path), { key: "stopped", stopped: e });
  for (const bar of document.querySelectorAll(".transfer-bar")) if (!bars.has(bar.parentElement)) bars.set(bar.parentElement, []); // none there now
  for (const [host, list] of bars) {
    keyed(host, list, {
      key: (b) => b.key,
      kind: barKind,
      make: (b) => makeTransferBar(barKind(b)),
      show: (bar, b) => (b.m ? showMediaPrepareBar(bar, b.m) : b.w ? showWebBar(bar, b.w) : b.d ? showDownloadBar(bar, b.d, b.part) : b.stopped ? showStoppedBar(bar, b.stopped) : showTransferBar(bar, b.t, b)),
    });
    // More than one on a tile (a copy into a folder a download goes to): one under the other.
    [...host.querySelectorAll(":scope > .transfer-bar")].forEach((bar, i) => put(bar.style, "top", i ? `${8 + i * 24}px` : ""));
  }
  renderTransferList();
}

// The sidebar's Processes: long work in the background (a folder's total
// being worked out, after 10 seconds: it goes on when another folder is
// shown), what and for how long; × stops it, a click shows the folder.
let processTicker = null;
function renderProcesses() {
  // One from the background shown in the terminal panel: the main terminal first (a click: back to it).
  const list = [...(terminal.kept ? [{ id: "main-terminal", kind: "main-terminal" }] : []), ...(state.processes ?? [])];
  keyed($("#processes"), list, { key: (p) => p.id, make: makeProcessRow, show: showProcessRow });
  $("#processes-panel").hidden = !list.length;
  // (How long they've taken: folders' totals'; a terminal in the background has none.)
  const timed = list.some((p) => p.kind !== "terminal" && p.kind !== "main-terminal");
  if (timed && !processTicker) processTicker = setInterval(() => [...$("#processes").children].forEach((row) => showProcessRow(row, row.item)), 1000);
  if (!timed) clearInterval(processTicker), (processTicker = null);
}

function makeProcessRow() {
  const row = document.createElement("div");
  row.className = "process-row";
  const cancel = Object.assign(document.createElement("button"), { type: "button", className: "cancel", textContent: "×", title: "Stop it (worked out again when it's asked for)" });
  cancel.addEventListener("click", async (e) => {
    e.stopPropagation();
    const p = row.item;
    if (p.kind === "terminal" && !await askConfirm({ title: `End “${p.command}”?`, detail: `The terminal in the background is closed: what runs there is hung up (in ${p.cwd}).`, ok: "End it" })) return;
    api("/api/process-cancel", { method: "POST", body: JSON.stringify({ id: p.id }) }).catch(() => {});
  });
  const icon = Object.assign(document.createElement("img"), { className: "process-icon", alt: "", hidden: true });
  icon.onerror = () => (icon.hidden = true);
  const glyph = Object.assign(document.createElement("span"), { className: "process-glyph", hidden: true }); // (the main terminal's, ssh's: Lucide's)
  row.append(Object.assign(document.createElement("span"), { className: "process-name" }), Object.assign(document.createElement("span"), { className: "process-time" }), cancel, icon, glyph);
  row.addEventListener("click", () => {
    const p = row.item;
    if (p.kind === "main-terminal") switchTerminal(1);
    else if (p.kind === "terminal") showBackgroundTerminal(p.term);
    else load(p.path);
  });
  row.addEventListener("mouseenter", () => row.item && showProcessRow(row, row.item)); // (its tip's time, as it is now)
  row.addEventListener("pointerdown", (e) => dragProcess(row, e));
  row.addEventListener("contextmenu", (e) => {
    const p = row.item;
    if (p?.kind !== "terminal") return;
    e.preventDefault();
    e.stopPropagation(); // (the sidebar's own menu would take its place)
    showMenu(e.clientX, e.clientY, [
      ["Rename…", () => renameProcess(p, row.querySelector(".process-name").textContent)],
      ["End", () => row.querySelector(".cancel").click()],
    ]);
  });
  return row;
}

const SHELLS = new Set(["bash", "sh", "zsh", "fish", "dash"]);
// Claude Code's terminal title starts with its status: idle (✳), or a spinner's frame.
const CLAUDE_MARK = /^[·✢✳✶✻✽◐◓◑◒]/u;

function showProcessRow(row, p) {
  const [name, time, cancel, icon, glyph] = row.children;
  const showGlyph = (which) => {
    put(glyph, "hidden", !which);
    if (which) putIcon(glyph, which);
  };
  if (p.kind === "main-terminal") {
    showGlyph("l:square-terminal");
    const at = terminal.main.cwd;
    put(name, "textContent", !at ? "Terminal" : at === state.init.home ? "~" : at === "/" ? "/" : at.split("/").pop());
    put(row, "title", ["The main terminal", at].filter(Boolean).join("\n"));
    put(time, "textContent", "");
    put(cancel, "hidden", true);
    put(icon, "hidden", true);
    return;
  }
  if (p.kind !== "terminal") showProcessTime(time, p);
  else put(time, "textContent", "");
  if (p.kind === "terminal") {
    // (The one this panel shows: marked; one another window's shows: dimmed.)
    row.classList.toggle("current", p.term === terminal.session);
    row.classList.toggle("elsewhere", !!p.attached && p.term !== terminal.session);
    // A terminal in the background: what runs there (its program without its path); just a
    // shell (at its prompt): the folder it's in.
    const [program = "bash", ...args] = (p.command || "bash").split(/\s+/);
    const shown = program.split("/").pop().replace(/^-/, "");
    const folder = p.cwd === state.init.home ? "~" : p.cwd === "/" ? "/" : p.cwd?.split("/").pop();
    // Claude Code: claude.ai's icon, and its session's name (the terminal's title it sets, its
    // status mark before it left out), else the folder.
    // ssh'd in: what runs there, by the terminal's title its programs set (Claude Code's: its
    // status mark first), the ssh command in the tip.
    const ssh = shown === "ssh";
    const remoteClaude = ssh && CLAUDE_MARK.test(p.title ?? "");
    const claude = shown === "claude" || remoteClaude;
    const titled = (p.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
    const session = claude ? titled : "";
    // (Over ssh, the newer of the title set there and the command typed there, its prompt left out.)
    const typed = (p.typed ?? "").replace(/^.*?[#$%>❯➜»]\s+(?=\S)/u, "");
    const remote = typed && (p.typedAt ?? 0) > (p.titleAt ?? 0) ? typed : titled || typed;
    const label = p.name || (claude ? session || folder || "claude" : ssh ? remote || p.command : SHELLS.has(shown) && folder ? folder : [shown, ...args].join(" "));
    put(name, "textContent", label);
    if (claude && !icon.getAttribute("src")) icon.src = "/api/icon/claude";
    put(icon, "hidden", !claude);
    showGlyph(ssh && !claude ? "l:server" : null); // (ssh'd in: another machine's)
    // Its tip: what it is, where, how long it's been going.
    put(row, "title", [label, ssh && p.command, p.cwd || "", elapsed(p.started)].filter(Boolean).join("\n"));
    put(cancel, "title", "End it (what runs there is hung up)");
    return;
  }
  showGlyph(null);
  const folder = p.path === "/" ? "/" : p.path.split("/").pop();
  put(name, "textContent", folder); // (what it's doing: in its tip, the sidebar's narrow)
  put(row, "title", `${p.mode === "check" ? "Looking at the times of the folders in" : "Adding up the size of everything in"} ${p.path}, at the lowest priority`);
  put(cancel, "title", "Stop it (worked out again when it's asked for)");
}

// A background terminal dropped on a folder: a script there, named and with the icon it has in
// the list, that starts it again (phil --background: back in the list, last).
async function processScript(row, dir) {
  const p = row.item;
  const name = row.querySelector(".process-name").textContent;
  const icon = !row.querySelector(".process-icon").hidden ? "claude" : !row.querySelector(".process-glyph").hidden ? row.querySelector(".process-glyph").dataset.icon?.replace(/^l:/, "") : "square-terminal";
  try {
    const { path } = await api("/api/terms-script", { method: "POST", body: JSON.stringify({ id: p.term, dir, name, icon }) });
    flashStatus(`${path.split("/").pop()}: in ${dir}. It starts “${name}” again, in the background`);
    if (dir === state.path) initialSelect = [path];
  } catch (err) {
    alert(`Couldn't make its script: ${err.message}`);
  }
}

// A terminal in the background named (its host keeps it); blank: named by what runs there again.
async function renameProcess(p, shown) {
  const answer = await askConfirm({ title: "Rename", detail: "Blank: named by what runs there.", ok: "Rename", danger: false, fields: [{ name: "name", label: "Name", value: p.name || shown }] });
  if (!answer) return;
  api("/api/terms-rename", { method: "POST", body: JSON.stringify({ id: p.term, name: answer.name }) }).catch(() => {});
}

// Terminals in the background dragged up or down among themselves: their order (and Alt+
// numbers) for every window, kept by the server (terms.js); a line shows where it goes.
function dragProcess(row, e) {
  if (e.button !== 0 || row.item?.kind !== "terminal" || e.target.closest(".cancel")) return;
  const rows = () => [...$("#processes").children].filter((r) => r.item?.kind === "terminal");
  const startY = e.clientY;
  let moved = false, before = null, folder = null; // (folder: dropped there, a script that starts it again)
  const mark = () => {
    const others = rows().filter((r) => r !== row);
    for (const r of others) {
      r.classList.toggle("drop-before", r === before);
      r.classList.toggle("drop-after", !before && r === others.at(-1));
    }
  };
  const move = (ev) => {
    if (!moved && Math.abs(ev.clientY - startY) < 5) return;
    moved = true;
    row.classList.add("dragging");
    // Out of the list, over a folder (a tile, a place, the folder shown): a script there.
    const inList = !!document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.("#processes-panel");
    const over = inList ? null : outsideTargetAt(ev.clientX, ev.clientY);
    folder = over && !over.gap ? over : null;
    setOutsideTarget(folder);
    if (folder) return (before = null), mark(), rows().forEach((r) => r.classList.remove("drop-before", "drop-after"));
    before = rows().filter((r) => r !== row).find((r) => {
      const b = r.getBoundingClientRect();
      return ev.clientY < b.top + b.height / 2;
    }) ?? null;
    mark();
  };
  const up = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointercancel", up);
    removeEventListener("pointerup", up);
    row.classList.remove("dragging");
    for (const r of rows()) r.classList.remove("drop-before", "drop-after");
    setOutsideTarget(null);
    if (!moved) return;
    row.addEventListener("click", (ev) => ev.stopImmediatePropagation(), { capture: true, once: true }); // (a drag, not a click)
    if (folder) return void processScript(row, folder.path);
    const ids = rows().filter((r) => r !== row).map((r) => r.item.term);
    ids.splice(before ? ids.indexOf(before.item.term) : ids.length, 0, row.item.term);
    // In that order at once (the server's list follows).
    const byId = new Map((state.processes ?? []).filter((p) => p.kind === "terminal").map((p) => [p.term, p]));
    state.processes = [...(state.processes ?? []).filter((p) => p.kind !== "terminal"), ...ids.map((id) => byId.get(id))];
    renderProcesses();
    api("/api/terms-order", { method: "PUT", body: JSON.stringify({ ids }) }).catch(() => {});
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
  addEventListener("pointercancel", up);
}

// How long it's been going (h:mm:ss).
function showProcessTime(time, p) {
  put(time, "textContent", elapsed(p.started));
}

function elapsed(started) {
  const s = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
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
    ...state.browserDownloads.map((w) => ({ key: `web ${w.id}`, w })),
  ];
  keyed($("#transfers"), list, { key: (b) => b.key, kind: barKind, make: makeTransferRow, show: showTransferRow });
  // Its heading only while there's something (or the view's open); the settings have a way in too.
  $("#transfers-panel").classList.toggle("empty", !list.length && transfersView.hidden);
  if (!transfersView.hidden) renderTransfersView(list);
}

function makeTransferRow(b) {
  const row = document.createElement("div");
  row.className = "transfer-row";
  row.append(Object.assign(document.createElement("span"), { className: "transfer-name" }), makeTransferBar(barKind(b)));
  row.addEventListener("click", () => goToTransfer(row.item));
  row.addEventListener("mouseenter", () => put(row, "title", transferTip(row.item))); // its time "ago" as of now
  return row;
}

function showTransferRow(row, b) {
  const [name, bar] = row.children;
  bar.item = b;
  if (b.w) showWebBar(bar, b.w);
  else if (b.stopped) showStoppedBar(bar, b.stopped);
  else if (b.d) showDownloadBar(bar, b.d);
  else showTransferBar(bar, b.t);
  let what;
  if (b.w) what = b.w.name;
  else if (b.stopped) what = `${b.stopped.copying.op === "move" ? "Moving" : "Copying"} ${b.stopped.path.split("/").pop()}`;
  else if (b.d) what = b.d.name;
  else what = `${{ move: "Moving", delete: "Deleting" }[b.t.op] ?? "Copying"} ${b.t.items > 1 ? `${b.t.items} items` : (b.t.targets?.[0] ?? b.t.dest).split("/").pop()}`;
  put(name, "textContent", what);
  // Hovering the row (its bar too): what's happening, and where.
  bar.removeAttribute("title");
  put(row, "title", transferTip(b));
}

// When something happened, as precisely as it's worth: "5 minutes ago" within the
// hour, then with its time ("3 hours ago, 14:32"), "yesterday 14:32", the weekday
// within the week ("Monday 14:32"), the date this year ("12 Oct 14:32"), with the
// year before that.
function whenText(ms) {
  const t = dayjs(ms), now = dayjs();
  if (now.diff(t, "minute") < 60) return t.fromNow();
  if (t.isSame(now, "day")) return `${t.fromNow()}, ${t.format("HH:mm")}`;
  if (t.isSame(now.subtract(1, "day"), "day")) return `yesterday ${t.format("HH:mm")}`;
  if (now.diff(t, "day") < 7) return t.format("dddd HH:mm");
  return t.format(t.isSame(now, "year") ? "D MMM HH:mm" : "D MMM YYYY HH:mm");
}

// A transfer's tooltip in the sidebar: its state and numbers, then when it started (or stopped).
function transferTip(b) {
  const of = (done, total) => (total ? `${formatSize(done)} of ${formatSize(total)}` : "");
  const line = (...parts) => parts.filter(Boolean).join(" · ");
  const when = (label, ms) => (ms ? `${label} ${whenText(ms)}` : "");
  if (b.w) {
    const w = b.w, going = w.state === "downloading";
    return [line(`${w.app}: ${going ? "downloading" : w.state === "stalled" ? "paused or stalled" : w.state}`, w.total ? of(w.bytes, w.total) : formatSize(w.bytes),
      going && w.speed ? `${formatSize(w.speed)}/s` : "", going && w.eta != null ? `${formatDuration(w.eta)} left` : ""), when("Started", w.started)].filter(Boolean).join("\n");
  }
  if (b.stopped) {
    const c = b.stopped.copying;
    return [line(`${c.op === "move" ? "Move" : "Copy"} stopped at ${c.percent}%`, of(c.bytes, c.total)), when("Stopped", c.updated)].filter(Boolean).join("\n");
  }
  if (b.t) {
    const t = b.t;
    const head = t.op === "delete" ? (t.counting ? `Counting: ${t.found.toLocaleString()} so far` : `Deleting: ${t.bytes.toLocaleString()} of ${t.total.toLocaleString()} gone`)
      : t.preparing && !t.paused ? `${t.op === "move" ? "Moving" : "Copying"}: ${t.preparing.toLowerCase()}…`
      : line(t.op === "move" ? (t.paused ? "Move paused" : "Moving") : t.paused ? "Copy paused" : "Copying", of(t.bytes, t.total),
        !t.paused && t.speed ? `${formatSize(t.speed)}/s` : "", !t.paused && t.eta != null ? `${formatDuration(t.eta)} left` : "");
    return [head, when("Started", t.started)].filter(Boolean).join("\n");
  }
  const d = b.d, active = d.state === "downloading" && d.checking == null;
  const state = d.checking != null ? `Checking files ${d.checking}%`
    : { paused: "Paused", completed: d.upSpeed > 0 ? "Seeding" : "Downloaded", error: "Failed", failed: "Failed", queued: "Queued", metadata: "Finding the torrent", initializing: "Starting", starting: "Starting" }[d.state] ?? "Downloading";
  return [line(state, d.state === "completed" ? formatSize(d.total) : of(d.bytes, d.total), active && d.speed ? `${formatSize(d.speed)}/s` : "", active && d.eta ? `${formatDuration(d.eta)} left` : "",
    d.upSpeed ? `↑ ${formatSize(d.upSpeed)}/s` : "", (d.state === "error" || d.state === "failed") && d.error), when("Added", d.created * 1000)].filter(Boolean).join("\n");
}

// The folder a transfer goes to (a delete's: the one it's deleting in), with what it's making selected.
function goToTransfer(b) {
  closeTransfersView({ resume: false });
  if (b.stopped) {
    initialSelect = [b.stopped.path];
    return navigate(parentOf(b.stopped.path));
  }
  if (b.w) {
    initialSelect = [b.w.path];
    return navigate(parentOf(b.w.path));
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

// `focus`: one of them ("download <id>", "web <id>": mediaview's) scrolled to and lit up, once it's there.
let transfersFocusKey = null;
function openTransfersView(focus = null) {
  transfersFocusKey = typeof focus === "string" ? focus : null;
  closePrefsView();
  // Where the keyboard goes back to: the folder, or the terminal (not the heading clicked to open it).
  transfersFocus = document.activeElement?.closest?.("#sidebar") ? grid : document.activeElement;
  transfersView.hidden = false;
  $("#btn-transfers").setAttribute("aria-pressed", "true");
  renderTransferList();
  loadDownloadSettings();
  transfersView.querySelector(".tv-head .close").focus({ preventScroll: true });
}

// `resume`: an app set aside for it (mediaview's download shown here) comes back as it was; false
// (a folder opened, Preferences): that app's closed.
function closeTransfersView({ resume = true } = {}) {
  if (transfersView.hidden) return;
  transfersView.hidden = true;
  $("#btn-transfers").setAttribute("aria-pressed", "false");
  renderTransferList();
  if (appAside) return void (resume ? bringAppBack() : closeApp());
  const back = transfersFocus?.isConnected && transfersFocus !== document.body && !transfersView.contains(transfersFocus) ? transfersFocus : grid;
  back.focus({ preventScroll: true });
}

function renderTransfersView(list) {
  transfersView.querySelector(".tv-empty").hidden = list.length > 0;
  keyed($("#tv-items"), list, { key: (b) => b.key, kind: barKind, make: makeTransferCard, show: showTransferCard });
  const card = transfersFocusKey && [...$("#tv-items").children].find((c) => c.dataset.keyed === transfersFocusKey);
  if (!card) return;
  transfersFocusKey = null;
  card.scrollIntoView({ block: "center" });
  card.classList.add("focused");
  setTimeout(() => card.classList.remove("focused"), 2500);
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
  if (b.d) { // panda-dl's: stopped, and every file it was making deleted
    card.insertAdjacentHTML("beforeend", `<div class="tv-actions"><button type="button" class="tv-delete danger"></button></div>`);
    card.querySelector(".tv-delete").onclick = () => deleteDownload(card.item.d);
  }
  return card;
}

function showTransferCard(card, b) {
  const bar = card.querySelector(".transfer-bar");
  bar.item = b;
  if (b.w) showWebBar(bar, b.w);
  else if (b.stopped) showStoppedBar(bar, b.stopped);
  else if (b.d) showDownloadBar(bar, b.d);
  else showTransferBar(bar, b.t);
  const what = b.w ? b.w.name : b.stopped ? b.stopped.path.split("/").pop() : b.d ? b.d.name : b.t.items > 1 ? `${b.t.items} items` : (b.t.targets?.[0] ?? b.t.dest).split("/").pop();
  put(card.querySelector(".tv-name"), "textContent", what);
  let state, where, facts;
  if (b.w) {
    const w = b.w, going = w.state === "downloading";
    state = `${w.app}: ${going ? "downloading" : w.state === "stalled" ? "paused or stalled" : w.state}`;
    where = `Into ${w.dir}`;
    facts = [w.total ? `${formatSize(w.bytes)} of ${formatSize(w.total)}` : formatSize(w.bytes), going && w.speed ? `↓ ${formatSize(w.speed)}/s` : "",
      going && w.eta != null ? `${formatDuration(w.eta)} left` : "", w.started ? `started ${whenText(w.started)}` : "", w.stoppable ? "" : "(phil can't pause or stop it: the program doing it can)"];
  } else if (b.stopped) {
    const c = b.stopped.copying;
    state = `${c.op === "move" ? "Moving" : "Copying"} stopped at ${c.percent}%`;
    where = `To ${parentOf(b.stopped.path)}`;
    facts = [`from ${c.from}`, c.total ? `${formatSize(c.bytes)} of ${formatSize(c.total)}` : "", c.updated ? `stopped ${formatDate(c.updated)}` : "", "↻ resumes it where it stopped"];
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
  const del = card.querySelector(".tv-delete");
  if (del) put(del, "textContent", b.d.state === "completed" ? "Remove and delete its files" : "Cancel and delete its files");
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
  const toggle = barButton("", "", () => api("/api/download", { method: "POST", body: JSON.stringify({ action: filePaused(row.d, row.item) ? "resume_files" : "pause_files", id: row.d.id, paths: [row.item.path] }) }).catch((err) => alert(err.message)));
  toggle.classList.add("pause");
  row.append(toggle, barButton("×", "", () => stopDownloadPart({ d: row.d, part: { path: row.item.path } })));
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
  const paused = pct < 100 && filePaused(d, f);
  row.classList.toggle("paused", paused);
  const toggle = row.querySelector(".pause");
  put(toggle.style, "visibility", pct >= 100 || d.state === "completed" ? "hidden" : "");
  putIcon(toggle, paused ? "l:play" : "l:pause");
  put(toggle, "title", paused ? `Resume this${d.state === "paused" ? " (the rest stays paused)" : ""}` : "Pause this (the rest goes on)");
  put(row.querySelector(".cancel:not(.pause)"), "title", d.state === "completed" || d.files.length === 1
    ? "Drop it (the last of it: the download is closed; the file stays)" : "Stop downloading this (the rest continues; what's downloaded stays)");
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
const barKind = (b) => (b.m ? "media" : b.w ? (b.w.stoppable ? "web-stop" : "web") : b.d ? (partDone(b) ? "downloaded" : "download") : b.stopped ? (b.stopped.copying.file ? "stopped-file" : "stopped") : b.t.op === "delete" ? "delete" : "copy");

// A download's files, and the folders in it (below the folder it goes to),
// each with how much of it there is and how much is downloaded: path ->
// {length, downloaded} (null for both: not known, the download's own then).
function downloadParts(d) {
  const parts = new Map();
  for (const f of d.files ?? []) {
    const left = f.length === null || f.downloaded < f.length;
    const going = left && !filePaused(d, f);
    for (let path = f.path; path.length > d.dir.length && path.startsWith(d.dir + "/"); path = parentOf(path)) {
      const part = parts.get(path) ?? parts.set(path, { length: 0, downloaded: 0, left: 0, going: 0, marked: 0 }).get(path);
      if (f.length === null || part.length === null) part.length = part.downloaded = null;
      else part.length += f.length, part.downloaded += f.downloaded;
      part.left += left; // its files not done yet,
      part.going += going; // and those of them being downloaded (not paused),
      part.marked += left && !!f.paused; // and paused by themselves
    }
  }
  return parts;
}

// A torrent's file paused: by itself, or with all of it.
const filePaused = (d, f) => f.paused || ["paused", "error", "failed"].includes(d.state);

// The torrents under way (panda-dl's, their files listed) that `paths` are
// files of, or folders in: [{d, paths, pausable, resumable}], where pausable
// and resumable are those of `paths` with files not done that aren't paused
// by themselves (all of it paused or being checked, too: they stay paused when
// it goes on), or are paused (by themselves, or with all of it).
function torrentsOf(paths) {
  const found = [];
  for (const d of state.downloads) {
    if (d.state === "completed" || !d.files?.length || d.files[0].length === null) continue;
    const mine = paths.filter((p) => p.startsWith(d.dir + "/"));
    const filesOf = (p) => d.files.filter((f) => (f.path === p || f.path.startsWith(p + "/")) && f.downloaded < f.length);
    const pausable = mine.filter((p) => filesOf(p).some((f) => !f.paused));
    const resumable = mine.filter((p) => filesOf(p).some((f) => filePaused(d, f)));
    if (pausable.length || resumable.length) found.push({ d, pausable, resumable });
  }
  return found;
}

// Some of torrents' files and folders paused or resumed (`action`: pause_files
// or resume_files), each torrent's together; the rest of each goes on as it was.
function pauseDownloadFiles(action, torrents) {
  for (const { d, pausable, resumable } of torrents) {
    const paths = action === "pause_files" ? pausable : resumable;
    if (paths.length) api("/api/download", { method: "POST", body: JSON.stringify({ action, id: d.id, paths }) }).catch((err) => alert(`Couldn't ${action === "pause_files" ? "pause" : "resume"} them: ${err.message}`));
  }
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

// A download stopped and taken off panda-dl's list, and its files deleted (what's downloaded of them too), once asked.
async function deleteDownload(d) {
  const done = d.state === "completed";
  const ok = await askConfirm({
    title: `${done ? "Remove" : "Cancel"} \u201c${d.name}\u201d and delete its files?`,
    detail: `${d.files?.length > 1 ? `Its ${d.files.length} files` : "Its file"} in ${d.dir} (${formatSize(done ? d.total : d.bytes)}${done ? "" : " downloaded so far"}) are deleted, not put in the trash.`,
    ok: "Delete", danger: true,
  });
  if (!ok) return;
  api("/api/download", { method: "POST", body: JSON.stringify({ action: "remove", id: d.id, deleteFile: true }) }).catch((err) => alert(`Couldn't delete it: ${err.message}`));
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
    const paused = !part.going, checking = d.checking != null; // (paused: by itself, or with all of it)
    bar.classList.toggle("paused", paused || checking);
    bar.classList.remove("failed");
    put(bar.querySelector(".fill").style, "width", `${pct}%`);
    put(bar.querySelector(".pct"), "textContent", `${paused && !inSidebar(bar) ? "Paused " : checking ? "Checking… " : ""}${pct}%`);
    put(bar, "title", `${formatSize(part.downloaded)} of ${formatSize(part.length)} of this; “${d.name}”: ${d.percent}%` +
      (part.marked && part.marked === part.left ? ` (paused by itself${d.state === "paused" || checking ? `: it stays paused when “${d.name}” goes on` : ""})` : paused ? " (paused)" : `${d.speed ? `, ${formatSize(d.speed)}/s` : ""}${d.eta ? `, ${formatDuration(d.eta)} left` : ""}`));
    const [toggle, stop] = bar.querySelectorAll(".cancel");
    putIcon(toggle, paused ? "l:play" : "l:pause");
    put(toggle, "title", d.files?.length > 1
      ? (paused ? `Resume this${d.state === "paused" ? ` (the rest of “${d.name}” stays paused)` : ""}` : `Pause this (the rest of “${d.name}” goes on)`)
      : paused ? `Resume “${d.name}”` : `Pause “${d.name}”`);
    put(stop, "title", d.files?.length > 1 ? "Stop downloading this (the rest continues; what's downloaded stays)" : `Stop and forget “${d.name}” (what's downloaded stays)`);
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
  put(toggle, "title", paused || failed ? "Resume" : "Pause");
  put(stop, "title", "Stop and forget this download (what's downloaded stays)");
}

// A copy's speed and time left (server.js: bytes/s and seconds), after `sep`; "" when not known.
const copySpeed = (t, sep) => (t.speed ? `${sep}${formatSize(t.speed)}/s` : "") + (t.speed && t.eta != null ? `${sep}${formatDuration(t.eta)} left` : "");

// Another program's download (a browser's): how far (its size known: from the browser's
// History), how fast; a size unknown, a moving stripe.
function showWebBar(bar, w) {
  const stop = bar.querySelector(".cancel");
  if (stop) put(stop, "title", w.stopKeeps ? "Stop it (what's downloaded so far is saved)" : "Stop it (what's downloaded so far is deleted)");
  // A program's own state (a report's: "preparing", "converting"...), said as it is.
  if (w.state !== "downloading" && w.state !== "stalled") {
    const words = w.state.charAt(0).toUpperCase() + w.state.slice(1);
    bar.classList.add("paused");
    bar.classList.remove("unknown");
    put(bar.querySelector(".fill").style, "width", w.percent != null ? `${w.percent}%` : "0%");
    put(bar.querySelector(".pct"), "textContent", inSidebar(bar) ? (w.percent != null ? `${w.percent}%` : "") : `${words}${w.percent != null ? ` ${w.percent}%` : ""}`);
    return put(bar, "title", `${w.app}: ${w.name}, ${w.state}`);
  }
  bar.classList.remove("paused");
  const going = w.state === "downloading", known = w.percent != null;
  bar.classList.toggle("paused", !going);
  bar.classList.toggle("unknown", !known && going);
  put(bar.querySelector(".fill").style, "width", known ? `${w.percent}%` : "100%");
  const amount = known ? `${w.percent}%` : formatSize(w.bytes);
  put(bar.querySelector(".pct"), "textContent", going ? `${amount}${w.speed ? ` · ${formatSize(w.speed)}/s` : ""}` : inSidebar(bar) ? amount : `Stalled ${amount}`);
  put(bar, "title", `${w.app}: ${w.name}, ${known ? `${formatSize(w.bytes)} of ${formatSize(w.total)}` : formatSize(w.bytes)}` +
    (going ? `${w.speed ? `, ${formatSize(w.speed)}/s` : ""}${w.eta != null ? `, ${formatDuration(w.eta)} left` : ""}` : " (paused or stalled)"));
}

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
  if (kind === "copy") label.insertAdjacentHTML("beforebegin", icon("l:loader-circle", "spin")); // getting ready (preparing)
  const cancel = () => api("/api/transfer-cancel", { method: "POST", body: JSON.stringify({ id: bar.item.t.id }) }).catch(() => {});
  if (kind === "delete") {
    bar.classList.add("deleting");
    bar.append(barButton("×", "Stop deleting (what's gone is gone; the rest stays)", cancel));
  } else if (kind === "downloaded") {
    bar.classList.add("downloaded");
    // Downloaded (an icon), and while it's seeding, ↑ and how fast.
    label.innerHTML = `${icon("l:download")}<span class="seeding">${icon("l:arrow-up")}<span></span></span>`;
    bar.append(barButton("×", "", () => stopDownloadPart(bar.item)));
  } else if (kind === "web" || kind === "web-stop") {
    bar.classList.add("download", "web"); // another program's: phil can't pause it; × when its report says it may be stopped
    if (kind === "web-stop") bar.append(barButton("×", "Stop it (what's downloaded so far is left)", () => api("/api/transfer-report-stop", { method: "POST", body: JSON.stringify({ id: bar.item.w.id }) }).catch(() => {})));
  } else if (kind === "download") {
    bar.classList.add("download");
    const act = (body) => api("/api/download", { method: "POST", body: JSON.stringify(body) }).catch((err) => alert(err.message));
    bar.append(
      barButton("", "", () => {
        const { d, part } = bar.item;
        // On one of a torrent's files (or a folder in it): that one, by itself.
        if (part?.path && part.length != null && d.files?.length > 1) return act({ action: part.going ? "pause_files" : "resume_files", id: d.id, paths: [part.path] });
        act({ action: ["paused", "error", "failed"].includes(d.state) ? "resume" : "pause", id: d.id });
      }),
      barButton("×", "", () => stopDownloadPart(bar.item)),
    );
  } else if (kind === "media") {
    bar.classList.add("media-prepare"); // a folder being added to Media: nothing to stop (it's quick, and harmless)
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
  // Getting ready (counting, rsync listing or comparing what's there): saying so with the spinning
  // icon on a tile; in the sidebar, the icon alone.
  bar.classList.toggle("preparing", !!t.preparing && !t.paused);
  if (t.preparing && !t.paused) return put(label, "textContent", inSidebar(bar) ? "" : `${t.preparing}…`);
  // As a download's: how far, and its speed (not on the file it's at: that's only how far into it).
  put(label, "textContent", `${t.paused && !inSidebar(bar) ? "Paused " : ""}${t.percent}%${!t.paused && !ofFile && t.speed ? ` · ${formatSize(t.speed)}/s` : ""}`);
  bar.classList.toggle("paused", !!t.paused);
  const [pause, cancel] = bar.querySelectorAll(".cancel");
  putIcon(pause, t.paused ? "l:play" : "l:pause");
  put(pause, "title", t.paused ? "Resume" : "Pause");
  put(cancel, "title", `Stop ${t.op === "move" ? "moving" : "copying"} (what's done stays; ↻ on the folder resumes it)`);
}

// A bar in the sidebar's Transfers: just the percentage (paused or stopped: its buttons and tooltip say), so it fits.
const inSidebar = (bar) => !!bar.closest(".transfer-row");

function showStoppedBar(bar, e) {
  const c = e.copying;
  put(bar.querySelector(".fill").style, "width", `${c.percent}%`);
  if (c.file) { // a file cut off mid-copy (it has its name): ↻ on the folder goes on with it
    put(bar, "title", `${c.op === "move" ? "Moving" : "Copying"} it from ${c.from} stopped ${c.percent}% of the way in, ${formatDate(c.updated)}: ↻ on the folder it's in resumes it`);
    put(bar.querySelector(".pct"), "textContent", inSidebar(bar) ? `${c.percent}%` : `Cut off at ${c.percent}%`);
    return;
  }
  put(bar, "title", `${c.op === "move" ? "Moving" : "Copying"} it from ${c.from} stopped at ${c.percent}% (${formatSize(c.bytes)} of ${formatSize(c.total)}), ${formatDate(c.updated)}`);
  put(bar.querySelector(".pct"), "textContent", inSidebar(bar) ? `${c.percent}%` : `Stopped at ${c.percent}%`);
  put(bar.querySelector(".cancel"), "title", `Resume ${c.op === "move" ? "moving" : "copying"} (what's there is skipped)`);
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
    if (filterInput.value) e.preventDefault(); // (cleared: that's all; empty, a chooser's Esc cancels)
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
// Which terminal it shows changed: the sidebar's Processes mark it.
terminal.onSession = () => renderProcesses();

// Reopen the panel on startup if it was open when phil last quit, and select
// files phil was started with (both set at startup, applied after the first load).
let restoreTerminal = false, startCovered = false;
let initialSelect = null;

function setTerminalOpen(open, { focus = true } = {}) {
  if (open) terminal.show(state.path, { focus });
  else terminal.hide(), setTerminalCover(false), (scriptRun = null);
  terminalShown(open);
  // Closed: the keyboard back to the folder view, or to the app shown over it.
  if (!open) (appView.hidden ? grid : appView.querySelector("iframe") ?? grid).focus({ preventScroll: true });
}

// The panel open or closed: its button, and the setting (it's opened again in the next window).
function terminalShown(open) {
  $("#btn-terminal").setAttribute("aria-pressed", String(open));
  document.body.classList.toggle("term-over-app", open && !appView.hidden);
  if (state.settings.termOpen !== open) {
    state.settings.termOpen = open;
    saveSettings(0); // right away: quitting is often the next thing that happens
  }
}

function toggleTerminal() {
  // Open, but under an app shown since: over it now.
  if (terminal.isOpen && !appView.hidden && !document.body.classList.contains("term-over-app")) return setTerminalOpen(true);
  setTerminalOpen(!terminal.isOpen);
}

const inTerminal = () => !!document.activeElement?.closest?.("#term-panel");

// Super+°: the terminal's shell, and what runs in it, into the background (the
// sidebar's Processes; a click there shows it again); the panel closes, its
// next shell a new one.
async function backgroundTerminal() {
  if (!terminal.isRunning) return flashStatus("No terminal to put in the background");
  if (!(await terminal.background())) return flashStatus("Terminals don't go to the background in incognito windows");
  setTerminalOpen(false);
  flashStatus("The terminal is in the background: the sidebar's Processes show it");
}

// A terminal in the background (one of the sidebar's Processes), in the panel again.
async function showBackgroundTerminal(id) {
  await terminal.restore(id, state.path);
  terminalShown(true);
}

// Ctrl+Tab / Ctrl+Shift+Tab, Alt+1…9 (switchKey): the terminal the panel shows, opening it.
// 1: the panel's own shell (a new one in the folder shown, when it's showing one of the
// others); 2 on: those in the background, in the order they went there (the sidebar's).
async function switchTerminal(which) {
  const slots = [null, ...(state.processes ?? []).filter((p) => p.kind === "terminal").map((p) => p.term)];
  let slot = which - 1;
  if (typeof which !== "number") {
    if (slots.length < 2) return flashStatus("No terminals in the background (Super+° puts the terminal there)");
    const at = terminal.kept ? Math.max(0, slots.indexOf(terminal.session)) : 0;
    slot = (at + (which === "next" ? 1 : -1) + slots.length) % slots.length;
  }
  if (slot >= slots.length) return flashStatus(slots.length > 1 ? `Alt+2 to Alt+${slots.length}: the terminals in the background` : "No terminals in the background (Super+° puts the terminal there)");
  await terminal.restore(slots[slot], state.path);
  terminalShown(true);
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
  terminal.showMain(); // (in the panel's own shell, one from the background shown or not)
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

// Keys in the terminal phil takes: Esc ends a double-clicked script's run, or
// closes the panel at the shell's prompt (a program running there, vim, less,
// gets it); Ctrl+F toggles covering the window.
function terminalKey(e) {
  const plainEsc = e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
  if (plainEsc && scriptRun) return endScriptRun(), true;
  if (plainEsc && !terminal.busy) return setTerminalOpen(false), true;
  if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.key.toLowerCase() === "f") {
    return setTerminalCover(!document.body.classList.contains("term-cover")), true;
  }
  return false;
}

// Capture phase, so these work while the terminal has focus too: F4 / Ctrl+`
// toggle the panel, Alt+↓ / Alt+↑ move focus to the terminal (opening it) / the
// folder view.
document.addEventListener("keydown", (e) => {
  // The terminal's keys, wherever the keyboard is (an app shown here too: the terminal over it).
  if ((isToggleKey(e) || isBackgroundKey(e) || switchKey(e) !== null) && !dialogOpen()) {
    if (isToggleKey(e)) toggleTerminal();
    else if (isBackgroundKey(e)) backgroundTerminal();
    else switchTerminal(switchKey(e));
    return e.preventDefault(), e.stopPropagation();
  }
  if (!appView.hidden && e.key === "Escape" && !inTerminal()) return askAppToClose(), e.preventDefault(), e.stopPropagation();
  // Esc closes the Transfers view, wherever the keyboard is (not a menu or dialog over it).
  if (!transfersView.hidden && e.key === "Escape" && contextMenu.hidden && !dialogOpen()) return closeTransfersView(), e.preventDefault(), e.stopPropagation();
  if (!prefsView.hidden && e.key === "Escape" && contextMenu.hidden && !dialogOpen()) return closePrefsView(), e.preventDefault(), e.stopPropagation();
  if (!appView.hidden || dialogOpen()) return;
  if (isFocusKey(e) && e.key === "ArrowDown") setTerminalOpen(true);
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

  if (e.altKey && e.key === "ArrowLeft") return history.back(), handled();
  if (e.altKey && e.key === "ArrowRight") return history.forward(), handled();
  if ((e.key === "Backspace" || (e.key === "Escape" && !choosing)) && e.target === grid) return $("#btn-up").click(), handled(); // (a chooser's Esc: cancelled)
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
  if (e.key === "F5" || (ctrl && e.key === "r")) return load(state.path, { recount: true }), handled();

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

// The page is styled and running: the engine notes when (PHIL_TRACE).
ready(JSON.stringify({ script: Math.round(performance.now()) }));
state.init = await api("/api/init");
Object.assign(state.settings, state.init.settings);
// A file chooser: its own settings over phil's, hidden files hidden (whatever phil shows).
if (choosing) Object.assign(state.settings, Object.fromEntries(CHOOSER_SETTINGS.filter((k) => k in (state.init.settings.chooser ?? {})).map((k) => [k, state.init.settings.chooser[k]])), { showHidden: false });
applySettings();
renderPlaces(); // once: after this, only when the places change (their space and speeds update in place)
refreshSpeeds(); // the drives' last speed tests, for their tooltips
loadCameras(); // the network cameras found so far (looked for again with the sidebar's refresh button)
thumbs.connect();

// (--terminal: the terminal covering the window, the keyboard in it.)
startCovered = new URLSearchParams(location.search).get("terminal") === "1" && !choosing;
restoreTerminal = state.settings.termOpen && !startCovered && !choosing; // (a file chooser: just the folder)
if (startCovered) {
  // At once, in the folder asked for (not after its listing: the file view would show first).
  const at = decodeURIComponent(location.hash.slice(1)) || state.init.home;
  setTerminalCover(true);
  terminal.show(at, { focus: true }).then(() => requestAnimationFrame(() => document.documentElement.classList.remove("term-start")));
  terminalShown(true);
}
// Files to select, from ?select= (phil file..., "Show in folder"); dropped from
// the URL so they aren't reselected later.
const selectParams = new URLSearchParams(location.search).getAll("select");
const transferParam = new URLSearchParams(location.search).get("transfer"); // (mediaview's: a download in the Transfers view)
initialSelect = selectParams.length ? selectParams : null;
if (location.search) history.replaceState(null, "", location.pathname + location.hash);
document.body.classList.toggle("incognito", state.init.incognito);
// (The Transfers view after the first folder's opened: opening one closes it.)
if (transferParam && location.hash.length > 1) setTimeout(() => openTransfersView(transferParam));
else if (transferParam) addEventListener("hashchange", () => setTimeout(() => openTransfersView(transferParam)), { once: true });
if (location.hash.length > 1) load(decodeURIComponent(location.hash.slice(1)));
else navigate(state.init.start);
holdFocus(grid);
