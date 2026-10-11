#!/usr/bin/env bash
# Builds phil, installs it to ~/.local/bin and makes it the default file manager:
#  - folders opened with xdg-open and most apps (the inode/directory MIME default)
#  - "Show in folder" from browsers, file pickers and portals, which use the
#    org.freedesktop.FileManager1 D-Bus service instead of the MIME default
set -euo pipefail
cd "$(dirname "$0")/.."

data=${XDG_DATA_HOME:-$HOME/.local/share}
bin=${PHIL_BIN:-$HOME/.local/bin/phil}

deno task compile
install -Dm755 phil "$bin"
install -d "$data/applications" "$data/dbus-1/services"
sed "s|@BIN@|$bin|g" data/phil.desktop > "$data/applications/phil.desktop"
sed "s|@BIN@|$bin|g" data/org.freedesktop.FileManager1.service > "$data/dbus-1/services/org.freedesktop.FileManager1.service"
update-desktop-database "$data/applications" 2>/dev/null || true
xdg-mime default phil.desktop inode/directory
# Have the session bus pick up the new service file.
busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus ReloadConfig >/dev/null 2>&1 || true
# A FileManager1 service still running the previous build: stop it, D-Bus
# starts the new one on the next request.
service=$(busctl --user status org.freedesktop.FileManager1 2>/dev/null || true)
if [[ $(sed -n 's/^Comm=//p' <<<"$service") == phil ]]; then
  kill "$(sed -n 's/^PID=//p' <<<"$service")" 2>/dev/null || true
fi

echo "Installed $bin"
echo "Folders open with: $(xdg-mime query default inode/directory)"
owner=$(busctl --user status org.freedesktop.FileManager1 2>/dev/null | sed -n 's/^Comm=//p' || true)
if [[ -n $owner && $owner != phil ]]; then
  echo "\"Show in folder\" goes to $owner for as long as it's running; it switches to phil once $owner has quit."
fi
