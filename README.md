# phil

A small file manager for folders full of pictures and videos. The UI is plain
HTML/CSS/JS rendered by the system WebKitGTK; the backend is a few hundred lines
of JavaScript running on Deno. No bundled browser, no npm dependencies.

## Install as the default file manager

```sh
deno task install
```

Builds `phil`, installs it to `~/.local/bin/phil` and makes it the default
file manager. Rerun it after changing the code.

- `~/.local/share/applications/phil.desktop` (with a "New Incognito Window"
  action) and `inode/directory=phil.desktop` in `~/.config/mimeapps.list`:
  folders opened with `xdg-open` and by most apps.
- `~/.local/share/dbus-1/services/org.freedesktop.FileManager1.service`:
  "Show in folder" in Brave/Chromium/Firefox, file pickers and portals goes
  through the [FileManager1](https://www.freedesktop.org/wiki/Specifications/file-manager-interface/)
  D-Bus interface, not the MIME default. The user service file takes
  precedence over Nautilus's, so D-Bus starts `phil --file-manager-service`
  (`src/dbus.js`), which opens a phil window per request with the items
  selected, and exits after 10 idle minutes. While Nautilus is running it
  holds that D-Bus name itself, so those requests go to Nautilus until it quits.

`phil file...` opens the files' folder with them selected.

## Background instance

`phil` keeps running after its last window closes, so later windows open
quickly (no GTK/WebKit startup): a new `phil ...` finds the running one through
`$XDG_RUNTIME_DIR/phil/main.sock`, asks it for a window and exits.

- Incognito windows get their own instance (`incognito.sock`): separate server,
  token and private WebKit session, app id `phil-incognito` and a purple stripe
  along the top. It exits, deleting its temporary thumbnails, with its last
  window. "Show in folder" always goes to the normal instance.
- Non-default `--thumb-dir`, `--thumb-size`, `--jobs` or `--port` make an
  instance of their own, so those options always apply.
- `phil --quit` stops the background phil (`--incognito --quit` the incognito
  one). `deno task install` runs `phil --retire`: running phils keep their
  windows but take no new ones and exit once those close.
- `--standalone` is the old behavior: one process per window, which exits with
  it. `deno task start` uses it, so development runs don't end up in the
  installed background phil.

## Run

```sh
deno task start [options] [directory]
deno task compile          # single ./phil binary (~100 MB, mostly the Deno runtime)
```

Options:

| option | env | default |
|---|---|---|
| `--thumb-dir PATH` | `PHIL_THUMB_DIR` | `$XDG_CACHE_HOME/phil/thumbnails` |
| `--thumb-size N` | `PHIL_THUMB_SIZE` | `384` (width; thumbnails are 16:9 center crops) |
| `--jobs N` | | CPU count |
| `--port N` | | random |
| `--incognito` | | off (see below) |
| `--browser` | | open a native window |

The thumbnail directory is per process, so you can run e.g. one instance with
`--thumb-dir /mnt/photos/.thumbs` for a photo drive and another with the default.
Thumbnails are stored as `<thumb-dir>/<W>x<H>/<hash>.jpg`. The hash covers path,
size and mtime, so edited files get new thumbnails. Clearing the cache means
deleting the folder.

Long options can be shortened to any unique prefix (`--incog`, `--thumb-s 256`).

Started without a folder, phil reopens the folder it showed last (saved in
`$XDG_STATE_HOME/phil/state.json` on every folder change, so it doesn't matter
how phil was closed). A folder argument always wins.

### Incognito

`--incognito` leaves no traces:

- the last folder isn't saved, and settings changes (zoom, sort, terminal
  panel...) last for this session only;
- the terminal's bash still has your existing history, but nothing from this
  session is written to it (`HISTFILE=/dev/null` after your bashrc ran, which
  also covers `history -a` prompt hooks; other recorders like atuin aren't
  covered);
- thumbnails go to a `.thumbnails/<W>x<H>/` folder inside each folder that gets
  any, instead of the shared cache (unless `--thumb-dir` is given). Folders
  that can't be written to use a temporary folder that's deleted on exit;
- WebKit runs a private session: no disk cache, cookies or storage.

Files inside `.thumbnails` folders are shown as their own thumbnails.

### Live updates

The folder you're looking at updates by itself, within about half a second,
whatever changed it: phil, the terminal, a download, another program. Scroll
position, selection and already loaded thumbnails stay. Its subfolders are
watched too (one level down), so a folder tile's counts and previews follow
changes inside it. F5 still reloads by hand.

### Folder tiles

A folder's tile shows what it holds: how many folders and files, the files'
total size (not counting subfolders), and thumbnails of its first four images
or videos in the current sort order. When a folder tile scrolls into view
without that information, or the folder changed since (say a file was deleted
in the terminal), or the view is sorted differently, phil reads the folder in
the background, makes those thumbnails and saves the result. The status bar
counts the folders being read. Summaries live next to the thumbnails
(`<thumb-dir>/<W>x<H>/folders/`); incognito keeps them in memory for the
session.

### Text files

Files that turn out to be text (anything UTF-8 without NUL bytes: notes,
Markdown, JSON, config files, code, CSV, logs...) show their own text on the
tile, scaled to the file: a short one in readable type, a long one smaller to
fit more of it, down to lines drawn as bars. Markdown headings stay large
enough to read even in long documents. Only the start of a file is read (32 KB,
up to 400 lines), when its tile comes into view.

### Themes

How names and details sit on the tiles is a theme, set by hand in
`~/.config/phil/settings.json`:

```json
{ "theme": "overlay", ... }
```

| theme | |
|---|---|
| `overlay` (default) | on the picture, over a shadow fading up from the bottom |
| `strip` | in a solid strip under the picture, each tile a card |
| `below` | centered under rounded pictures, on the page (taller tiles) |
| `chips` | the name in a small chip; details in another, on hover and for the selection |

phil never changes the theme itself (it writes the rest of the file around
it), and open windows pick up an edit right away.

`--browser` prints a URL instead of opening a window. That's handy for using
Chromium's devtools while working on the UI. In the window, right-click on empty
space → Inspect Element works too.

## Requirements

`webkit2gtk-4.1`, `deno`, `libvips` (`vipsthumbnail`, `vips`), `ffmpegthumbnailer`,
and GStreamer plugins for in-app video (`gst-plugins-good`, `gst-libav`). `mpv`
and `xdg-open` are used for "open externally".

## How it works

```
src/main.js     parse options, start the server worker, open the window
src/window.js   GTK3 + WebKitGTK window via Deno FFI (blocks in gtk_main)
src/server.js   127.0.0.1 HTTP server (worker): listing, files with Range, thumbnails
src/thumbs.js   thumbnail cache + LIFO job pool (vipsthumbnail / ffmpegthumbnailer)
src/folders.js  folder summaries for the folder tiles (counts, size, previews)
src/texthead.js the start of text files, drawn on their tiles
src/pty.js      pseudo-terminals via libc FFI (Deno has no PTY API)
src/dbus.js     org.freedesktop.FileManager1 D-Bus service via GDBus FFI
data/, scripts/install.sh  desktop entry, D-Bus service file, installer
src/shell-init.bash  rc file for the terminal panel's bash
ui/             the frontend (ui/vendor: xterm.js 6, MIT)
```

- Thumbnails that are already cached come back as URLs in the directory listing.
  Missing ones are requested over a WebSocket as tiles scroll into view, and
  cancelled when they scroll out. The server generates the most recently requested
  ones first, up to `--jobs` at a time.
- The server only answers requests with the right `Host` header and a session
  cookie, which it sets from a random token in the URL the window opens with.
- On NVIDIA, `__NV_DISABLE_EXPLICIT_SYNC=1` is set automatically. Without it,
  WebKitGTK crashes on Wayland with "Error 71 (Protocol error)". The other common
  fix, `WEBKIT_DISABLE_DMABUF_RENDERER=1`, also works but switches WebKit to CPU
  rendering, which makes scrolling sluggish. The NVDEC hardware video decoders
  are also ranked out (`GST_PLUGIN_FEATURE_RANK`): WebKit's player can't take
  their frames and freezes, so the built-in player decodes in software.
- WebKit's player never loads Matroska files with embedded subtitles; after six
  seconds the viewer says so. Double-click plays videos in mpv anyway.

## Terminal panel

F4 (or Ctrl+`) opens bash in a panel under the grid; drag its top edge to resize.
It is a real terminal (xterm.js on a pseudo-terminal), started with your
`~/.bashrc`, so prompts, aliases, job control and full-screen programs work.

- `cd` in the shell and the file view follows.
- Change folder in the file view while the shell sits at an empty prompt and
  the shell changes directory too, silently: nothing is typed and nothing goes
  into history, the prompt just redraws in place for the new folder. A prompt
  where you typed something and erased it again counts as empty. (phil
  leaves the target in a file and sends an empty Enter; phil's prompt hook does
  a `builtin cd` before your prompt renders, so `cd` wrappers like zoxide aren't
  involved.) If you're in the middle of typing or a command is running, it
  leaves the shell alone.
- Right-click a file → "Paste path in terminal" inserts its quoted path.
- Ctrl+Insert copies the selected text, Shift+Insert pastes; Ctrl+C and Ctrl+V
  stay the shell's. On Omarchy, Super+C / Super+V do the same once Hyprland
  counts phil as a terminal (it sends terminals Ctrl+Insert / Shift+Insert, and
  everything else Ctrl+C / Ctrl+V). Add to `~/.config/hypr/hyprland.lua`:

  ```lua
  o.window("phil(-incognito)?", { tag = "+terminal" })
  ```
- Hiding the panel keeps the shell running; closing the window hangs it up.
- Whether the panel is open is remembered: quit with it open and the next
  start opens it again (in the start folder, with the grid focused).

## Keys

| | |
|---|---|
| double-click / Enter | open folder, view image, play video in mpv, or open file with default app (right-click a video → "Play here" for the built-in player) |
| arrows, Home/End, PgUp/PgDn | move selection (with Shift: extend it) |
| Ctrl+click / Shift+click, Ctrl+A | add to / extend / select all; Esc clears |
| drag (Ctrl/Shift+drag) | select everything the rectangle touches (add to the selection); scrolls at the edges |
| type a name | jump to the next entry starting with it (repeat a letter to cycle) |
| F2 | rename in place (Enter or clicking elsewhere renames, Esc cancels) |
| Shift+Delete | permanently delete the selection, after a confirmation (Enter / Esc) |
| right-drag onto a folder | menu: "Move to" / "Copy to" (folder tiles, path segments in the top bar, places) |
| middle-drag onto a folder | move there right away |
| Backspace | parent folder |
| Alt+← / Alt+→ | back / forward |
| Ctrl+L | type a path (`~` works) |
| `/` or Ctrl+F | filter |
| Ctrl+H | show hidden files |
| F9 | toggle the places sidebar |
| F4 / Ctrl+` | toggle the terminal panel |
| Alt+↓ / Alt+↑ | focus the terminal (opening it) / the folder view |
| Ctrl + / − / wheel | thumbnail size |
| F5 | reload folder |
| in viewer: ← → Esc, `f` | previous/next, close, fullscreen |
