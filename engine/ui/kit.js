// What every app's pages share (served at /engine/ui/kit.js).

/**
 * Shown inside another app's window (an <iframe>, see appUrl): closing
 * returns to that app instead of closing the window.
 */
export const embedded = globalThis.parent !== globalThis && new URLSearchParams(location.search).has("embedded");

/**
 * The page is styled and running: the engine shows its window
 * (engine/window.js); shown inside another app, that app gives it the keyboard
 * (a page in a frame can't take focus itself in WebKit).
 */
export function ready(detail = "") {
  if (embedded) parent.postMessage({ engine: "ready" }, "*");
  else globalThis.webkit?.messageHandlers?.phil?.postMessage(detail ? `ready:${detail}` : "ready");
}

/** Closes the window, or the embedded view. */
export function closeWindow() {
  if (embedded) return parent.postMessage({ engine: "close" }, "*");
  const native = globalThis.webkit?.messageHandlers?.phil; // a window of the engine's own
  if (native) return native.postMessage("close");
  fetch("/api/quit", { method: "POST" }).finally(() => globalThis.close()); // --browser
}

/**
 * The URL that shows another app inside this page (an <iframe>), e.g.
 * appUrl("jsonedit", { file }): `params` go in its query. It's served on this
 * page's origin (/engine/embed/, see engine/server.js), and gets ?embedded, so
 * its close button comes back here.
 */
export function appUrl(app, params = {}) {
  const url = new URL(`/engine/embed/${app}/`, location.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("embedded", "1");
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
 * Keeps keyboard focus on `el` (a page's main view): now, and whenever the
 * window or embedded view gets focus back with nothing in particular focused.
 */
export function holdFocus(el) {
  const take = () => {
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) el.focus({ preventScroll: true });
  };
  addEventListener("focus", take);
  // Shown inside another app: WebKit ignores focus() here until that app has
  // given this frame the keyboard; it says so once it has (see ready()).
  if (embedded) addEventListener("message", (e) => e.source === parent && e.data?.engine === "focus" && take());
  take();
}

/**
 * Shown inside another app: `fn` runs when that app asks this one to close
 * (Esc pressed while it still had the keyboard).
 */
export function onCloseRequest(fn) {
  if (!embedded) return;
  addEventListener("message", (e) => e.source === parent && e.data?.engine === "close-request" && fn());
}
