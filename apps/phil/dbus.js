// org.freedesktop.FileManager1 over GDBus (FFI), so "Show in folder" in
// browsers, file pickers and portals opens phil. D-Bus starts this on demand
// (data/org.freedesktop.FileManager1.service, installed by scripts/install.sh);
// every request launches a phil window, and the service exits when idle.
// Interface: https://www.freedesktop.org/wiki/Specifications/file-manager-interface/

import { dirname } from "@std/path";
import { engineCommand } from "../../engine/instance.js";

const NAME = "org.freedesktop.FileManager1";
const OBJECT_PATH = "/org/freedesktop/FileManager1";
const IDLE_EXIT_SECONDS = 600;
const G_BUS_TYPE_SESSION = 2;

const INTROSPECTION = `<node>
  <interface name="${NAME}">
    <method name="ShowFolders"><arg type="as" name="URIs" direction="in"/><arg type="s" name="StartupId" direction="in"/></method>
    <method name="ShowItems"><arg type="as" name="URIs" direction="in"/><arg type="s" name="StartupId" direction="in"/></method>
    <method name="ShowItemProperties"><arg type="as" name="URIs" direction="in"/><arg type="s" name="StartupId" direction="in"/></method>
  </interface>
</node>`;

const glib = Deno.dlopen("libglib-2.0.so.0", {
  g_main_loop_new: { parameters: ["pointer", "i32"], result: "pointer" },
  g_main_loop_run: { parameters: ["pointer"], result: "void" },
  g_main_loop_quit: { parameters: ["pointer"], result: "void" },
  g_timeout_add_seconds: { parameters: ["u32", "function", "pointer"], result: "u32" },
  g_variant_n_children: { parameters: ["pointer"], result: "usize" },
  g_variant_get_child_value: { parameters: ["pointer", "usize"], result: "pointer" },
  g_variant_get_string: { parameters: ["pointer", "pointer"], result: "pointer" },
  g_variant_unref: { parameters: ["pointer"], result: "void" },
});
const gio = Deno.dlopen("libgio-2.0.so.0", {
  g_bus_get_sync: { parameters: ["i32", "pointer", "pointer"], result: "pointer" },
  g_dbus_node_info_new_for_xml: { parameters: ["buffer", "pointer"], result: "pointer" },
  g_dbus_node_info_lookup_interface: { parameters: ["pointer", "buffer"], result: "pointer" },
  g_dbus_connection_register_object: {
    parameters: ["pointer", "buffer", "pointer", "buffer", "pointer", "pointer", "pointer"],
    result: "u32",
  },
  g_bus_own_name_on_connection: {
    parameters: ["pointer", "buffer", "i32", "function", "function", "pointer", "pointer"],
    result: "u32",
  },
  g_dbus_method_invocation_return_value: { parameters: ["pointer", "pointer"], result: "void" },
});

const cstr = (s) => new TextEncoder().encode(s + "\0");
const readCString = (ptr) => (ptr ? Deno.UnsafePointerView.getCString(ptr) : "");

function variantString(v) {
  return readCString(glib.symbols.g_variant_get_string(v, null));
}

function variantStrings(v) {
  const out = [];
  for (let i = 0n; i < BigInt(glib.symbols.g_variant_n_children(v)); i++) {
    const child = glib.symbols.g_variant_get_child_value(v, i);
    out.push(variantString(child));
    glib.symbols.g_variant_unref(child);
  }
  return out;
}

function localPath(uri) {
  try {
    const url = new URL(uri);
    return url.protocol === "file:" ? decodeURIComponent(url.pathname) : null;
  } catch {
    return uri.startsWith("/") ? uri : null;
  }
}

function launch(args, startupId) {
  const [cmd, ...base] = [...engineCommand(), "phil"];
  const env = startupId ? { DESKTOP_STARTUP_ID: startupId, XDG_ACTIVATION_TOKEN: startupId } : {};
  try {
    new Deno.Command(cmd, { args: [...base, ...args], env, stdin: "null", stdout: "null", stderr: "null" }).spawn();
  } catch (err) {
    console.error(`phil: couldn't launch phil: ${err.message}`);
  }
}

function handle(method, uris, startupId) {
  const paths = uris.map(localPath).filter(Boolean);
  if (method === "ShowFolders") {
    for (const path of paths) launch([path], startupId);
    return;
  }
  // ShowItems / ShowItemProperties: one window per folder, with its items selected.
  const byFolder = Map.groupBy(paths, (p) => dirname(p));
  for (const items of byFolder.values()) launch(items, startupId);
}

export function runFileManagerService() {
  const connection = gio.symbols.g_bus_get_sync(G_BUS_TYPE_SESSION, null, null);
  if (!connection) throw new Error("no session bus");
  const node = gio.symbols.g_dbus_node_info_new_for_xml(cstr(INTROSPECTION), null);
  const iface = gio.symbols.g_dbus_node_info_lookup_interface(node, cstr(NAME));
  const loop = glib.symbols.g_main_loop_new(null, 0);
  let lastCall = Date.now();

  const onMethodCall = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer", "pointer", "pointer", "pointer", "pointer", "pointer"], result: "void" },
    (_conn, _sender, _path, _iface, methodPtr, params, invocation) => {
      lastCall = Date.now();
      const uris = glib.symbols.g_variant_get_child_value(params, 0n);
      const startup = glib.symbols.g_variant_get_child_value(params, 1n);
      handle(readCString(methodPtr), variantStrings(uris), variantString(startup));
      glib.symbols.g_variant_unref(uris);
      glib.symbols.g_variant_unref(startup);
      gio.symbols.g_dbus_method_invocation_return_value(invocation, null);
    },
  );
  // Someone else (e.g. a running Nautilus) has the name: nothing to do.
  const onNameLost = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    () => glib.symbols.g_main_loop_quit(loop),
  );
  const onIdleCheck = new Deno.UnsafeCallback({ parameters: ["pointer"], result: "i32" }, () => {
    if (Date.now() - lastCall < IDLE_EXIT_SECONDS * 1000) return 1;
    glib.symbols.g_main_loop_quit(loop);
    return 0;
  });

  // GDBusInterfaceVTable: method_call, get_property, set_property, padding[8].
  const vtable = new BigUint64Array(11);
  vtable[0] = BigInt(Deno.UnsafePointer.value(onMethodCall.pointer));
  gio.symbols.g_dbus_connection_register_object(connection, cstr(OBJECT_PATH), iface, new Uint8Array(vtable.buffer), null, null, null);
  gio.symbols.g_bus_own_name_on_connection(connection, cstr(NAME), 0, null, onNameLost.pointer, null, null);
  glib.symbols.g_timeout_add_seconds(60, onIdleCheck.pointer, null);
  glib.symbols.g_main_loop_run(loop);
}
