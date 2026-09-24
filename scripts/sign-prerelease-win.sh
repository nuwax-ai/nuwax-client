#!/usr/bin/env bash
# beta 从 CI 原产未签名 NSIS EXE 发布，不再经 Windows 人工签名。
set -euo pipefail

echo "[sign-prerelease-win] beta 不需要 Windows 签名。推送 prerelease-v* tag 后，五平台构建成功会自动同步 beta 并公开 prerelease。" >&2
echo "[sign-prerelease-win] 仅正式版 electron-v* 使用 scripts/release-stable.sh 完成签名及 stable 同步。" >&2
exit 1
