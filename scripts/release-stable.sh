#!/usr/bin/env bash
# Compatibility entrypoint. The cross-platform Node state machine owns releases.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/client/release.mjs" --channel stable "$@"
