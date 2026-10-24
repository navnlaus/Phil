// musicview's command line and window URL (engine/apps.js).
export const appId = "musicview";

const HELP = `musicview — your music, and radio

Usage: musicview [--incognito]          the window
       musicview COMMAND                the player: play, pause, toggle, next,
                                        previous (prev), stop, status
       musicview --album NAME           play an album (its songs in order)
       musicview --artist NAME          play an artist's songs
       musicview --genre NAME           play a genre's songs
       musicview --song NAME            play a song
       musicview --station NAME         play a radio station (its name, or its
                                        id: groovesalad, somafm:dronezone...)
       musicview --volume N             the volume, 0 to 100 (with any of these)
       musicview --shuffle | --no-shuffle  shuffle on or off (with any of these)

The songs in the folders marked as music (a folder's Properties in phil: "A
music folder"), every one in them and their subfolders, by their tags: albums
with their covers, artists, songs, genres, all in one place. And radio
stations, SomaFM's among them, and any added by their address. In phil: the
sidebar's Music & radio. NAME is matched as typed, then by its start, then
anywhere in it (any case).

The player is the engine's: it plays on with every window closed, and the
commands start the engine (no window) if it isn't running. The media keys
work too, through mpv's MPRIS script where it's installed. Runs on
phil-engine, like phil; see \`phil-engine --help\` for the engine options
(--browser, --standalone, --quit, --retire).
`;

const COMMANDS = { play: "play", pause: "pause", toggle: "toggle", next: "next", previous: "previous", prev: "previous", stop: "stop", status: "status" };
const NAMED = ["--album", "--artist", "--genre", "--song", "--station"];

export function parse(args) {
  if (args.some((a) => a === "-h" || a === "--help")) return { help: HELP };
  const incognito = args.includes("--incognito") || Deno.env.get("PHIL_INCOGNITO") === "1";
  const profile = incognito ? { incognito: true } : undefined;
  const player = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--incognito") continue;
    if (COMMANDS[a]) player.cmd = COMMANDS[a];
    else if (NAMED.includes(a) || a === "--volume") {
      const value = args[++i];
      if (value === undefined) throw new Error(`${a} needs a value`);
      if (a === "--volume" && !/^\d{1,3}$/.test(value)) throw new Error("--volume: 0 to 100");
      player[a.slice(2)] = a === "--volume" ? Number(value) : value;
    } else if (a === "--shuffle" || a === "--no-shuffle") player.shuffle = a === "--shuffle";
    else throw new Error(a.startsWith("-") ? `Unknown option ${a}` : `Unknown command ${a} (musicview --help)`);
  }
  if (Object.keys(player).length) return { profile, control: { to: "musicview", player } };
  return { open: {}, profile };
}

export function windowUrl(base) {
  return base;
}
