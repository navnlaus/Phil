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
  webkit_settings_set_enable_developer_extras: { parameters: ["pointer", "i32"], result: "void" },
});

const cstr = (s) => new TextEncoder().encode(s + "\0");

/** `ephemeral`: a private WebKit session that writes nothing to disk (no cache, cookies, storage). */
export function openWindow({ title, url, width, height, ephemeral = false }) {
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
  // The page's close button: window.webkit.messageHandlers.phil.postMessage("close").
  // (Scripts may not window.close() a window they didn't open.)
  const onMessage = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    () => gtk.symbols.gtk_widget_destroy(win),
  );
  const contentManager = webkit.symbols.webkit_web_view_get_user_content_manager(view);
  webkit.symbols.webkit_user_content_manager_register_script_message_handler(contentManager, cstr("phil"));
  gobject.symbols.g_signal_connect_data(contentManager, cstr("script-message-received::phil"), onMessage.pointer, null, null, 0);
  gobject.symbols.g_signal_connect_data(win, cstr("destroy"), onDestroy.pointer, null, null, 0);
  gobject.symbols.g_signal_connect_data(view, cstr("notify::title"), onTitle.pointer, null, null, 0);

  webkit.symbols.webkit_web_view_load_uri(view, cstr(url));
  gtk.symbols.gtk_widget_show_all(win);
  gtk.symbols.gtk_main();

  onDestroy.close();
  onTitle.close();
  onMessage.close();
}
