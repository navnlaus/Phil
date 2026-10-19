// camview's page: network cameras, live, the same way one or many. Each camera
// is a tile playing one stream (the one picked for it, else its biggest), side
// by side; one fills the window with its controls (pan, tilt and zoom, saved
// positions, a picture, which stream, stats). The wall (?wall=1: phil's
// sidebar's Cameras heading, `camview`): every camera that's on; a click fills
// the window with that tile, the same stream playing on (nothing reconnects),
// and Esc or × puts it back. One camera (?camera=: phil's sidebar, `camview
// name`): a wall of one, filling the window from the start; Esc closes it. The
// wall's list (the button in the top right corner, or L): every camera,
// offline and turned off ones too, each turned on or off, removed, and streams
// added by their URL. A web page camera is its page, used over the wall.
import { closeWindow, holdFocus, onCloseRequest, ready, tooltips } from "../engine/ui/kit.js";
import { playHls } from "./hls.js";

tooltips(); // the page's own, in the theme's style (kit.js)

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const WALL = params.has("wall");

const MOVE_REPEAT_MS = 500; // a held move is repeated this often (the server stops it 1.5 s after the last)
// Played at its own pace, never faster to catch up: a change of speed can
// restart the player, which stalls it, so it falls further behind.
// Only when it's this far behind (the window was hidden, say) it jumps ahead
// (landing between the camera's full frames, it shows nothing right for a moment).
const JUMP_S = 3;
const STALL_MS = 8000; // no video for this long: connect again

const wall = $("#wall");
const message = $("#message");
const tiles = []; // in the wall's order
let focused = null; // the tile filling the window (with the controls)

const ptz = { move: null, moveTimer: 0, keys: new Set(), presets: [] }; // the focused camera's

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json();
}

const log = (text) => fetch("api/log", { method: "POST", body: JSON.stringify({ message: text }) }).catch(() => {});

// A message over the page: what an action did (a toast, gone after a while), or why there's nothing.
function showMessage(text, { toast = false } = {}) {
  clearTimeout(showMessage.timer);
  message.textContent = text;
  message.hidden = !text;
  message.classList.toggle("toast", toast);
  if (toast && text) showMessage.timer = setTimeout(() => (message.hidden = true), 4000);
}

// What's said on a tile: connecting, trying again, why it can't play.
const say = (t, text) => (t.el.querySelector(".cam-msg").textContent = text);

// ---------------------------------------------------------------- a tile

function makeTile(camera) {
  const el = document.createElement("div");
  el.className = "cam";
  el.tabIndex = 0;
  el.innerHTML = `<video muted autoplay playsinline disablepictureinpicture></video><img alt="" hidden><span class="cam-name"></span><span class="cam-msg"></span>`;
  const t = { camera, el, video: el.querySelector("video"), img: el.querySelector("img"), mode: MODES[0], player: null, profile: null, info: null, connects: 0, noHls: false };
  if (camera.page) { // a web page (a camera's that plays it its own way): the page itself; a click shows it over the wall
    const frame = Object.assign(document.createElement("iframe"), { src: camera.page, title: camera.name, allow: "autoplay; fullscreen", loading: "lazy" });
    frame.setAttribute("referrerpolicy", "no-referrer");
    t.video.replaceWith(frame);
    t.page = true;
    el.onclick = () => showPage(camera);
  } else {
    el.onclick = () => WALL && !focused && focusTile(t);
    el.ondblclick = () => focused === t && toggleFullscreen();
    el.onkeydown = (e) => void (e.key === "Enter" && !focused && (e.preventDefault(), focusTile(t)));
  }
  showTileName(t);
  return t;
}

function showTileName(t) {
  t.el.querySelector(".cam-name").textContent = t.camera.name;
  t.el.title = t.page ? `${t.camera.name}: click to use the page` : WALL ? `${t.camera.name}${t.camera.host ? ` (${t.camera.host})` : ""}: click to fill the window with it, with its controls` : "";
}

// Its stream: the one picked for it (any window), else its biggest (a camera's main stream).
async function start(t) {
  if (t.page) return;
  if (t.camera.needsLogin) return say(t, "Needs a login: right-click it in phil's sidebar");
  try {
    t.info = await api(`api/camera?id=${encodeURIComponent(t.camera.id)}`);
    const { profiles } = t.info;
    const sized = profiles.filter((p) => p.width).sort((a, b) => b.width * b.height - a.width * a.height);
    t.profile = profiles.some((p) => p.token === t.camera.profile) ? t.camera.profile : (sized[0] ?? profiles[0])?.token ?? "";
    play(t);
    if (focused === t) showControls(t);
  } catch (err) {
    say(t, err.message);
  }
}

// ---------------------------------------------------------------- the video

// How a stream is shown, best first:
//   mpv    in salir's windows with phil's mpv plugin: the stream as it is, read by
//          mpv itself, under the page (low latency; decoded on the GPU, H.265 too)
// and the server's /stream modes:
//   copy   the camera's own H.264, copied into fragmented MP4 for a Media
//          Source: costs nothing, decoded on the GPU
//   h264   re-encoded by the server as the plainest H.264 (some CPU there)
//   mjpeg  JPEG pictures one after another, in an <img>: no video player at all
// Each is checked once it plays (checkPicture): solid green, or no new frames,
// and the next one is tried. The one that works is kept while the page is
// open (not saved: once this machine's player is fixed, copy is tried again).
// An HLS stream (a web camera's) is played by hls.js in the page first.
const MODES = [...(globalThis.salir ? ["mpv"] : []), "copy", "h264", "mjpeg"];

// A tile's stream, kept close to live (see JUMP_S). Connects again when the stream ends or stalls.
function play(t) {
  stop(t);
  const mode = MODES.includes(t.mode) ? t.mode : MODES[0];
  const player = (t.player = { abort: new AbortController(), lastData: Date.now(), mode, bytes: 0, jpegs: 0, started: Date.now() });
  t.connects++;
  say(t, "Connecting…");
  if (mode === "mjpeg") return showJpegs(t, player);
  if (mode === "mpv") return playMpv(t, player);
  t.video.hidden = false;
  t.img.hidden = true;
  if (!t.noHls) return tryHls(t, player);
  run(t, player).catch((err) => {
    if (player !== t.player || player.abort.signal.aborted) return;
    say(t, `${err.message}: trying again…`);
    player.retry = setTimeout(() => player === t.player && play(t), 3000);
  });
}

// An HLS stream: played by hls.js in the page (hls.js); not HLS, or it gives up: /stream, as the others.
async function tryHls(t, player) {
  const handle = await playHls(t.video, t.camera.id, t.profile, {
    onPlaying: () => player === t.player && say(t, ""),
    onGiveUp: (why) => {
      if (player !== t.player) return;
      log(`${t.camera.id}: ${why}: trying ${player.mode}`);
      t.noHls = true;
      play(t);
    },
  }).catch(() => null);
  if (player !== t.player) return handle?.stop();
  if (!handle) return (t.noHls = true), play(t);
  player.hls = handle;
  player.mode = "hls";
}

function stop(t) {
  const p = t.player;
  if (!p) return;
  t.player = null;
  p.embed?.remove();
  t.el.classList.remove("mpv");
  p.hls?.stop();
  p.abort.abort();
  clearTimeout(p.retry);
  clearTimeout(p.check);
  clearInterval(p.watch);
  t.img.removeAttribute("src");
  if (t.video.src) URL.revokeObjectURL(t.video.src);
  t.video.removeAttribute("src");
  t.video.load();
}

// mpv: the stream as it is (the server's /api/source), read by mpv, which reconnects
// itself; when it ends, connected again after a while. No mpv here (the embed's error):
// the other ways.
async function playMpv(t, player) {
  t.video.hidden = true;
  t.img.hidden = true;
  let source;
  try {
    source = await api(`api/source?id=${encodeURIComponent(t.camera.id)}&profile=${encodeURIComponent(t.profile ?? "")}`);
  } catch (err) {
    if (player !== t.player) return;
    say(t, `${err.message}: trying again…`);
    player.retry = setTimeout(() => player === t.player && play(t), 3000);
    return;
  }
  if (player !== t.player) return;
  const el = document.createElement("salir-embed");
  // Its buffer (the camera's settings, the list's): automatic, none on the local network
  // (shown as it comes: no cache, no clock to keep to), a second over the internet, whose
  // hiccups it rides out (mpv plays it at its own pace, a second behind, waiting for that
  // much again after a stall). Over TCP; no sound at all (not muted: a muted track is still
  // played, and the picture waits for it, ~1.2 s behind), and the decoder not holding frames
  // back (low_delay: ~0.1 s on the GPU).
  const buffer = bufferOf(t.camera, source.local);
  player.buffer = buffer;
  const common = { kind: "mpv", aid: "no", "vd-lavc-o": "flags=+low_delay", "rtsp-transport": "tcp", "network-timeout": "10" };
  const options = buffer
    ? { ...common, cache: "yes", "cache-secs": String(buffer), "demuxer-readahead-secs": String(buffer), "cache-pause": "yes", "cache-pause-initial": "yes", "cache-pause-wait": String(buffer) }
    : { ...common, profile: "low-latency", untimed: "yes", cache: "no" };
  for (const [k, v] of Object.entries(options)) el.setAttribute(k, v);
  el.className = "cam-mpv";
  player.embed = el;
  player.props = {};
  el.addEventListener("error", (e) => player === t.player && nextMode(t, player, `can't be played by mpv (${e.detail?.error})`));
  el.addEventListener("message", (e) => {
    const m = e.detail;
    if (player !== t.player || !m) return;
    if (m.properties) Object.assign(player.props, m.properties);
    if (m.event === "playback-restart") {
      say(t, "");
      player.lastData = Date.now();
      if (!player.logged) (player.logged = true), log(`${t.camera.id}: mpv plays (${player.props.width}×${player.props.height}, ${player.props["video-codec"] ?? "?"})`);
    } else if (m.event === "end-file" && m.reason !== "stop") {
      say(t, `${m.error ?? "The stream ended"}: trying again…`);
      player.retry = setTimeout(() => player === t.player && play(t), 3000);
    }
  });
  t.el.prepend(el);
  t.el.classList.add("mpv");
  el.send({ observe: ["width", "height", "video-codec", "estimated-vf-fps", "frame-drop-count", "demuxer-cache-duration", "video-bitrate"] });
  el.send({ command: ["loadfile", source.url, "replace"] });
}

// A camera's buffer, in seconds (its setting; automatic: none here, a second over the internet).
const bufferOf = (camera, local) => (typeof camera.buffer === "number" ? camera.buffer : local ? 0 : 1);

const streamUrl = (t, mode) => `stream?id=${encodeURIComponent(t.camera.id)}&profile=${encodeURIComponent(t.profile ?? "")}&mode=${mode}`;

// The next way of showing it, after `why` (logged, for finding out what this
// machine's player can do); the last one is kept regardless.
function nextMode(t, player, why) {
  const i = MODES.indexOf(player.mode);
  log(`${t.camera.id}: ${player.mode} ${why}${i < MODES.length - 1 ? `: trying ${MODES[i + 1]}` : ""}`);
  if (i >= MODES.length - 1 || player !== t.player) return;
  t.mode = MODES[i + 1];
  play(t);
}

// Whether the picture is right, a few seconds into playing: not solid green (a
// decoder that gives nothing), and new frames coming (not frozen on the first).
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
    } catch { /* can't be read here: taken as right */ }
    const now = frames();
    // Solid green on the screen; read back, sometimes exactly black (a camera's picture never is: its clock's on it).
    if (c && ((c.g > 30 && c.r < 8 && c.b < 8) || c.r + c.g + c.b < 0.5)) return nextMode(t, player, `shows solid green (${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)})`);
    if (first.frames !== null && now !== null && t.video.currentTime - first.time > 1.5 && now - first.frames < 3) {
      return nextMode(t, player, `shows no new frames (${now - first.frames} in ${(t.video.currentTime - first.time).toFixed(1)} s)`);
    }
    if (!player.logged) (player.logged = true), log(`${t.camera.id}: ${player.mode} plays (${t.video.videoWidth}×${t.video.videoHeight}${now !== null ? `, ${now - (first.frames ?? 0)} frames` : ""})`);
  }, 3000);
}

// MJPEG: an <img> the server keeps sending pictures to.
function showJpegs(t, player) {
  t.video.hidden = true;
  t.img.hidden = false;
  t.img.onload = () => player === t.player && (player.jpegs++, say(t, ""), player.logged || ((player.logged = true), log(`${t.camera.id}: mjpeg shows`)));
  t.img.onerror = () => {
    if (player !== t.player) return;
    say(t, "The stream stopped: trying again…");
    player.retry = setTimeout(() => player === t.player && play(t), 3000);
  };
  t.img.src = streamUrl(t, "mjpeg");
}

async function run(t, player) {
  const res = await fetch(streamUrl(t, player.mode), { signal: player.abort.signal });
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  const reader = res.body.getReader();
  // The start of the stream (up to its codec description), for the codec it has.
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
  player.codec = codec;
  if (!globalThis.MediaSource?.isTypeSupported(type)) return nextMode(t, player, `can't be played here (${codec})`); // H.265, say
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
      if (t.video.currentTime < start) t.video.currentTime = start; // the start (it doesn't begin at 0), or past a gap
      else if (end - t.video.currentTime > JUMP_S) t.video.currentTime = Math.max(start, end - 0.3);
      // What's well behind isn't needed: dropped now and then, so the buffer stays small.
      if (t.video.currentTime - b.start(0) > 30 && Date.now() - trimmed > 10000) {
        trimmed = Date.now();
        return buffer.remove(0, t.video.currentTime - 10);
      }
    }
    pump();
  });
  t.video.play().catch(() => {});
  t.video.addEventListener("playing", () => player === t.player && !player.check && checkPicture(t, player), { once: true });
  // Stalled (the camera or the network gone quiet): connected again.
  player.watch = setInterval(() => {
    if (Date.now() - player.lastData > STALL_MS && player === t.player) play(t);
  }, 2000);
  say(t, "");
  pump();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("The stream ended");
    player.lastData = Date.now();
    player.bytes += value.length;
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

// The codec string of an MP4's video, from its avcC (H.264: "avc1.PPCCLL",
// profile, constraints, level) or hvcC box (H.265), or null before it's there.
function codecOf(bytes) {
  const find = (a, b, c, d) => bytes.findIndex((x, i) => x === a && bytes[i + 1] === b && bytes[i + 2] === c && bytes[i + 3] === d);
  const avc = find(0x61, 0x76, 0x63, 0x43); // avcC
  if (avc >= 0 && bytes.length > avc + 8) {
    const hex = (n) => n.toString(16).padStart(2, "0");
    return `avc1.${hex(bytes[avc + 5])}${hex(bytes[avc + 6])}${hex(bytes[avc + 7])}`;
  }
  const hvc = find(0x68, 0x76, 0x63, 0x43); // hvcC
  if (hvc >= 0 && bytes.length > hvc + 20) return `hvc1.${bytes[hvc + 5] & 0x1f}.4.L${bytes[hvc + 16]}.B0`;
  return null;
}

// ---------------------------------------------------------------- one filling the window

// A tile filling the window, the same stream playing on, and the controls for it.
function focusTile(t) {
  if (focused === t) return;
  unfocusTile({ keep: true });
  focused = t;
  t.el.classList.add("focused");
  document.body.classList.add("focused");
  document.title = `${t.camera.name} — camview`;
  showControls(t);
  wall.focus({ preventScroll: true });
}

// Back to the wall (a wall of one: the window closes instead, see back()).
function unfocusTile({ keep = false } = {}) {
  if (!focused) return;
  stopMove();
  focused.el.classList.remove("focused");
  focused = null;
  if (keep) return;
  document.body.classList.remove("focused");
  document.title = "Cameras — camview";
  if (!statsBox.hidden) showStats(false, { remember: false });
  wall.focus({ preventScroll: true });
}

// The controls, for the focused tile's camera: its name, its streams, pan, tilt and zoom, saved positions.
function showControls(t) {
  $("#name").textContent = t.camera.name;
  $("#info").textContent = [t.camera.model, t.camera.host].filter(Boolean).join(" · ");
  const profiles = t.info?.profiles ?? [];
  const quality = $("#quality");
  quality.replaceChildren(...profiles.map((p) => new Option(p.width ? `${p.width}×${p.height}` : p.name, p.token)));
  quality.hidden = profiles.length < 2;
  quality.value = t.profile ?? "";
  const cam = t.info?.ptz;
  $("#ptz").hidden = !cam;
  $("#btn-invert").hidden = !cam;
  $("#zoom").hidden = !cam?.zoom;
  $("#presets").hidden = !cam?.presets;
  showInvert(t.camera.invert);
  ptz.presets = [];
  $("#preset-list").replaceChildren();
  if (cam?.presets) loadPresets(t);
  $("#btn-close").title = WALL ? "Back to the wall (Esc)" : "Close (Esc)";
  if (load("stats", "") || params.get("stats") === "1") showStats(true);
}

// Esc, ×: the wall again, or (one camera) the window closes.
function back() {
  if (document.fullscreenElement) return document.exitFullscreen();
  if (WALL && focused) return unfocusTile();
  close();
}

function close() {
  stopMove();
  closeWindow(); // (first: the window goes at once, mpv's teardown after, unseen)
  for (const t of tiles) stop(t);
  if (document.fullscreenElement) document.exitFullscreen();
}

// The stream picked (Q, or its menu): kept for that camera, in every window (its settings: cameras.json).
$("#quality").onchange = () => {
  const t = focused;
  if (!t) return;
  t.profile = $("#quality").value;
  t.noHls = false; // another stream: HLS maybe
  t.camera.profile = t.profile;
  api("api/camera", { method: "PUT", body: JSON.stringify({ id: t.camera.id, profile: t.profile }) }).catch(() => {});
  play(t);
  wall.focus({ preventScroll: true });
};

// ---------------------------------------------------------------- pan, tilt, zoom

const speed = () => Number($("#speed").value) || 0.5;

// Moving in a direction (each -1, 0 or 1), at the speed set; repeated while
// held, so the server's safety stop doesn't cut in. Stops with stopMove().
function startMove(dir) {
  if (!focused) return;
  const id = focused.camera.id;
  const move = { x: (dir.x ?? 0) * speed(), y: (dir.y ?? 0) * speed(), zoom: (dir.zoom ?? 0) * speed() };
  if (ptz.move && ptz.move.x === move.x && ptz.move.y === move.y && ptz.move.zoom === move.zoom) return;
  ptz.move = { ...move, id };
  document.body.classList.add("moving");
  clearInterval(ptz.moveTimer);
  const send = () => api("api/ptz", { method: "POST", body: JSON.stringify({ id, op: "move", x: ptz.move.x, y: ptz.move.y, zoom: ptz.move.zoom }) })
    .catch((err) => (showMessage(err.message, { toast: true }), stopMove()));
  send();
  ptz.moveTimer = setInterval(() => ptz.move && send(), MOVE_REPEAT_MS);
}

function stopMove() {
  clearInterval(ptz.moveTimer);
  document.body.classList.remove("moving");
  for (const b of document.querySelectorAll("#ptz .held")) b.classList.remove("held");
  if (!ptz.move) return;
  const { id } = ptz.move;
  ptz.move = null;
  api("api/ptz", { method: "POST", body: JSON.stringify({ id, op: "stop" }) }).catch(() => {});
}

for (const b of document.querySelectorAll("#ptz .dir")) {
  const dir = { x: Number(b.dataset.x ?? 0), y: Number(b.dataset.y ?? 0), zoom: Number(b.dataset.zoom ?? 0) };
  b.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    b.setPointerCapture(e.pointerId);
    b.classList.add("held");
    startMove(dir);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) b.addEventListener(type, stopMove);
}
$("#btn-stop").onclick = stopMove;
// The window losing the keyboard or going away mid-move: stopped (and the server stops it anyway).
addEventListener("blur", stopMove);
addEventListener("pagehide", stopMove);
document.addEventListener("visibilitychange", () => document.hidden && stopMove());

// The arrow keys held, together for diagonals.
function keyMove() {
  const k = ptz.keys;
  const x = (k.has("ArrowRight") ? 1 : 0) - (k.has("ArrowLeft") ? 1 : 0);
  const y = (k.has("ArrowUp") ? 1 : 0) - (k.has("ArrowDown") ? 1 : 0);
  const zoom = (k.has("+") ? 1 : 0) - (k.has("-") ? 1 : 0);
  if (x || y || zoom) startMove({ x, y, zoom });
  else stopMove();
}

const speedInput = $("#speed");
speedInput.value = load("speed", "0.5");
speedInput.oninput = () => save("speed", speedInput.value);

// ---------------------------------------------------------------- presets

async function loadPresets(t) {
  const list = await api(`api/presets?id=${encodeURIComponent(t.camera.id)}`).catch(() => []);
  if (focused !== t) return;
  ptz.presets = list;
  $("#preset-list").replaceChildren(...list.map((p, i) => {
    const b = document.createElement("button");
    b.type = "button";
    if (i < 9) b.innerHTML = `<span class="key">${i + 1}</span>`;
    b.append(p.name);
    b.title = `Go there${i < 9 ? ` (${i + 1})` : ""} · right-click: remove`;
    b.onclick = () => gotoPreset(p);
    b.oncontextmenu = (e) => {
      e.preventDefault();
      removePreset(p);
    };
    return b;
  }));
}

function gotoPreset(p) {
  if (!focused) return;
  stopMove();
  api("api/ptz", { method: "POST", body: JSON.stringify({ id: focused.camera.id, op: "goto", preset: p.token }) })
    .then(() => showMessage(`Going to ${p.name}`, { toast: true }), (err) => showMessage(err.message, { toast: true }));
}

async function removePreset(p) {
  const t = focused;
  if (!t || !confirm(`Remove the saved position “${p.name}”?`)) return;
  try {
    await api("api/ptz", { method: "POST", body: JSON.stringify({ id: t.camera.id, op: "remove", preset: p.token }) });
    await loadPresets(t);
  } catch (err) {
    showMessage(err.message, { toast: true });
  }
}

const presetForm = $("#preset-form"), presetName = $("#preset-name");
$("#btn-save-preset").onclick = () => {
  presetForm.hidden = false;
  presetName.value = `Position ${ptz.presets.length + 1}`;
  presetName.focus();
  presetName.select();
};
presetForm.onsubmit = async (e) => {
  e.preventDefault();
  const t = focused, name = presetName.value.trim();
  presetForm.hidden = true;
  wall.focus({ preventScroll: true });
  if (!t || !name) return;
  try {
    await api("api/ptz", { method: "POST", body: JSON.stringify({ id: t.camera.id, op: "save", name }) });
    await loadPresets(t);
    showMessage(`Saved “${name}”`, { toast: true });
  } catch (err) {
    showMessage(err.message, { toast: true });
  }
};
presetName.onkeydown = (e) => {
  e.stopPropagation(); // typing here isn't moving the camera
  if (e.key === "Escape") e.preventDefault(), (presetForm.hidden = true), wall.focus({ preventScroll: true });
};
presetName.onblur = () => (presetForm.hidden = true);

// Upside down: the server turns pan and tilt around (cameras.json keeps it, for
// this camera, wherever it's shown).
function showInvert(on) {
  const b = $("#btn-invert");
  b.setAttribute("aria-pressed", String(!!on));
  b.classList.toggle("on", !!on);
}

async function toggleInvert() {
  const t = focused;
  if (!t?.info?.ptz) return;
  stopMove();
  try {
    const c = await api("api/camera", { method: "PUT", body: JSON.stringify({ id: t.camera.id, invert: !t.camera.invert }) });
    t.camera.invert = c.invert;
    showInvert(c.invert);
    showMessage(c.invert ? "Controls turned around (upside down)" : "Controls the usual way", { toast: true });
  } catch (err) {
    showMessage(err.message, { toast: true });
  }
}

// ---------------------------------------------------------------- stats

// Over the video, top left (the chart button, or D): how the focused camera is
// shown, its frames per second and dropped frames, how far behind live it
// plays (what's buffered here and not shown yet; the camera's own encoding and
// the network before it come on top, a few hundred ms), the data coming in,
// and how often it had to connect again. Each second, while shown; remembered.
const statsBox = $("#stats");
const MODE_NAMES = { mpv: "mpv, the stream itself", hls: "HLS, played here (hls.js)", copy: "camera's own", h264: "re-encoded H.264", mjpeg: "MJPEG pictures" };
let statsTimer = 0, last = null, statsLogged = 0;

function showStats(on, { remember = true } = {}) {
  statsBox.hidden = !on;
  $("#btn-stats").setAttribute("aria-pressed", String(on));
  $("#btn-stats").classList.toggle("on", on);
  if (remember) save("stats", on ? "1" : "");
  clearInterval(statsTimer);
  last = null;
  if (on) updateStats(), (statsTimer = setInterval(updateStats, 1000));
}

function updateStats() {
  const t = focused, p = t?.player;
  if (!p) return (statsBox.textContent = "not connected");
  if (p.mode === "mpv") return showMpvStats(t, p);
  const video = t.video;
  const quality = video.getVideoPlaybackQuality?.();
  const now = { t: performance.now(), frames: p.mode === "mjpeg" ? p.jpegs : quality?.totalVideoFrames ?? 0, bytes: p.bytes, player: p };
  const dt = last && last.player === p ? (now.t - last.t) / 1000 : 0;
  const fps = dt ? (now.frames - last.frames) / dt : null;
  const mbit = dt && p.mode !== "mjpeg" ? ((now.bytes - last.bytes) * 8) / dt / 1e6 : null;
  last = now;
  const b = video.buffered;
  const behind = p.mode !== "mjpeg" && b.length ? b.end(b.length - 1) - video.currentTime : null;
  const size = p.mode === "mjpeg" ? `${t.img.naturalWidth}×${t.img.naturalHeight}` : `${video.videoWidth}×${video.videoHeight}`;
  const up = Math.round((Date.now() - p.started) / 1000);
  // Every 10 s, also to phil's log (camview: ...): what this machine's player does, to look into.
  if (fps !== null && ++statsLogged % 10 === 0) {
    log(`${t.camera.id}: stats ${p.mode} ${size} ${fps.toFixed(1)} fps, dropped ${quality?.droppedVideoFrames ?? "?"}, behind ${behind?.toFixed(2) ?? "-"} s, ${mbit?.toFixed(2) ?? "-"} Mbit/s, reconnects ${t.connects - 1}`);
  }
  statsBox.textContent = [
    `stream    ${MODE_NAMES[p.mode]}${p.codec ? ` (${p.codec})` : ""}`,
    `size      ${size}`,
    `fps       ${fps === null ? "…" : fps.toFixed(1)}${quality && p.mode !== "mjpeg" ? `   dropped ${quality.droppedVideoFrames}` : ""}`,
    behind !== null ? `behind    ${behind.toFixed(2)} s` : null,
    mbit !== null ? `data      ${mbit.toFixed(2)} Mbit/s` : null,
    `connected ${up < 120 ? `${up} s` : `${Math.round(up / 60)} min`}${t.connects > 1 ? `   reconnects ${t.connects - 1}` : ""}`,
  ].filter(Boolean).join("\n");
}

// mpv's, from its properties.
function showMpvStats(t, p) {
  const v = p.props ?? {}, up = Math.round((Date.now() - p.started) / 1000);
  statsBox.textContent = [
    `stream    ${MODE_NAMES.mpv}${v["video-codec"] ? ` (${v["video-codec"]})` : ""}`,
    `size      ${v.width ?? "?"}×${v.height ?? "?"}`,
    `fps       ${v["estimated-vf-fps"]?.toFixed(1) ?? "…"}   dropped ${v["frame-drop-count"] ?? 0}`,
    v["demuxer-cache-duration"] != null ? `behind    ${v["demuxer-cache-duration"].toFixed(2)} s` : null,
    v["video-bitrate"] ? `data      ${(v["video-bitrate"] / 1e6).toFixed(2)} Mbit/s` : null,
    `connected ${up < 120 ? `${up} s` : `${Math.round(up / 60)} min`}${t.connects > 1 ? `   reconnects ${t.connects - 1}` : ""}`,
  ].filter(Boolean).join("\n");
}

$("#btn-stats").onclick = () => showStats(statsBox.hidden);

// ---------------------------------------------------------------- the rest

async function snapshot() {
  if (!focused) return;
  showMessage("Taking a picture…", { toast: true });
  try {
    const { path } = await api("api/snapshot", { method: "POST", body: JSON.stringify({ id: focused.camera.id }) });
    showMessage(`Saved ${path.split("/").slice(-2).join("/")}`, { toast: true });
  } catch (err) {
    showMessage(err.message, { toast: true });
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

function load(key, fallback) {
  try {
    return localStorage.getItem(`camview.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(`camview.${key}`, value);
  } catch { /* not kept */ }
}

const ARROWS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "w") return e.preventDefault(), close();
  if (e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.("input, textarea, select")) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const handled = () => e.preventDefault();
  if (!focused) { // the wall: a page shown first, then the list, then the window
    if (key === "Escape" && !pageView.hidden) return closePage(), handled();
    if (key === "Escape" && !panel.hidden) return toggleList(false), handled();
    if (key === "Escape") return close(), handled();
    if (key === "l" && WALL) return toggleList(), handled();
    return;
  }
  const cam = focused.info?.ptz;
  if (cam && (ARROWS.has(key) || ((key === "+" || key === "=" || key === "-") && cam.zoom))) {
    if (!e.repeat) ptz.keys.add(key === "=" ? "+" : key), keyMove();
    return handled();
  }
  if (key === " ") return stopMove(), handled();
  if (/^[1-9]$/.test(key) && ptz.presets[Number(key) - 1]) return gotoPreset(ptz.presets[Number(key) - 1]), handled();
  if (key === "f") return toggleFullscreen(), handled();
  if (key === "s") return snapshot(), handled();
  if (key === "i" && cam) return toggleInvert(), handled();
  if (key === "d") return showStats(statsBox.hidden), handled();
  if (key === "q" && (focused.info?.profiles.length ?? 0) > 1) {
    const q = $("#quality");
    q.selectedIndex = (q.selectedIndex + 1) % q.options.length;
    q.onchange();
    return handled();
  }
  if (key === "Escape") return back(), handled();
});
document.addEventListener("keyup", (e) => {
  const key = e.key === "=" ? "+" : e.key;
  if (ptz.keys.delete(key)) keyMove();
});
addEventListener("blur", () => ptz.keys.clear());

$("#btn-snap").onclick = snapshot;
$("#btn-invert").onclick = toggleInvert;
$("#btn-full").onclick = toggleFullscreen;
$("#btn-close").onclick = back;
for (const b of document.querySelectorAll("#bar button")) b.addEventListener("mouseup", () => wall.focus({ preventScroll: true }));
// Asked to close (phil: Esc while it had the keyboard): a camera filling the wall's window first.
onCloseRequest(() => (WALL && focused ? unfocusTile() : close()));
holdFocus(wall);

// ---------------------------------------------------------------- the wall

const note = $("#wall-message");
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
    <p class="hint">RTSP, or a web stream: MJPEG, HLS (.m3u8), MP4; an rtsp.me embed link too. A login goes in the URL (rtsp://user:password@…). A web page that isn't a stream is shown as the page.</p>
    <p class="error" hidden></p>
  </form>`;
// A page camera, over the wall, to use (Esc, or ×, back).
const pageView = document.createElement("div");
pageView.id = "wall-page";
pageView.hidden = true;
pageView.innerHTML = `<iframe allow="autoplay; fullscreen" referrerpolicy="no-referrer"></iframe><button type="button" class="icon close" title="Back to the wall (Esc)"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
pageView.querySelector(".close").onclick = () => closePage();
function showPage(camera) {
  pageView.querySelector("iframe").src = camera.page;
  pageView.hidden = false;
  pageView.querySelector(".close").focus();
}
function closePage() {
  pageView.hidden = true;
  pageView.querySelector("iframe").src = "about:blank";
  wall.focus({ preventScroll: true });
}

const listButton = document.createElement("button");
listButton.id = "wall-list-button";
listButton.type = "button";
listButton.className = "icon";
listButton.title = "All cameras: turn them on or off, add a stream (L)";
listButton.innerHTML = `<svg viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>`;
if (WALL) document.body.append(listButton, panel);
document.body.append(pageView);

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

// The tiles, as the cameras shown now are: each kept (playing on) while its
// camera is, by id; new ones started, gone ones stopped.
function renderTiles(cameras) {
  const old = new Map(tiles.map((t) => [t.camera.id, t]));
  tiles.length = 0;
  for (const c of cameras) {
    let t = old.get(c.id);
    if (t) old.delete(c.id), (t.camera = { ...c, profile: t.camera.profile ?? c.profile }), showTileName(t);
    else (t = makeTile(c)), (t.fresh = true);
    tiles.push(t);
  }
  for (const t of old.values()) stop(t), t.el.remove();
  if (focused && !tiles.includes(focused)) unfocusTile(); // (filling the window, and gone)
  for (const t of tiles) wall.append(t.el); // (in place already: stays)
  for (const t of tiles.filter((t) => t.fresh)) (t.fresh = false), start(t);
  note.hidden = tiles.length > 0;
  if (!tiles.length) note.textContent = WALL ? "No cameras to show: the list (top right) has those turned off or offline, and adds streams." : "No cameras found on the network.";
  layout();
}

// The cameras to show: every one that's on (the wall), or the one asked for: its id ("host:port",
// from phil's sidebar), or its name or address (camview's command line), or the first.
async function refresh() {
  try {
    const list = await api("api/cameras");
    if (WALL) renderTiles(list);
    else {
      const camera = pickCamera(list, params.get("camera"));
      renderTiles(camera ? [camera] : []);
      if (camera) focusTile(tiles[0]);
    }
  } catch (err) {
    note.hidden = false;
    note.textContent = err.message;
  }
  if (WALL && !panel.hidden) renderRows(await api("api/cameras/all").catch(() => null));
}

function pickCamera(list, wanted) {
  if (!list.length) return null;
  if (!wanted) return list[0];
  const w = wanted.toLowerCase();
  const c = list.find((c) => c.id === wanted) ?? list.find((c) => c.name.toLowerCase() === w || c.host === wanted)
    ?? list.find((c) => c.name.toLowerCase().includes(w));
  if (!c) throw new Error(`No camera called ${wanted}`);
  return c;
}

// ---------------------------------------------------------------- the wall's list

const STATES = { on: "", offline: "offline", off: "off" };
const KINDS = { network: "", cloud: "cloud", stream: "stream", page: "web page" };

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
  row.innerHTML = `<label class="switch"><input type="checkbox"><span></span></label><div class="what"><span class="name"></span><span class="detail"></span></div><button type="button" class="settings-button" title="Its settings: name, stream, buffer">Settings</button><button type="button" class="remove"></button><div class="settings" hidden></div>`;
  row.querySelector(".settings-button").onclick = () => toggleSettings(row);
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

// A camera's settings, under its row in the list: its name, which of its streams, its buffer
// (mpv's: automatic, or how many seconds read ahead), upside down (one that turns). Each
// change kept (cameras.json) and its tile playing as it says at once.
const BUFFER_CHOICES = [
  ["auto", "Automatic (none on this network, 1 s over the internet)"],
  [0, "None: as it comes (the quickest; a network's hiccups show)"],
  [0.3, "0.3 s"], [0.5, "0.5 s"], [1, "1 s"], [2, "2 s"], [5, "5 s (the smoothest)"],
];

async function toggleSettings(row) {
  const box = row.querySelector(".settings");
  box.hidden = !box.hidden;
  row.querySelector(".settings-button").classList.toggle("on", !box.hidden);
  if (box.hidden) return;
  const c = row.camera;
  box.innerHTML = `<label>Name <input type="text" class="s-name" spellcheck="false" autocomplete="off"></label>
    <label class="s-stream-label" hidden>Stream <select class="s-stream"></select></label>
    <label>Buffer <select class="s-buffer"></select></label>
    <label class="check s-invert-label" hidden><input type="checkbox" class="s-invert"> Upside down (pan and tilt turned around)</label>`;
  const name = box.querySelector(".s-name"), stream = box.querySelector(".s-stream"), buffer = box.querySelector(".s-buffer"), invert = box.querySelector(".s-invert");
  name.value = c.name;
  buffer.replaceChildren(...BUFFER_CHOICES.map(([v, label]) => new Option(label, String(v))));
  buffer.value = String(c.buffer ?? "auto");
  invert.checked = !!c.invert;
  const change = async (changes) => {
    const saved = await api("api/camera", { method: "PUT", body: JSON.stringify({ id: c.id, ...changes }) }).catch((err) => (showMessage(err.message, { toast: true }), null));
    if (!saved) return;
    Object.assign(c, changes);
    const t = tiles.find((t) => t.camera.id === c.id);
    if (t) {
      Object.assign(t.camera, changes);
      if ("profile" in changes) t.profile = changes.profile;
      if ("name" in changes) showTileName(t);
      if ("profile" in changes || "buffer" in changes) play(t); // (as it says now)
    }
    if ("name" in changes) row.querySelector(".name").textContent = changes.name;
  };
  name.onchange = () => name.value.trim() && change({ name: name.value.trim() });
  name.onkeydown = (e) => e.key === "Enter" && name.blur();
  buffer.onchange = () => change({ buffer: buffer.value === "auto" ? "auto" : Number(buffer.value) });
  stream.onchange = () => change({ profile: stream.value });
  invert.onchange = () => change({ invert: invert.checked });
  // Its streams and whether it turns: asked of it (an offline one: just the rest).
  if (c.state === "off" || c.kind === "page") return;
  const info = await api(`api/camera?id=${encodeURIComponent(c.id)}`).catch(() => null);
  const profiles = info?.profiles ?? [];
  if (profiles.length > 1) {
    stream.replaceChildren(...profiles.map((p) => new Option(p.width ? `${p.width}×${p.height}` : p.name, p.token)));
    const sized = profiles.filter((p) => p.width).sort((a, b) => b.width * b.height - a.width * a.height);
    stream.value = profiles.some((p) => p.token === c.profile) ? c.profile : (sized[0] ?? profiles[0]).token;
    box.querySelector(".s-stream-label").hidden = false;
  }
  box.querySelector(".s-invert-label").hidden = !info?.ptz;
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

// ---------------------------------------------------------------- start

document.title = WALL ? "Cameras — camview" : "camview";
await refresh();
wall.focus({ preventScroll: true });
ready(); // the window appears (or, inside phil, gets the keyboard)
