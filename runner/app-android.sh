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
FILE="$RUNNER_TEMP/ready/.maestro/$FLOW.yaml"; [ -f "$FILE" ] || { echo "no flow $FLOW"; exit 1; }
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
# The emulator's launcher (Pixel Launcher on google_apis, Quickstep on AOSP) froze while the app was being installed
# and raised "... isn't responding" over the app in 4 of 6 runs (2026-11-23). The flows never need a home screen:
# switch the launchers off (a dialog of a stopped app goes with it) and hide system error dialogs. No watcher runs
# during the flow: a second UiAutomation client would fight Maestro's.
for pkg in com.android.launcher3 com.google.android.apps.nexuslauncher; do
  adb shell pm disable-user --user 0 "$pkg" > /dev/null 2>&1 && echo "launcher off: $pkg" >> "$OUT/checks.txt"
done
adb shell settings put global hide_error_dialogs 1 > /dev/null 2>&1 || true
status=0
( cd "$OUT" && maestro test --format junit --output "$OUT/junit.xml" --test-output-dir "$OUT/maestro" "$FILE" ) > "$OUT/maestro.log" 2>&1 || status=1
grep -E "^\[(Passed|Failed)\]" "$OUT/maestro.log" | sed -E 's/ \(.*//' || true # details stay in the sealed artifact
adb logcat -d -t 2000 '*:E' | grep -iE "ReactNative|AndroidRuntime|FATAL|$APP_ID" | tail -200 > "$OUT/logcat-errors.txt" || true
exit $status
