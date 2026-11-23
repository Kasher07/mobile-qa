#!/usr/bin/env bash
# One shard, inside android-emulator-runner: installs the prepared release APK and runs one Maestro flow (FLOW) in
# light mode, or with PASS=dark in dark mode at font scale 2.0; records APK size, permissions and backup rules.
# Results in out/android-<pass>-<flow>.
set -uo pipefail
[[ "${FLOW:-}" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad FLOW"; exit 1; }
PASS="${PASS:-light}"; [[ "$PASS" =~ ^(light|dark)$ ]] || { echo "bad PASS"; exit 1; }
OUT="$PWD/out/android-$PASS-$FLOW"; mkdir -p "$OUT"
APK=$(ls "$RUNNER_TEMP"/ready/*.apk | head -1)
[ -n "$APK" ] || { echo "no prepared APK"; exit 1; }
FILE="$PWD/app/.maestro/$FLOW.yaml"; [ -f "$FILE" ] || { echo "no flow $FLOW"; exit 1; }
AAPT=$(ls -d "$ANDROID_HOME"/build-tools/*/ | sort -V | tail -1)aapt2
{ echo "apk_bytes=$(stat -c %s "$APK") (x86_64 only)"
  "$AAPT" dump permissions "$APK" | sed 's/^/manifest: /'
  unzip -l "$APK" | awk '/lib\/.*\.so$/ {print "so: " $4 " " $1}'
  "$AAPT" dump xmltree --file AndroidManifest.xml "$APK" | grep -E "allowBackup|fullBackupContent|dataExtractionRules" | sed 's/^ */manifest: /'
} > "$OUT/checks.txt"
adb install -r "$APK"
if [ "$PASS" = dark ]; then
  adb shell cmd uimode night yes
  adb shell settings put system font_scale 2.0
else
  adb shell cmd uimode night no
fi
# A cold emulator's launcher can raise "Pixel Launcher isn't responding" over the app (2026-11-23, and 2026-11-23
# app-qa round 1). That dialog belongs to the emulator, not the app: answer "Wait" (BACK) whenever it holds the focus.
( while true; do
    if adb shell dumpsys window 2>/dev/null | grep -qE "mCurrentFocus=.*Application Not Responding"; then
      adb shell input keyevent KEYCODE_BACK; echo "system ANR dialog dismissed" >> "$OUT/checks.txt"
    fi
    sleep 2
  done ) &
ANR_WATCH=$!
status=0
( cd "$OUT" && maestro test --format junit --output "$OUT/junit.xml" --test-output-dir "$OUT/maestro" "$FILE" ) > "$OUT/maestro.log" 2>&1 || status=1
grep -E "^\[(Passed|Failed)\]" "$OUT/maestro.log" | sed -E 's/ \(.*//' || true # details stay in the sealed artifact
kill "$ANR_WATCH" 2>/dev/null || true
adb logcat -d -t 2000 '*:E' | grep -iE "ReactNative|AndroidRuntime|FATAL|$APP_ID" | tail -200 > "$OUT/logcat-errors.txt" || true
exit $status
