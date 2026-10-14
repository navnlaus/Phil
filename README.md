# phil

A scopemaxed, vibecoded file manager and the engine it
runs on. The UI is plain HTML/CSS/JS rendered by the system WebKitGTK; the
backend is JavaScript running on Deno. No bundled browser, no npm dependencies.\
Developed and tested on Omarchy, the install scripts assumes a similar setup.

![phil showing a Pictures folder: photo thumbnails with their tags, folders with previews of what's inside, and the folder's tags in the sidebar](docs/screenshots/pictures.webp)

| | |
|---|---|
| ![The filter box finding pictures by what they show](docs/screenshots/search.webp) | ![Home folder: each folder's tile previews its first files, photos, code and documents alike](docs/screenshots/home.webp) |
| Search by description: "mountains reflected in a lake" (auto-tagging, SigLIP 2) | Folders preview what's in them, and their most common tags |
| ![Documents with text tiles, and the terminal panel following the folder](docs/screenshots/terminal.webp) | ![textedit showing Markdown as it reads, editable](docs/screenshots/markdown.webp) |
| The terminal panel follows the folder you're in, and the other way round | Markdown, edited as it reads (textedit) |
| ![textedit with syntax highlighting](docs/screenshots/code.webp) | ![imageresize cropping a photo to an ultrawide wallpaper](docs/screenshots/resize.webp) |
| Code, highlighted (textedit) | Resize, crop, turn and compress (imageresize) |
| ![The chips theme](docs/screenshots/chips.webp) | |
| Themes: here, chips | |

<sub>Photos from [Unsplash](https://unsplash.com).</sub>

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
- **imageview**, an image viewer: `imageview picture.jpg`, and the other images
  in its folder (see [imageview](#imageview)).
- **imageresize**: resize, crop and compress an image (right-click it in phil;
  see [imageresize](#imageresize)).
- **phil-editor** (`ed` with `alias ed=phil-editor`): the right editor for a
  file, jsonedit for JSON and textedit for other text. Typed in phil's terminal
  panel, it opens the editor in that phil window (the panel's shell has
  `PHIL_TERMINAL` and `PHIL_ENGINE_SOCKET`; the editor's Esc returns to the
  terminal); anywhere else, in a window of its own.

Each app gets its own server on 127.0.0.1, with its own port and origin; its
windows get its own Wayland app id (`phil`, `jsonedit`) for window rules. Apps
share a look: a top (and bottom) bar that floats over the page and fades out
until hovered (phil's top bar stays, with the folder below it), with an X at
the right that closes the window (`themes/base.css`, `engine/ui/kit.js`). One app can show another inside its window:
phil opens `.json` files in jsonedit, other text files and documents in textedit and images
in imageview that way, and the app's X (or Esc) goes back to the folder. Copying and pasting go through
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
- On [Omarchy](https://omarchy.org): a widget for its bar
  (`data/omarchy-bar/phil`, installed to `~/.config/omarchy/plugins/phil` and
  put before the clock). It shows copies, moves and deletes that have taken
  more than 10 seconds: "󰆏 Top Gear 45%" with a thin progress bar under it
  ("+2" when there are more), all of them with speed and time left in its
  tooltip; a click opens where the first one goes in phil. phil keeps them in
  `$XDG_RUNTIME_DIR/phil/progress.json` (not incognito windows'); the widget
  hides them when that's more than 15 seconds old, phil being gone.
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
- caches are kept in memory only: thumbnails in a temporary folder in
  `$XDG_RUNTIME_DIR` (a tmpfs, i.e. RAM; `/dev/shm` without it), deleted when
  the incognito engine exits, unless `--thumb-dir` is given; folder summaries
  and descriptions or hooks set in Properties in the process itself;
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
size, then (with subfolders) the size of everything in it, like `du -s`
("3 folders · 17 files · 56 MB / 1.2 GB"), and previews of its first four files in
the current sort order that have one: images, videos and text files (files
without one, like archives, are skipped). When a folder tile scrolls into view
without that information, or the folder changed since (say a file was deleted
in the terminal), or the view is sorted differently, phil reads the folder in
the background, makes those previews and saves the result. The status bar
counts the folders being read. Summaries live next to the thumbnails
(`<thumb-dir>/<W>x<H>/folders/`); incognito keeps them in memory for the
session. The total is du's, in the background (… until then), on the folder's
own file system; it's worked out again when the folder changed or after 10
minutes, kept in `folder-totals.json` there. Network shares and the kernel's
folders (`/proc`, `/sys`) get none. Sorted by size, folders go by their totals
(all of them are worked out then, not just those in view), and move as the
totals come in: at most once a second, only when the order changed, sliding to
their new places (the grid isn't rebuilt, so nothing flickers). Folders always come before files, whatever the order.

### Tags

The sidebar lists the tags of what's in the folder, with how many have each;
clicking tags shows only what has all of them. Tiles show their tags under
the details, and a folder's tile its most common ones. Tags come two ways:

- **By hand**: select pictures (or any files), right-click → "Add tags…", or
  edit a file's tags in Properties. They're kept with its description (and
  follow it when phil renames or moves it).
- **Auto-tagging** (optional, per folder): in a folder's Properties, tick "Tag
  the pictures in it automatically, and make them findable by what they show"
  (for the folder you're in, right-click its name in the path at the top). phil
  then tags its pictures (and videos) with
  [SigLIP 2](https://huggingface.co/google/siglip2-base-patch16-224), on this
  computer, whenever it shows the folder, and the filter box finds them by
  description as well as by name: "foggy forest", "stars at night". Keywords
  and a description saved in the files themselves (EXIF, XMP, IPTC) show too:
  the keywords as tags, the description on the tile when phil has none.

  Set it up once with `scripts/install-tagging.sh`: a Python environment in
  `~/.local/share/phil/tagging` (it picks the PyTorch that works with your GPU,
  down to the GTX 10 series, or the CPU's) and the model: about 8 GB with
  PyTorch for an NVIDIA GPU, much less for the CPU. A Python helper does the
  work, started when there's tagging to do and gone when idle. A picture is
  looked at once and remembered (its embedding, next to the thumbnails), so
  coming back to a folder is instant; on a GTX 1080 Ti new pictures take a few
  seconds a folder, most of it reading the files.

Auto-tagging picks from a list: phil's (`apps/phil/tagging/tags.txt`, about
130 everyday ones: mountains, beach, city, night sky, document,
screenshot...) and yours, `~/.config/phil/tags.txt`, which tags added by hand
join, so it looks for them in other pictures too. A picture gets up to five,
those it's at least 5% sure of. Searching shows what it's at least 1% sure
of, best first (what's really there scores far above that). Names of people
and such won't be recognized (that's another kind of model). Properties shows
what auto-tagging found next to the tags given by hand.

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
up to 400 lines), when its tile comes into view. Documents (Word, RTF,
OpenDocument) show their text too, from the Markdown textedit reads them as
(below; converted once, then kept with the thumbnails).

### Themes

The theme, set by hand in
`~/.config/phil/settings.json`, is how names and details sit on the tiles,
and can recolor every app (all their windows follow):

```json
{ "theme": "overlay", ... }
```

| theme | |
|---|---|
| `overlay` (default) | on the picture, over a shadow fading up from the bottom |
| `chips` | the name in a small chip; details in another, on hover and for the selection |

Open windows pick up an edit to the file right away.

A theme is any stylesheet in `~/.config/phil/themes` (but base.css): drop a
new `.css` file there and it's in the picker. "New theme…" in the picker
makes one from scratch, from a template: the whole palette (dark and light:
backgrounds, text, accent, borders, errors, folders, syntax colors) and the
tiles' parts, with notes on what each is. It picks it and opens it in a
window of its own: every save shows. Only the theme in use is loaded, after
the apps' own styles (phil by name, the others as `/themes/current.css`), so
plain selectors are enough; its palette colors every app, its tile rules
(`.tile .label .name { ... }`) only mean something to phil. A theme that's
gone (deleted, or a setting naming one) gives the default, `overlay`.

Next to the themes, `base.css` is what every app shares: the palette's
defaults, buttons, fields, segmented buttons, checkboxes, section headings,
the bars that float over a page and fade out, and the X. Edit any of them and
every open window of every app follows right away.

`deno task install` copies the built-in ones there (`themes/` in the
repository; `phil-engine --install-themes`). A later install updates the
copies you haven't edited and leaves the ones you have (it says so), and
removes copies of themes no longer built in, unless edited. Delete
one to use the built-in one instead (a file that isn't there is served from
the build). Apps keep only what's
their own in their `ui/style.css`; base.css's element defaults weigh nothing
(`:where()`), so an app's rules always win. The engine serves the themes at
`/themes/` to every app, and `/engine/styles` tells pages when one changes.

`--browser` prints a URL instead of opening a window. That's handy for using
Chromium's devtools while working on the UI. In the window, Shift+right-click on
empty space → Inspect Element works too.

## Requirements

`webkit2gtk-4.1`, `deno`, `wl-clipboard`, `libvips` (built with poppler, for PDF thumbnails) (`vipsthumbnail`, `vips`), `ffmpegthumbnailer`,
and GStreamer plugins for in-app video (`gst-plugins-good`, `gst-libav`). `mpv`
and `xdg-open` are used for "open externally". `udisks2` (`udisksctl`) mounts removable drives from the sidebar; a system drive's mount, like everything phil does as root, goes through `sudo`.

## How it works

```
engine/main.js      the command line: asks the running engine for a window, or starts one
engine/instance.js  finding and talking to the running engine (Unix socket per profile)
engine/window.js    GTK3 + WebKitGTK windows via Deno FFI (blocks in gtk_main)
engine/server.js    the apps' 127.0.0.1 HTTP servers (a worker): session, static files
engine/tls.js       the servers' certificate, made at each start (HTTPS, for HTTP/2)
engine/http.js      responses, files with Range
engine/pty.js       pseudo-terminals via libc FFI (Deno has no PTY API)
engine/apps.js      the apps, and what an app consists of
engine/ui/          scripts every app's pages share: kit.js (windows, showing
                    another app inside a window, the clipboard), syntax
                    highlighting (syntax.js, with highlight.js in vendor/,
                    BSD-3-Clause; syntax-worker.js)
themes/             the built-in themes: styles every app's pages share
                    (base.css) and phil's tile themes (overlay.css, ...), copied
                    to ~/.config/phil/themes on install; engine/themes.js serves
                    and watches them
apps/phil/          launch.js (options, window URL), server.js (listing, files,
                    thumbnails, terminal), thumbs.js (cache + LIFO job pool:
                    vipsthumbnail / ffmpegthumbnailer), folders.js (folder
                    summaries), texthead.js (text tiles), dbus.js
                    (FileManager1), shell-init.bash, ui/ (ui/vendor: xterm.js 6, MIT; Lucide's icons, ISC)
apps/jsonedit/      launch.js, server.js, ui/ (json.js: a parser that keeps positions)
apps/textedit/      launch.js, server.js, ui/ (markdown.js: Markdown to HTML and back)
apps/phil/tagging.js, tagging/
                    auto-tagging: tagger.py (the Python helper: SigLIP 2) and tags.txt
apps/imageview/     launch.js, server.js, ui/
apps/imageresize/   launch.js, server.js (vips), ui/
engine/media.js     media kinds by name, vips previews of images WebKit can't show
engine/files.js     reading and saving files for the editors
data/, scripts/install.sh  desktop entries, D-Bus service file, installer
```

An app is a folder in `apps/` with a `launch.js` (its command line and window
URL; loaded by every command, so it stays small), a `server.js` (its routes, in
the engine's server worker) and a `ui/` folder (`index.html` at `/`, the rest
under `/ui/`); `engine/apps.js` lists them. Pages also get `/engine/ui/` (the
shared scripts), `/themes/` (the shared styles), `/engine/styles` (theme
edits), `/engine/clipboard` and `/engine/embed/<app>/`: every other app
on the page's own origin, to show inside it in an `<iframe>` with `?embedded`
(WebKit won't give keyboard focus to a page in a frame from another origin).
Apps that can be shown that way use relative URLs. The engine handles the session
(a random token in the window's URL becomes a cookie; requests without it, or
to another host, are refused), static files and window management.

The servers speak **HTTPS to the engine's own windows, for HTTP/2** (`engine/tls.js`):
over plain HTTP a page gets six connections to its server at most, one request
on each, so a few slow ones (a hung network share, videos playing) held up a
click; HTTP/2 carries any number over one connection, and WebKit only speaks it
over TLS. The certificate is made at each start (openssl, a few ms), for
127.0.0.1, kept in memory only, and trusted by the engine's windows alone
(`webkit_web_context_allow_tls_certificate_for_host`). `--browser` (a browser
wouldn't trust it) and `PHIL_PLAIN_HTTP=1` stay on plain HTTP, as does an
engine that can't run openssl.

- Thumbnails are JPEG files in the cache, keyed by the file's path, size and
  time (a cheap check when listing), and also filed by the file's content
  (`by-content/`, a hard link: no extra space): its size and three 64 KB samples
  hashed. A file with no thumbnail under its key has its fingerprint looked up
  before one is made, so a copy, a move or a rename (by phil or anything else)
  finds its thumbnail for a few small reads instead of making it again; identical
  files share one. phil's own copies, moves and renames carry theirs along with
  no reads at all. Thumbnails from before are filed as their folders are viewed,
  in the background, one at a time while nothing is being made. Content entries
  no thumbnail uses any more are removed a minute after the start.
- Pictures go to `vipsthumbnail` up to 6 at a time (starting it takes ~55 ms,
  more than half of a 12 MP picture's time; batched, they're about 1.7× faster;
  one a batch couldn't make is tried again alone, so a broken file fails
  alone). Every thumbnailing command runs at a lower priority (`nice`), so the
  windows stay smooth while a folder's thumbnails are made.
- Thumbnails that are already cached come back as URLs in the directory listing.
  Missing ones are requested over a WebSocket as tiles scroll into view, and
  cancelled when they scroll out. The server generates the most recently requested
  ones first, up to `--jobs` at a time: for files on the system's own drive;
  on any other (a USB drive, another disk, a network share) as its speed
  allows: with a speed test (Properties), one per 30 MB/s of its read speed (a
  spinning disk at most 3: thumbnails make it seek), without one 3, since more
  only get in each other's way on a slow drive. Worked out once per drive and
  kept, until a speed test. One that takes more
  than 60 s (a file that hangs its decoder) is given up on and not tried again.
- The server only answers requests with the right `Host` header and a session
  cookie, which it sets from a random token in the URL the window opens with.
- On NVIDIA, `__NV_DISABLE_EXPLICIT_SYNC=1` is set automatically. Without it,
  WebKitGTK crashes on Wayland with "Error 71 (Protocol error)". The other common
  fix, `WEBKIT_DISABLE_DMABUF_RENDERER=1`, also works but switches WebKit to CPU
  rendering, which makes scrolling sluggish. Video is decoded on the GPU (the
  NVDEC decoders): WebKit's player shows H.264 from the software decoders as
  solid green here. Should NVDEC freeze a video on its first frame (it once did,
  handing its frames over in CUDA memory), `PHIL_SOFTWARE_VIDEO=1` ranks it out.
- WebKitGTK's DMA-BUF renderer leaks a GPU fence handle (`sync_file`) for many
  frames it draws (on NVIDIA at least; not for video), so a page drawing
  constantly runs out of open files and crashes ("Too many open files"). phil
  draws nothing for nothing (no endless animations: a shimmer on every tile
  waiting for its thumbnail leaked 24,000 handles in 20 s), and the engine
  raises its open-files limit to the hard limit (524288 here, from 65536), which
  WebKit's processes inherit.
- WebKit's player never loads Matroska files with embedded subtitles; after six
  seconds the viewer says so. Double-click plays videos in mpv anyway.

## Terminal panel

F4 (or Ctrl+`) opens bash in a panel under the grid; drag its top edge to resize.
Ctrl+F in it toggles between covering the whole window and its own height.

Double-clicking a script or program runs it there: a file with a `#!` line, a
shell script by its name (`.sh`, `.bash`, `.zsh`, `.fish`), or an executable
program. The terminal covers the window while it runs (`./build.sh`, or through its
interpreter when it isn't executable: `bash build.sh`), its output from the top
line: what was on the screen scrolls up into the scrollback, and the command
line isn't shown (it's in the history). Anything half-typed at the prompt is
cleared first; only a program still running there keeps it from starting; **Esc** stops it
(Ctrl+C) and puts the terminal back as it was. "Edit as text" (right-click)
still opens one in the editor.
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
| double-click / Enter | open folder, view image in imageview, play video in mpv, edit a `.json` file in jsonedit or any other text file (notes, code, configs, logs; whatever reads as text) in textedit, both in this window (a Word, RTF or OpenDocument document: read in textedit, as Markdown), or open the file with its default app (right-click a video → "Play here" for the built-in player; any file → "Edit as text") |
| double-click a script (`#!`, `.sh`…) or program | run it in the terminal, covering the window; Esc stops it and puts the terminal back |
| arrows, Home/End, PgUp/PgDn | move selection (with Shift: extend it) |
| Ctrl+click / Shift+click, Ctrl+A | add to / extend / select all; click empty space to clear |
| Ctrl+C / Ctrl+X (Super+C / Super+X), Ctrl+V (Super+V) | copy or cut the selected files and folders (their tiles outlined; cut: faded too), paste them into the folder shown (right-click: Cut, Copy, Paste, Paste into a folder), in this window or another phil window. Pasting copies or moves as dragging does: across drives with rsync's progress, pause, stop and resume. The desktop's clipboard gets their paths as text too (a terminal, a chat), and files copied in another program (their paths or file:// URIs) paste here as copies; text copied since leaves nothing to paste |
| drag (Ctrl/Shift+drag) | select everything the rectangle touches (add to the selection); scrolls at the edges |
| drag a selected file or folder | drag the selection out as files: onto a browser page (an upload), another file manager, a chat; onto a folder in phil: "Move to" / "Copy to" |
| type a name | jump to the next entry starting with it (repeat a letter to cycle) |
| Insert / + (after the up arrow) | a new folder, "Folder" ("Folder 2"... when there's one), its name ready to type over (Enter keeps it) |
| Super+Insert | a new file, "File.txt" ("File 2.txt"...), the same way |
| right-click empty space (tiles or sidebar) | New folder / New file here; on a folder (its tile, a place in the sidebar, a part of the path) New folder / New file inside it |
| F2 | rename in place (Enter or clicking elsewhere renames, Esc cancels) |
| Shift+Delete | permanently delete the selection, after a confirmation (Enter / Esc). A big folder shows how far it is (a red bar on it and in the sidebar's Transfers), × stops it (what's gone is gone). What phil kept of what's deleted goes too: its metadata, thumbnails, documents read as Markdown, folder summaries, sizes and tagging |
| right-click a text or JSON file → Add to Config | a link to it in `Documents/Config`, for config files used often but kept all over (a name that's taken gets its folder's in front: `waybar-config`) |
| right-click → Properties, Alt+Enter | type, size (a folder's: everything in it), dates, owner, permissions and what you can do with it; and phil's own: a **description** shown above the name, a folder's **icon**, and, for a file, an **on-change hook**: a command run when the file changes (below) |
| drop files from another phil window (any button: middle moves, the others ask) or another program (a file manager…) | onto a folder (its tile, a place in the sidebar, a part of the path) or the folder's empty space: "Move to" / "Copy to" (all from that folder already: "Copy here"), with the same progress, pause and resume |
| right-drag onto a folder | menu: "Move to" / "Copy to" (folder tiles, path segments in the top bar, the sidebar); out of the window, the files go on being dragged, for the app they're dropped on to copy, move or ask |
| a copy or move under way | a bar on the folder it goes to, on what it's making there, on the file it's at (that file's percentage), and in the sidebar's Transfers, with the percentage and speed (time left in its tooltip); ⏸ pauses, × stops (what's done stays: a move removes each file only once it's copied). Its record (in phil's metadata, every few seconds) outlives a crash: a copy cut off shows "Stopped at 45%" on its folder, and the file it was at "Cut off at 18%" (a file that takes more than a few seconds has a record of its own); ↻ goes on where it stopped: finished files are skipped, and a file that was cut off is appended to, from where it stopped, then checked whole against the original (rsync --inplace --append-verify; after a crash too); copying the same thing there again goes on with it too; × forgets it. rsync stops with phil, so nothing copies on unseen. Moves within a drive, and copies within one that clones files (btrfs), are instant and skip it |
| a download under way ([panda-dl](https://github.com/pandaind/panda-dl)'s: HTTP and BitTorrent) | a bar like a copy's: on what's being downloaded (once it's there; a torrent's files each with their own progress, and the folders in it with theirs together: a file it has finished gets the finished mark and its thumbnail while the rest goes on; this needs panda-dl to list a torrent's files, a change to it in `~/Projects/panda-dl`, branch `file-progress`; without that, its files are guessed and share its progress), on the folder it goes to and in the sidebar's Transfers, with the percentage and speed (time left and peers in its tooltip); ⏸ pauses, ▶ goes on, × stops and forgets it (what's downloaded stays). × on one of a torrent's files (or a folder in it), or deleting it in phil, drops just that from the download and the rest goes on; dropping its last file closes it. phil asks panda-dl's daemon over its socket, on one connection: every second while something downloads, every 5 seconds otherwise, never while no window is open (`apps/phil/downloads.js`; `PANDA_DL_SOCKET` for another socket). What's being downloaded isn't thumbnailed till it's done, then at once. Links dropped on a folder (a tile, a place, a part of the path, or the empty space: the folder shown), a magnet link or a web link from a browser, are downloaded there; a dropped .torrent file offers "Download into" before Move and Copy (panda-dl's daemon is started then if it isn't running: `panda-dl start`, `PANDA_DL` for another panda-dl; it runs on apart from phil). One finished but still in panda-dl's list has a small mark on its tile: a download icon, and ↑ with its upload speed while it's seeding (what it has uploaded, and its ratio, in the tooltip); × takes it off the list (the file stays) |
| the sidebar's Transfers | every copy, move, delete and download (paused ones too, and finished downloads still seeding), each its name over its bar, with the bar's buttons; click one: the folder it goes to, with what it's making selected |
| click the sidebar's Transfers heading | the Transfers view, over the folder: every transfer in full (what, where to: a click shows it there, its bar and buttons, size, speeds, time left, peers, what's uploaded; a torrent's files, each with its own progress and ×), and the settings for downloads, panda-dl's: its download folder (for links copied to the clipboard and its own command; drops in phil go where they're dropped), connections per web download, and whether copied magnet and .torrent links are downloaded. Saved as they're changed: through its daemon when it's running, otherwise in `~/.config/panda-dl/config.json`. Esc, ×, or opening a folder closes it |
| right-drag onto the folder it's in | "Copy here" (the tiles' empty space, a file, that folder in the path): copies beside them, numbered ("photo 2.jpg", "Folder 2"), selected |
| middle-drag onto a folder | move there right away; out of the window, the files go on being dragged, for the app they're dropped on to move (or copy) |
| Backspace, Esc | parent folder |
| Alt+← / Alt+→ | back / forward |
| Ctrl+L | type a path (`~` works) |
| `/` or Ctrl+F | filter |
| Ctrl+H | show hidden files |
| hover / click the sidebar button (the folder in the top left corner), F9 | the sidebar slides out over the folder / stays open beside it (home folders, drives in /run/media and /mnt, and /etc/fstab's network shares and other mounts, each with its free space ("758 GB free of 1.8 TB"; a share that isn't mounted yet isn't woken for it); refreshed when the window gets focus) |
| right-click a drive in the sidebar → Properties | the drive under it (model, NVMe/USB/SATA, the disk device under partitions and encryption), file system, space, and its read speed: "Run speed test" reads up to 4 GB straight from the disk (`dd`, O_DIRECT, 15 s at most; as root, with sudo: it asks for the password unless sudo still remembers it, as for saving root's files in the editors), and the result is kept per disk; on a network share it's its speed both ways, a test file written to it and read back (10 s each, no root), kept per share. The sidebar's tooltip has the last result |
| drag a folder (a tile, one of the sidebar's own, with any button, or one from another program) between two of the sidebar's folders | a line shows where; dropped, it's in the sidebar there (a link: the folder stays where it is), or moves there if it's in it already. The sidebar's folders are kept in `~/.config/phil/sidebar.json`, for every window. Dragged onto a folder, a sidebar folder is moved or copied there like a tile (not a drive, home or /) |
| right-click a folder in the sidebar → Remove from sidebar | it's no longer listed (the folder itself stays) |
| double-click a camera at the bottom of the sidebar | shows it live in this window, with its pan, tilt and zoom (camview, below); right-click: Rename, Log in, Forget, Look for cameras, Add camera… |
| click a dimmed drive in the sidebar | mount it and open it: partitions nothing has mounted (an internal drive's, like Windows': only removable ones are mounted by themselves), by udisks under /run/media, a system drive's with sudo (the password box, unless sudo remembers it); right-click a drive in /run/media → Unmount |
| F4 / Ctrl+` | toggle the terminal panel |
| Alt+↓ / Alt+↑ | focus the terminal (opening it) / the folder view |
| Ctrl + / − / wheel | thumbnail size |
| F5 | reload folder |
| in the video player ("Play here"): ← → Esc, `f` | previous/next video, close, fullscreen |

**On-change hooks.** A file's Properties can name a command for phil to run
when the file changes — but only while a phil window shows its folder; with
the folder not shown, nothing runs. It runs in bash, in the folder, with the
file as `$1` (and `$PHIL_FILE`), and the status bar says it ran or why it
failed (the engine's log has the output). Through a link, it's the file the
link points to that's watched, so a link in `Documents/Config` with
`sudo systemctl restart keyd` restarts keyd whenever `/etc/keyd/default.conf`
is saved. A plain command like that runs as phil's own child, so sudo goes
without asking while it remembers the password you gave phil for anything
else; when it doesn't, phil asks for it (the password box) and runs it again. Opening or
touching the file doesn't count, nor do changes the command makes itself.
A tile with a hook has a ⚡.

**Root access**, wherever phil needs it (saving a file of root's in the
editors, mounting a system drive, a hook's `sudo`, a drive's speed test), is
one way: `sudo`. While sudo remembers a password (`timestamp_timeout`, 5
minutes by default; for phil as a whole) nothing is asked; otherwise a small
password box over the window asks, saying what for, and the password goes
to sudo and nowhere else.

**Descriptions.** Properties also takes a description, for a file or a
folder, shown in italics above its name (kept in the same metadata.json).

**Folder icons.** A folder's Properties has an **Icon**: "The usual folder"
opens a picker with icons suggested for it on top (from its name: "Games"
gets a gamepad, joystick, dice…; then ones any folder might want) and all of
[Lucide](https://lucide.dev)'s 1,900 below, with a search box (by name and
tags: "car", "money"; Enter takes the best match). The icon is on its tile (in
the corner, and in the middle when it has no pictures to show) and in the
sidebar; "Usual" puts the folder icon back. Kept in metadata.json too.

**Tile marks.** Before the name: a link icon on a link; a red lock on a file
or folder you can't change without sudo (a file: also its folder, as saving
replaces it there), and for a link, a red link icon when that's so of what it
points to. Hovering says which. ⚡ (a hook), ▶ (a video) and a folder's icon are in
the bottom right corner, on the label's last line; nothing goes in the top left. They're kept in `~/.config/phil/metadata.json`,
and follow the file when phil renames or moves it.

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
- Through a link, the file it points to is saved. One you can't write (root's,
  in /etc) is saved with sudo: it asks for your password, unless sudo still
  remembers it (5 minutes by default, `timestamp_timeout` in sudoers). The
  password isn't kept. textedit saves the same way.

| | |
|---|---|
| ↑ ↓ PgUp PgDn, Ctrl+Home / Ctrl+End | move (up and down keep to the key or value, if that's what's selected); the first / last row |
| → / ← | step through a row: the whole line, its key, its value; past the value → opens an object or array, before the line ← closes it (or goes to its parent) |
| Home / End | the whole line / its last part (the value) |
| with a key or value selected: Ctrl+C, Ctrl+V, Enter, typing | copy just it, paste over it (a key: renamed; a value: replaced), edit it, start editing it with what's typed; Esc: the whole line again |
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
Files are UTF-8 or UTF-16 (Windows' "Unicode", little or big endian, with or
without a byte order mark), and are saved the way they came, Windows line
breaks (CRLF) included; the status bar says so when it isn't plain UTF-8.

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

Documents (`.docx`, `.doc`, `.rtf`, `.odt` and other word processors' files)
open for reading: LibreOffice turns them into Markdown (with its Markdown
export: a recent LibreOffice; 26.8 has it), which shows rendered and read-only. Headings,
bold and italic, lists, tables, links and pictures come through; fonts,
colors and layout don't. "Save as Markdown…" (Ctrl+S) keeps that as a `.md`
file, editable from then on, and "Edit original" opens the document in its
own app (LibreOffice, usually). Converting takes a second or two; the
document is never written to.

`deno task textedit [file]` runs it from the source.

## imageview

`imageview [file or folder]` shows an image and lets you go through the
others in its folder (a folder: from its first), in name order, or in phil's
order when phil opens it (in its own window; Esc goes back to the folder, with
the image you were on selected). Typed in phil's terminal panel, it opens in
that phil window. It's the default app for images (`deno task install`;
`xdg-mime default imv.desktop image/jpeg ...` gives them back to imv).
Formats the webview can't show (HEIC, TIFF, JPEG XL...) are converted by vips.

| | |
|---|---|
| Z / Shift+Z | how the image meets the window: its height or its width fills it — first the one that shows the whole image, then the other, cropping what sticks out — or its original size (one image pixel to a screen pixel). Kept for the next images and windows |
| + / − (Ctrl too, Ctrl+wheel at the pointer), 0 | zoom in and out, back to the fit |
| arrow keys (Shift: a screenful), drag, wheel | scroll an image larger than the window; ← → when it's no wider: previous / next |
| Page Down / Space, Page Up / Backspace, Home, End | next, previous, first, last |
| double-click | original size at that spot, and back |
| F | fullscreen |
| Ctrl+C | copy the file's path |
| Esc / Q | leave fullscreen, close |

`deno task imageview [file]` runs it from the source.

## camview

`camview [camera]` shows a network camera live, and turns it if it can (pan,
tilt and zoom: PTZ). phil finds the cameras on the local network and lists
them at the bottom of its sidebar; double-click one to show it in that window
(camview's command line takes a camera's name or address, or shows the first).

- **Finding them**: phil looks only when you ask: the ↻ by "Cameras", or
  "Look for cameras" in the sidebar's right-click menu (there before any is
  found). It tries every address on this computer's own local
  networks (their /24s; not containers or VPNs) for RTSP (port 554) and asks
  those for ONVIF, the standard network cameras speak, on its usual ports
  (8899, 80, 2020, 8000...), giving each 1.5 s (a camera on weak Wi-Fi can lose
  the first try). The ↻ by "Cameras" looks again now: new ones are added, and
  ones not found (asked twice more, directly) are left out of the list until
  they're back, keeping their names, logins and settings. ONVIF's own discovery (WS-Discovery, multicast)
  isn't used: firewalls (ufw) drop its answers. One elsewhere: right-click →
  "Add camera…" with its address.
- **Logins**: a camera that wants one says "needs a login" in the sidebar;
  right-click → "Log in…". It's checked with the camera, sent as ONVIF's
  password digest, and kept, with the names you give them, in
  `~/.config/phil/cameras.json` (readable only by you). "Forget" hides one,
  even when it's found again.
- **The video** is the camera's own H.264, not re-encoded: ffmpeg copies its
  RTSP stream into fragmented MP4, which the page plays through Media Source
  Extensions (decoded on the GPU), a fragment per frame, about a second behind
  live. It plays at its own pace: WebKit's player stalls whenever its speed
  changes, so it never speeds up to catch up; more than 3 s behind (the
  window was hidden, say), it jumps ahead. The
  camera's streams are in the top bar (main, sub: Q switches). ffmpeg stops
  when the window does.
- **If the player can't show it** (an H.265 camera, or a player that shows
  solid green or a frozen frame, which camview checks 3 seconds in), it tries
  the stream re-encoded as plain H.264, then as JPEG pictures (MJPEG, no video
  player at all), and logs what it found (`camview: ...` in phil's log). The
  last two cost the computer some CPU, and are scaled to at most 1920 wide.
- **Turning it**: hold an arrow (bottom right; the diagonals too) or the arrow
  keys (two at once: diagonally), + and − zoom when it can, the slider is the
  speed, Space stops. A held move is repeated every half second and the
  camera is stopped by the server 1.5 s after the last one, so a closed window
  or a lost connection never leaves it turning.
- **Upside down** (a camera mounted on a ceiling): the ⇅ button in the top bar,
  or I, turns pan and tilt around, so up still turns it up. Kept for that
  camera, in `cameras.json`.
- **Presets** (its saved positions, along the bottom): click one or press 1–9
  to go there, + saves where it points now, right-click removes one.
- **Stats** (the chart button in the top bar, or D; remembered): how the
  stream is shown and its codec, its size, frames per second and dropped
  frames, how far behind live it plays here (what's buffered and not shown yet;
  the camera's encoding and the network add a few hundred ms before that), the
  data coming in, how long it's been connected and how often it reconnected. While shown, a summary goes to phil's log every 10 s (`camview: ... stats`).
- **Cameras with nothing local** (Tuya / Smart Life ones, like Hombli's: no
  RTSP, no ONVIF, every port closed): their video comes from
  [go2rtc](https://github.com/AlexxIT/go2rtc), which gets it through Tuya's
  cloud (a WebRTC call to Tuya's media servers: through Tuya's cloud API the
  video always goes by them, never straight over the LAN, so it needs the
  internet, and the cloud project's free trials renewed every few months) and
  serves it as local RTSP
  (`~/.config/go2rtc/go2rtc.yaml`, `go2rtc.service`). Such a camera is a
  `"type": "rtsp"` entry in `cameras.json` with its `streams` (go2rtc's RTSP
  URLs) and, for pan and tilt, `tuya` (its device ID and the Tuya cloud
  project's region, client ID and secret: `apps/camview/tuya.js` signs the
  commands). Added by hand; the network scan leaves it alone. H.265 (2K Tuya
  cameras) plays in WebKit as it comes, decoded on the GPU.
- **Cameras that get ONVIF half right** (cheap ones, like EYEPLUS / YCC365):
  answers with a wrong length are read up to their end, an empty answer to a
  move counts, and an answer to a question it doesn't support (some replay
  their previous answer) hides that part (its presets, say) instead of failing.
  A stream that drops is connected again by itself (when it ends, or after 8 s
  without video).
- S takes a picture (the best stream's, into `~/Pictures/Cameras`), F or a
  double-click is fullscreen, Esc closes.

## imageresize

`imageresize picture.jpg`, or right-click an image in phil → "Resize, crop,
compress…" (shown in phil's window). The picture is on the left with a crop
box over it; the settings on the right; the result is made as you change them
(by vips, in the background), with its file size and how much smaller it is.

- **Size**: a preset — this monitor's resolution (from Hyprland), 4K, 1440p,
  1080p, 720p, social media and link preview sizes, an avatar, a longest side
  (3840 … 512 px) or a percentage — or your own (typing one side changes the
  other with the lock on). A size with another shape than the picture is
  either filled (cropped to its shape; you get exactly that size) or fitted
  inside. "Enlarge if smaller" lets the others grow a small picture.
- **Turn**: a quarter turn left or right (Shift+R, R), a mirror image (M),
  and straightening by up to 45° either way (double-click the slider: back
  to straight), which crops away the corners it leaves. The crop is made on
  the turned picture.
- **Crop**: drag the box, its edges or corners; it keeps the preset's shape,
  or one you pick (1:1, 4:3, 3:2, 16:9, 21:9, 4:5, 2:3, 9:16, the picture's),
  or any. "All" takes the whole picture.
- **Compression**: JPEG (progressive, optimized Huffman tables), WebP or PNG;
  by quality, or by file size: the best quality that fits under it. The color
  profile is kept; other metadata (camera, GPS) only if you say so. Images
  are turned upright first (EXIF rotation).
- **Result** (V) shows what will be saved; click it for its actual pixels.
- **Save** (Ctrl+S) writes next to the original, named like
  `photo-1920x1080.jpg` (edit the name, or give a full path); it asks before
  replacing a file.

Its working copies live in `$XDG_RUNTIME_DIR` (memory) and go when the engine
exits. `deno task imageresize file` runs it from the source.
