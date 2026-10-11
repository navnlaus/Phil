// What every app's pages share (served at /engine/ui/kit.js).

/**
 * Shown inside another app's window (an <iframe>, see appUrl): closing
 * returns to that app instead of closing the window.
 */
export const embedded = globalThis.parent !== globalThis && new URLSearchParams(location.search).has("embedded");

/** The page is styled and running: the engine shows its window (engine/window.js). */
export function ready(detail = "") {
  if (!embedded) globalThis.webkit?.messageHandlers?.phil?.postMessage(detail ? `ready:${detail}` : "ready");
}

/** Closes the window, or the embedded view. */
export function closeWindow() {
  if (embedded) return parent.postMessage({ engine: "close" }, "*");
  const native = globalThis.webkit?.messageHandlers?.phil; // a window of the engine's own
  if (native) return native.postMessage("close");
  fetch("/api/quit", { method: "POST" }).finally(() => globalThis.close()); // --browser
}

/**
 * The URL that opens another app's page (with its session token), e.g.
 * appUrl("jsonedit", { file }) for an <iframe>: `params` go in its query.
 * Embedded pages get ?embedded, so their close button comes back here.
 */
export async function appUrl(app, params = {}, { embed = true } = {}) {
  const urls = await (await fetch("/engine/apps")).json();
  if (!urls[app]) throw new Error(`no app called ${app}`);
  const url = new URL(urls[app]);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (embed) url.searchParams.set("embedded", "1");
  return url.href;
}
