// Themes: the stylesheets every app's pages share (base.css: colors, controls,
// bars) and phil's tile themes (overlay.css, strip.css, ...) live in
// ~/.config/phil/themes ($XDG_CONFIG_HOME), where they can be edited: every
// open page picks up an edit right away (GET /engine/styles, an event stream
// kit.js listens to). A file there takes the place of the built-in one of its
// name; one that isn't built in is a theme of its own (phil's "theme"
// setting is its name).
//
// The built-in ones (the repository's themes/) are copied there when phil is
// installed (`phil-engine --install-themes`, from scripts/install.sh), and
// copies that haven't been edited follow new builds: .builtin.json remembers
// what was copied. Until then, or for a file not there, the built-in one is
// served.
import { join } from "@std/path";
import { staticFile, text } from "./http.js";

const BUILTIN = new URL("../themes/", import.meta.url);
const BUILTIN_FILES = ["base.css", "overlay.css", "strip.css", "below.css", "chips.css"];
const encoder = new TextEncoder();

const configHome = () => Deno.env.get("XDG_CONFIG_HOME") ?? join(Deno.env.get("HOME") ?? "/", ".config");
/** Where the themes are. */
export const themesDir = () => join(configHome(), "phil", "themes");

const listeners = new Set(); // the event streams' controllers

/** At the engine's start: watches the themes, telling pages when one changes. */
export function watchThemes() {
  watch(themesDir());
}

/**
 * Copies the built-in themes to the themes folder: new ones, and new
 * versions of copies nobody edited. Resolves to {copied, updated, kept}
 * (file names; kept: edited, so left alone).
 */
export async function installThemes() {
  const dir = themesDir();
  const report = { copied: [], updated: [], kept: [] };
  await Deno.mkdir(dir, { recursive: true });
  const recordFile = join(dir, ".builtin.json");
  const record = await Deno.readTextFile(recordFile).then(JSON.parse, () => ({})); // name -> hash of the copy made
  let changed = false;
  for (const name of BUILTIN_FILES) {
    const builtin = await Deno.readFile(new URL(name, BUILTIN));
    const theirs = await Deno.readFile(join(dir, name)).catch(() => null);
    const builtinHash = await hash(builtin);
    if (theirs && record[name] !== await hash(theirs)) { // edited (or theirs from the start)
      if (record[name] !== builtinHash && await hash(theirs) !== builtinHash) report.kept.push(name); // a newer built-in one they don't get
      continue;
    }
    if (theirs && record[name] === builtinHash) continue; // up to date
    if (!theirs && name in record) continue; // deleted on purpose: the built-in one is used
    await Deno.writeFile(join(dir, name), builtin);
    (theirs ? report.updated : report.copied).push(name);
    record[name] = builtinHash;
    changed = true;
  }
  if (changed) await Deno.writeTextFile(recordFile, JSON.stringify(record, null, 2) + "\n");
  return report;
}

async function hash(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** GET /themes/<name>: the one in the themes folder, or the built-in one. */
export async function themeFile(name) {
  if (!/^[\w-]+\.css$/.test(name)) return text(404, "Not found");
  const res = await staticFile(new URL(`file://${encodeURI(themesDir())}/`), name);
  return res.ok ? res : await staticFile(BUILTIN, name);
}

/** GET /engine/styles: "changed" whenever a theme's file does. */
export function themeEvents() {
  let me;
  const body = new ReadableStream({
    start(controller) {
      me = controller;
      listeners.add(controller);
      controller.enqueue(encoder.encode(": watching the themes\n\n"));
    },
    cancel() {
      listeners.delete(me);
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

async function watch(dir) {
  let timer = null;
  try {
    for await (const event of Deno.watchFs(dir, { recursive: false })) {
      if (event.kind === "access" || !event.paths.some((p) => p.endsWith(".css"))) continue;
      clearTimeout(timer);
      timer = setTimeout(() => { // an editor's save is several events
        for (const controller of listeners) {
          try {
            controller.enqueue(encoder.encode("data: changed\n\n"));
          } catch {
            listeners.delete(controller); // that page is gone
          }
        }
      }, 120);
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) console.error(`phil-engine: can't watch ${dir}: ${err.message}`);
  }
}
