#!/usr/bin/env bash
# 从外层提交锁定的 nuwax 子模块源码构建前端 dist（产物只留在工作区）。
#
# 用途：客户端打包前置。CI（release-electron-dev.yml）与本地发版共用同一脚本：
#   - Init submodules 按 gitlink 检出；
#   - 本脚本验证检出的源码等于 gitlink，再 pnpm build:prod；
#   - electron-builder extraResources 消费 ../../../nuwax/dist → resources/nuwax-dist，
#     因此同一外层提交的各平台构建使用同一份前端源码。
#
# SKIP_NUWAX_BUILD=1 只核对源码，不构建。pnpm 须已可用。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUB="$ROOT/nuwax"
PIN="$(git -C "$ROOT" rev-parse HEAD:nuwax)"

cd "$SUB"
TIP="$(git rev-parse HEAD)"
EXPECTED_STAMP="$(git rev-parse --short HEAD)"
if [ "$TIP" != "$PIN" ]; then
  echo "::error::nuwax 子模块 HEAD($TIP) != 外层 gitlink($PIN)，请在隔离检出中运行 git submodule update --init nuwax" >&2
  exit 1
fi
echo "[prepare-nuwax-dist] 前端源码锁定于外层 gitlink: $PIN"

if [ "${SKIP_NUWAX_BUILD:-0}" = "1" ]; then
  echo "[prepare-nuwax-dist] SKIP_NUWAX_BUILD=1，已核对源码，跳过构建"
  exit 0
fi

echo "[prepare-nuwax-dist] pnpm install --frozen-lockfile"

# pnpm 大版本对齐：nuwax 的 lockfile/patchedDependencies 由其 packageManager 声明
# 版本（pnpm@10.x）写入；宿主（如 CI 钉的 pnpm 9）frozen install 会报
# ERR_PNPM_LOCKFILE_CONFIG_MISMATCH——不符时经 corepack 按 packageManager 自动切版本。
PNPM="pnpm"
PM_SPEC="$(node -p "try{require('./package.json').packageManager||''}catch{''}")"
case "$PM_SPEC" in
  pnpm@*)
    WANT_MAJOR="${PM_SPEC#pnpm@}"; WANT_MAJOR="${WANT_MAJOR%%.*}"
    HAVE_MAJOR="$(pnpm --version 2>/dev/null | cut -d. -f1 || echo 0)"
    if [ "$HAVE_MAJOR" != "$WANT_MAJOR" ]; then
      echo "[prepare-nuwax-dist] 宿主 pnpm ${HAVE_MAJOR}x != 声明 ${WANT_MAJOR}x，corepack 切换"
      PNPM="corepack pnpm"
    fi
    ;;
esac

# shellcheck disable=SC2086 —— "$PNPM" 允许按词展开（corepack pnpm 两个词）
$PNPM install --frozen-lockfile

echo "[prepare-nuwax-dist] pnpm build:prod"
# UMI/max build 源码量增长后默认堆（~2GB）不够：mac runner 实测 OOM
# （Ineffective mark-compacts near heap limit），显式给到 4GB。
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=4096"
$PNPM build:prod

# 产物自校验：dist/version.json 的 gitHash 必须等于检出的源码尖（postbuild 写入）
STAMP="$(node -p "require('./dist/version.json').gitHash")"
if [ "$STAMP" != "$EXPECTED_STAMP" ]; then
  echo "::error::dist/version.json gitHash($STAMP) != 源码短哈希($EXPECTED_STAMP)——构建与源码不一致"
  exit 1
fi

echo "[prepare-nuwax-dist] 完成：nuwax/dist @ ${STAMP}（不回推 nuwax 仓）"
