// The PC's copies to this phone, as they go: a bar each along the bottom (what,
// how far, how fast, the time left; a tap opens the folder it's going to), and on
// the tiles being made how far each is (the item being copied, and the file it's
// at). Asked of the PC (Serve's /pc/transfers: link.js) while the app's showing,
// its answer coming when they change. A copy into the folder shown: the folder's
// read again as it starts and when it ends, what's new in it shown.

const $ = (s, root = document) => root.querySelector(s);
const el = (tag, props = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter((c) => c != null));
  return e;
};

const AWAY_MS = 5000; // the PC not answering (or not paired): asked again after this
const t = { version: -1, list: [], following: false, bars: new Map(), reread: 0 };

const size = (n) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) (n /= 1000), i++;
  return `${i && n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
};
const left = (s) => (s == null ? "" : s < 60 ? `${s} s left` : s < 3600 ? `${Math.round(s / 60)} min left` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min left`);
const nameOf = (p) => p.split("/").filter(Boolean).pop() ?? p;

async function follow() {
  if (t.following) return;
  t.following = true;
  try {
    while (!document.hidden) {
      let answer = null;
      try {
        const res = await fetch(`/pc/transfers?since=${t.version}`);
        if (res.ok) answer = await res.json();
      } catch { /* away */ }
      if (!answer || typeof answer.version !== "number") {
        if (t.list.length) changed([]);
        await new Promise((r) => setTimeout(r, AWAY_MS));
        continue;
      }
      t.version = answer.version;
      changed(answer.transfers ?? []);
    }
  } finally {
    t.following = false;
  }
}

function changed(list) {
  const before = t.list;
  t.list = list;
  showBars();
  // A copy into the folder shown, starting or ended: the folder read again.
  const where = globalThis.philFiles?.where();
  const ids = new Set(list.map((x) => x.id)), had = new Set(before.map((x) => x.id));
  const touches = (x) => where?.side === "phone" && (x.dest === where.path || x.targets.some((p) => p.startsWith(where.path + "/") && !p.slice(where.path.length + 1).includes("/")));
  // (and when the item it's at here isn't shown yet: made since the folder was read)
  const shown = new Set([...document.querySelectorAll("#grid .tile")].map((tile) => tile.entry?.path));
  const missing = list.some((x) => where?.side === "phone" && x.at && x.at.startsWith(where.path + "/") && !x.at.slice(where.path.length + 1).includes("/") && !shown.has(x.at));
  const reread = [...list.filter((x) => !had.has(x.id)), ...before.filter((x) => !ids.has(x.id))].some(touches) || (missing && Date.now() - t.reread > 2000);
  if (reread) {
    t.reread = Date.now();
    Promise.resolve(globalThis.philFiles.reread()).then(showTiles);
  } else showTiles();
}

// ---------------------------------------------------------------- the bars along the bottom

function showBars() {
  const box = $("#transfers");
  for (const [id, b] of t.bars) if (!t.list.some((x) => x.id === id)) (b.el.remove(), t.bars.delete(id));
  for (const x of t.list) {
    let b = t.bars.get(x.id);
    if (!b) {
      b = { fill: el("span", { className: "tr-fill" }), what: el("span", { className: "tr-what" }), how: el("span", { className: "tr-how" }) };
      b.el = el("button", { className: "tr" }, el("span", { className: "tr-text" }, b.what, b.how), el("span", { className: "tr-bar" }, b.fill));
      b.el.onclick = () => globalThis.philFiles?.openPhone?.(t.list.find((y) => y.id === x.id)?.dest);
      t.bars.set(x.id, b);
      box.append(b.el);
    }
    const verb = x.op === "move" ? "Moving" : x.op === "delete" ? "Deleting" : "Copying";
    const what = x.items > 1 ? `${x.items} items` : nameOf(x.targets[0] ?? x.dest);
    b.what.textContent = `${verb} ${what} to ${nameOf(x.dest)}`;
    b.how.textContent = x.paused ? `Paused · ${x.percent}%`
      : x.preparing && !x.bytes ? `${x.preparing}…`
      : [`${x.percent}%`, x.total ? `${size(x.bytes)} of ${size(x.total)}` : "", x.speed ? `${size(x.speed)}/s` : "", left(x.eta)].filter(Boolean).join(" · ");
    b.fill.style.width = `${x.percent}%`;
    b.el.classList.toggle("paused", !!x.paused);
  }
  box.hidden = !t.list.length;
  document.body.classList.toggle("transfers-on", t.list.length > 0);
  document.body.style.setProperty("--transfers-h", `${box.offsetHeight}px`);
}

// ---------------------------------------------------------------- on the tiles

// How far each tile being made is: path -> {percent, paused, waiting}. The item
// being copied has its own percentage, and the file it's at in it (a folder's) its
// own; the items before it are done, those after it wait.
function progressByPath() {
  const out = new Map();
  for (const x of t.list) {
    const at = x.at ? x.targets.indexOf(x.at) : 0;
    x.targets.forEach((p, i) => {
      if (i < at) return; // (done)
      out.set(p, i > at ? { percent: 0, waiting: true } : { percent: x.atPercent ?? x.percent, paused: x.paused });
    });
    if (x.file && !out.has(x.file)) out.set(x.file, { percent: x.filePercent ?? 0, paused: x.paused });
  }
  return out;
}

function showTiles() {
  const by = progressByPath();
  const where = globalThis.philFiles?.where();
  for (const tile of document.querySelectorAll("#grid .tile")) {
    const p = where?.side === "phone" ? by.get(tile.entry?.path) : null;
    const face = tile.querySelector(":scope > .thumb") ?? tile;
    let o = face.querySelector(":scope > .copying");
    if (!p) {
      o?.remove();
      continue;
    }
    if (!o) {
      o = el("div", { className: "copying" }, el("span", { className: "c-label" }), el("span", { className: "c-bar" }, el("span", { className: "c-fill" })));
      face.append(o);
    }
    o.querySelector(".c-label").textContent = p.waiting ? "Waiting" : p.paused ? `Paused · ${p.percent}%` : `${p.percent}%`;
    o.querySelector(".c-fill").style.width = `${p.percent}%`;
  }
}

// (A folder shown anew: its tiles get theirs.)
globalThis.philTransfersShow = showTiles;

document.addEventListener("visibilitychange", () => !document.hidden && follow());
follow();
