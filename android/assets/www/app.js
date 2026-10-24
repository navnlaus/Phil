// The light phil: the phone's own files, and the PC's when it's paired and in
// reach, as phil's tiles (a folder's face: its first pictures; a picture's,
// a video's, a song's: its thumbnail) in phil's theme. Serve.java answers:
// /phone/... from the phone, /pc/... from phil on the PC; thumbnails of both
// are kept on the phone.
//
// A tap opens a folder, shows a picture (swipe for the next), plays a video
// or a song (the next one in the folder after it), and opens anything else
// (the phone's: in the app for it; the PC's: saved to the phone first). A
// long press: what else can be done with it (Open with…, Send to PC, Save to
// phone). The + on a PC folder sends files from the phone into it. Back goes
// back.

const $ = (s) => document.querySelector(s);
const ICONS = { // phil's (apps/phil/ui/index.html), and Lucide's for the places
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  file: '<path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="1"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-9 9"/>',
  video: '<rect x="3" y="5" width="13" height="14" rx="1"/><path d="M16 10l5-3v10l-5-3z"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-3z"/><circle cx="12" cy="13" r="3.5"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  "file-text": '<path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  drive: '<path d="M22 12H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M6 16h.01M10 16h.01"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
};
const svg = (name, cls = "") => `<svg viewBox="0 0 24 24" class="${cls}">${ICONS[name] ?? ICONS.file}</svg>`;
const KIND_ICON = { dir: "folder", image: "image", video: "video", pdf: "file", file: "file", audio: "music" };
const VIEWED = new Set(["image", "video", "audio"]);
// What has a thumbnail (a song's: its cover art).
const hasThumb = (e) => ["image", "video", "pdf", "audio"].includes(e.kind);
const root = document.documentElement;

const state = {
  side: "phone", path: null, parent: null, entries: [],
  phone: { home: "/", places: [] }, pc: { paired: false, reachable: false, name: "PC", home: "/", places: [] },
  hidden: false, viewing: null,
};
let cols = Number(read("cols")) || 2;

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function keep(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch { /* not kept */ }
}

async function api(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `${res.status}`), { status: res.status });
  return body;
}

const base = (side) => (side === "phone" ? "/phone" : "/pc");
const fileUrl = (side, path) => `${base(side)}/file?path=${encodeURIComponent(path)}`;
// The PC's thumbnail URLs (/m/thumbs/...) through Serve, which keeps them.
const pcUrl = (url) => `/pc${url}`;

// ---------------------------------------------------------------- folders

async function open(side, path, { push = true } = {}) {
  closeViewer({ back: false });
  closeSheet();
  let listing;
  try {
    listing = await api(`${base(side)}/list?path=${encodeURIComponent(path)}${state.hidden ? "&hidden=1" : ""}`);
  } catch (err) {
    if (side === "phone" && /all files/.test(err.message)) {
      return showMessage("phil needs access to all files to show the phone's.", ["Allow it", () => globalThis.Phil?.askFiles()]);
    }
    return showMessage(`Can't open ${path}: ${err.message}`);
  }
  Object.assign(state, { side, path: listing.path, parent: listing.parent, entries: listing.entries });
  if (push) history.pushState({ side, path: state.path }, "");
  keep("last", JSON.stringify({ side, path: state.path }));
  render();
  scrollTo(0, 0);
}

function render() {
  const { side, path } = state;
  if (!path) return; // (the PC's status came before the first folder)
  const home = state[side].home;
  const place = [...state[side].places].sort((a, b) => b.path.length - a.path.length).find((p) => path === p.path || path.startsWith(p.path + "/"));
  $("#title").textContent = place?.path === path ? place.name : path === "/" ? "/" : path.split("/").pop();
  $("#path").textContent = (side === "phone" ? "Phone" : state.pc.name) + " · " +
    (side === "phone" && path.startsWith(home) ? path.slice(home.length) || "/" : side === "pc" && path.startsWith(home) ? "~" + path.slice(home.length) : path);
  // The phone's storage is as far up as it goes (above it, Android shows nothing).
  const top = side === "phone" && state.phone.places.some((p) => (p.icon === "phone" || p.icon === "drive") && p.path === path);
  $("#up").disabled = !state.parent || top;
  for (const b of $("#places").querySelectorAll("button[data-path]")) b.classList.toggle("here", b.dataset.side === side && b.dataset.path === path);
  $("#send-here").hidden = !(side === "pc" && state.pc.reachable);
  const grid = $("#grid");
  watching.disconnect();
  grid.replaceChildren(...state.entries.map(tile));
  showMessage(state.entries.length ? "" : "Nothing here");
}

// A tile, as phil makes it: .thumb (a picture, or the kind's icon; a folder's
// face), .label (name, then size and date, or what a folder holds), .marks.
function tile(e) {
  const side = state.side;
  const t = document.createElement("div");
  t.className = `tile ${e.kind}${e.name.startsWith(".") ? " hidden-file" : ""}`;
  t.entry = e;
  const box = Object.assign(document.createElement("div"), { className: "thumb" });
  if (e.kind !== "dir") {
    box.innerHTML = svg(KIND_ICON[e.kind] ?? "file", "kind");
    const ext = fileType(e.name);
    if (ext && (e.kind === "file" || e.kind === "pdf")) box.append(Object.assign(document.createElement("span"), { className: "ext", textContent: ext }));
    if (hasThumb(e)) {
      const img = Object.assign(document.createElement("img"), { alt: "", loading: "lazy", decoding: "async" });
      img.onload = () => (img.classList.add("shown"), box.classList.add("has-img"));
      img.onerror = () => img.remove();
      img.src = side === "phone" ? e.thumb : e.thumb ? pcUrl(e.thumb) : `/pc/thumb?path=${encodeURIComponent(e.path)}&size=${e.size}&mtime=${e.mtime}`;
      box.append(img);
    }
  }
  const label = Object.assign(document.createElement("div"), { className: "label" });
  label.append(Object.assign(document.createElement("span"), { className: "desc" }), Object.assign(document.createElement("span"), { className: "name", textContent: e.name }),
    Object.assign(document.createElement("span"), { className: "meta" }));
  t.append(box, label);
  if (e.kind === "dir") {
    showFolder(t, summaries.get(`${side}:${e.path}`) ?? e.summary);
    if (!summaries.has(`${side}:${e.path}`) && !(e.summary?.complete)) watching.observe(t);
  } else {
    showSong(t, e);
    if (e.kind === "audio" && !e.audio) watching.observe(t); // (its tags read when it comes into view)
  }
  const marks = [e.kind === "video" && ["play", "fill"], e.kind === "dir" && ["folder", "folder fill"]].filter(Boolean);
  if (marks.length) {
    const m = Object.assign(document.createElement("span"), { className: "marks" });
    m.innerHTML = marks.map(([name, cls]) => `<span class="badge ${cls}">${svg(name)}</span>`).join("");
    t.append(m);
    t.classList.add("has-marks");
    t.style.setProperty("--marks-n", marks.length);
  }
  t.onclick = () => activate(e);
  t.oncontextmenu = (ev) => (ev.preventDefault(), actions(e)); // (a long press)
  return t;
}

// A file's details; a song's: its title in place of its name, its artist over it, how long it is.
function showSong(t, e) {
  const song = e.kind === "audio" && e.audio ? e.audio : {};
  t.querySelector(".name").textContent = song.title || e.name;
  t.querySelector(".desc").textContent = song.artist ?? "";
  t.querySelector(".meta").textContent = [fileType(e.name).toUpperCase(), song.duration && songLength(song.duration), formatSize(e.size), formatDate(e.mtime)].filter(Boolean).join(" · ");
}
const songLength = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}` : Math.floor(s / 60)) + `:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// A folder's face (its first pictures, or an icon for what it holds) and what it holds.
function showFolder(t, summary) {
  const box = t.querySelector(".thumb");
  const face = Object.assign(document.createElement("div"), { className: "face" });
  const previews = summary?.previews ?? [];
  if (previews.length) {
    face.className = `face previews n${previews.length}`;
    for (const p of previews) {
      if (p.text) {
        const cell = Object.assign(document.createElement("div"), { className: "cell" });
        const text = Object.assign(document.createElement("div"), { className: "text" });
        for (const [kind, line] of p.text.lines ?? []) {
          const el = document.createElement(/^h\d/.test(kind) ? "b" : "span");
          el.textContent = line + "\n";
          text.append(el);
        }
        cell.append(text);
        face.append(cell);
      } else {
        const img = Object.assign(document.createElement("img"), { alt: "", loading: "lazy", decoding: "async", src: state.side === "pc" ? pcUrl(p.url) : p.url });
        img.onerror = () => img.remove();
        face.append(img);
      }
    }
  } else if (summary?.files || summary?.dirs) face.innerHTML = svg(summary.files ? "file" : "folder", "kind");
  box.replaceChildren(face);
  t.classList.toggle("empty-dir", !!summary && !summary.files && !summary.dirs);
  t.querySelector(".meta").textContent = summary ? contents(summary) : "";
}

// "3 folders · 12 files · 45 MB", as phil says it.
function contents({ files, dirs, size }) {
  const count = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
  const parts = [];
  if (dirs) parts.push(count(dirs, "folder"));
  if (files) parts.push(count(files, "file"), formatSize(size));
  return parts.join(" · ") || "Empty";
}

// Folders' summaries (and songs' tags), asked for as their tiles come into view (three at a time), kept for the session.
const summaries = new Map(); // "side:path" -> summary
const queue = [];
let asking = 0;
const watching = new IntersectionObserver((seen) => {
  for (const s of seen) {
    if (!s.isIntersecting) continue;
    watching.unobserve(s.target);
    queue.push(s.target);
  }
  pump();
}, { rootMargin: "200px" });

function pump() {
  while (asking < 3 && queue.length) {
    const t = queue.shift();
    if (!t.isConnected) continue;
    const side = state.side, e = t.entry;
    asking++;
    if (e.kind === "audio") { // a song's title and artist
      api(`${base(side)}/audio?path=${encodeURIComponent(e.path)}`)
        .then((info) => (e.audio = info, t.isConnected && showSong(t, e)), () => {})
        .finally(() => (asking--, pump()));
      continue;
    }
    api(`${base(side)}/summary?path=${encodeURIComponent(e.path)}`)
      .then((s) => {
        if (s.complete !== false) summaries.set(`${side}:${e.path}`, s);
        if (t.isConnected) showFolder(t, s);
      }, () => {})
      .finally(() => (asking--, pump()));
  }
}

function activate(e) {
  if (e.kind === "dir") return open(state.side, e.path);
  if (VIEWED.has(e.kind)) return view(e);
  if (state.side === "phone") return globalThis.Phil?.openFile(e.path);
  actions(e);
}

// A long press: what can be done with it.
function actions(e) {
  const side = state.side, list = [];
  if (e.kind === "dir") list.push(["Open", () => open(side, e.path)]);
  else if (VIEWED.has(e.kind)) list.push([e.kind === "image" ? "Show" : "Play", () => view(e)]);
  if (side === "phone" && e.kind !== "dir") {
    list.push(["Open with…", () => globalThis.Phil?.openFile(e.path)]);
    if (state.pc.reachable) list.push([`Send to ${state.pc.name}`, () => sendToPc(e)]);
  }
  if (side === "pc" && e.kind !== "dir") list.push(["Save to phone", () => saveToPhone(e)]);
  openSheet(e.name, list);
}

function sendToPc(e) {
  globalThis.Phil?.sendToPc(JSON.stringify([e.path]), "");
  toast(`Sending ${e.name} to ${state.pc.name}…`);
}

function saveToPhone(e) {
  globalThis.Phil?.download(e.path, e.name);
  toast(`Saving ${e.name} to Download…`);
}

function openSheet(title, list) {
  $("#sheet .sheet-title").textContent = title;
  $("#sheet .sheet-buttons").replaceChildren(...list.map(([text, act]) => {
    const b = Object.assign(document.createElement("button"), { textContent: text });
    b.onclick = () => {
      closeSheet();
      act();
    };
    return b;
  }));
  $("#sheet").hidden = !list.length;
}
const closeSheet = () => void ($("#sheet").hidden = true);

function showMessage(text, button = null) {
  $("#message").hidden = !text;
  $("#message p").textContent = text;
  const b = $("#message button");
  b.hidden = !button;
  if (button) [b.textContent, b.onclick] = button;
}

let toastTimer = null;
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 3000);
}

function fileType(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && name.length - dot <= 6 ? name.slice(dot + 1) : "";
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes, i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function formatDate(ms) {
  if (!ms) return "";
  const date = new Date(ms);
  const thisYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, thisYear ? { month: "short", day: "numeric" } : { dateStyle: "medium" });
}

// ---------------------------------------------------------------- the viewer

function view(e) {
  if (!state.viewing) history.pushState({ side: state.side, path: state.path, viewing: true }, "");
  state.viewing = e;
  const src = fileUrl(state.side, e.path);
  let el;
  if (e.kind === "image") el = Object.assign(document.createElement("img"), { src, alt: e.name });
  else if (e.kind === "video") el = Object.assign(document.createElement("video"), { src, controls: true, autoplay: true, playsInline: true });
  else {
    // A song: its cover (its thumbnail, if it has one) over the player; the next one after it.
    el = Object.assign(document.createElement("div"), { className: "song" });
    const audio = Object.assign(document.createElement("audio"), { src, controls: true, autoplay: true });
    audio.onended = () => next(1, "audio");
    if (state.side === "phone") {
      const cover = Object.assign(document.createElement("img"), { alt: "", src: e.thumb });
      cover.onerror = () => cover.remove();
      el.append(cover);
    }
    el.append(audio);
  }
  $("#viewer-body").replaceChildren(el);
  $("#viewer-name").textContent = e.name;
  const action = $("#viewer-action");
  action.textContent = state.side === "pc" ? "Save to phone" : "Open with…";
  action.onclick = () => (state.side === "pc" ? saveToPhone(e) : globalThis.Phil?.openFile(e.path));
  $("#viewer").hidden = false;
}

// The next (or previous) one of the same kind in the folder.
function next(step, kind = state.viewing?.kind) {
  const same = state.entries.filter((e) => e.kind === kind);
  const to = same[same.findIndex((e) => e.path === state.viewing?.path) + step];
  if (to) view(to);
}

function closeViewer({ back = true } = {}) {
  if (!state.viewing) return;
  state.viewing = null;
  $("#viewer-body").replaceChildren();
  $("#viewer").hidden = true;
  if (back) history.back();
}

let touchX = null;
$("#viewer-body").addEventListener("touchstart", (e) => (touchX = e.touches.length === 1 ? e.touches[0].clientX : null), { passive: true });
$("#viewer-body").addEventListener("touchend", (e) => {
  if (touchX === null || state.viewing?.kind !== "image") return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) > 60) next(dx < 0 ? 1 : -1);
});
$("#viewer-close").onclick = () => closeViewer();

// ---------------------------------------------------------------- places, the PC

function renderPlaces() {
  const box = $("#places");
  const chips = [Object.assign(document.createElement("span"), { className: "side", textContent: "Phone" })];
  const chip = (side, p) => {
    const b = Object.assign(document.createElement("button"), { innerHTML: svg(p.icon) });
    b.append(p.name);
    b.dataset.side = side;
    b.dataset.path = p.path;
    b.onclick = () => open(side, p.path);
    return b;
  };
  chips.push(...state.phone.places.map((p) => chip("phone", p)));
  const pc = state.pc;
  chips.push(Object.assign(document.createElement("span"), { className: "side", textContent: pc.paired ? pc.name : "PC" }));
  if (pc.paired && pc.reachable) chips.push(...pc.places.map((p) => chip("pc", p)));
  else {
    const b = Object.assign(document.createElement("button"), { innerHTML: svg(pc.paired ? "monitor" : "link") });
    b.append(pc.paired ? "Out of reach" : "Pair with a PC");
    b.classList.toggle("away", pc.paired);
    b.onclick = () => (pc.paired ? checkPc(true) : globalThis.Phil?.setup());
    chips.push(b);
  }
  box.replaceChildren(...chips);
  for (const b of box.querySelectorAll("button[data-path]")) b.classList.toggle("here", b.dataset.side === state.side && b.dataset.path === state.path);
}

// Is the PC there? Its places, and its look (the theme), when it is.
async function checkPc(said = false) {
  let s;
  try {
    s = await api("/pc/status");
  } catch {
    return;
  }
  Object.assign(state.pc, { paired: s.paired, reachable: s.reachable, name: s.name });
  // A newer phil on the PC: offered.
  $("#update").hidden = !s.update;
  if (s.update) $("#update span").textContent = `phil ${s.update} is ready on ${s.name}`;
  if (s.forgotten) toast("The PC forgot this phone: pair it again to see its files");
  if (s.themeChanged) for (const link of [$("#theme-base"), $("#theme")]) link.href = link.href.replace(/\?.*$/, "") + `?v=${Date.now()}`;
  if (s.reachable) {
    try {
      const { home, places, name } = await api("/pc/places");
      Object.assign(state.pc, { home, places, name: name ?? state.pc.name });
    } catch { /* again next time */ }
  } else if (said) toast(`${s.name} isn't in reach: on its Wi-Fi, or with Tailscale on?`);
  renderPlaces();
  if (state.side === "pc" && !s.reachable && state.path) showMessage(`${state.pc.name} isn't in reach.`, ["Try again", () => checkPc(true).then(() => state.pc.reachable && open("pc", state.path, { push: false }))]);
  else render();
}

// ---------------------------------------------------------------- the rest

$("#up").onclick = () => {
  if (state.parent) open(state.side, state.parent);
};
const showCols = () => root.style.setProperty("--cols", cols);
$("#cols").onclick = () => {
  cols = cols >= 4 ? 2 : cols + 1;
  keep("cols", cols);
  showCols();
};
$("#menu-button").onclick = (e) => {
  e.stopPropagation();
  $("#menu").hidden = !$("#menu").hidden;
  $("#menu [data-do=hidden]").textContent = state.hidden ? "Hide hidden files" : "Show hidden files";
};
document.addEventListener("click", (e) => {
  if (!e.target.closest("#menu")) $("#menu").hidden = true;
  if (!e.target.closest("#sheet, .tile")) closeSheet();
});
$("#menu").onclick = (e) => {
  const what = e.target.closest("button")?.dataset.do;
  $("#menu").hidden = true;
  if (what === "reload") summaries.clear(), open(state.side, state.path, { push: false }), checkPc();
  if (what === "hidden") (state.hidden = !state.hidden), open(state.side, state.path, { push: false });
  if (what === "setup") globalThis.Phil?.setup();
};
$("#send-here").onclick = () => globalThis.Phil?.pickAndSend(state.path);
$("#update button").onclick = () => {
  globalThis.Phil?.update();
  toast("Downloading the update…");
};

addEventListener("popstate", (e) => {
  if (!$("#sheet").hidden) closeSheet();
  if (state.viewing) return closeViewer({ back: false });
  if (e.state?.path) open(e.state.side, e.state.path, { push: false });
});

// What the app did (MainActivity, from LinkService).
globalThis.philEvent = (event) => {
  if ("sent" in event) {
    toast(`Sent to ${state.pc.name}`);
    if (state.side === "pc" && (event.sent === state.path || !event.sent)) open("pc", state.path, { push: false });
  }
  if (event.downloaded) toast(`Saved in Download: ${event.downloaded.split("/").pop()}`);
};
// Back in the app (all files allowed meanwhile, the PC paired): looked at again.
globalThis.philResumed = () => {
  checkPc();
  if (!state.path || $("#message").hidden === false) open(state.side, state.path ?? state.phone.home, { push: false });
};

(async () => {
  showCols();
  try {
    Object.assign(state.phone, await api("/phone/places"));
  } catch { /* none */ }
  renderPlaces();
  let last = null;
  try {
    last = JSON.parse(read("last"));
  } catch { /* none */ }
  const pc = checkPc();
  if (last?.side === "pc") await pc;
  const start = last && (last.side === "phone" || state.pc.reachable) ? last : { side: "phone", path: state.phone.home };
  await open(start.side, start.path, { push: false });
  if (!state.path) await open("phone", state.phone.home, { push: false });
  history.replaceState({ side: state.side, path: state.path }, "");
})();
