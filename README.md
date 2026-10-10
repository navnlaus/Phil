# phil

A small file manager for folders full of pictures and videos. The UI is plain
HTML/CSS/JS rendered by the system WebKitGTK; the backend is a few hundred lines
of JavaScript running on Deno. No bundled browser, no npm dependencies.

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
| `--browser` | | open a native window |

The thumbnail directory is per process, so you can run e.g. one instance with
`--thumb-dir /mnt/photos/.thumbs` for a photo drive and another with the default.
Thumbnails are stored as `<thumb-dir>/<W>x<H>/<hash>.jpg`. The hash covers path,
size and mtime, so edited files get new thumbnails. Clearing the cache means
deleting the folder.

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
src/pty.js      pseudo-terminals via libc FFI (Deno has no PTY API)
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
  rendering, which makes scrolling sluggish.

## Terminal panel

F4 (or Ctrl+`) opens bash in a panel under the grid; drag its top edge to resize.
It is a real terminal (xterm.js on a pseudo-terminal), started with your
`~/.bashrc`, so prompts, aliases, job control and full-screen programs work.

- `cd` in the shell and the file view follows.
- Change folder in the file view while the shell sits at an empty prompt and
  the shell changes directory too, silently: nothing is typed and nothing goes
  into history, the prompt just redraws in place for the new folder. (phil
  leaves the target in a file and sends an empty Enter; phil's prompt hook does
  a `builtin cd` before your prompt renders, so `cd` wrappers like zoxide aren't
  involved.) If you're in the middle of typing or a command is running, it
  leaves the shell alone.
- Right-click a file → "Paste path in terminal" inserts its quoted path.
- Hiding the panel keeps the shell running; closing the window hangs it up.
- Whether the panel is open is remembered: quit with it open and the next
  start opens it again (in the start folder, with the grid focused).

## Keys

| | |
|---|---|
| double-click / Enter | open folder, view media, or open file with default app |
| arrows, Home/End, PgUp/PgDn | move selection (with Shift: extend it) |
| Ctrl+click / Shift+click, Ctrl+A | add to / extend / select all; Esc clears |
| type a name | jump to the next entry starting with it (repeat a letter to cycle) |
| Shift+Delete | permanently delete the selection, after a confirmation (Enter / Esc) |
| Backspace / Alt+↑ | parent folder |
| Alt+← / Alt+→ | back / forward |
| Ctrl+L | type a path (`~` works) |
| `/` or Ctrl+F | filter |
| Ctrl+H | show hidden files |
| F9 | toggle the places sidebar |
| F4 / Ctrl+` | toggle the terminal panel |
| Ctrl + / − / wheel | thumbnail size |
| F5 | reload folder |
| in viewer: ← → Esc, `f` | previous/next, close, fullscreen |
