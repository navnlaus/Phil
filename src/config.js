import { join, resolve } from "@std/path";

export const HELP = `phil — a small media-oriented file manager

Usage: phil [options] [directory]

Options:
  --thumb-dir PATH   Where this process stores thumbnails
                     (env PHIL_THUMB_DIR, default $XDG_CACHE_HOME/phil/thumbnails)
  --thumb-size N     Thumbnail width in pixels; thumbnails are 16:9 crops
                     (env PHIL_THUMB_SIZE, default 384)
  --jobs N           Max parallel thumbnail jobs (default: CPU count)
  --port N           Port for the local UI server (default: random)
  --browser          Don't open a window; print the URL to open in a browser
  -h, --help         Show this help
`;

const env = (name) => Deno.env.get(name) || undefined;

export function home() {
  return env("HOME") ?? "/";
}

export function parseConfig(args) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--browser") {
      opts.browser = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    let value;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    } else {
      value = args[++i];
    }
    if (value === undefined) throw new Error(`${arg} needs a value`);
    const key = { "--thumb-dir": "thumbDir", "--thumb-size": "thumbSize", "--jobs": "jobs", "--port": "port" }[arg];
    if (!key) throw new Error(`Unknown option ${arg}`);
    opts[key] = value;
  }

  const cacheHome = env("XDG_CACHE_HOME") ?? join(home(), ".cache");
  const configHome = env("XDG_CONFIG_HOME") ?? join(home(), ".config");
  return {
    browser: !!opts.browser,
    startDir: resolve(positional[0] ?? Deno.cwd()),
    thumbDir: resolve(opts.thumbDir ?? env("PHIL_THUMB_DIR") ?? join(cacheHome, "phil", "thumbnails")),
    thumbSize: positiveInt("thumb size", opts.thumbSize ?? env("PHIL_THUMB_SIZE") ?? 384),
    jobs: positiveInt("jobs", opts.jobs ?? navigator.hardwareConcurrency ?? 4),
    port: opts.port === undefined ? 0 : positiveInt("port", opts.port),
    settingsFile: join(configHome, "phil", "settings.json"),
  };
}

function positiveInt(name, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${name}: ${value}`);
  return n;
}
