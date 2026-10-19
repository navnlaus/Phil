// phil's command line and window URL (engine/apps.js), and its server's settings.
import { dirname, join, resolve } from "@std/path";

export const appId = "phil";

export const HELP = `phil — a small media-oriented file manager

Usage: phil [options] [directory | file...]

Without a directory, phil opens the folder it was showing when it last closed.
Given files, it opens their folder with them selected.

phil runs on phil-engine, which keeps running in the background so windows
open quickly; the first app to run starts it. Incognito windows get an engine
of their own, which exits with its last window.

Options:
  --thumb-dir PATH   Where thumbnails are stored
                     (env PHIL_THUMB_DIR, default $XDG_CACHE_HOME/phil/thumbnails)
  --thumb-size N     Thumbnail width in pixels; thumbnails are 16:9 crops
                     (env PHIL_THUMB_SIZE, default 384)
  --jobs N           Max parallel thumbnail jobs (default: CPU count)
  --port N           Port for phil's local server (default: random)
  --incognito        Leave no traces: don't remember the folder or settings,
                     don't save the terminal's bash history, keep thumbnails and
                     other caches in memory only (unless --thumb-dir is given),
                     a throwaway browser profile (no disk cache or cookies kept)
  --choose MODE      A file chooser (an app's Open or Save dialog, through
                     xdg-desktop-portal-termfilechooser): MODE is open (a file),
                     dir (a folder) or save (a file's name and folder); with
                     --multiple, more than one; --out FILE gets the chosen
                     paths, one per line (nothing: cancelled). The path given
                     is where to start (to save: the suggested file). Waits
                     until the choice is made, or the window closed.
  --terminal         The terminal covering the window, the keyboard in it
                     (Esc at its prompt, or Ctrl+F: the folder)
  --multiple         (--choose) More than one may be chosen
  --out FILE         (--choose) Where the chosen paths are written
  --file-manager-service
                     Run the org.freedesktop.FileManager1 D-Bus service that
                     "Show in folder" uses; started by D-Bus, see scripts/install.sh
  -h, --help         Show this help

The first four (and --incognito) run a separate engine when not the default.
Long options can be shortened to any unique prefix, e.g. --incog.

Engine options, for every app (exact names):
  --browser          Don't open a window; print the URL to open in a browser
  --standalone       Don't use or start the background engine: a process of its
                     own that exits when its window closes (handy for development)
  --quit             Stop the background engine (with --incognito: that one)
  --retire           Ask every running engine to stop taking new windows and exit
                     once its windows are closed, so the next launch runs a new build
`;

// name -> takes a value?
const OPTIONS = {
  "--thumb-dir": true,
  "--thumb-size": true,
  "--jobs": true,
  "--port": true,
  "--incognito": false,
  "--choose": true,
  "--multiple": false,
  "--out": true,
  "--file-manager-service": false,
  "--terminal": false,
  "--help": false,
};

const env = (name) => Deno.env.get(name) || undefined;

export function home() {
  return env("HOME") ?? "/";
}

function longOption(arg) {
  if (arg in OPTIONS) return arg;
  const matches = Object.keys(OPTIONS).filter((name) => name.startsWith(arg));
  if (matches.length === 1) return matches[0];
  throw new Error(matches.length ? `Ambiguous option ${arg} (${matches.join(", ")})` : `Unknown option ${arg}`);
}

/** phil's command line: which engine (`profile`) and what window (`open`). */
export function parse(args, { cwd }) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    if (arg === "-h") return { help: HELP };
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    let value;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const name = longOption(arg);
    if (name === "--help") return { help: HELP };
    if (OPTIONS[name]) {
      value ??= args[++i];
      if (value === undefined) throw new Error(`${name} needs a value`);
    } else if (value !== undefined) {
      throw new Error(`${name} doesn't take a value`);
    }
    opts[name.slice(2)] = value ?? true;
  }
  if (opts["file-manager-service"]) {
    return { run: async () => (await import("./dbus.js")).runFileManagerService() };
  }

  const thumbDir = opts["thumb-dir"] ?? env("PHIL_THUMB_DIR");
  const thumbSize = opts["thumb-size"] ?? env("PHIL_THUMB_SIZE");
  // Non-default values make an engine of their own (see engine/instance.js).
  const profile = {
    incognito: opts.incognito ? true : undefined,
    thumbDir: thumbDir ? resolve(cwd, thumbDir) : undefined,
    thumbSize: thumbSize === undefined ? undefined : positiveInt("thumb size", thumbSize),
    jobs: opts.jobs === undefined ? undefined : positiveInt("jobs", opts.jobs),
    port: opts.port === undefined ? undefined : positiveInt("port", opts.port),
  };

  // A file chooser: the window, then waiting for the choice (phil's server writes
  // <out>, then <out>.done: when it's chosen, cancelled, or the window closed).
  if (opts.choose !== undefined) {
    if (!["open", "dir", "save"].includes(opts.choose)) throw new Error("--choose: open, dir or save");
    if (!opts.out) throw new Error("--choose needs --out FILE");
    const out = resolve(cwd, opts.out);
    const start = positional[0] ? resolve(cwd, positional[0]) : home();
    let dir = start, name = "";
    const stat = (() => {
      try {
        return Deno.statSync(start);
      } catch {
        return null;
      }
    })();
    if (opts.choose === "save" ? !stat?.isDirectory : stat && !stat.isDirectory) (dir = dirname(start)), (name = start.slice(dir.length + 1));
    try {
      if (!Deno.statSync(dir).isDirectory) dir = home();
    } catch {
      dir = home();
    }
    try {
      Deno.removeSync(`${out}.done`); // (none, usually)
    } catch { /* none */ }
    return {
      profile,
      // (variant: its window's class gets "-choose", for window rules: a dialog, floating)
      open: { dir, select: [], variant: "choose", choose: { mode: opts.choose, multiple: !!opts.multiple, out, name } },
      async waitFor() {
        for (;;) {
          try {
            Deno.statSync(`${out}.done`);
            Deno.removeSync(`${out}.done`);
            return;
          } catch { /* not yet */ }
          await new Promise((r) => setTimeout(r, 150));
        }
      },
    };
  }

  // A folder to open, or files to show selected in their folder.
  const paths = positional.map((p) => resolve(cwd, p));
  const isFile = (p) => {
    try {
      return !Deno.statSync(p).isDirectory;
    } catch {
      return false;
    }
  };
  const dir = paths.length && isFile(paths[0]) ? dirname(paths[0]) : paths[0] ?? null;
  return { profile, open: { dir, select: paths.filter((p) => dirname(p) === dir && isFile(p)), ...(opts.terminal ? { terminal: true } : {}) } };
}

/** The page URL: files to select in ?select=, the folder in the fragment. */
export function windowUrl(base, { dir, select = [], choose = null, transfer = null, terminal = false }) {
  for (const path of select) base.searchParams.append("select", path);
  if (terminal) base.searchParams.set("terminal", "1"); // (--terminal: the terminal covering the window)
  if (transfer) base.searchParams.set("transfer", transfer); // the Transfers view, that one in view (mediaview's)
  if (choose) { // a file chooser (--choose): what's asked, and where the answer goes
    base.searchParams.set("choose", choose.mode);
    if (choose.multiple) base.searchParams.set("multiple", "1");
    base.searchParams.set("out", choose.out);
    if (choose.name) base.searchParams.set("name", choose.name);
  }
  if (dir) base.hash = dir.split("/").map(encodeURIComponent).join("/");
  return base;
}

// Incognito's thumbnails: in memory ($XDG_RUNTIME_DIR and /dev/shm are tmpfs),
// deleted on exit.
const scratchDir = () => join(env("XDG_RUNTIME_DIR") ?? "/dev/shm", `phil-incognito-${Deno.pid}`);

export function cleanUp(profile) {
  if (!profile.incognito) return;
  try {
    Deno.removeSync(scratchDir(), { recursive: true });
  } catch { /* never created */ }
}

/** The server's settings for an engine `profile`, defaults filled in. */
export function serverConfig(profile) {
  const cacheHome = env("XDG_CACHE_HOME") ?? join(home(), ".cache");
  const configHome = env("XDG_CONFIG_HOME") ?? join(home(), ".config");
  const stateHome = env("XDG_STATE_HOME") ?? join(home(), ".local", "state");
  const incognito = !!profile.incognito;
  return {
    incognito,
    thumbDir: profile.thumbDir ?? (incognito ? join(scratchDir(), "thumbnails") : join(cacheHome, "phil", "thumbnails")),
    thumbsInMemory: incognito && !profile.thumbDir,
    cacheThumbDir: profile.thumbDir ?? join(cacheHome, "phil", "thumbnails"), // (incognito's caches: read there, not written)
    thumbSize: profile.thumbSize ?? 384,
    jobs: profile.jobs ?? navigator.hardwareConcurrency ?? 4,
    port: profile.port ?? 0,
    startDir: home(), // the first window's folder when there's no last one
    settingsFile: join(configHome, "phil", "settings.json"),
    stateFile: join(stateHome, "phil", "state.json"),
  };
}

function positiveInt(name, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${name}: ${value}`);
  return n;
}
