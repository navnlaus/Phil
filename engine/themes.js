// Themes: the stylesheets every app's pages share (base.css: colors, controls,
// bars) and the themes (overlay.css, chips.css, ...) live in
// ~/.config/phil/themes ($XDG_CONFIG_HOME), where they can be edited: every
// open page picks up an edit right away (GET /engine/styles, an event stream
// kit.js listens to). A file there takes the place of the built-in one of its
// name; one that isn't built in is a theme of its own. The theme in use is
// phil's "theme" setting (~/.config/phil/settings.json): phil loads it by
// name, the other apps as /themes/current.css, so its colors are theirs too.
//
// The built-in ones (the repository's themes/) are copied there when phil is
// installed (`phil-engine --install-themes`, from scripts/install.sh), and
// copies that haven't been edited follow new builds: .builtin.json remembers
// what was copied. Until then, or for a file not there, the built-in one is
// served.
import { join } from "@std/path";
import { staticFile, text } from "./http.js";

const BUILTIN = new URL("../themes/", import.meta.url);
const BUILTIN_FILES = ["base.css", "overlay.css", "chips.css"];
const DEFAULT_THEME = "overlay";
const encoder = new TextEncoder();

const configHome = () => Deno.env.get("XDG_CONFIG_HOME") ?? join(Deno.env.get("HOME") ?? "/", ".config");
/** Where the themes are. */
export const themesDir = () => join(configHome(), "phil", "themes");
const settingsFile = () => join(configHome(), "phil", "settings.json");

const listeners = new Set(); // the event streams' controllers

/**
 * At the engine's start: watches the themes, and which one is in use, telling
 * pages when either changes.
 */
export function watchThemes() {
  watch(themesDir(), (paths) => paths.some((p) => p.endsWith(".css")));
  let inUse = null;
  currentTheme().then((t) => (inUse = t));
  watch(join(configHome(), "phil"), async (paths) => { // phil's settings: another theme picked?
    if (!paths.includes(settingsFile())) return false;
    const now = await currentTheme();
    return now !== inUse && ((inUse = now), true);
  });
}

/** The theme in use: phil's setting, if there's such a theme; else the default. */
export async function currentTheme() {
  const name = await Deno.readTextFile(settingsFile()).then((s) => JSON.parse(s).theme, () => null);
  return typeof name === "string" && (await themeNames()).includes(name) ? name : DEFAULT_THEME;
}

/**
 * Copies the built-in themes to the themes folder: new ones, and new
 * versions of copies nobody edited; copies of ones no longer built in go,
 * unless edited. Resolves to {copied, updated, removed, kept} (file names;
 * kept: edited, so left alone).
 */
export async function installThemes() {
  const dir = themesDir();
  const report = { copied: [], updated: [], removed: [], kept: [] };
  await Deno.mkdir(dir, { recursive: true });
  const recordFile = join(dir, ".builtin.json");
  const record = await Deno.readTextFile(recordFile).then(JSON.parse, () => ({})); // name -> hash of the copy made
  let changed = false;
  for (const name of BUILTIN_FILES) {
    const builtin = await Deno.readFile(new URL(name, BUILTIN));
    const theirs = await Deno.readFile(join(dir, name)).catch(() => null);
    const builtinHash = await hash(builtin);
    if (theirs && await hash(theirs) === builtinHash) { // the same as this build's: it follows the next ones
      if (record[name] !== builtinHash) (record[name] = builtinHash), (changed = true);
      continue;
    }
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
  for (const name of Object.keys(record).filter((n) => !BUILTIN_FILES.includes(n))) { // no longer built in
    const theirs = await Deno.readFile(join(dir, name)).catch(() => null);
    if (theirs && await hash(theirs) === record[name]) {
      await Deno.remove(join(dir, name));
      report.removed.push(name);
    } // edited: theirs now
    delete record[name];
    changed = true;
  }
  if (changed) await Deno.writeTextFile(recordFile, JSON.stringify(record, null, 2) + "\n");
  return report;
}

async function hash(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The themes' names (phil's tile themes: every stylesheet but base.css), sorted. */
export async function themeNames() {
  const names = new Set(BUILTIN_FILES.filter((f) => f !== "base.css").map((f) => f.slice(0, -4)));
  try {
    for await (const e of Deno.readDir(themesDir())) {
      if (e.isFile && /^[\w-]+\.css$/.test(e.name) && e.name !== "base.css") names.add(e.name.slice(0, -4));
    }
  } catch { /* no folder yet: the built-in ones */ }
  return [...names].sort();
}

/**
 * GET /themes/<name>: the one in the themes folder, or the built-in one.
 * current.css: the theme in use.
 */
export async function themeFile(name) {
  if (name === "current.css") name = `${await currentTheme()}.css`;
  if (!/^[\w-]+\.css$/.test(name)) return text(404, "Not found");
  const res = await staticFile(new URL(`file://${encodeURI(themesDir())}/`), name);
  return res.ok ? res : await staticFile(BUILTIN, name);
}

/** GET /engine/styles: "changed" whenever a theme's file does, or the theme in use. */
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

// Tells the pages "changed" when `matters(paths)` says an event in `dir` does.
async function watch(dir, matters) {
  let timer = null;
  const paths = new Set(); // since the last time pages were told
  try {
    for await (const event of Deno.watchFs(dir, { recursive: false })) {
      if (event.kind === "access") continue;
      event.paths.forEach((p) => paths.add(p));
      clearTimeout(timer);
      timer = setTimeout(async () => { // an editor's save is several events
        const changed = [...paths];
        paths.clear();
        if (!(await matters(changed))) return;
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
