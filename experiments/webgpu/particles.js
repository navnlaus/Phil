// The particles, as WebGPU alone sees them: the same in a native window
// (main.js: Deno + SDL3) and in a browser's canvas (index.html). Particles
// moved by a compute shader and drawn as instanced quads, added up (glowing
// where they crowd).

const UNIFORMS_WGSL = /* wgsl */ `
struct Particle { pos: vec2f, vel: vec2f };
struct Uniforms { mouse: vec2f, pull: f32, dt: f32, size: vec2f, aspect: f32, time: f32 };
@group(0) @binding(0) var<uniform> u: Uniforms;
`;

const STEP_WGSL = UNIFORMS_WGSL + /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

@compute @workgroup_size(256)
fn step(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&particles)) { return; }
  var p = particles[i];
  // Toward the mouse (or away), in units that are the same both ways on screen.
  var d = (u.mouse - p.pos) * vec2f(u.aspect, 1.0);
  let r2 = dot(d, d) + 0.003;
  var a = d * (u.pull / (r2 * sqrt(r2))) * 0.05;
  // A slow swirl about the middle, so they're never still.
  a += vec2f(-p.pos.y, p.pos.x * u.aspect) * 0.15;
  p.vel = (p.vel + (a / vec2f(u.aspect, 1.0)) * u.dt) * exp(-0.9 * u.dt);
  let speed = length(p.vel);
  if (speed > 4.0) { p.vel *= 4.0 / speed; }
  p.pos += p.vel * u.dt;
  // Bounced off the edges.
  if (abs(p.pos.x) > 1.0) { p.pos.x = clamp(p.pos.x, -1.0, 1.0); p.vel.x = -p.vel.x * 0.5; }
  if (abs(p.pos.y) > 1.0) { p.pos.y = clamp(p.pos.y, -1.0, 1.0); p.vel.y = -p.vel.y * 0.5; }
  particles[i] = p;
}
`;

const DRAW_WGSL = UNIFORMS_WGSL + /* wgsl */ `
@group(0) @binding(1) var<storage, read> particles: array<Particle>;

struct Out { @builtin(position) pos: vec4f, @location(0) corner: vec2f, @location(1) color: vec3f };

@vertex
fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Out {
  let corner = vec2f(f32(v & 1u), f32(v >> 1u)) * 2.0 - 1.0; // (a strip of 4)
  let p = particles[i];
  var out: Out;
  out.pos = vec4f(p.pos + corner * u.size, 0.0, 1.0);
  out.corner = corner;
  let fast = clamp(length(p.vel) * 0.8, 0.0, 1.0);
  out.color = mix(vec3f(0.10, 0.30, 1.0), vec3f(1.0, 0.50, 0.15), fast);
  return out;
}

@fragment
fn fs(in: Out) -> @location(0) vec4f {
  let a = max(0.0, 1.0 - dot(in.corner, in.corner));
  return vec4f(in.color * a * 0.25, 1.0);
}
`;

const ADD = { srcFactor: "one", dstFactor: "one", operation: "add" };

/**
 * The particles on `device`, drawn into textures of `format`:
 * {seed(count), frame(view, {width, height, mouse: [x, y] (-1 to 1), pull, dt, time, paused}), count}.
 */
export function createParticles(device, format) {
  const uniforms = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const uniformData = new Float32Array(8);
  const stepPipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: STEP_WGSL }), entryPoint: "step" } });
  const drawModule = device.createShaderModule({ code: DRAW_WGSL });
  const drawPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: drawModule, entryPoint: "vs" },
    fragment: { module: drawModule, entryPoint: "fs", targets: [{ format, blend: { color: ADD, alpha: ADD } }] },
    primitive: { topology: "triangle-strip" },
  });
  let buffer = null, stepGroup, drawGroup;

  return {
    count: 0,

    /** Starts again with `count` particles, in a disc. */
    seed(count) {
      buffer?.destroy();
      const data = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        const r = Math.sqrt(Math.random()) * 0.9, t = Math.random() * Math.PI * 2;
        data[i * 4] = Math.cos(t) * r;
        data[i * 4 + 1] = Math.sin(t) * r;
      }
      buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, data);
      const entries = [{ binding: 0, resource: { buffer: uniforms } }, { binding: 1, resource: { buffer } }];
      stepGroup = device.createBindGroup({ layout: stepPipeline.getBindGroupLayout(0), entries });
      drawGroup = device.createBindGroup({ layout: drawPipeline.getBindGroupLayout(0), entries });
      this.count = count;
    },

    /** Moves them on by `dt` seconds (unless paused) and draws them into `view`. */
    frame(view, { width, height, mouse, pull, dt, time, paused }) {
      uniformData.set([mouse[0], mouse[1], pull, paused ? 0 : dt, 3 / width, 3 / height, width / height, time]);
      device.queue.writeBuffer(uniforms, 0, uniformData);
      const encoder = device.createCommandEncoder();
      if (!paused) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(stepPipeline);
        pass.setBindGroup(0, stepGroup);
        pass.dispatchWorkgroups(Math.ceil(this.count / 256));
        pass.end();
      }
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view, clearValue: { r: 0.01, g: 0.01, b: 0.02, a: 1 }, loadOp: "clear", storeOp: "store" }] });
      pass.setPipeline(drawPipeline);
      pass.setBindGroup(0, drawGroup);
      pass.draw(4, this.count);
      pass.end();
      device.queue.submit([encoder.finish()]);
    },
  };
}

/** Where the pull goes by itself (--auto, ?auto): round and round, now pulling, now pushing. */
export const autoPull = (time) => ({ mouse: [Math.cos(time * 0.7) * 0.6, Math.sin(time * 0.9) * 0.6], pull: Math.sin(time * 0.5) > -0.3 ? 1 : -1 });

/** "N frames in S s (F fps); frame time median, 99th percentile", from each frame's time in ms. */
export function frameStats(frameTimes, seconds, count) {
  const times = frameTimes.slice(10).sort((a, b) => a - b); // (not the first few: shaders compiling, the window coming up)
  const q = (f) => times[Math.min(times.length - 1, Math.floor(times.length * f))]?.toFixed(2);
  return `${frameTimes.length} frames in ${seconds.toFixed(2)} s (${(frameTimes.length / seconds).toFixed(1)} fps); frame time median ${q(0.5)} ms, 99th percentile ${q(0.99)} ms; ${count.toLocaleString("en")} particles`;
}
