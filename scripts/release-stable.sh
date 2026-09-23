#!/bin/bash
#
# 正式版（stable）发布一条龙编排：electron-v{x.y.z} tag → CI 五平台构建 → 资产校验
# → Windows SSH 远程手签 → 签名资产校验 → dispatch stable 同步 → stable 指针/字节级验证。
#
# 各阶段先查前置是否已满足，满足即跳过——支持跨天断点续跑（重跑同一版本号即续）。
# 先例：v1.0.3 / v1.0.4（说明见 release-notes/ 与 docs/sign-windows.md）。
#
# 用法：
#   scripts/release-stable.sh <version>           # 全流程
#   scripts/release-stable.sh <version> --notes   # 先提交并推送 release-notes/electron-v<version>.md 再走全流程
#
# 前置（人工，脚本不代办）：
#   1. release-notes/electron-v<version>.md 已写好（workflow prepare 从 tag 提交里读它，
#      所以必须先提交说明再打 tag——文件不在 tag 提交里会被回退成一句话默认文案）。
#   2. Windows 签名机已登录 SimplySign Desktop（手机 2FA 只能人工）。
#   3. 发版批次已过质量门禁（双轨测试 + /quality-review，见 AGENTS.md）。
#
# 环境旋钮：
#   RELEASE_SIGN_HOST   签名机 ssh 别名（默认 win-pc）
#   WIN_CLIENT_DIR      签名机上 nuwax-client 检出路径（默认 /c/soddy-git-workspace/nuwax-client）
#   SIGN_GH_PATH        签名机 gh 安装路径（默认 "/c/Program Files/GitHub CLI"；
#                       sshd 会话 PATH 不含 MSI 装的 gh，须显式注入）
#
# 一次性配置记录（2026-09-15，win-pc）：winget 装 GitHub CLI + gh auth login（token 管道），
# WINDOWS_CERTIFICATE_SHA1 已在 ~/.bashrc；signtool 用 Windows Kits 自带。

set -euo pipefail

VERSION="${1:?用法: scripts/release-stable.sh <version> [--notes]}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "版本须为 x.y.z" >&2; exit 1; }
shift || true
COMMIT_NOTES=false
[[ "${1:-}" == "--notes" ]] && COMMIT_NOTES=true

TAG="electron-v${VERSION}"
NOTES_FILE="release-notes/${TAG}.md"
REPO="nuwax-ai/nuwax-client"
SIGN_HOST="${RELEASE_SIGN_HOST:-win-pc}"
WIN_DIR="${WIN_CLIENT_DIR:-/c/soddy-git-workspace/nuwax-client}"
SIGN_GH_PATH="${SIGN_GH_PATH:-/c/Program Files/GitHub CLI}"

S3_BASE="https://s3.nuwax.com:9443/nuwaclaw/nuwax-electron"
STABLE_JSON="${S3_BASE}/latest/latest.json"
SIGNED_EXE="Nuwax.Setup.${VERSION}.exe"
UNSIGNED_EXE="Nuwax-Setup-${VERSION}-unsigned.exe"

step() { printf '\n==> %s\n' "$*"; }
die()  { printf '\n[release-stable] 错误: %s\n' "$*" >&2; exit 1; }

command -v gh >/dev/null || die "本机需要 gh CLI"
command -v jq >/dev/null || die "本机需要 jq"

tag_on_remote() { git ls-remote --exit-code origin "refs/tags/${TAG}" >/dev/null 2>&1; }

release_assets() {
  gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name'
}

ci_run_id() {
  gh run list --workflow=release-electron.yml --repo "$REPO" --limit 5 --json databaseId,headBranch,status,conclusion \
    --jq ".[] | select(.headBranch == \"${TAG}\") | .databaseId" | head -1
}

# ---- Phase 0/6 前置检查 -------------------------------------------------------
step "Phase 0/6 前置检查"
git fetch origin --tags --quiet
[[ -f "$NOTES_FILE" ]] || die "缺少 $NOTES_FILE（先写正式版说明，见脚本头注前置 1）"
[[ -z "$(git status --porcelain | grep -v 'nuwa-electron-shell' || true)" ]] \
  || die "外层工作树有未提交改动（除基座子模块同步产物外须干净）"
if git diff --quiet -- "$NOTES_FILE" && git ls-files --error-unmatch "$NOTES_FILE" >/dev/null 2>&1; then
  echo "  说明文件已提交"
else
  $COMMIT_NOTES || die "$NOTES_FILE 未提交——提交后重跑，或换 --notes 由脚本提交"
  step "Phase 0/6 提交说明文件"
  git add "$NOTES_FILE"
  git commit -m "docs(release-notes): ${TAG} 正式版说明（prerelease 验证通过后转正）"
  git push origin HEAD
fi
BRANCH="$(git branch --show-current)"
[[ -n "$BRANCH" ]] || die "须在远端可达的发布分支运行，不支持 detached HEAD"
REMOTE_HEAD="$(git ls-remote origin "refs/heads/${BRANCH}" | awk '{print $1}')"
[[ "$REMOTE_HEAD" == "$(git rev-parse HEAD)" ]] \
  || die "远端分支 ${BRANCH} 未包含当前 HEAD；先推送发布提交再打 tag"
echo "  分支=${BRANCH} HEAD=$(git rev-parse --short HEAD)"

# ---- Phase 1/6 打 tag ---------------------------------------------------------
step "Phase 1/6 打 tag ${TAG}"
if tag_on_remote; then
  echo "  远端 tag 已存在，跳过（断点续跑）"
else
  git tag "$TAG" HEAD
  git push origin "$TAG"
  echo "  已推送 $(git rev-parse --short "$TAG")"
fi

# ---- Phase 2/6 盯 CI 五平台构建 ----------------------------------------------
step "Phase 2/6 CI 构建（electron-v* 触发 release-electron.yml，mac 双架构约 90-120 分钟）"
RUN_ID="$(ci_run_id || true)"
[[ -n "$RUN_ID" ]] || die "未找到 ${TAG} 触发的 workflow run（tag 推送失败？）"
for _ in $(seq 1 150); do
  STATUS="$(gh run view "$RUN_ID" --repo "$REPO" --json status,conclusion --jq '.status + "/" + (.conclusion // "running")')"
  [[ "$STATUS" == completed/* ]] && break
  sleep 60
done
CONCLUSION="${STATUS#completed/}"
[[ "$STATUS" == completed/* ]] || die "构建超过 150 分钟仍未完成（run ${RUN_ID}）"
echo "  run ${RUN_ID}: ${CONCLUSION}"
[[ "$CONCLUSION" == success ]] || die "构建未成功（run ${RUN_ID}），先排障再续跑"

# ---- Phase 3/6 校验 Release 资产 ---------------------------------------------
step "Phase 3/6 校验 Release 资产"
ASSETS="$(release_assets)"
for want in "Nuwax-${VERSION}-arm64.dmg" "Nuwax-${VERSION}.dmg" "Nuwax-${VERSION}-arm64-mac.zip" \
            "Nuwax-${VERSION}.AppImage" "Nuwax-${VERSION}-amd64.deb" "Nuwax-${VERSION}-x86_64.rpm" \
            "$UNSIGNED_EXE" "Nuwax.${VERSION}.msi" "latest-mac.yml" "latest.yml" \
            "build-manifest-macos-arm64.json" "build-manifest-macos-x64.json" \
            "build-manifest-windows-x64.json" "build-manifest-linux-x64.json" \
            "build-manifest-linux-arm64.json"; do
  grep -qx "$want" <<<"$ASSETS" || die "Release 缺资产：$want"
done
echo "  关键资产齐（mac 双架构/linux/win unsigned/yml）"

# ---- Phase 4/6 Windows 远程手签 ----------------------------------------------
step "Phase 4/6 Windows 手签（${SIGN_HOST}，SimplySign 云端签名，约 10-40 分钟）"
if grep -qx "$SIGNED_EXE" <<<"$(release_assets)"; then
  echo "  ${SIGNED_EXE} 已在 Release 上，跳过签名（断点续跑）"
else
  ssh "$SIGN_HOST" "bash -lc 'export PATH=\"${SIGN_GH_PATH}:\$PATH\"; cd ${WIN_DIR}/nuwa-electron-shell/crates/agent-electron-client && SIGN_RELEASE_REPO=${REPO} SIGN_WORK_DIR=/c/tmp/nuwax-sign SIGN_WIN_ARTIFACT_PREFIX=Nuwax npm run sign:win -- ${VERSION} 2>&1'" \
    || die "签名失败（检查 SimplySign 登录态/证书指纹/网络）"
fi
ASSETS="$(release_assets)"
grep -qx "$SIGNED_EXE" <<<"$ASSETS" || die "签名后仍缺 ${SIGNED_EXE}"
grep -qx "$UNSIGNED_EXE" <<<"$ASSETS" && echo "  警告: unsigned EXE 未删（脚本应已删；不影响 stable，建议手动清理）" || true
grep -qx "${SIGNED_EXE}.blockmap" <<<"$ASSETS" \
  || echo "  注记: 签名版 ${SIGNED_EXE}.blockmap 未上传（v2 脚本默认跳过重生成）——Windows 更新走全量下载而非差分，功能不受影响"
echo "  ${SIGNED_EXE} 已上 Release"

# ---- Phase 5/6 stable 同步 ----------------------------------------------------
step "Phase 5/6 同步 stable（sync-electron-to-oss.yml，stable 路径历史上无自动触发）"
STABLE_VER="$(curl -sS --max-time 15 "$STABLE_JSON" 2>/dev/null | jq -r '.version // empty' || true)"
if [[ "$STABLE_VER" == "$VERSION" ]]; then
  echo "  stable 指针已是 ${VERSION}，跳过 dispatch（断点续跑）"
else
  gh workflow run sync-electron-to-oss.yml --repo "$REPO" --ref "$BRANCH" -f tag="$TAG" -f channel=stable
  sleep 20
  SYNC_RUN="$(gh run list --workflow=sync-electron-to-oss.yml --repo "$REPO" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')"
  for _ in $(seq 1 30); do
    S="$(gh run view "$SYNC_RUN" --repo "$REPO" --json status,conclusion --jq '.status + "/" + (.conclusion // "running")')"
    [[ "$S" == completed/* ]] && break
    sleep 20
  done
  [[ "$S" == completed/success ]] || die "同步 workflow 未成功（${SYNC_RUN}: ${S}）"
  echo "  sync run ${SYNC_RUN}: ${S}"
fi

# ---- Phase 6/6 stable 指针/字节级验证 ----------------------------------------
step "Phase 6/6 stable 验证"
STABLE_VER="$(curl -sS --max-time 15 "$STABLE_JSON" | jq -r '.version // empty')"
[[ "$STABLE_VER" == "$VERSION" ]] || die "stable 指针版本=${STABLE_VER:-空}，期望 ${VERSION}"
WIN_URL="$(curl -sS "$STABLE_JSON" | jq -r '.platforms["windows-x86_64"].url // empty')"
[[ "$WIN_URL" == *"$SIGNED_EXE" ]] || die "stable windows URL 未指向签名产物：${WIN_URL:-空}"
MAC_URL="$(curl -sS "$STABLE_JSON" | jq -r '.platforms["darwin-aarch64-zip"].url // empty')"
MAC_FILE="${MAC_URL##*/}"
GH_SIZE="$(gh release view "$TAG" --repo "$REPO" --json assets --jq ".assets[] | select(.name == \"${MAC_FILE}\") | .size")"
S3_SIZE="$(curl -sSI --max-time 30 "$MAC_URL" | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}' | tail -1)"
[[ -n "$GH_SIZE" && "$GH_SIZE" == "$S3_SIZE" ]] \
  || die "字节级对拍失败：${MAC_FILE} GitHub=${GH_SIZE:-?} S3=${S3_SIZE:-?}"
curl -sSf --max-time 15 "${S3_BASE}/${TAG}/latest-mac.yml" >/dev/null && echo "  版本目录 ${TAG}/latest-mac.yml: OK"

step "完成：${TAG} stable 全链发布就绪"
echo "  stable 指针=${STABLE_JSON}"
echo "  windows=${WIN_URL}"
echo "  字节级对拍：${MAC_FILE} ${GH_SIZE}B 一致"
echo "  后续人工抽查：1.0.x 老客户端收更新弹窗、真机升级冒烟（AGENTS 口径：提测/发版须验真实安装包）"
