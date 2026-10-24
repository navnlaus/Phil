#!/usr/bin/env bash
# Builds phil's Android app (android/: the phone link) into android/build/phil.apk,
# without Gradle: javac, d8, aapt2, zipalign and apksigner from the Android SDK.
#
#   ANDROID_HOME  the SDK (default ~/Android/Sdk): build-tools and platforms below
#   JAVA_HOME     a JDK 17 or later (default ~/Android/jdk, else the one on PATH)
#
# Its libraries (libs.txt: Apache MINA SSHD, the SFTP server; SLF4J) come from
# Maven Central, checked against the SHA-256s there, and are kept in
# ~/.cache/phil/android-libs. It's signed with a key of its own, made the first
# time in ~/.local/share/phil/android (keep it: an update must be signed by the
# same key, or Android won't install it over the old one).
set -euo pipefail
cd "$(dirname "$0")"

SDK=${ANDROID_HOME:-$HOME/Android/Sdk}
BUILD_TOOLS=36.1.0
PLATFORM=android-36
MIN_SDK=26
if [[ -z ${JAVA_HOME:-} && -x $HOME/Android/jdk/bin/javac ]]; then JAVA_HOME=$HOME/Android/jdk; fi
javabin=${JAVA_HOME:+$JAVA_HOME/bin/}
bt=$SDK/build-tools/$BUILD_TOOLS
jar=$SDK/platforms/$PLATFORM/android.jar
for need in "$bt/aapt2" "$bt/d8" "$jar"; do
  [[ -e $need ]] || { echo "build.sh: $need missing (sdkmanager \"build-tools;$BUILD_TOOLS\" \"platforms;$PLATFORM\")" >&2; exit 1; }
done
export JAVA_HOME PATH="${JAVA_HOME:+$JAVA_HOME/bin:}$PATH"

# The libraries.
libs=${XDG_CACHE_HOME:-$HOME/.cache}/phil/android-libs
mkdir -p "$libs"
jars=()
while read -r path sum; do
  [[ -z $path || $path == \#* ]] && continue
  file=$libs/$(basename "$path")
  if [[ ! -f $file ]] || ! echo "$sum  $file" | sha256sum -c --quiet - 2>/dev/null; then
    curl -sSfL -o "$file.tmp" "https://repo1.maven.org/maven2/$path"
    echo "$sum  $file.tmp" | sha256sum -c --quiet - || { echo "build.sh: $path isn't what libs.txt says" >&2; rm -f "$file.tmp"; exit 1; }
    mv "$file.tmp" "$file"
  fi
  jars+=("$file")
done < libs.txt

# Its version: phil's commit count (the code goes up with each), and the commit.
code=$(git rev-list --count HEAD 2>/dev/null || echo 1)
name="1.0.$code"

out=build
rm -rf "$out/classes" "$out/dex" "$out/gen" "$out"/*.apk "$out/res.zip"
mkdir -p "$out/classes" "$out/dex" "$out/gen"

# The assets, with phil's look built in (the shared styles and the default theme,
# from themes/: what the light phil wears until it has the PC's).
rm -rf "$out/assets"
mkdir -p "$out/assets"
cp -r assets/. "$out/assets/"
cp ../themes/base.css "$out/assets/www/theme-base.css"
cp ../themes/overlay.css "$out/assets/www/theme-theme.css"

"$bt/aapt2" compile --dir res -o "$out/res.zip"
"$bt/aapt2" link -I "$jar" --manifest AndroidManifest.xml -A "$out/assets" \
  --min-sdk-version $MIN_SDK --target-sdk-version "${PLATFORM#android-}" \
  --version-code "$code" --version-name "$name" \
  --java "$out/gen" -o "$out/unsigned.apk" "$out/res.zip"

classpath=$(IFS=:; echo "$jar:${jars[*]}")
"${javabin}javac" -nowarn -Xlint:-options --release 17 -classpath "$classpath" -d "$out/classes" \
  $(find src "$out/gen" -name '*.java')
"$bt/d8" --release --min-api $MIN_SDK --lib "$jar" --output "$out/dex" \
  $(find "$out/classes" -name '*.class') "${jars[@]}"
(cd "$out/dex" && zip -q -X ../unsigned.apk classes*.dex)

"$bt/zipalign" -f -p 4 "$out/unsigned.apk" "$out/aligned.apk"

# The signing key, made the first time.
keys=${XDG_DATA_HOME:-$HOME/.local/share}/phil/android
if [[ ! -f $keys/release.jks ]]; then
  mkdir -p "$keys"
  chmod 700 "$keys"
  (umask 077; head -c 24 /dev/urandom | base64 | tr -d '/+=' > "$keys/password")
  "${javabin}keytool" -genkeypair -keystore "$keys/release.jks" -storepass:file "$keys/password" -alias phil \
    -keyalg EC -groupname secp256r1 -validity 36500 -dname "CN=phil" >/dev/null 2>&1
  chmod 600 "$keys/release.jks"
fi
"$bt/apksigner" sign --ks "$keys/release.jks" --ks-pass "file:$keys/password" --ks-key-alias phil \
  --out "$out/phil.apk" "$out/aligned.apk"
rm -f "$out/unsigned.apk" "$out/aligned.apk" "$out/phil.apk.idsig"
echo "android/$out/phil.apk ($name, $(du -h "$out/phil.apk" | cut -f1))"
