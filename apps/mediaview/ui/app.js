// mediaview: the movies and TV shows in the folders marked as media (a
// folder's Properties in phil), from every one in one place, matched with
// IMDb's titles and ratings on this computer (../media.js, ../imdb.js). As
// pictures or a list (columns that sort), what's been started first
// ("Continue watching"); a title's details at the side; videos played in
// videoplayer, shown in this page. In phil: the sidebar's Media, over the
// whole window; Esc or × comes back (a title's details closing first).
import { appUrl, closeWindow, embedded, embedOf, onCloseRequest, ready, tellParent, tooltips } from "../engine/ui/kit.js";

tooltips(); // the page's own, in the theme's style (kit.js)

const $ = (sel) => document.querySelector(sel);
const put = (el, prop, value) => el[prop] !== value && (el[prop] = value);
const icon = (name, cls = "") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw Object.assign(new Error((await res.text()) || res.statusText), { status: res.status });
  return res.json();
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

// "3 days ago", "a year ago"...
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function fromNow(ms) {
  const s = (ms - Date.now()) / 1000;
  for (const [unit, n] of [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]]) {
    if (Math.abs(s) >= n) return relative.format(Math.round(s / n), unit);
  }
  return relative.format(0, "minute");
}

// Elements as phil's own lists: kept for their data's key, made once, shown again when it changes.
function keyed(container, items, { key, kind = () => "", make, show }) {
  const old = new Map();
  for (const el of container.children) if (el.dataset.keyed !== undefined) old.set(el.dataset.keyed, el);
  const els = items.map((item) => {
    const k = String(key(item)), kd = String(kind(item));
    let el = old.get(k);
    if (el?.dataset.kind === kd) old.delete(k);
    else {
      el = make(item);
      el.dataset.keyed = k;
      el.dataset.kind = kd;
    }
    el.item = item;
    show(el, item);
    return el;
  });
  for (const el of old.values()) el.remove();
  let prev = null;
  for (const el of els) {
    let next = prev ? prev.nextElementSibling : container.firstElementChild;
    while (next && next.dataset.keyed === undefined) next = next.nextElementSibling;
    if (next !== el) container.insertBefore(el, next);
    prev = el;
  }
}

// What's picked here (the tab, the sort, pictures or a list), for next time: this browser's.
const remembered = (() => {
  try {
    return JSON.parse(localStorage.getItem("mediaview") ?? "{}");
  } catch {
    return {};
  }
})();
const remember = (key, value) => {
  remembered[key] = value;
  try {
    localStorage.setItem("mediaview", JSON.stringify(remembered));
  } catch { /* not kept */ }
};

const mediaView = document.body, mediaGrid = $(".mv-grid"), mediaDetail = $(".mv-detail");
const mediaContinue = $(".mv-continue"), mediaCols = $(".mv-cols");
const media = { lib: null, tab: remembered.tab === "shows" ? "shows" : "movies", open: null, openKey: null, loading: null, reverse: false };
if (remembered.sort) $(".mv-sort").value = remembered.sort;
const layoutNow = () => (remembered.layout === "list" ? "list" : "grid");

$(".mv-head .close").onclick = () => closeWindow();
mediaDetail.querySelector(".close").onclick = () => closeMediaDetail();
$('[data-layout="grid"]').innerHTML = icon("layout-grid");
$('[data-layout="list"]').innerHTML = icon("list");

// Shown (the window, or the keyboard given it in phil's): once there's something to see.
let isShown = false;
const shown = () => isShown || ((isShown = true), ready());

// Opened: the library as it was last time, at once, then as it is now (the
// folders looked through again: a drive asleep can take a while).
async function loadMedia() {
  if (!media.lib) {
    const last = await api("api/media?cached=1").catch(() => null);
    if (last && !media.lib) {
      media.lib = last;
      showMediaStatus(last.imdb);
      renderMedia();
      shown();
    }
  }
  if (!media.lib) mediaView.querySelector(".mv-status").textContent = "Looking through the media folders…";
  const loading = (media.loading = api("api/media").catch((err) => ({ error: err.message })));
  const lib = await loading;
  if (loading !== media.loading) return; // asked again since
  if (lib.error) return void (mediaView.querySelector(".mv-status").textContent = `Couldn't read the media folders: ${lib.error}`);
  media.lib = lib;
  showMediaStatus(lib.imdb);
  renderMedia();
  if (media.open) {
    const again = [...lib.movies, ...lib.shows].find((x) => mediaKey(x) === media.open || x.key === media.openKey);
    again ? openMediaDetail(again) : closeMediaDetail();
  }
}

const mediaKey = (x) => (x.id ? `tt${x.id}` : x.key);
const isShow = (x) => "seasons" in x;

// IMDb's data: there or not, being downloaded; and the media folders not there now.
function showMediaStatus(status) {
  const line = mediaView.querySelector(".mv-status");
  const away = (media.lib?.roots ?? []).filter((r) => !r.online);
  line.replaceChildren();
  const button = (label, onclick) => Object.assign(document.createElement("button"), { type: "button", className: "mv-link", textContent: label, onclick });
  const update = () => api("api/media/update", { method: "POST" }).then(showMediaStatus, (err) => alert(err.message));
  if (status.building) {
    const { phase, done, total } = status.building;
    line.append(`${phase}${total ? ` ${Math.round((done / total) * 100)}%` : "…"} (IMDb's titles and ratings, on this computer)`);
  } else if (!status.ready) {
    line.append("Titles, years and ratings come from IMDb's datasets, downloaded to this computer (about 290 MB; 900 MB once built), so what's in your library stays here. ", button("Download them", update));
  } else {
    line.append(`Titles and ratings: IMDb's, of ${new Date(status.built).toLocaleDateString()}. `, button("Update", update));
  }
  if (status.error) line.append(` Couldn't update: ${status.error}`);
  // Media folders not there now: an unplugged drive (its titles shown as when last seen), or one
  // moved or deleted outside phil (which didn't see it go: Forget, then mark it where it is now).
  for (const r of away) {
    const forget = button("Forget it", async () => {
      if (!confirm(`Stop showing ${r.path}? If it was moved, mark it as a media folder where it is now (its Properties in phil).`)) return;
      await api("api/media/forget", { method: "POST", body: JSON.stringify({ path: r.path }) }).catch((err) => alert(err.message));
      loadMedia();
    });
    forget.title = "It was moved or deleted outside phil (phil carries it along when it moves it)";
    line.append(` ${r.path} isn't there now: its drive unplugged, or moved outside phil (shown as when last seen). `, forget);
  }
  // Not downloaded yet, or a folder not there: said at the top, where it's seen.
  line.classList.toggle("first", !status.ready || !!status.building || away.length > 0);
}

function onMediaStatus(status) {
  const was = media.lib?.imdb;
  if (media.lib) media.lib.imdb = status;
  showMediaStatus(status);
  if (was?.building && !status.building) loadMedia(); // built: matched again
}

for (const tab of mediaView.querySelectorAll(".mv-tabs [data-tab]")) {
  tab.onclick = () => {
    media.tab = tab.dataset.tab;
    remember("tab", media.tab);
    closeMediaDetail();
    renderMedia();
  };
}
mediaView.querySelector(".mv-filter").oninput = () => renderMedia();
mediaView.querySelector(".mv-genre").onchange = () => renderMedia();
mediaView.querySelector(".mv-sort").onchange = () => ((media.reverse = false), remember("sort", mediaView.querySelector(".mv-sort").value), renderMedia());
for (const b of mediaView.querySelectorAll(".mv-layout [data-layout]")) {
  b.onclick = () => {
    remember("layout", b.dataset.layout);
    renderMedia();
  };
}
// The list's column headings: sorted by it; again, the other way.
for (const h of mediaCols.querySelectorAll("[data-sort]")) {
  h.onclick = () => {
    const select = mediaView.querySelector(".mv-sort");
    media.reverse = select.value === h.dataset.sort ? !media.reverse : false;
    select.value = h.dataset.sort;
    remember("sort", select.value);
    renderMedia();
  };
}

const MEDIA_SORTS = {
  added: (a, b) => b.added - a.added,
  rating: (a, b) => (b.rating ?? -1) - (a.rating ?? -1) || (b.votes ?? 0) - (a.votes ?? 0),
  votes: (a, b) => (b.votes ?? 0) - (a.votes ?? 0),
  year: (a, b) => (b.year ?? 0) - (a.year ?? 0),
  title: (a, b) => collator.compare(a.title, b.title),
  length: (a, b) => (b.minutes ?? 0) - (a.minutes ?? 0),
};

function renderMedia() {
  const lib = media.lib;
  if (!lib) return;
  for (const tab of mediaView.querySelectorAll(".mv-tabs [data-tab]")) {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === media.tab));
    put(tab.querySelector(".n"), "textContent", String(lib[tab.dataset.tab].length));
  }
  const all = lib[media.tab];
  // Genres: those of what's in this tab.
  const genreSelect = mediaView.querySelector(".mv-genre");
  const genres = [...new Set(all.flatMap((x) => x.genres ?? []))].sort(collator.compare);
  const picked = genreSelect.value;
  if (genreSelect.options.length - 1 !== genres.length || genres.some((g, i) => genreSelect.options[i + 1].value !== g)) {
    genreSelect.replaceChildren(new Option("All genres", ""), ...genres.map((g) => new Option(g, g)));
    genreSelect.value = genres.includes(picked) ? picked : "";
  }
  const q = mediaView.querySelector(".mv-filter").value.trim().toLowerCase();
  const genre = genreSelect.value, sort = mediaView.querySelector(".mv-sort").value;
  const list = all.filter((x) => (!q || x.title.toLowerCase().includes(q) || x.parsed.title.toLowerCase().includes(q)) && (!genre || x.genres?.includes(genre)));
  list.sort((a, b) => (media.reverse ? -1 : 1) * (MEDIA_SORTS[sort](a, b) || collator.compare(a.title, b.title)));

  // What's been started, latest first (not while looking for something).
  const going = q || genre ? [] : all.map((x) => ({ x, next: nextToPlay(x) })).filter((c) => c.next?.resume).sort((a, b) => b.next.at - a.next.at).slice(0, 12);
  mediaView.querySelector(".mv-continue-wrap").hidden = !going.length;
  keyed(mediaContinue, going, { key: (c) => mediaKey(c.x), make: makeContinueCard, show: showContinueCard });

  const layout = layoutNow();
  for (const b of mediaView.querySelectorAll(".mv-layout [data-layout]")) b.setAttribute("aria-pressed", String(b.dataset.layout === layout));
  mediaCols.hidden = layout !== "list" || !list.length;
  for (const h of mediaCols.querySelectorAll("[data-sort]")) {
    h.classList.toggle("sorted", h.dataset.sort === sort);
    h.classList.toggle("reverse", h.dataset.sort === sort && media.reverse);
  }
  put(mediaCols.querySelector('[data-sort="length"]'), "textContent", media.tab === "shows" ? "Episodes" : "Length");
  mediaGrid.classList.toggle("list", layout === "list");
  keyed(mediaGrid, list, {
    key: mediaKey,
    kind: () => layout,
    make: layout === "list" ? makeMediaRow : makeMediaCard,
    show: layout === "list" ? showMediaRow : showMediaCard,
  });
  const empty = mediaView.querySelector(".mv-empty");
  empty.hidden = list.length > 0;
  empty.textContent = !lib.roots.length ? "No media folders yet: in a folder's Properties (right-click it), tick “A media folder”."
    : all.length ? "Nothing matches." : media.tab === "movies" ? "No movies in the media folders." : "No TV shows in the media folders.";
}

const mediaFiles = (x) => (isShow(x) ? x.seasons.flatMap((s) => s.episodes.flatMap((e) => e.files)) : x.files);
const firstFile = (x) => mediaFiles(x).find((f) => !f.offline) ?? mediaFiles(x)[0];
const posterUrl = (x) => {
  const f = firstFile(x);
  return f && !f.offline ? `api/media/poster?path=${encodeURIComponent(f.path)}` : "";
};
const putSrc = (img, src) => img.getAttribute("src") !== src && (src ? img.setAttribute("src", src) : img.removeAttribute("src"));
const QUALITY_RANK = { "2160p": 4, "1080p": 3, "720p": 2, "576p": 1, "480p": 1 };
const SOURCE_RANK = { BluRay: 3, "WEB-DL": 2, WEBRip: 2, WEB: 2, HDTV: 1, DVD: 0 };
const bestQuality = (files) => files.map((f) => f.quality).filter(Boolean).sort((a, b) => (QUALITY_RANK[b] ?? 0) - (QUALITY_RANK[a] ?? 0))[0] ?? "";
const runtime = (minutes) => (minutes ? `${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)} h ` : ""}${minutes % 60} min` : "");
const episodeName = (e) => `S${e.season ?? "?"} E${e.episode ?? "?"}${e.title ? ` · ${e.title}` : ""}`;
const votesText = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n ?? 0));

/**
 * What playing `x` plays: {file, episode, resume, at}. A movie: the copy
 * that was started (to go on from there), or the best one here. A show: the
 * episode last watched if it wasn't finished, else the one after it, else the
 * first. `resume`: it goes on from where it was left (or on to the next
 * episode); `at`: when that was watched.
 */
function nextToPlay(x) {
  if (!isShow(x)) {
    const files = x.files.filter((f) => !f.offline);
    const started = files.filter((f) => typeof f.watched === "number").sort((a, b) => (b.watchedAt ?? 0) - (a.watchedAt ?? 0))[0];
    if (started) return { file: started, resume: true, at: started.watchedAt ?? 0 };
    const best = [...files].sort((a, b) => (QUALITY_RANK[b.quality] ?? 0) - (QUALITY_RANK[a.quality] ?? 0) || (SOURCE_RANK[b.source] ?? 0) - (SOURCE_RANK[a.source] ?? 0))[0];
    return best ? { file: best, resume: false } : null;
  }
  const eps = x.seasons.flatMap((s) => s.episodes).filter((e) => e.files.length);
  let last = -1, at = 0;
  eps.forEach((e, i) => {
    for (const f of e.files) if (f.watched !== null && (f.watchedAt ?? 0) >= at) (last = i), (at = f.watchedAt ?? 0);
  });
  const online = (e) => e?.files.find((f) => !f.offline);
  if (last === -1) return online(eps[0]) ? { file: online(eps[0]), episode: eps[0], resume: false } : null;
  const lastEp = eps[last], lastFile = lastEp.files.find((f) => f.watched !== null);
  if (typeof lastFile.watched === "number" && !lastFile.offline) return { file: lastFile, episode: lastEp, resume: true, at };
  const after = eps.slice(last + 1).find((e) => online(e));
  return after ? { file: online(after), episode: after, resume: true, at } : null;
}

// How far it's been watched, 0 to 1 (null: not started): a movie's started copy; a show's episodes here.
function progressOf(x) {
  if (isShow(x)) {
    const eps = x.seasons.flatMap((s) => s.episodes).filter((e) => e.files.length);
    const done = eps.filter((e) => e.files.some((f) => f.watched === "done")).length;
    return done ? done / eps.length : null;
  }
  if (x.files.some((f) => f.watched === "done")) return 1;
  const t = Math.max(...x.files.map((f) => (typeof f.watched === "number" ? f.watched : 0)));
  return t && x.minutes ? Math.min(0.97, t / (x.minutes * 60)) : t ? 0.5 : null;
}

function play(x) {
  const next = nextToPlay(x);
  if (next) playMedia(next.file);
}

function mediaMeta(x, short = false) {
  const parts = [];
  if (isShow(x)) {
    if (x.year) parts.push(x.endYear && x.endYear !== x.year ? `${x.year}–${x.endYear}` : x.type === "tvSeries" && !x.endYear ? `${x.year}–` : String(x.year));
  } else if (x.year) parts.push(String(x.year));
  if (!short && x.rating) parts.push(`★ ${x.rating.toFixed(1)} (${votesText(x.votes)} votes)`);
  if (isShow(x)) {
    const have = x.seasons.reduce((n, s) => n + s.episodes.filter((e) => e.files.length).length, 0);
    parts.push(`${have} episode${have === 1 ? "" : "s"}${short ? "" : ` here, of ${x.seasonCount} season${x.seasonCount === 1 ? "" : "s"}`}`);
  } else if (x.minutes) parts.push(runtime(x.minutes));
  return parts.join(" · ");
}

function mediaBadges(x) {
  const files = mediaFiles(x), badges = [];
  if (x.match === "guess") badges.push(["?", "guess", "A guess: is it right?"]);
  if (x.match === "none") badges.push(["!", "none", "Not found in IMDb's titles"]);
  if (files.every((f) => f.offline)) badges.push(["⏏", "offline", "Its drive isn't there"]);
  if (!isShow(x) && files.some((f) => f.watched === "done")) badges.push(["✓", "watched", "Watched"]);
  return badges;
}

const putBadges = (box, badges) => {
  const html = badges.map(([t, c, title]) => `<span class="b ${c}" title="${title}">${t}</span>`).join("");
  if (box.innerHTML !== html) box.innerHTML = html;
};

const mediaTooltip = (x) => `${x.title}${x.year ? ` (${x.year})` : ""}\n${mediaMeta(x)}${x.genres?.length ? `\n${x.genres.join(", ")}` : ""}`;

// A title as a picture: its frame, rating, how far it's been watched; a play button on it.
function makeMediaCard() {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "mv-card";
  card.innerHTML = `<div class="mv-poster"><img loading="lazy" alt=""><span class="mv-badges"></span><span class="mv-rating"></span><span class="mv-q"></span><span class="mv-bar"><span></span></span><span class="mv-play-over" title="Play">${icon("play")}</span></div><span class="mv-title"></span><span class="mv-meta"></span>`;
  card.onclick = (e) => (e.target.closest(".mv-play-over") ? play(card.item) : openMediaDetail(card.item));
  return card;
}

function showMediaCard(card, x) {
  putSrc(card.querySelector("img"), posterUrl(x));
  put(card.querySelector(".mv-title"), "textContent", x.title);
  put(card.querySelector(".mv-meta"), "textContent", mediaMeta(x, true));
  put(card, "title", mediaTooltip(x));
  put(card.querySelector(".mv-rating"), "textContent", x.rating ? `★ ${x.rating.toFixed(1)}` : "");
  put(card.querySelector(".mv-q"), "textContent", isShow(x) ? "" : bestQuality(x.files));
  putBadges(card.querySelector(".mv-badges"), mediaBadges(x));
  const p = progressOf(x);
  card.querySelector(".mv-bar").hidden = p === null;
  put(card.querySelector(".mv-bar > span").style, "width", `${Math.round((p ?? 0) * 100)}%`);
  card.querySelector(".mv-bar").classList.toggle("done", p === 1);
  card.querySelector(".mv-play-over").hidden = !nextToPlay(x);
  card.classList.toggle("selected", mediaKey(x) === media.open);
}

// A title as a row of the list.
function makeMediaRow() {
  const row = document.createElement("div");
  row.className = "mv-row";
  row.tabIndex = 0;
  row.innerHTML = `<span class="c-pic"><img loading="lazy" alt=""><span class="mv-bar"><span></span></span></span><span class="c-title"><span class="t"></span><span class="mv-badges"></span></span><span class="c-year"></span><span class="c-rating"></span><span class="c-votes"></span><span class="c-length"></span><span class="c-genres"></span><span class="c-quality"></span><span class="c-added"></span>`;
  row.onclick = () => openMediaDetail(row.item);
  row.ondblclick = () => play(row.item);
  row.onkeydown = (e) => e.key === "Enter" && (e.preventDefault(), openMediaDetail(row.item));
  return row;
}

function showMediaRow(row, x) {
  putSrc(row.querySelector("img"), posterUrl(x));
  put(row.querySelector(".t"), "textContent", x.title);
  put(row, "title", `${mediaTooltip(x)}\nClick: details. Double-click: play`);
  putBadges(row.querySelector(".mv-badges"), mediaBadges(x));
  put(row.querySelector(".c-year"), "textContent", isShow(x) ? mediaMeta({ ...x, seasons: [], rating: null }, true).split(" · ")[0] : String(x.year ?? ""));
  put(row.querySelector(".c-rating"), "textContent", x.rating ? `★ ${x.rating.toFixed(1)}` : "–");
  put(row.querySelector(".c-votes"), "textContent", x.votes ? votesText(x.votes) : "");
  put(row.querySelector(".c-length"), "textContent", isShow(x) ? String(x.seasons.reduce((n, s) => n + s.episodes.filter((e) => e.files.length).length, 0)) : runtime(x.minutes));
  put(row.querySelector(".c-genres"), "textContent", (x.genres ?? []).join(", "));
  put(row.querySelector(".c-quality"), "textContent", bestQuality(mediaFiles(x)));
  put(row.querySelector(".c-added"), "textContent", x.added ? fromNow(x.added) : "");
  put(row.querySelector(".c-added"), "title", x.added ? new Date(x.added).toLocaleString() : "");
  const p = progressOf(x);
  row.querySelector(".mv-bar").hidden = p === null;
  put(row.querySelector(".mv-bar > span").style, "width", `${Math.round((p ?? 0) * 100)}%`);
  row.querySelector(".mv-bar").classList.toggle("done", p === 1);
  row.classList.toggle("selected", mediaKey(x) === media.open);
}

// "Continue watching": a click goes on with it (a movie where it was left, a show's next episode).
function makeContinueCard() {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "mv-card mv-going";
  card.innerHTML = `<div class="mv-poster"><img alt=""><span class="mv-bar"><span></span></span><span class="mv-play-over">${icon("play")}</span></div><span class="mv-title"></span><span class="mv-meta"></span>`;
  card.onclick = () => playMedia(card.item.next.file);
  card.oncontextmenu = (e) => (e.preventDefault(), openMediaDetail(card.item.x));
  return card;
}

function showContinueCard(card, { x, next }) {
  putSrc(card.querySelector("img"), next.file.offline ? "" : `api/media/poster?path=${encodeURIComponent(next.file.path)}`);
  // The title's own picture under it, while the episode's is being made.
  const behind = posterUrl(x) ? `url("${posterUrl(x)}")` : "";
  put(card.querySelector(".mv-poster").style, "backgroundImage", behind);
  put(card.querySelector(".mv-title"), "textContent", x.title);
  const t = typeof next.file.watched === "number" ? next.file.watched : 0;
  put(card.querySelector(".mv-meta"), "textContent", next.episode ? episodeName(next.episode) : t ? `${Math.round(t / 60)} min in` : "");
  put(card, "title", `${x.title}${next.episode ? `\n${episodeName(next.episode)}` : ""}\nClick: play${t ? ` from ${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}` : ""}. Right-click: details`);
  const minutes = x.minutes;
  const p = t && minutes ? Math.min(0.97, t / (minutes * 60)) : 0;
  card.querySelector(".mv-bar").hidden = !p;
  put(card.querySelector(".mv-bar > span").style, "width", `${Math.round(p * 100)}%`);
}

// One title's details: what it is, playing it, its files (a show's seasons and episodes), and its match.
function openMediaDetail(x) {
  media.open = mediaKey(x);
  media.openKey = x.key;
  mediaDetail.hidden = false;
  mediaView.classList.add("detail");
  for (const el of mediaView.querySelectorAll(".mv-card, .mv-row")) el.classList.toggle("selected", el.item && mediaKey(el.item) === media.open);
  const d = (sel) => mediaDetail.querySelector(sel);
  const poster = d(".mv-d-poster"), src = posterUrl(x);
  d(".mv-d-hero").classList.toggle("empty", !src);
  putSrc(poster, src);
  d(".mv-d-title").textContent = x.title;
  d(".mv-d-facts").textContent = mediaMeta(x);
  d(".mv-d-genres").textContent = (x.genres ?? []).join(" · ");

  const next = nextToPlay(x), playButton = d(".mv-d-play");
  playButton.hidden = !next;
  if (next) {
    const t = typeof next.file.watched === "number" ? next.file.watched : 0;
    playButton.innerHTML = icon("play");
    playButton.append(next.episode ? `${t ? "Resume" : "Play"} ${episodeName(next.episode)}` : t ? `Resume (${Math.round(t / 60)} min in)` : "Play");
    playButton.title = next.file.path;
    playButton.onclick = () => playMedia(next.file);
  }
  const imdbButton = d(".mv-d-imdb");
  imdbButton.hidden = !x.imdb;
  if (!imdbButton.querySelector("svg")) imdbButton.insertAdjacentHTML("beforeend", icon("external-link"));
  imdbButton.onclick = () => api("api/open-url", { method: "POST", body: JSON.stringify({ url: `https://www.imdb.com/title/${x.imdb}/` }) }).catch((err) => alert(err.message));

  const files = d(".mv-d-files");
  files.replaceChildren();
  if (isShow(x)) {
    for (const season of x.seasons) {
      const have = season.episodes.filter((e) => e.files.length).length;
      const h = document.createElement("h4");
      h.append(season.season === null ? "Episodes" : `Season ${season.season}`, Object.assign(document.createElement("span"), { className: "hint", textContent: `${have} of ${season.episodes.length} here` }));
      files.append(h);
      for (const e of season.episodes) {
        const f = e.files.find((g) => !g.offline) ?? e.files[0];
        const row = document.createElement("div");
        row.className = "mv-ep" + (f ? "" : " missing") + (f?.offline ? " offline" : "");
        row.innerHTML = `<span class="mv-ep-n"><span class="n"></span>${icon("play", "p")}</span><span class="mv-ep-title"></span><span class="mv-ep-rating"></span><span class="mv-ep-state"></span>`;
        row.querySelector(".n").textContent = e.episode ?? "";
        row.querySelector(".mv-ep-title").textContent = e.title ?? (f ? f.path.split("/").pop() : "");
        row.querySelector(".mv-ep-rating").textContent = e.rating ? `★ ${e.rating.toFixed(1)}` : "";
        const state = !f ? "" : f.offline ? "⏏" : f.watched === "done" ? "✓" : typeof f.watched === "number" ? "◐" : "";
        row.querySelector(".mv-ep-state").textContent = state;
        row.querySelector(".mv-ep-state").title = { "⏏": "Its drive isn't there", "✓": "Watched", "◐": "Started" }[state] ?? "";
        if (f) {
          row.title = `${f.path}\n${[f.quality, f.source, formatSize(f.size)].filter(Boolean).join(" · ")}${f.offline ? "\nIts drive isn't there" : "\nClick: play. Right-click: show it in its folder"}`;
          row.onclick = () => !f.offline && playMedia(f);
          row.oncontextmenu = (ev) => (ev.preventDefault(), showMediaFile(f));
        } else {
          row.title = "Not here";
          const search = searchLink(x, e);
          if (search) row.querySelector(".mv-ep-state").replaceWith(search);
        }
        files.append(row);
      }
    }
  } else {
    const h = document.createElement("h4");
    h.textContent = x.files.length > 1 ? `${x.files.length} copies` : "File";
    files.append(h);
    for (const f of x.files) {
      const row = document.createElement("div");
      row.className = "mv-file" + (f.offline ? " offline" : "");
      row.innerHTML = `<div class="mv-f-main"><span class="mv-f-what"></span><span class="mv-f-name"></span></div><button type="button" class="icon mv-f-play" title="Play">${icon("play")}</button><button type="button" class="icon mv-f-show" title="Show it in its folder">${icon("folder-open")}</button>`;
      row.querySelector(".mv-f-what").textContent = [f.quality, f.source, formatSize(f.size), f.watched === "done" ? "watched" : typeof f.watched === "number" ? `${Math.round(f.watched / 60)} min in` : "", f.offline ? "its drive isn't there" : ""].filter(Boolean).join(" · ");
      row.querySelector(".mv-f-name").textContent = f.path.split("/").pop();
      row.querySelector(".mv-f-name").title = f.path;
      row.querySelector(".mv-f-play").disabled = row.querySelector(".mv-f-show").disabled = f.offline;
      row.querySelector(".mv-f-play").onclick = () => playMedia(f);
      row.querySelector(".mv-f-show").onclick = () => showMediaFile(f);
      row.querySelector(".mv-f-show").title = `Show it in its folder:\n${f.path.slice(0, f.path.lastIndexOf("/")) || "/"}${f.offline ? "\n(its drive isn't there)" : ""}`;
      files.append(row);
    }
  }

  // Its match: out of the way when it's sure.
  const from = `“${x.parsed.title}${x.parsed.year ? ` (${x.parsed.year})` : ""}”`;
  const fix = d(".mv-d-fix");
  fix.open = x.match !== "sure";
  d(".mv-d-fix summary").textContent = x.fixed ? "Picked by hand" : x.match === "sure" ? `Matched from ${from}. Not right?` : x.match === "guess" ? `A guess, from ${from}: is it right?` : `Not found in IMDb's titles, from ${from}`;
  d(".mv-d-again").hidden = !x.fixed;
  d(".mv-d-again").onclick = () => fixMedia(x, null);
  d(".mv-d-none").onclick = () => confirm(`Leave “${x.title}” out of the Media view? (Its files stay where they are.)`) && fixMedia(x, 0);
  const search = d(".mv-d-search");
  search.value = "";
  d(".mv-d-results").replaceChildren();
  search.oninput = () => {
    clearTimeout(search.timer);
    search.timer = setTimeout(() => findMediaTitles(x, search.value), 250);
  };
  mediaDetail.scrollTop = 0;
}

// A missing episode's link: the download search engine (phil's Preferences) for
// "<show> S01E01", in the browser. Null when there's none set.
function searchLink(x, e) {
  const url = media.lib?.searchUrl;
  if (!url || e.season == null || e.episode == null) return null;
  const query = `${x.title} S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")}`;
  const page = url.includes("%s") ? url.replaceAll("%s", encodeURIComponent(query)) : url + encodeURIComponent(query);
  const b = Object.assign(document.createElement("button"), { type: "button", className: "icon mv-ep-search", title: `Search for \u201c${query}\u201d\n${new URL(page).host}` });
  b.innerHTML = icon("link");
  b.onclick = (ev) => {
    ev.stopPropagation();
    api("api/open-url", { method: "POST", body: JSON.stringify({ url: page }) }).catch((err) => alert(err.message));
  };
  return b;
}

function closeMediaDetail() {
  media.open = media.openKey = null;
  mediaDetail.hidden = true;
  mediaView.classList.remove("detail");
  for (const el of mediaView.querySelectorAll(".selected")) el.classList.remove("selected");
}

async function findMediaTitles(x, text) {
  const box = mediaDetail.querySelector(".mv-d-results");
  if (!text.trim()) return box.replaceChildren();
  const found = await api(`api/media/search?q=${encodeURIComponent(text)}`).catch(() => []);
  if (mediaDetail.querySelector(".mv-d-search").value !== text) return; // typed on
  const kinds = { movie: "movie", tvMovie: "TV movie", tvSeries: "TV series", tvMiniSeries: "miniseries", tvSpecial: "TV special", video: "video" };
  box.replaceChildren(...found.map((t) => {
    const b = Object.assign(document.createElement("button"), { type: "button", className: "mv-result" });
    b.append(Object.assign(document.createElement("span"), { textContent: `${t.title}${t.year ? ` (${t.year})` : ""}` }),
      Object.assign(document.createElement("span"), { className: "hint", textContent: [kinds[t.type] ?? t.type, t.rating ? `★ ${t.rating.toFixed(1)}` : "", t.votes ? `${votesText(t.votes)} votes` : ""].filter(Boolean).join(" · ") }));
    b.onclick = () => fixMedia(x, t.id);
    return b;
  }));
  if (!found.length) box.append(Object.assign(document.createElement("p"), { className: "hint", textContent: "Nothing called that." }));
}

// What the files named as `x` was are, by hand: an IMDb id, 0 (none: left out), null (matched again).
async function fixMedia(x, id) {
  try {
    await api("api/media/fix", { method: "PUT", body: JSON.stringify({ key: x.key, id }) });
  } catch (err) {
    return alert(`Couldn't save it: ${err.message}`);
  }
  media.open = id ? `tt${id}` : null;
  if (!id) closeMediaDetail();
  loadMedia();
}

// ---------------------------------------------------------------- playing, and the files' folders

// A video plays in videoplayer, shown over this page; closed, what was watched shows.
const player = $("#player");
let focusBeforePlayer = null;

function playMedia(f) {
  if (f.offline) return;
  focusBeforePlayer = document.activeElement;
  const src = appUrl("videoplayer", { file: f.path });
  const frame = Object.assign(document.createElement("iframe"), { src, title: "videoplayer", allow: "fullscreen" });
  frame.dataset.embed = embedOf(src);
  player.replaceChildren(frame);
  player.hidden = false;
  frame.focus();
}

function closePlayer() {
  if (player.hidden) return;
  player.hidden = true;
  player.replaceChildren();
  (focusBeforePlayer?.isConnected ? focusBeforePlayer : $(".mv-filter")).focus({ preventScroll: true });
  loadMedia(); // (what was watched, and how far)
}

// The player says it's ready (kit.js ready()): it gets the keyboard; or it closes.
addEventListener("message", (e) => {
  const frame = player.querySelector("iframe");
  if (!frame || e.origin !== location.origin || e.data?.embed !== frame.dataset.embed) return;
  if (e.data?.engine === "ready") {
    frame.focus();
    frame.contentWindow.focus();
    frame.contentWindow.postMessage({ engine: "focus" }, "*");
  } else if (e.data?.engine === "close") closePlayer();
});

// A file in its folder: in phil, the window this is shown in (it closes this);
// on its own, a phil window.
function showMediaFile(f) {
  if (f.offline) return;
  if (embedded) return tellParent({ app: "mediaview", show: f.path });
  api("api/show", { method: "POST", body: JSON.stringify({ path: f.path }) }).catch((err) => alert(err.message));
}

// Esc: the details close, then the view (back to phil, or the window).
addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (document.activeElement?.matches?.(".mv-d-search, .mv-filter") && document.activeElement.value) return; // (clears it)
  e.preventDefault();
  mediaDetail.hidden ? closeWindow() : closeMediaDetail();
});
// Phil asks it to close (Esc while phil still had the keyboard): the player first, then the details.
onCloseRequest(() => {
  if (!player.hidden) return player.querySelector("iframe")?.contentWindow.postMessage({ engine: "close-request" }, "*");
  mediaDetail.hidden ? closeWindow() : closeMediaDetail();
});

// IMDb's datasets being downloaded: how far, as it goes.
new EventSource("api/media/events").onmessage = (e) => onMediaStatus(JSON.parse(e.data));

await loadMedia();
shown();
