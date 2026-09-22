#!/usr/bin/env bash
# 拉取 nuwax 子模块最新分支源码，就地重建前端 dist（产物只留在 nuwax-client
# 工作区内，不回推 nuwax 仓分支）。
#
# 用途：客户端打包前置。CI（release-electron-dev.yml）与本地发版共用同一脚本：
#   - Init submodules 仍按 gitlink 检出（保底基线 + 凭据链就位）；
#   - 本脚本把 nuwax 工作树强切到分支尖端并 pnpm build:prod；
#   - electron-builder extraResources 消费 ../../../nuwax/dist → resources/nuwax-dist，
#     因此包内 dist 恒等于「构建时刻的分支尖端」，nuwax 仓不再积累 build(dist) 提交。
#
# 环境变量：
#   NUWAX_FRONTEND_BRANCH  分支名（默认 feat-dong.0930）
#   NUWAX_FRONTEND_REF     指定具体 SHA/refs 时精确检出（复现任意历史构建；优先于 BRANCH）
#   SKIP_NUWAX_BUILD=1     只切源码不构建（调试用）
#
# 注意：
#   - checkout --force 会覆盖本地构建戳（version.ts / dist 抖动属预期产物）；
#   - pnpm 须已可用（CI 侧放在 pnpm/action-setup 之后的步骤调用）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUB="$ROOT/nuwax"
BRANCH="${NUWAX_FRONTEND_BRANCH:-feat-dong.0930}"
REF="${NUWAX_FRONTEND_REF:-}"

cd "$SUB"

if [ -n "$REF" ]; then
  echo "[prepare-nuwax-dist] 精确检出 NUWAX_FRONTEND_REF=$REF"
  git fetch --force origin "$REF"
  TIP="$(git rev-parse FETCH_HEAD)"
else
  echo "[prepare-nuwax-dist] 拉取 origin/$BRANCH 尖端 …"
  git fetch --force origin "$BRANCH"
  TIP="$(git rev-parse FETCH_HEAD)"
fi

echo "[prepare-nuwax-dist] 强制检出 ${TIP}（覆盖本地构建戳/产物抖动）"
git checkout --force "$TIP"
git status --short | head -3 || true

if [ "${SKIP_NUWAX_BUILD:-0}" = "1" ]; then
  echo "[prepare-nuwax-dist] SKIP_NUWAX_BUILD=1，跳过构建"
  exit 0
fi

echo "[prepare-nuwax-dist] pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

echo "[prepare-nuwax-dist] pnpm build:prod"
pnpm build:prod

# 产物自校验：dist/version.json 的 gitHash 必须等于检出的源码尖（postbuild 写入）
STAMP="$(node -p "require('./dist/version.json').gitHash")"
if [ "$STAMP" != "${TIP:0:9}" ]; then
  echo "::error::dist/version.json gitHash($STAMP) != 源码尖(${TIP:0:9})——构建与源码不一致"
  exit 1
fi

echo "[prepare-nuwax-dist] 完成：nuwax/dist @ $STAMP（不回推 nuwax 仓）"
