#!/usr/bin/env bash
# JS-only change: reuse the release .app built by an earlier run (same native fingerprint and media files, checked by
# the client) and replace only its JavaScript, the way Xcode's "Bundle React Native code and images" phase makes it
# (expo export:embed, then Hermes bytecode). Skips prebuild, pods and xcodebuild (about 12 minutes).
set -euo pipefail
D="$RUNNER_TEMP/dd/Build/Products/Release-iphonesimulator"
mkdir -p "$D"
tar -xzf "$RUNNER_TEMP/shell-ios.tgz" -C "$D"
rm -f "$RUNNER_TEMP/shell-ios.tgz"
APP=$(find "$D" -maxdepth 1 -name "*.app" | head -1)
[ -n "$APP" ] && [ -f "$APP/main.jsbundle" ] || { echo "reused app has no main.jsbundle"; exit 1; }
cd app
ENTRY=$(node -e "require('expo/scripts/resolveAppEntry')" "$PWD" ios absolute | tail -n 1)
HERMESC="$PWD/node_modules/hermes-compiler/hermesc/osx-bin/hermesc"
[ -x "$HERMESC" ] || { echo "hermesc not found"; exit 1; }
T="$RUNNER_TEMP/jsbuild"; mkdir -p "$T"
NODE_ENV=production npx expo export:embed --platform ios --dev false --reset-cache --entry-file "$ENTRY" \
  --bundle-output "$T/main.jsbundle" --assets-dest "$APP" > "$RUNNER_TEMP/jsbundle.log" 2>&1 || { echo "JS bundle failed"; exit 1; }
"$HERMESC" -emit-binary -max-diagnostic-width=80 -O -out "$APP/main.jsbundle" "$T/main.jsbundle" >> "$RUNNER_TEMP/jsbundle.log" 2>&1 \
  || { echo "hermesc failed"; exit 1; }
echo "JS replaced in the reused app"
