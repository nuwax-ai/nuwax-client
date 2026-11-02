# Nuwax Harness 接入

客户端的 Codex 引擎统一通过 Nuwax Harness 接入：

```text
Nuwax 客户端 → nuwax-harness-acp-ts → nuwax-harness app-server → 模型服务
```

- 适配器：`@nuwax-ai/nuwax-harness-acp-ts`，入口 `dist/index.js`，由内置 Node 执行。
- 引擎：适配器依赖的 `@nuwax-ai/nuwax-harness`；随包资源位于 `resources/nuwax-harness-acp-ts/vendor/nuwax-harness/<版本>/`。
- `codex`、`codex-cli` 是既有引擎与会话标识；`nuwax-harness`、`nuwax-harness-acp-ts` 命令映射到相同实现。
- ACP 继续承担会话、权限与消息通信。适配器解析失败直接报错。

## 资源准备

日常从仓库根运行 `npm run setup`、`npm run dev` 或 `npm run pack`。
定向重建资源使用 `npm run shell:exec -- -- npm --prefix crates/agent-electron-client run prepare:harness`。
准备脚本根据引擎包的 `requiredBundleFiles()` 复制完整运行文件集；不复制缓存中的其他文件。

启动时主进程把引擎绝对路径注入 `NUWAX_PATH`，避免隔离 HOME 后找不到真实用户缓存。
依赖缺失时，应用内安装通道使用同一 harness 适配器包。

## 模型与会话配置

请求解析层提供模型、服务地址、API key 和协议族。适配器继续使用 `CODEX_MODEL`、
`CODEX_BASE_URL`、`CODEX_API_KEY` 等配置字段；这些名称属于当前引擎契约。
OpenAI 兼容请求设置 `CODEX_WIRE_API=chat`；Anthropic 请求设置
`NUWAX_API_PROTOCOL=anthropic`，不携带 wire API 配置。

`CODEX_HOME` 和 `CODEX_SQLITE_HOME` 使用会话隔离目录；日志目录通过
`CODEX_LOG_DIR` 与 `APP_SERVER_LOGS` 传递。具体配置与隔离规则见
`services/engines/acp/acpClient.ts`。
