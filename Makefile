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
.PHONY: help dev dev-direct setup frontend-build pack doctor release submodules submodules-latest

help:
	@$(CLIENT_CLI) help

dev:
	@$(CLIENT_CLI) dev --frontend $(FRONTEND_MODE) --port "$(FRONTEND_PORT)" $(ARGS)

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
