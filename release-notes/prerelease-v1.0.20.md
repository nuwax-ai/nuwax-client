# 女娲Nuwax 1.0.20（beta）

修复个人电脑部分智能体（Codex 引擎）会话发消息即报「Failed to create engine: ACP connection closed」的问题。

## 变更

### 引擎

- 修复 Codex 引擎命令别名映射缺失：后端按适配器包名 `nuwax-codex-acp-ts` 下发引擎命令时，客户端未能将其识别为 Codex 引擎，落入自定义 agent 分支后以裸命令名启动，机器上无此可执行文件导致启动失败（spawn ENOENT），会话报「Failed to create engine: ACP connection closed」。现正确路由到随包内置的 Codex 适配器，无需系统安装任何组件。

## 升级须知

- 含 1.0.19 全部变更及此前 beta 版全部变更。
- 数据目录 `~/.nuwax`、更新通道不变，存量 beta 客户端可直接在线更新。
- Windows beta 包为未签名构建（正式版手签）；SmartScreen 提示「未知发布者」选「仍要运行」。mac 双架构自动签名+公证。
