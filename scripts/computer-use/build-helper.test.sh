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
mkdir -p "$SOURCE/libs/cua-driver/rust/crates/cua-driver/src"
printf 'mod nuwax_tasks;\n' > "$SOURCE/libs/cua-driver/rust/crates/cua-driver/src/main.rs"
printf 'nuwax_window_preview\n' > "$SOURCE/libs/cua-driver/rust/crates/cua-driver/src/serve.rs"
printf 'windows-cua-binary' > "$SOURCE/libs/cua-driver/rust/target/$TARGET/release/cua-driver.exe"

cat > "$TMP/bin/rustup" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$TMP/bin/cargo" <<'EOF'
#!/usr/bin/env bash
if [ -n "${EXPECTED_LINKER:-}" ]; then
  [ "$(command -v link.exe)" = "$EXPECTED_LINKER" ] || exit 91
fi
exit 0
EOF
chmod +x "$TMP/bin/rustup" "$TMP/bin/cargo"

PATH="$TMP/bin:$PATH" NUWAX_CUA_SOURCE_DIR="$SOURCE" \
  TARGET_TRIPLE="$TARGET" OUT_DIR="$TMP/out" \
  bash "$SCRIPT_DIR/build-helper.sh" >/dev/null
cmp "$SOURCE/libs/cua-driver/rust/target/$TARGET/release/cua-driver.exe" \
  "$TMP/out/NuwaxComputerUse.exe"
echo "Windows helper artifact path: OK"

# Git Bash's Unix link.exe must not shadow the vcvars MSVC linker.
mkdir -p "$TMP/vs/bin/Hostx64/x64"
touch "$TMP/bin/link.exe" "$TMP/vs/bin/Hostx64/x64/link.exe"
chmod +x "$TMP/bin/link.exe" "$TMP/vs/bin/Hostx64/x64/link.exe"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$2"\n' > "$TMP/bin/cygpath"
chmod +x "$TMP/bin/cygpath"
PATH="$TMP/bin:$PATH" NUWAX_CUA_SOURCE_DIR="$SOURCE" \
  VCToolsInstallDir="$TMP/vs" VSCMD_ARG_HOST_ARCH=x64 VSCMD_ARG_TGT_ARCH=x64 \
  EXPECTED_LINKER="$TMP/vs/bin/Hostx64/x64/link.exe" \
  TARGET_TRIPLE="$TARGET" OUT_DIR="$TMP/msvc-out" \
  bash "$SCRIPT_DIR/build-helper.sh" >/dev/null
echo "MSVC linker keeps precedence over Git Bash: OK"
