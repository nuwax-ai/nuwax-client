#!/usr/bin/env bash
# 在 Windows 签名机的 Git Bash 中为 prerelease-v* Draft Release 签名 NSIS EXE。
# 基座 sign:win 只识别 electron-v* tag，因此先下载 beta 资产，再复用其本地签名路径。
# 签名后等待该 tag 的完整构建成功，再自动同步并核对 beta 指针。
set -euo pipefail

VERSION="${1:?用法: scripts/sign-prerelease-win.sh <x.y.z>}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "版本须为 x.y.z" >&2; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${SIGN_RELEASE_REPO:-nuwax-ai/nuwax-client}"
TAG="prerelease-v${VERSION}"
WORK_DIR="${SIGN_WORK_DIR:-/c/tmp/nuwax-sign-beta}"
UNSIGNED="Nuwax-Setup-${VERSION}-unsigned.exe"
SIGNED="Nuwax.Setup.${VERSION}.exe"
SYNC_REF="${SYNC_OSS_REF:-release/v1.0.x}"
SYNC_TITLE="Sync beta ${TAG}"
BUILD_WORKFLOW="release-electron-dev.yml"
SYNC_WORKFLOW="sync-electron-to-oss.yml"
S3_POINTER="https://s3.nuwax.com:9443/nuwaclaw/nuwax-electron/beta/latest.json"
OSS_POINTER="https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwax-electron/beta/latest.json"

die() { echo "[sign-prerelease-win] $*" >&2; exit 1; }

build_run_id() {
  gh run list --workflow "$BUILD_WORKFLOW" --repo "$REPO" --limit 100 \
    --json databaseId,headBranch,event \
    --jq "limit(1; .[] | select(.headBranch == \"${TAG}\" and .event == \"push\") | .databaseId)"
}

sync_run_id() {
  gh run list --workflow "$SYNC_WORKFLOW" --repo "$REPO" --limit 100 \
    --json databaseId,headBranch,displayTitle \
    --jq "limit(1; .[] | select(.headBranch == \"${SYNC_REF}\" and .displayTitle == \"${SYNC_TITLE}\") | .databaseId)"
}

wait_for_build() {
  local run_id state
  for _ in $(seq 1 180); do
    run_id="$(build_run_id)"
    if [ -n "$run_id" ]; then
      state="$(gh run view "$run_id" --repo "$REPO" --json status,conclusion \
        --jq '.status + "/" + (.conclusion // "running")')"
      case "$state" in
        completed/success) echo "[sign-prerelease-win] ${TAG} 构建成功（run ${run_id}）"; return ;;
        completed/*) die "${TAG} 构建未成功（run ${run_id}: ${state}）" ;;
      esac
    fi
    sleep 60
  done
  die "等待 ${TAG} 构建成功超过 180 分钟"
}

pointer_matches() {
  local url="$1"
  curl -fsSL --retry 3 --max-time 20 "${url}?check=$(date +%s)" | \
    node -e 'let data="";process.stdin.on("data",part=>data+=part).on("end",()=>{const value=JSON.parse(data);const win=value.platforms?.["windows-x86_64"]?.url;if(value.version!==process.argv[1]||!win?.endsWith("/beta-build/"+process.argv[3]+"/"+process.argv[2]))process.exit(1)})' \
      "$VERSION" "$SIGNED" "$TAG"
}

command -v gh >/dev/null || { echo "需要 gh CLI" >&2; exit 1; }
command -v curl >/dev/null || die "需要 curl"
command -v node >/dev/null || die "需要 node"
[[ "$SYNC_REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "SYNC_OSS_REF 无效: $SYNC_REF"
RELEASE_STATE="$(gh release view "$TAG" --repo "$REPO" --json isDraft,isPrerelease --jq '[.isDraft,.isPrerelease] | map(tostring) | join(":")')"
[ "$RELEASE_STATE" = true:true ] || die "${TAG} 必须是 beta Draft Release（当前: ${RELEASE_STATE}）"

SIGNED_PRESENT="$(gh release view "$TAG" --repo "$REPO" --json assets \
  --jq ".assets | any(.name == \"${SIGNED}\")")"
if [ "$SIGNED_PRESENT" != true ]; then
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
  echo "[sign-prerelease-win] $TAG: $SIGNED 已签名并上传"
else
  echo "[sign-prerelease-win] $TAG: $SIGNED 已在 Release，继续同步核验"
fi

wait_for_build
if pointer_matches "$S3_POINTER" && pointer_matches "$OSS_POINTER"; then
  echo "[sign-prerelease-win] $TAG: beta 双镜像指针已经正确，跳过重复同步"
  exit 0
fi

PREVIOUS_RUN="$(sync_run_id)"
gh workflow run "$SYNC_WORKFLOW" --repo "$REPO" --ref "$SYNC_REF" \
  -f tag="$TAG" -f channel=beta
echo "[sign-prerelease-win] 已触发 ${SYNC_WORKFLOW}：${SYNC_TITLE}（ref ${SYNC_REF}）"
SYNC_RUN=""
for _ in $(seq 1 30); do
  SYNC_RUN="$(sync_run_id)"
  [ -n "$SYNC_RUN" ] && [ "$SYNC_RUN" != "$PREVIOUS_RUN" ] && break
  sleep 5
done
[ -n "$SYNC_RUN" ] && [ "$SYNC_RUN" != "$PREVIOUS_RUN" ] \
  || die "未找到新启动的 beta 同步 run；请在 Actions 中检查 ${SYNC_TITLE}"
for _ in $(seq 1 180); do
  STATE="$(gh run view "$SYNC_RUN" --repo "$REPO" --json status,conclusion \
    --jq '.status + "/" + (.conclusion // "running")')"
  case "$STATE" in
    completed/success) break ;;
    completed/*) die "beta 同步失败（run ${SYNC_RUN}: ${STATE}）" ;;
  esac
  sleep 30
done
[ "$STATE" = completed/success ] || die "beta 同步超过 90 分钟（run ${SYNC_RUN}: ${STATE}）"
for _ in $(seq 1 10); do
  if pointer_matches "$S3_POINTER" && pointer_matches "$OSS_POINTER"; then
    echo "[sign-prerelease-win] $TAG: beta S3/OSS 指针已核对（sync run ${SYNC_RUN}）"
    exit 0
  fi
  sleep 6
done
die "beta 同步成功，但 S3/OSS 指针尚未指向 ${TAG} 的签名 Windows 安装包"
