#!/usr/bin/env bash
# Installs the pinned Maestro CLI release and checks its sha256. The zip is kept in ~/maestro-cache (actions/cache,
# keyed by version), so a shard job skips the ~30-90 s download; the checksum is checked either way.
set -euo pipefail
mkdir -p ~/maestro-cache
ZIP=~/maestro-cache/maestro-$MAESTRO_VERSION.zip
[ -f "$ZIP" ] || curl -fsSL "https://github.com/mobile-dev-inc/maestro/releases/download/$MAESTRO_VERSION/maestro.zip" -o "$ZIP"
echo "$MAESTRO_SHA256  $ZIP" | (shasum -a 256 -c - 2>/dev/null || sha256sum -c -)
unzip -q "$ZIP" -d "$RUNNER_TEMP"
echo "$RUNNER_TEMP/maestro/bin" >> "$GITHUB_PATH"
"$RUNNER_TEMP/maestro/bin/maestro" --version
