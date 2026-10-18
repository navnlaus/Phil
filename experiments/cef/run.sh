#!/bin/sh
# Builds cef-host and runs it from app/, CEF's files beside it (linked, not copied:
# libcef.so is 1.4 GB with its symbols). CEF itself is downloaded by the build
# (once, to ~/.local/share/cef); building it needs cmake and ninja. The newest
# CEF there is the one run (CEF_VERSION=154.0.34 for another): one built for an
# older CEF's API runs on a newer one (156 has the NVIDIA fix shared textures need).
set -e
cd "$(dirname "$0")"
export CEF_PATH="${CEF_PATH:-$HOME/.local/share/cef}"
cargo build --release --quiet
cef="$(find "$CEF_PATH/${CEF_VERSION:-}" -maxdepth 3 -name libcef.so -printf '%h\n' | sort -V | tail -1)"
[ -n "$cef" ] || { echo "No libcef.so in $CEF_PATH" >&2; exit 1; }
mkdir -p app
find app -maxdepth 1 -type l -delete # (another CEF's, before)
for f in "$cef"/*; do
  case "$(basename "$f")" in include|libcef_dll|cmake|CMakeLists.txt|archive.json|CREDITS.html) ;; *) ln -sfn "$f" app/ ;; esac
done
cp target/release/cef-host app/
echo "CEF: $cef" >&2
exec app/cef-host "$@"
