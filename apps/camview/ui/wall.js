// camview's wall (?wall=1; phil's sidebar, its Cameras heading): every camera,
// live, side by side. Each plays its smallest stream, the camera's own H.264 if
// this machine's player shows it right, otherwise re-encoded, otherwise JPEG
// pictures (as app.js does for one). A click shows that camera on its own (with
// its controls; Esc comes back here); Esc closes the wall.
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
document.body.replaceChildren(wall, note);
document.body.classList.add("wall");
document.title = "Cameras — camview";

const tiles = [];

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
  const t = { camera, el: tile, video: tile.querySelector("video"), img: tile.querySelector("img"), mode: "copy", player: null, profile: null };
  tiles.push(t);
  return t;
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
  if (e.key === "Escape" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w")) e.preventDefault(), close();
});
onCloseRequest(close);

try {
  const cameras = await api("api/cameras");
  if (!cameras.length) note.textContent = "No cameras found on the network (↻ by Cameras in phil's sidebar looks again).";
  else {
    note.hidden = true;
    wall.append(...cameras.map((c) => makeTile(c).el));
    layout();
    for (const t of tiles) start(t);
  }
} catch (err) {
  note.textContent = err.message;
}
wall.focus({ preventScroll: true });
ready();
