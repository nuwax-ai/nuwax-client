#!/usr/bin/env bash
# 构建 Computer Use helper（cua-driver 源码自建路线，2026-09-17 拍板）：
#   锁版 clone cua 仓 → apply nuwax 补丁（bundle 身份/私有端点鉴权）→ cargo build
#   → 组装 helper（mac .app / win exe）→ mac 预签 Developer ID（进 extraResources 前签好，
#   electron-builder 按 TCC 稳定性要求：同 Team + 同 bundle id 跨版本保授权）。
#
# 产物落 OUT_DIR：
#   mac: "$OUT_DIR/Nuwax Computer Use.app"（单 .app，可执行名=app 名）
#   win: "$OUT_DIR/NuwaxComputerUse.exe"
#
# 环境变量：
#   CUA_COMMIT            锁定的 cua 仓 commit（默认 85e2b1318，升级须迁移商业补丁并验证原生协议和宿主白名单）
#   CUA_VERSION           写进 Info.plist 的版本串（默认 0.38.0）
#   TARGET_TRIPLE         Rust target（必填，如 aarch64-apple-darwin / x86_64-pc-windows-msvc）
#   OUT_DIR               产物目录（必填，一般=agent-electron-client/resources/computer-use）
#   ICON_ICNS             mac 图标源（默认直接复用商业版主应用的 canonical icon.icns）
#   SIGN_IDENTITY         mac Developer ID 身份（空=ad-hoc 签名，仅 dev 用；产品必须正签）
#   NUWAX_CUA_SOURCE_DIR  本地 dev 直用已有 cua 检出（跳过 clone/patch，须已含补丁）
#   NUWAX_CUA_CACHE_DIR   未签名二进制缓存（默认 .cache/client-toolchain/cua-helper）
#   NUWAX_CUA_NO_CACHE=1  强制重编；本地源码检出始终不读写共享缓存
set -euo pipefail

CUA_COMMIT="${CUA_COMMIT:-85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19}"
CUA_VERSION="${CUA_VERSION:-0.38.0}"
TARGET_TRIPLE="${TARGET_TRIPLE:?TARGET_TRIPLE required}"
OUT_DIR="${OUT_DIR:?OUT_DIR required}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PATCH_FILE="${REPO_ROOT}/docs/computer-use-poc/0001-0003-cua-nuwax-helper-bundle.patch"
WORK_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/cua-build-$$"
trap 'rm -rf "$WORK_DIR"' EXIT

case "$TARGET_TRIPLE" in
  *-apple-darwin)   PLATFORM=mac ;;
  *-windows-*)      PLATFORM=win ;;
  *-unknown-linux-*) PLATFORM=linux ;;
  *)                PLATFORM=other ;;
esac

# ---------- 源码就位（clone+patch 或本地检出） ----------
if [ -n "${NUWAX_CUA_SOURCE_DIR:-}" ]; then
  echo "[cua-helper] 使用本地源码检出: $NUWAX_CUA_SOURCE_DIR"
  SRC_DIR="$NUWAX_CUA_SOURCE_DIR"
else
  [ -f "$PATCH_FILE" ] || { echo "::error::patch not found: $PATCH_FILE"; exit 1; }
  echo "[cua-helper] cloning trycua/cua @ $CUA_COMMIT ..."
  # The driver links the shared telemetry config reader and embeds two static
  # JSON registries. Include their source inputs without fetching media history.
  if [[ "$CUA_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]]; then
    git init --quiet "$WORK_DIR/cua"
    git -C "$WORK_DIR/cua" remote add origin https://github.com/trycua/cua.git
    git -C "$WORK_DIR/cua" fetch --quiet --depth 1 --filter=blob:none origin "$CUA_COMMIT"
  else
    git clone --quiet --filter=blob:none --no-checkout https://github.com/trycua/cua.git "$WORK_DIR/cua"
  fi
  git -C "$WORK_DIR/cua" sparse-checkout set \
    libs/cua-driver/rust libs/cua/crates/cua-telemetry \
    libs/cua/crates/cua-teleport/src/ux libs/images
  git -C "$WORK_DIR/cua" checkout --quiet "$CUA_COMMIT"
  echo "[cua-helper] applying nuwax patch ..."
  # Windows checkout with core.autocrlf may turn this tracked patch into CRLF;
  # Git Bash's git apply rejects that form, so feed it a normalized copy.
  APPLY_PATCH="$WORK_DIR/nuwax-cua-helper.patch"
  tr -d '\r' < "$PATCH_FILE" > "$APPLY_PATCH"
  git -C "$WORK_DIR/cua" apply "$APPLY_PATCH"
  SRC_DIR="$WORK_DIR/cua"
fi

# 本地源码逃逸路径也必须具备同一安全补丁；否则会产出永远无法通过
# Nuwax helper TCC 身份校验、或没有端点能力鉴权的二进制。
grep -q 'com.nuwax-ai.nuwax-computer-use' \
  "$SRC_DIR/libs/cua-driver/rust/crates/platform-macos/src/tools/check_permissions.rs" || {
  echo "::error::Nuwax helper TCC identity patch missing"; exit 1;
}
grep -q 'NUWAX_TOKEN_FILE_ENV' \
  "$SRC_DIR/libs/cua-driver/rust/crates/cua-driver-core/src/daemon.rs" || {
  echo "::error::Nuwax endpoint authentication patch missing"; exit 1;
}

grep -q 'mod nuwax_tasks;' \
  "$SRC_DIR/libs/cua-driver/rust/crates/cua-driver/src/main.rs" || {
  echo "::error::Nuwax window-task boundary patch missing"; exit 1;
}

grep -q 'nuwax_window_preview' \
  "$SRC_DIR/libs/cua-driver/rust/crates/cua-driver/src/serve.rs" || {
  echo "::error::Nuwax window preview capability patch missing"; exit 1;
}

# ---------- 构建 ----------
# Git Bash puts /usr/bin before the inherited Visual Studio PATH. Its link.exe
# is the Unix hard-link utility, so rustc's MSVC host build scripts must resolve
# the linker from the active vcvars environment first.
if [[ "$TARGET_TRIPLE" == *-windows-msvc ]] && [ -n "${VCToolsInstallDir:-}" ] && command -v cygpath >/dev/null 2>&1; then
  MSVC_BIN="$(cygpath -u "$VCToolsInstallDir")/bin/Host${VSCMD_ARG_HOST_ARCH:-x64}/${VSCMD_ARG_TGT_ARCH:-x64}"
  [ ! -f "$MSVC_BIN/link.exe" ] || export PATH="$MSVC_BIN:$PATH"
fi

# Cache only the compiler output. Source/patch checks above still execute on a
# hit, and the app bundle, icon, plist and signing identity are applied afresh.
COMPILE_STARTED=$SECONDS
CACHE_RESULT=disabled
CACHE_ENABLED=false
if [ -z "${NUWAX_CUA_SOURCE_DIR:-}" ] && [ "${NUWAX_CUA_NO_CACHE:-0}" != 1 ]; then
  CACHE_ENABLED=true
fi
CACHED_BIN="$WORK_DIR/unsigned-helper"
if [ "$CACHE_ENABLED" = true ] && node "$REPO_ROOT/scripts/client/native-build-cache.mjs" restore-helper "$SRC_DIR" "$TARGET_TRIPLE" "$CACHED_BIN"; then
  BIN="$CACHED_BIN"
  CACHE_RESULT=hit
else
  [ "$CACHE_ENABLED" != true ] || CACHE_RESULT=miss
  (
    cd "$SRC_DIR/libs/cua-driver/rust" || exit 1
    # Only a cold compiler build needs the target standard library. The locked
    # workspace resolves 1.97.1; a cache hit still identifies that exact compiler
    # and verifies source + patch, but need not download/reinstall target files.
    rustup target add "$TARGET_TRIPLE" || { sleep 5; rustup target add "$TARGET_TRIPLE"; }
    echo "[cua-helper] cargo build --locked --release -p cua-driver --features portal-input ($TARGET_TRIPLE) ..."
    # portal-input=libei 输入通道（GNOME/KDE Wayland；不开则 GNOME Wayland 输入
    # "no input backend" 无兜底）——上游官方 Linux 发行同款开启；纯 Rust 栈（reis）
    # +libxkbcommon-dev，mac/win 为 target-gated 无影响。portal-capture 不开：
    # 截屏主瀑布走免 feature 的 portal.Screenshot，逐窗 PipeWire 仅备用 API 未接线
    cargo build --locked --release -p cua-driver --features portal-input --target "$TARGET_TRIPLE" --target-dir "$SRC_DIR/libs/cua-driver/rust/target"
  )

  BIN="$SRC_DIR/libs/cua-driver/rust/target/$TARGET_TRIPLE/release/cua-driver"
  [ "$PLATFORM" = "win" ] && BIN="${BIN}.exe"
  if [ "$CACHE_ENABLED" = true ]; then
    if ! node "$REPO_ROOT/scripts/client/native-build-cache.mjs" save-helper "$SRC_DIR" "$TARGET_TRIPLE" "$BIN"; then
      echo '::warning::Optional unsigned helper cache save failed; packaging the freshly compiled binary'
    fi
  fi
fi
echo "[cua-helper] compiler cache: $CACHE_RESULT; restore/build elapsed: $((SECONDS - COMPILE_STARTED))s"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '\n- Helper compiler cache: **%s**, restore/build **%ss**; source/patch checked; bundle and signature applied afresh.\n' \
    "$CACHE_RESULT" "$((SECONDS - COMPILE_STARTED))" >> "$GITHUB_STEP_SUMMARY"
fi
[ -f "$BIN" ] || { echo "::error::built binary not found: $BIN"; exit 1; }
BIN_MD5="$(md5 -q "$BIN" 2>/dev/null || md5sum "$BIN" | cut -d' ' -f1)"
echo "[cua-helper] binary md5: $BIN_MD5"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# ---------- 组装 ----------
if [ "$PLATFORM" = "mac" ]; then
  APP="$OUT_DIR/Nuwax Computer Use.app"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  cp "$BIN" "$APP/Contents/MacOS/Nuwax Computer Use"
  chmod +x "$APP/Contents/MacOS/Nuwax Computer Use"
  # The dependency checkout can still contain the community AI icon. Read the
  # same commercial source used for the main app without depending on sync order.
  ICON_ICNS="${ICON_ICNS:-$REPO_ROOT/overlay/crates/agent-electron-client/public/icon.icns}"
  [ -f "$ICON_ICNS" ] || { echo "::error::main application icon.icns not found: $ICON_ICNS"; exit 1; }
  cp "$ICON_ICNS" "$APP/Contents/Resources/AppIcon.icns"
  sed -e "s/@@CUA_VERSION@@/$CUA_VERSION/g" "$SCRIPT_DIR/Info.plist" > "$APP/Contents/Info.plist"
  printf 'APPL????' > "$APP/Contents/PkgInfo"
  # cp/xattr 残留会让 codesign verify 报 resource fork（spike 实测），统一清一遍
  xattr -cr "$APP" 2>/dev/null || true
  # 预签：Developer ID（TCC 授权跨版本稳定的前提）；无 identity 时 ad-hoc（仅 dev）
  if [ -n "${SIGN_IDENTITY:-}" ]; then
    echo "[cua-helper] codesign (Developer ID): $SIGN_IDENTITY"
    codesign --force --sign "$SIGN_IDENTITY" --timestamp --options runtime "$APP"
  else
    echo "[cua-helper] codesign (ad-hoc, dev only)"
    codesign --force --sign - "$APP"
  fi
  codesign --verify --strict "$APP"
  echo "[cua-helper] mac bundle OK: $APP"
  du -sh "$APP"
elif [ "$PLATFORM" = "win" ]; then
  cp "$BIN" "$OUT_DIR/NuwaxComputerUse.exe"
  echo "[cua-helper] win exe OK: $OUT_DIR/NuwaxComputerUse.exe"
  ls -la "$OUT_DIR"
elif [ "$PLATFORM" = "linux" ]; then
  # 裸二进制（X11 直接可用；Wayland 走 portal/compositor 通路，见权限矩阵文档）
  cp "$BIN" "$OUT_DIR/NuwaxComputerUse"
  chmod 755 "$OUT_DIR/NuwaxComputerUse"
  echo "[cua-helper] linux binary OK: $OUT_DIR/NuwaxComputerUse"
  ls -la "$OUT_DIR"
else
  echo "::error::unsupported platform for helper: $TARGET_TRIPLE"; exit 1
fi
