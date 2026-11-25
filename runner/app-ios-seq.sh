#!/usr/bin/env bash
# iOS on one Mac (Codemagic M2): boots one simulator, warms its TLS trust, installs the prepared .app, then runs the
# light-mode flows in a single Maestro session (one XCTest driver start instead of one per flow) and the dark +
# largest-text flows after switching the simulator's look. SHARDS: JSON list of {flow, pass}. Results in
# out/ios-light-<flow> / out/ios-dark-<flow>, one folder per flow like the GitHub shards. A shard with pass "widgets" runs
# the widget step (runner/app-widgets.mjs) after the light flows, before the simulator switches to dark + largest text.
set -uo pipefail
APP=$(find "$APP_READY" -maxdepth 1 -name "*.app" | head -1)
[ -n "$APP" ] || { echo "no prepared .app"; exit 1; }
FLOWS="$APP_READY/.maestro"
LIGHT=($(node -e 'for (const s of JSON.parse(process.env.SHARDS)) if (s.pass === "light" && /^[A-Za-z0-9._-]+$/.test(s.flow)) console.log(s.flow)')) # macOS bash 3.2 has no mapfile; flow names have no spaces
DARK=($(node -e 'for (const s of JSON.parse(process.env.SHARDS)) if (s.pass === "dark" && /^[A-Za-z0-9._-]+$/.test(s.flow)) console.log(s.flow)'))
UDID=$(xcrun simctl list devices available -j | node -e '
  const j = JSON.parse(require("fs").readFileSync(0, "utf8")).devices;
  const rts = Object.keys(j).filter((k) => /iOS/.test(k)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  for (const rt of rts.reverse()) { const d = j[rt].find((x) => /^iPhone \d+( Pro)?$/.test(x.name)) || j[rt].find((x) => /^iPhone/.test(x.name)); if (d) { console.log(d.udid); break; } }')
[ -n "$UDID" ] || { echo "no iPhone simulator"; exit 1; }
xcrun simctl boot "$UDID" || true
xcrun simctl bootstatus "$UDID" -b > /dev/null
xcrun simctl ui "$UDID" appearance light
# A freshly booted simulator's trust daemon is cold: the app's first HTTPS handshake was cancelled in certificate
# verification (2026-11-23, -1200). One HTTPS page in Safari warms it.
xcrun simctl openurl "$UDID" https://www.apple.com > /dev/null 2>&1 || true
sleep 6
xcrun simctl terminate "$UDID" com.apple.mobilesafari > /dev/null 2>&1 || true
xcrun simctl install "$UDID" "$APP"
status=0
run_pass() { # $1 = light|dark, $2.. = flow names; one Maestro session, results split per flow afterwards
  local pass="$1"; shift
  local dir="$PWD/out/ios-$pass-session"; mkdir -p "$dir"
  local files=(); for f in "$@"; do files+=("$FLOWS/$f.yaml"); done
  ( cd "$dir" && maestro --device "$UDID" test --format junit --output "$dir/junit.xml" --test-output-dir "$dir/maestro" "${files[@]}" ) > "$dir/maestro.log" 2>&1 || status=1
  grep -E "^\[(Passed|Failed)\]" "$dir/maestro.log" | sed -E 's/ \(.*//' || true
  node runner/app-split-junit.mjs "$dir" "$pass" "$PWD/out" "$@"
}
WIDGETS_STEP=$(node -e 'console.log(JSON.parse(process.env.SHARDS).some((s) => s.pass === "widgets") ? "yes" : "")')
[ ${#LIGHT[@]} -eq 0 ] && [ ${#DARK[@]} -eq 0 ] && [ -z "$WIDGETS_STEP" ] && { echo "no flows to run"; exit 1; }
[ ${#LIGHT[@]} -gt 0 ] && run_pass light "${LIGHT[@]}"
if [ -n "$WIDGETS_STEP" ]; then
  mkdir -p "$PWD/out/ios-widgets-home"
  OUT="$PWD/out/ios-widgets-home" UDID="$UDID" FLOWS="$FLOWS" node runner/app-widgets.mjs ios > "$PWD/out/ios-widgets-home/maestro.log" 2>&1 || status=1
  grep -E "^\[widgets" "$PWD/out/ios-widgets-home/maestro.log" | sed -E 's/ - .*//' || true
  xcrun simctl ui "$UDID" appearance light
fi
DATA=$(xcrun simctl get_app_container "$UDID" "$APP_ID" data 2>/dev/null)
{ du -sk "$APP" | awk '{print "app_kb=" $1}'
  xcrun simctl list devices | grep "$UDID" | sed 's/^ */device=/'
  if [ -n "$DATA" ] && [ -d "$DATA/Documents/bible" ]; then
    echo "bible_dir_backup_excluded=$(xattr -p com.apple.metadata:com_apple_backup_excludeItem "$DATA/Documents/bible" >/dev/null 2>&1 && echo yes || echo no)"
  fi
} > "$PWD/out/ios-checks.txt"
if [ ${#DARK[@]} -gt 0 ]; then
  xcrun simctl ui "$UDID" appearance dark
  xcrun simctl ui "$UDID" content_size accessibility-extra-extra-extra-large
  xcrun simctl terminate "$UDID" "$APP_ID" || true
  run_pass dark "${DARK[@]}"
fi
exit $status
