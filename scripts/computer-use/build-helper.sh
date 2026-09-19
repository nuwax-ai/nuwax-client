#!/usr/bin/env bash
# 构建 Computer Use helper（cua-driver 源码自建路线，2026-09-17 拍板）：
#   锁版 clone cua 仓 → apply nuwax 补丁（bundle 白名单/app_bundle_path）→ cargo build
#   → 组装 helper（mac .app / win exe）→ mac 预签 Developer ID（进 extraResources 前签好，
#   electron-builder 按 TCC 稳定性要求：同 Team + 同 bundle id 跨版本保授权）。
#
# 产物落 OUT_DIR：
#   mac: "$OUT_DIR/Nuwax Computer Use.app"（单 .app，可执行名=app 名）
#   win: "$OUT_DIR/NuwaxComputerUse.exe"
#
# 环境变量：
#   CUA_COMMIT            锁定的 cua 仓 commit（默认 625118a90，升级须连同 SDK 版本四契约一起换）
#   CUA_VERSION           写进 Info.plist 的版本串（默认 0.28.2）
#   TARGET_TRIPLE         Rust target（必填，如 aarch64-apple-darwin / x86_64-pc-windows-msvc）
#   OUT_DIR               产物目录（必填，一般=agent-electron-client/resources/computer-use）
#   ICON_ICNS             mac 图标源（默认取 overlay 同步后的 public/icon.icns 黑标）
#   SIGN_IDENTITY         mac Developer ID 身份（空=ad-hoc 签名，仅 dev 用；产品必须正签）
#   NUWAX_CUA_SOURCE_DIR  本地 dev 直用已有 cua 检出（跳过 clone/patch，须已含补丁）
set -euo pipefail

CUA_COMMIT="${CUA_COMMIT:-625118a90}"
CUA_VERSION="${CUA_VERSION:-0.28.2}"
TARGET_TRIPLE="${TARGET_TRIPLE:?TARGET_TRIPLE required}"
OUT_DIR="${OUT_DIR:?OUT_DIR required}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PATCH_FILE="${REPO_ROOT}/docs/computer-use-poc/0001-0002-cua-nuwax-helper-bundle.patch"
WORK_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/cua-build-$$"

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
  git clone --quiet https://github.com/trycua/cua.git "$WORK_DIR/cua"
  git -C "$WORK_DIR/cua" checkout --quiet "$CUA_COMMIT"
  echo "[cua-helper] applying nuwax patch ..."
  git -C "$WORK_DIR/cua" apply "$PATCH_FILE"
  SRC_DIR="$WORK_DIR/cua"
fi

# ---------- 构建 ----------
# cua 仓 rust-toolchain.toml 钉 1.97.1：cargo 会切到该工具链，target 必须装进它——
# target add 须在仓内目录执行（让 rustup 解析钉住工具链；在仓外执行会装到默认 stable 上，
# CI 实证 mac x64 交叉腿两连挂 E0463）。瞬时下载失败重试一次。
(
  cd "$SRC_DIR/libs/cua-driver/rust" || exit 1
  rustup target add "$TARGET_TRIPLE" || { sleep 5; rustup target add "$TARGET_TRIPLE"; }
  echo "[cua-helper] cargo build --release -p cua-driver --features portal-input ($TARGET_TRIPLE) ..."
  # portal-input=libei 输入通道（GNOME/KDE Wayland；不开则 GNOME Wayland 输入
  # "no input backend" 无兜底）——上游官方 Linux 发行同款开启；纯 Rust 栈（reis）
  # +libxkbcommon-dev，mac/win 为 target-gated 无影响。portal-capture 不开：
  # 截屏主瀑布走免 feature 的 portal.Screenshot，逐窗 PipeWire 仅备用 API 未接线
  cargo build --release -p cua-driver --features portal-input --target "$TARGET_TRIPLE"
)

BIN="$SRC_DIR/libs/cua-driver/rust/target/$TARGET_TRIPLE/release/cua-driver"
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
  ICON_ICNS="${ICON_ICNS:-$(cd "$REPO_ROOT" && find nuwa-electron-shell/crates/agent-electron-client/public -maxdepth 1 -name 'icon.icns' | head -1)}"
  [ -n "$ICON_ICNS" ] && [ -f "$ICON_ICNS" ] || { echo "::error::icon.icns not found (overlay sync?)"; exit 1; }
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
