// The light phil: this PC's folders on the phone (phil's Android app shows this
// page, from the PC's link server: ../link.js). A tap opens a folder, shows a
// picture (swipe for the next), plays a video or a song (the next one in the
// folder after it), or downloads anything else (into the phone's Download
// folder, by the app); a long press downloads. The + sends files from the phone
// into the folder shown. Back goes back (the app's back button too).

const $ = (s) => document.querySelector(s);
const ICONS = {
  dir: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  video: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m22 8-6 4 6 4z"/>',
  audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  pdf: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  "file-text": '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24">${ICONS[name] ?? ICONS.file}</svg>`;
const hasThumb = (e) => e.kind === "image" || e.kind === "video" || e.kind === "pdf";
const fileUrl = (path, download = false) => `/m/file?path=${encodeURIComponent(path)}${download ? "&dl=1" : ""}`;

const state = { path: null, home: "/", places: [], entries: [], hidden: false, grid: localStorage.getItem("grid") === "1", viewing: null };

async function api(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body;
}

// ---------------------------------------------------------------- folders

async function open(path, { push = true } = {}) {
  closeViewer({ back: false });
  try {
    const listing = await api(`/m/api/list?path=${encodeURIComponent(path)}${state.hidden ? "&hidden=1" : ""}`);
    state.path = listing.path;
    state.parent = listing.parent;
    state.entries = listing.entries;
  } catch (err) {
    return showMessage(`Can't open ${path}: ${err.message}`);
  }
  if (push) history.pushState({ path: state.path }, "", "");
  try {
    localStorage.setItem("last", state.path);
  } catch { /* none */ }
  render();
  scrollTo(0, 0);
}

function render() {
  const name = state.path === state.home ? "Home" : state.path === "/" ? "/" : state.path.split("/").pop();
  $("#title").textContent = name;
  $("#path").textContent = state.path.startsWith(state.home) ? "~" + state.path.slice(state.home.length) : state.path;
  $("#up").disabled = !state.parent;
  for (const b of $("#places").children) b.classList.toggle("here", b.dataset.path === state.path);
  const list = $("#list");
  list.classList.toggle("grid", state.grid);
  list.replaceChildren(...state.entries.map(row));
  showMessage(state.entries.length ? "" : "Nothing here");
}

function row(e) {
  const el = document.createElement("div");
  el.className = `row ${e.kind}`;
  const pic = Object.assign(document.createElement("div"), { className: "pic", innerHTML: svg(e.kind) });
  if (hasThumb(e)) { // (in the tile from the start, unseen till it's there: a lazy image out of the page never loads)
    const img = Object.assign(document.createElement("img"), { loading: "lazy", alt: "", src: `/m/thumb?path=${encodeURIComponent(e.path)}` });
    img.onload = () => img.classList.add("shown");
    img.onerror = () => img.remove();
    pic.append(img);
  }
  const text = Object.assign(document.createElement("div"), { className: "text" });
  text.append(
    Object.assign(document.createElement("div"), { className: "name", textContent: e.name }),
    Object.assign(document.createElement("div"), { className: "meta", textContent: e.kind === "dir" ? date(e.mtime) : `${size(e.size)} · ${date(e.mtime)}` }),
  );
  el.append(pic, text);
  el.onclick = () => activate(e);
  let pressed = null;
  el.ontouchstart = () => (pressed = setTimeout(() => (pressed = "long", e.kind !== "dir" && download(e)), 600));
  el.ontouchend = el.ontouchmove = (ev) => {
    if (pressed === "long") ev.preventDefault();
    clearTimeout(pressed);
    pressed = null;
  };
  el.oncontextmenu = (ev) => ev.preventDefault();
  return el;
}

function activate(e) {
  if (e.kind === "dir") return open(e.path);
  if (e.kind === "image" || e.kind === "video" || e.kind === "audio") return view(e);
  download(e);
}

// Into the phone's Download folder (the app does it, in a notification).
function download(e) {
  location.href = fileUrl(e.path, true);
}

function showMessage(text) {
  $("#message").hidden = !text;
  $("#message").textContent = text;
}

const size = (n) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`;
const date = (ms) => ms ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";

// ---------------------------------------------------------------- the viewer

function view(e) {
  if (!state.viewing) history.pushState({ path: state.path, viewing: true }, "", "");
  state.viewing = e;
  const body = $("#viewer-body");
  let el;
  if (e.kind === "image") el = Object.assign(document.createElement("img"), { src: fileUrl(e.path), alt: e.name });
  else {
    el = Object.assign(document.createElement(e.kind), { src: fileUrl(e.path), controls: true, autoplay: true });
    if (e.kind === "audio") el.onended = () => next(1, "audio"); // the next song in the folder
  }
  body.replaceChildren(el);
  $("#viewer-name").textContent = e.name;
  $("#viewer-download").href = fileUrl(e.path, true);
  $("#viewer").hidden = false;
}

// The next (or previous) of the same kind in the folder.
function next(step, kind = state.viewing?.kind) {
  const same = state.entries.filter((e) => e.kind === kind);
  const i = same.findIndex((e) => e.path === state.viewing?.path);
  const to = same[i + step];
  if (to) view(to);
}

function closeViewer({ back = true } = {}) {
  if (!state.viewing) return;
  state.viewing = null;
  $("#viewer-body").replaceChildren();
  $("#viewer").hidden = true;
  if (back) history.back();
}

// Pictures: swipe for the next and previous.
let touchX = null;
$("#viewer-body").addEventListener("touchstart", (e) => (touchX = e.touches.length === 1 ? e.touches[0].clientX : null), { passive: true });
$("#viewer-body").addEventListener("touchend", (e) => {
  if (touchX === null || state.viewing?.kind !== "image") return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) > 60) next(dx < 0 ? 1 : -1);
});
$("#viewer-close").onclick = () => closeViewer();

// ---------------------------------------------------------------- sending files here

$("#upload").onclick = () => $("#files").click();
$("#files").onchange = async () => {
  const files = [...$("#files").files];
  $("#files").value = "";
  const dir = state.path;
  for (const file of files) await upload(file, dir);
  if (state.path === dir) open(dir, { push: false });
};

function upload(file, dir) {
  const box = $("#uploads");
  const item = Object.assign(document.createElement("div"), { className: "upload" });
  item.innerHTML = `<div class="name"></div><div class="bar"><div></div></div>`;
  item.firstChild.textContent = file.name;
  box.append(item);
  box.hidden = false;
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/m/api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}&size=${file.size}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && (item.querySelector(".bar > div").style.width = `${(e.loaded / e.total) * 100}%`);
    const done = (failed) => {
      if (failed) {
        item.classList.add("failed");
        item.firstChild.textContent = `${file.name}: ${failed}`;
        setTimeout(() => finish(), 6000);
      } else finish();
      resolve();
    };
    const finish = () => {
      item.remove();
      box.hidden = !box.children.length;
    };
    xhr.onload = () => done(xhr.status < 400 ? null : (() => {
      try {
        return JSON.parse(xhr.responseText).error;
      } catch {
        return `HTTP ${xhr.status}`;
      }
    })());
    xhr.onerror = () => done("not sent (connection lost)");
    xhr.send(file);
  });
}

// ---------------------------------------------------------------- the rest

$("#up").onclick = () => state.parent && open(state.parent);
$("#grid-toggle").onclick = () => {
  state.grid = !state.grid;
  try {
    localStorage.setItem("grid", state.grid ? "1" : "0");
  } catch { /* none */ }
  render();
};
$("#menu-button").onclick = (e) => {
  e.stopPropagation();
  $("#menu").hidden = !$("#menu").hidden;
  $("#menu [data-do=hidden]").textContent = state.hidden ? "Hide hidden files" : "Show hidden files";
  $("#menu [data-do=phone]").hidden = !globalThis.Phil;
};
document.addEventListener("click", () => ($("#menu").hidden = true));
$("#menu").onclick = (e) => {
  const what = e.target.closest("button")?.dataset.do;
  if (what === "reload") open(state.path, { push: false });
  if (what === "hidden") (state.hidden = !state.hidden), open(state.path, { push: false });
  if (what === "phone") globalThis.Phil?.setup();
};

addEventListener("popstate", (e) => {
  if (state.viewing) return closeViewer({ back: false });
  if (e.state?.path) open(e.state.path, { push: false });
});

(async () => {
  try {
    const { home, places, name } = await api("/m/api/places");
    state.home = home;
    document.title = `phil on ${name}`;
    $("#places").replaceChildren(...places.map((p) => {
      const b = Object.assign(document.createElement("button"), { innerHTML: svg(p.icon) });
      b.append(p.name);
      b.dataset.path = p.path;
      b.onclick = () => open(p.path);
      return b;
    }));
  } catch (err) {
    return showMessage(`phil didn't answer: ${err.message}`);
  }
  let start = state.home;
  try {
    start = localStorage.getItem("last") || start;
  } catch { /* none */ }
  await open(start, { push: false });
  if (!state.path) await open(state.home, { push: false });
  history.replaceState({ path: state.path }, "", "");
})();
