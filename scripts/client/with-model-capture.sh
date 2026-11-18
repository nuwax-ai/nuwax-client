#!/usr/bin/env bash
# 本地调试：为 `make dev` / `make harness-local` 自动起"模型请求抓包代理"，
# 然后把客户端命令放到前台跑；客户端退出时代理随之结束。
#
#   with-model-capture.sh <命令...>
#
# 默认开启（端口 18777，日志 logs/model-capture.log，启动即截断）。
# 关闭/改端口：
#   NUWAX_MODEL_CAPTURE=0      # 关闭
#   NUWAX_MODEL_CAPTURE=19000  # 换端口
#   CAPTURE_PORT=19000         # 同上（Makefile 变量）
#
# 如果该端口已经有代理在跑（例如另开终端 `make model-capture`），直接复用它，
# 不再另起一个，也不会在退出时把它杀掉。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${NUWAX_MODEL_CAPTURE:-${CAPTURE_PORT:-18777}}"
LOG="$ROOT/logs/model-capture.log"
PROXY="$ROOT/scripts/client/model-capture-proxy.mjs"

case "$PORT" in
  0|no|off|false|'')
    # 显式关闭：变量必须清掉，否则客户端会把 "0" 当成端口去改写 base URL。
    unset NUWAX_MODEL_CAPTURE
    exec "$@" ;;
esac

if [ "$#" -eq 0 ]; then
  echo "[model-capture] 缺少要执行的命令" >&2
  exit 2
fi

port_busy() {
  # macOS/Linux 通用的探测：能连上就认为已被占用（可能就是我们自己的代理）。
  (exec 3<>"/dev/tcp/127.0.0.1/$PORT") >/dev/null 2>&1 && { exec 3>&- 2>/dev/null; return 0; }
  return 1
}

OWN_PROXY=0
if port_busy; then
  echo "[model-capture] 复用已在 $PORT 端口运行的代理；日志 $LOG"
else
  mkdir -p "$ROOT/logs"
  node "$PROXY" --port "$PORT" --log "$LOG" >"$ROOT/logs/model-capture-proxy.out" 2>&1 &
  PROXY_PID=$!
  OWN_PROXY=1
  # 等它真正监听（最多 ~5s），避免客户端抢在代理之前发第一个请求。
  for _ in $(seq 1 50); do
    port_busy && break
    sleep 0.1
  done
  if ! port_busy; then
    echo "[model-capture] 代理启动失败，见 $ROOT/logs/model-capture-proxy.out；本次不抓包" >&2
    kill "$PROXY_PID" 2>/dev/null || true
    OWN_PROXY=0
    unset NUWAX_MODEL_CAPTURE
    exec "$@"
  fi
  echo "[model-capture] 已启动 http://127.0.0.1:$PORT → 日志 $LOG"
fi

cleanup() {
  if [ "$OWN_PROXY" = "1" ] && [ -n "${PROXY_PID:-}" ]; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

export NUWAX_MODEL_CAPTURE="$PORT"
"$@"
STATUS=$?
exit "$STATUS"
