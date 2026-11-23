#!/usr/bin/env bash
# Runs inside android-emulator-runner: installs the release APK, runs the app's Maestro flows in light mode, then in
# dark mode with font scale 2.0; records APK size, permissions and backup rules from the merged manifest.
set -uo pipefail
OUT="$PWD/out/android"; mkdir -p "$OUT/light" "$OUT/dark-large"
APK=$(ls app/android/app/build/outputs/apk/release/*.apk | head -1)
[ -n "$APK" ] || { echo "no APK built"; exit 1; }
AAPT=$(ls -d "$ANDROID_HOME"/build-tools/*/ | sort -V | tail -1)aapt2
{ echo "apk_bytes=$(stat -c %s "$APK") (x86_64 only)"
  "$AAPT" dump permissions "$APK" | sed 's/^/manifest: /'
  unzip -l "$APK" | awk '/lib\/.*\.so$/ {print "so: " $4 " " $1}'
  "$AAPT" dump xmltree --file AndroidManifest.xml "$APK" | grep -E "allowBackup|fullBackupContent|dataExtractionRules" | sed 's/^ */manifest: /'
} > "$OUT/checks.txt"
adb install -r "$APK"
FLOWS="$PWD/app/.maestro"
status=0
run_flows() {
  local dir="$1"; shift
  ( cd "$dir" && maestro test --format junit --output "$dir/junit.xml" --test-output-dir "$dir/maestro" "$@" ) > "$dir/maestro.log" 2>&1 || status=1
  grep -E "^\[(Passed|Failed)\]" "$dir/maestro.log" | sed -E 's/ \(.*//' || true # details stay in the sealed artifact
}
adb shell cmd uimode night no
# Every flow the app ships (.maestro/*.yaml, in name order) runs in light mode.
shopt -s nullglob; LIGHT_FLOWS=("$FLOWS"/*.yaml); shopt -u nullglob
run_flows "$OUT/light" "${LIGHT_FLOWS[@]}"
adb shell cmd uimode night yes
adb shell settings put system font_scale 2.0
adb shell am force-stop "$APP_ID"
sleep 3
run_flows "$OUT/dark-large" "$FLOWS/03-man-hinh.yaml"
adb logcat -d -t 2000 '*:E' | grep -iE "ReactNative|AndroidRuntime|FATAL|$APP_ID" | tail -200 > "$OUT/logcat-errors.txt" || true
exit $status
