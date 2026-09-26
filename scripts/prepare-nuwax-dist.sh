#!/usr/bin/env bash
# CI compatibility entry; default validation uses HEAD:nuwax.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT/scripts/prepare-nuwax-dist.mjs" "$@"
