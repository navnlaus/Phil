#!/usr/bin/env bash
# Builds phil-engine and installs it with its apps to ~/.local/bin:
#  - phil-engine, the engine, and a small command per app (phil, jsonedit,
#    textedit, imageview, videoplayer, imageresize, camview, and phil-editor, which picks jsonedit
#    or textedit for a file)
#  - the themes (shared styles, phil's tile themes) in ~/.config/phil/themes,
#    where they can be edited; open windows follow the edits
#  - phil as the default file manager: folders opened with xdg-open and most
#    apps (the inode/directory MIME default), and "Show in folder" from
#    browsers, file pickers and portals, which use the
#    org.freedesktop.FileManager1 D-Bus service instead
#  - on Omarchy, a widget for its bar: copies, moves and deletes under way
#  - desktop entries for jsonedit, textedit and imageview, the default apps for
#    JSON, text and image files (what xdg-open, browsers' download lists and
#    file pickers use), and for videoplayer and imageresize, offered under
#    "Open with"
set -euo pipefail
cd "$(dirname "$0")/.."

data=${XDG_DATA_HOME:-$HOME/.local/share}
bindir=${PHIL_BINDIR:-$HOME/.local/bin}
engine=$bindir/phil-engine

# The commit it's built from, for Preferences (engine/version.js): in the build, not left behind.
trap 'rm -f engine/ui/build.json' EXIT
if commit=$(git rev-parse --short HEAD 2>/dev/null); then
  dirty=false
  [[ -n $(git status --porcelain --untracked-files=no) ]] && dirty=true
  printf '{"commit":"%s","branch":"%s","dirty":%s,"built":"%s"}\n' "$commit" "$(git rev-parse --abbrev-ref HEAD)" "$dirty" "$(date -Iseconds)" > engine/ui/build.json
fi
deno task compile
install -Dm755 phil-engine "$engine"
# phil's mpv plugin for salir (native/salir-mpv): video under the page, through libmpv.
# Without libmpv's headers, none: videoplayer then plays what Chromium can.
libdir=${PHIL_LIBDIR:-$HOME/.local/lib/phil}
if pkg-config --exists mpv 2>/dev/null; then
  deno task mpv-plugin
  install -Dm755 native/salir-mpv/salir-mpv.so "$libdir/salir-mpv.so"
else
  echo "No libmpv (pkg-config mpv): no mpv plugin, so videos play only as salir's Chromium can" >&2
fi
# The themes, where they can be edited (~/.config/phil/themes).
"$engine" --install-themes
# An app's command runs the engine with the app's name.
for app in phil jsonedit textedit imageview videoplayer imageresize camview mediaview phil-editor; do
  printf '#!/bin/sh\nexec "%s" %s "$@"\n' "$engine" "$app" > "$bindir/$app.tmp"
  chmod 755 "$bindir/$app.tmp"
  mv -f "$bindir/$app.tmp" "$bindir/$app"
done

install -d "$data/applications" "$data/dbus-1/services"
for entry in phil jsonedit textedit imageview videoplayer imageresize camview mediaview; do
  sed "s|@BIN@|$bindir/$entry|g" "data/$entry.desktop" > "$data/applications/$entry.desktop"
done
sed "s|@BIN@|$bindir/phil|g" data/org.freedesktop.FileManager1.service > "$data/dbus-1/services/org.freedesktop.FileManager1.service"
update-desktop-database "$data/applications" 2>/dev/null || true
xdg-mime default phil.desktop inode/directory
xdg-mime default jsonedit.desktop application/json
# Text: what textedit.desktop lists, except HTML and XML (browsers show those).
text_types=$(sed -n 's/^MimeType=//p' data/textedit.desktop | tr ';' '\n' | grep -vE '^(text/html|application/xml|text/xml)?$')
xdg-mime default textedit.desktop $text_types
xdg-mime default imageview.desktop $(sed -n 's/^MimeType=//p' data/imageview.desktop | tr ';' ' ')
# Have the session bus pick up the new service file.
busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus ReloadConfig >/dev/null 2>&1 || true
# Omarchy: phil's widget for its bar (long copies, moves and deletes, with
# their progress), a shell plugin in ~/.config/omarchy/plugins/phil, put
# before the clock unless it's on the bar already. Only when it's changed: the
# shell reloads its plugins on a change, and a reload gives every widget the
# settings it had when the bar was built, not what's been changed since (the
# taskbar's pins vanish, and its next edit writes that back to shell.json).
omarchy_config=${XDG_CONFIG_HOME:-$HOME/.config}/omarchy
if [[ -d $omarchy_config ]] && command -v omarchy >/dev/null; then
  plugin_changed=
  for f in manifest.json BarWidget.qml; do
    cmp -s "data/omarchy-bar/phil/$f" "$omarchy_config/plugins/phil/$f" && continue
    install -Dm644 "data/omarchy-bar/phil/$f" "$omarchy_config/plugins/phil/$f"
    plugin_changed=1
  done
  [[ -n $plugin_changed ]] && { omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true; }
  omarchy bar put phil --section center --before omarchy.clock >/dev/null 2>&1 || echo "Couldn't put phil's widget on the bar: omarchy bar put phil"
fi
# Running engines (and phils from before the engine) keep their open windows
# but stop taking new ones and exit once those are closed, so the next launch
# runs the new build.
"$engine" --retire || true
# A FileManager1 service still running the previous build: stop it, D-Bus
# starts the new one on the next request.
service=$(busctl --user status org.freedesktop.FileManager1 2>/dev/null || true)
if [[ $(sed -n 's/^Comm=//p' <<<"$service") =~ ^phil(-engine)?$ ]]; then
  kill "$(sed -n 's/^PID=//p' <<<"$service")" 2>/dev/null || true
fi

echo "Installed $engine with phil, jsonedit, textedit, imageview, videoplayer, imageresize, camview, mediaview and phil-editor in $bindir"
echo "Folders open with: $(xdg-mime query default inode/directory); JSON with $(xdg-mime query default application/json); text with $(xdg-mime query default text/plain); images with $(xdg-mime query default image/jpeg)"
owner=$(busctl --user status org.freedesktop.FileManager1 2>/dev/null | sed -n 's/^Comm=//p' || true)
if [[ -n $owner && ! $owner =~ ^phil(-engine)?$ ]]; then
  echo "\"Show in folder\" goes to $owner for as long as it's running; it switches to phil once $owner has quit."
fi
