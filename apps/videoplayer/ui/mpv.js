// The player as mpv, under the page, when the window is salir's and has phil's
// mpv plugin (native/salir-mpv: <salir-embed kind="mpv">): what the browser
// can't play (H.264 and AAC in salir's Chromium, HEVC, AVI...) plays, decoded
// on the GPU. MpvVideo stands in for the <video> element: the same properties,
// methods and events, as app.js uses them, from mpv's properties.

const OBSERVED = ["time-pos", "duration", "pause", "volume", "mute", "speed", "width", "height", "eof-reached", "paused-for-cache", "demuxer-cache-time"];

/**
 * The player in `box` as mpv, or null where there's none (not salir, or no
 * plugin: then the <video>). Asked once, at the start.
 */
export async function mpvVideo(box) {
  if (!globalThis.salir) return null;
  const el = document.createElement("salir-embed");
  el.setAttribute("kind", "mpv");
  el.setAttribute("sid", "no"); // (the page shows the subtitles: app.js)
  el.setAttribute("pause", "yes"); // (till play())
  el.id = "mpv";
  box.prepend(el);
  // Its first answer (to observing): there. An error, or nothing: not.
  const answer = await new Promise((resolve) => {
    el.addEventListener("message", () => resolve(true), { once: true });
    el.addEventListener("error", (e) => resolve(e.detail?.error ?? "error"), { once: true });
    setTimeout(() => resolve("no answer"), 3000);
    el.send({ observe: OBSERVED });
  });
  if (answer !== true) {
    console.warn(`videoplayer: no mpv (${answer}): the browser's player`);
    return el.remove(), null;
  }
  return new MpvVideo(el);
}

class MpvVideo extends EventTarget {
  #el;
  #p = { pause: true }; // mpv's properties, as last heard (or as set)
  #src = "";
  #loaded = false; // played since this file was loaded (loadeddata told)
  #seeking = false;
  readyState = 0;
  defaultPlaybackRate = 1;

  constructor(el) {
    super();
    this.#el = el;
    this.style = el.style;
    el.addEventListener("message", (e) => this.#heard(e.detail));
  }

  #send(m) {
    this.#el.send(m);
  }

  #fire(...types) {
    for (const type of types) this.dispatchEvent(new Event(type));
  }

  #heard(m) {
    if (m?.properties) {
      for (const [name, value] of Object.entries(m.properties)) {
        const was = this.#p[name];
        this.#p[name] = value;
        if (name === "time-pos" && value !== null) this.#fire("timeupdate");
        else if (name === "duration") this.#fire("durationchange");
        else if (name === "pause" && value !== was) this.#fire(value ? "pause" : "play", ...(value || this.readyState < 3 ? [] : ["playing"]));
        else if (name === "volume" || name === "mute") this.#fire("volumechange");
        else if (name === "speed") this.#fire("ratechange");
        else if ((name === "width" || name === "height") && value) this.#fire("resize");
        else if (name === "eof-reached" && value) this.#fire("ended");
        else if (name === "paused-for-cache" && value !== was) {
          this.readyState = value ? 2 : 4;
          this.#fire(value ? "waiting" : "playing");
        } else if (name === "demuxer-cache-time") this.#fire("progress");
      }
    } else if (m?.event === "file-loaded") {
      this.readyState = 1;
      this.#fire("loadedmetadata", "durationchange", "resize");
    } else if (m?.event === "seek") {
      this.#seeking = true;
      this.#fire("seeking");
    } else if (m?.event === "playback-restart") {
      this.readyState = 4;
      if (!this.#loaded) (this.#loaded = true), this.#fire("loadeddata", "canplay");
      if (this.#seeking) (this.#seeking = false), this.#fire("seeked");
      if (!this.paused) this.#fire("playing");
    } else if (m?.event === "end-file" && m.reason === "error") {
      this.error = { message: m.error };
      this.#fire("error");
    } else if (m?.error) console.warn(`mpv: ${m.error}`, m.command);
  }

  /** Plays `path` (a file's, a URL), from `start` seconds. */
  open(path, start = 0) {
    this.#src = path;
    this.#loaded = false;
    this.readyState = 0;
    this.#p["time-pos"] = start;
    this.#p.duration = null;
    this.#p["eof-reached"] = false;
    // (loadfile <url> <flags> <index> <options>: positionally; mpv's named form loaded nothing.)
    this.#send({ command: ["loadfile", path, "replace", "-1", start ? `start=${start}` : ""] });
  }

  get src() {
    return this.#src;
  }
  getAttribute(name) {
    return name === "src" ? this.#src || null : null;
  }
  removeAttribute(name) {
    if (name !== "src" || !this.#src) return;
    this.#src = "";
    this.readyState = 0;
    this.#send({ command: ["stop"] });
  }
  load() {} // (the <video>'s reset: removeAttribute("src") did it)

  get currentTime() {
    return this.#p["time-pos"] ?? 0;
  }
  set currentTime(t) {
    this.#p["time-pos"] = t;
    this.#send({ command: ["seek", String(t), "absolute"] });
  }
  get duration() {
    return this.#p.duration ?? NaN;
  }
  get paused() {
    return this.#p.pause !== false;
  }
  play() {
    this.#p.pause = false;
    this.#send({ set: { pause: false } });
    return Promise.resolve();
  }
  pause() {
    this.#send({ set: { pause: true } });
  }
  get volume() {
    return (this.#p.volume ?? 100) / 100;
  }
  set volume(v) {
    this.#p.volume = v * 100;
    this.#send({ set: { volume: v * 100 } });
  }
  get muted() {
    return !!this.#p.mute;
  }
  set muted(m) {
    this.#p.mute = !!m;
    this.#send({ set: { mute: !!m } });
  }
  get playbackRate() {
    return this.#p.speed ?? 1;
  }
  set playbackRate(r) {
    this.#p.speed = r;
    this.#send({ set: { speed: r } });
  }
  get videoWidth() {
    return this.#p.width ?? 0;
  }
  get videoHeight() {
    return this.#p.height ?? 0;
  }
  // What's read ahead (a file: all of it soon), as the <video>'s buffered.
  get buffered() {
    const end = this.#p["demuxer-cache-time"];
    return end ? { length: 1, start: () => 0, end: () => end } : { length: 0, start: () => 0, end: () => 0 };
  }

  /** A frame on (1) or back (-1), paused. */
  frameStep(dir) {
    this.#send({ command: [dir < 0 ? "frame-back-step" : "frame-step"] });
  }

  /**
   * Shows the middle of the picture `w`×`h` (video pixels; null: all of it), as large as the
   * element (its own box: the crop's) takes.
   */
  crop(w, h) {
    const vw = this.videoWidth, vh = this.videoHeight;
    this.#send({ set: { "video-crop": w && vw ? `${Math.round(w)}x${Math.round(h)}+${Math.round((vw - w) / 2)}+${Math.round((vh - h) / 2)}` : "" } });
  }
}
