# 基于 Cua（cua-driver）集成 Computer-Use 能力——调研与集成方案 v2（壳仓实证修订版）

- 记录日期：2026-09-17。**本文替代 v1**（`~/Downloads/20260916-cua-computer-use-integration.md`）：v1 撰写时壳 submodule 未检出，7 处标【待核对】；v2 在独立 worktree（`feat/computer-use-research`，基点 release/v1.0.x @ d4ab22b3）完成壳源码三路探查 + 本机 PoC 实证，全部【待核对】已落定为文件级锚点。
- 调研方式：①壳基座源码全量探查（服务编排 / MCP·审批·模型设施 / 打包签名管线三路并行）；②cua 仓恢复检出 @ `625118a90`（v1 依据的本地检出已被移除，本次重新 clone 并核对契约文档与 TS typings）；③本机 PoC：进程内 SDK「截图→元素树→点击」闭环 + VLM 六轮任务循环，**全部通过**（证据见附录 A）。
- 路径约定：**基座** = `nuwa-electron-shell/crates/agent-electron-client`（下文 `src/...` 均相对于此）；**外层** = nuwax-client 本仓；**前端** = nuwax 子模块（nuwax-ai/nuwax）。

---

## 〇、结论速览（v2 修订）

1. **可行性上调：三大对接设施在壳内全部现成，P1 落地成本显著低于 v1 估计。**
   - MCP 管理：stdio 与 HTTP 双形态一等公民（`src/main/services/packages/mcp.ts:522-568`），三层合并 + 代理改写 + 工具发现 + 沙箱白名单联动全链路已有；
   - 审批：ACP `session/request_permission` → 权限协调器 → 干预服务 → `computer:progress` SSE 双投递 → webview 审批卡片 → `notify-resolved` 回传，事件链完整，cua 新增 subType 即可复用；
   - 打包分发：nuwaxcode「构建期 GitHub Release tar.gz / 运行期 OSS zip 兜底 / extraResources + binaryLocator 定位」三通道模式可整体复制；mac 嵌套签名插入点明确（`scripts/build/after-sign.js:255` 后）。
2. **PoC 实证（macOS arm64，本机，2026-09-17）**：
   - TCC 责任链继承**实测通过**：宿主 App 直系 spawn 的 node 子进程里，`accessibility` 与 `screenRecording` 双 `true`，全程零手动授权弹窗；
   - SDK 闭环通过：`list_apps` → `list_windows` → `get_window_state`（截图落盘 + 171 元素树）→ `click`（element_token 定位 + Background 投递）× 4 → 计算器显示 `6×7 = 42`；
   - VLM 循环通过：manual 模式 6 轮（本会话 GLM+4.5v 图像理解，文件握手）；**auto 模式 glm-5.3-flash（BigModel API）4 轮全自动通过**——识别 poc1 残留状态「6×」后主动点清除，再 7→=→视觉确认 42，全程零人工；
   - **反例发现**：macOS 计算器显示屏**不在 AX 元素树里**（170 个元素全是按钮/菜单，无文本节点）——「元素树优先」必须配「截图校验兜底」，终验环节不能依赖元素树读值。
3. **新增对比题（v1 未做）**：壳内已有低配 computer-use——`agent-gui-server`（nut.js 截图/键鼠，HTTP MCP 60008）。v2 §3.5 给出共存/替换结论：**短期共存、cua-driver 作为升级路径引入，不立即替换**。
4. **SDK 新事实（0.28.2 typings 实读）**：
   - 拓扑不止 v1 说的「进程内/daemon」两种，还有第三种 **`createPrivateWorker`**——直接 spawn 二进制、仅经继承 stdio 通信、无 socket 无复用端点（`PrivateWorkerOptions`），是「进程隔离 + 不对外暴露端点」的更保守形态，P1 选型时与 daemon 形态二选一；
   - **`DriverAuthorizationHost` 回调**（`createConfiguredWithAuthorizationHost`）：驱动内建的残留授权请求可经宿主回调转发到壳审批浮层——比 v1 设想的「驱动 consent ↔ 审批浮层对齐」更顺，有官方接缝；
   - 版本三件套实测：driver `0.28.2` / contract `0.8.0` / MCP protocol `2025-06-18`（`metadata()` 返回，启动时校验契约就靠它）；
   - 工具面 55 个（`listToolsJson()` 实测），含 browser_* CDP 套件、`start/stop_recording` + `replay_trajectory`、`launch_app`/`kill_app`、`zoom`、`verify_state`、`escalate_session`。
5. **授权双层结论不变**：OS 层走嵌入模式 TCC 责任链（已实测）；驱动层商业版必须 `bounded` + 能力清单，`standard` 不作默认。
6. **分期维持 P0→P3 框架，P0 已由本次完成**（文档落定 + 双 PoC），P1 工作量下修，具体文件清单见 §10。

---

## 一、目标与范围（沿用 v1，无修订）

目标：Nuwax 客户端在「我的电脑」本地能力之上增加 computer use——登录用户授权后，Agent（本地引擎或云端会话）能够感知本机桌面（截图/元素树）、操作本机应用（后台投递优先）、操控浏览器（CDP），全程可审计、纳入现有审批体系。

成功标准（v1 §1.2 四条）不变：一次授权不再弹窗 / 视觉会话完成计算器级真实任务且步骤可见 / 敏感动作走审批浮层 / 关会话无残留。其中「计算器级任务」**本次 PoC 已在本机预演通过**。

范围外不变：移动端、远程云沙箱桌面（Cua Sandbox/Fleet 另一条产品线）、首期修改 Cua 源码。

---

## 二、Cua 能力与通信面盘点（v2 增补实测数据）

### 2.1 通信面（不变，补充 typings 证据）

| 通道 | 形态 | v2 证据 |
|---|---|---|
| `CuaDriver.create(DriverOptions)` | 进程内直调（UniFFI 原生库，零子进程） | PoC 即此形态；`DriverOptions.claudeCodeCompatibility` 必填布尔 |
| `EmbeddedCuaDriverHost` | spawn 私有 daemon（`--embedded` + hostBundleId） | `EmbeddedDriverHostOptions` 字段全集见 §4.2 |
| **`CuaDriver.createPrivateWorker(PrivateWorkerOptions)`** | **直接 spawn 二进制，仅继承 stdio 通信，无 socket、宿主通道关闭即不可重连** | v2 新发现；`PrivateWorkerOptions {binaryPath, hostBundleId, configuredDriver, environment, inheritStderr}` |
| `CuaDriver.connect(socketPath)` | 连既有 daemon 的兼容客户端 | |
| stdio MCP / HTTP MCP | Agent 边界 | `metadata().mcpProtocolVersion = 2025-06-18` 实测 |

npm 包事实复认：主包纯 JS+类型，平台子包（本机 `@trycua/cua-driver-darwin-arm64` 51MB）内含原生库；**npm 不带 `cua-driver` 可执行文件**（daemon/worker/私有 worker 三种 spawn 形态都需自备二进制，从 Python wheel 提取或源码构建）。

### 2.2 工具面（`listToolsJson()` 实测 55 个）

分组摘录：输入（`click`/`right_click`/`double_click`/`type_text`/`press_key`/`hotkey`/`scroll`/`drag`/`move_cursor`/`set_value`）；感知（`get_window_state`/`get_desktop_state`/`get_accessibility_tree`/`zoom`/`get_screen_size`/`list_apps`/`list_windows`/`get_browser_state`）；应用/窗口（`launch_app`/`kill_app`/`bring_to_front`/`set_window_frame`/`invoke_menu`/`page`）；浏览器 CDP（`browser_prepare/_navigate/_click/_type/_pointer/_download/_dialog/_set_input_files`）；校验/审计（`verify_state`/`start_recording`/`stop_recording`/`replay_trajectory`/`get_recording_state`/`health_report`）；会话/权限（`start_session`/`end_session`/`escalate_session`/`get_session*`/`check_permissions`/`get_config`/`set_config`/`set_agent_cursor_*`）；剪贴板（`clipboard_read/_write`）。

v1 说法复认：独立 `screenshot` 工具确实已移除，规范路径 = `get_window_state` + `includeScreenshot` + `screenshotOutFile`（PoC 实测落盘 460×816@2x PNG ≈110KB）。

### 2.3 定位与元素树（PoC 实测细节，写提示词要用）

- `elementToken` 格式 `s00000001:11`（会话前缀+索引）；`elementIndex` 跨快照稳定（同一窗口 6 轮 snapshot 索引未漂移）；
- 元素 `frame` 是全局屏幕坐标（与截图同源），模型侧「截图 + 带坐标元素清单」可以互相印证；
- macOS 计算器实测：AX 树质量好（中文标签「乘/等于/全部清除」齐全），但**显示屏无任何文本类元素**——`AXStaticText` 缺席，读显示值只能靠截图；
- 中文系统下 appName 也是本地化的（`计算器`），匹配要兼容中英文。

---

## 三、集成形态选型（v2 修订）

v1 四方案（A 进程内 SDK / B 独立安装 / C 嵌入式 daemon / D 云端隧道）结论维持：**C 为主形态**。v2 增补：

- **C 的实现容器二选一**（P1 拍板项）：①`EmbeddedCuaDriverHost`（daemon，UDS socket，多客户端：壳自研循环 + 本地引擎 MCP 代理共用）；②`createPrivateWorker`（stdio-only，更保守：无本地端点可被其他进程连，但 MCP 代理形态要另想——worker 不暴露 socket，引擎侧接入需要壳进程内转发）。**推荐①**：因为「本地引擎经 MCP 接入」是场景一刚需，daemon 的 `connection.mcp` 现成支持。
- A（纯进程内）已由 PoC 验证可行性，作为 P1 里「不启 daemon 时 SDK 也能跑」的降级路径保留。
- B 仅历史意义；D（P3）不变。

### 3.5 新增：vs 壳内既有 `agent-gui-server` 对比

事实（探查实证）：`src/main/services/packages/guiAgentServer.ts` 起 agent-gui-server（`crates/agent-gui-server`，nut.js），HTTP MCP `127.0.0.1:60008/mcp`，API Key 走 `GUI_AGENT_API_KEY`；截图能力在 `crates/agent-gui-server/src/desktop/screenshot.ts`（`screen.capture()`，需屏幕录制 TCC）；由设置页开关（`guiMcpLocalConfig.ts:46` `step1_config.guiMcpEnabled`，缺省关）注入 `mcp_local_config` 远程条目；Windows 另有 `windowsMcp.ts`（uv+python）。

| 维度 | agent-gui-server（现状） | cua-driver 0.28.2 |
|---|---|---|
| 元素感知 | 无元素树（纯截图+坐标） | 带索引/token 的三平台统一元素树 |
| 输入方式 | nut.js 全局事件（动用户焦点/鼠标） | `background` 后台窗口定向投递（macOS SkyLight），`foreground` 可选 |
| 权限模型 | 无（启用即全桌面） | standard/bounded/unrestricted + 能力清单 + `DriverAuthorizationHost` 授权回调，Agent 无法扩权 |
| 轨迹审计 | 无 | 每步 action.json + 前后截图、加密 history、replay |
| 浏览器 | 无 | CDP 套件（OOPIF/shadow-DOM、会话级 target 令牌） |
| 光标可视化 | 无 | agent cursor overlay（daemon 形态） |
| 依赖成本 | 已随包、已在跑（社区版） | 新增二进制分发 + 嵌套签名 + 版本三件套锁定 |
| 许可 | 内部 | MIT（可随包分发） |

**结论：短期共存，不立即替换。** agent-gui-server 是已上线能力（且 guiMcpEnabled 缺省关、影响面小），cua-driver 引入后作为「元素树 + 后台输入 + bounded 权限 + 审计」的升级路径，两者 MCP 条目并存（`gui-agent` 与 `cua`），前端入口/文档口径在 P1 里统一；待 cua 链路稳定后再评估下线 agent-gui-server（社区版兼容性单独评估）。

---

## 四、推荐架构（方案 C 展开，v2 全部文件级锚点）

### 4.1 组件图（沿 v1，标注实证落点）

```text
Renderer/webview（nuwax 前端）
  会话工作台 computer-use 步骤卡片 ◄─ 复用 computer:progress SSE（新 subType: cua_step / cua_screenshot / cua_consent）
壳主进程
  CuaService【落位：src/main/services/cua/（新域，与 packages/ 平级）；骨架照抄 guiAgentServer.ts 模块单例】
   ├─ EmbeddedCuaDriverHost(binaryPath, hostBundleId=app.getBundleName())   ← 二进制定位走 binaryLocator getter
   ├─ CuaDriver.connect(connection.socketPath)   ← 壳自研 VLM 循环直调
   ├─ connection.mcp {command,args,environment}  ← 写入 mcp_local_config（StdioMcpServerEntry 或 Remote HTTP）
   └─ DriverAuthorizationHost 回调 → 干预服务（approvalInterventionService）→ 审批浮层
现有设施（全部已在）：serviceManager 编排 · MCP 管理 · ACP 引擎 · 干预/审批 · file-server（截图 URL）
```

### 4.2 壳内落点清单（【待核对】→ 实证锚点，全部 worktree 内核实）

| v1 待核对项 | v2 实证落点 |
|---|---|
| 壳内服务注册点 | 无统一生命周期框架，编排点是三处手写序：`src/main/window/serviceManager.ts:660 restartAllServices`（顺序：MCP Proxy→GUI MCP→Agent→FileServer→ComputerServer→Lanproxy→ttyd）/ `:939 stopAllServices` / `src/main/main.ts:470 cleanupAllProcesses`。CuaService 需在**三处**都挂；社区版启动期是 `src/main/bootstrap/startup.ts:48` 的 `APP_NAME_IDENTIFIER !== "nuwax"` 分叉，商业版登录驱动 = overlay `nuwaxBridgeHandlers.ts` lifecycle start 回调 → `src/main/ipc/processHandlers.ts:138 restartAllServicesNow` |
| 子进程封装 | `src/main/processManager.ts:10 ManagedProcess`（spawn+日志采集+启动观察窗+进程树杀灭）；**模板 = `guiAgentServer.ts`**（模块级单例：端口 sweep→入口解析→spawn→status/stop，:152-334）。注意：**无自动重启先例**，exit 只记日志；cua 的 restart 代际语义（旧 socket/mcp 配置整体作废）要在 CuaService 自持 |
| 实际 bundle identifier | 商业版产物 = `com.nuwax-ai.nuwax`，但**只存在于 CI 构建期 `npm pkg set`**（外层 `.github/workflows/release-electron.yml:165`），基座源码静态值是 `com.nuwax-ai.nuwaclaw`（`crates/agent-electron-client/package.json:148`）。**嵌入模式必须运行时取 `app.getBundleName()`**，不能依赖源码常量 |
| 随包资源路径约定 | `src/main/services/system/appPaths.ts:29 getResourcesPath()`（packaged=`process.resourcesPath`，dev 回退 `cwd/resources`）+ `src/main/services/system/binaryLocator.ts` getter 模式（:373-382 有「打包→运行时下载目录」双通道回退范例）。新加 `getCuaDriverBinPath()` 照抄 |
| 壳内 MCP 注册接口 | `mcp.ts:522-568`：`StdioMcpServerEntry{command,args,env,enabled,persistent,allowTools,denyTools}` / `RemoteMcpServerEntry{url,transport,headers,authToken,...}` 两者全支持。注入先例 = `guiMcpLocalConfig.ts:82-131`（开关→`mcp_local_config` upsert 远程条目）；另有 feature flag 会话级注入先例 `acpNewSessionParams.ts:163-187`。沙箱联动：macOS strict seatbelt 下 MCP 工具链放行 `src/main/services/sandbox/macOsStrictMcpSandbox.ts:29-70` |
| 审批浮层对接 | 完整链：`acpEngine.ts:2462 handlePermissionRequest` → `permission/permissionCoordinator.ts:105 evaluate`（tool_approval_rules 规则来自 chat 请求 `agent_server.tool_approval_rules`，`computerTypes.ts:32-45`）→ `intervention/approvalInterventionService.ts:58 createPending` → `computer:progress`（`eventForwarders.ts:109-130` 双投递：webContents IPC + computerServer SSE）→ 前端 `AgentIntervention/AcpPermissionCard` → 回传三路（HTTP `/computer/notify-resolved` :970 / 云端回调 / 壳 renderer `intervention:respond`）。cua 的授权回调（`DriverAuthorizationHost`）与步骤推送（新 subType）都挂这条链 |
| 模型代理通道 | 无网关。两条现成路：①chat 请求级 `model_provider{provider,api_key,base_url,model,...}`（`computerTypes.ts:90-110`，前端随会话下发）；②memory 服务直连先例 `src/main/services/memory/utils/llmClient.ts`。VLM 循环首期建议走①（用户会话自带模型配置），key 不落库 |
| electron-builder afterSign 位 | mac：`crates/agent-electron-client/scripts/build/after-sign.js`——嵌套签名段 :165-255（better-sqlite3/node/uv/lanproxy/sandbox-runtime/nuwaxcode/nuwax-codex），**cua-driver 插在 :255 后、主 app 重签 :257 前**，目录加进 :298-305 `stapleDirs`；win：`afterSignWindows`（:364-494）`signDirectory` 模式 + 外层 `docs/sign-windows.md` 手签 runbook 增补一段 |

### 4.3 EmbeddedDriverHostOptions 完整字段（typings 实读，比 v1 文档细）

`{ binaryPath, hostBundleId, socketPath?, startupTimeoutMs?, shutdownTimeoutMs?, permissionMode?(Standard/Bounded/Unrestricted), capabilityManifestPath?, approveCapabilityManifest, dangerouslyBypassApprovals, environment[], inheritStderr, noOverlay }`——商业版传 `permissionMode: Bounded + capabilityManifestPath + approveCapabilityManifest: true`；`connection` 返回 `{socketPath, pid, generation, driverVersion, contractVersion, mcpProtocolVersion, mcp{command,args,environment}}`；`waitForExit(generation)` 观测子进程退出。关停顺序沿官方契约（停新任务→end_session→关 MCP 客户端→driver.shutdown→uniffiDestroy→host.stop→host.uniffiDestroy）。

### 4.4 社区/商业分叉：走 overlay 插槽纪律

`overlay/README.md` 落位纪律：**基座开可选插槽（no-op 桩 + 扩展点）优先于整文件覆写**，loopbackGateway 是先例（基座 `services/loopbackGateway/index.ts` no-op 桩，overlay 实现注入）。CuaService 建议：基座提供 `services/cua/index.ts` 导出面（`startCua/stopCua/getCuaStatus`）+ settings 键 + 事件名，社区版默认关；商业差异（bounded 清单、登录驱动启停、审批桥接）走 overlay。托管清单在外层 `.overlay-sync.json`（现 22 文件）。

### 4.5 本地引擎接入（场景一）与云端（场景二 P3）——结论不变，通道实证补充

引擎接入零改造结论坐实：cua daemon 的 stdio 代理 `connection.mcp` 直接填 `StdioMcpServerEntry`；若用 HTTP MCP 则 `RemoteMcpServerEntry{url: http://127.0.0.1:<port>/mcp, authToken}`。场景二（lanproxy 隧道转发 HTTP MCP）架构位保留，无新增证据。

---

## 五、操作系统授权（v2：PoC 实证 + 壳内现状）

1. **责任链继承实测通过**：PoC 的 node 进程（宿主 App 直系子进程链）内 `currentMacOsPermissionStatus()` 返回 `{accessibility:true, screenRecording:true}`，与嵌入契约「主进程直接 spawn、禁 `open`/NSWorkspace 拉起驱动」一致。**注意**：PoC 里「用 `open -a Calculator` 启动目标应用」不影响结论——TCC 检查的是驱动侧（读屏+注入输入）进程链，目标应用由谁启动无关紧要。
2. 壳内现状：已有检测 `src/main/ipc/appHandlers.ts:357-392 permissions:check`（`isTrustedAccessibilityClient` + `getMediaAccessStatus("screen")`）与引导 `src/main/services/system/macPermissions.ts:31 openMacPrivacySettings`（设置页呈现）；**缺启动期主动申请**——SDK 现成 `requestMacOSPermissions()`（`/electron` 入口同款封装），P1 在 `app.whenReady()` 后按需调用 + 授权页 UX（「去授权→回来刷新→提示重启」）。
3. 可复用先例：`src/main/services/system/workspaceAccessProbe.ts`（用受控子进程复现 TCC 拒绝来「实证」权限而非只看 API 状态）——cua-driver 拉起前可做同款真实能力探测（比如截一张图验证屏幕录制真实生效，规避 stale permission）。
4. 授权变更后完全重启应用再重建运行时（官方契约，troubleshoot-stale-macos-permissions）；嵌入模式禁用 `cua-driver permissions grant`（独立模式命令）。
5. Windows/Linux 结论不变（壳 win 已有代码签名；Linux Wayland 边界写发行说明）。

---

## 六、VLM Agent 循环设计（v2：PoC 实测记录回填）

数据流设计沿 v1 §6.1（截图+元素索引摘要→VLM→{tool,args}→审批门→background 执行→复查），本次 PoC 按「element_index 优先、坐标兜底、截图终验」完整落地。**实测记录（P1 提示词与实现的直接输入）**：

1. **提示词侧**：给模型的元素清单用 `[index] role "label" @(x,y w×h)` 行格式 + 全局坐标（与截图同源）效果好；中文标签直接可用（模型侧无翻译损耗）；显示屏类只读值不在树里，提示词要教模型「算式确认看截图，动作定位看清单」。
2. **执行侧**：模型回 `element_index`，壳侧解析回 `elementToken` 再 `click`（token 是执行通道，index 是模型通道）——六轮全部 index 命中，无需坐标兜底；`deliveryMode: Background` 全程未动用户焦点/鼠标。
3. **校验侧**：终验必须截图（AX 树读不到显示值，见 §2.3 反例）；`verify_state` 工具在场景里未用（计算器无文本元素可比对），复杂应用可启用。
4. **防抖动**：脚本实现「同元素连续失败 3 次中止」，本次未触发。
5. **模型通道（双模式均已实证）**：manual 文件握手=本会话 GLM+4.5v 图像理解驱动 6 轮；**auto 模式 = glm-5.3-flash（BigModel OpenAI 兼容端点）4 轮全自动通过**（2026-09-17）：轮次决策=残留识别→清除→7→=→done(42)，token 开销=每轮 prompt ~1.26k（截图+元素清单，很省）/ completion 含思维链（round1 达 3032），整任务约 9.7k tokens。行为观察：模型会把历史动作与截图状态结合推理（round2 thought 引用了历史而非纯截图），终验截图环节不可省。key 管理纪律：`~/Documents/git-workspace/cua-poc/.env`（600 权限，人工经剪贴板管道写入，agent 命令行/日志零密钥），脚本自动加载。壳内落地走 chat 请求级 `model_provider`（§4.2），不引入 Python `cua-agent` 边车（结论不变）。
6. **开发坑沉淀**（P1 直接避雷）：UniFFI 生成的 tagged-union 变体是 ES class，**必须 `new ActionTarget.Window({...})`** 不能函数调用；`DriverOptions.claudeCodeCompatibility` 是必填布尔；窗口 `windowId` 是 bigint，JSON 序列化要转换。

---

## 七、安全与合规（v2 增补）

1. 攻击面结论不变（嵌入 socket 私有路径 per-user；HTTP MCP 仅 loopback+token；场景二四层链路）。v2 增补：**若选 `createPrivateWorker` 形态，本地零端点**（stdio-only），攻击面更小，代价是引擎 MCP 接入需壳内转发（§3 拓扑二选一）。
2. 与现有体系对齐新增实证接缝：`DriverAuthorizationHost` 官方回调（trusted host 专用，文档明确「不得经 MCP elicitation 或模型可见通道实现」）↔ 壳 `approvalInterventionService`；`DriverActivityEvent`（content-free 审计事件：动作/授权拒绝/会话起止 + riskClass）↔ 壳日志/审计。
3. 许可合规不变：cua-driver MIT 可随包分发；不引入 cua-som（AGPL）。遥测（PostHog）开关仍列 P1 验证项。
4. 隐私：轨迹留存策略（保留时长/上云/可删）仍待产品定义；截图经 file-server URL 下发会话 UI 的链路复用现有产物模式。

---

## 八、打包与分发（v2：模式复制清单）

1. **照抄 nuwaxcode 全链**（`scripts/prepare/prepare-nuwaxcode.js` → `binaryLocator.getNuwaxcodeBundledBinPath` → `nuwaxcodeDownloader.ts` OSS zip 兜底 → `dependencyChecker` 清单）：
   - 构建期：新 `scripts/prepare/prepare-cua-driver.js`——产物源**首版从官方 Python wheel 按平台提取 `cua-driver` 可执行文件**（v1 结论复核仍成立：npm 不带），锁 0.28.2；SHA256 校验 + 缓存放 `resources/cua-driver/{platform}-{arch}/bin/`；extraResources 加一条；
   - 运行期：`getCuaDriverBinPath()`（packaged→appDataDir 下载目录→bundled 双通道回退，照 :373-382）；OSS deps 通道 zip 兜底照 `nuwaxcodeDownloader.ts`（产物须上传 nuwax-electron/deps，人工上传——现状无 workflow 自动化）。
2. **mac 嵌套签名**：`after-sign.js` :255 后加 cua-driver 段（codesign + entitlements 视驱动需求）→ 主 app 重签 → stapleDirs(:298-305) 加目录。CI 证书/公证管线不动。
3. **win**：NSIS/MSI 分发 + `afterSignWindows` signDirectory + 手签 runbook（`docs/sign-windows.md`）增补。
4. **版本锁定**：npm 主包+平台包+可执行文件三件套同版本（0.28.2 / contract 0.8.0 / MCP 2025-06-18）；启动时 `driver.metadata()` 校验 `contractVersion`，不匹配禁用入口 fail-fast（SDK 侧 `IncompatibleDaemon` 错误类型已备）。
5. 平台矩阵不变（mac arm64/x64、win x64、linux x64/arm64 均在支持列表）。

---

## 九、风险与边界（v2 修订表）

| # | 风险 | v1 判断 | v2 修订 |
|---|---|---|---|
| 1 | 契约 0.x 破坏性变更 | 高 | 不变；已实测 `metadata()` 可用作启动校验；0.28.x 一个月内多次小版本，锁版纪律从严 |
| 2 | standard=全桌面输入 | 必须 bounded | 不变；SDK 侧 `RuntimeAuthorizationOptions`（allowedModes+compatibilityMode+manifest 路径）实证存在，宿主锁定天花板是官方设计 |
| 3 | 平台能力差异 | 声明边界 | 不变；mac 全链已 PoC，win/linux 留 P1 实测 |
| 4 | 进程内无 agent cursor overlay | 走 daemon | 不变（daemon 形态自带，overlay 工具 `set_agent_cursor_*` 在 55 工具清单内） |
| 5 | 可执行文件自备 | wheel 提取/源码构建 | 不变；P1 先 wheel 提取验证，必要时锁版缓存或 CI 构建 |
| 6 | VLM 模型差异 | P0 实测 2-3 个 | **基本完成**：glm-5.3-flash 全自动 4 轮通过（残留识别/主动清除决策正确，整任务 ~9.7k tokens）+ manual 侧管线双验证；第二家模型按需补测 |
| 7 | 壳仓未检出、落点未实证 | P0 第一件事 | **已关闭**：§4.2 全部落定 |
| 8 | 驱动遥测 PostHog | P1 验证 | 不变 |
| 9 | （新）与 agent-gui-server 双轨并存的口径/维护成本 | — | §3.5 共存结论；P1 里统一 MCP 条目命名与文档口径，稳定后评估下线 |
| 10 | （新）元素树不覆盖只读文本（计算器显示反例） | — | 设计已吸收：终验一律截图，提示词明示分工（§6.3） |

---

## 十、分期路线（v2 修订）

| 阶段 | 内容 | 出口标准 | v2 状态 |
|---|---|---|---|
| P0 预研 | 壳仓核对 + SDK 闭环 PoC + VLM 用例 + 文档落定 | 本文 + PoC 证据 | **✅ 2026-09-17 完成**（SDK 闭环 + VLM manual/auto 双模式全过，glm-5.3-flash 实测） |
| P1 本机 MVP | 方案 C：EmbeddedCuaDriverHost + 可执行文件随包（wheel 提取+prepare 脚本+extraResources+binaryLocator）+ macOS 权限引导（requestMacOSPermissions + 授权页）+ MCP 条目注入（照 guiMcpLocalConfig）+ bounded 默认 + DriverAuthorizationHost→审批浮层 + cua_step/cua_screenshot subType + 三处编排挂载 + win/linux 打包验证 | v1 §1.2 成功标准三平台全过；嵌套签名公证流水线跑通；契约校验 fail-fast | 工作量较 v1 下修（MCP/审批/打包三块现成），预估 4-6 人日（mac）+2-3（win/linux 打包验证） |
| P2 体验收紧 | agent cursor 可视化、轨迹回放入会话 UI、能力清单管理 UI、遥测合规、doctor 集成 | 内测可用 + 安全评审 | 不变 |
| P3 云端场景 | lanproxy 隧道 + HTTP MCP + 平台侧 VLM 编排联调 | 端到端演示 + 安全评审 | 不变 |

---

## 附录 A：PoC 证据与复现（2026-09-17，macOS arm64，本机）

- 环境：`~/Documents/git-workspace/cua-poc`（npm `@trycua/cua-driver@0.28.2` + `cua-driver-darwin-arm64`）；cua 源码仓恢复检出 @ `625118a90`。
- 脚本与产物已归档：`docs/computer-use-poc/`（本仓 worktree）——`poc1-sdk-loop.mjs`（SDK 闭环 probe/act）、`poc2-vlm-loop.mjs`（VLM 循环 auto/manual）、`transcript.jsonl`（VLM 六轮转录）、`shot-before/after.png`（SDK 闭环前后）、`round-1/6.png`（VLM 循环首末轮）。
- SDK 闭环结果：`click 6/乘/7/等于`（element_token + Background）全部 ok；after 截图显示 `6×7 = 42`。
- VLM 循环结果：manual 模式 6 轮 `done(answer=42)`（模型侧=本会话 GLM+4.5v 图像理解，文件握手）；**auto 模式 glm-5.3-flash 4 轮全自动通过**（残留识别→清除→7→=→done(42)，token：prompt 1253/1259/1269/1281 + completion 3032/940/274/353，转录 `vlm-auto-transcript.jsonl`、截图 `vlm-auto-round{1,4}.png`/`vlm-auto-final.png`）。
- auto 复跑：key 放 `~/Documents/git-workspace/cua-poc/.env`（`CUA_VLM_API_KEY`/`CUA_VLM_MODEL`，600 权限、人工创建），然后 `node poc2-vlm-loop.mjs auto`——命令行与日志零密钥。
- 关键日志摘录：TCC `{accessibility:true, screenRecording:true}`；metadata `{driverVersion:0.28.2, contractVersion:0.8.0, mcpProtocolVersion:2025-06-18, embedded:true}`。

## 附录 B：Cua 侧参考索引（v2 复认，仓 @625118a90）

| 主题 | 路径 |
|---|---|
| 嵌入契约（权威） | `libs/cua-driver/rust/Skills/cua-driver/EMBEDDING.md` ✅ 存在 |
| 桌面应用暴露 MCP | `docs/content/docs/how-to-guides/driver/expose-mcp-from-desktop-app.mdx` ✅ 存在 |
| TS SDK 入口 | `libs/cua-driver/typescript/`：`/electron`（权限引导）、`/embedded`、`/fleet` 导出 ✅（npm 包 exports 实测同） |
| typings（本 PoC 实读） | npm 包 `dist/native/cua_driver_sdk.d.ts`（3586 行）与 `cua_driver_contract.d.ts` |

## 附录 C：v1 → v2 差异一览

- 7 处【待核对】全部落定（§4.2 表）。
- 新增：§3.5 vs agent-gui-server 对比；§2.1 第三拓扑 PrivateWorker；§4.3 EmbeddedDriverHostOptions 全字段；§七 DriverAuthorizationHost/DriverActivityEvent 接缝；§6 实测记录（含三条开发坑）；风险 #9/#10；P0 完成标记与 P1 工作量下修。
- 结论变化：可行性上调（三大设施现成）、形态推荐细化为「daemon 容器（EmbeddedCuaDriverHost）为主 + PrivateWorker 备选」。
