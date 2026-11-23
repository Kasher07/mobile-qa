#!/usr/bin/env bash
# JS-only change: reuse the release APK built by an earlier run (same native fingerprint and media files, checked by
# the client), replace assets/index.android.bundle with a fresh Hermes bundle, align and sign it with a throwaway key.
# Skips prebuild and Gradle (about 12 minutes).
set -euo pipefail
APKDIR="$PWD/app/android/app/build/outputs/apk/release"
mkdir -p "$APKDIR"
T="$RUNNER_TEMP/jsbuild"; mkdir -p "$T/assets"
mv "$RUNNER_TEMP/shell-android.tgz" "$T/shell.tgz"
tar -xzf "$T/shell.tgz" -C "$T"
SHELL_APK=$(ls "$T"/*.apk | head -1)
unzip -l "$SHELL_APK" | grep -q "assets/index.android.bundle" || { echo "reused APK has no JS bundle"; exit 1; }
cd app
ENTRY=$(node -e "require('expo/scripts/resolveAppEntry')" "$PWD" android absolute | tail -n 1)
HERMESC="$PWD/node_modules/hermes-compiler/hermesc/linux64-bin/hermesc"
[ -x "$HERMESC" ] || chmod +x "$HERMESC" 2>/dev/null || true
[ -x "$HERMESC" ] || { echo "hermesc not found"; exit 1; }
NODE_ENV=production npx expo export:embed --platform android --dev false --reset-cache --entry-file "$ENTRY" \
  --bundle-output "$T/index.android.js" --assets-dest "$T/res" > "$RUNNER_TEMP/jsbundle.log" 2>&1 || { echo "JS bundle failed"; exit 1; }
"$HERMESC" -emit-binary -max-diagnostic-width=80 -O -out "$T/assets/index.android.bundle" "$T/index.android.js" >> "$RUNNER_TEMP/jsbundle.log" 2>&1 \
  || { echo "hermesc failed"; exit 1; }
cp "$SHELL_APK" "$T/work.apk"
( cd "$T" && zip -q -d work.apk 'META-INF/*.SF' 'META-INF/*.RSA' 'META-INF/*.EC' 'META-INF/MANIFEST.MF' 2>/dev/null || true
  zip -q -0 work.apk assets/index.android.bundle )
BT=$(ls -d "$ANDROID_HOME"/build-tools/*/ | sort -V | tail -1)
"$BT/zipalign" -p -f 4 "$T/work.apk" "$T/aligned.apk"
keytool -genkeypair -keystore "$T/qa.jks" -storepass android -keypass android -alias qa -keyalg RSA -keysize 2048 \
  -validity 2 -dname CN=app-qa -noprompt > /dev/null 2>&1
"$BT/apksigner" sign --ks "$T/qa.jks" --ks-pass pass:android --key-pass pass:android --out "$APKDIR/app-release.apk" "$T/aligned.apk"
rm -f "$T/qa.jks"
echo "JS replaced in the reused APK"
