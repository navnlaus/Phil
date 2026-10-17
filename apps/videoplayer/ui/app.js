import { closeWindow, copyText, holdFocus, onCloseRequest, ready, tellParent, tooltips } from "../engine/ui/kit.js";

// The player. A video the browser plays itself is played from the file; one it
// can't (the server's probe says so, or it fails or shows no picture) from the
// server's /stream, ffmpeg making it into an MP4 as it plays: that one starts
// at `offset`, so its times here are offset + the element's, and seeking past
// what's come is a new stream from there.
//
// Keys: Space / K play and pause; ← → seek (settings.seekStep; with Shift,
// seekStepLong), J L 10 s; ↑ ↓ and the wheel the volume; M mutes; [ ] the speed,
// Backspace back to normal; , . a frame (paused); 0–9 to that tenth; Home the
// start; Page Up / Page Down the previous / next video in the folder; R repeats;
// C (Shift+C) the next (previous) crop; S subtitles on and off; F or a double-click fullscreen; Ctrl+C
// copies the path; Esc / Q closes.
//
// The settings (~/.config/phil/videoplayer.json, server.js DEFAULTS): the gear
// changes some; the file has them all. Nothing's kept in the page itself (no
// local storage); in incognito the server keeps what changes in memory only.

tooltips(); // the page's own, in the theme's style (kit.js)

const $ = (sel) => document.querySelector(sel);
const video = $("#video");
const stage = $("#stage");
const seekBar = $("#seek");
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const POSITION_EVERY_MS = 15_000; // where it is, told to the server while it plays

const state = {
  videos: [], // {path, name, size, mtime}
  index: -1,
  info: null, // the probe's: {duration, width, height, video, audio, direct}
  streaming: false, // playing /stream (not the file)
  offset: 0, // where that stream starts, in the video
  settings: {},
  incognito: false,
  token: 0, // the video being loaded; earlier loads finishing late are ignored
  seeking: null, // the time dragged to on the timeline
  crop: null, // the aspect ratio cropped to ("2.39:1"), or none
  subs: { tracks: [], track: null, cues: [], last: null }, // the video's subtitles, the one shown, its cues ([start, end, text]) so far, the one shown before
};

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json();
}
const put = (path, body) => fetch(path, { method: "PUT", body: JSON.stringify(body) }).catch(() => {});
const q = (path) => encodeURIComponent(path);

// ---------------------------------------------------------------- time

const now = () => (state.streaming ? state.offset : 0) + (video.currentTime || 0);
const duration = () => state.info?.duration ?? (Number.isFinite(video.duration) ? video.duration : 0);

function clock(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Goes to `t` seconds: in the file, in what the stream has, or a new stream from there. */
function seekTo(t) {
  const end = duration();
  t = Math.max(0, end ? Math.min(t, end - 0.05) : t);
  if (!state.streaming) {
    video.currentTime = t;
  } else {
    const rel = t - state.offset;
    const have = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0;
    if (rel >= 0 && rel <= have + 1) video.currentTime = rel;
    else startStream(t, !video.paused);
  }
  showTime();
}

// A copied video's stream starts at the keyframe before `t` (the server's
// seekpoint), and its offset is that.
let streamToken = 0;
async function startStream(t, play = true) {
  const token = ++streamToken, path = entry().path;
  state.streaming = true;
  state.offset = Math.max(0, t);
  if (t > 0) {
    const at = await fetch(`api/seekpoint?path=${q(path)}&t=${t.toFixed(3)}`).then((r) => r.json()).catch(() => null);
    if (token !== streamToken || entry().path !== path) return;
    if (typeof at?.t === "number") state.offset = at.t;
  }
  video.src = `stream?path=${q(path)}&t=${state.offset.toFixed(3)}`;
  if (play) video.play().catch(() => {});
  showInfo();
}

// ---------------------------------------------------------------- videos

const entry = () => state.videos[state.index];

async function show(index) {
  const e = state.videos[index];
  if (!e) return;
  savePosition();
  state.index = index;
  const token = ++state.token;
  $("#name").textContent = e.name;
  $("#count").textContent = state.videos.length > 1 ? `${index + 1} / ${state.videos.length}` : "";
  $("#info").textContent = "";
  document.title = e.name;
  $("#prev").disabled = index === 0;
  $("#next").disabled = index === state.videos.length - 1;
  for (const b of [$("#prev"), $("#next")]) b.classList.toggle("alone", state.videos.length < 2);
  tellParent({ app: "videoplayer", showing: e.path }); // shown in phil: it selects it
  showMessage("");
  spinner(true);
  setSubtitles([]);
  video.removeAttribute("src");
  video.load();

  let info, position;
  try {
    [info, { position }] = await Promise.all([api(`api/probe?path=${q(e.path)}`), api(`api/settings?path=${q(e.path)}`)]);
  } catch (err) {
    if (token !== state.token) return;
    spinner(false);
    return showMessage(`Can't play ${e.name}:\n${err.message}`, true);
  }
  if (token !== state.token) return;
  state.info = info;
  // Where it was left, unless that's nearly the end.
  const start = state.settings.resume && position && (!info.duration || position < info.duration - 10) ? position : 0;
  setSubtitles(info.subtitles ?? [], start);
  if (info.direct) {
    state.streaming = false;
    state.offset = 0;
    video.src = `file?path=${q(e.path)}`;
    if (start) video.addEventListener("loadedmetadata", () => (video.currentTime = start), { once: true });
    video.play().catch(() => {});
    // No picture after all (HEVC without the GPU's help), or nothing at all for a
    // while: the stream instead.
    setTimeout(() => {
      if (token === state.token && !state.streaming && video.readyState === 0) startStream(start);
    }, 8000);
  } else {
    startStream(start);
  }
  showInfo();
  showTime();
}

video.addEventListener("loadeddata", () => {
  if (!state.streaming && state.info?.video && video.videoWidth === 0) startStream(now(), !video.paused);
});
video.addEventListener("error", () => {
  if (!video.getAttribute("src")) return; // (emptied between videos)
  spinner(false);
  if (!state.streaming) return startStream(now());
  showMessage(`Can't play ${entry()?.name ?? "this video"} here.`, true);
});

function showInfo() {
  const e = entry(), info = state.info;
  if (!e || !info) return;
  $("#info").textContent = [
    info.width ? `${info.width} × ${info.height}` : "",
    formatSize(e.size),
    formatDate(e.mtime),
    state.streaming ? "converted as it plays" : "",
  ].filter(Boolean).join("   ·   ");
}

function step(dir) {
  const i = state.index + dir;
  if (i >= 0 && i < state.videos.length) show(i);
}

// Where it was left, for the next time (the server forgets it at the end).
let positionTimer = 0;
function savePosition() {
  const e = entry();
  if (!e || !state.info) return;
  const t = now(), end = duration();
  const done = end && (t > end - 10 || t / end > 0.97);
  put("api/position", { path: e.path, t: t < 5 || done ? null : t, done: !!done });
}
video.addEventListener("play", () => (clearInterval(positionTimer), (positionTimer = setInterval(savePosition, POSITION_EVERY_MS))));
video.addEventListener("pause", () => (clearInterval(positionTimer), savePosition()));
addEventListener("pagehide", savePosition);

video.addEventListener("ended", () => {
  // A stream that ended short of the end: ffmpeg couldn't go on.
  if (state.streaming && duration() && now() < duration() - 3) return showMessage(`Can't play ${entry()?.name ?? "this video"} further here.`, true);
  if (state.settings.loop) return seekTo(0), video.play().catch(() => {});
  savePosition();
  if (state.settings.playNext && state.index < state.videos.length - 1) step(1);
  else wake();
});

// ---------------------------------------------------------------- showing it

function showMessage(text, withMpv = false) {
  $("#message .text").textContent = text;
  $("#message").hidden = !text;
  $("#msg-mpv").hidden = !withMpv;
}

const spinner = (on) => ($("#spinner").hidden = !on);
video.addEventListener("waiting", () => spinner(true));
video.addEventListener("seeking", () => spinner(true));
for (const type of ["playing", "canplay", "pause", "seeked"]) video.addEventListener(type, () => spinner(video.readyState < 3 && !video.paused));

function showTime() {
  const t = state.seeking ?? now(), end = duration();
  $("#time").textContent = `${clock(t)} / ${clock(end)}`;
  $("#seek .played").style.width = end ? `${(t / end) * 100}%` : "0";
  let have = 0;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= video.currentTime + 1) have = video.buffered.end(i);
  }
  $("#seek .buffered").style.width = end ? `${Math.min(100, ((have + (state.streaming ? state.offset : 0)) / end) * 100)}%` : "0";
}
video.addEventListener("timeupdate", showTime);
video.addEventListener("progress", showTime);
video.addEventListener("durationchange", showTime);

function showPlaying() {
  document.body.classList.toggle("playing", !video.paused);
  $("#btn-play").title = video.paused ? "Play (Space)" : "Pause (Space)";
  wake();
}
video.addEventListener("play", showPlaying);
video.addEventListener("pause", showPlaying);

function showVolume() {
  document.body.classList.toggle("muted", video.muted || video.volume === 0);
  $("#volume").value = video.muted ? 0 : video.volume;
  $("#btn-mute").title = video.muted ? "Unmute (M)" : "Mute (M)";
}
video.addEventListener("volumechange", showVolume);

function showSpeed() {
  $("#btn-speed").textContent = `${video.playbackRate}×`;
  $("#btn-speed").classList.toggle("on", video.playbackRate !== 1);
}
video.addEventListener("ratechange", showSpeed);

function showLoop() {
  $("#btn-loop").classList.toggle("on", !!state.settings.loop);
  $("#btn-loop").title = state.settings.loop ? "Repeating (R)" : "Repeat (R)";
  $("#settings [name=loop]").checked = !!state.settings.loop;
}

// The bars float over the video and fade in when the pointer's on them (base.css),
// staying while a menu of theirs is open. The pointer hides after a while still,
// while it plays.
let idleTimer = 0;
function wake() {
  document.body.classList.remove("idle");
  clearTimeout(idleTimer);
  if (video.paused) return;
  idleTimer = setTimeout(() => {
    if (video.paused || document.querySelector(".overlay-bar:hover, #settings:hover, .menu:hover")) return;
    document.body.classList.add("idle");
  }, (state.settings.hideControlsAfter ?? 2) * 1000);
}
addEventListener("pointermove", wake);

// ---------------------------------------------------------------- cropping

// Cropped to an aspect ratio (as VLC's Video → Crop): the middle of the picture
// that shape, as large as the window takes; bars burnt into the video (a 2.39:1
// film in a 16:9 file) cut off. "fill": the window's own shape, so the picture fills
// it (a 2.39:1 film on a 16:9 screen: its sides cut). Kept from video to video while
// the player's open.
const CROPS = [null, "fill", "16:10", "16:9", "4:3", "1.85:1", "2:1", "2.21:1", "2.35:1", "2.39:1", "5:3", "5:4", "1:1"];
const ratioOf = (crop) => crop.split(":").reduce((w, h) => Number(w) / Number(h));
const cropBox = $("#crop");

// Lays the picture out: the crop's window centered in the stage, the video in it
// at the scale that fills it, centered.
function layoutCrop() {
  const W = stage.clientWidth, H = stage.clientHeight;
  const w = video.videoWidth, h = video.videoHeight;
  if (!state.crop || !w || !h) {
    Object.assign(cropBox.style, { left: "0", top: "0", width: "100%", height: "100%" });
    Object.assign(video.style, { left: "0", top: "0", width: "100%", height: "100%" });
    return;
  }
  const r = state.crop === "fill" ? W / H : ratioOf(state.crop);
  const cw = r > w / h ? w : h * r, ch = r > w / h ? w / r : h; // the part kept, in video pixels
  const s = Math.min(W / cw, H / ch);
  Object.assign(cropBox.style, { left: `${(W - cw * s) / 2}px`, top: `${(H - ch * s) / 2}px`, width: `${cw * s}px`, height: `${ch * s}px` });
  Object.assign(video.style, { left: `${((cw - w) / 2) * s}px`, top: `${((ch - h) / 2) * s}px`, width: `${w * s}px`, height: `${h * s}px` });
}
new ResizeObserver(layoutCrop).observe(stage);
video.addEventListener("loadedmetadata", layoutCrop);
video.addEventListener("resize", layoutCrop); // (its size known, or changed: a stream started)

function setCrop(crop) {
  state.crop = crop;
  $("#btn-crop").textContent = crop === "fill" ? "Fill" : crop ? `Crop ${crop}` : "Crop";
  $("#btn-crop").classList.toggle("on", !!crop);
  for (const li of $("#crop-menu").children) li.classList.toggle("on", li.dataset.crop === String(crop));
  layoutCrop();
}

function cycleCrop(dir) {
  setCrop(CROPS[(CROPS.indexOf(state.crop) + dir + CROPS.length) % CROPS.length]);
}

function toggleCropMenu(show = $("#crop-menu").hidden) {
  if (show) toggleSubsMenu(false);
  $("#crop-menu").hidden = !show;
  $("#controls").classList.toggle("show", show);
}

for (const crop of CROPS) {
  const li = document.createElement("li");
  li.dataset.crop = String(crop);
  li.textContent = crop === "fill" ? "Fill window" : crop ?? "None";
  li.onclick = () => (setCrop(crop), toggleCropMenu(false));
  $("#crop-menu").append(li);
}

// ---------------------------------------------------------------- subtitles

// The video's own (the server's probe) and the files that go with it (Movie.srt,
// Subs/English.srt), shown over the picture, at the bottom (#subs). The one shown
// first: settings.subtitles' language when it has one (what was chosen last), or
// "auto": a file named as the video, or the one the video says to show (often its
// forced ones: what's said in another language). The server sends a track's cues as
// it reads them, where it's playing first.

const languageNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
// ISO 639-2's bibliographic codes (Matroska's: "ger"), as the terminology ones Intl knows.
const B_CODES = { ger: "deu", fre: "fra", dut: "nld", chi: "zho", cze: "ces", gre: "ell", rum: "ron", slo: "slk", may: "msa", per: "fas", arm: "hye", baq: "eus", bur: "mya", geo: "kat", ice: "isl", mac: "mkd", mao: "mri", alb: "sqi", tib: "bod", wel: "cym", scc: "srp", scr: "hrv" };
function languageName(code) {
  code = String(code ?? "").toLowerCase();
  if (!/^[a-z]{2,3}$/.test(code) || code === "und") return "";
  try {
    return languageNames.of(B_CODES[code] ?? code) ?? "";
  } catch {
    return "";
  }
}
// Words in subtitle files' names that look like languages' codes and aren't.
const NOT_LANGUAGES = new Set(["sdh", "hi", "cc", "forced", "full", "sub", "subs", "the", "and", "of", "web", "rip", "dl"]);
const LANGUAGE_WORDS = new Map(["en", "es", "fr", "de", "it", "pt", "nl", "sv", "no", "da", "fi", "is", "pl", "cs", "sk", "sl", "hu", "ro", "bg", "ru", "uk", "el", "tr", "ar", "he", "hi", "th", "vi", "id", "ms", "zh", "ja", "ko", "et", "lv", "lt", "hr", "sr", "fa", "ta", "te", "ca"]
  .map((c) => [languageName(c).toLowerCase(), languageName(c)]));

// The menu's name for a track, and its language ("English"; for a file, from its name:
// Movie.en.srt, Subs/2_English.srt, Subs/SDH.eng.HI.srt).
function describe(track, videoName) {
  if (track.file) {
    const base = track.name.split("/").pop().replace(/\.[^.]+$/, "");
    const stem = videoName.replace(/\.[^.]+$/, "");
    const words = (base.toLowerCase().startsWith(stem.toLowerCase()) ? base.slice(stem.length) : base).toLowerCase().split(/[^a-z]+/).filter(Boolean);
    const code = (n) => words.filter((w) => w.length === n && !NOT_LANGUAGES.has(w)).map(languageName).find(Boolean);
    const language = code(3) ?? words.map((w) => LANGUAGE_WORDS.get(w)).find(Boolean) ?? code(2) ?? "";
    const forced = words.includes("forced"), sdh = words.some((w) => w === "sdh" || w === "hi" || w === "cc");
    const label = language ? [language, sdh ? "SDH" : "", forced ? "Forced" : ""].filter(Boolean).join(" · ") : track.name;
    return { ...track, id: `f${track.file}`, language, forced, label, what: language ? track.name : "" };
  }
  const language = languageName(track.lang), title = track.title;
  const label = title && language && title.toLowerCase().includes(language.toLowerCase())
    ? title
    : [language || "Unknown language", title, track.forced && !/forced/i.test(title) ? "Forced" : ""].filter(Boolean).join(" · ");
  return { ...track, id: `s${track.stream}`, language, label, what: track.text ? "" : "pictures" };
}

// The one to show first (settings.subtitles).
function chooseTrack(pref = state.settings.subtitles) {
  const text = state.subs.tracks.filter((t) => t.text);
  if (pref === "off") return null;
  if (pref && pref !== "auto") {
    const same = text.filter((t) => t.language === pref && !t.forced);
    const pick = same.find((t) => t.exact) ?? same.find((t) => t.default) ?? same[0];
    if (pick) return pick;
  }
  return text.find((t) => t.exact) ?? text.find((t) => t.default) ?? text.find((t) => t.forced) ?? null;
}

// A video's subtitles (the probe's, `at` where it starts): the menu, and the one shown first.
function setSubtitles(tracks, at = 0) {
  const name = entry()?.name ?? "";
  state.subs.tracks = tracks.map((t) => describe(t, name));
  state.subs.track = state.subs.last = null; // (the last video's)
  const item = (track) => {
    const li = document.createElement("li");
    li.dataset.id = track?.id ?? "";
    li.textContent = track ? track.label : "Off";
    if (track?.what) li.append(Object.assign(document.createElement("span"), { className: "what", textContent: track.what }));
    if (track && !track.text) li.classList.add("off"), (li.title = "Pictures, not text: not shown here (mpv shows them)");
    else li.onclick = () => (pickSubtitle(track), toggleSubsMenu(false));
    return li;
  };
  $("#subs-menu").replaceChildren(item(null), ...state.subs.tracks.map(item));
  $("#btn-subs").parentElement.hidden = !state.subs.tracks.length;
  showSubtitle(tracks.length ? chooseTrack() : null, at);
}

// Chosen (the menu, S): this one, and its language the one to show first from now on.
function pickSubtitle(track) {
  saveSettings({ subtitles: track ? track.language || "auto" : "off" });
  showSubtitle(track);
}

// S: the subtitles off, or back on (the ones shown before, or the language's, or the first).
function toggleSubtitles() {
  const { track, last, tracks } = state.subs;
  if (track) return pickSubtitle(null);
  const text = tracks.filter((t) => t.text);
  const pick = last ?? chooseTrack(state.subs.language ?? "auto") ?? text.find((t) => !t.forced) ?? text[0];
  if (pick) pickSubtitle(pick);
}

let subsJob = null;
async function showSubtitle(track, at = now()) {
  subsJob?.abort();
  subsJob = null;
  const subs = state.subs, cues = (subs.cues = []);
  if (subs.track) subs.last = subs.track;
  subs.track = track;
  if (track?.language) subs.language = track.language;
  for (const li of $("#subs-menu").children) li.classList.toggle("on", li.dataset.id === (track?.id ?? ""));
  $("#btn-subs").classList.toggle("on", !!track);
  $("#btn-subs").classList.remove("loading");
  $("#btn-subs").title = track ? `Subtitles: ${track.label} (S: off)` : "Subtitles (S: on)";
  showSubs();
  subsLoop();
  if (!track) return;
  const job = (subsJob = new AbortController()), path = entry().path;
  $("#btn-subs").classList.add("loading");
  const url = track.file
    ? `api/subtitle?path=${q(path)}&file=${q(track.file)}`
    : `api/subtitle?path=${q(path)}&stream=${track.stream}&from=${Math.max(0, at - 10).toFixed(1)}`;
  try {
    const res = await fetch(url, { signal: job.signal });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let rest = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const lines = (rest + value).split("\n");
      rest = lines.pop();
      for (const line of lines) if (line) cues.push(JSON.parse(line));
      cues.sort((a, b) => a[0] - b[0]); // (from where it plays, then the start)
      showSubs();
    }
    if (subsJob === job && !cues.length) $("#btn-subs").title = `Subtitles: ${track.label}: none found in it`;
  } catch (err) {
    if (job.signal.aborted) return;
    $("#btn-subs").title = `Subtitles: ${track.label}: can't read them: ${err.message}`;
  } finally {
    if (subsJob === job) $("#btn-subs").classList.remove("loading");
  }
}

// The cues of now, in #subs (only when they change). WebVTT's <i> <b> <u> kept, its other tags dropped.
const cueParser = new DOMParser();
let subsShown = "";
function showSubs() {
  const t = now(), on = state.subs.cues.filter((c) => c[0] <= t && t < c[1]);
  const key = on.map((c) => `${c[0]}\n${c[2]}`).join("\n\n");
  if (key === subsShown) return;
  subsShown = key;
  $("#subs").replaceChildren(...on.map(([, , text]) => {
    const div = document.createElement("div");
    div.className = "cue";
    const copy = (from, to) => {
      for (const n of from.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) to.append(n.textContent);
        else if (n.localName === "br") to.append("\n");
        else if (["i", "b", "u"].includes(n.localName)) copy(n, to.appendChild(document.createElement(n.localName)));
        else if (n.nodeType === Node.ELEMENT_NODE) copy(n, to);
      }
    };
    copy(cueParser.parseFromString(text.replace(/<\d[^>]*>/g, ""), "text/html").body, div);
    return div;
  }));
}

// Each frame while it plays (and on each seek, paused).
let subsFrame = 0;
function subsLoop() {
  cancelAnimationFrame(subsFrame);
  if (state.subs.track && !video.paused) subsFrame = requestAnimationFrame(() => (showSubs(), subsLoop()));
}
video.addEventListener("play", subsLoop);
for (const type of ["seeked", "timeupdate", "emptied"]) video.addEventListener(type, showSubs);

function toggleSubsMenu(show = $("#subs-menu").hidden) {
  if (show) toggleCropMenu(false);
  $("#subs-menu").hidden = !show;
  $("#controls").classList.toggle("show", show);
  if (show) $("#subs-menu li.on")?.scrollIntoView({ block: "nearest" });
}

// ---------------------------------------------------------------- doing things

const togglePlay = () => (video.paused ? video.play().catch(() => {}) : video.pause());

function setVolume(v) {
  video.volume = Math.max(0, Math.min(1, Math.round(v * 100) / 100));
  video.muted = false;
  saveSettings({ volume: video.volume, muted: false });
}

function toggleMute() {
  video.muted = !video.muted;
  if (!video.muted && video.volume === 0) video.volume = 0.5;
  saveSettings({ muted: video.muted, volume: video.volume });
}

function setSpeed(dir) {
  const i = SPEEDS.findIndex((s) => s >= video.playbackRate - 0.001);
  video.playbackRate = video.defaultPlaybackRate = dir === 0 ? 1 : SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i === -1 ? SPEEDS.length - 1 : i) + dir))];
}

function frame(dir) {
  video.pause();
  seekTo(now() + dir / 30);
}

function toggleLoop() {
  saveSettings({ loop: !state.settings.loop });
  showLoop();
}

let saveTimer = 0, unsaved = {};
function saveSettings(changed) {
  Object.assign(state.settings, changed);
  Object.assign(unsaved, changed);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => (put("api/settings", unsaved), (unsaved = {})), 500);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

function playInMpv() { // (what can't be played here)
  const e = entry();
  if (!e) return;
  video.pause();
  fetch("api/mpv", { method: "POST", body: JSON.stringify({ path: e.path, t: now() }) }).catch(() => {});
}

function close() {
  savePosition();
  video.pause();
  if (document.fullscreenElement) document.exitFullscreen();
  closeWindow();
}

function toggleSettings(show = $("#settings").hidden) {
  $("#settings").hidden = !show;
  $("#btn-settings").classList.toggle("on", show);
  $("#top").classList.toggle("show", show);
}

// ---------------------------------------------------------------- the timeline

const timeAt = (x) => {
  const r = seekBar.getBoundingClientRect();
  return Math.max(0, Math.min(1, (x - r.left) / r.width)) * duration();
};

function hoverTime(x) {
  const tip = $("#seek .hover-time"), r = seekBar.getBoundingClientRect();
  tip.hidden = false;
  tip.textContent = clock(timeAt(x));
  tip.style.left = `${Math.max(24, Math.min(r.width - 24, x - r.left))}px`;
}

seekBar.addEventListener("pointermove", (e) => hoverTime(e.clientX));
seekBar.addEventListener("pointerleave", () => !state.seeking && ($("#seek .hover-time").hidden = true));
seekBar.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !duration()) return;
  seekBar.setPointerCapture(e.pointerId);
  seekBar.classList.add("dragging");
  state.seeking = timeAt(e.clientX);
  showTime();
  const move = (ev) => {
    state.seeking = timeAt(ev.clientX);
    hoverTime(ev.clientX);
    if (!state.streaming) video.currentTime = state.seeking; // the file: as it's dragged
    showTime();
  };
  seekBar.addEventListener("pointermove", move);
  seekBar.addEventListener("pointerup", () => {
    seekBar.removeEventListener("pointermove", move);
    seekBar.classList.remove("dragging");
    const t = state.seeking;
    state.seeking = null;
    $("#seek .hover-time").hidden = true;
    seekTo(t);
  }, { once: true });
});

// ---------------------------------------------------------------- input

document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.altKey) return;
  if (e.target.closest?.("input, select, textarea, #settings") && e.key !== "Escape") return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const handled = () => (e.preventDefault(), wake());
  const s = state.settings;
  if (ctrl) {
    if (key === "c" && !getSelection().toString()) return copyText(entry()?.path ?? ""), handled();
    if (key === "w") return close(), handled();
    return;
  }
  if (key === " " || key === "k") return togglePlay(), handled();
  if (key === "ArrowLeft") return seekTo(now() - (e.shiftKey ? s.seekStepLong : s.seekStep)), handled();
  if (key === "ArrowRight") return seekTo(now() + (e.shiftKey ? s.seekStepLong : s.seekStep)), handled();
  if (key === "j") return seekTo(now() - 10), handled();
  if (key === "l") return seekTo(now() + 10), handled();
  if (key === "ArrowUp") return setVolume(video.volume + 0.05), handled();
  if (key === "ArrowDown") return setVolume(video.volume - 0.05), handled();
  if (key === "m") return toggleMute(), handled();
  if (key === "[") return setSpeed(-1), handled();
  if (key === "]") return setSpeed(1), handled();
  if (key === "Backspace") return setSpeed(0), handled();
  if (key === ",") return frame(-1), handled();
  if (key === ".") return frame(1), handled();
  if (/^[0-9]$/.test(key)) return seekTo((duration() * Number(key)) / 10), handled();
  if (key === "Home") return seekTo(0), handled();
  if (key === "PageUp") return step(-1), handled();
  if (key === "PageDown") return step(1), handled();
  if (key === "r") return toggleLoop(), handled();
  if (key === "c") return cycleCrop(e.shiftKey ? -1 : 1), handled();
  if (key === "s") return toggleSubtitles(), handled();
  if (key === "f") return toggleFullscreen(), handled();
  if (key === "Escape" || key === "q") {
    if (!$("#subs-menu").hidden) toggleSubsMenu(false);
    else if (!$("#crop-menu").hidden) toggleCropMenu(false);
    else if (!$("#settings").hidden) toggleSettings(false);
    else if (document.fullscreenElement) document.exitFullscreen();
    else close();
    stage.focus({ preventScroll: true });
    return e.preventDefault();
  }
});

// A click plays and pauses; a double-click (two clicks: unchanged) is fullscreen.
stage.addEventListener("click", () => {
  if (!$("#subs-menu").hidden) return toggleSubsMenu(false);
  if (!$("#crop-menu").hidden) return toggleCropMenu(false);
  if (!$("#settings").hidden) return toggleSettings(false);
  togglePlay();
});
stage.addEventListener("dblclick", toggleFullscreen);
stage.addEventListener("wheel", (e) => {
  e.preventDefault();
  setVolume(video.volume + (e.deltaY < 0 ? 0.05 : -0.05));
  wake();
}, { passive: false });

$("#btn-play").onclick = togglePlay;
$("#btn-mute").onclick = toggleMute;
$("#volume").oninput = (e) => setVolume(Number(e.target.value));
$("#btn-speed").onclick = (e) => setSpeed(e.shiftKey ? -1 : video.playbackRate >= SPEEDS.at(-1) ? 0 : 1);
$("#btn-speed").oncontextmenu = (e) => (e.preventDefault(), setSpeed(0));
$("#btn-loop").onclick = toggleLoop;
$("#btn-full").onclick = toggleFullscreen;
$("#btn-close").onclick = close;
$("#btn-crop").onclick = () => toggleCropMenu();
$("#btn-subs").onclick = () => toggleSubsMenu();
$("#msg-mpv").onclick = playInMpv;
$("#btn-settings").onclick = () => toggleSettings();
$("#prev").onclick = () => step(-1);
$("#next").onclick = () => step(1);
$("#settings").onchange = (e) => {
  saveSettings({ [e.target.name]: e.target.checked });
  showLoop();
};
for (const b of document.querySelectorAll("button")) b.addEventListener("mouseup", () => stage.focus({ preventScroll: true }));
onCloseRequest(close);
holdFocus(stage);

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes, i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

const formatDate = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

// ---------------------------------------------------------------- start

const params = new URLSearchParams(location.search);
const file = params.get("file");
try {
  const { settings, incognito, file: settingsFile } = await api("api/settings");
  state.settings = settings;
  state.incognito = incognito;
  video.volume = Math.max(0, Math.min(1, Number(settings.volume) || 0));
  video.muted = !!settings.muted;
  video.playbackRate = video.defaultPlaybackRate = Number(settings.speed) || 1; // (the default: kept from video to video)
  for (const name of ["resume", "playNext", "loop"]) $(`#settings [name=${name}]`).checked = !!settings[name];
  $("#settings .file").textContent = incognito
    ? "Incognito: what's changed here lasts until the window closes, and where videos were left isn't kept."
    : `These and more (seek steps, when the controls hide, how what's converted is): ${settingsFile}`;
} catch { /* the defaults */ }
showVolume();
showSpeed();
showLoop();
showPlaying();
if (!file) {
  showMessage("No video. Open one with: videoplayer <file>");
} else {
  try {
    const listing = await api(`api/videos?path=${q(file)}&sort=${params.get("sort") ?? "name"}`);
    state.videos = listing.videos;
    if (!state.videos.length) showMessage(`No videos in ${listing.dir}`);
    else show(listing.index);
  } catch (err) {
    showMessage(err.message);
  }
}
ready(); // the window appears (or, inside phil, gets the keyboard)
