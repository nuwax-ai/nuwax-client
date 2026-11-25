# 会话建立阶段高可用（session-setup-ha）手动复现

对应规格 `specs/session-setup-ha.md`、计划 `plans/20261125-session-setup-ha-plan.md`。
这里只放手动验证工具，不进自动化测试。

## 1. 直接驱动引擎：`probe.mjs`

不经过 Electron，直接用 ACP（stdio 上的 NDJSON JSON-RPC）驱动随包的 nuwaxcode，
确认引擎侧行为与主进程恢复链路（`acpSessionRecovery.ts`）的假设一致。

```bash
# 在 nuwa-electron-shell/crates/agent-electron-client 下
node tests/manual/session-setup-ha/probe.mjs clean
node tests/manual/session-setup-ha/probe.mjs slowmcp
node tests/manual/session-setup-ha/probe.mjs hangdir
# 只想快速冒烟：加 --fast（等待按 1/5 缩短）
```

| 场景 | 放什么 | 应当看到 |
|---|---|---|
| `clean` | 干净目录 | 不存在的会话 `session/load` 约 1–2 秒就报错；`session/new`、对已有会话的 `session/load` 正常返回 |
| `slowmcp` | 一个 20 秒才应答 `initialize` 的 MCP 服务 | `session/load` 在旧的 15 秒预算内无响应，约 21 秒才成功返回 —— 所以恢复超时要比冷启动 MCP 更长 |
| `hangdir` | 工作目录里放一个永不返回的项目级插件 | `session/load` 与回退的 `session/new` 都无响应；同进程里另一个干净目录照常可用；引擎日志停在加载插件那一步 |

文件说明：

- `slow-mcp-server.mjs`：延迟应答 `initialize` 的最小 MCP stdio 服务。
- `hang-plugin.js`：让引擎在加载本目录的项目级插件时永不返回。

工具只写系统临时目录下的新目录，结束时删除，并杀掉引擎进程。
前提是 `resources/nuwaxcode` 已就位（`npm run prepare`）。

## 2. 走完整链路：开发环境复现「目录卡死」

这一步才经过主进程的恢复链路（预算、重建进程、熔断、隔离 home、诊断）。

1. 用商业版身份启动开发环境（根目录 `npm run dev`），登录，新建一个会话并发一条消息，
   确认能正常回复。记下该会话 id。
2. 完全退出应用。在该会话的工作目录
   `~/.nuwax/computer-project-workspace/<userId>/<conversationId>/` 下建
   `.opencode/plugins/hang.js`，内容取自本目录的 `hang-plugin.js`。
3. 重新启动应用，在同一个会话里发一条消息。

预期：

- 主日志里依次出现 `[SessionSetup] slow restore`（15 秒）、`♻️ Session setup recovery (load_timeout)`
  （40 秒）、`♻️ Session setup recovery (new_timeout)`，随后是这个会话的 home 被隔离
  （`Quarantined engine home`），新进程里仍然建不出会话时出现
  `[SessionSetup] engine log tail` 与 `[SessionSetup] failed`，原因是 `engine_env_hang`。
- 整条消息在约 2 分半内有结果：前端收到「会话运行环境异常…」的可读文案，而不是
  `java.net.http.HttpTimeoutException`。
- 之后 5 分钟内在该会话再发消息会立刻返回同样的错误（熔断）；其他会话不受影响。
- `~/.nuwax/run/projects/<userId>/<conversationId>/nuwaxcode/` 下出现
  `home.quarantine-<时间戳>`，原会话数据在里面。
- 「导出日志」得到的 ZIP 里有 `diagnostics/session-setup.json` 和
  `engine-logs/<userId>/<conversationId>/nuwaxcode/home/opencode.log`。

清理：删除工作目录里的 `.opencode/plugins/hang.js`；需要找回原会话上下文时，
退出应用后把 `home.quarantine-<时间戳>` 改回 `home`（先删掉隔离后新建的 `home`）。

## 3. Windows 安装包验收（必做）

进程树 kill 与目录改名在 Windows 上行为不同，同样的步骤要在安装包上再走一遍：

- 任务管理器里没有残留的 `nuwaxcode.exe`。
- `home.quarantine-<时间戳>` 改名成功；若因文件占用失败，主日志原因是
  `quarantine_failed`，不重试、不循环。
- 删除 `hang.js`、熔断过期（5 分钟）后，该会话恢复可用。
