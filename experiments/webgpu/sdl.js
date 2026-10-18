// Just enough of SDL3 (over Deno FFI) for a window drawn with WebGPU: a window,
// the native handles Deno.UnsafeWindowSurface wants (Wayland, X11, Win32, or a
// Metal view on macOS), and its events as plain objects. SDL3 is the system's
// (Arch: sdl3); on Windows, SDL3.dll next to the script or on PATH.

const LIBRARY = { linux: ["libSDL3.so.0", "libSDL3.so"], windows: ["SDL3.dll"], darwin: ["libSDL3.dylib", "/opt/homebrew/lib/libSDL3.dylib", "/usr/local/lib/libSDL3.dylib"] }[Deno.build.os] ?? ["libSDL3.so.0"];

const SYMBOLS = {
  SDL_Init: { parameters: ["u32"], result: "bool" },
  SDL_GetError: { parameters: [], result: "pointer" },
  SDL_GetCurrentVideoDriver: { parameters: [], result: "pointer" },
  SDL_CreateWindow: { parameters: ["buffer", "i32", "i32", "u64"], result: "pointer" },
  SDL_SetWindowTitle: { parameters: ["pointer", "buffer"], result: "bool" },
  SDL_GetWindowSize: { parameters: ["pointer", "buffer", "buffer"], result: "bool" },
  SDL_GetWindowSizeInPixels: { parameters: ["pointer", "buffer", "buffer"], result: "bool" },
  SDL_GetWindowProperties: { parameters: ["pointer"], result: "u32" },
  SDL_GetPointerProperty: { parameters: ["u32", "buffer", "pointer"], result: "pointer" },
  SDL_GetNumberProperty: { parameters: ["u32", "buffer", "i64"], result: "i64" },
  SDL_Metal_CreateView: { parameters: ["pointer"], result: "pointer" },
  SDL_PollEvent: { parameters: ["buffer"], result: "bool" },
};

const INIT_VIDEO = 0x20;
const WINDOW_RESIZABLE = 0x20n, WINDOW_HIGH_PIXEL_DENSITY = 0x2000n;

// Event types (SDL_events.h), and where their fields are in an SDL_Event (128 bytes).
const QUIT = 0x100, WINDOW_PIXEL_SIZE_CHANGED = 0x207, WINDOW_CLOSE_REQUESTED = 0x210;
const KEY_DOWN = 0x300, KEY_UP = 0x301, MOUSE_MOTION = 0x400, MOUSE_BUTTON_DOWN = 0x401, MOUSE_BUTTON_UP = 0x402, MOUSE_WHEEL = 0x403;

export const KEY = { ESCAPE: 0x1b, SPACE: 0x20, R: 0x72, F: 0x66, PLUS: 0x2b, EQUALS: 0x3d, MINUS: 0x2d };

const cstr = (s) => new TextEncoder().encode(s + "\0");
const str = (p) => (p ? Deno.UnsafePointerView.getCString(p) : "");

function open() {
  const errors = [];
  for (const name of LIBRARY) {
    try {
      return Deno.dlopen(name, SYMBOLS).symbols;
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  throw new Error(`SDL3 isn't there (${errors.join("; ")})`);
}

export class Window {
  #sdl;
  #win;
  #event = new Uint8Array(128);
  #view = new DataView(this.#event.buffer);

  constructor(title, width, height) {
    this.#sdl = open();
    if (!this.#sdl.SDL_Init(INIT_VIDEO)) throw new Error(`SDL_Init: ${str(this.#sdl.SDL_GetError())}`);
    this.#win = this.#sdl.SDL_CreateWindow(cstr(title), width, height, WINDOW_RESIZABLE | WINDOW_HIGH_PIXEL_DENSITY);
    if (!this.#win) throw new Error(`SDL_CreateWindow: ${str(this.#sdl.SDL_GetError())}`);
    this.driver = str(this.#sdl.SDL_GetCurrentVideoDriver());
  }

  /** Its size in pixels: [width, height]. */
  size() {
    return this.#size("SDL_GetWindowSizeInPixels");
  }

  /** Its size in the desktop's (scaled) units, which mouse events are in: [width, height]. */
  logicalSize() {
    return this.#size("SDL_GetWindowSize");
  }

  #size(fn) {
    const w = new Int32Array(1), h = new Int32Array(1);
    this.#sdl[fn](this.#win, w, h);
    return [w[0], h[0]];
  }

  set title(text) {
    this.#sdl.SDL_SetWindowTitle(this.#win, cstr(text));
  }

  /** The options for new Deno.UnsafeWindowSurface(), but its size. */
  surfaceHandles() {
    const props = this.#sdl.SDL_GetWindowProperties(this.#win);
    const ptr = (name) => this.#sdl.SDL_GetPointerProperty(props, cstr(name), null);
    switch (this.driver) {
      case "wayland":
        return { system: "wayland", windowHandle: ptr("SDL.window.wayland.surface"), displayHandle: ptr("SDL.window.wayland.display") };
      case "x11": {
        const xid = this.#sdl.SDL_GetNumberProperty(props, cstr("SDL.window.x11.window"), 0n);
        return { system: "x11", windowHandle: Deno.UnsafePointer.create(BigInt(xid)), displayHandle: ptr("SDL.window.x11.display") };
      }
      case "windows":
        return { system: "win32", windowHandle: ptr("SDL.window.win32.hwnd"), displayHandle: ptr("SDL.window.win32.instance") };
      case "cocoa": // (an NSView with a CAMetalLayer: what wgpu draws into there)
        return { system: "cocoa", windowHandle: this.#sdl.SDL_Metal_CreateView(this.#win), displayHandle: null };
      default:
        throw new Error(`SDL's video driver "${this.driver}": not one WebGPU can draw in here`);
    }
  }

  /** The events since last asked: [{type: "quit"|"resize"|"key"|"mouse"|"button"|"wheel", ...}]. */
  poll() {
    const out = [], v = this.#view;
    while (this.#sdl.SDL_PollEvent(this.#event)) {
      const type = v.getUint32(0, true);
      if (type === QUIT || type === WINDOW_CLOSE_REQUESTED) out.push({ type: "quit" });
      else if (type === WINDOW_PIXEL_SIZE_CHANGED) out.push({ type: "resize", width: v.getInt32(20, true), height: v.getInt32(24, true) });
      else if (type === KEY_DOWN || type === KEY_UP) out.push({ type: "key", key: v.getUint32(28, true), down: type === KEY_DOWN, repeat: v.getUint8(37) !== 0 });
      else if (type === MOUSE_MOTION) out.push({ type: "mouse", x: v.getFloat32(28, true), y: v.getFloat32(32, true), buttons: v.getUint32(24, true) });
      else if (type === MOUSE_BUTTON_DOWN || type === MOUSE_BUTTON_UP) out.push({ type: "button", button: v.getUint8(24), down: type === MOUSE_BUTTON_DOWN, x: v.getFloat32(28, true), y: v.getFloat32(32, true) });
      else if (type === MOUSE_WHEEL) out.push({ type: "wheel", y: v.getFloat32(28, true) });
    }
    return out;
  }

  // (No close(): a window WebGPU draws in goes with the process. See main.js's end.)
}
