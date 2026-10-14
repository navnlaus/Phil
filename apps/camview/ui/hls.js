// A camera whose stream is HLS (a web one: rtsp.me's, say) is played here with
// hls.js, as a browser does, instead of through ffmpeg: HLS comes in pieces of
// a few seconds, and ffmpeg's re-packing of them, kept close to live, played
// in fits and starts. hls.js is loaded the first time one is played.

let Hls = null;

/**
 * Plays camera `id`'s profile `profile` in `video` if its stream is HLS:
 * resolves to a handle ({stop()}), or null (not HLS, or no hls.js here: use
 * /stream). On an error its address is asked for again (a signed one expires);
 * `onGiveUp(why)` after three in a row without playing.
 */
export async function playHls(video, id, profile, { onPlaying = () => {}, onGiveUp = () => {} } = {}) {
  const ask = async () => {
    const res = await fetch(`api/hls?id=${encodeURIComponent(id)}&profile=${encodeURIComponent(profile ?? "")}`);
    return res.ok ? (await res.json()).url : null;
  };
  const first = await ask().catch(() => null);
  if (!first) return null;
  Hls ??= (await import("./vendor/hls.light.min.mjs")).default;
  if (!Hls.isSupported()) return null;
  let hls = null, stopped = false, failures = 0, retry = 0;
  const start = (src) => {
    hls?.destroy();
    // Live: a couple of pieces behind its end, little kept behind (a camera is watched, not rewound).
    hls = new Hls({ liveSyncDurationCount: 2, maxBufferLength: 12, backBufferLength: 8, enableWorker: true });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal || stopped) return;
      if (++failures >= 3) return onGiveUp(`hls.js: ${data.details}`);
      clearTimeout(retry);
      retry = setTimeout(async () => !stopped && start((await ask().catch(() => null)) ?? src), 2000);
    });
    hls.loadSource(src);
    hls.attachMedia(video);
    video.play().catch(() => {});
  };
  const playing = () => ((failures = 0), onPlaying());
  video.addEventListener("playing", playing);
  start(first);
  return {
    stop() {
      stopped = true;
      clearTimeout(retry);
      video.removeEventListener("playing", playing);
      hls?.destroy();
      hls = null;
    },
  };
}
