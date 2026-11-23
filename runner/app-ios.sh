#!/usr/bin/env bash
# Boots the newest plain iPhone simulator, installs the release .app, runs the app's Maestro flows in light mode, then
# in dark mode with the largest accessibility text size; records app size and the iCloud backup exclusion of the
# app's Bible folder. Results in out/ios.
set -uo pipefail
OUT="$PWD/out/ios"; mkdir -p "$OUT/light" "$OUT/dark-large"
APP=$(find "$RUNNER_TEMP/dd/Build/Products/Release-iphonesimulator" -maxdepth 1 -name "*.app" | head -1)
[ -n "$APP" ] || { echo "no .app built"; exit 1; }
du -sk "$APP" | awk '{print "app_kb=" $1}' > "$OUT/checks.txt"
# A fresh build goes back to the caller (sealed), so the next JS-only run can reuse it.
[[ ",${REUSE:-}," == *",ios,"* ]] || tar -czf "$OUT/shell.tgz" -C "$(dirname "$APP")" "$(basename "$APP")"
UDID=$(xcrun simctl list devices available -j | node -e '
  const j = JSON.parse(require("fs").readFileSync(0, "utf8")).devices;
  const rts = Object.keys(j).filter((k) => /iOS/.test(k)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  for (const rt of rts.reverse()) { const d = j[rt].find((x) => /^iPhone \d+( Pro)?$/.test(x.name)) || j[rt].find((x) => /^iPhone/.test(x.name)); if (d) { console.log(d.udid); break; } }')
[ -n "$UDID" ] || { echo "no iPhone simulator"; exit 1; }
xcrun simctl boot "$UDID" || true
xcrun simctl bootstatus "$UDID" -b
xcrun simctl list devices | grep "$UDID" | sed 's/^ */device=/' >> "$OUT/checks.txt"
xcrun simctl ui "$UDID" appearance light
xcrun simctl install "$UDID" "$APP"
FLOWS="$PWD/app/.maestro"
status=0
# Flow lists come from the caller (FLOWS_LIGHT, FLOWS_DARK: comma-separated names without .yaml; checked here too).
pick() {
  local spec="$1" f; local -a names
  [[ "$spec" == "*" || "$spec" =~ ^[A-Za-z0-9._,-]*$ ]] || { echo "bad flow list" >&2; return; }
  if [ "$spec" = "*" ]; then shopt -s nullglob; for f in "$FLOWS"/*.yaml; do echo "$f"; done; shopt -u nullglob; return; fi
  IFS=',' read -ra names <<< "$spec"
  for f in "${names[@]}"; do [ -z "$f" ] && continue; if [ -f "$FLOWS/$f.yaml" ]; then echo "$FLOWS/$f.yaml"; else echo "flow not found: $f" >&2; status=1; fi; done
}
run_flows() { # $1 = output folder, $2.. = flows
  local dir="$1"; shift
  ( cd "$dir" && maestro --device "$UDID" test --format junit --output "$dir/junit.xml" --test-output-dir "$dir/maestro" "$@" ) > "$dir/maestro.log" 2>&1 || status=1
  grep -E "^\[(Passed|Failed)\]" "$dir/maestro.log" | sed -E 's/ \(.*//' || true # details stay in the sealed artifact
}
mapfile -t LIGHT < <(pick "${FLOWS_LIGHT:-*}")
[ ${#LIGHT[@]} -gt 0 ] && run_flows "$OUT/light" "${LIGHT[@]}"
DATA=$(xcrun simctl get_app_container "$UDID" "$APP_ID" data 2>/dev/null)
if [ -n "$DATA" ] && [ -d "$DATA/Documents/bible" ]; then
  { echo "bible_files=$(ls "$DATA/Documents/bible" | tr '\n' ' ')"
    echo "bible_dir_backup_excluded=$(xattr -p com.apple.metadata:com_apple_backup_excludeItem "$DATA/Documents/bible" >/dev/null 2>&1 && echo yes || echo no)"
    for f in "$DATA"/Documents/bible/*.db; do echo "file_backup_excluded $(basename "$f")=$(xattr -p com.apple.metadata:com_apple_backup_excludeItem "$f" >/dev/null 2>&1 && echo yes || echo no)"; done
  } >> "$OUT/checks.txt"
else
  echo "bible_dir=missing" >> "$OUT/checks.txt"
fi
mapfile -t DARK < <(pick "${FLOWS_DARK:-}")
if [ ${#DARK[@]} -gt 0 ]; then
  xcrun simctl ui "$UDID" appearance dark
  xcrun simctl ui "$UDID" content_size accessibility-extra-extra-extra-large
  xcrun simctl terminate "$UDID" "$APP_ID" || true
  run_flows "$OUT/dark-large" "${DARK[@]}"
fi
exit $status
