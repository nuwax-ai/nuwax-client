# Nuwax 客户端壳源码

本目录属于 `nuwax-client` 仓库，直接维护 Electron 客户端、引擎 SDK 和构建工具。源码修改、评审、测试及发布均在当前仓库完成；不单独检出、更新或发布原基座仓库。

## 开发入口

以下命令从 **nuwax-client 仓库根目录**运行：

```bash
npm run setup
npm run dev
npm run dev -- --frontend source
npm run test:commercial
npm run test:scripts
npm run pack
npm run release -- --version X.Y.Z-beta.N --dry-run
```

开发、打包和发布统一由根目录 `scripts/client/cli.mjs` 编排。低层脚本供该编排和定向检查使用；直接启动 crate 不会自动获得完整的产品配置和资源准备。

## 目录

| 路径 | 职责 |
|---|---|
| `crates/agent-electron-client/` | 主进程、preload、renderer、IPC、桌面能力及打包实现 |
| `crates/agent-kit/` | ACP、引擎和 MCP 桥原语；本仓通过本地 workspace 引用 |
| `crates/agent-gui-server/` | 保留的 GUI 服务组件；当前 Computer Use 采用仓库根的 CUA helper 构建链 |
| `scripts/` | 壳内构建和资源准备工具 |

前端源码与产物分别位于仓库根的 `nuwax/`、`nuwax-dist/` 子模块。它们是独立的前端输入，壳目录自身不是子模块。

## 产品配置与检查

产品身份、更新地址和发布目标由根目录 `client.config.mjs` 及构建入口注入。内部包名、未注入环境时的缺省值和兼容标识不用于选择另一套源码；不要通过改名或直接运行底层脚本切换产品。

完整商业测试入口为 `npm run test:commercial`，不注入构建身份，保留缺省值断言和专项身份测试。定向测试可使用：

```bash
npm --prefix nuwa-electron-shell/crates/agent-electron-client run test:run -- <测试文件>
```

当前工程约束见 [AGENTS.md](./AGENTS.md)、[模块地图](./MODULES.md)；日常命令见[根 README](../README.md)和[npm 脚本参考](../docs/npm-scripts.md)。发布流程见[发布与更新通道](../docs/release-channels.md)。历史文档只记录当时状态，不作为当前开发入口。
