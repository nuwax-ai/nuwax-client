# Compatibility entrypoints. All preparation and process management live in the
# cross-platform Node CLI; Windows developers can use npm without installing make.
CLIENT_CLI := node scripts/client/cli.mjs
SUBMODULES := nuwa-electron-shell nuwax nuwax-dist
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
.PHONY: help dev setup frontend-build pack doctor release submodules submodules-latest

help:
	@$(CLIENT_CLI) help

dev:
	@$(CLIENT_CLI) dev --frontend $(FRONTEND_MODE) --port "$(FRONTEND_PORT)" $(ARGS)

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

# Explicitly align all three existing submodules to committed pins. Ordinary dev
# only initializes missing submodules and preserves existing source checkouts.
submodules:
	@git submodule update --init --depth 1 -- $(SUBMODULES)

# Source update, frontend build, artifact push and dual-pin commit form one chain.
submodules-latest:
	@$(CLIENT_CLI) sub:update $(ARGS)
