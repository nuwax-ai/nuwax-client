# Compatibility entrypoints. All preparation and process management live in the
# cross-platform Node CLI; Windows developers can use npm without installing make.
CLIENT_CLI := node scripts/client/cli.mjs
SUBMODULES := nuwax nuwax-dist
DEV_WEBVIEW ?= loopback
FRONTEND_PORT ?= 3000
ARGS ?=

ifeq ($(DEV_WEBVIEW),loopback)
FRONTEND_MODE := dist
else ifeq ($(DEV_WEBVIEW),dev)
FRONTEND_MODE := source
else
$(error DEV_WEBVIEW must be loopback or dev)
endif

.DEFAULT_GOAL := dev
.PHONY: help dev dev-direct dev-uos setup frontend-build pack doctor release submodules submodules-latest harness-local

help:
	@$(CLIENT_CLI) help

dev:
	@if [ -z "$$HARNESS_LOCAL" ]; then node scripts/sync-local-harness.mjs --restore --quiet 2>/dev/null || true; fi
	@bash scripts/client/with-model-capture.sh $(CLIENT_CLI) dev --frontend $(FRONTEND_MODE) --port "$(FRONTEND_PORT)" $(REFRESH_FLAG) $(ARGS)

# UOS 1050 (arm64) 本地启动客户端。这台机器没有系统 Node、开发副本没有 .git、
# 原生模块需按 glibc 2.28 重编，且开发模式关沙箱会打死沙箱化 webview；
# 本命令做前置检查与环境装配后复用 dev-direct 启动。
# 仅限 linux/arm64；--check-only 只做检查不起客户端。
dev-uos:
	@node scripts/client/dev-uos.mjs $(ARGS)

# Lightweight commercial dev: the shell in commercial identity against the production
# webview (direct https://agent.nuwax.com). Unlike `make dev` (loopback dist with
# pinned frontend submodules), this skips frontend preparation entirely.
# Identity env comes from scripts/run-shell.cjs (single source of truth), which also
# runs the crate's own dev entry (resources check + vite + electron).
# Caveats: shares the real commercial data dir (~/.nuwax) and its single-instance
# lock — quit the installed Nuwax.app first. First-run nuwaxcode release download
# may need GH_TOKEN (GitHub API rate-limits unauthenticated requests).
dev-direct:
	@echo ">>> Commercial direct dev: production webview + local shell"
	@node scripts/run-shell.cjs -- npm run dev --prefix crates/agent-electron-client

setup:
	@$(CLIENT_CLI) setup $(ARGS)

frontend-build:
	@$(CLIENT_CLI) frontend:build $(ARGS)

pack:
	@$(CLIENT_CLI) pack $(ARGS)

doctor:
	@$(CLIENT_CLI) doctor $(ARGS)

release:
	@$(CLIENT_CLI) release $(ARGS)

# Explicitly align both existing submodules to committed pins. Ordinary dev
# only initializes missing submodules and preserves existing source checkouts.
submodules:
	@git submodule update --init --depth 1 -- $(SUBMODULES)

# Source update, frontend build, artifact push and pin commit form one chain.
submodules-latest:
	@$(CLIENT_CLI) sub:update $(ARGS)

# Local harness integration: build the fork's nuwax-harness engine from source,
# swap it into the dev resources, then start dev WITH that local engine — one
# command to test unreleased engine changes, no npm publish needed.
# Plain `make dev` always auto-restores the released engine first, so the two
# modes never interfere.
# HARNESS_PROFILE=dev builds much faster (debug); HARNESS_VERSION=0.18.33-dev stamps.
# 模型请求抓包:`make dev` / `make harness-local` **默认开启**,请求与响应落到
# logs/model-capture.log(每次启动截断)。关闭:`NUWAX_MODEL_CAPTURE=0 make dev`。
# 换端口:`CAPTURE_PORT=19000`。想单独前台看日志用 `make model-capture`。
# 源码类资源(nuwax-file-server / claude-code-acp-ts)默认拉取上游最新:
# CLI 的准备流程会复用 .cache/client-toolchain/sources 里的旧克隆,不 fetch,
# 于是本地可能长期停留在旧版本(2026-11-18 本地 1.6.2 而上游已 1.6.4;
# npm 的 prepare:all 路径每次都解析远程 commit,所以 CI 不受影响)。
# 关闭:`REFRESH_RESOURCES=0 make dev`
REFRESH_RESOURCES ?= 1
REFRESH_FLAG := $(if $(filter 0,$(REFRESH_RESOURCES)),,--refresh-resources)
CAPTURE_PORT ?= 18777
model-capture:
	@node scripts/client/model-capture-proxy.mjs --port $(CAPTURE_PORT) --log logs/model-capture.log

# 本地验证待办清单(update_plan):默认开启,`NUWAX_UPDATE_PLAN=false make harness-local` 关闭。
# 这个是引擎侧开关,会经 Electron -> ACP 适配器 -> app-server 子进程透传(NUWAX_ 前缀,
# 不在适配器的消费清单里),因此设置在这里就够,不需要改适配器或客户端代码。
# 注意只有源码构建的引擎才有这个开关(0.18.68 及更早的 npm 版没有)。
NUWAX_UPDATE_PLAN ?= true
harness-local:
	@node scripts/sync-local-harness.mjs --ensure-frontend
	@node scripts/sync-local-harness.mjs
	@HARNESS_LOCAL=1 NUWAX_UPDATE_PLAN=$(NUWAX_UPDATE_PLAN) bash scripts/client/with-model-capture.sh $(CLIENT_CLI) dev --frontend $(FRONTEND_MODE) --port "$(FRONTEND_PORT)" $(REFRESH_FLAG) $(ARGS)
