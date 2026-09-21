# 个人电脑会话发消息报 400（SSE）——根因定位与修复建议（致后端）

> 2026-09-18 · 排查：客户端组 · 定位结论：**agent-platform「项目创建和会话改造」把云端容器路径回填进了个人电脑会话，派发时覆盖了正确的 agent_work_dir**
>
> 对照代码：**origin/feat-0901**（注意：本地检出落后远端十几个提交，`WorkspacePathRules`/双路径模型在旧检出里不存在，请以 origin/feat-0901 为准）

## TL;DR

新版会话创建对**无项目**的通用智能体会话，落库后**无条件**回填 `agentWorkspacePath = /home/user/<会话ID>`（云端容器约定）。选「个人电脑」的会话也被回填。发消息时 `SandboxAgentClient` 用该字段覆盖 `agent_work_dir` 默认值（裸会话 ID），于是发往用户个人电脑的 chat 请求带上了 `/home/user/<会话ID>`——这个 Linux 路径在用户的 Windows/Mac 本机不存在，客户端按契约拒收（HTTP 400, `AGENT_WORK_DIR_NOT_FOUND`），前端表现为：

```
Failed to connect to SSE stream. Unexpected status code: 400
```

## 现象与复现

- 入口：客户端（Nuwax 桌面版）内嵌首页会话框 → 选择「个人电脑（Nuwax 客户端）」→ 新建会话发消息。
- 当天 16:22 创建的第一条会话（cId=1693430）正常回复；**16:23 起之后所有新建会话全部报 SSE 400**（cId=1693431/1693432/1693436），旧会话 1693430 复用始终正常。
- 客户端侧链路全程健康：登录注册成功（reg ok、服务 ready）、lanproxy 隧道健康、后端 `create-workspace-v2` 在本机建工作区+装技能均成功——问题不在客户端，在 chat 请求体的一个字段。

## 客户端侧证据（main 日志，win 真机）

成功与失败两次 chat 请求体逐字段 diff，**唯一实质差异**就是 `agent_work_dir`：

| 时间 | cId | chat 请求里的 agent_work_dir | 结果 |
|---|---|---|---|
| 16:22:04 | 1693430 | `"1693430"`（裸 ID） | 会话创建、SSE 建立、正常回复 |
| 16:23:05 起 | 1693431/1693432/1693436 | `"/home/user/<cId>"` | `❌ agent_work_dir rejected: AGENT_WORK_DIR_NOT_FOUND` → 400 |

客户端校验契约（2026-09-14 双方对齐的双轨制，客户端 `agentWorkDir.ts`）：

- 非绝对值 = 会话标识符 → 映射到本机 `{workspace}\computer-project-workspace\{userId}\{cId}`（后端 `create-workspace-v2` 正是建在这里，技能也装在这里）；
- 绝对路径 = 用户通过 web 目录选择器选的**本机**目录，要求真实存在（fail-fast，不误建）。

`/home/user/<cId>` 两条轨都不属于——它是云端容器路径。

## 根因（agent-platform @ origin/feat-0901）

**① 创建会话：无项目会话无条件回填云端容器路径**

`ConversationApplicationServiceImpl.doCreateConversation` 末尾：

```java
// 通用智能体（无项目）双路径按会话规则生成（依赖会话 id），落库后回填；
// 项目会话双路径已在上方取自绑定行
if (project == null) {
    Conversation backfill = new Conversation();
    backfill.setFileWorkspacePath(WorkspacePathRules.taskAgentFileWorkspacePath(userId, conversation.getId()));
    backfill.setAgentWorkspacePath(WorkspacePathRules.taskAgentWorkspacePath(conversation.getId()));
    conversationDomainService.updateConversation(conversation.getId(), backfill);
    ...
}
```

`WorkspacePathRules`：

```java
/** agent 执行容器工作空间根 */
public static final String AGENT_WORKSPACE_ROOT = "/home/user";

public static String taskAgentWorkspacePath(Long cId) {
    return AGENT_WORKSPACE_ROOT + "/" + cId;   // ← 失败请求里看到的值
}
```

回填发生在 `sandboxServerId` 解析之后，但**没有按沙箱 scope 区分**——个人电脑（USER scope）会话同样被填上云端容器路径。

**② 派发：该字段覆盖了正确的默认值**

`SandboxAgentClient`（chat 组包处）：

```java
String agentWorkDir = agentContext.getConversationId();   // 默认=裸 cId，个人电脑要的正是它
if (/* UserApp */) { agentWorkDir = appId; }
if (conversation != null && StringUtils.isNotBlank(conversation.getAgentWorkspacePath())) {
    agentWorkDir = conversation.getAgentWorkspacePath();  // ← /home/user/<cId> 覆盖，未区分目标沙箱
}
```

**③ 客户端拒收**：绝对路径轨 `realpathSync("/home/user/1693431")` 在本机失败 → 400 `AGENT_WORK_DIR_NOT_FOUND`（客户端 `router.ts:331-337`）→ 前端 SSE 400。

## 为什么第一条会话是好的

1693430（16:22:03 创建）发出的 `agent_work_dir` 是裸 cId，说明它的 `agentWorkspacePath` 为空——**只有旧版代码才会留空**。即 test 环境在 16:22–16:23 之间部署了新版；部署前创建的会话正常、部署后新建的通用会话全挂，旧会话因字段为空持续可用。这与"第一条能聊、之后全报错"的现象完全吻合，非偶发。

## 影响范围

- **主伤害**：选个人电脑 + 未选目录（默认工作目录）的新建通用智能体会话，**100% 必挂**（每次发消息都 400）。
- 云端沙箱会话不受影响（`/home/user/<cId>` 在容器内正确）。
- 选了自定义目录的个人电脑会话理论上不受影响（隐式常规项目绑定行里存的是本机路径）——建议一并回归。

## 修复建议（两处任选，建议双保险）

1. **创建时**（推荐）：`taskAgentWorkspacePath` 的回填**仅限云端沙箱会话**；沙箱为个人电脑（USER scope）且用户未选目录 → 不回填（留空 = 裸 cId 语义，客户端自动映射到 `computer-project-workspace\<userId>\<cId>`，与 `create-workspace-v2` 建目录的位置一致）。注意存量脏数据：已回填的个人电脑会话需要清理（`agent_workspace_path` 置空或按下方②兜底）。
2. **派发时**（兜底）：`SandboxAgentClient` 组包前，若会话沙箱 scope=USER 且 `agentWorkspacePath` 以 `/home/user/` 开头（容器路径形态）→ 回退为裸 `conversationId`。

## 验收标准

修复部署后：

1. 首页会话框选「个人电脑」（**不选目录**）→ 新建会话发消息 → 正常回复；客户端 main 日志 `📨 [HTTP] Computer Chat request body` 中 `agent_work_dir` 为**裸 cId**，且无 `❌ agent_work_dir rejected`。
2. 同场景**选一个本机目录**再建会话发消息 → 正常（`agent_work_dir` 为所选本机绝对路径）。
3. 云端沙箱会话回归：发消息正常（`agent_work_dir=/home/user/<cId>` 不变）。
4. 部署前创建的既有个人电脑会话（含已挂的 1693431 等）重发消息 → 正常（存量脏数据被②兜底或①清理）。

## 附：客户端日志关键行（win 真机，2026-09-18）

```
16:23:04 [fileServer] Create workspace v2 request {"userId":"17545...","cId":"1693431","agentId":"4276","workspaceType":"taskAgent",...}   ← 后端在本机建工作区成功
16:23:04 [fileServer] Workspace created successfully ... {"workspaceRoot":"D:\\tools\\Nuwax\\computer-project-workspace\\17545...\\1693431",...}
16:23:05 [HTTP][DEBUG] Computer Chat request body = { ... "agent_work_dir": "/home/user/1693431" ... }                                     ← 一秒后 chat 却带容器路径
16:23:05 ❌ [HTTP] agent_work_dir rejected: { code: 'AGENT_WORK_DIR_NOT_FOUND', value: '/home/user/1693431' }                              ← 客户端 400，前端显示 SSE 400
```

（对比 16:22:04 成功会话同结构请求体，`agent_work_dir: "1693430"`，其余字段等价。）
