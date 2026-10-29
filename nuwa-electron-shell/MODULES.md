# 客户端模块地图

下列模块直接由 `nuwax-client` 维护，路径相对于 `nuwa-electron-shell/`。当前代码修改随同一仓库提交、评审和发布。

## 客户端与 SDK

| 位置 | 职责 |
|---|---|
| `crates/agent-kit/` | 引擎解析、ACP、MCP 桥、权限决策和启动重试原语；保持无 Electron 宿主依赖 |
| `crates/agent-electron-client/src/main/` | 桌面能力、窗口、服务、SQLite、IPC 和生命周期 |
| `crates/agent-electron-client/src/preload/` | 受来源及权限限制的宿主桥 |
| `crates/agent-electron-client/src/renderer/` | 客户端界面，通过桥调用主进程 |
| `crates/agent-electron-client/src/shared/` | 共享契约、常量与构建身份 |

## 主进程功能域

| 位置（相对客户端 src/main） | 职责 |
|---|---|
| `features/capture/` | 截图、录屏、系统快捷键及捕获会话 |
| `features/computer-use/` | Computer Use 任务、控制权限与 driver 生命周期 |
| `services/engines/` | 引擎管理、统一 Agent 与 ACP 适配 |
| `services/system/` | 系统环境、依赖和进程管理 |
| `services/packages/` | MCP、终端等资源集成 |
| `services/computer/` | 设备服务、请求分派与会话通信 |
| `services/loopbackGateway/` | 前端本地承载、认证路由、代理和文件访问 |
| `services/autoUpdater.ts` | 产品更新通道 |

平台 CUA helper、截图编码资源和终端兼容组件由仓库根 `scripts/computer-use/`、`scripts/client/`、`native/` 及来源锁管理；准备脚本只消费指定版本，开发者源码与生成资源保持隔离。

## 扩展与验证

- 与 Electron 无关的引擎原语优先落在 agent-kit；新桌面能力落在客户端已有功能域，页面不直接调用系统能力。
- 商业登录、域名、服务生命周期与本地文件授权在主进程统一管理，具体约束以[根 AGENTS.md](../AGENTS.md)和[工程边界](../docs/architecture.md)为准。
- 宿主桥类型事实源在 `nuwax/` 前端仓，本仓生成类型快照并用 `npm run host-bridge:check` 核对。
- 根目录 `npm run test:commercial` 执行完整商业测试；`npm run test:scripts` 检查工具链。构建、签名和安装包实机验收分别记录。
