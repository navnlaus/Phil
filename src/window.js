// GTK3 + WebKitGTK (webkit2gtk-4.1) windows over Deno FFI. One app per
// process: it can open several windows, and run() blocks the calling thread
// in gtk_main() until quit().

// WebKitGTK's DMA-BUF renderer dies with "Error 71 (Protocol error)" on the
// proprietary NVIDIA driver under Wayland because of explicit sync. Turning off
// explicit sync keeps GPU rendering; WEBKIT_DISABLE_DMABUF_RENDERER=1 also
// avoids the crash but drops WebKit to CPU rendering, which makes scrolling slow.
// Must be set before WebKit loads. (Checked through libc because Deno refuses
// /proc and /sys without --allow-all.)
if (Deno.env.get("WEBKIT_DISABLE_DMABUF_RENDERER") === undefined && Deno.env.get("__NV_DISABLE_EXPLICIT_SYNC") === undefined) {
  const libc = Deno.dlopen("libc.so.6", { access: { parameters: ["buffer", "i32"], result: "i32" } });
  if (libc.symbols.access(new TextEncoder().encode("/proc/driver/nvidia\0"), 0) === 0) {
    Deno.env.set("__NV_DISABLE_EXPLICIT_SYNC", "1");
  }
  libc.close();
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
});
const gtk = Deno.dlopen("libgtk-3.so.0", {
  gtk_init: { parameters: ["pointer", "pointer"], result: "void" },
  gtk_window_new: { parameters: ["i32"], result: "pointer" },
  gtk_window_set_title: { parameters: ["pointer", "buffer"], result: "void" },
  gtk_window_set_default_size: { parameters: ["pointer", "i32", "i32"], result: "void" },
  gtk_window_set_startup_id: { parameters: ["pointer", "buffer"], result: "void" },
  gtk_container_add: { parameters: ["pointer", "pointer"], result: "void" },
  gtk_widget_show_all: { parameters: ["pointer"], result: "void" },
  gtk_widget_destroy: { parameters: ["pointer"], result: "void" },
  gtk_main: { parameters: [], result: "void" },
  gtk_main_quit: { parameters: [], result: "void" },
});
const webkit = Deno.dlopen("libwebkit2gtk-4.1.so.0", {
  webkit_web_view_new: { parameters: [], result: "pointer" },
  webkit_web_context_new_ephemeral: { parameters: [], result: "pointer" },
  webkit_web_view_new_with_context: { parameters: ["pointer"], result: "pointer" },
  webkit_web_view_load_uri: { parameters: ["pointer", "buffer"], result: "void" },
  webkit_web_view_get_title: { parameters: ["pointer"], result: "pointer" },
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
 * `appId`: Wayland app id / WM class (e.g. for Hyprland window rules).
 * `ephemeral`: all windows share one private WebKit session that writes
 *   nothing to disk (no cache, cookies, storage).
 * `keepRunning`: stay in gtk_main() after the last window closes (background
 *   instance); otherwise quit then.
 * `trace(label)`: startup milestones (PHIL_TRACE).
 */
export function createApp({ appId, ephemeral = false, keepRunning = false, trace = () => {} }) {
  glib.symbols.g_set_prgname(cstr(appId));
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
    gtk.symbols.gtk_widget_show_all(w.win);
  };

  const onDestroy = new Deno.UnsafeCallback({ parameters: ["pointer", "pointer"], result: "void" }, (win) => {
    const w = byWin.get(key(win));
    if (!w) return;
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
    gtk.symbols.gtk_window_set_title(w.win, cstr((ptr && Deno.UnsafePointerView.getCString(ptr)) || appId));
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
  // Messages from a page: window.webkit.messageHandlers.phil.postMessage(...)
  //   "ready[:timings]"  page styled and running
  //   "close"            its close button (scripts may not window.close() a window they didn't open)
  const onMessage = new Deno.UnsafeCallback({ parameters: ["pointer", "pointer", "pointer"], result: "void" }, (manager, result) => {
    const w = byManager.get(key(manager));
    if (!w) return;
    const str = jsc.symbols.jsc_value_to_string(webkit.symbols.webkit_javascript_result_get_js_value(result));
    const message = str ? Deno.UnsafePointerView.getCString(str) : "";
    glib.symbols.g_free(str);
    if (message === "close") gtk.symbols.gtk_widget_destroy(w.win);
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

    /** Opens a window on `url`; it appears once the page is ready. */
    openWindow(url, { startupId, width = 1280, height = 820 } = {}) {
      const win = gtk.symbols.gtk_window_new(0);
      gtk.symbols.gtk_window_set_title(win, cstr(appId));
      gtk.symbols.gtk_window_set_default_size(win, width, height);
      if (startupId) gtk.symbols.gtk_window_set_startup_id(win, cstr(startupId));
      const view = context ? webkit.symbols.webkit_web_view_new_with_context(context) : webkit.symbols.webkit_web_view_new();
      webkit.symbols.webkit_settings_set_enable_developer_extras(webkit.symbols.webkit_web_view_get_settings(view), 1);
      gtk.symbols.gtk_container_add(win, view);
      const manager = webkit.symbols.webkit_web_view_get_user_content_manager(view);
      webkit.symbols.webkit_user_content_manager_register_script_message_handler(manager, cstr("phil"));

      const w = { win, view, manager, shown: false };
      windows.add(w);
      byWin.set(key(win), w);
      byView.set(key(view), w);
      byManager.set(key(manager), w);
      gobject.symbols.g_signal_connect_data(manager, cstr("script-message-received::phil"), onMessage.pointer, null, null, 0);
      gobject.symbols.g_signal_connect_data(win, cstr("destroy"), onDestroy.pointer, null, null, 0);
      gobject.symbols.g_signal_connect_data(view, cstr("notify::title"), onTitle.pointer, null, null, 0);

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
