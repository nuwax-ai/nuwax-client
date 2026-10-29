# 实施计划:Developer Tools 引擎强制开关(切 nuwax-harness-acp-ts)

- 对应 spec:无(dev-only 小需求,单件 plan)
- 状态:已完成(2026-10-29;验证:构建绿 + 引擎域 28 文件/423 用例全绿)

## 目标

DevToolsPanel(仅 IS_DEV 渲染)新增开关,默认关;开启后所有 agent 请求的引擎强制改走
`nuwax-harness-acp-ts` 适配器,模型配置(key/base_url/model/api_protocol)照常从请求的
model_provider 读取注入。复用既有 `NUWACLAW_FORCE_ENGINE` 强制引擎钩子,不新增引擎路由。

## 改动文件清单

| # | 文件 | 动作 | 说明 |
|---|---|---|---|
| 1 | `src/shared/constants.ts` | 增 | `DEV_FORCE_ENGINE_SETTING_KEY = "dev.force_engine"` 与 `DEV_FORCE_ENGINE_HARNESS = "nuwax-harness-acp-ts"`(renderer/main 共用) |
| 2 | `renderer/components/dev/DevToolsPanel.tsx` | 改 | antd Switch 行(默认关),读写上述 settings 键;面板硬编码英文,不动 i18n |
| 3 | `services/engines/unifiedAgent.ts` | 改 | force-engine 块改双来源:`NUWACLAW_FORCE_ENGINE` env 优先,其次 `readSetting("dev.force_engine")`;保持 `NODE_ENV=development` gate |
| 4 | `services/engines/acp/acpClient.ts` | 改 | codex env 分支:`config.apiProtocol === "anthropic"` 时设 `NUWAX_API_PROTOCOL=anthropic` 且**不设** `CODEX_WIRE_API`(适配器 anthropic 协议禁带 wire);否则维持 `CODEX_WIRE_API=chat` |

## 证明成立的测试

- 新增/回归:unifiedAgent force-engine 相关既有测试(如有)保持绿;构建 + 引擎域相关 vitest。
- 手工(dev):开关开 → 发起会话,日志出现 `forcing engine to "nuwax-harness-acp-ts"` + `[AcpClient] codex: using TS adapter`,请求模型配置注入生效。

## 风险与回退

| 风险 | 缓解 | 回退 |
|---|---|---|
| 存量会话跨引擎恢复无语义保障 | dev 工具定位,开关描述注明"对新会话生效" | 关开关即回原引擎 |
| anthropic 协议误判 | 仅当请求 api_protocol 显式为 anthropic 才走新分支,其余默认不变 | revert |

## 偏离记录

(无)
