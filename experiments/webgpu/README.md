# WebGPU without a browser (an experiment)

What it's like to draw with WebGPU in a native window from Deno, phil's
runtime, and whether the same code runs in a browser too. One million
particles, moved by a compute shader and drawn as instanced quads
(`particles.js`; its shaders in `common.wgsl`, `step.wgsl`, `draw.wgsl`, which
`../cef`'s Rust host draws with too), in:

- **a native window** (`main.js`): Deno's own WebGPU (wgpu: Vulkan here,
  Direct3D 12 on Windows, Metal on macOS), a window from SDL3 over FFI
  (`sdl.js`), joined by `Deno.UnsafeWindowSurface`;
- **a browser's canvas** (`index.html`, served by `serve.js`).

```sh
deno task webgpu                     # the native window (Linux: pacman -S sdl3)
deno task webgpu --count 4194304     # more of them
deno run --allow-net --allow-read experiments/webgpu/serve.js   # then http://127.0.0.1:8137/
```

Mouse: left pulls, right pushes, wheel: how hard. Space: pause. R: again.
+/−: twice or half as many. Esc: quit (the native one). `--auto` / `?auto`:
the pull goes round by itself; `--frames N` / `?frames=N`: how fast N frames came.

## Found (2026-10-18; GTX 1080 Ti, NVIDIA 580.178.04, Deno 2.9.6, SDL 3.4.16, Brave 155)

Run in a headless compositor (cage) on the GPU, 60 Hz:

| | Native (Deno + SDL3, Wayland) | Native (X11 / Xwayland) | Brave |
|---|---|---|---|
| 1 M particles | 60 fps, frames 16.0 ms (99th: 17.5) | 60 fps, frames 12–13 ms, uneven (99th: 27) | 60 fps, 16.1 ms (99th: 16.7) |
| 8 M particles | 60 fps, 16.0 ms (99th: 17.4) | | |

- The same module, unchanged, in both: WGSL, pipelines, buffers. Only the
  window around it differs (~100 lines each).
- Wayland paces frames evenly; through X11 they come early and late.
- SDL3 picks X11 unless the compositor has the frame-timing protocols (fifo,
  commit-timing); cage hasn't, Hyprland (0.56) should. `SDL_VIDEO_DRIVER=wayland`
  forces it; the first line printed says which it is.
- **A crash at exit** (Wayland + NVIDIA): Deno has no way to let go of a
  window surface but its own clean-up at the very end, after SDL has closed
  the Wayland connection, and NVIDIA's Vulkan then uses it (SIGSEGV/SIGABRT in
  libwayland-client, from libnvidia-glcore). Ending with `Deno.exit()` first
  avoids it. A rough edge of an API marked unstable (`--unstable-webgpu`).
- Not tried yet: resizing (cage's window is the whole screen), Windows and
  macOS (the handles for them are in `sdl.js`: Win32, a Metal view), typing text.
