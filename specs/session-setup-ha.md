# 规格：session-setup-ha

- 状态：技术评审通过（方案经用户批准，2026-11-25）

## 需求基线

背景与目标见 `plans/20261125-session-setup-ha-plan.md`。本规格只记录需要长期稳定的边界：预算、恢复链路、隔离约束、对外返回字段。

本期不做：prompt 阶段卡死（模型接口无响应）、MCP 冷启动提速、引擎/后端/前端改动、建立阶段的进度提示。

## 方案设计

### 架构落点

- `engines/acp/acpSetupBudgets.ts`：预算与超时包装，无其他依赖。
- `engines/acp/acpSessionRecovery.ts`：恢复链路状态机。纯逻辑，依赖全部注入（时钟、重建、隔离、状态），不直接碰进程和文件。
- `engines/acp/acpEngine.ts`：只负责把引擎能力接给链路——重建进程、读取隔离 home、记摘要。
- `computer/router.ts`：传入链路起点时间，熔断期内直接返回。错误信封不变。

超时只能做在宿主侧：SDK 的待响应表是私有的，无法取消已发出的 RPC，迟到的响应会唤醒挂起的续体。因此硬超时后必须销毁进程，并用代际号让销毁前的续体失效。

### 数据与契约

**预算**（初值，单位毫秒；`NUWAX_ACP_SETUP_BUDGETS` 以 JSON 覆盖，字段同名）：

| 字段 | 初值 | 含义 |
|---|---|---|
| `loadSoftMs` | 15000 | 恢复超过该时长只告警，继续等 |
| `loadHardMs` | 40000 | 恢复硬上限 |
| `newSessionHardMs` | 40000 | 建新会话硬上限 |
| `pluginInstallHardMs` | 40000 | 插件共享的 `npm install`；超时按既有失败语义处理（告警后继续启动） |
| `spawnHardMs` | 10000 | 等待引擎进程 spawn |
| `handshakeHardMs` | 10000 | `initialize` 握手 |
| `configOptionHardMs` | 15000 | 模型同步 |
| `destroyHardMs` | 12000 | 销毁引擎 |
| `chainDeadlineMs` | 150000 | 自进入 `/computer/chat` 起整条链路上限 |
| `minRetryMs` | 20000 | 剩余不足该值不再重试 |

**恢复链路**（每个请求最多经历三个引擎进程）：

1. 内存命中直接用。
2. `session/load`：成功保留上下文；报错记原因后建新会话；软超时告警继续等；硬超时则销毁进程、该 `session_id` 进黑名单，再建新会话。
3. `session/new` 超时：
   - 本请求还没重建过：销毁并用原配置重启，重试一次。
   - 已重建过：满足隔离约束则隔离 home，重启，再试一次。
   - 仍失败：销毁进程，开熔断，返回结构化错误。
4. 模型同步超时：销毁进程，返回结构化错误，本请求不再重试。

**隔离 home 的约束**：

- 只对持久化的 project home。
- 同一 home 还有其他活跃引擎时不隔离。
- 每个 home 每次运行最多一次。
- 本次运行里若有别的会话也出现建会话超时，视为机器级变慢，不隔离。
- 做法是把 `<engine>/home` 改名为 `home.quarantine-<时间戳>`，原数据保留 7 天。

**进程内状态**（重启清空）：

- 恢复黑名单：硬超时过的 `session_id` 本次运行不再 load。
- 熔断：判为环境卡死后，该会话 5 分钟内直接返回错误；到期自动再试，不再隔离。

**并发**：同一会话的并发消息共享一次建立过程，含错误；建立完成后沿用现有 `runDispatch` 顶替。

**对外字段**（`ComputerChatResponse`，类型不变）：

- 失败：`code: "5000"`、`success: false`，`message` 为可读文案，`data.error` 同文案，`data.fallback_reason` 取 `engine_init_timeout`、`setup_timeout`、`engine_env_hang`、`quarantine_failed` 之一（另有内部用的 `setup_failed`、`engine_recycle_failed`）。
- 降级后成功：`is_new_session: true` 加 `fallback_reason`，取 `session_not_found`、`load_error`、`load_timeout`、`engine_env_reset`。
- `need_fallback` 不动：契约含义是「需要调用方降级重试」，后端行为未知。

### 平台/引擎矩阵

| 行为点 | 说明 |
|---|---|
| 所有引擎 | 链路在 `AcpEngine` 内，claude-code、nuwaxcode、codex、harness 共用 |
| Windows | 进程树 kill 与 home 改名需安装包实机验收；改名失败归入 `quarantine_failed` |
| stable / beta | 摘要日志为 info 级，两条通道都落盘 |

## 异常与失败场景

| 场景 | 结果 |
|---|---|
| 握手、spawn、插件安装无响应 | 初始化返回失败，chat 返回 `engine_init_timeout` |
| `session/load` 报错（含会话不存在） | 建新会话，`fallback_reason` 为 `session_not_found` 或 `load_error` |
| `session/new` 返回非超时错误 | 返回 `setup_failed`，不重建 |
| 重建本身失败 | 返回 `engine_recycle_failed`，不熔断；下次请求由服务层重建 |
| 链路时限已到 | 不再重试，返回 `setup_timeout` |
| 引擎在链路期间被外部销毁（停止、空闲驱逐） | 链路中止，本条消息返回失败，不尝试重启 |
| 熔断期内再来消息 | 不进链路，立即返回同一条错误 |

## 测试计划

见 `plans/20261125-session-setup-ha-plan.md` 的「证明成立的测试」。真环境验收：macOS 开发环境复现由实现者手动跑；Windows 安装包验收由实机执行。

## 已否决的备选方案

- **维持 15 秒即回退新会话**：健康恢复在慢机器上要 23–26 秒，会把正常恢复判成失败并静默丢上下文。
- **只加超时、不重建进程**：超时不取消 RPC，后续请求会排在卡死的 load 后面，回退的 new 同样挂起。
- **超时后先在同一连接上重试 new**：同事日志里 6 次回退全部无响应，连接已不可用。
- **引擎日志有增长就延长等待**：依赖引擎日志格式，脆弱；留作后续可选优化。
