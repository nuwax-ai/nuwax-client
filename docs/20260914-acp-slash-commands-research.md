# ACP Slash Command 统一能力调研——让 /compact 等命令在 nuwax（PC Web）与 nuwax-mobile 会话框可用

- 记录日期：2026-09-14
- 目标口径：用户在 **nuwax PC web**（含桌面客户端 webview，二者同源）、**nuwax-mobile**（uni-app x）的会话输入框中，用 `/` 前缀命令触发**跨引擎统一能力**。首批范围（2026-09-14 调整）：`/compact` `/status` `/usage` + 宿主内置命令 **`/goal`**（会话目标，新概念）+ **自定义 slash command**（平台级用户命令库，另含引擎原生自定义命令透出）。`/stop` `/clear` `/model` 明确移出首批（见 §1.1 范围外）。**另含姊妹轨道：ACP plan 模式（§八）——一并调研但相对独立（协议面/UX/排期互不前置）**。
- 调研方式：三仓源码实读（本仓壳基座 `nuwa-electron-shell` + 前端独立检出 `~/workspace/nuwax`@feat-dong.0930 + 移动端 `~/workspace/nuwax-mobile`）+ ACP 官方协议文档 / RFD / 上游 issue 网络调研（2026-09-14 快照）。
- 关联：壳仓 `nuwa-electron-shell/docs/ACP-ENGINES-RESEARCH.md`（ACP 多引擎调研，本文是其「命令 / 会话控制能力」维度的后续）；`20260913-webview-loading-differences.md`（webview 加载链路，本文消息链路的姊妹篇）。
- 本文是**调研文档**：只盘点事实、对比方案、给推荐与分期路线，不含任何已实施改动。

## 〇、结论速览

1. **协议层已就绪**：slash commands 于 2025-09 进入 ACP v1 稳定 spec（PR #88）。发现 = agent 通过 `session/update` 推送 `available_commands_update`（无 capability 门控、可随时重发、REPLACE 语义）；调用 = **无专用 RPC**，命令作为普通文本走 `session/prompt` 透传，由 agent 识别前缀自行处理。
2. **我们链路里能力已在源头存在，断在中间四处**：vendored claude 适配器（fork 0.65.0）**已经在发** `available_commands_update`（会话建立时查 `supportedCommands()` 全量推送 + `commands_changed` 时全量替换推送）；但壳侧 `acpUpdateMapper` 只映射 6 种 update、该事件落 "Unhandled" 被丢弃 → 云端无对应 SSE 事件 → 双前端零消费。
3. **透传路线天然半通**：用户文本从三端输入框到 ACP `session/prompt` 基本逐字透传（`acpEngine.ts:1423`），今天在输入框敲 `/compact` 理论上就能到达 claude 引擎并被 SDK 内部执行——缺的只是「发现 + 菜单 UI + 结果反馈」三块。
4. **推荐方案 C（分层混合）**：三端一致的**统一命令注册表**（UX 契约，宿主持有）+ 按命令做**能力路由**（宿主侧原生实现 / ACP 透传 / fork 增强，三档）。不做纯 B（云端拦截摘要重建会话）——非标、丢 agent 内部状态、编排复杂。引擎间能力差异（各 engine 经 ACP 支持的命令/能力不同）的治理方案见 §5.7：能力画像 + 三档降级，**统一能力下限由宿主保证、上限由引擎增强**。
5. **三端一份契约**：PC web、客户端 webview、mobile 三端打的是**同一套云端端点**（`/api/agent/conversation/chat` 等），云-端契约改一份即可三端受益。
6. **自定义命令两层皆有现成抓手**：引擎原生层——claude 自定义命令（`.claude/commands/*.md`）与 skills 连参数提示（`argumentHint`→`input.hint`）已随 `available_commands_update` 透出，零改动可用；平台层——云端用户命令库 + 发送前模板展开，跨引擎通用（展开位置建议云端，§5.6-2）。
7. **/compact 反馈可见化 = 差异化机会**：上游 claude-agent-acp 公认缺口（压缩摘要被丢弃 #873、无边界信号 #656）；我们持有 vendored fork，可自行补结构化上报，形状直接对齐协议 Session Compaction RFD（Draft）草案——协议定型前抢先落地，定型后平移。
8. 观望轨道：Session Compaction RFD（`compaction_update` / `compaction_summary_chunk`）2026-08 进 Draft，尚未进协议；跟进但不阻塞我们落地。
9. **姊妹轨道：ACP plan 模式（§八）控制面是已落地的存量、数据面与 slash command 同病**——壳侧双层 mode 模型（业务 agent_mode × 引擎 session mode）、agent-kit 双通道发现、set_mode 下发、ExitPlanMode 走审批卡，这些都在；但 plan 内容呈现的数据面断链（fork 在发 `plan` 内容块，壳 mapper/引擎/路由全链无处理，三端都收不到；前端已有渲染组件但数据源是云端编排事件），外加 mobile 零支持。与 slash command 共享治理框架与 mapper 扩展点，但协议面（实验性 vs 已稳定）、UX、排期**相对独立、互不前置**。

## 一、目标与范围

### 1.1 首批统一命令集（2026-09-14 调整：移出 /stop /clear /model，纳入 /goal 与自定义命令）

| 命令 | 语义 | 归属初判（详见 §5.2 路由） |
|---|---|---|
| `/compact` | 会话压缩：摘要历史释放上下文 | 透传（claude/codex 原生）+ fork 增强反馈；nuwaxcode 视支持情况宿主兜底 |
| `/status` | 查询 agent / 会话状态 | 透传（claude/codex 有）+ fork 补输出可见化（上游 #642：内置命令无输出） |
| `/usage` | 查询 token 用量 | 同上；壳侧 `usage_update` 已在映射，可宿主聚合回答 |
| `/goal` | 设定 / 查看会话目标（**新概念**，三仓无既有实现，语义待产品拍板见 §5.6） | **宿主侧原生**：快版 = 平台内置模板命令（发送前展开为结构化指令）；完整版 = 会话级持久 goal，复用 `acpChatMemory` 注入通道逐轮带上 |
| 自定义 slash command | 用户自定义命令：名称 + 描述 + 提示词模板 + 参数占位（如 `/review 关注并发` → 展开为完整提示词） | **平台级（跨引擎）**：云端用户命令库 + 发送前模板展开，对任意引擎生效；引擎原生自定义命令（claude `.claude/commands/*.md`、skills）经 `available_commands_update` 自然透出，透传即用、连参数提示都现成（§2.3） |

调整说明：`/stop` `/clear` `/model` 移出首批——前两者语义与云端会话编排强耦合（stop 的对象是云端 requestId 任务而非 agent prompt；clear 涉及云端会话语义裁决），`/model` 切换链路重。三者的路由结论留档在 §5.2 尾行供后续批次取用；host-native 档位改由 `/goal` 与自定义命令接棒验证。

范围外（本调研只记录、不排期）：`/stop` `/clear` `/model`（后续批次）、命令面板全局化。

### 1.2 明确的成功标准

- 三端输入框敲 `/` 均能唤起命令菜单，展示**同一份**统一命令集（+ 平台自定义命令 + 当前引擎广播的原生命令）。
- 同一命令名在三端、三引擎下语义一致（能力差异允许降级提示，不允许语义漂移）。
- `/compact` 执行后用户能看到**发生了什么**（进度 + 摘要卡片），而非静默无反馈（上游反面教材见 §3.2）。
- 用户能自定义一条命令（如 `/review`），三端可用、对任意引擎生效（模板展开为普通提示词）。

## 二、现状盘点：三端消息链路与断点

### 2.1 三端同链路（一份契约改三端）

```
nuwax PC web ─┐                       (浏览器形态: 无本地壳, 会话由云端沙箱承载*)
nuwax webview ─┼─→ 云端 Java 后端 /api/agent/conversation/chat (POST SSE)
nuwax-mobile ──┘         │ resume: GET /chat/sub/{id}; stop: POST /chat/stop/{requestId};
                         │ permission: POST /chat/permission-request/response
                         ▼
              lanproxy 隧道 → 本地 computerServer(:61006, 社区 60006) /computer/chat
                         ▼
              UnifiedAgentService.ensureEngineForRequest → AcpEngine.chat (逐轮串行)
                         ▼
              ACP 子进程 (NDJSON/stdio, @agentclientprotocol/sdk 0.26)
              ├─ claude-code-acp-ts (vendored fork 0.65.0, 包 Claude Agent SDK)
              ├─ nuwaxcode acp (Go 二进制, resources/nuwaxcode)
              └─ nuwax-codex-acp-ts 1.2.8 (包 Rust codex-acp)
```

- 端点同源证据：PC `nuwax/src/constants/common.constants.ts:19`、transport `src/features/conversation/runtime/conversationTransport.ts`；mobile `constants/common.constants.uts:8`（同 path）、恢复 `subpackages/.../AgentDetailService.uts:3368`、权限回传 `subpackages/servers/intervention.uts:54`。
- 引擎与端口：`crates/agent-electron-client/src/shared/constants.ts:130-137`（`AgentEngineType = "nuwaxcode" | "claude-code" | "codex-cli"`，默认 claude-code）、`:80-104`（端口表，商业 offset+1000 → computerServer 61006）；webview 回环网关 46800（`loopbackGateway/gateway.ts:18`，`/api` 反代业务域）。
- \* 纯浏览器（无本地壳）形态下会话由云端沙箱承载（`/api/computer/pod/ensure` 等，见前端 `services/vncDesktop.ts`），其 agent 执行体是否同构 agent-electron-client **本次未核实**，列入 §7 待确认。

### 2.2 断点清单（命令能力四处断链，均有代码证据）

| # | 断点 | 证据 |
|---|---|---|
| 1 | **agent 侧已在发**，壳侧不收：mapper 只映射 `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `session_info_update` / `usage_update` 六种，`available_commands_update` 落 default 分支仅打日志 "Unhandled ACP update" 后丢弃 | `crates/agent-electron-client/src/main/services/engines/acp/acpUpdateMapper.ts:31-129` |
| 2 | 发送侧两处齐全：会话级 `sendAvailableCommandsUpdate()`（查 `session.query.supportedCommands()` 全量推送）+ SDK `commands_changed` 控制消息（全量 REPLACE，注释明确 "client should REPLACE its cached command list"） | vendored `sources/claude-code-acp-ts/src/acp-agent.ts:5211, 3001`（`commands_changed` case 在 2990 前后） |
| 3 | 壳的 IPC 扩展点是**过时桩**：`agent:listCommands` 恒返回空数组，注释 "ACP doesn't support this, return empty for compatibility"（2025-09 后协议已支持，注释失实）；`agent:command` preload 有暴露但**无注册 handler**（死 API） | `src/main/ipc/agentHandlers.ts:443-450`、`src/preload/index.ts:128-129` |
| 4 | 云→前端 SSE 词汇表固定 6 种 eventType（`HEART_BEAT/PROCESSING/MESSAGE/FINAL_RESULT/ERROR/ACP_REQUEST_PERMISSION`），无命令发现通道；双前端（PC + mobile）**零 slash 命令 UI**，PC 的 `/` 已被 CapabilityModal 占用 | `nuwax/src/types/enums/agent.ts:128-134`；`nuwax/src/components/ChatInputHome/MentionEditor/index.tsx:657-675`（`detectMention(text,'/')` → CapabilityModal） |

### 2.3 既有可复用资产（不需要从零造）

- **文本透传已天然成立**：`acpEngine.prompt()` 把 text part 逐字推进 `session/prompt`（`acpEngine.ts:1423-1424, 1510`，仅附 `_meta`），无任何包装/改写 → 透传路线的「执行」环节零改动。
- **ACP 形状事件穿透云端有先例**：`ACP_REQUEST_PERMISSION` 从 agent 的 `session/request_permission` 一路映射到前端 SSE 事件并配套审批 UI（`applyAcpPermissionSseEvent.ts:43-131` 同时容忍 camelCase/snake_case）→ 证明「新增一种 ACP 衍生 SSE 事件」的云端通道是走得通的，命令发现可复用同一模式。
- **stop 链路现成**：PC `services/agentConfig.ts:315`（`chat/stop/{requestId}`）、mobile `servers/conversation.uts:30`、壳侧 `/computer/agent/stop` 路由（首批 `/stop` 已移出，留作后续批次的现成储备）。
- **会话恢复链路现成**：ACP `session/load`（`acpSessionSetup.ts`，`SessionRestoredVia = memory|resume|load|new`）→ `/clear`（新会话）与压缩后重建都有挂点。
- **模型同步链路现成**：`acpSessionModelSync.ts` 存在 → `/model` 二期有现成接入点。
- **ACP 控制类方法先例**：`session/set_mode`（ask/yolo/plan，`src/shared/types/acpMode.ts`）是链路里唯一已用的「prompt 之外」控制方法，说明非 update 类方法壳侧也能加。
- **平台侧已有 compact 概念**：前端 `constants/hook.constants.ts:18-31` 定义了服务端 agent 编排的 `PreCompact`/`PostCompact` hook 事件与 `SessionStart` matcher 值 `compact` —— 云端 agent 平台对 compact 并不陌生，沟通成本低。
- **引擎原生自定义命令已带参数提示透出**：vendored 适配器 `getAvailableSlashCommands()` 把 Claude SDK `SlashCommand[]`（含 `.claude/commands/*.md` 自定义命令与 skills）映射为 ACP `AvailableCommand[]`，`argumentHint` → `AvailableCommandInput.hint`（字符串或数组均处理，`sources/claude-code-acp-ts/src/acp-agent.ts:7073-7091`）→ 引擎原生自定义命令**零改动可用**，菜单参数提示有现成数据源。
- **上下文注入通道现成**：`acpChatMemory.ts`（长期记忆注入 chat 链路）→ `/goal` 完整版的「会话级持久目标逐轮注入」可复用同一通道（把 per-user 记忆换成 per-conversation goal）。
- **命令菜单 UI 基础设施**：MentionEditor 已有 `/` 触发检测与弹层机制（当前指向 CapabilityModal），改造为命令菜单有现成交互骨架。

### 2.4 会话历史在哪（决定谁能做压缩）

- agent 进程内（真身）：壳只存内存 `SdkSession`（`engines/types.ts:47-53`，`agentHandlers.ts:199-217` 明言 "ACP doesn't store messages"），跨进程恢复靠 ACP `session/load` 重放。
- **云端 Java 存了全量消息**：`GET /api/agent/conversation/{id}` + `POST /api/agent/conversation/message/list`（`services/agentConfig.ts:292,306`）→ 云端拦截方案（B）的数据源在云侧，但该历史**不含 agent 内部状态**（工具缓存、skills、隐上下文），这是 B 方案的天花板。

## 三、ACP 协议现状（2026-09-14 快照）

> 生态注意：项目已从 `zed-industries/agent-client-protocol` 迁至 **`agentclientprotocol`** org（旧 URL 浏览重定向正常，GitHub 搜索失效）；Claude 适配器已更名 `claude-code-acp` → **`agentclientprotocol/claude-agent-acp`**。我们的 vendored fork（`claude-code-acp-ts` 0.65.0）是更名前血统。协议分 v1（稳定）/ v2（进行中）双版本。

### 3.1 Slash commands 已进稳定 spec（2025-09）

- 规范页：v1 `https://agentclientprotocol.com/protocol/v1/slash-commands`、v2 同路径 `/protocol/v2/slash-commands`。
- **发现（推送制，无门控）**：agent MAY 在 `session/new` 后（实现上 load/resume 后同样）发 `session/update` 通知，`update.sessionUpdate = "available_commands_update"`，`update.availableCommands: AvailableCommand[]`（必填 `name`、`description`；可选 `input`（`AvailableCommandInput`，含必填 `hint`））。**可随时重发，语义为整体 REPLACE**；无 initialize capability 协商——客户端只需防御性处理通知。
- **调用（无专用 RPC）**：客户端把命令作为普通文本放进 `session/prompt`（如 content block text `"/compact"`），agent 识别前缀自行处理；允许与其它内容块混排。
- 演进史：issue #77（2025-09-09 提出，动机即 Gemini `/corgi` 类命令与 Claude `/model`）→ PR #54（2025-09-01 experimental）→ PR #88（2025-09-13 稳定）。
- SDK 层：壳用 `@agentclientprotocol/sdk` ^0.26.0（agent-kit peerDeps 兼容 ^0.26.0 || ^1.2.1），0.26 晚于稳定化，类型应已含该变体（M1 实施时核对，缺则按宽类型处理）。

### 3.2 `/compact` 的事实标准 = agent 内部执行，且反馈是公认缺口

生态共识做法（claude-agent-acp / codex-acp / crush-acp / Gemini 拦截式）全部是：宿主把 `/compact` 当普通 prompt 透传，**压缩在 agent 内部发生**。代价是过程对宿主不可见：

| 上游 issue | 问题 |
|---|---|
| claude-agent-acp [#873](https://github.com/agentclientprotocol/claude-agent-acp/issues/873) | 压缩摘要（SDK `compaction`/`compaction_delta` 内容块）被适配器**主动丢弃**，只透出一句 "Compacting completed." |
| [#656](https://github.com/agentclientprotocol/claude-agent-acp/issues/656) | 无结构化 `clear_boundary` 信号，宿主无法在 UI 上标记压缩边界 |
| [#1030](https://github.com/agentclientprotocol/claude-agent-acp/issues/1030) | `compact_boundary` 等 system 消息在 resume 重放中被丢 |
| [#1024](https://github.com/agentclientprotocol/claude-agent-acp/issues/1024) | 超限 resume 后 `/compact` **静默 no-op** |
| [#642](https://github.com/agentclientprotocol/claude-agent-acp/issues/642) | 内置 `/usage` `/status` `/model` 等查询命令**无输出**（对我们首批命令集直接相关） |
| [#342](https://github.com/agentclientprotocol/claude-agent-acp/issues/342) / [#26](https://github.com/agentclientprotocol/claude-agent-acp/issues/26) | 早期无完成消息 / "Prompt is too long" 无解（已关闭） |

对我们的含义：透传路线的执行端可靠，**反馈端必须靠自持 fork 补**（§5.5）。

### 3.3 Session Compaction RFD（Draft，观望轨道）

- 草案：`https://agentclientprotocol.com/rfds/session-compaction.md`（2026-07-22 初稿，2026-08-05 进 Draft，见 rfds/updates.md）。**未进协议。**
- 形状：新增两个 `SessionUpdate` 变体 `compaction_update`（生命周期：`in_progress|completed|failed|cancelled`）+ `compaction_summary_chunk`（可选的用户可读摘要投影，流式追加、完成时整体替换）；压缩仍由 agent 执行；v1 需新 `clientCapabilities.session.compaction` 门控，v2 无。
- 草案**不涉及 slash 调用方式**——`/compact` 的触发仍走透传，RFD 只解决「上报」。
- 策略：形状对齐、自持 fork 先行（用 `_` 扩展或 `_meta` 承载同形 payload），协议定型后平移到正式变体名。

### 3.4 v2 要点与扩展机制

- v2：`session/resume`（带 `replayFrom` 重放选项）取代 `session/load`；`auth/login|logout` 取代 `authenticate`；slash commands 语义与 v1 相同。
- 扩展机制（v1 `extensibility.md`）：`_` 前缀方法保留给扩展（如 `_zed.dev/...`），自定义数据放 `_meta`；未知请求返 `-32601`，未知通知 MUST 忽略 —— fork 先行实现 RFD 形状的合规通道。

### 3.5 生态对照

| 实现 | slash 命令处理 | /compact |
|---|---|---|
| Zed（宿主） | 渲染 `available_commands_update` 进自动补全（大量 issue 佐证时序/提示细节：#53161 #60199 #63796 #57461 #53225） | 宿主侧 /compact **只对自家 agent**（摘要模型 `thread_summary_model`）；对外部 ACP agent 走透传 |
| Gemini CLI（`--acp`） | PR #20528（2026-03）：`Session.prompt` 内原生拦截 `/memory` `/init` 等，不进 LLM，结果走 `agent_message_chunk` 回传；`sendAvailableCommands` 广播 | 拦截式同思路 |
| claude-agent-acp | 广播命令（含 custom slash commands / skills）；`#657` 推动 clear 后重推 | 透传 → SDK 内部压缩（§3.2 缺口） |
| codex-acp | 广播 `/compact` `/status` `/mcp` `/skills` 等 | 透传 |
| crush-acp | 广播 `/compact` `/new` `/model` `/status` 等 | 透传（"Summarize session to save context"） |
| opencode | 支持自定义命令；`/undo` `/redo` 不支持 | — |
| Copilot CLI ACP | 有命令广播 | — |

结论：**「广播 + 透传」是全生态唯一跨 agent 的统一机制**；宿主侧自建命令（Zed 式）只服务宿主自有 agent。我们要的「统一能力」= 宿主注册表 + 透传执行的组合，方向与生态一致。

## 四、方案对比

### 4.1 方案 A：纯透传（ACP 标准，agent 侧执行）

三端菜单完全由 `available_commands_update` 驱动，`/compact` 等原样透传。

- 优点：改动最小（补发现链路即可）；与协议/生态完全同构，上游演进零成本；agent 命令集（含 skills）自然透出。
- 缺点：命令集随引擎漂移（nuwaxcode 广播什么就是什么，三端 UX 不一致）；压缩反馈不可见（§3.2 缺口原样继承）；`/stop` `/clear` 这类**宿主语义**命令 agent 侧并无对应物或语义不合（stop 的对象是云端 requestId 编排的任务，不是 agent prompt）。

### 4.2 方案 B：宿主/云端统一拦截（云端摘要 + 重建会话）

输入框拦截 `/compact`，不送 prompt；云端取 message list 做摘要，然后新开 ACP 会话（或 `session/load`）注入摘要。

- 优点：真正引擎无关（含 nuwaxcode 不支持命令的场景）；摘要质量与展示完全可控（数据源 = 云端全量消息，§2.4）。
- 缺点：非标（生态无先例，Zed 也只对自有 agent 这么做）；**丢失 agent 内部状态**（工具结果缓存、skills 上下文、隐状态），压缩后行为退化；破坏 prompt 缓存（Zed #59528 的教训）；云端-本地编排复杂（摘要发生在云、会话重建发生在端）；每个命令都要云端实现一遍，成本高。

### 4.3 方案 C：分层混合（**推荐**）

三层分离：

1. **UX 契约层（宿主持有）**：统一命令注册表定义首批六命令的名称/描述/参数/三端展示，**不关心谁执行**。注册表内置命令集三端硬一致，这是「统一能力」的落点。
2. **能力路由层**：按「命令 × 引擎」路由到三档——
   - **host-native**（`/stop` `/clear`，可选兜底 `/status` `/usage`）：宿主/云端直接执行，映射既有链路，全引擎一致；
   - **passthrough**（`/compact` `/status` `/usage` 于 claude/codex）：`available_commands_update` 里有就透传，agent 内部执行；
   - **fork-enhanced**（`/compact` 反馈、`/status` `/usage` 输出）：自持 claude fork 补结构化上报与命令输出（上游 #873/#642 的修法），形状对齐 Compaction RFD。
3. **发现层**：agent 广播命令与内置注册表**合并去重**（同名内置优先、agent 版本折叠进详情），一起进三端菜单。

- 优点：统一 UX 与标准协议各取所长；nuwaxcode 不支持时优雅降级（宿主兜底或隐藏）；fork 补齐反馈是相对上游的**差异化**；分期清晰（M1-M4 见 §六）。
- 缺点：注册表 + 路由是一层新抽象，壳/云/三端都要认同一份契约（一次性设计成本）；fork 增强部分要承担与上游同步的维护差量。

### 4.4 对比总表

| 维度 | A 纯透传 | B 云端拦截 | **C 分层混合** |
|---|---|---|---|
| 三端 UX 一致性 | ✗ 随引擎漂移 | ✓ | ✓（注册表保证） |
| 协议/生态符合度 | ✓ 完全同构 | ✗ 无先例 | ✓（透传为主 + `_` 扩展） |
| 压缩反馈可见 | ✗（上游缺口） | ✓（但摘要自造） | ✓（fork 补，对齐 RFD） |
| agent 内部状态保留 | ✓ | ✗ 丢失 | ✓（压缩仍 agent 侧） |
| 改动量 | 最小 | 最大 | 中（分四期摊薄） |
| nuwaxcode 覆盖 | 取决于二进制 | ✓ | 兜底/降级 |

## 五、推荐设计要点（落地时的关键裁决）

### 5.1 统一命令注册表

- 位置建议：壳侧 `agent-kit`（"Shared agent/ACP logic for nuwa-cli and nuwaclaw"，peerDeps 已兼容双版本 SDK）——放这里 **nuwa-cli 顺带共享同一套命令定义**，与「统一能力」的定位最贴；云端需要的是命令元数据的镜像（JSON 契约同步，或云端只做转发不持有定义）。
- 结构建议：`{ name, description, args?, scope: session|global, handler: host-native | passthrough | fallback, source: builtin | platform-custom | agent-advertised }` + 三端 i18n key。**命令名是跨端契约，改名即破坏性变更**，需在注册表处立规。平台自定义命令（source=platform-custom）实体存云端用户命令库，注册表持有其镜像；同名冲突优先级见 §5.6-3。

### 5.2 能力路由决策表（首批，2026-09-14 调整后）

| 命令 | claude-code | codex-cli | nuwaxcode | 路由结论 |
|---|---|---|---|---|
| `/compact` | 透传 + fork 反馈 | 透传（待核 1.2.8 广播情况） | 待确认 | 透传优先；nuwaxcode 无则隐藏或宿主提示不支持 |
| `/status` `/usage` | 透传 + fork 输出 | 透传 | 待确认 | 透传优先，宿主兜底（`usage_update` 已聚合在壳） |
| `/goal` | 宿主 | 宿主 | 宿主 | **host-native**：与引擎无关；快版模板展开、完整版走 `acpChatMemory` 注入通道（§5.6-1） |
| 自定义命令 | 平台展开 + 原生透传双轨 | 平台展开 | 平台展开 | **host-native（云端/前端展开）**：平台命令库全引擎生效；claude 原生自定义命令（含 skills、参数提示）经广播透传，双轨并存 |
| `/stop` `/clear` `/model` | 后续批次 | 后续批次 | 后续批次 | 留档结论：stop=宿主映射 stop 链路；clear=宿主新会话（语义待裁决）；model=查询先行、切换接 `acpSessionModelSync` |

### 5.3 发现链路（命令列表怎么到三端）

- 壳侧（M1）：mapper 增 `available_commands_update` case → **按 (engine, project, sessionId) 缓存最新全量**（REPLACE 语义）→ 激活 `agent:listCommands`（顺手修正过时注释）返回「内置注册表 ∪ agent 广播」合并结果。
- 云端（M2，二选一或并行）：
  - **推荐：REST 查询端点**（如 `GET /api/agent/conversation/commands?conversationId=`）——云端向 computer 转发或读其缓存，并**合并云端用户自定义命令库**后返回三源合一（内置 ∪ agent 广播 ∪ 平台自定义）；三端在会话加载时拉取一次 + 订阅变更。无状态、好缓存、mobile 弱网友好；
  - 备选：新增 SSE eventType（`ACP_AVAILABLE_COMMANDS`，仿 `ACP_REQUEST_PERMISSION` 先例）——实时性好（skills 动态发现场景），但三端都要改事件 reducer，且纯浏览器形态依赖会话在跑才能收到。
  - 建议首期 REST（覆盖 90% 场景：会话开始前菜单就要有），SSE 事件作为 M4 附近的增强。
- **纯浏览器形态**：命令发现只能来自云端缓存（上次会话快照）+ 内置注册表——注册表保证六命令恒可用，agent 原生命令允许滞后，可接受。

### 5.4 前端 `/` 冲突裁决（PC web + webview）

- 现状：`MentionEditor` 的 `detectMention(text,'/')` 把 `/` 全量导向 CapabilityModal（能力选择器），且 `useSlashPlugins` 已消费「选中后附加组件」语义——**不能直接抢占**。
- 建议规则：输入为「`/` 起始 + 命令名前缀匹配中」→ 唤起**命令菜单**（内置 + agent 命令合并列表）；无命中（如 `/xxx` 非命令）或光标不在首词 → 回落 CapabilityModal 现行为。两个菜单互斥弹出，命令菜单项选中即替换首词为规范命令 token。
- mobile（uni-app x）：同规则在 `chat-conversation-component` 输入层实现，SSE/端点契约同 PC。

### 5.5 `/compact` 反馈可见化（fork 差异化）

- vendored fork 补两件事：① 压缩生命周期与摘要不再丢弃（#873 修法：把 SDK `compaction`/`compaction_delta` 内容块翻成 `session/update` 通知，形状对齐 RFD 草案：`compaction_update` + `compaction_summary_chunk`，正式名未定型前可用 `_nuwax.dev/compaction/*` 扩展方法或 update `_meta` 承载）；② 压缩边界事件（#656 修法）供前端在消息流里渲染分隔卡片。
- 壳侧 mapper 增对应 case → 云端复用 MESSAGE 类事件或新 subType → 前端渲染「已压缩 · 摘要」卡片。
- 协议定型后：fork 改正式变体名即可，壳/云/前端形状不变（这是对齐 RFD 的回报）。

### 5.6 语义裁决项（实施前需产品拍板，调研先立牌）

1. **`/goal` 语义与实现档位**（三仓无既有概念，全新定义）：
   - 快版 = 平台内置模板命令：`/goal 修复登录超时` 发送前展开为结构化指令文本（如「本会话目标：…，后续回复需围绕该目标」），单轮生效、零后端改动；
   - 完整版 = 会话级持久 goal：落云端会话元数据，逐轮经 `acpChatMemory` 同款注入通道带上；`/goal` 无参 = 查看当前目标，支持更新与清除；
   - 建议 M3 先落快版（验证交互与菜单），完整版随 M4 附近升级；注入通道选 memory 通道还是 prompt 前缀需实现前定。
2. **自定义命令的展开位置**：前端展开（发送前替换为模板文本——云端零改动，但模板暴露在载荷、命令使用不落审计）vs **云端展开（推荐**：云端收命令 token + 参数，按用户命令库展开后再下发 computer——审计、迁移、团队共享、三端一致性都更优，代价是云端持有命令库与展开逻辑）。
3. **命名冲突裁决**：内置 / 平台自定义 / agent 原生三源同名（如用户自定义 `/compact`）——需定优先级（建议：内置 > 平台自定义 > agent 原生，覆盖时菜单标注来源），否则三端合并列表会出现静默覆盖。
4. **自定义命令作用域与安全**：个人 / 项目 / 团队共享三档；共享模板本质是**可分发的提示词**，存在提示注入面，团队档需要权限与审核约束（§7-8）。
5. **命令执行形态**：命令是否作为一条「命令消息」进消息流（建议进流：可审计、断线重放语义清楚、移动端弱网友好）。

### 5.7 引擎能力差异的治理（不同 engine 经 ACP 支持的东西不一样，怎么办）

**问题定性**：三个引擎在四个维度都存在差异——① initialize 静态能力（`loadSession`、`promptCapabilities`、`auth.logout`…各家不同）；② 广播的命令集（claude 连 skills 与自定义命令、codex 另一套 `/compact /status /mcp /skills`、nuwaxcode 未知）；③ update 种类与形状（典型：compaction 内容块在 claude 适配器被丢弃）；④ SDK/协议版本节奏（壳 0.26，各引擎子进程自带各自版本）。这是**常态而非异常**——ACP 的设计哲学本来就是「能力协商 + 防御性消费」（省略的能力视为不支持、未知通知 MUST 忽略）。解法是把差异**当数据治理，不当代码分支**：

1. **能力画像（EngineCapabilityProfile）**：壳按 (engine × 项目) 持续记录三类事实——initialize 返回的 `agentCapabilities`、运行期观测到的 update 种类、最新广播命令集（REPLACE 语义天然适合做快照）——形成画像缓存。命令路由与三端菜单**全部读画像**，禁止散落 `if (engine === "claude-code")`。落点建议 agent-kit（与注册表同层），画像即 §5.3 发现链路的自然扩展；纯浏览器形态用云端缓存的画像。
2. **三档降级矩阵（命令 × 引擎 → 行为）**：每条统一命令按画像解析到三档之一——
   - **passthrough**：引擎广播了该命令 → 文本透传（claude/codex 的 `/compact`）；
   - **host-emulation**：引擎没有、但宿主可等价实现 → 宿主执行：`/status` 用壳内引擎/会话状态回答、`/usage` 用已映射的 `usage_update` 聚合回答、`/compact` 兜底可触发宿主摘要重建（方案 B 的按引擎触发版，仅对无原生压缩的引擎启用）；
   - **hidden**：无等价物 → 菜单隐藏或置灰标注「当前引擎不支持」。
   - 关键原则：**统一能力的下限由宿主保证，上限由引擎增强**——三端 UX 契约不随引擎漂移，靠的就是宿主把下限兜住。
3. **语义契约 + 可观测验证**：同名命令跨引擎的内部实现差异（各家 `/compact` 机制不同）无法根除，但可以约束**可观测结果**：关键命令定义宿主侧验收断言（如 `/compact` 后 `usage_update` 的上下文占用应显著回落、应出现边界事件），fork 能力范围内对齐输出形状（§5.5），菜单详情标注命令来源（内置 / 平台自定义 / 某引擎原生）。
4. **fork 对齐 + 定点补齐**：可控面有三层——claude fork（补 #642 查询命令输出、#873 压缩摘要）、codex fork（1.2.8 核对后同样可补）、**nuwaxcode 是自家 Go 二进制，直接实现命令广播与 `/compact` 内部处理即可对齐协议**。真正不可控的只有上游官方演进节奏（claude/codex 官方版本），由画像 + 降级矩阵吸收。
5. **契约测试**：agent-kit 加 per-engine 合同测试（initialize 能力集快照、必须广播的命令清单、update 种类快照），引擎升级 / fork bump 时 CI 显形差异，而不是线上用户显形。

## 六、分期落地路线（M1→M4，每期可独立验收）

| 期 | 内容 | 涉及 | 验收口径 |
|---|---|---|---|
| **M1 壳侧发现链路** | mapper 接住 `available_commands_update` 并按引擎/项目缓存；激活 `agent:listCommands`（返内置∪广播合并）+ 修正过时注释；核对 SDK 0.26 类型 | 仅壳仓（中立改动，走基座 PR） | dev 态 `agent:listCommands` 能列出 claude 引擎广播的命令（含 skills） |
| **M2 云端契约** | 命令查询 REST 端点（云端 → computer 转发 + 合并云端自定义命令库，三源合一）；自定义命令库 CRUD 与展开逻辑（若按 §5.6-2 选云端展开）；命令文本透传确认（应零改动，回归即可） | 云端 Java + 壳 router | 三端任意一端 curl 端点能拿到该 conversation 的三源合并命令列表（含自定义命令） |
| **M3 双前端菜单** | PC：MentionEditor 命令菜单 + 冲突裁决 + 选中替换；mobile：同契约实现；host-native 项接通：`/goal` 快版 + 一条自定义命令端到端 | nuwax + nuwax-mobile | 三端敲 `/compact` 可发送且 claude 引擎实际压缩（日志验证）；`/goal` 与自定义命令三端、跨引擎生效 |
| **M4 反馈可见化** | fork 补 compaction 上报（RFD 形状）；mapper/云端/前端串起摘要卡片与边界；可选 SSE 实时命令事件 | fork + 壳 + 云端 + 双前端 | `/compact` 后消息流出现「已压缩 + 摘要」卡片；`/status` `/usage` 有可见输出 |

依赖关系：M1→M2→M3 串行（契约逐层向上），M4 依赖 M3 可并行开发。`/stop` `/clear` `/model` 三命令连同 `/goal` 完整版，作为后续批次在 M4 后另行排期。

## 七、风险与待确认清单

1. **nuwaxcode（Go 二进制）命令支持未知**：非本仓可改；需向其团队确认是否实现 `available_commands_update` 广播与 `/compact` 内部处理。不支持的降级策略已在 §5.2 预案（隐藏/宿主提示）。
2. **codex fork（nuwax-codex-acp-ts 1.2.8）**：上游 codex-acp 广播 `/compact` `/status` 等，但 1.2.8 版本的实际广播内容未核——M1 验收时顺带核对。
3. **云端沙箱执行体同构性**：纯浏览器形态下沙箱内 agent 执行体是否同构 agent-electron-client（决定 M2 端点在沙箱形态的可达性）——未核实。
4. **上游 RFD 演进**：Compaction RFD 仍在 Draft，形状可能变——fork 扩展用 `_` 命名空间隔离，协议定型时改名的成本控制在 fork 单点。
5. **`/` 语义占用的 UX 评审**：CapabilityModal 与命令菜单的并存规则（§5.4）需产品过一遍，避免「同键两义」投诉。
6. **SDK 双版本**：agent-kit peer 允许 ^0.26.0 || ^1.2.1，注册表与 update 处理需两版本类型兼容（宽类型 + 运行时判别）。
7. **命令名即契约**：三端 + 云端 + 文档同时生效，改名成本极高，注册表立规（§5.1）；三源（内置/平台自定义/agent 原生）同名冲突的优先级不先定，合并列表会出现静默覆盖（§5.6-3）。
8. **自定义命令的注入面**：团队共享模板本质是**可分发的提示词**，存在提示注入风险；团队共享档需权限与审核约束，个人档风险可控（§5.6-4）。
9. **`/goal` 语义未定**：三仓无既有概念、全新定义，语义与注入通道（§5.6-1）拍板前，M3 的 `/goal` 验收口径无法固化——建议排期前先过产品评审。

## 八、姊妹轨道：ACP Plan 模式（与 slash command 相对独立）

**定位**：plan 模式与 slash command 同属「跨引擎统一会话控制能力」，本节一并调研，但刻意保持**相对独立**——协议面、UX、排期互不前置，不做耦合设计。它与 slash command 最大的不同是：**这不是新建能力，而是已大体落地的存量**，本节以盘点现状与缺口为主。

### 8.1 协议面（与 slash command 完全不同的一套，且稳定度不同档）

| 维度 | plan 模式 | slash command（对照） |
|---|---|---|
| 模式发现 | `session/new\|load\|resume` 响应的 `modes`（currentModeId + availableModes 描述符），或 `mode` select 配置项（两种通道，引擎各异） | `available_commands_update` 推送 |
| 切换/调用 | `session/set_mode` 请求 | 无专用 RPC，文本透传 |
| 呈现 | `session/update` 的 `plan`（content blocks）/ `plan_update`（条目状态）/ `plan_removed` | 命令输出走普通 message chunk |
| 客户端能力 | 声明 `plan: {}` 才会收到 `plan_update`/`plan_removed`（agent-kit 口径） | 无门控 |
| 协议稳定度 | **实验性/扩展面**：v1 稳定版 initialization 文档无 `clientCapabilities.plan` 亦无 `modes` 字段（2026-09-14 核实），agent-kit 注释自称 experimental | **已稳定**（2025-09 PR #88） |

Claude 系特殊形状：ExitPlanMode 工具审批复用 `session/request_permission` 通道（拒绝选项 "No, keep planning"），即 plan 退出确认天然走权限审批链路——这正是它能复用我们 AgentIntervention 基础设施的原因。

### 8.2 我们侧现状（远比 slash command 成熟）

- **壳侧 v4 双层模型**（`src/shared/types/acpMode.ts` 头注释，概念定义相当清晰）：① 业务 `agent_mode`（ask/yolo/plan）由 chat 请求 `agent_config.agent_server.agent_mode` 驱动——ask/yolo 只影响本端审批策略、**不调** `session/set_mode`；plan 额外触发引擎侧 set_mode，且本地审批策略强制折算 ask（ExitPlanMode 类确认必须人工放行）。② 引擎 ACP session mode（claude 的 default/auto/plan、nuwaxcode 的 build/plan）由 agent 在 session 结果中广告，仅业务请求为 plan 时下发 set_mode。Mode 不做本地持久化。
- **agent-kit `sessionMode.ts` 双通道发现已收敛**：通道① `modes` 字段（claude-code-acp-ts / deepagents-flow-ts / codex-acp-ts，SDK 0.26+/1.x 形状）；通道② `mode` config option（nuwaxcode / opencode 只用此方式）。`PLAN_MODE_ID = "plan"`——注释明言"各受支持引擎恰好一致的 mode id"。结构化类型、无 SDK 运行时导入，一份构建同时服务双版本宿主。**这份双通道收敛是 §5.7 能力画像的现成范本——slash 命令的引擎发现层可以仿照它的形状做。**
- **`clientCapabilities.ts` 已声明 `plan: {}`**（与 `terminal` 并列）。
- **claude fork 全链支持**：modes 描述符与 set_mode（经 config option 下发）、plan 内容块呈现（`sessionUpdate: "plan"` 多处）、ExitPlanMode → permission 请求含 "No, keep planning" 选项（`sources/claude-code-acp-ts/src/acp-agent.ts:4912-4921` 等）。
- **PC 前端：渲染组件与控制面已就绪，数据面未接**——① 业务模式选择 UI（`ModelSetting` / `CreateModel`）、ExitPlanMode 审批卡（`AgentIntervention/AcpPermissionCard`，走 permission 通道）可用；② plan 块渲染组件存在（`features/conversation/presentation-v2/renderPreferences.ts:34-66`、`ProcessNodeRow.tsx`、`utils/markdownProcess.ts:33-46`、`types/interfaces/appDev.ts:438-442`），**但其数据源是云端编排的处理事件与应用开发（AppDev）链路，不是本地 ACP 引擎的 plan update**。
- **数据面断链（与 slash command 同病）**：`acpEngine.ts` / `acpUpdateMapper.ts` / `computer/router.ts` 全链 grep `plan`/`plan_update` 零命中——fork 在发 `sessionUpdate: "plan"`（多处），壳侧无人接住，本地 ACP 链路的 plan 内容到不了任何前端。即：**控制面（agent_mode→set_mode、ExitPlanMode→审批卡）已通，数据面（plan 内容呈现）三端都未接**。
- **mobile：零支持**（全仓 grep `plan_update`/`ExitPlanMode`/`planMode` 无命中）。注意其权限回传链路（`subpackages/servers/intervention.uts`）已在，缺的是卡片区与模式选择器。

### 8.3 缺口与方案要点（独立排期，单列 P 系列）

1. **P0 壳侧数据面接通**：mapper 增 `plan` / `plan_update` / `plan_removed` 三个 case → computer/router 透出 → 云端 SSE → 前端复用**已存在的** presentation-v2 plan 渲染组件。这与 slash command 的 M1（接住 `available_commands_update`）是同一类工作、同一处扩展点，可同批实施但各自独立验收——这是两条轨道「共享基础设施、独立排期」的具体形态。
2. **P1 mobile 补齐**：plan/plan_update 渲染、ExitPlanMode 审批卡（权限回传链路已在，补卡片区）、`agent_mode` 选择器；契约与 PC 同源（SSE 事件与 permission response 已共用）。
3. **P2 三端 UX 一致性评审**：模式切换入口统一（当前 PC 藏在模型设置里，语义位置是否合适值得评审）；plan 审批交互三端对齐。
4. **引擎差异治理直接复用 §5.7**：双通道发现已由 agent-kit 收敛；`PLAN_MODE_ID` 各引擎一致是**现状事实而非协议保证**，未来新增引擎仍须走画像判别，勿写死。
5. **实验性协议面的对冲**：modes/plan 能力未进稳定文档，上游形状变动风险高于 slash commands——继续用 agent-kit 结构化类型层吸收（现做法正确），升级 SDK/协议版本时把 modes 形状纳入契约测试快照。

### 8.4 与 slash command 轨道的边界（共享什么、独立什么）

- **共享**：§5.7 能力画像与治理框架（sessionMode 双通道是现成范本）、mapper 扩展点（update 映射同一处加 case）、云→前端 SSE 契约通道（`ACP_REQUEST_PERMISSION` 先例同时服务两者）、AgentIntervention 审批组件族（ExitPlanMode 卡与未来的命令确认卡可同源）。
- **独立**：协议面（set_mode + plan updates vs available_commands_update + 透传）、UX（模式切换器 + 计划审批 vs 命令菜单）、命令注册表不收模式项、排期互不前置（M1-M4 与 P1-P2 可并行）。
- **唯一预期交汇点**：未来若引入 `/plan` `/mode` 类切换命令，届时命令路由层调 `set_mode` 即可——首批不含，两条轨道在此之前保持解耦。

## 九、附录

### 9.1 代码证据索引（相对各仓根）

**壳仓（nuwax-client/nuwa-electron-shell，crates/agent-electron-client）**
- `src/main/services/engines/acp/acpUpdateMapper.ts:31-129` —— 六种 update 映射，default "Unhandled"
- `sources/claude-code-acp-ts/src/acp-agent.ts:5211`（`sendAvailableCommandsUpdate`）、`:2990` 前后（`commands_changed` → REPLACE 全量推送）、`:7073-7091`（`getAvailableSlashCommands`：SDK `SlashCommand[]`（含自定义命令/skills）→ `AvailableCommand[]`，`argumentHint` → `input.hint`）—— 命令事件发送侧
- `src/main/ipc/agentHandlers.ts:443-450`（`agent:listCommands` 空桩 + 过时注释）、`:199-217`（"ACP doesn't store messages"）
- `src/preload/index.ts:128-129`（`agent:command` 死 API）
- `src/main/services/engines/acp/acpEngine.ts:1398-1522`（prompt 构建，text 逐字透传 + `_meta`）
- `src/main/services/engines/acp/acpSessionSetup.ts`（`session/load` 恢复）；`acpSessionModelSync.ts`（模型同步）；`acpChatMemory.ts`（长期记忆注入通道，`/goal` 完整版候选）
- `src/shared/types/acpMode.ts`（**v4 双层 mode 模型**：业务 agent_mode × 引擎 session mode，头注释即权威定义）；`crates/agent-kit/src/sessionMode.ts`（**双通道 mode 发现**：modes 字段 / mode config option，`PLAN_MODE_ID`）；`crates/agent-kit/src/clientCapabilities.ts`（声明 `terminal` + experimental `plan: {}`）；`acpEngine.ts:229-249, 2010`（agent_mode→审批策略映射，ask/yolo 不调 set_mode）
- `src/main/services/engines/acp/acpEngine.ts` / `acpUpdateMapper.ts:31-129` / `computer/router.ts` 全链无 plan/plan_update 处理（grep 零命中）——fork 发送的 plan 内容块在本地 ACP 链路被丢，§8.2「数据面断链」佐证
- `src/shared/constants.ts:80-104`（端口表）、`:130-137`（引擎枚举，默认 claude-code）
- `src/main/services/engines/types.ts:47-53`（内存态 SdkSession）
- `crates/agent-electron-client/package.json`（`@agentclientprotocol/sdk` ^0.26.0 / `@nuwax-ai/agent-kit` 0.4.0 / `@nuwax-ai/nuwax-codex-acp-ts` 1.2.8）

**前端（nuwax，feat-dong.0930）**
- `src/components/business-component/ChatInputUnified/index.tsx:546`（confirmSendMessage）
- `src/components/ChatInputHome/MentionEditor/index.tsx:657-675`（`detectMention(text,'/')` → CapabilityModal）；`src/components/ChatInputHome/useSlashPlugins.ts`（能力选择消费侧）
- `src/constants/common.constants.ts:19`（CONVERSATION_CONNECTION_URL）；`src/types/enums/agent.ts:128-134`（SSE eventType 词汇表）
- `src/features/conversation/runtime/conversationTransport.ts`（POST/恢复）；`src/components/business-component/AgentIntervention/utils/applyAcpPermissionSseEvent.ts:43-131`（ACP 事件穿透先例）
- `src/services/agentConfig.ts:292,306,315`（详情/消息列表/stop）
- `src/constants/hook.constants.ts:18-31`（PreCompact/PostCompact、SessionStart matcher 含 compact）
- `src/constants/feature.constants.ts:7`（消息队列开关）

**移动端（nuwax-mobile，uni-app x）**
- `constants/common.constants.uts:8`（同款端点）、`servers/conversation.uts:30`（stop）、`subpackages/servers/intervention.uts:54`（权限回传）、`subpackages/pages/chat-conversation-component/layers/AgentDetailService.uts:3368`（sub 恢复）、`utils/streamRequest.uts`（SSE 消费）
- 全仓无 slash 命令/命令菜单实现（grep 仅命中三方库文件）

### 9.2 上游链接（2026-09-14 可达）

- 协议：[v1 overview](https://agentclientprotocol.com/protocol/v1/overview.md) · [v1 slash-commands](https://agentclientprotocol.com/protocol/v1/slash-commands) · [v1 initialization](https://agentclientprotocol.com/protocol/v1/initialization.md) · [v1 session-setup](https://agentclientprotocol.com/protocol/v1/session-setup.md) · [v1 extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md) · [v2 overview](https://agentclientprotocol.com/protocol/v2/overview.md) · [v2 slash-commands](https://agentclientprotocol.com/protocol/v2/slash-commands) · [llms.txt 索引](https://agentclientprotocol.com/llms.txt)
- 演进：[slash issue #77](https://github.com/agentclientprotocol/agent-client-protocol/issues/77) · [PR #54 experimental](https://github.com/agentclientprotocol/agent-client-protocol/pull/54) · [PR #88 stabilize](https://github.com/agentclientprotocol/agent-client-protocol/pull/88) · [Session Compaction RFD](https://agentclientprotocol.com/rfds/session-compaction.md) · [RFD updates](https://agentclientprotocol.com/rfds/updates.md) · [v2 session-resume-replay RFD](https://agentclientprotocol.com/rfds/v2/session-resume-replay.md)
- claude-agent-acp：[#873 摘要丢弃](https://github.com/agentclientprotocol/claude-agent-acp/issues/873) · [#656 边界信号](https://github.com/agentclientprotocol/claude-agent-acp/issues/656) · [#1030](https://github.com/agentclientprotocol/claude-agent-acp/issues/1030) · [#1024 静默 no-op](https://github.com/agentclientprotocol/claude-agent-acp/issues/1024) · [#642 查询命令无输出](https://github.com/agentclientprotocol/claude-agent-acp/issues/642) · [#657 clear 后重推](https://github.com/agentclientprotocol/claude-agent-acp/issues/657)
- 同类实现：[Gemini CLI ACP](https://geminicli.com/docs/cli/acp-mode/) · [Gemini PR #20528](https://github.com/google-gemini/gemini-cli/pull/20528) · [Zed external agents](https://zed.dev/docs/ai/external-agents) · [Zed #59528 缓存不友好](https://github.com/zed-industries/zed/issues/59528) · [Zed #62342 摘要模型](https://github.com/zed-industries/zed/issues/62342) · [codex-acp](https://github.com/agentclientprotocol/codex-acp) · [opencode ACP](https://opencode.ai/docs/acp/) · [agents 目录](https://agentclientprotocol.com/get-started/agents.md)
