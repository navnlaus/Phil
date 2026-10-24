// musicview: the songs in the folders marked as music (a folder's Properties in
// phil), by their tags (../library.js): albums with their covers, artists,
// songs, genres; an album's, an artist's or a genre's songs over the list.
// Played here, with a queue (Next up), shuffle and repeat; the media keys
// through the page's media session. And radio stations (../radio.js): SomaFM's,
// and any added by their address; what's playing on one, as it changes.
import { closeWindow, embedded, onCloseRequest, ready, tooltips } from "../engine/ui/kit.js";

tooltips();

const $ = (sel, root = document) => root.querySelector(sel);
const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const el = (tag, props = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter((c) => c != null));
  return e;
};

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw Object.assign(new Error((await res.text().then((t) => { try { return JSON.parse(t).error ?? t; } catch { return t; } })) || res.statusText), { status: res.status });
  return res.json();
}

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function keep(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* not kept */ }
}

const clock = (s) => {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};
const songName = (s) => s.title || s.path.split("/").pop().replace(/\.[^.]+$/, "");
const artistOf = (s) => s.albumArtist || s.artist || "Unknown artist";
const albumKey = (s) => `${artistOf(s)}\0${s.album || ""}`;
const coverUrl = (song) => (song?.cover ? `api/cover?path=${encodeURIComponent(song.path)}` : null);

const state = {
  songs: [], roots: [], stations: [], tab: "albums", sort: "name", filter: "", detail: null,
  albums: [], artists: [], genres: [],
};

// ---------------------------------------------------------------- the library

async function loadLibrary() {
  const lib = await api("api/library");
  state.songs = lib.songs;
  state.roots = lib.roots;
  showScan(lib.scanning);
  group();
  render();
}

// Albums (by their album artist, or artist, and name), artists, genres.
function group() {
  const albums = new Map(), artists = new Map(), genres = new Map();
  for (const s of state.songs) {
    const key = albumKey(s);
    const a = albums.get(key) ?? albums.set(key, { key, name: s.album || "Unknown album", artist: artistOf(s), year: null, songs: [], added: 0 }).get(key);
    a.songs.push(s);
    a.year ??= s.year;
    a.added = Math.max(a.added, s.added ?? 0);
    const ar = artists.get(artistOf(s)) ?? artists.set(artistOf(s), { name: artistOf(s), songs: [], albums: new Set() }).get(artistOf(s));
    ar.songs.push(s);
    ar.albums.add(key);
    for (const g of (s.genre || "No genre").split(/\s*[;,/]\s*/)) (genres.get(g) ?? genres.set(g, { name: g, songs: [] }).get(g)).songs.push(s);
  }
  for (const a of albums.values()) {
    a.songs.sort(trackOrder);
    a.cover = a.songs.find((s) => s.cover) ?? null;
  }
  state.albums = [...albums.values()];
  state.artists = [...artists.values()];
  state.genres = [...genres.values()];
}

const trackOrder = (a, b) => (a.disc ?? 1) - (b.disc ?? 1) || (a.track ?? 1e6) - (b.track ?? 1e6) || collator.compare(a.path, b.path);

function showScan(scan) {
  $(".mu-scan").textContent = scan ? (scan.total ? `Reading songs: ${scan.done} of ${scan.total}` : "Looking for songs…") : "";
  $(".mu-rescan").disabled = !!scan;
}

const matches = (text) => !state.filter || text.toLowerCase().includes(state.filter);

function render() {
  for (const b of $(".mu-tabs").children) b.setAttribute("aria-selected", String(b.dataset.tab === state.tab));
  const counts = { albums: state.albums.length, artists: state.artists.length, songs: state.songs.length, genres: state.genres.length, radio: state.stations.length };
  for (const b of $(".mu-tabs").children) $(".n", b).textContent = counts[b.dataset.tab] || "";
  $(".mu-sort").hidden = state.tab === "radio" || state.tab === "genres" || state.tab === "artists";
  const main = $(".mu-main");
  if (state.detail) return renderDetail();
  $(".mu-detail").hidden = true;
  main.hidden = false;
  const empty = $(".mu-empty");
  empty.hidden = true;
  if (state.tab !== "radio" && !state.songs.length) {
    main.replaceChildren();
    empty.hidden = false;
    empty.textContent = state.roots.length
      ? ($(".mu-scan").textContent ? "Looking for songs in the music folders…" : "No songs in the music folders.")
      : "No music folders yet. In phil, a folder's Properties: “A music folder”. Every song in it and its subfolders comes here.";
    return;
  }
  if (state.tab === "albums") return renderAlbums(main, sortAlbums(state.albums.filter((a) => matches(`${a.name} ${a.artist}`))));
  if (state.tab === "artists") return renderRows(main, state.artists.filter((a) => matches(a.name)).sort((a, b) => collator.compare(a.name, b.name)),
    (a) => [a.name, `${a.albums.size} album${a.albums.size === 1 ? "" : "s"} · ${a.songs.length} song${a.songs.length === 1 ? "" : "s"}`], (a) => openDetail({ kind: "artist", name: a.name }));
  if (state.tab === "genres") return renderRows(main, state.genres.filter((g) => matches(g.name)).sort((a, b) => collator.compare(a.name, b.name)),
    (g) => [g.name, `${g.songs.length} song${g.songs.length === 1 ? "" : "s"}`], (g) => openDetail({ kind: "genre", name: g.name }));
  if (state.tab === "songs") return renderSongs(main, sortSongs(state.songs.filter((s) => matches(`${songName(s)} ${s.artist ?? ""} ${s.album ?? ""}`))), { album: true });
  renderRadio(main);
}

function sortAlbums(list) {
  const by = {
    name: (a, b) => collator.compare(a.name, b.name),
    artist: (a, b) => collator.compare(a.artist, b.artist) || (a.year ?? 0) - (b.year ?? 0),
    year: (a, b) => (b.year ?? 0) - (a.year ?? 0),
    added: (a, b) => b.added - a.added,
  }[state.sort];
  return list.sort((a, b) => by(a, b) || collator.compare(a.name, b.name));
}

function sortSongs(list) {
  const by = {
    name: (a, b) => collator.compare(songName(a), songName(b)),
    artist: (a, b) => collator.compare(artistOf(a), artistOf(b)) || collator.compare(a.album ?? "", b.album ?? "") || trackOrder(a, b),
    year: (a, b) => (b.year ?? 0) - (a.year ?? 0) || trackOrder(a, b),
    added: (a, b) => (b.added ?? 0) - (a.added ?? 0),
  }[state.sort];
  return list.sort(by);
}

function renderAlbums(box, albums) {
  box.className = "mu-main mu-grid";
  box.replaceChildren(...albums.map((a) => {
    const card = el("button", { type: "button", className: "mu-card" },
      cover(coverUrl(a.cover)),
      el("span", { className: "mu-card-name", textContent: a.name }),
      el("span", { className: "mu-card-sub", textContent: [a.artist, a.year].filter(Boolean).join(" · ") }));
    card.onclick = () => openDetail({ kind: "album", key: a.key });
    card.oncontextmenu = (e) => (e.preventDefault(), menu(e, [["Play", () => playList(a.songs, 0)], ["Play next", () => queueNext(a.songs)], ["Add to Next up", () => queueAdd(a.songs)]]));
    return card;
  }));
}

function cover(url) {
  const box = el("span", { className: "mu-cover" });
  box.innerHTML = icon("disc-3");
  if (url) {
    const img = el("img", { alt: "", loading: "lazy", decoding: "async", src: url });
    img.onload = () => box.classList.add("has-img");
    img.onerror = () => img.remove();
    box.prepend(img);
  }
  return box;
}

function renderRows(box, items, text, open) {
  box.className = "mu-main mu-rows";
  box.replaceChildren(...items.map((item) => {
    const [name, sub] = text(item);
    const row = el("button", { type: "button", className: "mu-row" }, el("span", { className: "mu-row-name", textContent: name }), el("span", { className: "mu-row-sub", textContent: sub }));
    row.onclick = () => open(item);
    return row;
  }));
}

// Songs as a table: a click plays from it, the rest after it (Next up).
function renderSongs(box, songs, { album = true, numbers = false } = {}) {
  box.className = `${box.classList.contains("mu-detail-songs") ? "mu-detail-songs " : "mu-main "}mu-songs`;
  box.replaceChildren(...songs.map((s, i) => {
    const row = el("div", { className: "mu-song", tabIndex: 0 },
      el("span", { className: "mu-song-n", textContent: numbers ? (s.track ?? "") : "" }),
      el("span", { className: "mu-song-title", textContent: songName(s) }),
      el("span", { className: "mu-song-artist", textContent: s.artist ?? "" }),
      album ? el("span", { className: "mu-song-album", textContent: s.album ?? "" }) : null,
      el("span", { className: "mu-song-len", textContent: s.duration ? clock(s.duration) : "" }));
    row.dataset.path = s.path;
    row.onclick = () => playList(songs, i);
    row.onkeydown = (e) => {
      if (e.key === "Enter") playList(songs, i);
    };
    row.oncontextmenu = (e) => (e.preventDefault(), menu(e, [
      ["Play", () => playList(songs, i)], ["Play next", () => queueNext([s])], ["Add to Next up", () => queueAdd([s])],
      ["Show in folder", () => showInFolder(s.path)],
    ]));
    return row;
  }));
  markPlaying();
}

// ---------------------------------------------------------------- an album's, an artist's, a genre's

function openDetail(detail) {
  if (!state.detail) history.pushState({ detail: true }, "");
  state.detail = detail;
  renderDetail();
}

function closeDetail({ back = true } = {}) {
  if (!state.detail) return;
  state.detail = null;
  if (back) history.back();
  render();
}

function renderDetail() {
  const d = state.detail, box = $(".mu-detail");
  let songs, title, sub, art = null;
  if (d.kind === "album") {
    const a = state.albums.find((x) => x.key === d.key);
    if (!a) return closeDetail();
    songs = a.songs;
    title = a.name;
    sub = [a.artist, a.year].filter(Boolean).join(" · ");
    art = coverUrl(a.cover);
  } else if (d.kind === "artist") {
    const ar = state.artists.find((x) => x.name === d.name);
    if (!ar) return closeDetail();
    songs = [...ar.songs].sort((a, b) => collator.compare(a.album ?? "", b.album ?? "") || trackOrder(a, b));
    title = ar.name;
    sub = `${ar.albums.size} album${ar.albums.size === 1 ? "" : "s"}`;
    art = coverUrl(songs.find((s) => s.cover));
  } else {
    const g = state.genres.find((x) => x.name === d.name);
    if (!g) return closeDetail();
    songs = sortSongs([...g.songs]);
    title = g.name;
    sub = "Genre";
  }
  const length = songs.reduce((t, s) => t + (s.duration ?? 0), 0);
  const back = el("button", { type: "button", className: "icon mu-back", title: "Back (Esc)", innerHTML: icon("arrow-left") });
  back.onclick = () => closeDetail();
  const play = el("button", { type: "button", className: "primary", innerHTML: `${icon("play")}Play` });
  play.onclick = () => playList(songs, 0);
  const shuffle = el("button", { type: "button", innerHTML: `${icon("shuffle")}Shuffle` });
  shuffle.onclick = () => playList(shuffled(songs), 0);
  const add = el("button", { type: "button", innerHTML: `${icon("list-plus")}Add to Next up` });
  add.onclick = () => queueAdd(songs);
  const list = el("div", { className: "mu-detail-songs" });
  box.replaceChildren(
    el("div", { className: "mu-detail-head" }, back, cover(art),
      el("div", { className: "mu-detail-text" },
        el("h3", { textContent: title }),
        el("p", { className: "hint", textContent: [sub, `${songs.length} song${songs.length === 1 ? "" : "s"}`, length ? clock(length) : ""].filter(Boolean).join(" · ") }),
        el("div", { className: "mu-detail-buttons" }, play, shuffle, add))),
    list);
  renderSongs(list, songs, { album: d.kind !== "album", numbers: d.kind === "album" });
  box.hidden = false;
  $(".mu-main").hidden = true;
  $(".mu-empty").hidden = true;
}

const shuffled = (list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// ---------------------------------------------------------------- radio

async function loadStations() {
  state.stations = await api("api/stations").catch(() => []);
  if (state.tab === "radio" && !state.detail) render();
}

function renderRadio(box) {
  box.className = "mu-main mu-radio";
  const add = el("button", { type: "button", innerHTML: `${icon("plus")}Add a station` });
  add.onclick = () => editStation(null);
  const soma = el("button", { type: "button", innerHTML: `${icon("radio")}Add SomaFM's stations`, title: "All of SomaFM's stations (new ones too, and any taken off)" });
  soma.onclick = async () => {
    soma.disabled = true;
    try {
      const r = await api("api/stations/somafm", { method: "POST" });
      state.stations = r.stations;
      render();
    } catch (err) {
      say(`Couldn't add them: ${err.message}`);
    } finally {
      soma.disabled = false;
    }
  };
  const grid = el("div", { className: "mu-grid" }, ...state.stations.filter((s) => matches(`${s.name} ${s.genre ?? ""} ${s.description ?? ""}`)).map((s) => {
    const card = el("button", { type: "button", className: "mu-card mu-station-card", title: s.description ?? "" },
      cover(s.image ? `api/radio/logo?id=${encodeURIComponent(s.id)}` : null),
      el("span", { className: "mu-card-name", textContent: s.name }),
      el("span", { className: "mu-card-sub", textContent: s.genre ?? "" }));
    card.dataset.station = s.id;
    card.onclick = () => playStation(s);
    card.oncontextmenu = (e) => (e.preventDefault(), menu(e, [
      ["Play", () => playStation(s)], ["Edit…", () => editStation(s)],
      s.homepage && ["Its web page", () => open(s.homepage, "_blank")],
      ["Remove", () => removeStation(s)],
    ].filter(Boolean)));
    return card;
  }));
  box.replaceChildren(el("div", { className: "mu-radio-head" }, add, soma), grid);
  markPlaying();
}

// A station added (null) or changed: its dialog.
function editStation(s) {
  const d = $(".mu-station"), form = $("form", d), error = $(".error", d);
  $(".title", d).textContent = s ? `Change ${s.name}` : "Add a station";
  $("[value=ok]", d).textContent = s ? "Save" : "Add";
  for (const name of ["name", "url", "homepage", "image", "genre"]) form.elements[name].value = s?.[name] ?? "";
  error.hidden = true;
  d.returnValue = "";
  d.showModal();
  form.onsubmit = async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    const body = Object.fromEntries(["name", "url", "homepage", "image", "genre"].map((k) => [k, form.elements[k].value.trim()]));
    try {
      await api("api/stations", { method: s ? "PUT" : "POST", body: JSON.stringify(s ? { id: s.id, ...body } : body) });
      d.close();
      await loadStations();
      render();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  };
}

// (SomaFM's come back with "Add SomaFM's stations".)
async function removeStation(s) {
  await api(`api/stations?id=${encodeURIComponent(s.id)}`, { method: "DELETE" }).catch((err) => say(err.message));
  await loadStations();
  render();
  say(`${s.name} removed`);
}

// ---------------------------------------------------------------- playing

const audio = $(".mu-audio");
const player = {
  queue: [], // [{song} | {station}]
  at: -1,
  shuffle: read("shuffle", false),
  repeat: read("repeat", "off"), // off, all, one
  nowTimer: null,
};
audio.volume = read("volume", 0.8);

function playList(songs, i) {
  player.queue = songs.map((song) => ({ song }));
  if (player.shuffle) {
    const first = player.queue[i];
    player.queue = [first, ...shuffled(player.queue.filter((q) => q !== first))];
    i = 0;
  }
  playAt(i);
}

function playStation(station) {
  player.queue = [{ station }];
  playAt(0);
}

function queueNext(songs) {
  if (player.at < 0) return playList(songs, 0);
  player.queue.splice(player.at + 1, 0, ...songs.map((song) => ({ song })));
  renderQueue();
}

function queueAdd(songs) {
  if (player.at < 0) return playList(songs, 0);
  player.queue.push(...songs.map((song) => ({ song })));
  renderQueue();
}

function playAt(i) {
  const item = player.queue[i];
  if (!item) return stop();
  player.at = i;
  clearInterval(player.nowTimer);
  if (item.song) {
    audio.src = `api/file?path=${encodeURIComponent(item.song.path)}`;
    showNow({ title: songName(item.song), artist: [item.song.artist, item.song.album].filter(Boolean).join(" · "), cover: coverUrl(item.song) });
  } else {
    audio.src = `api/radio/stream?id=${encodeURIComponent(item.station.id)}`;
    showNow({ title: item.station.name, artist: "Radio", cover: item.station.image ? `api/radio/logo?id=${encodeURIComponent(item.station.id)}` : null, live: true });
    const ask = () => api(`api/radio/now?id=${encodeURIComponent(item.station.id)}`).then((now) => {
      if (player.queue[player.at] !== item) return;
      const text = now ? [now.artist, now.title].filter(Boolean).join(" — ") || now.text : "";
      $(".mu-now-artist").textContent = text || "Radio";
      mediaSession(item.station.name, text);
    }, () => {});
    ask();
    player.nowTimer = setInterval(ask, 20_000);
  }
  audio.play().catch((err) => err.name !== "AbortError" && showError(err));
  renderQueue();
  markPlaying();
}

function stop() {
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  player.at = -1;
  clearInterval(player.nowTimer);
  showNow(null);
  renderQueue();
  markPlaying();
}

function next(step = 1, { ended = false } = {}) {
  const item = player.queue[player.at];
  if (!item) return;
  if (item.station) return; // (a station plays on)
  if (ended && player.repeat === "one") return playAt(player.at);
  let i = player.at + step;
  if (i >= player.queue.length) {
    if (player.repeat !== "all" && ended) return stop();
    i = 0;
  }
  if (i < 0) i = player.repeat === "all" ? player.queue.length - 1 : 0;
  playAt(i);
}

function showNow(now) {
  $(".mu-now-title").textContent = now?.title ?? "Nothing playing";
  $(".mu-now-artist").textContent = now?.artist ?? "";
  const img = $(".mu-now-cover img");
  img.hidden = !now?.cover;
  if (now?.cover) img.src = now.cover;
  else img.removeAttribute("src");
  $(".mu-player").classList.toggle("live", !!now?.live);
  $(".mu-pos").disabled = !!now?.live || !now;
  $(".mu-length").textContent = now?.live ? "Live" : "0:00";
  document.title = now ? `${now.title} — Music` : "Music";
  mediaSession(now?.title, now?.artist, now?.cover);
}

function mediaSession(title, artist, art) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = title ? new MediaMetadata({ title, artist: artist ?? "", artwork: art ? [{ src: new URL(art, location.href).href }] : [] }) : null;
}
if ("mediaSession" in navigator) {
  const on = (action, fn) => {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch { /* not this one */ }
  };
  on("play", () => audio.play());
  on("pause", () => audio.pause());
  on("nexttrack", () => next(1));
  on("previoustrack", () => previous());
}

function previous() {
  if (audio.currentTime > 4 && !$(".mu-player").classList.contains("live")) audio.currentTime = 0;
  else next(-1);
}

function showError(err) {
  $(".mu-now-artist").textContent = `Can't play it: ${err.message ?? err}`;
}

audio.onplay = audio.onpause = () => {
  $(".mu-play").innerHTML = icon(audio.paused ? "play" : "pause");
  $(".mu-play").title = audio.paused ? "Play (Space)" : "Pause (Space)";
};
audio.onended = () => next(1, { ended: true });
audio.onerror = () => player.at >= 0 && showError(new Error(player.queue[player.at]?.station ? "the station doesn't answer" : "the file can't be read"));
audio.ontimeupdate = () => {
  if ($(".mu-player").classList.contains("live")) return void ($(".mu-time").textContent = clock(audio.currentTime));
  $(".mu-time").textContent = clock(audio.currentTime);
  $(".mu-length").textContent = clock(audio.duration);
  if (!seeking) $(".mu-pos").value = audio.duration ? Math.round((audio.currentTime / audio.duration) * 1000) : 0;
};
let seeking = false;
$(".mu-pos").oninput = () => (seeking = true);
$(".mu-pos").onchange = () => {
  if (audio.duration) audio.currentTime = ($(".mu-pos").value / 1000) * audio.duration;
  seeking = false;
};
$(".mu-play").onclick = () => (player.at < 0 ? (state.songs.length && playList(sortSongs([...state.songs]), 0)) : audio.paused ? audio.play() : audio.pause());
$(".mu-next").onclick = () => next(1);
$(".mu-prev").onclick = () => previous();
$(".mu-volume").value = Math.round(audio.volume * 100);
$(".mu-volume").oninput = () => {
  audio.volume = $(".mu-volume").value / 100;
  audio.muted = false;
  keep("volume", audio.volume);
  showVolume();
};
$(".mu-mute").onclick = () => (audio.muted = !audio.muted, showVolume());
const showVolume = () => ($(".mu-mute").innerHTML = icon(audio.muted || audio.volume === 0 ? "volume-x" : "volume-2"));
const showModes = () => {
  $(".mu-shuffle").setAttribute("aria-pressed", String(player.shuffle));
  $(".mu-repeat").setAttribute("aria-pressed", String(player.repeat !== "off"));
  $(".mu-repeat").innerHTML = icon(player.repeat === "one" ? "repeat-1" : "repeat");
  $(".mu-repeat").title = { off: "Repeat", all: "Repeating all (again: this one)", one: "Repeating this one (again: off)" }[player.repeat];
};
$(".mu-shuffle").onclick = () => {
  player.shuffle = !player.shuffle;
  keep("shuffle", player.shuffle);
  // On: what's after this one, shuffled.
  if (player.shuffle && player.at >= 0) player.queue = [...player.queue.slice(0, player.at + 1), ...shuffled(player.queue.slice(player.at + 1))], renderQueue();
  showModes();
};
$(".mu-repeat").onclick = () => {
  player.repeat = { off: "all", all: "one", one: "off" }[player.repeat];
  keep("repeat", player.repeat);
  showModes();
};

// The song (or station) playing, lit where it's listed.
function markPlaying() {
  const item = player.queue[player.at];
  for (const row of document.querySelectorAll(".mu-song")) row.classList.toggle("playing", !!item?.song && row.dataset.path === item.song.path);
  for (const card of document.querySelectorAll(".mu-station-card")) card.classList.toggle("playing", !!item?.station && card.dataset.station === item.station.id);
}

// Next up: what's after the one playing; a click plays it, × takes it off.
function renderQueue() {
  const list = $(".mu-queue-list");
  const after = player.queue.map((q, i) => [q, i]).slice(player.at + 1);
  list.replaceChildren(...after.map(([q, i]) => {
    const remove = el("button", { type: "button", className: "icon", title: "Take it off", innerHTML: icon("x") });
    remove.onclick = (e) => {
      e.stopPropagation();
      player.queue.splice(i, 1);
      renderQueue();
    };
    const li = el("li", {}, el("span", { className: "mu-q-text" }, el("span", { className: "mu-q-title", textContent: q.song ? songName(q.song) : q.station.name }),
      el("span", { className: "mu-q-sub", textContent: q.song?.artist ?? "" })), remove);
    li.onclick = () => playAt(i);
    return li;
  }));
  if (!after.length) list.append(el("li", { className: "hint mu-q-empty", textContent: "Nothing after this one." }));
}
$(".mu-queue-button").onclick = () => {
  const open = $(".mu-queue").hidden;
  $(".mu-queue").hidden = !open;
  $(".mu-queue-button").setAttribute("aria-pressed", String(open));
  document.body.classList.toggle("queue-open", open);
};
$(".mu-queue-clear").onclick = () => {
  player.queue.splice(player.at + 1);
  renderQueue();
};

// ---------------------------------------------------------------- the rest

async function showInFolder(path) {
  await api("api/show", { method: "POST", body: JSON.stringify({ path }) }).catch((err) => say(err.message));
}

// A message, for a few seconds.
let sayTimer = null;
function say(text) {
  const box = $(".mu-say");
  box.textContent = text;
  box.hidden = false;
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => (box.hidden = true), 4000);
}

function menu(e, items) {
  const box = $(".mu-menu");
  box.replaceChildren(...items.map(([text, act]) => {
    const b = el("button", { type: "button", textContent: text });
    b.onclick = () => {
      box.hidden = true;
      act();
    };
    return b;
  }));
  box.hidden = false;
  const r = box.getBoundingClientRect();
  box.style.left = `${Math.min(e.clientX, innerWidth - r.width - 4)}px`;
  box.style.top = `${Math.min(e.clientY, innerHeight - r.height - 4)}px`;
}
addEventListener("click", (e) => !e.target.closest(".mu-menu") && ($(".mu-menu").hidden = true));

for (const b of $(".mu-tabs").children) {
  b.onclick = () => {
    state.tab = b.dataset.tab;
    if (state.detail) closeDetail();
    render();
    saveView();
    scrollTo(0, 0);
  };
}
$(".mu-sort").onchange = () => {
  state.sort = $(".mu-sort").value;
  render();
  saveView();
};
$(".mu-filter").oninput = () => {
  state.filter = $(".mu-filter").value.trim().toLowerCase();
  if (state.detail) closeDetail();
  render();
};
$(".mu-rescan").onclick = () => api("api/scan", { method: "POST" }).then(() => showScan({ done: 0, total: 0 }));
const saveView = () => api("api/view", { method: "PUT", body: JSON.stringify({ tab: state.tab, sort: state.sort }) }).catch(() => {});

addEventListener("popstate", () => state.detail && closeDetail({ back: false }));
addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select, dialog")) return;
  if (e.key === " ") {
    e.preventDefault();
    $(".mu-play").click();
  } else if (e.key === "Escape") {
    if (!$(".mu-menu").hidden) $(".mu-menu").hidden = true;
    else if (state.detail) closeDetail();
    else if (embedded) closeWindow();
  } else if ((e.ctrlKey && e.key === "f") || e.key === "/") {
    e.preventDefault();
    $(".mu-filter").focus();
  }
});
onCloseRequest(() => closeWindow());
$(".close").hidden = !embedded;
$(".close").onclick = () => closeWindow();

// The scan's progress, and the library once it's done.
const events = new EventSource("api/events");
events.addEventListener("scan", (e) => showScan(JSON.parse(e.data)));
events.addEventListener("library", () => loadLibrary().catch(() => {}));

(async () => {
  const view = await api("api/view").catch(() => ({}));
  if (view.tab) state.tab = view.tab;
  if (view.sort) state.sort = view.sort;
  $(".mu-sort").value = state.sort;
  showModes();
  showVolume();
  renderQueue();
  await Promise.all([loadLibrary().catch((err) => ($(".mu-scan").textContent = err.message)), loadStations()]);
  render();
  ready();
})();
