#!/usr/bin/env bash
# 在 Windows 签名机的 Git Bash 中为 prerelease-v* Draft Release 签名 NSIS EXE。
# 基座 sign:win 只识别 electron-v* tag，因此先下载 beta 资产，再复用其本地签名路径。
set -euo pipefail

VERSION="${1:?用法: scripts/sign-prerelease-win.sh <x.y.z>}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "版本须为 x.y.z" >&2; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${SIGN_RELEASE_REPO:-nuwax-ai/nuwax-client}"
TAG="prerelease-v${VERSION}"
WORK_DIR="${SIGN_WORK_DIR:-/c/tmp/nuwax-sign-beta}"
UNSIGNED="Nuwax-Setup-${VERSION}-unsigned.exe"
SIGNED="Nuwax.Setup.${VERSION}.exe"

command -v gh >/dev/null || { echo "需要 gh CLI" >&2; exit 1; }
mkdir -p "$WORK_DIR/unsigned" "$WORK_DIR/signed"
gh release download "$TAG" --repo "$REPO" --dir "$WORK_DIR/unsigned" --pattern "$UNSIGNED" --clobber

(
  cd "$ROOT/nuwa-electron-shell/crates/agent-electron-client"
  SIGN_RELEASE_REPO="$REPO" \
  SIGN_WORK_DIR="$WORK_DIR" \
  SIGN_WIN_ARTIFACT_PREFIX=Nuwax \
  SIGN_SKIP_BLOCKMAP=true \
    npm run sign:win -- "$VERSION" --skip-download --skip-upload
)

test -s "$WORK_DIR/signed/$SIGNED"
gh release upload "$TAG" "$WORK_DIR/signed/$SIGNED" --clobber --repo "$REPO"
echo "[sign-prerelease-win] $TAG: $SIGNED 已签名并上传；可触发 beta 同步核验"
