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
node tests/manual/session-setup-ha/probe.mjs plugin-recovery
# 只想快速冒烟：加 --fast（等待按 1/5 缩短）
```

| 场景 | 放什么 | 应当看到 |
|---|---|---|
| `clean` | 干净目录 | 不存在的会话 `session/load` 约 1–2 秒就报错；`session/new`、对已有会话的 `session/load` 正常返回 |
| `slowmcp` | 一个 20 秒才应答 `initialize` 的 MCP 服务 | `session/load` 在旧的 15 秒预算内无响应，约 21 秒才成功返回 —— 所以恢复超时要比冷启动 MCP 更长 |
| `hangdir` | 工作目录里放一个永不返回的项目级插件 | `session/load` 与回退的 `session/new` 都无响应；同进程里另一个干净目录照常可用；引擎日志停在加载插件那一步 |
| `plugin-recovery` | 先建会话，再放入永不返回的外部插件 | 普通模式恢复卡住；以 `OPENCODE_PURE=1` 重启后恢复原会话，项目权限、技能及插件文件保留 |

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

- 主日志出现 `[SessionSetup] slow restore`（15 秒）、`external_plugins_disabled`（40 秒），
  然后用原 session ID 恢复。原 home 和插件文件不被移动或删除。
- 前端出现确认：说明本次运行暂时跳过所有外部插件，包括插件提供的安全检查。
  确认前消息不发送；拒绝、取消和超时都不会发送；确认后继续原会话。
- 如果跳过外部插件后仍然无法恢复，返回明确错误并保留原会话数据；其他会话不受影响。
- 「导出日志」应包含本次恢复的 `diagnostics/session-setup.json`。

清理：退出应用后删除测试用的 `.opencode/plugins/hang.js`。下一次启动恢复正常插件加载。

## 3. Windows 安装包验收（必做）

进程树和进度事件在 Windows 上需要用安装包再验收一遍：

- 任务管理器里没有残留的 `nuwaxcode.exe`。
- 旧会话 ID 保持不变，并在确认前显示插件停用提示；拒绝与超时均不执行消息。
- 原 home、项目权限、技能与插件文件保留，其他会话不受影响。
- 删除 `hang.js` 并重启后，原会话以正常插件模式恢复。
