// A native window drawn with WebGPU from Deno: no browser. Deno's WebGPU is
// wgpu (Vulkan here; Direct3D 12 on Windows, Metal on macOS), the window is
// SDL3's (sdl.js), and Deno.UnsafeWindowSurface joins the two. What's drawn is
// particles.js, as index.html draws it in a browser.
//
//   deno task webgpu [--count N] [--frames N] [--auto]
//
// Mouse: left button pulls the particles, right pushes them, the wheel how
// hard. Space: pause. R: start again. +/-: twice or half as many. Esc: quit.
// --frames N: quits after N frames, saying how fast they came (for tests);
// --auto: the pull goes round by itself (no mouse needed).
import { KEY, Window } from "./sdl.js";
import { autoPull, createParticles, frameStats } from "./particles.js";

const args = Deno.args;
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
};
const maxFrames = arg("--frames", Infinity);
const auto = args.includes("--auto");

const win = new Window("WebGPU · Deno", 1280, 800);
const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
if (!adapter) throw new Error("No WebGPU adapter");
const gpuName = adapter.info?.description || adapter.info?.vendor || "GPU";
const device = await adapter.requestDevice();
let running = true;
device.lost.then((info) => {
  console.error(`GPU device lost: ${info.reason} ${info.message}`);
  running = false;
});
device.addEventListener("uncapturederror", (e) => console.error(`WebGPU: ${e.error.message}`));

let [width, height] = win.size();
const surface = new Deno.UnsafeWindowSurface({ ...win.surfaceHandles(), width, height });
const context = surface.getContext("webgpu");
const format = navigator.gpu.getPreferredCanvasFormat();
const configure = () => context.configure({ device, format, alphaMode: "opaque" });
configure();
console.log(`${win.driver} window, ${width}×${height} px; ${gpuName}${adapter.info?.architecture ? ` (${adapter.info.architecture})` : ""}; ${format}`);

const particles = createParticles(device, format);
particles.seed(arg("--count", 1 << 18));

let mouse = [0, 0], pull = 0, strength = 1, paused = false;
let shownAt = performance.now(), shownFrames = 0, last = performance.now();
const start = last, frameTimes = [];

while (running && frameTimes.length < maxFrames) {
  for (const e of win.poll()) {
    if (e.type === "quit") running = false;
    else if (e.type === "resize") {
      [width, height] = [e.width, e.height];
      surface.width = width;
      surface.height = height;
      configure();
    } else if (e.type === "mouse") mouse = toClip(e.x, e.y);
    else if (e.type === "button") {
      mouse = toClip(e.x, e.y);
      if (e.button === 1) pull = e.down ? 1 : 0;
      if (e.button === 3) pull = e.down ? -1 : 0;
    } else if (e.type === "wheel") strength = Math.min(8, Math.max(0.125, strength * (e.y > 0 ? 1.25 : 0.8)));
    else if (e.type === "key" && e.down && !e.repeat) {
      if (e.key === KEY.ESCAPE) running = false;
      else if (e.key === KEY.SPACE) paused = !paused;
      else if (e.key === KEY.R) particles.seed(particles.count);
      else if (e.key === KEY.PLUS || e.key === KEY.EQUALS) particles.seed(Math.min(particles.count * 2, 1 << 23));
      else if (e.key === KEY.MINUS) particles.seed(Math.max(particles.count >> 1, 1024));
    }
  }
  if (!running) break;

  const now = performance.now();
  frameTimes.push(now - last);
  const dt = Math.min((now - last) / 1000, 1 / 30);
  last = now;
  const time = (now - start) / 1000;
  const pulling = auto ? autoPull(time) : { mouse, pull };
  particles.frame(context.getCurrentTexture().createView(), { width, height, mouse: pulling.mouse, pull: pulling.pull * strength, dt, time, paused });
  surface.present();
  await device.queue.onSubmittedWorkDone(); // (one frame at a time; and lets Deno's event loop run: device.lost)

  shownFrames++;
  if (now - shownAt > 500) {
    const fps = (shownFrames * 1000) / (now - shownAt);
    win.title = `WebGPU · Deno — ${particles.count.toLocaleString("en")} particles · ${fps.toFixed(0)} fps${paused ? " · paused" : ""} · ${gpuName}`;
    shownAt = now, shownFrames = 0;
  }
}

if (Number.isFinite(maxFrames)) console.log(frameStats(frameTimes, (performance.now() - start) / 1000, particles.count));
// Ended here, the window left to go with the process: Deno has no way to let go of the
// surface (UnsafeWindowSurface) but its own clean-up at the end, which comes after
// SDL's, and on Wayland NVIDIA's Vulkan then talks to a connection SDL has closed
// (a crash). Deno.exit() ends it before that.
Deno.exit(0);

function toClip(x, y) {
  const [w, h] = win.logicalSize();
  return [(x / w) * 2 - 1, 1 - (y / h) * 2];
}
