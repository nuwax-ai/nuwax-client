# NW-041 常规项目多对话并行：审查与回归记录

日期：2026-10-14（Asia/Shanghai）。验证环境：macOS arm64，隔离检出，社区与商业 overlay 分别运行。

## 来源与结论

- 基座修复 PR：https://github.com/nuwax-ai/nuwa-electron-shell/pull/30
- 同事原修复：`ad784f64b4007ed1faf556572d41c06bb01dd514`。
- 补充失败回归：`d94e7720`；补修及活跃 prompt 回归：`f937dac0`。
- 基座更新前 pin：`d4d0e68c797d8130f9a7cd2ec3e93cb0b60d3692`。
- PR 已合入基座 main，合并提交及客户端新 pin：`e75c9d5cd334e203520aaee6fecb6c84ed4561e5`，合并树与已验证的 `f937dac0` 完全一致。
- 已确认源码和自动化回归修复了按共享目录归并对话、导致新对话抢占旧对话的问题。安装包与真实账号的验收范围见下文。
- 15:24–15:28 已通过 macOS 开发客户端、真实测试账号和 ACP 子进程验收：测试站点 direct 模式下，同常规项目双对话并行、单独停止 B、继续 B 与 A 完整返回均正常。具体证据见「真实开发客户端验收」。

## 审查发现与补修

原修复将引擎注册、派发和会话归属改为 conversationId（`project_id`）优先，`agent_work_dir` 继续决定共享 cwd。IPC 状态与取消也按 conversationId 定位。

读取侧候选 key 原先仍包含共享的 `agent_work_dir`：当新对话没有注册记录，而目录 id 与另一 conversationId 撞号时，会继承另一对话的 session、关闭其 SSE，或在 devcomputer reload 时停止其引擎。新增 3 个用例在原修复上均失败；补修后，携带 conversationId 的请求不再探测目录 id，未携带 conversationId 的旧请求仍保留目录回退，`session_id` 可精确恢复。

质量三问：

| 检查 | 结论与证据（基座相对路径） |
| --- | --- |
| 功能逻辑内聚 | 通过。`src/main/services/computer/chatEngineKey.ts:38`、`:60`、`:94` 维护注册和读取规则；`src/main/services/engines/acp/acpSessionSetup.ts` 维护会话归属，cwd 仍由目录解析函数决定。 |
| 代码分层 | 通过。Computer IPC、HTTP 派发、SSE 和 reload 消费服务层规则；商业实现只经外层 overlay 注入，无新前端协议。import boundary 门禁通过。 |
| 便于维护 | 通过。补齐共享 cwd / 独立对话的注释，新增跨对话读取回归与真实 AcpEngine.chat / prompt 生命周期回归；重要发现均已处理。 |

## 验证证据

| 验证 | 结果 |
| --- | --- |
| 原修复的 3 个关键测试文件 + 旧基座实现 | 13 failed / 28 passed，包含第二对话错误复用第一 session 的失败断言。 |
| 读取侧补充回归 + 原修复 | 3 failed / 25 passed，覆盖 session 补全、SSE 清理、reload 的跨对话干扰。 |
| 最终 `npm run base:test` | 1625 passed / 18 skipped，134 个测试文件通过、1 个跳过。 |
| 最终 `npm run test:commercial` | 2829 passed / 18 skipped，218 个测试文件通过、1 个跳过。 |
| nuwaxcode / claude-code 活跃 prompt 回归 | 两对话同时保持执行、session 不同且 cwd 相同；取消 B 后 A 仍活跃；同对话新 turn 复用原 session 并取消原 turn。用例见 `src/main/services/engines/acp/acpEngine.test.ts:1212`。 |
| overlay 兼容检查 | 基座修复与商业 overlay 的文件交集为 0。 |
| 基座纯净与分层门禁 | staged、工作树、remote 字节检查及 import boundary 通过。 |
| 商业生产构建 | 主进程 esbuild、macOS arm64+x64 通知权限 addon、renderer Vite 构建通过。 |
| GitHub CI | Linux fresh checkout 的 vitest 通过：[CI run](https://github.com/nuwax-ai/nuwa-electron-shell/actions/runs/38522119303)；PR 标题门禁通过。 |

隔离检出复用了本机已安装的依赖及 MCP 测试资源。首轮全量社区测试因隔离副本缺少 `resources/mcp-proxy-ts/dist/host/rewrite.js` 导致 MCP 用例失败；补齐已有资源后重新运行全量通过。此失败归属测试环境。

## 验收范围

活跃 prompt 用例运行实际 AcpEngine.chat / prompt / abort 生命周期，ACP 连接为 mock。它证明客户端会话解析和取消逻辑的隔离，但不替代真实 ACP 子进程、模型服务、账号、安装包及 UI 验收。

本次没有发布新版本，也没有移动任何发布指针。已在运行的旧客户端进程需要重新启动，安装包需要从新基座重新构建后才包含修复。

真实安装包验收步骤：在同一常规项目创建 A/B 两个对话，让 A 持续执行时启动 B；确认 A/B 均继续输出，session_id 不同、cwd 相同，B 到达时没有针对 A 的 `New chat supersedes in-flight turn` / session/cancel；停止 B 后 A 继续执行；分别切换对话和恢复会话，确认状态、SSE 和停止按钮指向各自对话。macOS / Windows 应各自记录包版本、基座 SHA 和客户端日志证据。

## 真实开发客户端验收

2026-10-14 15:24–15:28（Asia/Shanghai），macOS arm64。客户端工作树 `release/v3.0.x@c2f7df5f692f3d64fd5f7c3a25daf480100fe2b2`，基座 pin 仍为 `e75c9d5c`；已同时合入 Computer Use 与本地文件功能 overlay。主进程按此工作树重新构建，测试引擎为 `claude-code` ACP，页面模型显示 DeepSeek V4.1 Flash。

按用户要求保持 WebView **direct**：实际加载 `https://testagent.xspaceagi.com`，日志 `override: null`、`loopback: null`、`step1ServerHost: https://testagent.xspaceagi.com`。未使用本地前端源码或 loopback 加速页面。测试站点页面上报 `gitHash: 786b93fc9`。本机 HTTP 服务 `61006` 健康。

先前在云端项目中新建对话时，首页选择本机仍被项目绑定覆盖为云端；那些请求未进入客户端，不能计入 NW-041 验收。此次通过「创建常规项目」表单，在项目创建时选定 `DONG-MBP128`，创建专用项目 **NW-041 本机并行验收 1014**（normalProject id `539`），随后两条对话均显示本机且实际请求进入客户端。

| 对话 | conversationId / engine key | ACP session_id | 结果 |
| --- | --- | --- | --- |
| A | `1695527` / `normalProject:1695527` | `c3360891-3f03-431b-8825-7c560e37673a` | 前台执行打印标记 + `sleep 180` + 打印完成标记；期间新建 B、停止 B、继续 B，A 始终 Busy，最终 UI 返回 `NW041_DIRECT_A_OK`。 |
| B | `1695528` / `normalProject:1695528` | `1a4aae5d-396d-41ba-b32f-499c7c024be7` | 首轮前台 `sleep 180` 在执行中通过 UI 停止；后续在原对话前台 `sleep 30`，复用自己的 session，UI 返回 `NW041_DIRECT_B2_OK`。 |

关键证据：

- 15:24:22 / 15:25:17 分别创建 A/B 引擎；两次日志 cwd 均为 `<workspace>/normalProject/539`，session 不同。
- 15:25:29 左右通过 `/computer/agent/status` 查询，A/B 同时为 Busy。
- 15:25:59 UI 停止 B，日志只有针对 B session 的 `Cancel succeeded`；紧接查询 A Busy、B Idle。
- 15:26:36 B 后续 turn 派发 key 为 `normalProject:1695528`、gen=2，返回原 B session，`reloaded=false`；查询 A/B 再次同时为 Busy。
- 分别切回 A/B，UI 显示各自完成标记；最终状态查询两者均 Idle，session 未串用。
- 从本轮验收起点截取的日志中，`New chat supersedes in-flight turn` 和 `Engine switch failed` 均为 0。全部终端命令仅打印与等待，没有请求创建、修改或删除文件，也没有请求访问网络。

本地脱敏证据位于 `.cache/client-toolchain/acceptance/nw041/direct-lifecycle.log`、`direct-runtime.jsonl` 与 `direct-start.json`（ignored，不提交原始账号/鉴权日志）。开发客户端继续保持运行，供用户进一步验收。

启动说明：并行合入批次更新了 `nuwax` 源码 pin 至 `7cd54922b`，尚未同步对应 `nuwax-dist` 产物戳；标准 `npm run dev` 的产物一致性预检因此退出。本轮复用已完成 prepare 的资源，通过现有 dev 编排入口启动、重新构建主进程，不修改或发布任何 pin；WebView 直接使用测试站点，未消费不一致的前端产物。该预检问题与 NW-041 会话隔离无关，后续恢复标准入口需对齐产物。

结论：**NW-041 在 macOS 当前开发客户端、测试环境 direct 模式的真实 UI/模型/ACP 验收通过。** 本轮仍不代表新安装包或 Windows 验收，也未创建发布版本。
