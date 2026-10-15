// mediaview's command line and window URL (engine/apps.js).
export const appId = "mediaview";

const HELP = `mediaview — your movies and TV shows

Usage: mediaview [--incognito]

The movies and TV shows in the folders marked as media folders (a folder's
Properties in phil: "A media folder"), from all of them in one place, matched
with IMDb's titles and ratings on this computer: as pictures or a list, what's
been started first, a show's every episode. Plays them in videoplayer. In
phil: the sidebar's Media. Runs on phil-engine, like phil; see
\`phil-engine --help\` for the engine options (--browser, --standalone,
--quit, --retire).
`;

export function parse(args) {
  if (args.some((a) => a === "-h" || a === "--help")) return { help: HELP };
  const incognito = args.includes("--incognito") || Deno.env.get("PHIL_INCOGNITO") === "1";
  const unknown = args.find((a) => a !== "--incognito");
  if (unknown) throw new Error(unknown.startsWith("-") ? `Unknown option ${unknown}` : "mediaview takes no files: it shows the media folders");
  return { open: {}, profile: incognito ? { incognito: true } : undefined };
}

export function windowUrl(base) {
  return base;
}
