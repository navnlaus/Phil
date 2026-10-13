import { closeWindow, holdFocus, onCloseRequest, ready, tooltips } from "../engine/ui/kit.js";

tooltips(); // the page's own, in the theme's style (kit.js)

const $ = (sel) => document.querySelector(sel);
const video = $("#video");
const stage = $("#stage");
const message = $("#message");

const MOVE_REPEAT_MS = 500; // a held move is repeated this often (the server stops it 1.5 s after the last)
// Kept close to live: a little behind, it plays a little faster until it's
// caught up; far behind (a pause, the window hidden), it jumps (a jump lands
// between the camera's full frames, so it shows nothing right for a moment).
const CATCH_UP_S = 0.8, CAUGHT_UP_S = 0.35, JUMP_S = 4;
const STALL_MS = 8000; // no video for this long: connect again

const state = {
  id: null,
  info: null, // {camera, profiles, ptz}
  profile: null, // the stream's token
  presets: [],
  player: null, // the stream being played (see play)
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

// The camera's stream as fragmented MP4 (the server's ffmpeg copies it, no
// re-encoding), fed to a Media Source as it comes, kept close to live (see
// CATCH_UP_S). Connects again when the stream ends or stalls.
function play() {
  stopPlayer();
  const player = (state.player = { abort: new AbortController(), lastData: Date.now(), retry: 0 });
  showMessage("Connecting…");
  run(player).catch((err) => {
    if (player !== state.player || player.abort.signal.aborted) return;
    showMessage(`${err.message}\nTrying again…`);
    player.retryTimer = setTimeout(() => player === state.player && play(), 3000);
  });
}

function stopPlayer() {
  const p = state.player;
  if (!p) return;
  state.player = null;
  p.abort.abort();
  clearTimeout(p.retryTimer);
  clearInterval(p.watch);
  if (video.src) URL.revokeObjectURL(video.src);
  video.removeAttribute("src");
  video.load();
}

async function run(player, transcode = false) {
  const res = await fetch(`stream?id=${encodeURIComponent(state.id)}&profile=${encodeURIComponent(state.profile ?? "")}${transcode ? "&transcode=1" : ""}`, { signal: player.abort.signal });
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  const reader = res.body.getReader();
  // The start of the stream (up to its codec description), for the codec it has.
  let head = new Uint8Array(0), codec = null;
  while (!codec) {
    const { value, done } = await reader.read();
    if (done) throw new Error("The camera's stream ended");
    head = concat(head, value);
    codec = codecOf(head);
    if (head.length > 4_000_000) throw new Error("Can't tell what the camera's video is");
  }
  const type = `video/mp4; codecs="${codec}"`;
  if (!globalThis.MediaSource?.isTypeSupported(type)) {
    if (!transcode && codec.startsWith("h")) { // H.265: converted to H.264 on the way (costs the server some CPU)
      player.abort.abort();
      const again = { ...player, abort: new AbortController() };
      state.player = again;
      return run(again, true);
    }
    throw new Error(`This window can't play the camera's video (${codec})`);
  }
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
      else if (behind > JUMP_S) video.currentTime = Math.max(start, end - 0.5);
      else if (behind > CATCH_UP_S) video.playbackRate = 1.25;
      else if (behind < CAUGHT_UP_S) video.playbackRate = 1;
      // What's well behind isn't needed: dropped now and then, so the buffer stays small.
      if (video.currentTime - b.start(0) > 30 && Date.now() - trimmed > 10000) {
        trimmed = Date.now();
        return buffer.remove(0, video.currentTime - 10);
      }
    }
    pump();
  });
  video.play().catch(() => {});
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
    save(`profile.${state.id}`, state.profile);
    play();
    stage.focus({ preventScroll: true });
  };
  if (ptz) {
    $("#ptz").hidden = false;
    $("#zoom").hidden = !ptz.zoom;
    $("#presets").hidden = !ptz.presets;
    if (ptz.presets) loadPresets();
  }
  play();
} catch (err) {
  showMessage(err.message);
}
ready(); // the window appears (or, inside phil, gets the keyboard)
