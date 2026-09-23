# ============================================================================
# Nuwax 客户端 · 开发启动
# ============================================================================
#   make dev                            # 默认 DEV_WEBVIEW=loopback（生产同构）
#   make dev DEV_WEBVIEW=dev            # 前端热更形态（:3000 dev server）
#
# 两种形态的差别只在 webview 前端来源与后端请求出口：
#   loopback（默认） 不起 :3000、不设 NUWAX_WEBVIEW_ORIGIN；webview 加载 loopback
#                   网关托管的 nuwax/dist（submodule 构建产物——改前端源码需先
#                   pnpm build 提交 dist，或改用 DEV_WEBVIEW=dev）；/computer/*
#                   经 testagent Java → lanproxy 回本机，与生产链路同构——验证
#                   后端转发行为（service_type/cwd 透传、cId→项目 id 替换）用它。
#   dev              webview 加载 :3000 UMI dev server（前端 src 热更，改代码
#                   即时生效）；终端等 /computer 请求被 UMI dev proxy 抄近路
#                   直连本机网关，不经 Java（前端离线调试用它）。
#
# 一条命令拉起完整服务：
#   1) git submodule 同步     —— init + 对齐到仓库 pin 的 SHA（--init，已就绪时秒过）
#   2) nuwax 前端 dev server  —— 后台启动，自动等待就绪，日志 logs/frontend-dev.log
#                               （DEV_WEBVIEW=dev 时才启动）
#   3) Electron 壳            —— 前台，壳 vite + Electron + 全部内置服务
#   4) 主进程日志镜像         —— 后台 tail -F ~/.nuwax/logs/latest.log → logs/electron.log
# 每次 make dev 清空 logs/ 下的 *.log，只保留本轮记录，方便对照排查。
# Ctrl-C：向 3 个进程组发 SIGTERM，约 2s 宽限后 SIGKILL（见下方 kill_pg）。
#
# 为什么不是「只给前台发 SIGINT」：
#   npm → concurrently → electron 信号转发不可靠，且 Electron 无 SIGINT 处理时
#   会跳过 before-quit 清理链、遗留子进程。这里用独立进程组 + TERM/KILL 兜底，
#   Electron 侧另在 main.ts 将 SIGINT/SIGTERM 转成 app.quit() 走完整清理。
#
# submodule 说明：
#   - 对齐的是本仓 gitlink pin 的 SHA（可复现，与 CI/release 一致），不是远端分支尖。
#   - 子模块工作区有未提交改动且 pin 变化时会失败退出，不会强杀本地改动；
#     需要远端分支最新时：make submodules-latest（前进到分支尖并自动 bump pin）
#   - 跳过本次同步：make dev SKIP_SUBMODULES=1
#
# 为什么必须带 NUWAX_WEBVIEW_ORIGIN：
#   2026-09-18 起 dev 直连形态不再默认加载 localhost:3000（依据见基座
#   crates/agent-electron-client/src/main/services/loopbackGateway/index.ts
#   与 src/main/ipc/commercialAuth.ts 头注）。不设置时主进程 token 准入名单里
#   没有 dev origin，auth:getToken 会被拒，登录态静默进不了壳。
#
# 端口默认取 NUWAX_PORT_OFFSET 体系下的 61173（壳）与前端约定的 3000；
# 前端端口可用 FRONTEND_PORT= 覆盖，例如：make dev FRONTEND_PORT=3001
# ============================================================================

SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c

NUWAX_DIR     := nuwax
FRONTEND_PORT ?= 3000
LOG_DIR       := logs
FRONTEND_LOG  := $(LOG_DIR)/frontend-dev.log
ELECTRON_LOG  := $(LOG_DIR)/electron.log
# 产品数据目录（identifier=nuwax → ~/.nuwax）；可用 NUWAX_LOG_DIR= 覆盖
NUWAX_LOG_DIR ?= $(HOME)/.nuwax/logs
NUWAX_LATEST  := $(NUWAX_LOG_DIR)/latest.log
# 需要随 make dev 对齐 pin 的 submodule（与 README fresh clone 一致）
SUBMODULES    := nuwa-electron-shell nuwax

# webview 形态开关（loopback | dev），默认 loopback（生产同构）；
# 前端热更调试用 DEV_WEBVIEW=dev。用法与差别见文件头注释。
DEV_WEBVIEW ?= loopback

ifeq ($(DEV_WEBVIEW),loopback)
# loopback 形态不注入 dev origin：webview 回落 loopback 托管的 nuwax/dist。
# unexport 同时防御用户 shell 里的同名残留。
unexport NUWAX_WEBVIEW_ORIGIN
else
export NUWAX_WEBVIEW_ORIGIN := http://localhost:$(FRONTEND_PORT)
endif

.DEFAULT_GOAL := dev

.PHONY: dev submodules submodules-latest

# 只同步 submodule 到 pin（make dev 会自动跑；也可单独执行）
submodules:
	@echo ">>> 同步 submodule 到仓库 pin（$(SUBMODULES)）..."
	@git submodule update --init -- $(SUBMODULES) || { \
		echo "!!! submodule 同步失败。"; \
		echo "    常见原因：子模块本地有改动且 pin 已前进（git 拒绝覆盖未提交修改）。"; \
		echo "    处理：进子模块提交/stash 后重试；或临时 make dev SKIP_SUBMODULES=1 跳过。"; \
		exit 1; \
	}

# 前进 submodule 到远端分支尖（.gitmodules 的 branch 配置：基座 main / 前端 feat-dong.0930）。
# 有变化时自动：重新 overlay:sync + 提交 pin bump（保持 submodule 状态与 pin 一致、可复现）。
# 适用：跟进同事刚推的基座/前端提交。注意本命令不动壳仓自身——先 git pull 同步
# 壳仓远端的 pin 变更，再跑本命令向前推进；基座依赖变化（package.json/lock）需手动重装。
submodules-latest:
	@echo ">>> [1/4] 清理基座 overlay 同步态（让 submodule 可以前进）..."
	@node scripts/sync-overlay.js --clean >/dev/null || { echo "!!! overlay:clean 失败"; exit 1; }
	@echo ">>> [2/4] submodule 前进到远端分支尖（.gitmodules branch）..."
	@git submodule update --remote -- $(SUBMODULES) || { \
		echo "!!! submodule 更新失败。"; \
		echo "    常见原因：nuwax 工作区有构建戳等未提交改动（如 src/constants/version.ts）。"; \
		echo "    处理：cd nuwax && git status 确认无需保留后 git restore .，再重试。"; \
		exit 1; \
	}
	@if git diff --quiet -- $(SUBMODULES); then \
		echo ">>> submodule 已在远端分支尖，无需 bump。"; \
	else \
		echo ">>> [3/4] 重新同步 overlay 到新基座..."; \
		node scripts/sync-overlay.js >/dev/null || { echo "!!! overlay:sync 失败"; exit 1; }; \
		echo ">>> [4/4] 提交 pin bump..."; \
		git add $(SUBMODULES); \
		git commit -m "chore(client): bump submodule 到远端分支尖——$$(git submodule status $(SUBMODULES) | awk '{print $$2"@"$$1}' | tr '\n' ' ')"; \
		echo ">>> 完成。若基座依赖有变（package.json/pnpm-lock），重装：cd nuwa-electron-shell && pnpm install"; \
	fi

dev:
	@if [ -z "$(SKIP_SUBMODULES)" ]; then \
		$(MAKE) --no-print-directory submodules; \
	else \
		echo ">>> 跳过 submodule 同步（SKIP_SUBMODULES=1）"; \
	fi
	@if [ "$(DEV_WEBVIEW)" != "loopback" ]; then \
		if curl -fsS -o /dev/null "http://localhost:$(FRONTEND_PORT)/" 2>/dev/null; then \
			echo "!!! :$(FRONTEND_PORT) 已有服务在监听（可能是上次残留的前端 dev server）。"; \
			echo "    先停掉它再启动；或换端口：make dev FRONTEND_PORT=3001"; \
			exit 1; \
		fi; \
		if [ ! -d "$(NUWAX_DIR)/node_modules" ]; then \
			echo "!!! $(NUWAX_DIR)/node_modules 不存在，前端依赖未安装。"; \
			echo "    先执行：cd $(NUWAX_DIR) && pnpm install"; \
			exit 1; \
		fi; \
	fi
	@mkdir -p $(LOG_DIR)
	@rm -f $(LOG_DIR)/*.log
	@# set -m：后台任务各自独立进程组，便于 Ctrl-C 时按组 TERM→KILL 整树清理
	@set -m; \
	if [ "$(DEV_WEBVIEW)" = "loopback" ]; then unset NUWAX_WEBVIEW_ORIGIN 2>/dev/null || true; fi; \
	FE_PID=""; TAIL_PID=""; EL_PID=""; CLEANED=0; \
	kill_pg_wait() { \
		p=$$1; [ -z "$$p" ] && return 0; \
		kill -TERM -"$$p" 2>/dev/null || kill -TERM "$$p" 2>/dev/null || true; \
		i=0; while [ $$i -lt 10 ]; do \
			kill -0 "$$p" 2>/dev/null || return 0; \
			sleep 0.2; i=$$((i+1)); \
		done; \
		kill -KILL -"$$p" 2>/dev/null || kill -KILL "$$p" 2>/dev/null || true; \
	}; \
	cleanup() { \
		[ "$$CLEANED" = "1" ] && return 0; \
		CLEANED=1; \
		echo ">>> 停止中（TERM，约 2s 后仍存活则 KILL）..."; \
		kill_pg_wait "$$EL_PID"; \
		kill_pg_wait "$$FE_PID"; \
		kill_pg_wait "$$TAIL_PID"; \
		echo ">>> 已停止"; \
	}; \
	trap 'cleanup' EXIT INT TERM HUP; \
	if [ "$(DEV_WEBVIEW)" = "loopback" ]; then \
		echo ">>> [1/3] DEV_WEBVIEW=loopback：跳过 :$(FRONTEND_PORT) 前端 dev server（webview=loopback dist；前端热更请用 make dev DEV_WEBVIEW=dev）"; \
	else \
		echo ">>> [1/3] 启动 nuwax 前端 dev server :$(FRONTEND_PORT)（日志 $(FRONTEND_LOG)）"; \
		( cd $(NUWAX_DIR) && exec pnpm dev --port $(FRONTEND_PORT) ) > $(FRONTEND_LOG) 2>&1 & \
		FE_PID=$$!; \
	fi; \
	echo ">>> [2/3] 镜像主进程日志 $(NUWAX_LATEST) → $(ELECTRON_LOG)（tail -n 0 只记本轮）"; \
	tail -n 0 -F "$(NUWAX_LATEST)" >> $(ELECTRON_LOG) 2>/dev/null & \
	TAIL_PID=$$!; \
	if [ "$(DEV_WEBVIEW)" != "loopback" ]; then \
		echo ">>> 等待前端就绪（最长 180s）..."; \
		ready=0; \
		for _ in $$(seq 1 180); do \
			if curl -fsS -o /dev/null "http://localhost:$(FRONTEND_PORT)/" 2>/dev/null; then ready=1; break; fi; \
			if ! kill -0 $$FE_PID 2>/dev/null; then \
				echo "!!! 前端 dev server 启动失败，日志尾部："; \
				tail -n 30 $(FRONTEND_LOG); \
				exit 1; \
			fi; \
			sleep 1; \
		done; \
		if [ "$$ready" != "1" ]; then \
			echo "!!! 等待前端超时（180s），日志尾部："; \
			tail -n 30 $(FRONTEND_LOG); \
			exit 1; \
		fi; \
		echo ">>> 前端已就绪 http://localhost:$(FRONTEND_PORT)"; \
	fi; \
	if [ "$(DEV_WEBVIEW)" = "loopback" ]; then \
		echo ">>> [3/3] 启动 Electron 壳（DEV_WEBVIEW=loopback → webview 走 loopback 托管 nuwax/dist）"; \
	else \
		echo ">>> [3/3] 启动 Electron 壳（NUWAX_WEBVIEW_ORIGIN=$(NUWAX_WEBVIEW_ORIGIN)）"; \
	fi; \
	node scripts/in-base.js -- make electron-dev & \
	EL_PID=$$!; \
	wait $$EL_PID || true
