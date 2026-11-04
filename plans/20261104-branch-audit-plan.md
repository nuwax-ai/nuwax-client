# 当前仓库分支审计与 3.1 漏合修复整合

## 范围

- 用户授权：审计当前 `nuwax-client` 的未处理 PR 和独立分支，删除没有继续保留价值的 topic，有价值且可独立验证的改动经 PR 合入当前 `release/v3.1.0`。
- 基线：`b0d1bd5b`，已 fetch/prune 并执行 ff-only pull，与远端一致。
- 使用独立 worktree；原工作区的 IM 恢复、Browser 样式、规格及未跟踪文件原样保留。其他工作区占用的分支、发布线、显式归档和备份不删除。
- 不改其他仓库、不更新前端双 pin，不纳入终端持久化、运行实例管理，不发版或打安装包。

## 评估与处置

| 候选 | 结论与证据 |
| --- | --- |
| PR #80 / `ci/frontend-gate-fastpath` | 已关闭。CI 优化已由 `72bb9ea4` 进入当前线；剩余独立提交 `9916df33` 为无文件改动的热缓存验证提交，旧 PR 指向 `release/v3.0.23`，没有新增可合内容。 |
| `fix/nw318-webview-find` / `aec6a421` | 有价值，选入本批 PR。补齐主业务 webview 的 Cmd/Ctrl+F；与 Browser 独立窗口的既有查找是不同入口。 |
| `codex/theme-plugins` / `7cc8ee92` | 网关修复可独立使用，选入本批 PR；主题本体 `913802de` 继续保留。主题桥和核心快照依赖另一仓库尚未推送的主题前端，不能在仅处理本仓的范围内合入一个 CI 无法获取的源码 pin。既有主题安装包验收 4/4 停止状态保持。 |
| `codex/client-efficiency-pilot` / `9e81e959` | 有价值，选入本批 PR。复用现有域测试，增加有输入、环境和日志摘要的验证记录。解决旧分支 `.sdlc.json` 冲突时保留当前 `nuwa-electron-shell/` 路径和 `test:commercial`，不恢复旧 `base:test`。 |
| `fix/nw181-notify-remark-name` | 已由 `49bbec0a` 的当前通知取名实现替代；当前实现在异步查询后还会再次核对账号、锁屏和前台状态，不重复合旧缓存实现。源分支所在工作区有改动，保留。 |
| Browser / 安装稳定性 / CUA 权限 topic | 按当前实现和后续提交核对，已合入或被替代：`a91306a0`、`059d1960`、`49bbec0a`、`1f947181`、`32a50e90`、`6efe1eb2` 等。旧 overlay/子模块历史的 SHA 不同不代表缺少功能。 |
| 旧发布准备、安装/更新、安全和能力端口分支 | 已被当前发布线吸收或后续实现替代，删除闲置 topic；旧 pi-agent 独立集成与当前统一 Harness 方向不符，不恢复旧引擎实现。历史 Dependabot 分支针对旧工作流，不整体搬回旧发布链。 |
| `feat/plan-mode-mcp` | 保留设计候选。只有 2026-09-18 的跨仓接口设计，尚无可独立交付的实现；不能把文档方案当成已实现功能合入发布线。需按当前 Harness 与前端契约重新评估后实施。 |
| `codex/nw044-session-status` | 保留调查证据。未稳定复现的原始问题继续延期；本批没有修复或关闭该问题。 |

## 已完成的分支清理

- 初始清单：含本次整合分支共 79 个本地分支、54 个远端引用（包含 `origin/HEAD`）。
- 已删除 54 个闲置本地 topic、38 个远端 topic；删除前重新核对 SHA 和工作区占用，未发现需跳过的并发变化。
- 删除前保存逐分支 SHA 清单，并生成和验证恢复 bundle。仅删除引用，没有清理工作目录、未提交改动或产品数据。
- 逐分支清单与删除结果保存在仓外证据目录的 `branches-before.json`、`deletion-plan.json`、`deletion-result.json`；可恢复历史为 `deleted-branch-history.bundle`。

## 验证

- `npm run test:commercial`：302 文件通过；3738 项通过、1 项跳过、0 失败。
- webviewPolicy / loopbackGateway 定向回归：123 项通过。
- `npm run test:scripts`：410 项通过、0 失败。
- `npm run typecheck`、`host-bridge:check`、`check:boundaries`、`check:appdir`、`git diff --check`：通过。
- `npm run verify:tooling`：四项 predicate 全部通过；没有执行产品打包。doctor 的结构通过不代表环境 ready 或实机验收通过。
- 商业身份主进程及 preload 构建：通过，产出包含新的 `webviewFind.js`。
- 原 NW-318 提交有 Electron 查找引擎证据；当前批次尚未完成原生键盘焦点和 Windows 安装包验收，不将源码测试当成实机结论。
- 证据目录：`/Users/apple/Documents/Codex/2026-11-04/nuwax-client-branch-audit/`。

## 三问与 REVIEW 五遍自查

- 内聚：查找条的状态、请求、焦点和清理集中在 `main/services/system/webviewFind.ts:31`；网关开发态判断集中在 `loopbackGateway/index.ts:104`；工具链记录归 `scripts/sdlc-verify.mjs:68`。
- 分层：查找条使用自有沙箱 preload，经所属 WebContents 的 IPC 接收命令，并核对发送者、主 frame 和固定 data URL（`webviewFind.ts:122`）；不新增业务宿主桥契约。网关仅在未打包的开发档案和 HTTP 前端下启用，保持现有设置值。
- 维护：查找请求编号过滤迟到结果，导航/失焦/销毁撤销监听与计时器；验证器拒绝跨仓符号链接输入，复用时校验 source、环境与日志摘要，运行期间输入变化会判失败（`sdlc-verify.mjs:91`、`:144`）。
- 已按 REVIEW 检查逻辑、安全、范围、分层和证据；自查不代表作者自批。待 PR CI 通过后按用户授权合并。
