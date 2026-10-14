# NW-041 常规项目多对话并行：审查与回归记录

日期：2026-10-14（Asia/Shanghai）。验证环境：macOS arm64，隔离检出，社区与商业 overlay 分别运行。

## 来源与结论

- 基座修复 PR：https://github.com/nuwax-ai/nuwa-electron-shell/pull/30
- 同事原修复：`ad784f64b4007ed1faf556572d41c06bb01dd514`。
- 补充失败回归：`d94e7720`；补修及活跃 prompt 回归：`f937dac0`。
- 基座更新前 pin：`d4d0e68c797d8130f9a7cd2ec3e93cb0b60d3692`。
- PR 已合入基座 main，合并提交及客户端新 pin：`e75c9d5cd334e203520aaee6fecb6c84ed4561e5`，合并树与已验证的 `f937dac0` 完全一致。
- 已确认源码和自动化回归修复了按共享目录归并对话、导致新对话抢占旧对话的问题。安装包与真实账号的验收范围见下文。

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
