#!/usr/bin/env bash
# One shard: boots the newest plain iPhone simulator, installs the prepared release .app and runs one Maestro flow
# (FLOW, name without .yaml) in light mode, or with PASS=dark in dark mode at the largest accessibility text size.
# Records app size and the iCloud backup exclusion of the app's Bible folder. Results in out/ios-<pass>-<flow>.
set -uo pipefail
[[ "${FLOW:-}" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad FLOW"; exit 1; }
PASS="${PASS:-light}"; [[ "$PASS" =~ ^(light|dark)$ ]] || { echo "bad PASS"; exit 1; }
OUT="$PWD/out/ios-$PASS-$FLOW"; mkdir -p "$OUT"
APP=$(find "$RUNNER_TEMP/ready" -maxdepth 1 -name "*.app" | head -1)
[ -n "$APP" ] || { echo "no prepared .app"; exit 1; }
FILE="$PWD/app/.maestro/$FLOW.yaml"; [ -f "$FILE" ] || { echo "no flow $FLOW"; exit 1; }
du -sk "$APP" | awk '{print "app_kb=" $1}' > "$OUT/checks.txt"
UDID=$(xcrun simctl list devices available -j | node -e '
  const j = JSON.parse(require("fs").readFileSync(0, "utf8")).devices;
  const rts = Object.keys(j).filter((k) => /iOS/.test(k)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  for (const rt of rts.reverse()) { const d = j[rt].find((x) => /^iPhone \d+( Pro)?$/.test(x.name)) || j[rt].find((x) => /^iPhone/.test(x.name)); if (d) { console.log(d.udid); break; } }')
[ -n "$UDID" ] || { echo "no iPhone simulator"; exit 1; }
xcrun simctl boot "$UDID" || true
xcrun simctl bootstatus "$UDID" -b > /dev/null
xcrun simctl list devices | grep "$UDID" | sed 's/^ */device=/' >> "$OUT/checks.txt"
if [ "$PASS" = dark ]; then
  xcrun simctl ui "$UDID" appearance dark
  xcrun simctl ui "$UDID" content_size accessibility-extra-extra-extra-large
else
  xcrun simctl ui "$UDID" appearance light
fi
xcrun simctl install "$UDID" "$APP"
status=0
( cd "$OUT" && maestro --device "$UDID" test --format junit --output "$OUT/junit.xml" --test-output-dir "$OUT/maestro" "$FILE" ) > "$OUT/maestro.log" 2>&1 || status=1
grep -E "^\[(Passed|Failed)\]" "$OUT/maestro.log" | sed -E 's/ \(.*//' || true # details stay in the sealed artifact
DATA=$(xcrun simctl get_app_container "$UDID" "$APP_ID" data 2>/dev/null)
if [ -n "$DATA" ] && [ -d "$DATA/Documents/bible" ]; then
  { echo "bible_files=$(ls "$DATA/Documents/bible" | tr '\n' ' ')"
    echo "bible_dir_backup_excluded=$(xattr -p com.apple.metadata:com_apple_backup_excludeItem "$DATA/Documents/bible" >/dev/null 2>&1 && echo yes || echo no)"
    for f in "$DATA"/Documents/bible/*.db; do echo "file_backup_excluded $(basename "$f")=$(xattr -p com.apple.metadata:com_apple_backup_excludeItem "$f" >/dev/null 2>&1 && echo yes || echo no)"; done
  } >> "$OUT/checks.txt"
fi
exit $status
