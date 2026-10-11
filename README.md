# phil

A small file manager for folders full of pictures and videos, and the engine it
runs on. The UI is plain HTML/CSS/JS rendered by the system WebKitGTK; the
backend is JavaScript running on Deno. No bundled browser, no npm dependencies.

## The engine and its apps

phil is one app of `phil-engine`, which runs apps in one background process:
their windows (GTK + WebKitGTK) share a main loop, and their servers a worker.
The first app you run starts the engine in the background; after that, an app's
command just asks the running engine for a window and returns, so windows open
quickly. The engine keeps running after its last window closes.

- **phil**, the file manager (below).
- **jsonedit**, a JSON editor: `jsonedit file.json` (see [jsonedit](#jsonedit)).
- **textedit**, a text editor with syntax highlighting and Markdown that can be
  edited as it reads: `textedit file` (see [textedit](#textedit)).
- **phil-editor** (`ed` with `alias ed=phil-editor`): the right editor for a
  file, jsonedit for JSON and textedit for other text. Typed in phil's terminal
  panel, it opens the editor in that phil window (the panel's shell has
  `PHIL_TERMINAL` and `PHIL_ENGINE_SOCKET`; the editor's Esc returns to the
  terminal); anywhere else, in a window of its own.

Each app gets its own server on 127.0.0.1, with its own port and origin; its
windows get its own Wayland app id (`phil`, `jsonedit`) for window rules. Apps
share a look: a top (and bottom) bar that floats over the page and fades out
until hovered, with an X at the right that closes the window
(`engine/ui/kit.css`, `kit.js`). One app can show another inside its window:
phil opens `.json` files in jsonedit and other text files in textedit that
way, like images in its viewer, and the editor's X (or Esc) goes back to the
folder. Copying and pasting go through
the desktop's clipboard (`wl-copy` / `wl-paste`), so they show up in Omarchy's
clipboard history and take what was copied anywhere; every way of pressing
them works the same: Ctrl+C / Ctrl+V, Super+C / Super+V, Ctrl+Insert /
Shift+Insert (what Omarchy's Super+C / Super+V send to windows tagged as
terminals, like phil's).

- The engine finds the running one through `$XDG_RUNTIME_DIR/phil/main.sock`;
  its output goes to `main.log` next to it.
- An app's options can pick a separate engine (a profile): incognito phil
  windows get their own (`incognito.sock`): separate servers, token and private
  WebKit session, app id `phil-incognito` and a purple stripe along the top. It
  exits, deleting its temporary thumbnails, with its last window. "Show in
  folder" always goes to the normal engine. Non-default `--thumb-dir`,
  `--thumb-size`, `--jobs` or `--port` also get an engine of their own, so those
  options always apply.
- Engine options, with any app: `--quit` stops the background engine (`phil
  --incognito --quit` the incognito one); `--retire` (`phil-engine --retire`)
  makes every running engine keep its windows but take no new ones and exit once
  those close (`deno task install` does this); `--standalone` runs the app in a
  process of its own that exits with its window (`deno task start` uses it, so
  development runs don't end up in the installed engine); `--browser` prints a
  URL instead of opening a window.

## Install

```sh
deno task install
```

Builds `phil-engine` and installs it to `~/.local/bin`, with a small `phil` and
`jsonedit` command next to it, and makes phil the default file manager. Rerun it
after changing the code.

- `~/.local/share/applications/phil.desktop` (with a "New Incognito Window"
  action) and `inode/directory=phil.desktop` in `~/.config/mimeapps.list`:
  folders opened with `xdg-open` and by most apps.
- `~/.local/share/dbus-1/services/org.freedesktop.FileManager1.service`:
  "Show in folder" in Brave/Chromium/Firefox, file pickers and portals goes
  through the [FileManager1](https://www.freedesktop.org/wiki/Specifications/file-manager-interface/)
  D-Bus interface, not the MIME default. The user service file takes
  precedence over Nautilus's, so D-Bus starts `phil --file-manager-service`
  (`apps/phil/dbus.js`), which opens a phil window per request with the items
  selected, and exits after 10 idle minutes. While Nautilus is running it
  holds that D-Bus name itself, so those requests go to Nautilus until it quits.
- `jsonedit.desktop` and `textedit.desktop`, made the default apps for JSON and
  for text files (plain text, Markdown, scripts, code, configs, logs; not HTML
  or XML), so they open from browsers' download lists, `xdg-open` and file
  pickers.

## phil

`phil [options] [directory | file...]`; `phil file...` opens the files' folder
with them selected.

```sh
deno task start [options] [directory]   # phil from the source, --standalone
deno task compile                       # the single ./phil-engine binary (~100 MB, mostly the Deno runtime)
```

Options:

| option | env | default |
|---|---|---|
| `--thumb-dir PATH` | `PHIL_THUMB_DIR` | `$XDG_CACHE_HOME/phil/thumbnails` |
| `--thumb-size N` | `PHIL_THUMB_SIZE` | `384` (width; thumbnails are 16:9 center crops) |
| `--jobs N` | | CPU count |
| `--port N` | | random |
| `--incognito` | | off (see below) |

The thumbnail directory is per engine, so you can run e.g. one with
`--thumb-dir /mnt/photos/.thumbs` for a photo drive and another with the default.
Thumbnails are stored as `<thumb-dir>/<W>x<H>/<hash>.jpg`. The hash covers path,
size and mtime, so edited files get new thumbnails. Clearing the cache means
deleting the folder.

phil's long options can be shortened to any unique prefix (`--incog`,
`--thumb-s 256`); the engine options can't.

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
total size (not counting subfolders), and previews of its first four files in
the current sort order that have one: images, videos and text files (files
without one, like archives, are skipped). When a folder tile scrolls into view
without that information, or the folder changed since (say a file was deleted
in the terminal), or the view is sorted differently, phil reads the folder in
the background, makes those previews and saves the result. The status bar
counts the folders being read. Summaries live next to the thumbnails
(`<thumb-dir>/<W>x<H>/folders/`); incognito keeps them in memory for the
session.

### PDFs

PDFs get a thumbnail of their first page, cropped from the top so the title
and headings show (vips renders it with poppler; about 80 ms for a typical
page, more for big scans). They count as folder previews too, and open with
the default PDF app.

### Text files

Files that turn out to be text (anything UTF-8 without NUL bytes: notes,
Markdown, JSON, config files, code, CSV, logs...) show their own text on the
tile, code and configs syntax-highlighted in textedit's colors (in the
background: tiles show plain first), scaled to the file: a short one in readable type, a long one smaller to
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

`webkit2gtk-4.1`, `deno`, `wl-clipboard`, `libvips` (built with poppler, for PDF thumbnails) (`vipsthumbnail`, `vips`), `ffmpegthumbnailer`,
and GStreamer plugins for in-app video (`gst-plugins-good`, `gst-libav`). `mpv`
and `xdg-open` are used for "open externally".

## How it works

```
engine/main.js      the command line: asks the running engine for a window, or starts one
engine/instance.js  finding and talking to the running engine (Unix socket per profile)
engine/window.js    GTK3 + WebKitGTK windows via Deno FFI (blocks in gtk_main)
engine/server.js    the apps' 127.0.0.1 HTTP servers (a worker): session, static files
engine/http.js      responses, files with Range
engine/pty.js       pseudo-terminals via libc FFI (Deno has no PTY API)
engine/apps.js      the apps, and what an app consists of
engine/ui/          what every app's pages share: the fading bars, the close
                    button, showing another app inside a window, syntax
                    highlighting (syntax.js, with highlight.js in vendor/,
                    BSD-3-Clause; syntax-worker.js)
apps/phil/          launch.js (options, window URL), server.js (listing, files,
                    thumbnails, terminal), thumbs.js (cache + LIFO job pool:
                    vipsthumbnail / ffmpegthumbnailer), folders.js (folder
                    summaries), texthead.js (text tiles), dbus.js
                    (FileManager1), shell-init.bash, ui/ (ui/vendor: xterm.js 6, MIT)
apps/jsonedit/      launch.js, server.js, ui/ (json.js: a parser that keeps positions)
apps/textedit/      launch.js, server.js, ui/ (markdown.js: Markdown to HTML and back)
engine/files.js     reading and saving files for the editors
data/, scripts/install.sh  desktop entries, D-Bus service file, installer
```

An app is a folder in `apps/` with a `launch.js` (its command line and window
URL; loaded by every command, so it stays small), a `server.js` (its routes, in
the engine's server worker) and a `ui/` folder (`index.html` at `/`, the rest
under `/ui/`); `engine/apps.js` lists them. Pages also get `/engine/ui/` (the
shared kit), `/engine/clipboard` and `/engine/embed/<app>/`: every other app
on the page's own origin, to show inside it in an `<iframe>` with `?embedded`
(WebKit won't give keyboard focus to a page in a frame from another origin).
Apps that can be shown that way use relative URLs. The engine handles the session
(a random token in the window's URL becomes a cookie; requests without it, or
to another host, are refused), static files and window management.

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
- `phil-editor file` (or `ed file`) opens the file's editor over the folder,
  in this window; Esc comes back to the terminal.
- On a network mount (NFS, sshfs; from /etc/fstab or mounted), `ssh` with
  nothing else goes to that machine, into the same folder there. So does
  "SSH here" on a folder's menu, or double-clicking (or right-clicking) a
  network share in the sidebar. The remote shell gets a network icon (󰈀)
  before its prompt, and it and the file view follow each other as they do
  locally: `cd` there moves the view, and browsing the mount moves the shell
  (silently, through the ssh session's own connection, a control socket).
  After `exit`, the local shell goes to where the view is. phil sends the
  remote shell its prompt hooks along with the ssh command (a temporary rc
  file there that removes itself); `ssh` with arguments is plain ssh.
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
| double-click / Enter | open folder, view image, play video in mpv, edit a `.json` file in jsonedit or any other text file (notes, code, configs, logs; whatever reads as text) in textedit, both in this window, or open the file with its default app (right-click a video → "Play here" for the built-in player; any file → "Edit as text") |
| arrows, Home/End, PgUp/PgDn | move selection (with Shift: extend it) |
| Ctrl+click / Shift+click, Ctrl+A | add to / extend / select all; click empty space to clear |
| Ctrl+C / Ctrl+Insert / Super+C | copy the selected files' paths, one per line |
| drag (Ctrl/Shift+drag) | select everything the rectangle touches (add to the selection); scrolls at the edges |
| type a name | jump to the next entry starting with it (repeat a letter to cycle) |
| F2 | rename in place (Enter or clicking elsewhere renames, Esc cancels) |
| Shift+Delete | permanently delete the selection, after a confirmation (Enter / Esc) |
| right-drag onto a folder | menu: "Move to" / "Copy to" (folder tiles, path segments in the top bar, places) |
| middle-drag onto a folder | move there right away |
| Backspace, Esc | parent folder |
| Alt+← / Alt+→ | back / forward |
| Ctrl+L | type a path (`~` works) |
| `/` or Ctrl+F | filter |
| Ctrl+H | show hidden files |
| F9 | toggle the places sidebar (home folders, drives in /run/media and /mnt, and /etc/fstab's network shares and other mounts; refreshed when the window gets focus) |
| F4 / Ctrl+` | toggle the terminal panel |
| Alt+↓ / Alt+↑ | focus the terminal (opening it) / the folder view |
| Ctrl + / − / wheel | thumbnail size |
| F5 | reload folder |
| in viewer: ← → Esc, `f` | previous/next, close, fullscreen |

## jsonedit

`jsonedit [file.json]` shows JSON as a tree and edits it in place. Without a
file it starts a new one. Opened from phil, it shows in phil's window.

- Click a value to edit it, or select it and start typing. What you type sets
  the type: JSON is taken as such (`42`, `true`, `null`, `{"a": 1}`, `[1, 2]`,
  `"quoted"`), anything else is a string; a hint says which, and objects or
  arrays that aren't valid JSON yet can't be kept. An object or array can be
  edited as JSON text too.
- Double-click a key (or F2) to rename it; booleans toggle with a click.
- Rows select like lines in a text editor: Shift+arrows, Shift+click and
  dragging select several, and a selected object or array takes everything
  inside along. Dragging inside a key or value selects text there instead.
  Delete, copy, cut, duplicate and move act on the whole selection.
- Copying a row copies its line: `"key": value` with everything inside it
  (several rows: one per line, with commas between), so it pastes into another
  editor as it is in the file. Pasted lines, from here or elsewhere, go in as
  items keeping their keys (just the values in an array). Text dragged over
  inside a key or value copies as just that text. Menu: Copy value, Copy path.
- `+ key` / `+ item` on an object or array adds one inside; the right-click
  menu (or `⋯`) adds after, duplicates, moves, copies as JSON or path, changes
  the type (keeping what it can) and deletes. Pasting JSON inserts it.
- Undo and redo cover every change; Find searches keys and values.
- Saving writes the tree with 2 or 4 spaces or tabs (it picks up the file's
  own), keeping key order and numbers as written (no lost digits). It writes a
  temporary file and renames it over the old one, keeping its permissions; if
  the file changed on disk since it was opened, it asks first. A file that
  isn't valid JSON opens as text, with the error located, to fix first.

| | |
|---|---|
| ↑ ↓ Home End PgUp PgDn, ← → | move; close and open |
| Shift + those, Shift+click, drag | select rows; Ctrl+A everything, Esc one again |
| Enter / F2 / Space / typing | edit the value (open or close an object or array) / rename the key / toggle / replace the value |
| Ctrl+Enter, Insert | add inside, add after |
| Delete, Ctrl+D (Shift+Alt+↓), Alt+↑ ↓ (Ctrl+↑ ↓) | delete, duplicate, move |
| Ctrl+C / Ctrl+X / Ctrl+V (also Ctrl+Insert / Shift+Delete / Shift+Insert, Super+C / Super+V) | copy, cut, paste |
| `*` | open everything inside |
| Ctrl+Z / Ctrl+Shift+Z | undo / redo |
| Ctrl+F, Ctrl+S, Ctrl+Shift+S, Ctrl+O | find, save, save as, open |
| Esc (shown in phil) | back to the folder |

`deno task jsonedit [file]` runs it from the source.

## textedit

`textedit [file]` edits text with syntax highlighting. The language comes from
the file's name, its first line (`#!/bin/bash`, `[section]`), or a guess, and
can be changed in the status bar; highlighting is
[highlight.js](https://highlightjs.org/) (36 languages and Dockerfile, nginx,
properties), in the background, so typing never waits for it (very large files
aren't highlighted). It's a native text field with the highlighted text drawn
under it: typing, selecting, undo and input methods are the browser's own.

- Tab / Shift+Tab indent and outdent the selected lines; Enter keeps the
  indentation (one more after an opening bracket).
- Ctrl+/ comments lines out and back in; Alt+↑ ↓ moves lines, Shift+Alt+↑ ↓
  duplicates them, Ctrl+Shift+K deletes them, Ctrl+L selects them.
- Copy and cut with nothing selected take the whole line, which pastes back as
  a line above the cursor's. Through the desktop's clipboard, like the others.
- Ctrl+F find, Ctrl+H replace (one or all), F3 / Shift+F3 next and previous,
  Ctrl+G go to line.
- Saving works as in jsonedit: atomic, keeps permissions, asks if the file
  changed on disk. Files that aren't text (or UTF-8) aren't opened.

Markdown opens as it reads (Rendered), editable: type in it, Ctrl+B / Ctrl+I /
Ctrl+K for bold, italic and links, and `# `, `- `, `1. `, `> ` at the start of a
line turn it into a heading, list or quote. Code shows the Markdown itself
(Ctrl+Shift+M switches). Going back to the code writes only the blocks that
were edited as new Markdown; everything else keeps its exact source, so a
small edit doesn't reformat the file. Front matter and raw HTML show as they
are and can be edited in the code. Images show from the file's folder.

`deno task textedit [file]` runs it from the source.
