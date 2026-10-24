// musicview: the songs in the folders marked as music (a folder's Properties in
// phil), by their tags (../library.js): albums with their covers, artists,
// songs, genres; an album's, an artist's or a genre's songs over the list.
// Played by the engine (../player.js: on with the window closed), with a queue
// (Next up), shuffle and repeat; this page is its remote. And radio stations (../radio.js): SomaFM's,
// and any added by their address; what's playing on one, as it changes.
import { closeWindow, embedded, onCloseRequest, ready, tellParent, tooltips } from "../engine/ui/kit.js";

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

// The player is the engine's (../player.js: it plays on with this window
// closed): this is its remote. Its state comes as it changes (/api/events,
// "player"); its position, between those, is moved on here.
const player = { state: null, at: 0, since: 0 };

const send = (cmd, args = {}) => api("api/player", { method: "POST", body: JSON.stringify({ cmd, ...args }) })
  .then(showPlayer, (err) => say(`Can't play it: ${err.message}`));
const playList = (songs, i) => send("songs", { paths: songs.map((s) => s.path), at: i });
const playStation = (station) => send("station", { id: station.id });
const queueNext = (songs) => send("queueNext", { paths: songs.map((s) => s.path) });
const queueAdd = (songs) => send("queueAdd", { paths: songs.map((s) => s.path) });

function showPlayer(s) {
  if (!s) return;
  player.state = s;
  player.at = s.position ?? 0;
  player.since = performance.now();
  const now = s.now;
  const live = !!now?.station;
  $(".mu-now-title").textContent = now ? (now.song ? songName(now.song) : now.station.name) : "Nothing playing";
  $(".mu-now-artist").textContent = !now ? "" : now.song ? [now.song.artist, now.song.album].filter(Boolean).join(" · ")
    : (now.playing && [now.playing.artist, now.playing.title].filter(Boolean).join(" — ")) || "Radio";
  const art = now?.song ? coverUrl(now.song) : now?.station?.image ? `api/radio/logo?id=${encodeURIComponent(now.station.id)}` : null;
  const img = $(".mu-now-cover img");
  img.hidden = !art;
  if (art && img.getAttribute("src") !== art) img.src = art;
  else if (!art) img.removeAttribute("src");
  $(".mu-player").classList.toggle("live", live);
  $(".mu-pos").disabled = live || !now;
  $(".mu-play").innerHTML = icon(now && !s.paused ? "pause" : "play");
  $(".mu-play").title = now && !s.paused ? "Pause (Space)" : "Play (Space)";
  $(".mu-shuffle").setAttribute("aria-pressed", String(s.shuffle));
  $(".mu-repeat").setAttribute("aria-pressed", String(s.repeat !== "off"));
  $(".mu-repeat").innerHTML = icon(s.repeat === "one" ? "repeat-1" : "repeat");
  $(".mu-repeat").title = { off: "Repeat", all: "Repeating all (again: this one)", one: "Repeating this one (again: off)" }[s.repeat];
  if (!volumeHeld) $(".mu-volume").value = s.volume;
  $(".mu-mute").innerHTML = icon(s.volume === 0 ? "volume-x" : "volume-2");
  document.title = now ? `${$(".mu-now-title").textContent} — Music` : "Music";
  showPosition();
  renderQueue();
  markPlaying();
}

// Where it is: the last told, and the time since (while it plays).
function showPosition() {
  const s = player.state;
  const live = !!s?.now?.station;
  const pos = s?.now && !s.paused ? player.at + (performance.now() - player.since) / 1000 : player.at;
  const length = s?.duration ?? s?.now?.song?.duration ?? 0;
  $(".mu-time").textContent = clock(s?.now ? Math.min(pos, length || pos) : 0);
  $(".mu-length").textContent = live ? "Live" : clock(length);
  if (!seeking) $(".mu-pos").value = length && !live ? Math.round((Math.min(pos, length) / length) * 1000) : 0;
}
setInterval(showPosition, 500);

let seeking = false, volumeHeld = false;
$(".mu-pos").oninput = () => (seeking = true);
$(".mu-pos").onchange = () => {
  const length = player.state?.duration ?? player.state?.now?.song?.duration;
  if (length) send("seek", { at: ($(".mu-pos").value / 1000) * length });
  seeking = false;
};
$(".mu-play").onclick = () => {
  if (player.state?.now) return send("toggle");
  if (state.songs.length) playList(sortSongs([...state.songs]), 0); // (nothing yet: every song)
};
$(".mu-next").onclick = () => send("next");
$(".mu-prev").onclick = () => send("previous");
$(".mu-volume").oninput = () => {
  volumeHeld = true;
  send("volume", { value: Number($(".mu-volume").value) }).finally(() => (volumeHeld = false));
};
let unmuted = 80;
$(".mu-mute").onclick = () => {
  const v = player.state?.volume ?? 0;
  if (v > 0) unmuted = v;
  send("volume", { value: v > 0 ? 0 : unmuted });
};
$(".mu-shuffle").onclick = () => send("shuffle", { on: !player.state?.shuffle });
$(".mu-repeat").onclick = () => send("repeat", { mode: { off: "all", all: "one", one: "off" }[player.state?.repeat ?? "off"] });

// The song (or station) playing, lit where it's listed.
function markPlaying() {
  const now = player.state?.now;
  for (const row of document.querySelectorAll(".mu-song")) row.classList.toggle("playing", !!now?.song && row.dataset.path === now.song.path);
  for (const card of document.querySelectorAll(".mu-station-card")) card.classList.toggle("playing", !!now?.station && card.dataset.station === now.station.id);
}

// Next up: what's after the one playing; a click plays it, × takes it off.
function renderQueue() {
  const s = player.state, list = $(".mu-queue-list");
  const after = (s?.queue ?? []).map((q, i) => [q, i]).slice((s?.at ?? -1) + 1);
  list.replaceChildren(...after.map(([q, i]) => {
    const remove = el("button", { type: "button", className: "icon", title: "Take it off", innerHTML: icon("x") });
    remove.onclick = (e) => {
      e.stopPropagation();
      send("remove", { i });
    };
    const li = el("li", {}, el("span", { className: "mu-q-text" }, el("span", { className: "mu-q-title", textContent: q.song ? songName(q.song) : q.station.name }),
      el("span", { className: "mu-q-sub", textContent: q.song?.artist ?? "" })), remove);
    li.onclick = () => send("playAt", { i });
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
$(".mu-queue-clear").onclick = () => send("clearNext");

// ---------------------------------------------------------------- the rest

async function showInFolder(path) {
  if (embedded) return tellParent({ app: "musicview", show: path }); // (in phil: there, this closed)
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
$(".close").onclick = () => closeWindow(); // (the music plays on: the engine's)

// The scan's progress, the library once it's done, and the player as it changes.
const events = new EventSource("api/events");
events.addEventListener("player", (e) => showPlayer(JSON.parse(e.data)));
events.addEventListener("scan", (e) => showScan(JSON.parse(e.data)));
events.addEventListener("library", () => loadLibrary().catch(() => {}));

(async () => {
  const view = await api("api/view").catch(() => ({}));
  if (view.tab) state.tab = view.tab;
  if (view.sort) state.sort = view.sort;
  $(".mu-sort").value = state.sort;
  renderQueue();
  await Promise.all([loadLibrary().catch((err) => ($(".mu-scan").textContent = err.message)), loadStations()]);
  render();
  ready();
})();
