import { closeWindow, copyText, embedded, holdFocus, onCloseRequest, ready } from "../engine/ui/kit.js";

const $ = (sel) => document.querySelector(sel);
const stage = $("#stage");
const img = $("#img");
const message = $("#message");

// How the image meets the window, switched with Z:
//   fit       its height or its width fills the window, whichever shows all of it
//   fill      the other one: it fills the window, cropping what sticks out
//   original  one image pixel to a screen pixel
// + and − zoom from there (`zoom`, until Z or 0).
const MODES = ["fit", "fill", "original"];
const ZOOM_STEP = 1.25;
const MAX_ZOOM = 32; // × original

const state = {
  images: [], // {path, name, size, mtime}
  index: -1,
  mode: load("mode", "fit"),
  zoom: null, // a scale of its own (+ / −), or null: the mode's
  width: 0, // the image's own size
  height: 0,
  token: 0, // the image being loaded; earlier loads finishing late are ignored
};

// ---------------------------------------------------------------- scale

// CSS pixels per image pixel for `mode`, in the window as it is now.
function modeScale(mode) {
  const sx = stage.clientWidth / state.width, sy = stage.clientHeight / state.height;
  if (mode === "fit") return Math.min(sx, sy);
  if (mode === "fill") return Math.max(sx, sy);
  return 1 / devicePixelRatio;
}

const scale = () => state.zoom ?? modeScale(state.mode);

// Lays the image out at the current scale, keeping the point of it at `focus`
// (window coordinates; default the middle) where it is.
function layout(focus = null) {
  if (!state.width) return;
  const f = focus ?? { x: stage.clientWidth / 2, y: stage.clientHeight / 2 };
  const before = img.getBoundingClientRect();
  const u = before.width ? (f.x - before.left) / before.width : 0.5;
  const v = before.height ? (f.y - before.top) / before.height : 0.5;
  const s = scale();
  img.style.width = `${state.width * s}px`;
  img.style.height = `${state.height * s}px`;
  img.classList.toggle("pixels", s * devicePixelRatio >= 4);
  const after = img.getBoundingClientRect();
  stage.scrollLeft += after.left + u * after.width - f.x;
  stage.scrollTop += after.top + v * after.height - f.y;
  showScale();
}

function showScale() {
  const s = scale();
  const sx = stage.clientWidth / state.width, sy = stage.clientHeight / state.height;
  // Which side meets the window: the one the scale came from.
  const side = Math.abs(s - sx) <= Math.abs(s - sy) ? "width" : "height";
  $("#btn-mode").textContent = state.zoom !== null ? "Zoomed" : state.mode === "original" ? "Original" : `Fit ${side}`;
  $("#btn-mode").title = (state.mode === "fill" && state.zoom === null ? "Cropped to fill the window. " : "") +
    "Fit the height, the width, or the original size (Z)";
  $("#btn-zoom").textContent = `${Math.round(s * devicePixelRatio * 100)}%`;
  const pannable = stage.scrollWidth > stage.clientWidth + 1 || stage.scrollHeight > stage.clientHeight + 1;
  stage.classList.toggle("pannable", pannable);
}

// Z: the next mode whose scale differs from what's shown (an image shaped like
// the window fits and fills the same way).
function nextMode(dir = 1) {
  if (!state.width) return;
  const now = scale();
  let i = MODES.indexOf(state.mode);
  for (let n = 0; n < MODES.length; n++) {
    i = (i + dir + MODES.length) % MODES.length;
    if (Math.abs(modeScale(MODES[i]) / now - 1) > 0.005) break;
  }
  state.mode = MODES[i];
  state.zoom = null;
  save("mode", state.mode);
  layout();
}

function zoomBy(factor, focus) {
  if (!state.width) return;
  const min = Math.min(modeScale("fit"), 1 / devicePixelRatio) / 4;
  state.zoom = Math.min(MAX_ZOOM / devicePixelRatio, Math.max(min, scale() * factor));
  layout(focus);
}

function resetZoom() {
  state.zoom = null;
  layout();
}

// ---------------------------------------------------------------- images

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json();
}

const fileUrl = (path) => `file?path=${encodeURIComponent(path)}`;

async function show(index) {
  const entry = state.images[index];
  if (!entry) return;
  state.index = index;
  const token = ++state.token;
  $("#name").textContent = entry.name;
  $("#count").textContent = state.images.length > 1 ? `${index + 1} / ${state.images.length}` : "";
  $("#info").textContent = "";
  document.title = entry.name;
  $("#prev").disabled = index === 0;
  $("#next").disabled = index === state.images.length - 1;
  if (embedded) parent.postMessage({ app: "imageview", showing: entry.path }, "*"); // phil selects it

  // Decoded before it's swapped in, so the previous one stays until then.
  // What the webview can't decode (HEIC, TIFF, ...) is converted by the server.
  const next = new Image();
  let loaded = false;
  for (const src of [fileUrl(entry.path), `preview?path=${encodeURIComponent(entry.path)}&size=${previewSize()}`]) {
    next.src = src;
    try {
      await next.decode();
      loaded = true;
      break;
    } catch { /* try the next way */ }
  }
  if (token !== state.token) return;
  if (!loaded) {
    img.hidden = true;
    state.width = 0;
    showMessage(`Can't show ${entry.name}.`);
    return;
  }
  message.hidden = true;
  // An SVG without a size of its own: as large as the window.
  state.width = next.naturalWidth || stage.clientWidth;
  state.height = next.naturalHeight || stage.clientHeight;
  state.zoom = null;
  img.src = next.src;
  img.hidden = false;
  img.style.width = img.style.height = "0";
  layout();
  // A new image starts at its top, in the middle across.
  stage.scrollTop = 0;
  stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
  $("#info").textContent = `${state.width} × ${state.height}   ·   ${formatSize(entry.size)}   ·   ${formatDate(entry.mtime)}`;
  preload(index + 1);
  preload(index - 1);
}

const previewSize = () => Math.round(Math.max(screen.width, screen.height) * devicePixelRatio);

function preload(index) {
  const entry = state.images[index];
  if (entry) new Image().src = fileUrl(entry.path);
}

function step(dir) {
  const i = state.index + dir;
  if (i >= 0 && i < state.images.length) show(i);
}

function showMessage(text) {
  message.textContent = text;
  message.hidden = false;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes, i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

const formatDate = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

// ---------------------------------------------------------------- the rest

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

function close() {
  if (document.fullscreenElement) document.exitFullscreen();
  closeWindow();
}

// Remembered between images and windows (the mode), where storage works.
function load(key, fallback) {
  try {
    return localStorage.getItem(`imageview.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(`imageview.${key}`, value);
  } catch { /* not kept */ }
}

const overflows = (axis) => axis === "x" ? stage.scrollWidth > stage.clientWidth + 1 : stage.scrollHeight > stage.clientHeight + 1;

// ←/→ scroll an image wider than the window, or go to the previous / next
// one; ↑/↓ scroll a taller one. Shift: a screenful.
function arrow(e) {
  const x = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
  const y = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
  if (x && !overflows("x")) return step(x);
  const amount = e.shiftKey ? 0.85 : 0.15;
  stage.scrollBy({ left: x * stage.clientWidth * amount, top: y * stage.clientHeight * amount, behavior: e.repeat ? "auto" : "smooth" });
}

document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.altKey) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const handled = () => e.preventDefault();
  if (ctrl) {
    if (key === "c") return copyText(state.images[state.index]?.path ?? ""), handled();
    if (key === "=" || key === "+") return zoomBy(ZOOM_STEP), handled();
    if (key === "-") return zoomBy(1 / ZOOM_STEP), handled();
    if (key === "0") return resetZoom(), handled();
    if (key === "w") return close(), handled();
    return;
  }
  if (key.startsWith("Arrow")) return arrow(e), handled();
  if (key === "z") return nextMode(e.shiftKey ? -1 : 1), handled();
  if (key === "f") return toggleFullscreen(), handled();
  if (key === "+" || key === "=") return zoomBy(ZOOM_STEP), handled();
  if (key === "-") return zoomBy(1 / ZOOM_STEP), handled();
  if (key === "0") return resetZoom(), handled();
  if (key === "PageDown" || (key === " " && !e.shiftKey)) return step(1), handled();
  if (key === "PageUp" || key === "Backspace" || (key === " " && e.shiftKey)) return step(-1), handled();
  if (key === "Home") return show(0), handled();
  if (key === "End") return show(state.images.length - 1), handled();
  if (key === "Escape" || key === "q") {
    if (document.fullscreenElement) document.exitFullscreen();
    else close();
    return handled();
  }
});

// Ctrl+wheel zooms at the pointer; the wheel alone scrolls (sideways when
// only that way is left to scroll).
stage.addEventListener("wheel", (e) => {
  if (e.ctrlKey) {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, { x: e.clientX, y: e.clientY });
  } else if (!overflows("y") && overflows("x") && !e.deltaX) {
    e.preventDefault();
    stage.scrollLeft += e.deltaY;
  }
}, { passive: false });

// Dragging moves the image around.
stage.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !stage.classList.contains("pannable")) return;
  const start = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
  stage.setPointerCapture(e.pointerId);
  stage.classList.add("panning");
  const move = (ev) => {
    stage.scrollLeft = start.left - (ev.clientX - start.x);
    stage.scrollTop = start.top - (ev.clientY - start.y);
  };
  stage.addEventListener("pointermove", move);
  stage.addEventListener("pointerup", () => {
    stage.removeEventListener("pointermove", move);
    stage.classList.remove("panning");
  }, { once: true });
});

// Double-click: the original size at that spot, and back.
stage.addEventListener("dblclick", (e) => {
  if (!state.width) return;
  const original = 1 / devicePixelRatio;
  if (Math.abs(scale() / original - 1) < 0.005) state.zoom = null;
  else state.zoom = original;
  if (state.zoom === null && state.mode === "original") state.mode = "fit";
  layout({ x: e.clientX, y: e.clientY });
});

new ResizeObserver(() => layout()).observe(stage);

$("#btn-mode").onclick = () => nextMode();
$("#btn-in").onclick = () => zoomBy(ZOOM_STEP);
$("#btn-out").onclick = () => zoomBy(1 / ZOOM_STEP);
$("#btn-zoom").onclick = resetZoom;
$("#btn-full").onclick = toggleFullscreen;
$("#btn-close").onclick = close;
$("#prev").onclick = () => step(-1);
$("#next").onclick = () => step(1);
for (const b of document.querySelectorAll("button")) b.addEventListener("mouseup", () => stage.focus({ preventScroll: true }));
onCloseRequest(close);
holdFocus(stage);

// ---------------------------------------------------------------- start

const params = new URLSearchParams(location.search);
const file = params.get("file");
if (!file) {
  showMessage("No image. Open one with: imageview <file or folder>");
} else {
  try {
    const listing = await api(`api/images?path=${encodeURIComponent(file)}&sort=${params.get("sort") ?? "name"}`);
    state.images = listing.images;
    if (!state.images.length) showMessage(`No images in ${listing.dir}`);
    else await show(listing.index);
  } catch (err) {
    showMessage(err.message);
  }
}
ready(); // with the image shown: the window appears (or, inside phil, gets the keyboard)
