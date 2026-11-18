#!/usr/bin/env bash
# Installs the pinned Maestro CLI release and checks its sha256.
set -euo pipefail
curl -fsSL "https://github.com/mobile-dev-inc/maestro/releases/download/$MAESTRO_VERSION/maestro.zip" -o "$RUNNER_TEMP/maestro.zip"
echo "$MAESTRO_SHA256  $RUNNER_TEMP/maestro.zip" | (shasum -a 256 -c - 2>/dev/null || sha256sum -c -)
unzip -q "$RUNNER_TEMP/maestro.zip" -d "$RUNNER_TEMP"
echo "$RUNNER_TEMP/maestro/bin" >> "$GITHUB_PATH"
"$RUNNER_TEMP/maestro/bin/maestro" --version
