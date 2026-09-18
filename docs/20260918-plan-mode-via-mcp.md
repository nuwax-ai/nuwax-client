# 计划模式（PLAN）MCP 外挂式实现契约 — 零后端改动

> 2026-09-18 定稿。范围：nuwax PC web + Nuwax 客户端（mobile 二期）。
> 核心决策：plan 不走 ACP `session/set_mode`/plan updates 协议路线（四引擎四形态 + v2 unstable + set_mode 标记将移除），
> 不依赖 MCP elicitation（客户端支持参差），**不修改 agent-platform 任何代码**。
> 形态：壳内自持 plan MCP server + 复用既有 `plan` / `acpRequestPermission` SSE 词汇 + 复用审批应答端点。

## 1. 零后端依据（agent-platform 只读查证）

| 环节 | 事实 | 证据 |
|---|---|---|
| 激活信号 | `agentMode` 为无校验 String 全链透传（TryReqDto → AgentContext → AgentRequest.agent_mode） | `TryReqDto.java:55`、`SandboxAgentClient.java:1055/1076/1110/1141` |
| 前端新字段 | Jackson 默认 `FAIL_ON_UNKNOWN_PROPERTIES=false`，未知字段静默丢弃 → 只能复用 agentMode | bootstrap application.yml 无 jackson 覆盖 |
| plan 进度通道 | 云端对壳侧 `subType=plan` 事件映射 `ComponentTypeEnum.Plan`，`data.entries` 原样透传 | `SandboxAgentClient.java` onEvent plan 分支 + `buildComponentExecutingPlan` |
| 审批事件通道 | `acpRequestPermission`/`request_permission` 的 data **整体透传**为 REQUEST_PERMISSION 事件 `result.input` | 同上 acpRequestPermission 分支 + `buildExecutingEvent` |
| 审批应答 | `POST /api/agent/conversation/chat/permission-request/response` 按 conversation→sandboxSession 通用路由回壳 `/computer/notify-resolved`，不绑工具语义；**载荷仅 optionId + outcome="selected"** | `ConversationController.notifyResolved:277-292`、`SandboxAgentClient.notifyResolved:1858-1921` |
| system prompt | agent system_prompt / 租户 globalSystemPrompt 纯配置可追加计划契约段 | `SandboxAgentClient.executeTask:509` |

**约束**：修订文本不能随 resolve 回传（仅 optionId）；云端 `buildComponentExecutingPlan` 每事件随机 executeId（无 upsert 键）→ plan 进度事件频率须克制（首期 create/submit 各一次）。

## 2. 外挂语义

- `agentMode="plan"` 仅作传输编码。壳内不建模式状态机：ask/yolo 审批决策链（①question ②strict ③rules ④mode）原序不动。
- plan 的壳侧状态 = 权限协调器里新增**前置早退闸**（plan 轮写类工具拒绝）+ **plan 工具自动放行**（免审批），均为独立分支。
- 移除该能力 = 前端停发 `"plan"` + 壳摘除 planMode 模块。社区版完全休眠（社区云不发 plan、工具不激活）。

## 3. 链路总览

```
前端「计划」开关(本地态；ask/yolo 阶梯停靠本地) 
  → chat 请求 agentMode:"plan"（云端透传）
  → 壳 acpEngine.chat：resolveEffectiveMode("plan") → mode="plan"（现有折算 ask 审批）
  → syncSessionModeForChat 存 "plan" + planModeService.beginPlanTurn(session)（重置已批准标记）
  → 引擎经会话注入的 loopback plan MCP server 调工具：
      nuwax_plan_create {entries}            → 状态机建计划 →（观测器）发 subType=plan SSE
      nuwax_plan_update {planId, entries}    → 状态机更新 →（观测器）发 subType=plan SSE
      nuwax_plan_submit {planId}             → 工具挂起 →（观测器）注册审批 pending + 发 acpRequestPermission SSE
  → 云端映射 → 前端：
      subType=plan  → ComponentTypeEnum.Plan PROCESSING（计划卡，三端已有渲染）
      request_permission → REQUEST_PERMISSION Event（审批卡，data 含 kind="plan_approval"/entries/options）
  → 用户点「批准」/「需要修改」→ POST /chat/permission-request/response {optionId}
  → 云端通用路由 → 壳 /computer/notify-resolved {session_id, tool_call_id, request_permission_response}
  → approvalInterventionService 按 (acpSessionId, toolCallId) 唤醒 pending
  → planModeService：批准 → 计划状态 approved → submit 工具返回 {approved:true} → 同轮继续执行
    （硬闸见 §5：批准前写类工具一律拒绝；批准后放行，按 ask 阶梯逐笔审批——现有 plan→ask 折算即安全档）
  → 「需要修改」→ submit 返回 {approved:false} → 引擎收尾 → 用户下一条消息即修订意见（ask-question resume 同款）
```

## 4. MCP 工具契约（壳内 plan server，server 名 `plan`）

端点：`http://127.0.0.1:{DEFAULT_PLAN_MCP_PORT}/mcp`（Streamable HTTP，**stateless**：sessionIdGenerator=undefined，状态全在壳内 planStore，按 planId 键控）。端口 `60010 + NUWAX_PORT_OFFSET`（商业 61010），常量 `DEFAULT_PLAN_MCP_PORT`、`PLAN_MCP_SERVER_ID="plan"`。

| 工具 | 输入 | 输出（structuredContent） | 语义 |
|---|---|---|---|
| `nuwax_plan_create` | `{ entries: [{content: string, priority?: "high"\|"medium"\|"low"}] }` | `{ planId, revision }` | 新建计划（status=draft）。工具描述写明计划契约：计划获批准前不得执行写操作 |
| `nuwax_plan_update` | `{ planId, entries, changelog?: string }` | `{ planId, revision }` | 全量替换条目，revision+1 |
| `nuwax_plan_submit` | `{ planId, summary?: string }` | `{ approved: boolean, feedback?: string }` | 提交批准；**挂起**直至审批应答（批准/需要修改/取消） |

- 条目 `status`（pending/in_progress/completed）由引擎侧重发 update 维护（模型语义），壳不推断。
- 工具命名带 `nuwax_plan_` 前缀：云端 SSE 的 title 特判（ask_question/openui）不会误命中；壳内观测器/自动放行按 `title 含 nuwax_plan_` 匹配，兼容各引擎前缀（`mcp__plan__nuwax_plan_submit` 等）。

## 5. 壳侧硬闸与自动放行（permissionCoordinator 前置分支）

```
① question 拒绝（现有）
⓪a plan 工具自动放行：title 含 "nuwax_plan_" → select allow_once/allow_always（宿主自有工具无副作用，
    免去 plan 轮内引擎侧权限弹窗——云端对 ask-question 是用 tool_approval_rules 干同样的事，我们在壳内做）
⓪b 计划硬闸：getEffectiveMode(session)==="plan" && 写类请求(evaluateStrictWritePermission().isWriteRequest)
    && !planModeService.hasApprovedPlan(session) → cancel，reason="plan_mode_requires_approval"
    （模型收到工具被拒 → 按提示词契约回到计划工具；批准后 hasApprovedPlan=true 放行）
②③④ 现有决策链原序不动
```

## 6. SSE 事件形状（逐字段对齐云端 onEvent 白名单）

### 6.1 计划进度（观测器在 create/update/submit 完成时发射）
```json
{ "sessionId": "<acpSessionId>", "acpSessionId": "<同左>",
  "messageType": "plan", "subType": "plan",
  "data": { "entries": [ { "content": "...", "priority": "high", "status": "pending" } ] },
  "timestamp": "ISO-8601" }
```
云端匹配：`"plan".equals(subType)`（SSE event 名=壳 subType）→ `buildComponentExecutingPlan(data)` 读 `data.entries`。

### 6.2 计划批准请求（submit 观测到 in_progress 时发射；形状复刻 acpEngine 现有审批发射）
```json
{ "sessionId": "<acpSessionId>", "acpSessionId": "<同左>",
  "messageType": "acpRequestPermission", "subType": "request_permission",
  "data": {
    "request_permission_request": {
      "sessionId": "<acpSessionId>",
      "toolCall": { "toolCallId": "<submit 的 ACP toolCallId>", "title": "nuwax_plan_submit…",
                     "kind": "plan_approval", "rawInput": { "planId": "...", "entries": [...], "summary": "..." } },
      "options": [ { "optionId": "approve", "kind": "allow_once", "name": "批准" },
                    { "optionId": "revise", "kind": "reject_once", "name": "需要修改" } ]
    },
    "tool_call_id": "<submit 的 ACP toolCallId>",
    "_meta": { "nuwaclaw_intervention_id": "itv_…", "nuwaclaw_revision": 1 },
    "_intervention": { …buildAcpPermissionInterventionRequest 全量信封，acp.request 即上结构… },
    "_engine": "<engineName>"
  },
  "timestamp": "ISO-8601" }
```
- `request_permission_request` + `tool_call_id` 由 agent-kit `toComputerPermissionProgressData` 产出（壳内 `computerPermissionProtocol.ts:54` 包装）；`kind="plan_approval"` 为自由字符串，云端 `ComponentExecuteResult.kind` 不校验、整体透传。
- 云端防覆盖保护：REQUEST_PERMISSION 事件按 tool_call_id 记入 eventMap 后，同 id 的 tool_call 事件不会覆盖其 input（云注释明示）——submit 的引擎侧工具卡与审批卡共存不互踩。

### 6.3 审批应答（复用，无新端点）
```
前端 POST /api/agent/conversation/chat/permission-request/response
  { conversationId, toolId: "<submit toolCallId>", option: { optionId: "approve"|"revise", outcome: "selected" } }
→ 云端 notifyResolved → 壳 POST /computer/notify-resolved
  { permission_resolve_request: { session_id, tool_call_id, request_permission_response: { outcome: { optionId, outcome: "selected" } } } }
→ approvalInterventionService.resolveFromComputerPermissionCallback（getPendingBySessionTool）
→ pending promise resolve → planModeService 映射：
    optionId=approve  → 计划 status=approved → submit 返回 { approved: true }
    optionId=revise   → 计划 status=draft    → submit 返回 { approved: false, feedback: "用户要求修改计划" }
    cancelled（新 chat/abort/destroy）→ submit 返回 { approved: false }
```

## 7. 观测器关联协议（planModeService.observeToolUpdate）

acpEngine.handleAcpSessionUpdate 对 `tool_call`/`tool_call_update` 透传给观测器（延迟机制无碍：仅 `ui` 表单类 rawInput 被延迟，plan 工具不在其列）：

| 观测 | 动作 |
|---|---|
| title 含 `nuwax_plan_create` && status=completed && rawOutput 可解析出 planId | 绑定 session→plan；发 §6.1 |
| title 含 `nuwax_plan_update` && rawInput.planId | 绑定 session→plan；发 §6.1（条目读 planStore） |
| title 含 `nuwax_plan_submit` && status=in_progress && rawInput.planId | 注册 §6.2 审批 pending（approvalInterventionService.createPending + 合成 acpRequest）+ 发射；await promise → 解 submit 挂起 + 状态机流转 |

- create 的 rawOutput 解析失败时跳过绑定（update/submit 的 rawInput.planId 兜底绑定），仅损失首张计划卡。
- 会话生命周期：`beginPlanTurn`（mode=plan 的 chat 请求时）重置 approved；`clearSession`/destroy 清会话状态。

## 8. 前端契约（nuwax 仓，P2）

- 模式选择器加「计划」：本地旁路态；发送时 `agentMode:"plan"`；ask/yolo 阶梯停靠本地（复用 previousModes 语义），批准后下轮回写。
- 审批卡：`kind==="plan_approval"` 分支（AcpPermissionCard 新分支或独立 PlanApprovalCard）：entries 清单 + [批准(approve)] [需要修改(revise)]；应答走现有 permission response API；revise 后引导用户发送修订消息。
- 计划卡：componentType=Plan → 现有 V2 kind:'plan' 渲染，零改动验证。
- i18n 键在前端仓四文件；壳侧无用户可见文案（硬闸 reason 仅日志/引擎可见）。

## 9. 风险与边界（留档）

- 模型跳过计划直接动手 → 硬闸拦截（引擎收到工具被拒），提示词层（工具描述 + agent system_prompt 配置段）引导。
- 云端 plan 组件随机 executeId → 前端可能按事件堆叠计划卡；首期控制发射频率（create/submit 各一次），P2 目检后定。
- submit 挂起时长受引擎 MCP 超时约束（ask-question 同款机制在产，风险低；联调确认）。
- 修订文本不回传（载荷仅 optionId）→ 二期可选后端 2 处小改（PermissionRequestResponseDto + notifyResolved 透传）。
- 多会话并发：planStore 按 planId 键控 + session→plan 绑定，会话间互不串扰。
