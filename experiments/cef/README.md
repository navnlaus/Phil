# A web page over native WebGPU, with CEF (an experiment)

`cef-host`: a native window (winit) drawn with wgpu — the particles of
`../webgpu`, the same WGSL files — and over them a web page (`hud.html`) drawn
by CEF, the Chromium Embedded Framework, off screen. Each frame of the page is
handed over as a GPU texture (a dmabuf here; a D3D11 texture on Windows, an
IOSurface on macOS) and drawn over the particles: no copy through memory. The
mouse goes to the page over its panels and to the particles elsewhere; keys
go to the page. In Rust, with [`cef`](https://crates.io/crates/cef) (tauri-apps' cef-rs).

```sh
experiments/cef/run.sh                       # builds, then runs (Linux: cmake, ninja)
experiments/cef/run.sh --url http://…        # another page instead
experiments/cef/run.sh --no-shared-texture   # the page's frames through memory, to compare
experiments/cef/run.sh --auto --frames 600   # for tests: no mouse needed, quits saying how it went
```

The first build downloads CEF (Chromium 154, ~300 MB, to `~/.local/share/cef`)
and builds its C++ wrapper (a few minutes). `run.sh` runs the newest CEF it
finds there: zero-copy on NVIDIA needs **CEF 156** (below), which the `cef`
crate doesn't pin yet: put its "minimal" build's `Release/` and `Resources/`
files together in `~/.local/share/cef/156.0.7/cef_linux_x86_64/`. A program
built against 154's API runs on 156's library (it takes API versions back to 133).

`CEF_DEBUG=1` logs each frame's buffer and what the page gets; `CEF_OZONE=x11|wayland`
and `CEF_SWITCHES="name=value …"` pass Chromium's switches through, for trying.

## Found (2026-10-18; GTX 1080 Ti, NVIDIA 580.178.04, Wayland, CEF 154.0.34 / 156.0.7)

Run in a headless compositor (cage) on the GPU, at 60 Hz:

- **Zero-copy works, with CEF 156** (beta): 1 M particles and the page over them
  at 62 fps (frames 16.05 ms, 99th percentile 16.6 ms); the page's frames come
  as NVIDIA's own tiled buffers, imported into wgpu (Vulkan) once each and used
  again (2 in all). A minute of it: memory flat (CEF's processes ~960 MB).
- **Not with CEF 154** (the crate's): on NVIDIA Chromium draws nothing into the
  buffers it shares (linear ones: `modifier 0x0`; "ProduceSkiaGanesh failed to
  create GL representation"). CEF's fix ([#4238](https://github.com/chromiumembedded/cef/pull/4238),
  merged 2026-10-09) is in 156. With Chromium on Vulkan (`enable-features=Vulkan
  use-angle=vulkan`) 154 hands buffers over, but they're empty too.
- Through memory (`--no-shared-texture`) works on both, at the same frame rate.
- Chromium in CEF picks Wayland by itself (it says "not compatible with Vulkan",
  harmlessly); X11 works too with `use-gl=angle use-angle=gl-egl`.
- Inside the page: WebGPU and WebGL are there. phil's own UI (its server's
  address as `--url`) draws in it as it does in Brave.
- Clicks and typing go through: buttons, a text field, `þé` (scripted clicks on
  the page's controls, `--click more@60`; keys typed with wtype in the compositor).

What it took, the rough edges:

- cef-rs's importer makes a new Vulkan image and memory for each frame and never
  frees the memory (its own example imports each frame: a leak). Kept here: one
  import per buffer (by the dmabuf's inode), drawn into our own texture before
  CEF has the buffer back.
- cef-rs's example also sleeps 59 ms between turns of its loop (≈17 fps).
- Keys: CEF on Linux makes a key's character from its Windows key code (US
  style), not from the character it's given, so text typed as key events comes
  out wrong (`o` as `/`). Text goes in with `ime_commit_text` instead (any
  Unicode); keys with codes from the layout's key (winit's logical key).
- Hit-testing is ours: the page says where its panels are (console messages,
  `"hud:" + JSON`), the host sends the mouse there only over them.
- CEF needs its files beside the program (`libcef.so` is 1.4 GB with symbols;
  ~250 MB stripped), and leaves an `extensions/` folder there.
- Not tried yet: resizing (the compositor's window is the whole screen), a
  second page, Windows and macOS (the importers for them are in cef-rs), mpv.
