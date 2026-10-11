// Minimal GTK3 + WebKitGTK (webkit2gtk-4.1) window over Deno FFI.
// Blocks the calling thread in gtk_main() until the window is closed.

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

const glib = Deno.dlopen("libglib-2.0.so.0", {
  g_set_prgname: { parameters: ["buffer"], result: "void" },
  g_timeout_add: { parameters: ["u32", "function", "pointer"], result: "u32" },
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

// How long to wait for the page's "ready" before showing the window anyway.
const SHOW_TIMEOUT_MS = 2000;

/**
 * Sets up the (still hidden) window, so that happens while the server is
 * starting; `run(url)` then loads the page and blocks in the GTK main loop
 * until the window is closed.
 * `ephemeral`: a private WebKit session that writes nothing to disk (no cache, cookies, storage).
 * `trace(label)`: called with startup milestones (PHIL_TRACE).
 */
export function createWindow({ title, width, height, ephemeral = false, trace = () => {} }) {
  glib.symbols.g_set_prgname(cstr(title)); // app-id / WM class, e.g. for Hyprland window rules
  gtk.symbols.gtk_init(null, null);

  const win = gtk.symbols.gtk_window_new(0);
  gtk.symbols.gtk_window_set_title(win, cstr(title));
  gtk.symbols.gtk_window_set_default_size(win, width, height);

  const view = ephemeral
    ? webkit.symbols.webkit_web_view_new_with_context(webkit.symbols.webkit_web_context_new_ephemeral())
    : webkit.symbols.webkit_web_view_new();
  const settings = webkit.symbols.webkit_web_view_get_settings(view);
  webkit.symbols.webkit_settings_set_enable_developer_extras(settings, 1); // right-click → Inspect Element
  gtk.symbols.gtk_container_add(win, view);

  const onDestroy = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer"], result: "void" },
    () => gtk.symbols.gtk_main_quit(),
  );
  const onTitle = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    () => {
      const ptr = webkit.symbols.webkit_web_view_get_title(view);
      const pageTitle = ptr ? Deno.UnsafePointerView.getCString(ptr) : "";
      gtk.symbols.gtk_window_set_title(win, cstr(pageTitle || title));
    },
  );
  // The window is shown only once the page is styled and its script runs
  // ("ready"). Mapped earlier, it shows a buffer WebKit hasn't drawn yet (noise
  // on NVIDIA), then a white page and a black frame at the redirect. The folder
  // itself renders a few ms later, while the compositor's open animation runs.
  let shown = false;
  const show = (why) => {
    if (shown) return;
    shown = true;
    trace(`window shown (${why})`);
    gtk.symbols.gtk_widget_show_all(win);
  };
  const onShowTimeout = new Deno.UnsafeCallback({ parameters: ["pointer"], result: "i32" }, () => {
    show("timeout");
    return 0;
  });

  // Messages from the page: window.webkit.messageHandlers.phil.postMessage(...)
  //   "ready[:timings]"  page styled and running
  //   "close"            the close button (scripts may not window.close() a window they didn't open)
  const onMessage = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    (_manager, result) => {
      const str = jsc.symbols.jsc_value_to_string(webkit.symbols.webkit_javascript_result_get_js_value(result));
      const message = str ? Deno.UnsafePointerView.getCString(str) : "";
      glib.symbols.g_free(str);
      if (message === "close") gtk.symbols.gtk_widget_destroy(win);
      else if (message.startsWith("ready")) {
        if (message.length > 6) trace(`page ready ${message.slice(6)}`);
        show("page ready");
      }
    },
  );
  const contentManager = webkit.symbols.webkit_web_view_get_user_content_manager(view);
  webkit.symbols.webkit_user_content_manager_register_script_message_handler(contentManager, cstr("phil"));
  gobject.symbols.g_signal_connect_data(contentManager, cstr("script-message-received::phil"), onMessage.pointer, null, null, 0);
  gobject.symbols.g_signal_connect_data(win, cstr("destroy"), onDestroy.pointer, null, null, 0);
  gobject.symbols.g_signal_connect_data(view, cstr("notify::title"), onTitle.pointer, null, null, 0);

  trace("window created");

  return {
    run(url) {
      webkit.symbols.webkit_web_view_load_uri(view, cstr(url));
      trace("loading page");
      glib.symbols.g_timeout_add(SHOW_TIMEOUT_MS, onShowTimeout.pointer, null);
      gtk.symbols.gtk_main();

      onDestroy.close();
      onTitle.close();
      onMessage.close();
      onShowTimeout.close();
    },
  };
}
