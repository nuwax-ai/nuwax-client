# 商业版移除旧 computer use 资源

问题：CUA 已是商业版唯一 computer use 实现，但社区基座的 prepare:all、本地 prepare 和 electron-builder extraResources 仍准备并打包 agent-gui-server / windows-mcp。Windows 停止服务和退出时仍会加载旧管理库并扫旧端口。

- 商业 prepare:all 跳过两项旧资源；本地工具链不再构建 GUI server 或准备 Windows MCP。
- 正式/开发 CI 与本地 builder 配置均排除两项资源，保留 computer-use helper。
- 商业 overlay 用无依赖的停用兼容接口替代旧管理实现：启动明确不可用，停止无副作用，状态关闭、URL 空；覆盖继承的 IPC、引擎与 serviceManager 调用，避免加载旧管理库或杀旧端口。
- 保留社区基座实现和现有 WIP，不修改已发布 tag；历史安装速度报告属于历史证据。
- 验证脚本测试、prepare:all 两种产品 dry-run、商业兼容接口行为、商业构建与相关回归。真实 Windows 安装包和新 CI 发版单独验收。
