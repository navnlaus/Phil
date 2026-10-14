import { closeWindow, holdFocus, onCloseRequest, ready, tooltips } from "../engine/ui/kit.js";
import { playHls } from "./hls.js";

tooltips(); // the page's own, in the theme's style (kit.js)

const $ = (sel) => document.querySelector(sel);
const video = $("#video");
const stage = $("#stage");
const message = $("#message");

const MOVE_REPEAT_MS = 500; // a held move is repeated this often (the server stops it 1.5 s after the last)
// Played at its own pace, never faster to catch up: in WebKit a change of
// speed restarts the player, which stalls it, so it falls further behind.
// Only when it's this far behind (the window was hidden, say) it jumps ahead
// (landing between the camera's full frames, it shows nothing right for a moment).
const JUMP_S = 3;
const STALL_MS = 8000; // no video for this long: connect again

const state = {
  id: null,
  info: null, // {camera, profiles, ptz}
  profile: null, // the stream's token
  presets: [],
  player: null, // the stream being played (see play)
  mode: "copy", // how (see MODES)
  connects: 0, // streams started since the window opened (1: never reconnected)
  move: null, // {x, y, zoom}: under way
  moveTimer: 0,
  keys: new Set(), // arrow keys held
};

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json();
}

function showMessage(text, { toast = false } = {}) {
  clearTimeout(showMessage.timer);
  message.textContent = text;
  message.hidden = !text;
  message.classList.toggle("toast", toast);
  if (toast && text) showMessage.timer = setTimeout(() => (message.hidden = true), 4000);
}

// ---------------------------------------------------------------- the video

// How the stream is shown, best first (the server's /stream modes):
//   copy   the camera's own H.264, copied into fragmented MP4 for a Media
//          Source: costs nothing, decoded on the GPU
//   h264   re-encoded by the server as the plainest H.264 (some CPU there)
//   mjpeg  JPEG pictures one after another, in an <img>: no video player at all
// Each is checked once it plays (checkPicture): solid green, or no new frames,
// and the next one is tried. The one that works is kept while the window is
// open (not saved: once this machine's player is fixed, copy is tried again).
const MODES = ["copy", "h264", "mjpeg"];
const mjpeg = $("#mjpeg");

// The camera's stream, kept close to live (see JUMP_S). Connects again
// when the stream ends or stalls.
function play() {
  stopPlayer();
  const mode = MODES.includes(state.mode) ? state.mode : "copy";
  const player = (state.player = { abort: new AbortController(), lastData: Date.now(), retry: 0, mode, bytes: 0, jpegs: 0, started: Date.now() });
  state.connects++;
  showMessage("Connecting…");
  if (mode === "mjpeg") return showJpegs(player);
  video.hidden = false;
  mjpeg.hidden = true;
  if (!state.noHls) return tryHls(player);
  run(player).catch((err) => {
    if (player !== state.player || player.abort.signal.aborted) return;
    showMessage(`${err.message}\nTrying again…`);
    player.retryTimer = setTimeout(() => player === state.player && play(), 3000);
  });
}

// An HLS stream (a web camera's): played by hls.js in the page, as a browser does (hls.js);
// not HLS, or it gives up: /stream, as the others.
async function tryHls(player) {
  const handle = await playHls(video, state.id, state.profile, {
    onPlaying: () => player === state.player && showMessage(""),
    onGiveUp: (why) => {
      if (player !== state.player) return;
      log(`${state.id}: ${why}: trying ${player.mode}`);
      state.noHls = true;
      play();
    },
  }).catch(() => null);
  if (player !== state.player) return handle?.stop();
  if (!handle) return (state.noHls = true), play();
  player.hls = handle;
  player.mode = "hls";
}

function stopPlayer() {
  const p = state.player;
  if (!p) return;
  state.player = null;
  p.hls?.stop();
  p.abort.abort();
  clearTimeout(p.retryTimer);
  clearTimeout(p.checkTimer);
  clearInterval(p.watch);
  mjpeg.removeAttribute("src");
  if (video.src) URL.revokeObjectURL(video.src);
  video.removeAttribute("src");
  video.load();
}

const streamUrl = (mode) => `stream?id=${encodeURIComponent(state.id)}&profile=${encodeURIComponent(state.profile ?? "")}&mode=${mode}`;

// The next way of showing it, after `why` (logged, for finding out what this
// machine's player can do); the last one is kept regardless.
function nextMode(player, why) {
  const i = MODES.indexOf(player.mode);
  log(`${state.id}: ${player.mode} ${why}${i < MODES.length - 1 ? `: trying ${MODES[i + 1]}` : ""}`);
  if (i >= MODES.length - 1 || player !== state.player) return;
  state.mode = MODES[i + 1];
  play();
}

const log = (message) => fetch("api/log", { method: "POST", body: JSON.stringify({ message }) }).catch(() => {});

// Whether the picture is right, a few seconds into playing: not solid green (a
// decoder that gives nothing), and new frames coming (not frozen on the first).
function checkPicture(player) {
  const canvas = Object.assign(document.createElement("canvas"), { width: 48, height: 27 });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const sample = () => {
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) (r += d[i]), (g += d[i + 1]), (b += d[i + 2]);
      const n = d.length / 4;
      return { r: r / n, g: g / n, b: b / n };
    } catch {
      return null; // can't be read here: taken as right
    }
  };
  const frames = () => video.getVideoPlaybackQuality?.().totalVideoFrames ?? null;
  const first = { frames: frames(), time: video.currentTime };
  player.checkTimer = setTimeout(() => {
    if (player !== state.player) return;
    const c = sample(), now = frames();
    // Solid green on the screen; read back, sometimes exactly black (a camera's picture never is: its clock's on it).
    const green = c && ((c.g > 30 && c.r < 8 && c.b < 8) || c.r + c.g + c.b < 0.5);
    const frozen = first.frames !== null && now !== null && video.currentTime - first.time > 1.5 && now - first.frames < 3;
    if (green) return nextMode(player, `shows solid green (${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)})`);
    if (frozen) return nextMode(player, `shows no new frames (${now - first.frames} in ${(video.currentTime - first.time).toFixed(1)} s)`);
    if (!player.logged) (player.logged = true), log(`${state.id}: ${player.mode} plays (${video.videoWidth}×${video.videoHeight}${c ? `, average colour ${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)}` : ""}${now !== null ? `, ${now - (first.frames ?? 0)} frames` : ""})`);
  }, 3000);
}

// MJPEG: an <img> the server keeps sending pictures to.
function showJpegs(player) {
  video.hidden = true;
  mjpeg.hidden = false;
  mjpeg.onload = () => player === state.player && (player.jpegs++, showMessage(""), player.logged || ((player.logged = true), log(`${state.id}: mjpeg shows`)));
  mjpeg.onerror = () => {
    if (player !== state.player) return;
    showMessage("The camera's stream stopped\nTrying again…");
    player.retryTimer = setTimeout(() => player === state.player && play(), 3000);
  };
  mjpeg.src = streamUrl("mjpeg");
}

async function run(player) {
  const res = await fetch(streamUrl(player.mode), { signal: player.abort.signal });
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  const reader = res.body.getReader();
  // The start of the stream (up to its codec description), for the codec it has.
  let head = new Uint8Array(0), codec = null;
  while (!codec) {
    const { value, done } = await reader.read();
    if (done) throw new Error("The camera's stream ended");
    head = concat(head, value);
    codec = codecOf(head);
    // A fragment of video, and no H.264 or H.265 description before it: something else (a web
    // camera's MJPEG, say), which the page can't play as it is: re-encoded, next.
    if (!codec && hasBox(head, "moof")) return nextMode(player, "isn't H.264 or H.265");
    if (head.length > 4_000_000) throw new Error("Can't tell what the camera's video is");
  }
  const type = `video/mp4; codecs="${codec}"`;
  player.codec = codec;
  if (!globalThis.MediaSource?.isTypeSupported(type)) return nextMode(player, `can't be played here (${codec})`); // H.265, say
  const source = new MediaSource();
  video.src = URL.createObjectURL(source);
  await new Promise((resolve) => source.addEventListener("sourceopen", resolve, { once: true }));
  const buffer = source.addSourceBuffer(type);
  buffer.mode = "segments";
  const queue = [head];
  let trimmed = 0;
  const pump = () => {
    if (buffer.updating || !queue.length || player !== state.player) return;
    try {
      buffer.appendBuffer(queue.length > 1 ? concat(...queue.splice(0)) : queue.shift());
    } catch (err) {
      if (err.name === "QuotaExceededError") buffer.remove(0, Math.max(0, video.currentTime - 2));
      else throw err;
    }
  };
  buffer.addEventListener("updateend", () => {
    const b = buffer.buffered;
    if (b.length) {
      const start = b.start(b.length - 1), end = b.end(b.length - 1), behind = end - video.currentTime;
      if (video.currentTime < start) video.currentTime = start; // the start (it doesn't begin at 0), or past a gap
      else if (behind > JUMP_S) video.currentTime = Math.max(start, end - 0.3);
      // What's well behind isn't needed: dropped now and then, so the buffer stays small.
      if (video.currentTime - b.start(0) > 30 && Date.now() - trimmed > 10000) {
        trimmed = Date.now();
        return buffer.remove(0, video.currentTime - 10);
      }
    }
    pump();
  });
  video.play().catch(() => {});
  video.addEventListener("playing", () => player === state.player && !player.checkTimer && checkPicture(player), { once: true });
  // Stalled (the camera or the network gone quiet): connected again.
  player.watch = setInterval(() => {
    if (Date.now() - player.lastData > STALL_MS && player === state.player) play();
  }, 2000);
  showMessage("");
  pump();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("The camera's stream ended");
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

// ---------------------------------------------------------------- pan, tilt, zoom

const speed = () => Number($("#speed").value) || 0.5;

// Moving in a direction (each -1, 0 or 1), at the speed set; repeated while
// held, so the server's safety stop doesn't cut in. Stops with stopMove().
function startMove(dir) {
  const move = { x: (dir.x ?? 0) * speed(), y: (dir.y ?? 0) * speed(), zoom: (dir.zoom ?? 0) * speed() };
  if (state.move && state.move.x === move.x && state.move.y === move.y && state.move.zoom === move.zoom) return;
  state.move = move;
  document.body.classList.add("moving");
  clearInterval(state.moveTimer);
  const send = () => api("api/ptz", { method: "POST", body: JSON.stringify({ id: state.id, op: "move", ...state.move }) })
    .catch((err) => (showMessage(err.message, { toast: true }), stopMove()));
  send();
  state.moveTimer = setInterval(() => state.move && send(), MOVE_REPEAT_MS);
}

function stopMove() {
  clearInterval(state.moveTimer);
  document.body.classList.remove("moving");
  for (const b of document.querySelectorAll("#ptz .held")) b.classList.remove("held");
  if (!state.move) return;
  state.move = null;
  api("api/ptz", { method: "POST", body: JSON.stringify({ id: state.id, op: "stop" }) }).catch(() => {});
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
  const k = state.keys;
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

async function loadPresets() {
  state.presets = await api(`api/presets?id=${encodeURIComponent(state.id)}`).catch(() => []);
  const list = $("#preset-list");
  list.replaceChildren(...state.presets.map((p, i) => {
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
  stopMove();
  api("api/ptz", { method: "POST", body: JSON.stringify({ id: state.id, op: "goto", preset: p.token }) })
    .then(() => showMessage(`Going to ${p.name}`, { toast: true }), (err) => showMessage(err.message, { toast: true }));
}

async function removePreset(p) {
  if (!confirm(`Remove the saved position “${p.name}”?`)) return;
  try {
    await api("api/ptz", { method: "POST", body: JSON.stringify({ id: state.id, op: "remove", preset: p.token }) });
    await loadPresets();
  } catch (err) {
    showMessage(err.message, { toast: true });
  }
}

const presetForm = $("#preset-form"), presetName = $("#preset-name");
$("#btn-save-preset").onclick = () => {
  presetForm.hidden = false;
  presetName.value = `Position ${state.presets.length + 1}`;
  presetName.focus();
  presetName.select();
};
presetForm.onsubmit = async (e) => {
  e.preventDefault();
  const name = presetName.value.trim();
  presetForm.hidden = true;
  stage.focus({ preventScroll: true });
  if (!name) return;
  try {
    await api("api/ptz", { method: "POST", body: JSON.stringify({ id: state.id, op: "save", name }) });
    await loadPresets();
    showMessage(`Saved “${name}”`, { toast: true });
  } catch (err) {
    showMessage(err.message, { toast: true });
  }
};
presetName.onkeydown = (e) => {
  e.stopPropagation(); // typing here isn't moving the camera
  if (e.key === "Escape") e.preventDefault(), (presetForm.hidden = true), stage.focus({ preventScroll: true });
};
presetName.onblur = () => (presetForm.hidden = true);

// Upside down: the server turns pan and tilt around (cameras.json keeps it, for
// this camera, wherever it's shown).
function showInvert(on) {
  state.invert = !!on;
  const b = $("#btn-invert");
  b.setAttribute("aria-pressed", String(state.invert));
  b.classList.toggle("on", state.invert);
}

async function toggleInvert() {
  stopMove();
  try {
    const c = await api("api/camera", { method: "PUT", body: JSON.stringify({ id: state.id, invert: !state.invert }) });
    showInvert(c.invert);
    showMessage(c.invert ? "Controls turned around (upside down)" : "Controls the usual way", { toast: true });
  } catch (err) {
    showMessage(err.message, { toast: true });
  }
}

// ---------------------------------------------------------------- stats

// Over the video, top left (the chart button, or D): how it's shown, its
// frames per second and dropped frames, how far behind live it plays (what's
// buffered here and not shown yet; the camera's own encoding and the network
// before it come on top, a few hundred ms), the data coming in, and how often
// it had to connect again. Each second, while shown; remembered.
const statsBox = $("#stats");
const MODE_NAMES = { hls: "HLS, played here (hls.js)", copy: "camera's own", h264: "re-encoded H.264", mjpeg: "MJPEG pictures" };
let statsTimer = 0, last = null, statsLogged = 0;

function showStats(on) {
  statsBox.hidden = !on;
  $("#btn-stats").setAttribute("aria-pressed", String(on));
  $("#btn-stats").classList.toggle("on", on);
  save("stats", on ? "1" : "");
  clearInterval(statsTimer);
  last = null;
  if (on) updateStats(), (statsTimer = setInterval(updateStats, 1000));
}

function updateStats() {
  const p = state.player;
  if (!p) return (statsBox.textContent = "not connected");
  const quality = video.getVideoPlaybackQuality?.();
  const now = { t: performance.now(), frames: p.mode === "mjpeg" ? p.jpegs : quality?.totalVideoFrames ?? 0, bytes: p.bytes, player: p };
  const dt = last && last.player === p ? (now.t - last.t) / 1000 : 0;
  const fps = dt ? (now.frames - last.frames) / dt : null;
  const mbit = dt && p.mode !== "mjpeg" ? ((now.bytes - last.bytes) * 8) / dt / 1e6 : null;
  last = now;
  const b = video.buffered;
  const behind = p.mode !== "mjpeg" && b.length ? b.end(b.length - 1) - video.currentTime : null;
  const size = p.mode === "mjpeg" ? `${mjpeg.naturalWidth}×${mjpeg.naturalHeight}` : `${video.videoWidth}×${video.videoHeight}`;
  const up = Math.round((Date.now() - p.started) / 1000);
  // Every 10 s, also to phil's log (camview: ...): what this machine's player does, to look into.
  if (fps !== null && ++statsLogged % 10 === 0) {
    log(`${state.id}: stats ${p.mode} ${size} ${fps.toFixed(1)} fps, dropped ${quality?.droppedVideoFrames ?? "?"}, behind ${behind?.toFixed(2) ?? "-"} s, ${mbit?.toFixed(2) ?? "-"} Mbit/s, reconnects ${state.connects - 1}`);
  }
  statsBox.textContent = [
    `stream    ${MODE_NAMES[p.mode]}${p.codec ? ` (${p.codec})` : ""}`,
    `size      ${size}`,
    `fps       ${fps === null ? "…" : fps.toFixed(1)}${quality && p.mode !== "mjpeg" ? `   dropped ${quality.droppedVideoFrames}` : ""}`,
    behind !== null ? `behind    ${behind.toFixed(2)} s` : null,
    mbit !== null ? `data      ${mbit.toFixed(2)} Mbit/s` : null,
    `connected ${up < 120 ? `${up} s` : `${Math.round(up / 60)} min`}${state.connects > 1 ? `   reconnects ${state.connects - 1}` : ""}`,
  ].filter(Boolean).join("\n");
}

$("#btn-stats").onclick = () => showStats(statsBox.hidden);

// ---------------------------------------------------------------- the rest

async function snapshot() {
  showMessage("Taking a picture…", { toast: true });
  try {
    const { path } = await api("api/snapshot", { method: "POST", body: JSON.stringify({ id: state.id }) });
    showMessage(`Saved ${path.split("/").slice(-2).join("/")}`, { toast: true });
  } catch (err) {
    showMessage(err.message, { toast: true });
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

function close() {
  stopMove();
  stopPlayer();
  if (document.fullscreenElement) document.exitFullscreen();
  // Shown from the wall of cameras (wall.js): back to it (the parameters phil gave stay).
  const url = new URL(location.href);
  if (url.searchParams.get("from") === "wall") {
    url.searchParams.delete("camera");
    url.searchParams.delete("from");
    url.searchParams.set("wall", "1");
    return location.replace(url.href);
  }
  closeWindow();
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
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") e.preventDefault(), close();
    return;
  }
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const handled = () => e.preventDefault();
  if (state.info?.ptz && (ARROWS.has(key) || ((key === "+" || key === "=" || key === "-") && state.info.ptz.zoom))) {
    if (!e.repeat) state.keys.add(key === "=" ? "+" : key), keyMove();
    return handled();
  }
  if (key === " ") return stopMove(), handled();
  if (/^[1-9]$/.test(key) && state.presets[Number(key) - 1]) return gotoPreset(state.presets[Number(key) - 1]), handled();
  if (key === "f") return toggleFullscreen(), handled();
  if (key === "s") return snapshot(), handled();
  if (key === "i" && state.info?.ptz) return toggleInvert(), handled();
  if (key === "d") return showStats(statsBox.hidden), handled();
  if (key === "q" && state.info?.profiles.length > 1) {
    const q = $("#quality");
    q.selectedIndex = (q.selectedIndex + 1) % q.options.length;
    q.onchange();
    return handled();
  }
  if (key === "Escape") {
    if (document.fullscreenElement) document.exitFullscreen();
    else close();
    return handled();
  }
});
document.addEventListener("keyup", (e) => {
  const key = e.key === "=" ? "+" : e.key;
  if (state.keys.delete(key)) keyMove();
});
addEventListener("blur", () => state.keys.clear());

$("#btn-snap").onclick = snapshot;
$("#btn-invert").onclick = toggleInvert;
$("#btn-full").onclick = toggleFullscreen;
$("#btn-close").onclick = close;
stage.ondblclick = toggleFullscreen;
for (const b of document.querySelectorAll("#bar button")) b.addEventListener("mouseup", () => stage.focus({ preventScroll: true }));
onCloseRequest(close);
holdFocus(stage);

// ---------------------------------------------------------------- start

// The camera asked for: its id ("host:port", from phil's sidebar), or its
// name or address (camview's command line), or the first one.
async function pickCamera(wanted) {
  const list = await api("api/cameras");
  if (!list.length) throw new Error("No cameras found on the network.");
  if (!wanted) return list[0];
  const w = wanted.toLowerCase();
  const c = list.find((c) => c.id === wanted) ?? list.find((c) => c.name.toLowerCase() === w || c.host === wanted)
    ?? list.find((c) => c.name.toLowerCase().includes(w));
  if (!c) throw new Error(`No camera called ${wanted}`);
  return c;
}

try {
  const camera = await pickCamera(new URLSearchParams(location.search).get("camera"));
  state.id = camera.id;
  $("#name").textContent = camera.name;
  document.title = `${camera.name} — camview`;
  state.info = await api(`api/camera?id=${encodeURIComponent(state.id)}`);
  const { profiles, ptz } = state.info;
  $("#info").textContent = [camera.model, camera.host].filter(Boolean).join(" · ");
  const quality = $("#quality");
  quality.replaceChildren(...profiles.map((p) => new Option(p.width ? `${p.width}×${p.height}` : p.name, p.token)));
  quality.hidden = profiles.length < 2;
  state.profile = profiles.some((p) => p.token === load(`profile.${state.id}`, "")) ? load(`profile.${state.id}`, "") : profiles[0].token;
  quality.value = state.profile;
  quality.onchange = () => {
    state.profile = quality.value;
    state.noHls = false; // another stream: HLS maybe
    save(`profile.${state.id}`, state.profile);
    play();
    stage.focus({ preventScroll: true });
  };
  if (ptz) {
    $("#ptz").hidden = false;
    showInvert(camera.invert);
    $("#btn-invert").hidden = false;
    $("#zoom").hidden = !ptz.zoom;
    $("#presets").hidden = !ptz.presets;
    if (ptz.presets) loadPresets();
  }
  play();
  if (load("stats", "") || new URLSearchParams(location.search).get("stats") === "1") showStats(true);
} catch (err) {
  showMessage(err.message);
}
ready(); // the window appears (or, inside phil, gets the keyboard)
