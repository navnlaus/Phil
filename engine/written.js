// Files the engine's apps wrote (an editor's save, imageresize's result),
// for phil: what's known of the folders they're in (their total sizes) is
// worked out again. All the apps run in the one server worker.
const listeners = new Set();

/** `path` was written. */
export function wrote(path) {
  for (const listener of listeners) {
    try {
      listener(path);
    } catch { /* one listener's trouble isn't the writer's */ }
  }
}

/** `listener(path)` for each file written; returns what stops it. */
export function onWrote(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
