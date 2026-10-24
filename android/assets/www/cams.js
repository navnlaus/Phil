// The light phil's cameras: "Cams" in the bar. camview's cameras (the PC's
// list, kept by the app for when it's away), each a tile playing its small
// stream; a tap shows one over everything, its big stream (the small one on
// mobile data, unless asked), with its pan, tilt, zoom and saved positions.
// The video comes from the app (Cams.java): straight from the camera when it's
// on this network, else through the PC; the tile says which. Fragmented MP4 into
// a Media Source, kept close to live, as camview's page does.

const $ = (s, root = document) => root.querySelector(s);
const el = (tag, props = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter((c) => c != null));
  return e;
};

const BEHIND_S = 1.5; // further behind live than this: jumped ahead
const STALL_MS = 8000; // no video for this long: connected again
const RETRY_MS = 3000;
const MOVE_REPEAT_MS = 500; // a held move is repeated this often (the PC stops it 1.5 s after the last)
const SPEED = 0.6;

const c = {
  on: false, cameras: [], from: "pc", metered: false, loaded: false,
  tiles: new Map(), // id -> {camera, el, video, name, via, say, player}
  focused: null, // {camera, player, quality}
  move: null, moveTimer: null,
};

async function api(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body;
}

// ---------------------------------------------------------------- its streams

// The small stream (the narrowest) and the big one (the first: camview's best).
const small = (cam) => [...(cam.profiles ?? [])].sort((a, b) => (a.width || 1e9) - (b.width || 1e9))[0]?.token ?? "";
const big = (cam) => cam.profiles?.[0]?.token ?? "";
const qualityOf = (cam) => {
  try {
    const q = localStorage.getItem(`cam-quality:${cam.id}`);
    if (q === "hd" || q === "sd") return q;
  } catch { /* none kept */ }
  return c.metered ? "sd" : "hd";
};
const canPlay = (cam) => !cam.offline && (c.from === "pc" || cam.direct);

// Plays `cam`'s `profile` in `video`, telling `show({say, via})` how it goes;
// connects again when it ends or stalls. Returns {stop}.
function play(video, cam, profile, show) {
  const p = { abort: new AbortController(), lastData: Date.now(), stopped: false, retry: null, watch: null };
  const again = (why) => {
    if (p.stopped) return;
    clearInterval(p.watch);
    show({ say: `${why}: trying again…` });
    p.retry = setTimeout(() => {
      if (p.stopped) return;
      p.abort = new AbortController();
      run().catch(fail);
    }, RETRY_MS);
  };
  const fail = (err) => {
    if (!p.stopped && err.name !== "AbortError") again(err.message || "It stopped");
  };
  async function run() {
    show({ say: "Connecting…" });
    const res = await fetch(`/cams/stream?id=${encodeURIComponent(cam.id)}&profile=${encodeURIComponent(profile)}`, { signal: p.abort.signal });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `${res.status}`);
    show({ via: res.headers.get("x-via") });
    const reader = res.body.getReader();
    let head = new Uint8Array(0), codec = null;
    while (!codec) {
      const { value, done } = await reader.read();
      if (done) throw new Error("The stream ended");
      head = concat(head, value);
      codec = codecOf(head);
      if (!codec && head.length > 4_000_000) throw new Error("Can't tell what the video is");
    }
    const type = `video/mp4; codecs="${codec}"`;
    if (!globalThis.MediaSource?.isTypeSupported(type)) {
      p.stopped = true;
      return show({ say: `This phone can't play it (${codec})` });
    }
    const source = new MediaSource();
    video.src = URL.createObjectURL(source);
    await new Promise((resolve) => source.addEventListener("sourceopen", resolve, { once: true }));
    const buffer = source.addSourceBuffer(type);
    buffer.mode = "segments";
    const queue = [head];
    let trimmed = 0;
    const pump = () => {
      if (buffer.updating || !queue.length || p.stopped) return;
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
        const start = b.start(b.length - 1), end = b.end(b.length - 1);
        if (video.currentTime < start) video.currentTime = start;
        else if (end - video.currentTime > BEHIND_S) video.currentTime = Math.max(start, end - 0.2);
        if (video.currentTime - b.start(0) > 20 && Date.now() - trimmed > 10000) {
          trimmed = Date.now();
          return buffer.remove(0, video.currentTime - 5);
        }
      }
      pump();
    });
    video.play().catch(() => {});
    video.addEventListener("playing", () => show({ say: "" }), { once: true });
    p.watch = setInterval(() => {
      if (Date.now() - p.lastData > STALL_MS && !p.stopped) {
        p.abort.abort();
        again("No video");
      }
    }, 2000);
    pump();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("The stream ended");
      p.lastData = Date.now();
      queue.push(value);
      pump();
    }
  }
  run().catch(fail);
  return {
    stop() {
      p.stopped = true;
      clearTimeout(p.retry);
      clearInterval(p.watch);
      p.abort.abort();
      video.removeAttribute("src");
      video.load();
    },
  };
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of parts) out.set(x, at), (at += x.length);
  return out;
}

// The codec string of an MP4's video, from its avcC (H.264) or hvcC (H.265) box; null before it's there.
function codecOf(bytes) {
  const find = (a, b, c2, d) => bytes.findIndex((x, i) => x === a && bytes[i + 1] === b && bytes[i + 2] === c2 && bytes[i + 3] === d);
  const avc = find(0x61, 0x76, 0x63, 0x43);
  if (avc >= 0 && bytes.length > avc + 8) {
    const hex = (n) => n.toString(16).padStart(2, "0");
    return `avc1.${hex(bytes[avc + 5])}${hex(bytes[avc + 6])}${hex(bytes[avc + 7])}`;
  }
  const hvc = find(0x68, 0x76, 0x63, 0x43);
  if (hvc >= 0 && bytes.length > hvc + 20) return `hvc1.${bytes[hvc + 5] & 0x1f}.4.L${bytes[hvc + 16]}.B0`;
  return null;
}

const VIA = { direct: "Direct", pc: "Through the PC" };
// (A video with nothing to show yet: nothing, not the WebView's grey play button.)
const NO_POSTER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
$("#cam-video").poster = NO_POSTER;

// ---------------------------------------------------------------- the wall

function show(on, { push = true } = {}) {
  if (c.on === on) return;
  c.on = on;
  if (on) globalThis.philMusic?.off();
  document.body.classList.toggle("cams-view", on);
  $("#cams").hidden = !on;
  globalThis.philViews?.update();
  // The whole screen (the system's bars too: a swipe shows them; Back goes to the files).
  globalThis.Phil?.fullScreen?.(on);
  if (on) {
    if (push) history.pushState({ cams: true }, "");
    $("#title").textContent = "Cams";
    $("#path").textContent = "";
    $("#up").disabled = true;
    render();
    load();
  } else {
    unfocus({ back: false });
    for (const t of c.tiles.values()) stopTile(t);
    globalThis.philFiles?.render();
  }
}

async function load() {
  try {
    const list = await api("/cams/list");
    c.cameras = list.cameras;
    c.from = list.from;
    c.metered = list.metered;
  } catch (err) {
    c.error = err.message;
  }
  c.loaded = true;
  render();
}

// The tiles, one a camera, kept by its id (one already playing plays on).
function render() {
  if (!c.on) return;
  $("#path").textContent = c.from === "kept" ? "PC away" : "";
  const box = $("#cams");
  if (!c.loaded) return box.replaceChildren(el("p", { className: "m-empty", textContent: "Asking for the cameras…" }));
  if (!c.cameras.length) {
    return box.replaceChildren(el("p", {
      className: "m-empty",
      textContent: c.error ?? (c.from === "kept" ? "The PC isn't in reach, and no cameras are kept from it yet." : "No cameras on the PC (camview finds them, or adds them by address)."),
    }));
  }
  const ids = new Set(c.cameras.map((cam) => cam.id));
  for (const [id, t] of c.tiles) if (!ids.has(id)) (stopTile(t), t.el.remove(), c.tiles.delete(id));
  const grid = box.querySelector(".cam-grid") ?? el("div", { className: "cam-grid" });
  if (!grid.isConnected) box.replaceChildren(grid);
  let note = box.querySelector(".cam-note");
  const noteText = c.from === "kept" ? "The PC isn't in reach: only the cameras on this network play." : "";
  if (noteText && !note) box.prepend((note = el("p", { className: "cam-note" })));
  if (note) (note.textContent = noteText), (note.hidden = !noteText);
  for (const [i, cam] of c.cameras.entries()) {
    let t = c.tiles.get(cam.id);
    if (!t) {
      t = tile(cam);
      c.tiles.set(cam.id, t);
    }
    const changed = JSON.stringify(t.camera) !== JSON.stringify(cam);
    t.camera = cam;
    t.name.textContent = cam.name;
    if (grid.children[i] !== t.el) grid.insertBefore(t.el, grid.children[i] ?? null); // (in the list's order)
    if (!canPlay(cam)) {
      stopTile(t);
      t.say.textContent = cam.offline ? "Offline" : "Needs the PC";
      t.via.textContent = "";
      t.el.classList.add("off");
    } else {
      t.el.classList.remove("off");
      if (changed && t.player) stopTile(t);
      if (!t.player && t.seen && !c.focused) startTile(t);
    }
  }
  fitGrid();
}

// The tiles filling the screen: as many across as makes the pictures (16:9) biggest.
function fitGrid() {
  const grid = $("#cams .cam-grid");
  const n = grid?.children.length ?? 0;
  if (!n) return;
  const W = innerWidth, H = innerHeight;
  let best = 1, area = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols), w = Math.min(W / cols, (H / rows) * 16 / 9);
    if (w * w > area) (area = w * w), (best = cols);
  }
  grid.style.gridTemplateColumns = `repeat(${best}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${Math.ceil(n / best)}, minmax(0, 1fr))`;
}
addEventListener("resize", () => c.on && fitGrid());

function tile(cam) {
  const t = { camera: cam, player: null, seen: false };
  t.video = el("video", { muted: true, playsInline: true, autoplay: true, poster: NO_POSTER });
  t.video.muted = true;
  t.name = el("span", { className: "cam-name" });
  t.via = el("span", { className: "cam-via" });
  t.say = el("span", { className: "cam-say" });
  t.el = el("button", { className: "cam-tile" }, t.video, t.say, el("span", { className: "cam-label" }, t.name, t.via));
  t.el.onclick = () => canPlay(t.camera) && focus(t.camera);
  seen.observe(t.el);
  t.el.philTile = t;
  return t;
}

function startTile(t) {
  if (t.player || !canPlay(t.camera)) return;
  t.player = play(t.video, t.camera, small(t.camera), ({ say, via }) => {
    if (say !== undefined) t.say.textContent = say;
    if (via !== undefined) t.via.textContent = VIA[via] ?? "";
  });
}

function stopTile(t) {
  t.player?.stop();
  t.player = null;
}

// Only the tiles on the screen play.
const seen = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const t = e.target.philTile;
    if (!t) continue;
    t.seen = e.isIntersecting;
    if (!c.on || c.focused) continue;
    if (t.seen) startTile(t);
    else stopTile(t);
  }
}, { rootMargin: "100px" });

// ---------------------------------------------------------------- one camera

function focus(cam) {
  for (const t of c.tiles.values()) stopTile(t);
  c.focused = { camera: cam, player: null, quality: qualityOf(cam) };
  history.pushState({ cams: true, cam: cam.id }, "");
  const view = $("#cam-view");
  view.hidden = false;
  showControls(3000); // (its name and controls a moment, then just the picture)
  $("#cam-view-name").textContent = cam.name;
  const q = $("#cam-quality");
  q.hidden = small(cam) === big(cam);
  view.classList.toggle("ptz", !!cam.ptz && c.from === "pc");
  $("#cam-zoom").hidden = !cam.ptz?.zoom;
  $("#cam-presets").replaceChildren();
  if (cam.ptz && c.from === "pc") {
    api(`/cams/presets?id=${encodeURIComponent(cam.id)}`).then(({ presets }) => {
      if (c.focused?.camera !== cam) return;
      $("#cam-presets").replaceChildren(...presets.map((p) => {
        const b = el("button", { textContent: p.name });
        b.onclick = () => ptz({ op: "goto", preset: p.token }).catch((err) => toast(err.message));
        return b;
      }));
    }, () => {});
  }
  playFocused();
}

function playFocused() {
  const f = c.focused;
  f.player?.stop();
  $("#cam-quality").textContent = f.quality === "hd" ? "HD" : "SD";
  f.player = play($("#cam-video"), f.camera, f.quality === "hd" ? big(f.camera) : small(f.camera), ({ say, via }) => {
    if (say !== undefined) $("#cam-say").textContent = say;
    if (via !== undefined) $("#cam-via").textContent = VIA[via] ?? "";
  });
}

function unfocus({ back = true } = {}) {
  if (!c.focused) return;
  stopMove();
  c.focused.player?.stop();
  c.focused = null;
  $("#cam-view").hidden = true;
  $("#cam-say").textContent = $("#cam-via").textContent = "";
  if (c.on) for (const t of c.tiles.values()) if (t.seen) startTile(t);
  if (back) history.back();
}

$("#cam-close").onclick = () => history.back();

// Its controls (name, quality, pan and tilt) over the picture: shown by a tap, for a few
// seconds (while a move's held, till it's let go); the picture alone otherwise.
let controlsTimer = 0;
function showControls(ms = 4000) {
  $("#cam-view").classList.add("controls");
  clearTimeout(controlsTimer);
  controlsTimer = setTimeout(() => !c.move && $("#cam-view").classList.remove("controls"), ms);
}
$("#cam-view").addEventListener("click", (e) => {
  if (e.target.closest("button, #cam-presets")) return showControls();
  if ($("#cam-view").classList.contains("controls")) {
    clearTimeout(controlsTimer);
    $("#cam-view").classList.remove("controls");
  } else showControls();
});
$("#cam-quality").onclick = () => {
  const f = c.focused;
  f.quality = f.quality === "hd" ? "sd" : "hd";
  try {
    localStorage.setItem(`cam-quality:${f.camera.id}`, f.quality);
  } catch { /* not kept */ }
  playFocused();
};

// ---------------------------------------------------------------- pan, tilt, zoom (through the PC)

const ptz = (args) => api(`/cams/ptz?${new URLSearchParams({ id: c.focused.camera.id, ...args })}`);

function startMove(dir) {
  if (!c.focused) return;
  const move = { x: (dir.x ?? 0) * SPEED, y: (dir.y ?? 0) * SPEED, zoom: (dir.zoom ?? 0) * SPEED };
  c.move = move;
  clearInterval(c.moveTimer);
  const send = () => c.move && ptz({ op: "move", ...c.move }).catch((err) => (toast(err.message), stopMove()));
  send();
  c.moveTimer = setInterval(send, MOVE_REPEAT_MS);
}

function stopMove() {
  clearInterval(c.moveTimer);
  if (c.focused) showControls();
  for (const b of document.querySelectorAll("#cam-view .held")) b.classList.remove("held");
  if (!c.move) return;
  c.move = null;
  if (c.focused) ptz({ op: "stop" }).catch(() => {});
}

for (const b of document.querySelectorAll("#cam-view .dir")) {
  const dir = { x: Number(b.dataset.x ?? 0), y: Number(b.dataset.y ?? 0), zoom: Number(b.dataset.zoom ?? 0) };
  b.addEventListener("pointerdown", (e) => {
    b.setPointerCapture(e.pointerId);
    b.classList.add("held");
    startMove(dir);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) b.addEventListener(type, stopMove);
  b.addEventListener("contextmenu", (e) => e.preventDefault());
}

let toastTimer = null;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2500);
}

// ---------------------------------------------------------------- this phone as a camera

// Its settings (the gear's dialog): on or off, which camera, its resolution (every
// size the camera and the phone's encoder can do it at), how it is (watched; what
// went wrong), and its address.
let selfState = {};
const sizeName = (z) => {
  const [w, h] = z.split("x").map(Number);
  const wide = w * 9 === h * 16;
  const name = !wide ? "" : h >= 2160 ? "4K" : h >= 1440 ? "1440p" : h >= 1080 ? "1080p" : h >= 720 ? "720p" : h >= 480 ? "480p" : "";
  const ratio = wide ? "" : w * 3 === h * 4 ? " 4:3" : w === h ? " 1:1" : ` ${(w / h).toFixed(2)}:1`;
  return `${w} × ${h}${name || ratio ? ` (${[name, ratio.trim()].filter(Boolean).join(", ")})` : ""}`;
};
function showSelf(st = selfState) {
  selfState = st;
  const card = $("#cam-self");
  const sw = card.querySelector(".cs-switch");
  sw.setAttribute("aria-checked", String(!!st.on));
  sw.classList.toggle("on", !!st.on);
  for (const b of card.querySelectorAll("[data-front]")) b.classList.toggle("here", String(!!st.front) === b.dataset.front);
  // Its sizes: the camera's (back or front), asked for once each.
  const select = card.querySelector(".cs-size");
  const key = st.front ? "front" : "back";
  if (select.dataset.for !== key) {
    const sizes = JSON.parse(globalThis.Phil?.cameraSizes?.(!!st.front) ?? "[]");
    select.replaceChildren(...sizes.map((z) => el("option", { value: z, textContent: sizeName(z) })));
    select.dataset.for = key;
  }
  if (st.size) {
    if (![...select.options].some((o) => o.value === st.size)) select.append(el("option", { value: st.size, textContent: sizeName(st.size) }));
    select.value = st.size;
  }
  card.querySelector(".cs-status").textContent = st.error ? st.error
    : !st.on ? "Off: the PC's camview can show it when it's on"
    : st.watching ? `On: watched (${st.watching})` : "On: the camera opens when the PC watches";
  card.classList.toggle("error", !!st.error);
  // Its address (for VLC or another player; camview has it already): shown without its login, copied with it.
  const addr = card.querySelector(".cs-address");
  addr.hidden = !st.address;
  if (st.address) {
    addr.querySelector("code").textContent = st.address.replace(/\/\/[^@]*@/, "//");
    addr.querySelector("button").onclick = () => navigator.clipboard.writeText(st.address).then(() => toast("Copied (with its login)"), () => toast("Couldn't copy it"));
  }
}

const camera = (cmd) => globalThis.Phil && showSelf(JSON.parse(globalThis.Phil.camera(JSON.stringify(cmd))));
$("#cam-self .cs-switch").onclick = (e) => camera({ cmd: e.currentTarget.classList.contains("on") ? "off" : "on" });
for (const b of document.querySelectorAll("#cam-self [data-front]")) b.onclick = () => camera({ front: b.dataset.front === "true" });
$("#cam-self .cs-size").onchange = (e) => camera({ size: e.target.value });

// ---------------------------------------------------------------- with the rest

// (The view switch in the bar, app.js; the gear's dialog: this phone as a camera.)
globalThis.philCams = {
  on: () => show(true),
  off: () => show(false, { push: false }),
  showSelf: () => showSelf(JSON.parse(globalThis.Phil?.camera('{"cmd":"state"}') ?? "{}")),
};
// (Up does nothing here.)
$("#up").addEventListener("click", (e) => c.on && e.stopImmediatePropagation(), true);
addEventListener("popstate", (e) => {
  if (c.focused && e.state?.cam !== c.focused.camera.id) unfocus({ back: false });
  if (e.state?.cams) {
    if (!c.on) show(true, { push: false });
  } else if (c.on) show(false, { push: false });
});
// The app's news: the camera's state (CameraService), as it changes. Its notification tapped: this view.
const before = globalThis.philEvent;
globalThis.philEvent = (event) => {
  if (event.camera) return showSelf(event.camera);
  before?.(event);
};
globalThis.philShowCams = () => show(true);

// The app put away (or the screen off): nothing plays; back: the same again.
document.addEventListener("visibilitychange", () => {
  if (!c.on) return;
  if (document.hidden) {
    stopMove();
    for (const t of c.tiles.values()) stopTile(t);
    c.focused?.player?.stop();
  } else if (c.focused) playFocused();
  else {
    load();
    for (const t of c.tiles.values()) if (t.seen) startTile(t);
  }
});
