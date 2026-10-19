// What every app's pages share (served at /engine/ui/kit.js).

/**
 * Shown inside another app's window (an <iframe>, see appUrl): closing
 * returns to that app instead of closing the window.
 */
const embedId = new URLSearchParams(location.search).get("embedded");
export const embedded = globalThis.parent !== globalThis && !!embedId;

// Messages between an app and the one it's shown in (see appUrl) are told
// apart by origin and the embedded view's id.
const ours = (e) => e.origin === location.origin;

/** The id of the embedded view at `url` (from appUrl), which its messages carry. */
export const embedOf = (url) => new URL(url).searchParams.get("embedded");

/**
 * Tells the app this one is shown in something: {engine: "ready" | "close"},
 * or the app's own (imageview's {app, showing}). Marked as this view's.
 */
export function tellParent(message) {
  if (embedded) parent.postMessage({ ...message, embed: embedId }, location.origin);
  else engine?.send({ phil: "tell", message }); // (a window opened over another's: to that one, openOver's onMessage)
}

// A theme edited while the app runs (in ~/.config/phil/themes, see
// engine/themes.js) is loaded again: the page's stylesheets are, each new one
// replacing the old once it has loaded, so nothing flickers. The document
// gets a "themes-changed" event, also for a theme added or removed.
if (globalThis.EventSource) {
  new EventSource(new URL("../styles", import.meta.url)).onmessage = () => {
    document.dispatchEvent(new Event("themes-changed")); // for a page that lists them (phil)
    for (const link of document.querySelectorAll("link[rel=stylesheet]")) {
      const url = new URL(link.href);
      url.searchParams.set("v", Date.now());
      const fresh = link.cloneNode();
      fresh.href = url.href;
      fresh.onload = fresh.onerror = () => link.remove();
      link.after(fresh);
    }
  };
}

// A window of the engine's (salir's: engine/salir.js) has window.salir: its page
// talks to the engine through it. (In a plain browser, --browser, it's not there.)
const engine = globalThis.salir ?? null;

// Scrollbars thin, as the theme has them (themes/base.css): the "blink" class.
if (globalThis.navigator?.userAgentData) document.documentElement.classList.add("blink");

/**
 * The page is styled and running (the engine notes it); shown inside another app,
 * that app gives it the keyboard (a page in a frame can't take it itself).
 */
export function ready(detail = "") {
  if (embedded) tellParent({ engine: "ready" });
  else engine?.send({ phil: "ready", detail });
}

/** Closes the window, or the embedded view. */
export function closeWindow() {
  if (embedded) return tellParent({ engine: "close" });
  if (engine) return engine.close();
  fetch("/api/quit", { method: "POST" }).finally(() => globalThis.close()); // --browser
}

/**
 * Opens `app` in a window of its own (`params`: its window's, as appUrl's), over
 * `element` (its area of the window, from a frame too): on Hyprland it floats
 * exactly there, following this window till it's moved itself (engine/hyprland.js).
 * `onMessage`: what its page tells (tellParent). Resolves when that window's
 * closed. Only in the engine's windows (salir's): elsewhere null, and the app's
 * to show inside (appUrl).
 */
export function openOver(app, params, { element = document.documentElement, onMessage = () => {} } = {}) {
  if (!engine) return null;
  const request = Math.random().toString(36).slice(2);
  // Where `element` is in the window (through the frames it's in: same origin, appUrl's).
  const rect = () => {
    const r = element === document.documentElement ? { left: 0, top: 0, width: innerWidth, height: innerHeight } : element.getBoundingClientRect();
    let x = r.left, y = r.top;
    for (let w = globalThis; w !== w.top && w.frameElement; w = w.parent) {
      const f = w.frameElement.getBoundingClientRect();
      x += f.left + w.frameElement.clientLeft;
      y += f.top + w.frameElement.clientTop;
    }
    return [x, y, r.width, r.height];
  };
  engine.send({ phil: "open", app, params, rect: rect(), request });
  const moved = () => engine.send({ phil: "over", request, rect: rect() });
  const sizes = new ResizeObserver(moved);
  sizes.observe(element);
  return new Promise((resolve) => {
    const stop = engine.on((m) => {
      if (m?.request !== request) return;
      if (m.phil === "told") return void onMessage(m.message);
      if (m.phil !== "closed") return;
      stop();
      sizes.disconnect();
      resolve();
    });
  });
}

/**
 * The URL that shows another app inside this page (an <iframe>), e.g.
 * appUrl("jsonedit", { file }): `params` go in its query. It's served on this
 * page's origin (/engine/embed/, see engine/server.js), and gets ?embedded, so
 * its close button comes back here. Its messages carry that id (embedOf).
 */
export function appUrl(app, params = {}) {
  const url = new URL(`/engine/embed/${app}/`, location.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("embedded", Math.random().toString(36).slice(2));
  return url.href;
}

/**
 * Copies to the desktop's clipboard (and so Omarchy's clipboard history),
 * through the engine; the browser's clipboard if that's not available.
 */
export async function copyText(text) {
  try {
    if ((await fetch("/engine/clipboard", { method: "PUT", body: text })).ok) return;
  } catch { /* not served: --browser without wl-clipboard, say */ }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

/** What's on the desktop's clipboard ("" if nothing); see copyText. */
export async function pasteText() {
  try {
    const res = await fetch("/engine/clipboard");
    if (res.ok) return await res.text();
  } catch { /* see copyText */ }
  return await navigator.clipboard.readText().catch(() => "");
}

/**
 * The copy and paste keys, however they're pressed: Ctrl+C / Ctrl+V,
 * Ctrl+Insert / Shift+Insert (what Omarchy's Super+C / Super+V send to windows
 * tagged as terminals), and Super+C / Super+V themselves. Cut: Ctrl+X,
 * Shift+Delete. Returns "copy", "cut", "paste" or null.
 */
export function clipboardKey(e) {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
  if ((mod && !e.shiftKey && k === "c") || (e.ctrlKey && !e.shiftKey && k === "Insert")) return "copy";
  if ((mod && !e.shiftKey && k === "x") || (e.shiftKey && !e.ctrlKey && k === "Delete")) return "cut";
  if ((mod && !e.shiftKey && k === "v") || (e.shiftKey && !e.ctrlKey && k === "Insert")) return "paste";
  return null;
}

/**
 * Keeps keyboard focus on `el` (a page's main view, or a function giving it):
 * now, and whenever the window or embedded view gets focus back with nothing
 * in particular focused.
 */
export function holdFocus(el) {
  const take = () => {
    const active = document.activeElement;
    const target = typeof el === "function" ? el() : el;
    if (!active || active === document.body || active === document.documentElement) target.focus({ preventScroll: true });
  };
  addEventListener("focus", take);
  // Shown inside another app: focus() does nothing here till that app has given
  // this frame the keyboard; it says so once it has (see ready()).
  if (embedded) addEventListener("message", (e) => ours(e) && e.data?.engine === "focus" && take());
  take();
}

/**
 * Shown inside another app: `fn` runs when that app asks this one to close
 * (Esc pressed while it still had the keyboard).
 */
export function onCloseRequest(fn) {
  if (!embedded) return;
  addEventListener("message", (e) => ours(e) && e.data?.engine === "close-request" && fn());
}

/**
 * Asks for a password (to save with sudo, say), in a small box over the page,
 * over a dialog that's open too (a modal one of its own: anything else would be
 * under that one, out of reach). Resolves to it, or null when cancelled. It
 * isn't kept anywhere.
 */
export function askPassword(message, { ok = "Save" } = {}) {
  return new Promise((resolve) => {
    const box = document.createElement("dialog");
    box.className = "kit-password";
    const form = document.createElement("form");
    box.append(form);
    form.innerHTML = `<label></label><div><input type="password" autocomplete="current-password" spellcheck="false"><button type="submit">Save</button><button type="button">Cancel</button></div>`;
    form.querySelector("label").textContent = message;
    form.querySelector("button[type=submit]").textContent = ok;
    const input = form.querySelector("input");
    const back = document.activeElement;
    let answered = false;
    const done = (value) => {
      if (answered) return;
      answered = true;
      box.close();
      box.remove();
      back?.focus?.({ preventScroll: true });
      resolve(value);
    };
    form.onsubmit = (e) => (e.preventDefault(), done(input.value));
    form.querySelector("button[type=button]").onclick = () => done(null);
    form.onkeydown = (e) => {
      e.stopPropagation(); // typing here isn't the page's
      if (e.key === "Escape") e.preventDefault(), done(null);
    };
    box.addEventListener("cancel", (e) => (e.preventDefault(), done(null))); // Esc, as the browser has it
    document.body.append(box);
    box.showModal();
    input.focus();
  });
}

/**
 * Tooltips drawn by the page, for every element with a title (or data-tip):
 * the theme's (.kit-tip in themes/base.css), not the system's. Shown after a moment on hover,
 * at once when moving on from one just shown; gone on a click, a key, a
 * scroll, or leaving; none during a drag. A title moves to data-tip when first hovered, so the
 * browser's own doesn't show as well; setting it again later works. Inside an
 * open dialog, the tip goes in it (a modal one is over everything else).
 */
export function tooltips() {
  if (tooltips.on) return;
  tooltips.on = true;
  const tip = document.createElement("div");
  tip.className = "kit-tip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  let target = null, timer = 0, hiddenAt = 0, x = 0, y = 0;

  const textOf = (el) => {
    if (el.hasAttribute("title")) {
      el.dataset.tip = el.getAttribute("title");
      el.removeAttribute("title");
    }
    return el.dataset.tip;
  };
  const show = () => {
    const text = target?.isConnected && textOf(target);
    if (!text) return;
    const host = target.closest("dialog[open]") ?? document.body;
    if (tip.parentNode !== host) host.append(tip);
    tip.textContent = text;
    tip.hidden = false;
    // Under the pointer, kept inside the window: above it near the bottom, to the left near the right.
    const { width, height } = tip.getBoundingClientRect();
    const left = x + 12 + width > innerWidth - 4 ? Math.max(4, x - width - 8) : x + 12;
    const top = y + 20 + height > innerHeight - 4 ? Math.max(4, y - height - 10) : y + 20;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };
  const hide = () => {
    clearTimeout(timer);
    if (!tip.hidden) hiddenAt = Date.now();
    tip.hidden = true;
  };

  addEventListener("pointerover", (e) => {
    const found = e.target.closest?.("[title], [data-tip]");
    const el = found?.tagName === "IFRAME" ? null : found; // a frame's title names it for screen readers: it isn't a tip
    if (el === target) return;
    hide();
    target = el;
    if (!el || e.buttons || !textOf(el)) return; // none while dragging
    x = e.clientX;
    y = e.clientY;
    timer = setTimeout(show, Date.now() - hiddenAt < 500 ? 0 : 450);
  }, true);
  addEventListener("pointermove", (e) => {
    if (tip.hidden) (x = e.clientX), (y = e.clientY);
  }, { passive: true, capture: true });
  addEventListener("pointerout", (e) => {
    if (target && !target.contains(e.relatedTarget)) hide(), (target = null);
  }, true);
  for (const type of ["pointerdown", "keydown", "wheel", "blur"]) addEventListener(type, () => (hide(), (target = null)), true);
  addEventListener("scroll", hide, { capture: true, passive: true });
}
