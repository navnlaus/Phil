// musicview's command line and window URL (engine/apps.js).
export const appId = "musicview";

const HELP = `musicview — your music, and radio

Usage: musicview [--incognito]

The songs in the folders marked as music (a folder's Properties in phil: "A
music folder"), every one in them and their subfolders, by their tags: albums
with their covers, artists, songs, genres, all in one place; played here, with
a queue. And radio stations, SomaFM's among them, and any added by their
address. In phil: the sidebar's Music & radio. Runs on phil-engine, like phil;
see \`phil-engine --help\` for the engine options (--browser, --standalone,
--quit, --retire).
`;

export function parse(args) {
  if (args.some((a) => a === "-h" || a === "--help")) return { help: HELP };
  const incognito = args.includes("--incognito") || Deno.env.get("PHIL_INCOGNITO") === "1";
  const unknown = args.find((a) => a !== "--incognito");
  if (unknown) throw new Error(unknown.startsWith("-") ? `Unknown option ${unknown}` : "musicview takes no files: it shows the music folders");
  return { open: {}, profile: incognito ? { incognito: true } : undefined };
}

export function windowUrl(base) {
  return base;
}
