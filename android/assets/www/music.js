// The light phil's music: "Music" in the bar. The phone's own songs (Android's
// media index), the PC's (musicview's library, while it's in reach) and the
// radio (the PC's stations, kept; SomaFM's with none yet), as albums with their
// covers or a list of songs; an album's songs over it. The player is the app's
// (MusicService: it plays on with the app closed); this is its remote. A small
// player along the bottom of both views while something's in it; a tap opens
// the big one, with Next up.

const $ = (s, root = document) => root.querySelector(s);
const el = (tag, props = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter((c) => c != null));
  return e;
};
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const PLAY = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24"><path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" fill="currentColor" stroke="none"/></svg>';
const DISC = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M6 12c0-1.7.7-3.2 1.8-4.2"/><circle cx="12" cy="12" r="2"/><path d="M18 12c0 1.7-.7 3.2-1.8 4.2"/></svg>';

async function api(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body;
}
const command = (cmd, args = {}) => globalThis.Phil?.music(JSON.stringify({ cmd, ...args }));

const m = {
  on: false, source: "phone", mode: "albums", album: null,
  phone: null, pc: null, stations: null, pcName: "PC", pcReachable: false,
  state: null, at: 0, since: 0,
};

const songName = (s) => s.title || s.path.split("/").pop().replace(/\.[^.]+$/, "");
const artistOf = (s) => s.albumArtist || s.artist || "Unknown artist";
const trackOrder = (a, b) => (a.disc ?? 1) - (b.disc ?? 1) || (a.track ?? 1e6) - (b.track ?? 1e6) || collator.compare(a.path, b.path);
const clock = (s) => {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  s = Math.floor(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const coverUrl = (s) => (s.kind === "pc" ? `/music/cover?kind=pc&path=${encodeURIComponent(s.path)}&mtime=${s.mtime ?? 0}` : `/music/cover?kind=phone&path=${encodeURIComponent(s.path)}`);
const logoUrl = (station) => (station?.image ? `/music/logo?url=${encodeURIComponent(station.image)}` : null);

function cover(url) {
  const box = el("span", { className: "m-cover", innerHTML: DISC });
  if (url) {
    const img = el("img", { alt: "", loading: "lazy", decoding: "async", src: url });
    img.onload = () => img.classList.add("shown");
    img.onerror = () => img.remove();
    box.append(img);
  }
  return box;
}

// ---------------------------------------------------------------- the view

function show(on, { push = true } = {}) {
  if (m.on === on) return;
  m.on = on;
  document.body.classList.toggle("music-view", on);
  $("#to-music").classList.toggle("on", on);
  $("#to-music").textContent = on ? "Files" : "Music";
  for (const id of ["#music-sources", "#music-modes", "#music"]) $(id).hidden = !on;
  if (on) {
    if (push) history.pushState({ music: true }, "");
    m.album = null;
    load();
    render();
  } else {
    m.album = null;
    globalThis.philFiles?.render();
  }
}

async function load() {
  const [phone, stations] = await Promise.all([api("/music/phone").catch(() => null), api("/music/stations").catch(() => null)]);
  if (phone) m.phone = phone.songs;
  if (stations) m.stations = stations;
  render();
  const status = await api("/pc/status").catch(() => null);
  m.pcName = status?.name ?? "PC";
  m.pcReachable = !!status?.reachable;
  if (m.pcReachable) {
    const lib = await api("/music/pc").catch(() => null);
    if (lib) {
      m.pc = lib.songs.map((s) => ({ ...s, kind: "pc" }));
      if (lib.stations?.length) m.stations = lib.stations;
    }
  }
  render();
}

function render() {
  if (!m.on) return;
  const sources = [["phone", "Phone"], ["pc", m.pcName], ["radio", "Radio"]];
  $("#music-sources").replaceChildren(...sources.map(([key, name]) => {
    const b = el("button", { textContent: name });
    b.classList.toggle("here", m.source === key);
    b.classList.toggle("away", key === "pc" && !m.pcReachable);
    b.onclick = () => {
      m.source = key;
      m.album = null;
      render();
      scrollTo(0, 0);
    };
    return b;
  }));
  for (const b of $("#music-modes").children) b.classList.toggle("here", b.dataset.mode === m.mode);
  $("#music-modes").hidden = m.source === "radio" || !!m.album;
  $("#title").textContent = m.album ? m.album.name : "Music";
  $("#path").textContent = m.album ? m.album.artist : m.source === "radio" ? "Radio" : m.source === "pc" ? m.pcName : "Phone";
  $("#up").disabled = !m.album;
  const box = $("#music");
  if (m.source === "radio") return renderRadio(box);
  const songs = m.source === "pc" ? m.pc : m.phone;
  if (!songs) return box.replaceChildren(el("p", { className: "m-empty", textContent: m.source === "pc" ? (m.pcReachable ? "Reading…" : `${m.pcName} isn't in reach.`) : "Reading…" }));
  if (!songs.length) {
    return box.replaceChildren(el("p", {
      className: "m-empty",
      textContent: m.source === "pc" ? `No songs on ${m.pcName} yet: a folder's Properties in phil there, "A music folder".` : "No songs on the phone (or phil can't see them: all files access).",
    }));
  }
  if (m.album) return renderAlbum(box, m.album);
  if (m.mode === "songs") return box.replaceChildren(songList([...songs].sort((a, b) => collator.compare(artistOf(a), artistOf(b)) || collator.compare(a.album ?? "", b.album ?? "") || trackOrder(a, b)), { covers: true }));
  renderAlbums(box, songs);
}

function albumsOf(songs) {
  const albums = new Map();
  for (const s of songs) {
    const key = `${artistOf(s)}\0${s.album ?? ""}`;
    const a = albums.get(key) ?? albums.set(key, { key, name: s.album || "Unknown album", artist: artistOf(s), year: s.year, songs: [] }).get(key);
    a.songs.push(s);
  }
  for (const a of albums.values()) a.songs.sort(trackOrder);
  return [...albums.values()].sort((a, b) => collator.compare(a.name, b.name));
}

function renderAlbums(box, songs) {
  box.replaceChildren(el("div", { className: "m-grid" }, ...albumsOf(songs).map((a) => {
    const card = el("button", { className: "m-card" }, cover(coverUrl(a.songs[0])),
      el("span", { className: "m-name", textContent: a.name }), el("span", { className: "m-sub", textContent: [a.artist, a.year].filter(Boolean).join(" · ") }));
    card.onclick = () => {
      m.album = a;
      history.pushState({ music: true, album: true }, "");
      render();
      scrollTo(0, 0);
    };
    return card;
  })));
}

function renderAlbum(box, a) {
  const play = el("button", { className: "main", textContent: "Play" });
  play.onclick = () => playList(a.songs, 0);
  const shuffle = el("button", { textContent: "Shuffle" });
  shuffle.onclick = () => (command("shuffle", { on: true }), playList(a.songs, Math.floor(Math.random() * a.songs.length)));
  const add = el("button", { textContent: "Add to Next up" });
  add.onclick = () => command("queueAdd", { items: a.songs });
  const length = a.songs.reduce((t, s) => t + (s.duration ?? 0), 0);
  box.replaceChildren(
    el("div", { className: "m-head" }, cover(coverUrl(a.songs[0])),
      el("div", {}, el("h3", { textContent: a.name }), el("p", { textContent: [a.artist, a.year, `${a.songs.length} song${a.songs.length === 1 ? "" : "s"}`, length ? clock(length) : ""].filter(Boolean).join(" · ") }),
        el("div", { className: "m-head-buttons" }, play, shuffle, add))),
    songList(a.songs, { numbers: true }),
  );
}

// Songs: a tap plays it, the rest after it (Next up); a long press adds it to Next up.
function songList(songs, { covers = false, numbers = false } = {}) {
  return el("div", { className: "m-songs" }, ...songs.map((s, i) => {
    const row = el("button", { className: "m-song" },
      covers ? cover(coverUrl(s)) : el("span", { className: "m-n", textContent: numbers ? (s.track ?? "") : "" }),
      el("span", { className: "m-text" }, el("span", { className: "m-name", textContent: songName(s) }), el("span", { className: "m-sub", textContent: [s.artist, covers ? s.album : null].filter(Boolean).join(" · ") })),
      el("span", { className: "m-len", textContent: s.duration ? clock(s.duration) : "" }));
    row.dataset.path = s.path;
    row.onclick = () => playList(songs, i);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      command("queueNext", { items: [s] });
      toast(`${songName(s)}: next`);
    };
    return row;
  }));
}

function renderRadio(box) {
  const stations = m.stations ?? [];
  if (!stations.length) return box.replaceChildren(el("p", { className: "m-empty", textContent: "No stations." }));
  box.replaceChildren(el("div", { className: "m-grid" }, ...stations.map((s) => {
    const card = el("button", { className: "m-card m-station" }, cover(logoUrl(s)),
      el("span", { className: "m-name", textContent: s.name }), el("span", { className: "m-sub", textContent: s.genre ?? "" }));
    card.dataset.station = s.id;
    card.onclick = () => command("station", { station: s });
    return card;
  })));
  markPlaying();
}

const playList = (songs, at) => command("list", { items: songs, at });

// ---------------------------------------------------------------- the player

function showState(s) {
  m.state = s;
  m.at = s.position ?? 0;
  m.since = performance.now();
  const now = s.now;
  const live = now?.kind === "radio";
  document.body.classList.toggle("mini-on", !!now);
  $("#mini").hidden = !now;
  if (!now) $("#player").hidden = true;
  const title = !now ? "" : live ? now.station?.name ?? "Radio" : songName(now);
  const artist = !now ? "" : live ? (s.playing ? [s.playing.artist, s.playing.title].filter(Boolean).join(" — ") : s.loading ? "Tuning in…" : "Radio") : [now.artist, now.album].filter(Boolean).join(" · ");
  const art = !now ? null : live ? logoUrl(now.station) : coverUrl(now);
  for (const [box, t, a, img] of [[$("#mini"), ".mini-title", ".mini-artist", ".mini-cover img"], [$("#player"), ".player-title", ".player-artist", ".player-cover img"]]) {
    box.classList.toggle("live", live);
    $(t, box).textContent = title;
    $(a, box).textContent = artist;
    const i = $(img, box);
    if (art && i.getAttribute("src") !== art) i.src = art;
    else if (!art) i.removeAttribute("src");
  }
  const playing = now && !s.paused;
  $(".mini-play").innerHTML = $(".player-play").innerHTML = playing ? PAUSE : PLAY;
  $(".mini-prev").disabled = $(".mini-next").disabled = $(".player-prev").disabled = $(".player-next").disabled = live;
  $(".player-pos").disabled = live;
  $(".player-shuffle").classList.toggle("on", !!s.shuffle);
  $(".player-repeat").classList.toggle("on", s.repeat !== "off");
  $(".player-repeat").classList.toggle("one", s.repeat === "one");
  showPosition();
  renderQueue();
  markPlaying();
}

function showPosition() {
  const s = m.state;
  if (!s?.now) return;
  const live = s.now.kind === "radio";
  const pos = !s.paused && !s.loading ? m.at + (performance.now() - m.since) / 1000 : m.at;
  const length = s.duration || s.now.duration || 0;
  $(".player-time").textContent = clock(live ? 0 : Math.min(pos, length || pos));
  $(".player-length").textContent = live ? "Live" : clock(length);
  if (!seeking) $(".player-pos").value = length && !live ? Math.round((Math.min(pos, length) / length) * 1000) : 0;
}
setInterval(showPosition, 500);

function renderQueue() {
  const s = m.state, list = $(".player-queue");
  const after = (s?.queue ?? []).map((q, i) => [q, i]).slice((s?.at ?? -1) + 1);
  list.replaceChildren(...after.map(([q, i]) => {
    const li = el("li", {}, el("span", { className: "q-title", textContent: q.kind === "radio" ? q.station?.name : songName(q) }), el("span", { className: "q-sub", textContent: q.artist ?? "" }));
    li.onclick = () => command("playAt", { i });
    return li;
  }));
  $(".player-next-up").hidden = !after.length;
}

function markPlaying() {
  const now = m.state?.now;
  for (const row of document.querySelectorAll(".m-song")) row.classList.toggle("playing", !!now && now.kind !== "radio" && row.dataset.path === now.path);
  for (const card of document.querySelectorAll(".m-station")) card.classList.toggle("playing", now?.kind === "radio" && card.dataset.station === now.station?.id);
}

let seeking = false;
$(".player-pos").oninput = () => (seeking = true);
$(".player-pos").onchange = () => {
  const length = m.state?.duration || m.state?.now?.duration;
  if (length) command("seek", { at: ($(".player-pos").value / 1000) * length });
  seeking = false;
};
for (const sel of [".mini-play", ".player-play"]) $(sel).onclick = () => command("toggle");
for (const sel of [".mini-next", ".player-next"]) $(sel).onclick = () => command("next");
for (const sel of [".mini-prev", ".player-prev"]) $(sel).onclick = () => command("previous");
$(".player-shuffle").onclick = () => command("shuffle", { on: !m.state?.shuffle });
$(".player-repeat").onclick = () => command("repeat", { mode: { off: "all", all: "one", one: "off" }[m.state?.repeat ?? "off"] });
$(".mini-now").onclick = () => {
  $("#player").hidden = false;
  history.pushState({ music: m.on, player: true }, "");
};
$("#player-close").onclick = () => history.back();

let toastTimer = null;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2500);
}

// ---------------------------------------------------------------- with the files

$("#to-music").onclick = () => (m.on ? history.back() : show(true));
for (const b of $("#music-modes").children) {
  b.onclick = () => {
    m.mode = b.dataset.mode;
    render();
  };
}
// (Up, in the music: from an album back to the albums.)
$("#up").addEventListener("click", (e) => {
  if (!m.on) return;
  e.stopImmediatePropagation();
  if (m.album) history.back();
}, true);
addEventListener("popstate", (e) => {
  if (!$("#player").hidden && !e.state?.player) $("#player").hidden = true;
  if (e.state?.music) {
    if (!m.on) show(true, { push: false });
    else if (!e.state.album && m.album) (m.album = null), render();
  } else if (m.on) show(false, { push: false });
});

// The app's news: the player's state (MusicService), as it changes.
const before = globalThis.philEvent;
globalThis.philEvent = (event) => {
  if (event.music) return showState(event.music);
  if (event.phoneMedia) { // (songs the PC sent, in Android's media index now: read again)
    if (!m.on) return (m.phone = null);
    return api("/music/phone").then((r) => ((m.phone = r.songs), render()), () => {});
  }
  before?.(event);
};
// The music's notification tapped: its view.
globalThis.philShowMusic = () => show(true);
// (The cameras' view coming: this one goes.)
globalThis.philMusic = { off: () => show(false, { push: false }) };

api("/music/state").then(showState, () => {});
