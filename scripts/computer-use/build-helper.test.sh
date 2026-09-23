#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SOURCE="$TMP/source"
TARGET="x86_64-pc-windows-msvc"
mkdir -p "$SOURCE/libs/cua-driver/rust/target/$TARGET/release" "$TMP/bin"
mkdir -p "$SOURCE/libs/cua-driver/rust/crates/platform-macos/src/tools" \
  "$SOURCE/libs/cua-driver/rust/crates/cua-driver-core/src"
printf 'com.nuwax-ai.nuwax-computer-use\n' > \
  "$SOURCE/libs/cua-driver/rust/crates/platform-macos/src/tools/check_permissions.rs"
printf 'NUWAX_TOKEN_FILE_ENV\n' > \
  "$SOURCE/libs/cua-driver/rust/crates/cua-driver-core/src/daemon.rs"
printf 'windows-cua-binary' > "$SOURCE/libs/cua-driver/rust/target/$TARGET/release/cua-driver.exe"

cat > "$TMP/bin/rustup" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$TMP/bin/cargo" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TMP/bin/rustup" "$TMP/bin/cargo"

PATH="$TMP/bin:$PATH" NUWAX_CUA_SOURCE_DIR="$SOURCE" \
  TARGET_TRIPLE="$TARGET" OUT_DIR="$TMP/out" \
  bash "$SCRIPT_DIR/build-helper.sh" >/dev/null
cmp "$SOURCE/libs/cua-driver/rust/target/$TARGET/release/cua-driver.exe" \
  "$TMP/out/NuwaxComputerUse.exe"
echo "Windows helper artifact path: OK"
