import { dirname, join, resolve } from "@std/path";

export const HELP = `phil — a small media-oriented file manager

Usage: phil [options] [directory | file...]

Without a directory, phil opens the folder it was showing when it last closed.
Given files, it opens their folder with them selected.

phil keeps running in the background after its last window closes, so new
windows open quickly: \`phil ...\` hands the request to the running phil.
Incognito windows get their own phil, which exits with its last window.

Options:
  --thumb-dir PATH   Where this process stores thumbnails
                     (env PHIL_THUMB_DIR, default $XDG_CACHE_HOME/phil/thumbnails)
  --thumb-size N     Thumbnail width in pixels; thumbnails are 16:9 crops
                     (env PHIL_THUMB_SIZE, default 384)
  --jobs N           Max parallel thumbnail jobs (default: CPU count)
  --port N           Port for the local UI server (default: random)
  --incognito        Leave no traces: don't remember the folder or settings,
                     don't save the terminal's bash history, keep thumbnails in a
                     .thumbnails folder inside each folder instead of the cache
                     (unless --thumb-dir is given), no WebKit disk cache
  --browser          Don't open a window; print the URL to open in a browser
  --standalone       Don't use or become the background phil: a process of its
                     own that exits when its window closes (handy for development)
  --quit             Stop the background phil (with --incognito: the incognito one)
  --retire           Ask every running phil to stop taking new windows and exit once
                     its windows are closed, so the next launch runs a new build
  --file-manager-service
                     Run the org.freedesktop.FileManager1 D-Bus service that
                     "Show in folder" uses; started by D-Bus, see scripts/install.sh
  -h, --help         Show this help

Long options can be shortened to any unique prefix, e.g. --incog.
`;

// name -> takes a value?
const OPTIONS = {
  "--thumb-dir": true,
  "--thumb-size": true,
  "--jobs": true,
  "--port": true,
  "--incognito": false,
  "--browser": false,
  "--standalone": false,
  "--quit": false,
  "--retire": false,
  "--file-manager-service": false,
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

export function parseConfig(args) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    if (arg === "-h") return { help: true };
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
    if (name === "--help") return { help: true };
    if (OPTIONS[name]) {
      value ??= args[++i];
      if (value === undefined) throw new Error(`${name} needs a value`);
    } else if (value !== undefined) {
      throw new Error(`${name} doesn't take a value`);
    }
    opts[name.slice(2)] = value ?? true;
  }

  const cacheHome = env("XDG_CACHE_HOME") ?? join(home(), ".cache");
  const configHome = env("XDG_CONFIG_HOME") ?? join(home(), ".config");
  const stateHome = env("XDG_STATE_HOME") ?? join(home(), ".local", "state");
  const incognito = !!opts.incognito;
  const thumbDir = opts["thumb-dir"] ?? env("PHIL_THUMB_DIR");
  // A folder to open, or files to show selected in their folder.
  const paths = positional.map((p) => resolve(p));
  const isFile = (p) => {
    try {
      return !Deno.statSync(p).isDirectory;
    } catch {
      return false;
    }
  };
  const startDir = paths.length && isFile(paths[0]) ? dirname(paths[0]) : paths[0] ?? Deno.cwd();
  return {
    browser: !!opts.browser,
    standalone: !!opts.standalone,
    quit: !!opts.quit,
    retire: !!opts.retire,
    fileManagerService: !!opts["file-manager-service"],
    // Options that make a separate instance (see instance.js).
    thumbDirOption: thumbDir ? resolve(thumbDir) : undefined,
    thumbSizeOption: opts["thumb-size"] ?? env("PHIL_THUMB_SIZE"),
    jobsOption: opts.jobs,
    portOption: opts.port,
    incognito,
    startDir,
    startDirGiven: paths.length > 0,
    select: paths.filter((p) => dirname(p) === startDir && isFile(p)),
    // null: per-folder .thumbnails (incognito without an explicit thumbnail dir)
    thumbDir: thumbDir ? resolve(thumbDir) : incognito ? null : join(cacheHome, "phil", "thumbnails"),
    // incognito: thumbnails for folders that can't hold a .thumbnails folder; deleted on exit
    scratchDir: join(env("XDG_RUNTIME_DIR") ?? "/tmp", `phil-incognito-${Deno.pid}`),
    thumbSize: positiveInt("thumb size", opts["thumb-size"] ?? env("PHIL_THUMB_SIZE") ?? 384),
    jobs: positiveInt("jobs", opts.jobs ?? navigator.hardwareConcurrency ?? 4),
    port: opts.port === undefined ? 0 : positiveInt("port", opts.port),
    settingsFile: join(configHome, "phil", "settings.json"),
    stateFile: join(stateHome, "phil", "state.json"),
  };
}

function positiveInt(name, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${name}: ${value}`);
  return n;
}
