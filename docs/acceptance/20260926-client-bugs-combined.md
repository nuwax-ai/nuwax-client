# 客户端 Bug 隔离合流门禁

## 合流状态

- 工作树 `/Users/apple/workspace/nuwax-client-bugs-combined-20260926`。
- 分支 `codex/bugs-client-combined-20260926`，基线 `951aa597`。
- 白屏提交 `30082a60` → 本树 `726793ce`。
- 语言/菜单/终端提交 `50b77e1e` → 本树 `63181189`。
- 基座 pin `f7e3f931`：中立会话 cwd 与 UTF-8 locale 修复；来自独立基座 clone。
- 主共享 checkout 未修改；未推送/发包/部署/修改禅道。

## 门禁

1. 同步 73 个商业 overlay；`overlay --check` 0 差异。
2. `check:pin`：73 个基座脏文件全部是 overlay 同步产物。
3. `npm run test:commercial`：首次因隔离树缺 prepared `resources/mcp-proxy-ts/dist/host/rewrite.js`，MCP suite 59 项未能加载；执行隔离 `prepare:mcp-proxy` 后复跑全门禁：**142 文件通过，1 文件跳过；1753 项通过，18 项跳过；0 失败**。
4. 跳过：macOS 上 Linux bwrap 集成 17 项，加 agentWorkDir 1 项既有 skip。
5. 商业品牌 `NUWAX_APP_IDENTIFIER=nuwax` / `NUWAX_APP_DISPLAY_NAME=女娲 Nuwax` 下 main 与 renderer production 构建通过；renderer 仅既有大 chunk 提示。
6. `git diff --check` 通过；构建产物未提交。

原始日志位于 `/Users/apple/workspace/bug-batch-20260926/evidence/client-integration/`：`combined-commercial.log`（初次资源缺失）、`combined-prepare-mcp.log`、`combined-commercial-prepared.log`、`combined-renderer-build.log`、`combined-main-build.log`。

## 交叉独立评审

- 客户端白屏 agent 独立评审 `50b77e1e + f7e3f931`：可信语言来源、不反传 guest、稳定菜单状态、cwd 关联/歧义回退、LC 优先级，无有证据的 Important；独立 6 文件 110 / 110 通过（`/tmp/client-integration-independent-review.log`）。
- 客户端集成 agent 只读评审白屏 `726793ce`：共享队列失败可续、late start / cookie 镜像 await 后 direct 意图复查、mainframe 与 ERR_ABORTED 过滤、重试 epoch/取消旧 URL resolve、诊断 URL 移除 userinfo/query/hash、沿用 defaultSession 与 will-attach preload 策略，无有证据的 Important。该结论不属于语言/终端作者自批。

## 真实验证与未验边界

- 白屏受控真实 Electron 导航失败/renderer crash/重试取证见 `20260926-bug2537-recovery.md`。
- 语言/菜单真实 Electron 本地 guest、生产 IPC/preload 与 SQLite镜像 CUA 验证见 `../20260926-client-integration-bugs-validation.md`。
- 未打包集成版本；原用户现场白屏根因、未知重开包版本、Windows/Linux 真包菜单、Mac 输入法与真实项目终端 cwd 仍待包/账号环境验收。
- 全门禁与构建通过只作为实现合流证据，不据此关闭工单。
