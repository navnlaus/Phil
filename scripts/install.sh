#!/usr/bin/env bash
# Builds phil-engine and installs it with its apps to ~/.local/bin:
#  - phil-engine, the engine, and a small command per app (phil, jsonedit,
#    textedit, imageview, imageresize, and phil-editor, which picks jsonedit
#    or textedit for a file)
#  - the themes (shared styles, phil's tile themes) in ~/.config/phil/themes,
#    where they can be edited; open windows follow the edits
#  - phil as the default file manager: folders opened with xdg-open and most
#    apps (the inode/directory MIME default), and "Show in folder" from
#    browsers, file pickers and portals, which use the
#    org.freedesktop.FileManager1 D-Bus service instead
#  - desktop entries for jsonedit, textedit and imageview, the default apps for
#    JSON, text and image files (what xdg-open, browsers' download lists and
#    file pickers use), and for imageresize, offered under "Open with"
set -euo pipefail
cd "$(dirname "$0")/.."

data=${XDG_DATA_HOME:-$HOME/.local/share}
bindir=${PHIL_BINDIR:-$HOME/.local/bin}
engine=$bindir/phil-engine

deno task compile
install -Dm755 phil-engine "$engine"
# The themes, where they can be edited (~/.config/phil/themes).
"$engine" --install-themes
# An app's command runs the engine with the app's name.
for app in phil jsonedit textedit imageview imageresize phil-editor; do
  printf '#!/bin/sh\nexec "%s" %s "$@"\n' "$engine" "$app" > "$bindir/$app.tmp"
  chmod 755 "$bindir/$app.tmp"
  mv -f "$bindir/$app.tmp" "$bindir/$app"
done

install -d "$data/applications" "$data/dbus-1/services"
for entry in phil jsonedit textedit imageview imageresize; do
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

echo "Installed $engine with phil, jsonedit, textedit, imageview, imageresize and phil-editor in $bindir"
echo "Folders open with: $(xdg-mime query default inode/directory); JSON with $(xdg-mime query default application/json); text with $(xdg-mime query default text/plain); images with $(xdg-mime query default image/jpeg)"
owner=$(busctl --user status org.freedesktop.FileManager1 2>/dev/null | sed -n 's/^Comm=//p' || true)
if [[ -n $owner && ! $owner =~ ^phil(-engine)?$ ]]; then
  echo "\"Show in folder\" goes to $owner for as long as it's running; it switches to phil once $owner has quit."
fi
