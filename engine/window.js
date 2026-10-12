// GTK3 + WebKitGTK (webkit2gtk-4.1) windows over Deno FFI, for the engine:
// windows of any app, and run() blocks the calling thread in gtk_main() until
// quit().

// WebKitGTK's DMA-BUF renderer dies with "Error 71 (Protocol error)" on the
// proprietary NVIDIA driver under Wayland because of explicit sync. Turning off
// explicit sync keeps GPU rendering; WEBKIT_DISABLE_DMABUF_RENDERER=1 also
// avoids the crash but drops WebKit to CPU rendering, which makes scrolling slow.
//
// Also on NVIDIA, the video player (GStreamer) picks the NVDEC hardware
// decoders, whose frames come in CUDA memory that WebKit's video sink can't
// take: playback freezes on the first frame or never starts. Ranking them out
// leaves video to the software decoders. Your own GST_PLUGIN_FEATURE_RANK
// entries come after these, so they still win.
//
// Both must be set before WebKit loads. (Checked through libc because Deno
// refuses /proc and /sys without --allow-all.)
{
  const libc = Deno.dlopen("libc.so.6", { access: { parameters: ["buffer", "i32"], result: "i32" } });
  const nvidia = libc.symbols.access(new TextEncoder().encode("/proc/driver/nvidia\0"), 0) === 0;
  libc.close();
  if (nvidia) {
    if (Deno.env.get("WEBKIT_DISABLE_DMABUF_RENDERER") === undefined && Deno.env.get("__NV_DISABLE_EXPLICIT_SYNC") === undefined) {
      Deno.env.set("__NV_DISABLE_EXPLICIT_SYNC", "1");
    }
    const nvdec = ["h264", "h265", "vp8", "vp9", "av1", "mpeg2video", "mpeg4video", "mpegvideo", "jpeg"].map((c) => `nv${c}dec:NONE`);
    Deno.env.set("GST_PLUGIN_FEATURE_RANK", [...nvdec, Deno.env.get("GST_PLUGIN_FEATURE_RANK")].filter(Boolean).join(","));
  }
}

const libc = Deno.dlopen("libc.so.6", {
  read: { parameters: ["i32", "buffer", "usize"], result: "isize" },
});
const glib = Deno.dlopen("libglib-2.0.so.0", {
  g_set_prgname: { parameters: ["buffer"], result: "void" },
  g_timeout_add: { parameters: ["u32", "function", "pointer"], result: "u32" },
  g_unix_fd_add: { parameters: ["i32", "u32", "function", "pointer"], result: "u32" },
  g_free: { parameters: ["pointer"], result: "void" },
});
const jsc = Deno.dlopen("libjavascriptcoregtk-4.1.so.0", {
  jsc_value_to_string: { parameters: ["pointer"], result: "pointer" },
});
const gobject = Deno.dlopen("libgobject-2.0.so.0", {
  g_signal_connect_data: {
    parameters: ["pointer", "buffer", "function", "pointer", "pointer", "i32"],
    result: "u64",
  },
  g_object_unref: { parameters: ["pointer"], result: "void" },
});
const gtk = Deno.dlopen("libgtk-3.so.0", {
  gtk_init: { parameters: ["pointer", "pointer"], result: "void" },
  gtk_window_new: { parameters: ["i32"], result: "pointer" },
  gtk_window_set_title: { parameters: ["pointer", "buffer"], result: "void" },
  gtk_window_set_default_size: { parameters: ["pointer", "i32", "i32"], result: "void" },
  gtk_window_set_startup_id: { parameters: ["pointer", "buffer"], result: "void" },
  gtk_container_add: { parameters: ["pointer", "pointer"], result: "void" },
  gtk_widget_show_all: { parameters: ["pointer"], result: "void" },
  gtk_widget_grab_focus: { parameters: ["pointer"], result: "void" },
  gtk_window_present: { parameters: ["pointer"], result: "void" },
  gtk_widget_destroy: { parameters: ["pointer"], result: "void" },
  gtk_main: { parameters: [], result: "void" },
  gtk_main_quit: { parameters: [], result: "void" },
  gtk_target_list_new: { parameters: ["pointer", "u32"], result: "pointer" },
  gtk_target_list_add_uri_targets: { parameters: ["pointer", "u32"], result: "void" },
  gtk_target_list_add_text_targets: { parameters: ["pointer", "u32"], result: "void" },
  gtk_target_list_unref: { parameters: ["pointer"], result: "void" },
  gtk_drag_begin_with_coordinates: { parameters: ["pointer", "pointer", "i32", "i32", "pointer", "i32", "i32"], result: "pointer" },
  gtk_drag_set_icon_surface: { parameters: ["pointer", "pointer"], result: "void" },
  gtk_selection_data_set_uris: { parameters: ["pointer", "buffer"], result: "i32" },
  gtk_selection_data_set_text: { parameters: ["pointer", "buffer", "i32"], result: "i32" },
});
// A drag's picture: PNG bytes into a pixbuf, then a cairo surface at the screen's scale.
const pixbuf = Deno.dlopen("libgdk_pixbuf-2.0.so.0", {
  gdk_pixbuf_loader_new: { parameters: [], result: "pointer" },
  gdk_pixbuf_loader_write: { parameters: ["pointer", "buffer", "usize", "pointer"], result: "i32" },
  gdk_pixbuf_loader_close: { parameters: ["pointer", "pointer"], result: "i32" },
  gdk_pixbuf_loader_get_pixbuf: { parameters: ["pointer"], result: "pointer" },
});
const gdk = Deno.dlopen("libgdk-3.so.0", {
  gdk_cairo_surface_create_from_pixbuf: { parameters: ["pointer", "i32", "pointer"], result: "pointer" },
});
const cairo = Deno.dlopen("libcairo.so.2", {
  cairo_surface_set_device_offset: { parameters: ["pointer", "f64", "f64"], result: "void" },
  cairo_surface_destroy: { parameters: ["pointer"], result: "void" },
});
const webkit = Deno.dlopen("libwebkit2gtk-4.1.so.0", {
  webkit_web_view_new: { parameters: [], result: "pointer" },
  webkit_web_context_new_ephemeral: { parameters: [], result: "pointer" },
  webkit_web_view_new_with_context: { parameters: ["pointer"], result: "pointer" },
  webkit_web_view_load_uri: { parameters: ["pointer", "buffer"], result: "void" },
  webkit_web_view_get_title: { parameters: ["pointer"], result: "pointer" },
  webkit_web_view_terminate_web_process: { parameters: ["pointer"], result: "void" },
  webkit_web_view_get_settings: { parameters: ["pointer"], result: "pointer" },
  webkit_web_view_get_user_content_manager: { parameters: ["pointer"], result: "pointer" },
  webkit_user_content_manager_register_script_message_handler: { parameters: ["pointer", "buffer"], result: "i32" },
  webkit_javascript_result_get_js_value: { parameters: ["pointer"], result: "pointer" },
  webkit_settings_set_enable_developer_extras: { parameters: ["pointer", "i32"], result: "void" },
});

const cstr = (s) => new TextEncoder().encode(s + "\0");
const key = (ptr) => Deno.UnsafePointer.value(ptr);

// How long to wait for a page's "ready" before showing its window anyway.
const SHOW_TIMEOUT_MS = 2000;

/**
 * `name`: the process's program name (windows get their app's id instead).
 * `ephemeral`: all windows share one private WebKit session that writes
 *   nothing to disk (no cache, cookies, storage).
 * `keepRunning`: stay in gtk_main() after the last window closes (background
 *   instance); otherwise quit then.
 * `trace(label)`: startup milestones (PHIL_TRACE).
 */
export function createApp({ name, ephemeral = false, keepRunning = false, trace = () => {} }) {
  glib.symbols.g_set_prgname(cstr(name));
  gtk.symbols.gtk_init(null, null);
  const context = ephemeral ? webkit.symbols.webkit_web_context_new_ephemeral() : null;

  // Open windows by GTK window, web view and content manager pointer, so one
  // set of signal callbacks serves every window.
  const windows = new Set();
  const byWin = new Map(), byView = new Map(), byManager = new Map();
  let retiring = false;

  const show = (w, why) => {
    if (w.shown || !windows.has(w)) return;
    w.shown = true;
    trace(`window shown (${why})`);
    // GTK takes a window's Wayland app id from the program name when it first
    // shows it, so each app's windows get their own (for window rules).
    glib.symbols.g_set_prgname(cstr(w.appId));
    gtk.symbols.gtk_widget_show_all(w.win);
    // Keys go to the page from the start, without a click first.
    gtk.symbols.gtk_widget_grab_focus(w.view);
    gtk.symbols.gtk_window_present(w.win);
  };

  // A closing window's web process is killed rather than left to exit by
  // itself: on NVIDIA its exit often crashes (a thread's cleanup calls into the
  // EGL driver while it is being unloaded), and the desktop reports the crash.
  // Nothing is lost; phil keeps no state in the page.
  const onDestroy = new Deno.UnsafeCallback({ parameters: ["pointer", "pointer"], result: "void" }, (win) => {
    const w = byWin.get(key(win));
    if (!w) return;
    webkit.symbols.webkit_web_view_terminate_web_process(w.view);
    windows.delete(w);
    byWin.delete(key(w.win));
    byView.delete(key(w.view));
    byManager.delete(key(w.manager));
    if (windows.size === 0 && (!keepRunning || retiring)) gtk.symbols.gtk_main_quit();
  });
  const onTitle = new Deno.UnsafeCallback({ parameters: ["pointer", "pointer", "pointer"], result: "void" }, (view) => {
    const w = byView.get(key(view));
    if (!w) return;
    const ptr = webkit.symbols.webkit_web_view_get_title(view);
    gtk.symbols.gtk_window_set_title(w.win, cstr((ptr && Deno.UnsafePointerView.getCString(ptr)) || w.appId));
  });
  // Windows stay hidden until their page is styled and its script runs
  // ("ready"). Mapped earlier, a window shows a buffer WebKit hasn't drawn yet
  // (noise on NVIDIA), then a white page and a black frame at the redirect. The
  // folder renders a few ms later, during the compositor's open animation.
  const onShowTimeout = new Deno.UnsafeCallback({ parameters: ["pointer"], result: "i32" }, (win) => {
    const w = byWin.get(key(win));
    if (w) show(w, "timeout");
    return 0;
  });
  // Dragging files out of a window (startDrag): what each window's drag
  // carries, handed over when the place it's dropped on asks.
  const URI_TARGET = 0, TEXT_TARGET = 1;
  const onDragDataGet = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer", "u32", "u32", "pointer"], result: "void" },
    (win, _context, selection, info) => {
      const drag = byWin.get(key(win))?.drag;
      if (!drag) return;
      if (info === URI_TARGET) gtk.symbols.gtk_selection_data_set_uris(selection, drag.uriArray);
      else gtk.symbols.gtk_selection_data_set_text(selection, drag.text, -1);
    },
  );
  const onDragEnd = new Deno.UnsafeCallback({ parameters: ["pointer", "pointer", "pointer"], result: "void" }, (win) => {
    const w = byWin.get(key(win));
    if (w) w.drag = null;
  });

  // A drag of files out of window `w`, started while the page's own drag (a
  // right- or middle-drag, which WebKit doesn't turn into one) leaves the
  // window, its button still held. `uris`: file:// URIs; `actions`: what the
  // place it's dropped on may do ("copy", "move", "ask"); `image`: the drag's
  // picture (a PNG data: URL, drawn at `scale`), with the pointer at
  // `hotspot` from its top left corner.
  function startDrag(w, { uris, paths, button, actions, image, scale = 1, hotspot = [0, 0] }) {
    const strings = uris.map(cstr);
    const uriArray = new BigUint64Array(strings.length + 1); // a NULL-terminated char**
    strings.forEach((s, i) => (uriArray[i] = BigInt(Deno.UnsafePointer.value(Deno.UnsafePointer.of(s)))));
    w.drag = { strings, uriArray, text: cstr(paths.join("\n")) }; // kept alive while GTK may ask
    const targets = gtk.symbols.gtk_target_list_new(null, 0);
    gtk.symbols.gtk_target_list_add_uri_targets(targets, URI_TARGET);
    gtk.symbols.gtk_target_list_add_text_targets(targets, TEXT_TARGET);
    const mask = { copy: 2, move: 4, ask: 32 }; // GdkDragAction
    const context = gtk.symbols.gtk_drag_begin_with_coordinates(
      w.win, targets, actions.reduce((m, a) => m | (mask[a] ?? 0), 0), button, null, -1, -1,
    );
    gtk.symbols.gtk_target_list_unref(targets);
    if (!context) return void (w.drag = null);
    if (image) setDragPicture(context, image, scale, hotspot);
  }

  function setDragPicture(context, dataUrl, scale, [hx, hy]) {
    const png = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0));
    const loader = pixbuf.symbols.gdk_pixbuf_loader_new();
    const ok = pixbuf.symbols.gdk_pixbuf_loader_write(loader, png, png.length, null) &&
      pixbuf.symbols.gdk_pixbuf_loader_close(loader, null);
    const pb = ok ? pixbuf.symbols.gdk_pixbuf_loader_get_pixbuf(loader) : null;
    if (pb) {
      const surface = gdk.symbols.gdk_cairo_surface_create_from_pixbuf(pb, scale, null);
      // The pointer is at the surface's (0, 0): its origin moved to the hotspot (in device pixels).
      cairo.symbols.cairo_surface_set_device_offset(surface, hx * scale, hy * scale);
      gtk.symbols.gtk_drag_set_icon_surface(context, surface);
      cairo.symbols.cairo_surface_destroy(surface); // GTK keeps its own reference
    }
    gobject.symbols.g_object_unref(loader);
  }

  // Messages from a page: window.webkit.messageHandlers.phil.postMessage(...)
  //   "ready[:timings]"  page styled and running
  //   "close"            its close button (scripts may not window.close() a window they didn't open)
  //   "drag:{json}"      drag files out of the window (startDrag)
  const onMessage = new Deno.UnsafeCallback({ parameters: ["pointer", "pointer", "pointer"], result: "void" }, (manager, result) => {
    const w = byManager.get(key(manager));
    if (!w) return;
    const str = jsc.symbols.jsc_value_to_string(webkit.symbols.webkit_javascript_result_get_js_value(result));
    const message = str ? Deno.UnsafePointerView.getCString(str) : "";
    glib.symbols.g_free(str);
    if (message === "close") gtk.symbols.gtk_widget_destroy(w.win);
    else if (message.startsWith("drag:")) startDrag(w, JSON.parse(message.slice(5)));
    else if (message.startsWith("ready")) {
      if (message.length > 6) trace(`page ready ${message.slice(6)}`);
      show(w, "page ready");
    }
  });

  trace("app created");

  return {
    get windowCount() {
      return windows.size;
    },

    /**
     * Opens a window on `url`; it appears once the page is ready. `appId`:
     * its Wayland app id / WM class (e.g. for Hyprland window rules).
     */
    openWindow(url, { appId, startupId, width = 1280, height = 820 }) {
      const win = gtk.symbols.gtk_window_new(0);
      gtk.symbols.gtk_window_set_title(win, cstr(appId));
      gtk.symbols.gtk_window_set_default_size(win, width, height);
      if (startupId) gtk.symbols.gtk_window_set_startup_id(win, cstr(startupId));
      const view = context ? webkit.symbols.webkit_web_view_new_with_context(context) : webkit.symbols.webkit_web_view_new();
      webkit.symbols.webkit_settings_set_enable_developer_extras(webkit.symbols.webkit_web_view_get_settings(view), 1);
      gtk.symbols.gtk_container_add(win, view);
      const manager = webkit.symbols.webkit_web_view_get_user_content_manager(view);
      webkit.symbols.webkit_user_content_manager_register_script_message_handler(manager, cstr("phil"));

      const w = { win, view, manager, appId, shown: false };
      windows.add(w);
      byWin.set(key(win), w);
      byView.set(key(view), w);
      byManager.set(key(manager), w);
      gobject.symbols.g_signal_connect_data(manager, cstr("script-message-received::phil"), onMessage.pointer, null, null, 0);
      gobject.symbols.g_signal_connect_data(win, cstr("destroy"), onDestroy.pointer, null, null, 0);
      gobject.symbols.g_signal_connect_data(view, cstr("notify::title"), onTitle.pointer, null, null, 0);
      gobject.symbols.g_signal_connect_data(win, cstr("drag-data-get"), onDragDataGet.pointer, null, null, 0);
      gobject.symbols.g_signal_connect_data(win, cstr("drag-end"), onDragEnd.pointer, null, null, 0);

      webkit.symbols.webkit_web_view_load_uri(view, cstr(url));
      trace("loading page");
      glib.symbols.g_timeout_add(SHOW_TIMEOUT_MS, onShowTimeout.pointer, win);
    },

    /**
     * Calls onMessage(line) for each line written to `fd` (a non-blocking pipe):
     * how other threads ask this one, blocked in gtk_main(), to do something.
     */
    watchPipe(fd, onLine) {
      let pending = "";
      const buf = new Uint8Array(4096);
      const decoder = new TextDecoder();
      const onReadable = new Deno.UnsafeCallback({ parameters: ["i32", "u32", "pointer"], result: "i32" }, () => {
        for (let n; (n = Number(libc.symbols.read(fd, buf, buf.length))) > 0;) {
          pending += decoder.decode(buf.subarray(0, n), { stream: true });
        }
        let nl;
        while ((nl = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, nl);
          pending = pending.slice(nl + 1);
          if (line) onLine(line);
        }
        return 1;
      });
      glib.symbols.g_unix_fd_add(fd, 1 /* G_IO_IN */, onReadable.pointer, null);
    },

    /** Stop once the open windows are closed (a newer phil takes over). */
    retire() {
      retiring = true;
      if (windows.size === 0) gtk.symbols.gtk_main_quit();
    },

    quit() {
      for (const w of [...windows]) gtk.symbols.gtk_widget_destroy(w.win);
      gtk.symbols.gtk_main_quit();
    },

    run() {
      gtk.symbols.gtk_main();
    },
  };
}
