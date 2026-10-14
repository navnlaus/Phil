// camview's wall (?wall=1; phil's sidebar, its Cameras heading): every camera,
// live, side by side. Each plays its smallest stream, the camera's own H.264 if
// this machine's player shows it right, otherwise re-encoded, otherwise JPEG
// pictures (as app.js does for one). A click shows that camera on its own (with
// its controls; Esc comes back here); Esc closes the wall. Its list (the
// button in the top right corner, or L): every camera, offline and turned off
// ones too, each turned on or off, removed, and streams added by their URL.
import { closeWindow, onCloseRequest, ready, tooltips } from "../engine/ui/kit.js";

tooltips();

const MODES = ["copy", "h264", "mjpeg"]; // see app.js
const STALL_MS = 8000; // no video for this long: connect again
const JUMP_S = 3; // this far behind live: it jumps ahead

const wall = document.createElement("main");
wall.id = "wall";
wall.tabIndex = 0;
wall.setAttribute("aria-label", "Cameras");
const note = Object.assign(document.createElement("p"), { id: "wall-message", textContent: "Looking for cameras…" });
const panel = document.createElement("aside");
panel.id = "wall-list";
panel.hidden = true;
panel.innerHTML = `
  <header>
    <h2>Cameras</h2>
    <button type="button" class="icon look" title="Look for cameras again, and check the streams"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4"/></svg></button>
    <button type="button" class="icon close" title="Close the list (Esc)"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
  </header>
  <p class="hint list-state"></p>
  <div class="rows"></div>
  <form class="add">
    <h3>Add a stream</h3>
    <input name="name" type="text" placeholder="Name" maxlength="80" autocomplete="off" spellcheck="false">
    <input name="url" type="text" placeholder="rtsp://… or https://…" autocomplete="off" spellcheck="false" required>
    <button type="submit">Add</button>
    <p class="hint">RTSP, or a web stream: MJPEG, HLS (.m3u8), MP4. A login goes in the URL (rtsp://user:password@…).</p>
    <p class="error" hidden></p>
  </form>`;
const listButton = document.createElement("button");
listButton.id = "wall-list-button";
listButton.type = "button";
listButton.className = "icon";
listButton.title = "All cameras: turn them on or off, add a stream (L)";
listButton.innerHTML = `<svg viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>`;
document.body.replaceChildren(wall, note, listButton, panel);
document.body.classList.add("wall");
document.title = "Cameras — camview";

const tiles = []; // in the wall's order

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json();
}

const log = (message) => fetch("api/log", { method: "POST", body: JSON.stringify({ message }) }).catch(() => {});

// The URL of this page with other parameters (the ones phil gave it, to know it by, stay).
// Whole: a relative one is taken relative to whichever page's script set it.
function pageWith(changes) {
  const url = new URL(location.href);
  for (const [k, v] of Object.entries(changes)) v === null ? url.searchParams.delete(k) : url.searchParams.set(k, v);
  return url.href;
}

function makeTile(camera) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "cam";
  tile.title = `${camera.name}${camera.host ? ` (${camera.host})` : ""}: click to show it on its own`;
  tile.innerHTML = `<video muted autoplay playsinline disablepictureinpicture></video><img alt="" hidden><span class="cam-name"></span><span class="cam-msg"></span>`;
  tile.querySelector(".cam-name").textContent = camera.name;
  tile.onclick = () => {
    for (const t of tiles) stop(t);
    location.href = pageWith({ wall: null, camera: camera.id, from: "wall" });
  };
  return { camera, el: tile, video: tile.querySelector("video"), img: tile.querySelector("img"), mode: "copy", player: null, profile: null };
}

const say = (t, text) => (t.el.querySelector(".cam-msg").textContent = text);

async function start(t) {
  if (t.camera.needsLogin) return say(t, "Needs a login: right-click it in phil's sidebar");
  try {
    const { profiles } = await api(`api/camera?id=${encodeURIComponent(t.camera.id)}`);
    // The smallest (a camera's second stream): many at once, each small on the screen.
    const sized = profiles.filter((p) => p.width);
    t.profile = (sized.length ? sized.sort((a, b) => a.width * a.height - b.width * b.height)[0] : profiles[0])?.token ?? "";
    play(t);
  } catch (err) {
    say(t, err.message);
  }
}

const streamUrl = (t, mode) => `stream?id=${encodeURIComponent(t.camera.id)}&profile=${encodeURIComponent(t.profile ?? "")}&mode=${mode}`;

function play(t) {
  stop(t);
  const player = (t.player = { abort: new AbortController(), lastData: Date.now(), mode: t.mode });
  say(t, "Connecting…");
  if (player.mode === "mjpeg") return showJpegs(t, player);
  t.video.hidden = false;
  t.img.hidden = true;
  run(t, player).catch((err) => {
    if (player !== t.player || player.abort.signal.aborted) return;
    say(t, `${err.message}: trying again…`);
    player.retry = setTimeout(() => player === t.player && play(t), 3000);
  });
}

function stop(t) {
  const p = t.player;
  if (!p) return;
  t.player = null;
  p.abort.abort();
  clearTimeout(p.retry);
  clearTimeout(p.check);
  clearInterval(p.watch);
  t.img.removeAttribute("src");
  if (t.video.src) URL.revokeObjectURL(t.video.src);
  t.video.removeAttribute("src");
  t.video.load();
}

function nextMode(t, player, why) {
  const i = MODES.indexOf(player.mode);
  log(`wall: ${t.camera.id}: ${player.mode} ${why}${i < MODES.length - 1 ? `: trying ${MODES[i + 1]}` : ""}`);
  if (i >= MODES.length - 1 || player !== t.player) return;
  t.mode = MODES[i + 1];
  play(t);
}

function showJpegs(t, player) {
  t.video.hidden = true;
  t.img.hidden = false;
  t.img.onload = () => player === t.player && say(t, "");
  t.img.onerror = () => {
    if (player !== t.player) return;
    say(t, "The stream stopped: trying again…");
    player.retry = setTimeout(() => player === t.player && play(t), 3000);
  };
  t.img.src = streamUrl(t, "mjpeg");
}

// A few seconds in: not solid green (a decoder that gives nothing), and new frames coming.
function checkPicture(t, player) {
  const canvas = Object.assign(document.createElement("canvas"), { width: 48, height: 27 });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const frames = () => t.video.getVideoPlaybackQuality?.().totalVideoFrames ?? null;
  const first = { frames: frames(), time: t.video.currentTime };
  player.check = setTimeout(() => {
    if (player !== t.player) return;
    let c = null;
    try {
      ctx.drawImage(t.video, 0, 0, canvas.width, canvas.height);
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) (r += d[i]), (g += d[i + 1]), (b += d[i + 2]);
      const n = d.length / 4;
      c = { r: r / n, g: g / n, b: b / n };
    } catch { /* can't be read: taken as right */ }
    const now = frames();
    if (c && ((c.g > 30 && c.r < 8 && c.b < 8) || c.r + c.g + c.b < 0.5)) return nextMode(t, player, "shows solid green");
    if (first.frames !== null && now !== null && t.video.currentTime - first.time > 1.5 && now - first.frames < 3) return nextMode(t, player, "shows no new frames");
  }, 3000);
}

async function run(t, player) {
  const res = await fetch(streamUrl(t, player.mode), { signal: player.abort.signal });
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  const reader = res.body.getReader();
  let head = new Uint8Array(0), codec = null;
  while (!codec) {
    const { value, done } = await reader.read();
    if (done) throw new Error("The stream ended");
    head = concat(head, value);
    codec = codecOf(head);
    // A fragment of video, and no H.264 or H.265 description before it: something else (a web
    // camera's MJPEG, say), which the page can't play as it is: re-encoded, next.
    if (!codec && hasBox(head, "moof")) return nextMode(t, player, "isn't H.264 or H.265");
    if (head.length > 4_000_000) throw new Error("Can't tell what the video is");
  }
  const type = `video/mp4; codecs="${codec}"`;
  if (!globalThis.MediaSource?.isTypeSupported(type)) return nextMode(t, player, `can't be played here (${codec})`);
  const source = new MediaSource();
  t.video.src = URL.createObjectURL(source);
  await new Promise((resolve) => source.addEventListener("sourceopen", resolve, { once: true }));
  const buffer = source.addSourceBuffer(type);
  buffer.mode = "segments";
  const queue = [head];
  let trimmed = 0;
  const pump = () => {
    if (buffer.updating || !queue.length || player !== t.player) return;
    try {
      buffer.appendBuffer(queue.length > 1 ? concat(...queue.splice(0)) : queue.shift());
    } catch (err) {
      if (err.name === "QuotaExceededError") buffer.remove(0, Math.max(0, t.video.currentTime - 2));
      else throw err;
    }
  };
  buffer.addEventListener("updateend", () => {
    const b = buffer.buffered;
    if (b.length) {
      const start = b.start(b.length - 1), end = b.end(b.length - 1);
      if (t.video.currentTime < start) t.video.currentTime = start;
      else if (end - t.video.currentTime > JUMP_S) t.video.currentTime = Math.max(start, end - 0.3);
      if (t.video.currentTime - b.start(0) > 30 && Date.now() - trimmed > 10000) {
        trimmed = Date.now();
        return buffer.remove(0, t.video.currentTime - 10);
      }
    }
    pump();
  });
  t.video.play().catch(() => {});
  t.video.addEventListener("playing", () => player === t.player && !player.check && checkPicture(t, player), { once: true });
  player.watch = setInterval(() => {
    if (Date.now() - player.lastData > STALL_MS && player === t.player) play(t);
  }, 2000);
  say(t, "");
  pump();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("The stream ended");
    player.lastData = Date.now();
    queue.push(value);
    pump();
  }
}

const hasBox = (bytes, name) => {
  const [a, b, c, d] = [...name].map((ch) => ch.charCodeAt(0));
  return bytes.some((x, i) => x === a && bytes[i + 1] === b && bytes[i + 2] === c && bytes[i + 3] === d);
};

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, at), (at += p.length);
  return out;
}

// As app.js's: the codec string from the MP4's avcC or hvcC box.
function codecOf(bytes) {
  const find = (a, b, c, d) => bytes.findIndex((x, i) => x === a && bytes[i + 1] === b && bytes[i + 2] === c && bytes[i + 3] === d);
  const avc = find(0x61, 0x76, 0x63, 0x43);
  if (avc >= 0 && bytes.length > avc + 8) {
    const hex = (n) => n.toString(16).padStart(2, "0");
    return `avc1.${hex(bytes[avc + 5])}${hex(bytes[avc + 6])}${hex(bytes[avc + 7])}`;
  }
  const hvc = find(0x68, 0x76, 0x63, 0x43);
  if (hvc >= 0 && bytes.length > hvc + 20) return `hvc1.${bytes[hvc + 5] & 0x1f}.4.L${bytes[hvc + 16]}.B0`;
  return null;
}

// As many columns as make the tiles biggest for the window (16:9 each).
function layout() {
  const n = tiles.length;
  if (!n) return;
  const w = innerWidth, h = innerHeight;
  let best = 1, bestSize = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const size = Math.min(w / cols, (h / rows) * (16 / 9));
    if (size > bestSize) (bestSize = size), (best = cols);
  }
  wall.style.setProperty("--cols", best);
  wall.style.setProperty("--rows", Math.ceil(n / best));
}
addEventListener("resize", layout);

function close() {
  for (const t of tiles) stop(t);
  closeWindow();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !panel.hidden) return e.preventDefault(), toggleList(false); // the list first
  if (e.key === "Escape" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w")) return e.preventDefault(), close();
  const typing = e.target.closest?.("input, textarea");
  if (!typing && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "l") e.preventDefault(), toggleList();
});
onCloseRequest(close);

// The wall's tiles, as the cameras shown now are: each kept (playing on) while
// its camera is, by id; new ones started, gone ones stopped.
function renderTiles(cameras) {
  const old = new Map(tiles.map((t) => [t.camera.id, t]));
  tiles.length = 0;
  for (const c of cameras) {
    let t = old.get(c.id);
    if (t) old.delete(c.id), (t.camera = c), (t.el.querySelector(".cam-name").textContent = c.name);
    else (t = makeTile(c)), (t.fresh = true);
    tiles.push(t);
  }
  for (const t of old.values()) stop(t), t.el.remove();
  for (const t of tiles) wall.append(t.el); // (in place already: stays)
  for (const t of tiles.filter((t) => t.fresh)) (t.fresh = false), start(t);
  note.hidden = tiles.length > 0;
  if (!tiles.length) note.textContent = "No cameras to show: the list (top right) has those turned off or offline, and adds streams.";
  layout();
}

async function refresh() {
  try {
    renderTiles(await api("api/cameras"));
  } catch (err) {
    note.hidden = false;
    note.textContent = err.message;
  }
  if (!panel.hidden) renderRows(await api("api/cameras/all").catch(() => null));
}

// ---------------------------------------------------------------- the list

const STATES = { on: "", offline: "offline", off: "off" };
const KINDS = { network: "", cloud: "cloud", stream: "stream" };

function renderRows(list) {
  if (!list) return;
  panel.querySelector(".list-state").textContent = list.length ? "" : "No cameras yet: phil's ↻ by Cameras looks for them on the network, or add a stream below.";
  const rows = panel.querySelector(".rows");
  const old = new Map([...rows.children].map((r) => [r.dataset.id, r]));
  const els = list.map((c) => {
    let row = old.get(c.id);
    if (row) old.delete(c.id);
    else row = makeRow(c);
    showRow(row, c);
    return row;
  });
  for (const r of old.values()) r.remove();
  for (const r of els) rows.append(r);
}

function makeRow(c) {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.id = c.id;
  row.innerHTML = `<label class="switch"><input type="checkbox"><span></span></label><div class="what"><span class="name"></span><span class="detail"></span></div><button type="button" class="remove"></button>`;
  row.querySelector("input").onchange = async (e) => {
    await fetch("api/camera", { method: "PUT", body: JSON.stringify({ id: row.camera.id, disabled: !e.target.checked }) }).catch(() => {});
    refresh();
  };
  row.querySelector(".remove").onclick = async () => {
    const c = row.camera;
    if (!confirm(c.kind === "stream" ? `Remove ${c.name}?` : `Forget ${c.name}? (Looking for cameras won't bring it back; adding it by its address will.)`)) return;
    await fetch(`api/camera?id=${encodeURIComponent(c.id)}`, { method: "DELETE" }).catch(() => {});
    refresh();
  };
  return row;
}

function showRow(row, c) {
  row.camera = c;
  row.classList.toggle("off", c.state !== "on");
  row.querySelector("input").checked = c.state !== "off";
  row.querySelector(".switch").title = c.state === "off" ? "Turned off: turn it on to show it" : "Shown: turn it off to hide it (it's kept here)";
  row.querySelector(".name").textContent = c.name;
  const detail = [STATES[c.state], KINDS[c.kind], c.kind === "stream" ? c.url : [c.model, c.host].filter(Boolean).join(" · ")].filter(Boolean).join(" · ");
  row.querySelector(".detail").textContent = detail;
  row.querySelector(".detail").title = detail;
  const remove = row.querySelector(".remove");
  remove.textContent = c.kind === "stream" ? "Remove" : "Forget";
  remove.title = c.kind === "stream" ? "Remove this stream" : "Forget this camera";
}

async function toggleList(open = panel.hidden) {
  panel.hidden = !open;
  listButton.classList.toggle("on", open);
  if (open) {
    renderRows(await api("api/cameras/all").catch(() => null));
    panel.querySelector('input[name="url"]').focus();
  } else wall.focus({ preventScroll: true });
}

listButton.onclick = () => toggleList();
panel.querySelector(".close").onclick = () => toggleList(false);
panel.querySelector(".look").onclick = async (e) => {
  const button = e.currentTarget;
  button.classList.add("busy");
  panel.querySelector(".list-state").textContent = "Looking for cameras, and checking the streams…";
  const list = await fetch("api/cameras/look", { method: "POST" }).then((r) => r.json()).catch(() => null);
  button.classList.remove("busy");
  panel.querySelector(".list-state").textContent = "";
  renderRows(list);
  refresh();
};
panel.querySelector(".add").onsubmit = async (e) => {
  e.preventDefault();
  const form = e.currentTarget, error = form.querySelector(".error"), button = form.querySelector("button");
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    const res = await fetch("api/cameras/stream", { method: "POST", body: JSON.stringify({ name: form.name.value, url: form.url.value }) });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    const c = await res.json();
    form.reset();
    error.hidden = c.state === "on";
    error.textContent = c.state === "on" ? "" : `${c.name} doesn't answer now: it's in the list, offline (↻ checks again).`;
  } catch (err) {
    error.hidden = false;
    error.textContent = err.message;
  }
  button.disabled = false;
  button.textContent = "Add";
  refresh();
};

await refresh();
wall.focus({ preventScroll: true });
ready();
