// The particles, as WebGPU alone sees them: the same in a native window
// (main.js: Deno + SDL3) and in a browser's canvas (index.html). Particles
// moved by a compute shader and drawn as instanced quads, added up (glowing
// where they crowd).

/**
 * The shaders (common.wgsl before each), fetched from beside this file: over
 * http in a browser, from disk in Deno (--allow-read). {step, draw}.
 */
export async function loadShaders() {
  const text = (name) => fetch(new URL(name, import.meta.url)).then((r) => r.ok ? r.text() : Promise.reject(new Error(`${name}: ${r.status}`)));
  const [common, step, draw] = await Promise.all(["common.wgsl", "step.wgsl", "draw.wgsl"].map(text));
  return { step: common + step, draw: common + draw };
}

const ADD = { srcFactor: "one", dstFactor: "one", operation: "add" };

/**
 * The particles on `device`, drawn into textures of `format`, with `shaders` (loadShaders()):
 * {seed(count), frame(view, {width, height, mouse: [x, y] (-1 to 1), pull, dt, time, paused}), count}.
 */
export function createParticles(device, format, shaders) {
  const uniforms = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const uniformData = new Float32Array(8);
  const stepPipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: shaders.step }), entryPoint: "step" } });
  const drawModule = device.createShaderModule({ code: shaders.draw });
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
