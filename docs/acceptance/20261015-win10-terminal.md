# Win10 1511 终端修复提测记录

## 范围与结论

- 工单：<https://zt.nuwax.com/index.php?m=bug&f=view&bugID=2675>。
- 基线：客户端 `v3.0.15`，基座 `eb0eeaca96ac32b1a671bf1bd570dc3a5dd059d0`；独立工作树，不含原工作区 pi-agent 在途源码。
- 目标：Win10 1511 / Build 10586 x64 保留内嵌终端。当前缺少目标系统设备，按用户要求由原反馈人安装 `3.0.16-beta.1` 复测。
- **Win11 的结果仅算回归，不代表 Win10 1511 兼容验收通过。**

## 三问质量自查

1. **内聚**：系统分支在 `overlay/crates/agent-electron-client/src/main/services/system/ttydPlatform.ts:5`；WebSocket 与会话生命周期在 `native/legacy-terminal/server.go:35` / `session.go:60`；WinPTY/pipe/job 资源在 `winpty_windows.go:118` / `winpty_windows.go:246`。检查中补齐裸 CMD 降级时忽略 URL 参数的原有语义，并测试关闭发生在 PTY 创建期间的清理。
2. **分层**：binaryLocator 只选择可执行文件，serviceManager、现有 gateway、前端和业务地址不变。兼容程序使用独立进程和 DLL API，不向 Electron 注入旧版 Node 原生插件。所有商业代码位于壳仓或 overlay，未提交基座同步产物。
3. **维护**：WinPTY 归档与二进制 SHA256、Go 工具链、go.sum 固定；准备、缓存失效和真实包体验证集中于 `scripts/client/terminal-compat-resources.mjs:37` / `:60`。CI 同时跑协议测试与 Windows 回归，两条发布链均准备并核验实际入包资源。编译产物在专用目录自忽略，不修改基座 .gitignore。

结论：本次修复可进入 Beta 提测；目标系统兼容性仍待反馈人确认。

## 已完成验证

| 验证 | 结果 |
|---|---|
| 隔离社区 `npm run base:test` | 135 文件通过，1640 项通过，18 跳过 |
| 隔离商业 `npm run test:commercial` | 245 文件通过，3054 项通过，18 跳过 |
| `npm run test:scripts` | 347 项通过；最终资源脚本改动另跑相关 50 项全部通过 |
| Go 协议与竞态 `go test -race ./...` | 8 项通过 |
| 新平台选择模块严格类型检查 | 通过 |
| 主进程生产 esbuild | 通过 |
| 源码边界、appdir、overlay 一致性、宿主契约 | 通过 |
| 基座 worktree / origin/main 纯净守卫 | 通过；同步产物 326 个均为 overlay |
| Win11 Build 26200 强制 WinPTY 回归 | 中文、两个含空格工作目录、133×43 缩放、Ctrl+C、断连进程树清理、另一会话存活均通过 |

完整 `tsc -p tsconfig.main.json` 仍有 7 条既有错误（capture renderer 别名/DOM iterable、OpenDevToolsOptions、IM snapshot 类型）。将 binaryLocator 恢复为 `v3.0.15` 的商业源码对照运行，诊断字节完全相同；本修复未增加诊断，不以此宣称全量 tsc 通过。

本地隔离验证仅复用已安装依赖和 mcp-proxy 资源；依赖符号链接在该隔离基座的本地 info/exclude 中列明，不忽略源码改动。

## 反馈人复测

1. 在原 Win10 1511 机器退出旧客户端，安装 Beta，确认版本 `3.0.16-beta.1`。
2. 登录，确认终端服务正常运行、整体服务不再因 ConPTY 报错。
3. 在不同会话打开内嵌终端，确认各自项目目录；执行中文回显命令。
4. 调整终端尺寸，执行长时间命令后 Ctrl+C；关闭一个终端，确认另一个仍可操作。
5. 退出客户端，确认无遗留终端进程；失败时导出本次日志。

复测结果回填前不关闭工单，不把 Win11 回归记作目标兼容通过。
