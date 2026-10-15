// The downloads phil follows, for the other apps' servers in the same worker
// (mediaview's: what's downloading into its media folders): panda-dl's
// (downloads.js) and other programs' (browserdownloads.js), as phil's server
// last heard. A "change" event when either list changes; use() keeps them
// being asked about (as an open phil window does) until the function it
// returns is called.
export const feed = Object.assign(new EventTarget(), {
  panda: [], // [{id, name, path, dir, state, percent, bytes, total, speed, eta, files: [{path, length, downloaded}]}]
  browser: [], // [{id, name, path (the partial file), target, dir, percent, bytes, total, speed, eta, state}]
  use: () => () => {}, // (phil's server sets it)
});

export function setDownloads(kind, list) {
  feed[kind] = list;
  feed.dispatchEvent(new Event("change"));
}
