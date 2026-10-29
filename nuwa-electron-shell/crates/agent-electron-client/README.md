# Nuwax Electron 客户端

本目录是 `nuwax-client` 仓库中的 Electron 应用实现，直接在当前仓库维护。开发和发布以[仓库根 README](../../../README.md)、[npm 脚本参考](../../../docs/npm-scripts.md)为准。

## 目录边界

- `src/main/`：窗口、服务、设备/登录生命周期、桌面能力和 IPC。
- `src/preload/`：受来源与权限限制的宿主桥。
- `src/renderer/`：客户端 React 界面。
- `src/shared/`：共享类型、常量和构建身份。
- `scripts/`、`build/`：本仓调用的构建、打包、签名和安装实现。

完整开发约束见 [AGENTS.md](./AGENTS.md)，模块地图见 [MODULES.md](../../MODULES.md)。

## 命令

从 **nuwax-client 仓库根目录**执行 `npm run setup`、`npm run dev`、`npm run pack`、`npm run release`，由统一工具链准备依赖、前端与产品身份。

完整客户端测试使用根 `npm run test:commercial`。定向验证可用：

```bash
npm --prefix nuwa-electron-shell/crates/agent-electron-client run test:run -- <测试文件>
```

底层 crate 保留构建实现和兼容标识，不能通过直接运行底层 dev/签名命令替代根目录的产品准备与发布准入。
