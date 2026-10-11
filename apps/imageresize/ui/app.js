import { closeWindow, holdFocus, onCloseRequest, ready } from "../engine/ui/kit.js";

const $ = (sel) => document.querySelector(sel);
const view = $("#view"), frame = $("#frame"), cropEl = $("#crop"), resultImg = $("#result");

// Size presets. box: exactly w × h (cropped to its shape, or fitted inside it);
// long: the longer side n pixels; scale: a fraction; original: as it is.
const PRESETS = [
  { group: "", items: [{ id: "original", label: "Original size", kind: "original" }] },
  { group: "Screens", items: [] }, // this computer's monitors first (start())
  { group: "Screens", items: [
    { id: "uhd", label: "4K UHD · 3840 × 2160", kind: "box", w: 3840, h: 2160 },
    { id: "uw1440", label: "Ultrawide 1440p · 3440 × 1440", kind: "box", w: 3440, h: 1440 },
    { id: "qhd", label: "1440p · 2560 × 1440", kind: "box", w: 2560, h: 1440 },
    { id: "fhd", label: "1080p · 1920 × 1080", kind: "box", w: 1920, h: 1080 },
    { id: "hd", label: "720p · 1280 × 720", kind: "box", w: 1280, h: 720 },
  ] },
  { group: "Web & social", items: [
    { id: "square", label: "Square post · 1080 × 1080", kind: "box", w: 1080, h: 1080 },
    { id: "portrait", label: "Portrait post 4:5 · 1080 × 1350", kind: "box", w: 1080, h: 1350 },
    { id: "story", label: "Story / reel 9:16 · 1080 × 1920", kind: "box", w: 1080, h: 1920 },
    { id: "og", label: "Link preview · 1200 × 630", kind: "box", w: 1200, h: 630 },
    { id: "yt", label: "Video thumbnail · 1280 × 720", kind: "box", w: 1280, h: 720 },
    { id: "avatar", label: "Avatar · 512 × 512", kind: "box", w: 512, h: 512 },
  ] },
  { group: "Longest side", items: [3840, 2560, 2048, 1600, 1280, 1024, 800, 512].map((n) => ({ id: `long${n}`, label: `${n} px`, kind: "long", n })) },
  { group: "Percent", items: [75, 50, 33, 25].map((p) => ({ id: `pct${p}`, label: `${p}%`, kind: "scale", s: p / 100 })) },
  { group: "", items: [{ id: "custom", label: "Your own size", kind: "box", custom: true }] },
];
const presetById = (id) => PRESETS.flatMap((g) => g.items).find((p) => p.id === id);

const S = {
  info: null, // {path, name, dir, width, height, size, format, monitors}
  preset: "original",
  custom: { w: 0, h: 0 }, // "Your own size"
  lock: true,
  fit: "fill",
  enlarge: false,
  aspect: "free",
  crop: null, // {x, y, width, height} in the picture's pixels
  format: "jpeg",
  by: "quality",
  quality: 82,
  targetKB: 500,
  progressive: true,
  metadata: false,
  show: "crop",
  destEdited: false,
  result: null, // {url, bytes, width, height, quality}
};

// ---------------------------------------------------------------- the math

const preset = () => presetById(S.preset);
const box = () => { // the w × h a box preset (or your own size) asks for
  const p = preset();
  return p.kind !== "box" ? null : p.custom ? S.custom : { w: p.w, h: p.h };
};
const filling = () => !!box() && S.fit === "fill";

// The crop's shape: a filling box's, or the one picked (null: any).
function aspect() {
  if (filling()) return box().w / box().h;
  if (S.aspect === "free") return null;
  if (S.aspect === "original") return S.info.width / S.info.height;
  const [a, b] = S.aspect.split(":").map(Number);
  return a / b;
}

// The output's size for the crop: a box filled is exactly its size; the rest
// are only made larger with "Enlarge if smaller".
function outputSize() {
  const c = S.crop, p = preset();
  let s = 1;
  if (p.kind === "box") {
    const { w, h } = box();
    if (S.fit === "fill") return { width: w, height: h };
    s = Math.min(w / c.width, h / c.height);
  } else if (p.kind === "long") s = p.n / Math.max(c.width, c.height);
  else if (p.kind === "scale") s = p.s;
  if (!S.enlarge) s = Math.min(1, s);
  return round(c, s);
}
const round = (c, s) => ({ width: Math.max(1, Math.round(c.width * s)), height: Math.max(1, Math.round(c.height * s)) });

// The largest box of shape `a` in the middle of the picture (all of it for none).
function centeredCrop(a) {
  const { width: W, height: H } = S.info;
  if (!a) return { x: 0, y: 0, width: W, height: H };
  const w = W / H > a ? Math.round(H * a) : W, h = W / H > a ? H : Math.round(W / a);
  return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), width: w, height: h };
}

// Called after anything that can change the crop's shape: a crop that has
// another shape now is replaced by the largest one in the middle.
function fitCrop() {
  const a = aspect();
  if (!S.crop || (a && Math.abs(S.crop.width / S.crop.height - a) > 0.01)) S.crop = centeredCrop(a);
}

// ---------------------------------------------------------------- the crop box

let k = 1; // screen pixels per picture pixel

function layoutFrame() {
  if (!S.info) return;
  const pad = 24, top = 44; // under the bar
  const availW = view.clientWidth - pad * 2, availH = view.clientHeight - top - pad;
  k = Math.min(availW / S.info.width, availH / S.info.height);
  const w = S.info.width * k, h = S.info.height * k;
  Object.assign(frame.style, { width: `${w}px`, height: `${h}px`, left: `${(view.clientWidth - w) / 2}px`, top: `${top + (availH - h) / 2}px` });
  if (S.crop) drawCrop();
}

function drawCrop() {
  const c = S.crop;
  const place = { left: `${c.x * k}px`, top: `${c.y * k}px`, width: `${c.width * k}px`, height: `${c.height * k}px` };
  Object.assign(cropEl.style, place);
  Object.assign($("#hole").style, place);
  $("#crop-size").textContent = `${c.width} × ${c.height}`;
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

// Dragging the box (move) or a handle (n, ne, e, ... : those sides move),
// keeping the shape when there is one: the opposite side or corner stays put
// (the middle, for a side's handle), and it shrinks to stay in the picture.
function dragCrop(start, dir, dx, dy) {
  const { width: W, height: H } = S.info, MIN = 8;
  if (dir === "move") return { ...start, x: clamp(start.x + dx, 0, W - start.width), y: clamp(start.y + dy, 0, H - start.height) };
  let l = start.x, t = start.y, r = start.x + start.width, b = start.y + start.height;
  if (dir.includes("w")) l = clamp(l + dx, 0, r - MIN);
  if (dir.includes("e")) r = clamp(r + dx, l + MIN, W);
  if (dir.includes("n")) t = clamp(t + dy, 0, b - MIN);
  if (dir.includes("s")) b = clamp(b + dy, t + MIN, H);
  const a = aspect();
  if (!a) return { x: l, y: t, width: r - l, height: b - t };
  let w = r - l, h = b - t;
  if (dir === "e" || dir === "w") h = w / a;
  else if (dir === "n" || dir === "s") w = h * a;
  else if (w / h > a) h = w / a;
  else w = h * a;
  const cx = start.x + start.width / 2, cy = start.y + start.height / 2;
  const right = start.x + start.width, bottom = start.y + start.height;
  const roomX = dir.includes("w") ? right : dir.includes("e") ? W - start.x : 2 * Math.min(cx, W - cx);
  const roomY = dir.includes("n") ? bottom : dir.includes("s") ? H - start.y : 2 * Math.min(cy, H - cy);
  const f = Math.min(1, roomX / w, roomY / h);
  w *= f;
  h *= f;
  const x = dir.includes("w") ? right - w : dir.includes("e") ? start.x : cx - w / 2;
  const y = dir.includes("n") ? bottom - h : dir.includes("s") ? start.y : cy - h / 2;
  return { x, y, width: w, height: h };
}

cropEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const dir = e.target.dataset.drag ?? "move";
  const start = { ...S.crop }, x0 = e.clientX, y0 = e.clientY;
  cropEl.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const c = dragCrop(start, dir, (ev.clientX - x0) / k, (ev.clientY - y0) / k);
    S.crop = { x: Math.round(c.x), y: Math.round(c.y), width: Math.round(c.width), height: Math.round(c.height) };
    drawCrop();
    update({ render: false });
  };
  cropEl.addEventListener("pointermove", move);
  cropEl.addEventListener("pointerup", () => {
    cropEl.removeEventListener("pointermove", move);
    update();
  }, { once: true });
});

// ---------------------------------------------------------------- the settings

function fillPresets() {
  const select = $("#preset");
  select.replaceChildren();
  let group = null;
  for (const g of PRESETS) {
    if (!g.items.length) continue;
    if (!g.group) group = select;
    else if (group?.label !== g.group) group = select.appendChild(Object.assign(document.createElement("optgroup"), { label: g.group }));
    for (const p of g.items) group.append(new Option(p.label, p.id));
  }
}

// Everything shown from S; then a new result, unless `render` is false (while
// dragging) — it's rendered when the dragging ends.
function update({ render = true } = {}) {
  if (!S.info) return; // it didn't load
  fitCrop();
  const out = outputSize(), p = preset();
  $("#preset").value = S.preset;
  if (document.activeElement !== $("#w")) $("#w").value = out.width;
  if (document.activeElement !== $("#h")) $("#h").value = out.height;
  $("#lock").classList.toggle("on", S.lock);
  for (const b of document.querySelectorAll("#fit button")) b.classList.toggle("on", b.dataset.fit === S.fit);
  $("#fit").classList.toggle("unused", p.kind !== "box");
  $("#enlarge").checked = S.enlarge;
  $("#enlarge").parentElement.hidden = p.kind === "original" || filling();
  $("#aspect").value = S.aspect;
  $("#aspect").disabled = filling();
  $("#crop-hint").textContent = filling() ? `Shaped like ${box().w} × ${box().h}. Drag the box, or its edges and corners.` : "Drag the box, or its edges and corners.";
  for (const b of document.querySelectorAll("#format button")) b.classList.toggle("on", b.dataset.format === S.format);
  for (const b of document.querySelectorAll("#by button")) b.classList.toggle("on", b.dataset.by === S.by);
  document.querySelector(".lossy").hidden = S.format === "png";
  $("#quality-row").hidden = S.by !== "quality";
  $("#size-row").hidden = S.by !== "size";
  $("#quality").value = S.quality;
  $("#quality-out").textContent = S.quality;
  document.querySelector(".jpeg-only").hidden = S.format !== "jpeg";
  $("#progressive").checked = S.progressive;
  $("#metadata").checked = S.metadata;
  if (!S.destEdited) $("#dest").value = defaultName(out);
  for (const b of document.querySelectorAll("#show button")) b.classList.toggle("on", b.dataset.show === S.show);
  frame.hidden = S.show !== "crop";
  resultImg.hidden = S.show !== "result" || !S.result;
  drawCrop();
  showOutcome(out);
  if (render) scheduleRender();
}

const EXT = { jpeg: "jpg", webp: "webp", png: "png" };

function defaultName({ width, height }) {
  const stem = S.info.name.replace(/\.[^.]+$/, "");
  const sameSize = width === S.info.width && height === S.info.height;
  return `${stem}-${sameSize ? "small" : `${width}x${height}`}.${EXT[S.format]}`;
}

function showOutcome(out) {
  const r = S.result;
  const main = $("#out-main"), detail = $("#out-detail");
  if (!r) {
    main.textContent = `${out.width} × ${out.height}`;
    detail.textContent = "…";
    return;
  }
  const change = r.bytes / S.info.size - 1;
  main.innerHTML = "";
  main.append(`${formatSize(r.bytes)} `);
  const pct = Object.assign(document.createElement("span"), { textContent: `${change <= 0 ? "−" : "+"}${Math.abs(Math.round(change * 100))}%` });
  if (change < 0) pct.className = "smaller";
  main.append(pct);
  detail.textContent = `${r.width} × ${r.height}${r.quality ? ` · quality ${r.quality}` : ""} · was ${formatSize(S.info.size)}, ${S.info.width} × ${S.info.height}`;
}

function job() {
  const out = outputSize();
  return {
    path: S.info.path,
    crop: S.crop,
    width: out.width,
    height: out.height,
    format: S.format,
    quality: S.quality,
    targetKB: S.format !== "png" && S.by === "size" ? S.targetKB : null,
    progressive: S.progressive,
    keepMetadata: S.metadata,
  };
}

let renderTimer = null, renderToken = 0;
function scheduleRender() {
  clearTimeout(renderTimer);
  $("#outcome").classList.add("busy");
  renderTimer = setTimeout(renderNow, 250);
}

async function renderNow() {
  const token = ++renderToken;
  try {
    const res = await fetch("api/render", { method: "POST", body: JSON.stringify(job()) });
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    if (token !== renderToken) return;
    if (S.result) URL.revokeObjectURL(S.result.url);
    S.result = {
      url: URL.createObjectURL(blob),
      bytes: blob.size,
      width: Number(res.headers.get("x-width")),
      height: Number(res.headers.get("x-height")),
      quality: Number(res.headers.get("x-quality")) || null,
    };
    resultImg.src = S.result.url;
    $("#outcome").classList.remove("busy");
    update({ render: false });
  } catch (err) {
    if (token !== renderToken) return;
    $("#outcome").classList.remove("busy");
    $("#out-detail").textContent = err.message;
  }
}

async function save(overwrite = false) {
  const name = $("#dest").value.trim();
  if (!name) return $("#dest").focus();
  const dest = name.startsWith("/") ? name : `${S.info.dir}/${name}`;
  const saved = $("#saved");
  saved.hidden = true;
  if (dest === S.info.path && !overwrite && !confirm(`Replace the original, ${S.info.name}?`)) return;
  try {
    const res = await fetch("api/save", { method: "POST", body: JSON.stringify({ ...job(), dest, overwrite: overwrite || dest === S.info.path }) });
    if (res.status === 409 && !overwrite) {
      if (confirm(`${await res.text()}. Replace it?`)) return save(true);
      return;
    }
    if (!res.ok) throw new Error(await res.text());
    const r = await res.json();
    saved.className = "";
    saved.textContent = `Saved ${r.path.split("/").pop()}: ${formatSize(r.bytes)}, ${r.width} × ${r.height}`;
  } catch (err) {
    saved.className = "failed";
    saved.textContent = `Couldn't save: ${err.message}`;
  }
  saved.hidden = false;
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

// ---------------------------------------------------------------- controls

$("#preset").onchange = (e) => {
  if (!presetById(e.target.value)) return;
  S.preset = e.target.value;
  if (S.preset === "custom") S.custom = { w: Number($("#w").value), h: Number($("#h").value) };
  S.crop = null;
  update();
};

// Typing a size makes it your own; with the lock, the other side follows
// the crop's shape.
function sizeTyped(side) {
  const w = Number($("#w").value), h = Number($("#h").value);
  if (!(w > 0 && h > 0)) return;
  const shape = S.crop.width / S.crop.height;
  S.custom = !S.lock ? { w, h } : side === "w" ? { w, h: Math.round(w / shape) } : { w: Math.round(h * shape), h };
  S.preset = "custom";
  update();
}
$("#w").oninput = () => sizeTyped("w");
$("#h").oninput = () => sizeTyped("h");
$("#w").onchange = $("#h").onchange = () => update();
$("#lock").onclick = () => ((S.lock = !S.lock), update({ render: false }));
for (const b of document.querySelectorAll("#fit button")) b.onclick = () => ((S.fit = b.dataset.fit), (S.crop = null), update());
$("#enlarge").onchange = (e) => ((S.enlarge = e.target.checked), update());
$("#aspect").onchange = (e) => ((S.aspect = e.target.value), (S.crop = null), update());
$("#crop-all").onclick = () => {
  if (filling()) S.fit = "inside"; // the whole picture can't be cropped to the box's shape
  S.aspect = "free";
  S.crop = null;
  update();
};
for (const b of document.querySelectorAll("#format button")) b.onclick = () => ((S.format = b.dataset.format), update());
for (const b of document.querySelectorAll("#by button")) b.onclick = () => ((S.by = b.dataset.by), update());
$("#quality").oninput = (e) => ((S.quality = Number(e.target.value)), update());
$("#target").oninput = (e) => {
  if (Number(e.target.value) > 0) (S.targetKB = Number(e.target.value)), update();
};
$("#progressive").onchange = (e) => ((S.progressive = e.target.checked), update());
$("#metadata").onchange = (e) => ((S.metadata = e.target.checked), update());
$("#dest").oninput = () => (S.destEdited = true);
$("#dest").onkeydown = (e) => e.key === "Enter" && save();
$("#save").onclick = () => save();
for (const b of document.querySelectorAll("#show button")) b.onclick = () => ((S.show = b.dataset.show), update({ render: false }));
resultImg.onclick = () => resultImg.classList.toggle("actual"); // its actual pixels, to judge the compression
$("#btn-close").onclick = closeWindow;
onCloseRequest(closeWindow);

document.addEventListener("keydown", (e) => {
  const typing = e.target.matches?.("input[type=text], input[type=number]");
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") return e.preventDefault(), save();
  if (e.key === "Escape") return e.preventDefault(), closeWindow();
  if (!typing && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "v") {
    S.show = S.show === "crop" ? "result" : "crop";
    update({ render: false });
  }
});

new ResizeObserver(layoutFrame).observe(view);
holdFocus(view);

// ---------------------------------------------------------------- start

const file = new URLSearchParams(location.search).get("file");
try {
  if (!file) throw new Error("No image. Open one with: imageresize <file>");
  const res = await fetch(`api/info?path=${encodeURIComponent(file)}`);
  if (!res.ok) throw new Error(await res.text());
  S.info = await res.json();
  S.format = S.info.format === "png" || S.info.format === "webp" ? S.info.format : "jpeg";
  // This computer's monitors (Hyprland's; elsewhere, this screen), and the
  // screen sizes that aren't one of them.
  if (!S.info.monitors.length) {
    S.info.monitors = [{ name: "", width: Math.round(screen.width * devicePixelRatio), height: Math.round(screen.height * devicePixelRatio) }];
  }
  const isMonitor = (p) => S.info.monitors.some((m) => m.width === p.w && m.height === p.h);
  PRESETS[2].items = PRESETS[2].items.filter((p) => !isMonitor(p));
  PRESETS[1].items = S.info.monitors.map((m, i) => ({
    id: `monitor${i}`,
    label: `This monitor${S.info.monitors.length > 1 ? ` (${m.name})` : ""} · ${m.width} × ${m.height}`,
    kind: "box",
    w: m.width,
    h: m.height,
  }));
  fillPresets();
  $("#name").textContent = S.info.name;
  $("#orig").textContent = `${S.info.width} × ${S.info.height} · ${formatSize(S.info.size)}`;
  document.title = `Resize ${S.info.name}`;
  $("#dest-dir").textContent = `In ${S.info.dir} (or a full path)`;
  const src = $("#src");
  src.src = `api/source?path=${encodeURIComponent(file)}`;
  await src.decode().catch(() => {});
  frame.hidden = false;
  layoutFrame();
  update();
} catch (err) {
  $("#message").textContent = err.message;
  $("#message").hidden = false;
  document.querySelector("#panel").hidden = true;
}
ready();
