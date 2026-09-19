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
3. **新增对比题（v1 未做）**：壳内曾有低配 computer-use——`agent-gui-server`（nut.js 截图/键鼠，HTTP MCP 60008）。**2026-09-17 用户定案：GUI agent 已废弃，不进商业版；社区本地沙箱方案（seatbelt/bwrap/ACP 约束那套）同样不进商业版（09-14 已定界：商业走 reg 远端沙箱）**——cua-driver 是商业版唯一 computer-use 路径，直接接班（对比表保留作能力差异的历史证据，§3.5）。
4. **SDK 新事实（0.28.2 typings 实读）**：
   - 拓扑不止 v1 说的「进程内/daemon」两种，还有第三种 **`createPrivateWorker`**——直接 spawn 二进制、仅经继承 stdio 通信、无 socket 无复用端点（`PrivateWorkerOptions`），是「进程隔离 + 不对外暴露端点」的更保守形态，P1 选型时与 daemon 形态二选一；
   - **`DriverAuthorizationHost` 回调**（`createConfiguredWithAuthorizationHost`）：驱动内建的残留授权请求可经宿主回调转发到壳审批浮层——比 v1 设想的「驱动 consent ↔ 审批浮层对齐」更顺，有官方接缝；
   - 版本三件套实测：driver `0.28.2` / contract `0.8.0` / MCP protocol `2025-06-18`（`metadata()` 返回，启动时校验契约就靠它）；
   - 工具面 55 个（`listToolsJson()` 实测），含 browser_* CDP 套件、`start/stop_recording` + `replay_trajectory`、`launch_app`/`kill_app`、`zoom`、`verify_state`、`escalate_session`。
5. **授权双层结论不变**：OS 层走嵌入模式 TCC 责任链（已实测）；驱动层商业版必须 `bounded` + 能力清单，`standard` 不作默认。
6. **分期维持 P0→P3 框架，P0 已由本次完成**（文档落定 + 双 PoC），P1 工作量下修，具体文件清单见 §10。
7. **形态拍板（2026-09-17 下午增量，用户决策）：方案 E「独立 helper 应用实例」升为首发形态**，C（内嵌 daemon）降为回退参考——核心理由=权限身份隔离（授权/回收/重授权只重启 helper、主客户端零重启、最小权限口径）+ ZCode 市场先例实证；代价=P1 打包签名链路工作量约翻倍（mac 8-10 人日）。**TCC 身份是一次性决定，不做 C→E 中途迁移**（否则全量用户重授权）。同场拍板：helper 二进制**源码自建**（锁 tag cargo 构建，不打包 trycua release 产物）。详见 §3.6 / §八 / §十 / 附录 D。

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

v1 四方案（A 进程内 SDK / B 独立安装 / C 嵌入式 daemon / D 云端隧道）原本结论为 C 为主。**2026-09-17 下午用户拍板升级为方案 E（独立 helper 应用实例，见 §3.6）**，C 降为回退参考（§四 保留其锚点——MCP/审批/模型对接与容器形态无关，两种形态通用）。仍有效的增补：
- C 的实现容器二选一（若回退 C 时）：①`EmbeddedCuaDriverHost`（daemon，多客户端共用）；②`createPrivateWorker`（stdio-only 无端点，更保守但 MCP 代理需壳内转发）。
- A（纯进程内）已由 PoC 验证，作为「不启 daemon 时 SDK 也能跑」的降级路径保留；B 仅历史意义；D（P3）不变。

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

**结论（2026-09-17 用户定案，替代早先「短期共存」草案）：GUI agent 已废弃，不进商业版；本地沙箱方案（社区 seatbelt/bubblewrap/ACP 约束）亦不进商业版（09-14 定界：商业走 reg 远端沙箱）。** cua-driver 是商业版唯一 computer-use 路径，直接接班：无 MCP 条目并存问题（只有 `cua`）、无前端入口/文档口径迁移问题；`guiMcpEnabled` 开关与 gui-agent 相关代码在商业版不出现（本节开关设计仅**引用其代码模式**作为实现参照，非保留该功能）；§4.2/§七 提及的沙箱锚点（macOsStrictMcpSandbox、沙箱矩阵）均为社区版设施，商业版 MCP 条目注入不依赖它们。社区版是否保留 agent-gui-server 与本地沙箱由社区线自行决定，与商业版无关。

### 3.6 方案 E：独立 helper 应用实例（首发形态，2026-09-17 用户拍板）

**决策记录**：核心理由=①权限身份隔离：辅助功能/屏幕录制授权归专用 helper，授权/回收/重授权**只重启 helper、主客户端零重启**；②最小权限口径：系统弹窗署名是专用 helper 而非主 app 持有「控制电脑」能力，商业合规更稳；③市场先例已验证可量产。代价=P1 打包签名链路工作量约翻倍、离开 cua 官方文档路径（机制以 spike 实证兜底，见附录 D）。TCC 身份一次性决定，不做 C→E 中途迁移。

**市场实证（本机探查，2026-09-17）**：ZCode 的 computer-use = `ZCode Computer Use.app`（bundle id `dev.zcode.cua-helper`，LSUIElement 无图标、与主程序同团队 `8A5X4JJ39T` 签名、hardened runtime）。分发模式=随主程序捆绑（meta `bundled:zcode-app`）→**首用安装到 `~/.zcode/computer-use/`**（安装锁 + 签名/团队校验 `verificationMode:"release"`）→按需 LaunchServices 拉起（launchctl `application.dev.zcode.cua-helper.*`，PPID=1 挂 launchd，`--launcher-pid` 探活）→MCP server（stdio）经 `/tmp/zcode-cua-501/<uid>/broker-*.sock` + token 文件连 helper；TCC 归 helper。注意：**ZCode 的 helper 是自研栈（Node SEA + 自研 AX 模块），不消费 cua-driver**——我们封装模式照抄，驱动用 cua-driver。

**cua 官方立场与边界（源码实证 @625118a90）**：
- standalone daemon 是官方三种受支持 macOS 身份之一（`docs/content/docs/reference/cua-driver/process-model.mdx:60-62`），但「桌面 App 连外部独立 daemon」**无官方 how-to**；EMBEDDING.md 开篇即为其反面诉求（不随包发第二个 app、不出第二个授权弹窗）；
- **官方 CuaDriver.app（`com.trycua.driver`，Developer ID 签名公证）不可直接随包分发**：它自带 `update --apply` 自更新，而 SDK↔daemon 是**四个契约版本精确匹配**（contract/tools_list_schema/capability/mcp_protocol，`cua-driver-sdk/src/lib.rs:350-383`）——它自行升版我们必失配拒连；
- 故 E 的实现 = **自建 bundle + 自建二进制**（§八源码构建），版本随主包锁死，helper 无独立更新通道；
- 通信面：daemon UDS 默认 `~/Library/Caches/cua-driver/cua-driver.sock`（0600 + SO_PEERCRED 同用户鉴权，`serve.rs:624-752`，无 token）；我们用 `--socket` 显式私有路径；HTTP MCP（loopback + 强制 bearer token，`mcp_http.rs`，env 开关无 CLI flag）作引擎/云端备选通道；多客户端共享 daemon 的官方配方 = 各客户端统一 `cua-driver mcp --socket <endpoint>` 显式下发（process-model.mdx:99-102）。

**产品链路（单包集成，用户强调：一个客户端包搞定）**：

```text
Nuwax 安装包（DMG/NSIS 单包）
 └─ Resources/cua-helper/Nuwax Computer Use.app   ← 嵌套完整 .app（自建 Info.plist + entitlements）
     首用/版本变化 → 安装器逻辑：拷贝到 ~/.nuwax/cua-helper/（稳定路径锚定 TCC 与 LaunchServices）
       + codesign 校验（团队 ID + bundle id + 版本 meta + 安装锁，学 ZCode verificationMode）
     → open 拉起：serve --socket <~/.nuwax/…/cua.sock> --permission-mode bounded [--capability-manifest …]
     → 主进程就绪握手（socket 出现 + metadata 四契约校验 + pid）
     → CuaDriver.connect(socketPath)（壳自研 VLM 循环）
       + 本地引擎：cua-driver mcp --socket 代理 或 HTTP MCP 条目下发
```

- 双版本 bundle id：商业 `com.nuwax-ai.nuwax-cua-helper` / 社区 `com.nuwax-ai.nuwaclaw-cua-helper`（同机双装不互抢 TCC）；
- 生命周期：登录/会话按需拉起（挂 §4.2 三处编排）；主 app 退出**不必**杀 helper（E 的额外红利：helper 可跨主 app 重启存活，会话不中断；配 launcher-pid 看门狗超时自退）；
- TCC 交互：授权弹窗署名 = helper 名；壳 `permissions:check` 需扩展「面向 helper 的探测」（现只测主 app）；授权变更后仅 `open` 重拉 helper——主客户端不动。

**配置开关与首次授权引导（2026-09-17 用户需求，P1 交互骨架）**：
1. **开关=配置项**：settings 键 `step1_config.computerUseEnabled`（**默认关**），完全照 `guiMcpEnabled` 先例（`guiMcpLocalConfig.ts:46/82-131` 的开关→服务拉起→MCP 条目 upsert 模式）——开=装 helper（若未装）→授权检查→拉 daemon→`cua` MCP 条目注入；关=daemon shutdown（协议优先/pid 直杀兜底）+ 移除 MCP 条目。设置页开关旁挂状态灯（未装/待授权/已就绪/运行中）。
2. **首次授权引导**（开关首次打开时，设置页内嵌三步卡片，不走独立弹窗）：
   - ① **说明页**：为什么要两项权限（辅助功能=替你点击输入；屏幕录制=看懂屏幕）+ 隐私口径（本机执行、轨迹可审计、bounded 范围内）+「Nuwax Computer Use 将出现在系统设置的辅助功能/屏幕录制列表」预告（避免用户疑惑陌生名字）；
   - ② **一键授权**：「开始授权」→ 壳触发 helper 的权限宿主（附录 D 已实测的正路：AX 弹窗→打开系统设置→开开关；SR 同页处理）→ 后台轮询 `check_permissions` 实时回显两项状态；
   - ③ **完成/失败页**：双绿→自动拉起 daemon+注入 MCP+「试一试」demo 按钮（计算器示例）；拒绝/超时→重试入口+排障提示（含 doctor 集成）。授权全流程零终端、零手动找 app（正是 spike 实证的权限宿主弹窗流）。
3. 开关与 overlay 插槽联动：基座提供开关+引导骨架（插槽），商业版默认关+引导文案走 overlay（locales 键随行）。

**壳侧新增工作清单（7 项，文件级锚点，均为全新无先例）**：
1. `prepare-cua-helper`：源码构建（cargo，锁 tag）+ 组装 .app（自写 Info.plist：bundle id 参数化 / LSUIElement / CFBundleExecutable）→ `resources/cua-helper/`；win 侧 = 独立 exe 目录（`build-sandbox-helper.js` 同款模式）；
2. `after-sign.js`：嵌套 bundle 级签名（:255 后插入，先内后外、禁 `--deep`）+ stapleDirs 扩展 bundle 级 staple（:298-305）+ 新增 helper entitlements plist；
3. LaunchServices 拉起封装（全仓零先例；`open -a <path> --args`，垫 `services/utils/spawn.ts`）+ 就绪握手（轮询模式抄 lanproxyHealth `waitForLanproxyTunnel` / serviceManager `waitForTtydGatewayHealth` 四件套 + daemon socket/metadata/pid）；
4. 首用安装器：Resources→稳定路径拷贝 + codesign 团队校验 + 安装锁 + 版本比对升级；`binaryLocator` 新增 `getCuaHelperAppPath()` 双通道 getter（照 :373-382 范例）；
5. TCC 探测/引导改造：`permissions:check` 扩 helper 面（受控子进程真实探测，workspaceAccessProbe 模式）+ 授权页 UX（署名说明 / 去授权 / 只重启 helper）；
6. helper 看门狗与自恢复：launcher-pid 探活自退（主 app 强杀后）；健康巡检 + 重启上限（windowsMcp `manager.ts:233-268` 模式）；注意 `killProcessTreeGraceful` 组杀/后代杀对 launchd 下的 open 拉起进程**无效**（processTree.ts:390-439），只能 pid 直杀或 shutdown 协议；
7. 证书/身份稳定性纪律：bundle id + Developer ID 证书跨版本不变 = TCC 授权保留（**换证书 = 全量用户重弹授权**，写决策记录）；每次更新 helper 须重公证 + staple（否则首启 syspolicyd 在线查证）。

**spike 实现级补充（2026-09-17，详见附录 D）**：①源码补丁点=`bundle.rs:100-113` 的 bundle 白名单（否则 disclaim re-exec 导致动作静默失效，本日实测踩中）；②launcher 必须做 TCC 主动弹窗引导（macOS 无 API 写 TCC，手动＋添加 UX 不可接受）；③helper 二进制与 npm SDK **必须同仓锁版同包分发**（四契约精确匹配，官方 0.21 vs SDK 0.28.2 实测拒连）。

---

## 四、壳内对接锚点与架构（容器形态无关；C 为回退参考）

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
6. **方案 E（首发形态）下的差异**：TCC 归 helper bundle（`com.nuwax-ai.*-cua-helper`），弹窗署名=helper 名；授权/回收/重授权后**仅需 `open` 重拉 helper，主客户端零重启**——这是 E 相对 C 的核心体验差（C 需整机重启应用，见 §5.1 第 4 条）；探测需面向 helper 身份（§3.6 工作清单第 5 项）。spike 实证见附录 D。

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

1. **helper 二进制=源码自建（2026-09-17 用户拍板，替代「wheel 提取/release 产物」）**：CI 从锁定的 cua 源码 tag `cargo build --release -p cua-driver`（仓内先例：agent-kit 即 CI 源码构建装入）——供应链自控、版本自锁、必要时可改（如 bundle 路径判定适配我们自己的 .app 名）；本地 dev 用 `NUWAX_CUA_SOURCE_DIR` 指本地检出（同 `NUWAXCODE_DIST_DIR` 模式）。组装链照抄 nuwaxcode 全链（`prepare-nuwaxcode.js` → `binaryLocator` getter → OSS zip 兜底 → `dependencyChecker` 清单），但产物从「裸二进制目录」升级为**完整 helper .app**（§3.6 链路）；extraResources 加 `resources/cua-helper/` 一条。
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
| 5 | 可执行文件自备 | wheel 提取/源码构建 | **已定源码自建**（09-17 用户拍板）：锁 tag cargo 构建，供应链自控；本地 dev 用 NUWAX_CUA_SOURCE_DIR |
| 11 | （E 增）我们的 bundle + open 拉起的 TCC 归属机制未实证 | E 形态根基 | **✅ 附录 D 已实证**（隔离/授权/动作/重启恢复全过）；剩最终形态组合复验转 P1 首项 |
| 12 | （E 增）主 app 更新时 helper 在跑 | 安装器覆盖稳定路径副本冲突 | 更新流程先经 shutdown 协议停 helper / 等看门狗自退；spike 外 P1 设计 |
| 13 | （E 增）helper 崩溃 | 会话中断 | 健康巡检 + 重启上限 + 代际换新端点（抄 windowsMcp manager 模式） |
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
| P1 本机 MVP（**方案 E**） | 机制 spike（附录 D）→ prepare 源码构建 + helper .app 组装（§八/§3.6 项 1）→ **配置开关 computerUseEnabled + 首次授权引导三步卡片（§3.6 交互骨架，用户 09-17 需求）** → 首用安装器 + LaunchServices 拉起 + 就绪握手（项 3/4）→ TCC 探测/授权页改造（项 5）→ MCP 条目注入 + DriverAuthorizationHost→审批浮层 + cua_step/cua_screenshot subType（与 C 共有部分，锚点见 §4.2）→ 嵌套 bundle 签名+staple+CI（项 2）→ 看门狗/自恢复（项 6）→ win/linux 打包验证 | v1 §1.2 成功标准三平台全过；嵌套 .app 签名公证流水线跑通；授权变更仅重启 helper 实测；开关/引导流程走查通过 | mac 约 8-10 人日（较 C 翻倍，打包签名链路为主）+ win/linux 2-3 人日 |
| P2 体验收紧 | agent cursor 可视化、轨迹回放入会话 UI、能力清单管理 UI、遥测合规、doctor 集成 | 内测可用 + 安全评审 | 不变 |
| P3 云端场景 | lanproxy 隧道 + HTTP MCP + 平台侧 VLM 编排联调 | 端到端演示 + 安全评审 | 不变 |

### 十.1 P1 第一轮实施记录（2026-09-18，提交 5a59f1fb）

P1 主体工程当日一轮落地（mac 代码全量 + win 代码骨架，门禁全绿：商业轨 1383 / 社区轨 1332 / tsc 基线 205 / check:pin / 新增 computerUse.test.ts 9 用例）：

- **MCP 功能闭环**：`setCuaEnabled` 开=拉 daemon+upsert `cua` stdio 条目（command=helper 可执行、args=`mcp --socket <私有端点>`，写 db `mcp_local_config` 并 `syncMcpConfigToProxyAndReload` 即时生效；消费链=unifiedAgent.loadLocalMcpConfig 引擎启动合并、本地优先），关=移除条目+协议停机。**B0 实测**：`mcp --socket` stdio 代理对运行中 daemon 握手通过（0.28.2/protocol 2025-06-18/tools 56 个）——官方多客户端配方坐实。启动期 `ensureCuaOnBoot` 幂等收敛挂 overlay lifecycle start（restartAllServicesNow 后、不阻塞主链）。
- **CI 构建链**：外层仓 `scripts/computer-use/build-helper.sh`（clone trycua/cua@625118a90 → apply 0001-0002 补丁 → cargo build → mac .app/win exe 组装 → Developer ID 预签 + entitlements 免）。预签在进 extraResources **之前**（electron-builder 当数据拷贝；TCC 稳定=同 Team+同 bundle id，after-sign 基座脚本不动）。`release-electron-dev.yml`/`release-electron.yml` 各加 rust-toolchain+构建+extraResources 注入步骤（Linux 腿跳过）。**本地全链验证过**：cargo 1m04s（增量）→ bundle 31M → daemon 拉起 → MCP 握手 56 工具。
- **首用安装流**：`installCuaHelper`（IPC `cua:installHelper`+设置页「安装」行，installable 态显示）——签名/bundle id 双校验（codesign -dv 解析，win 跳过）、`fs.cpSync`+`xattr -cr` 清 quarantine、安装后复验、lsregister -f+mdimport、`.install-lock` 溯源；装完自动 `requestCuaPermissions`（TCC 归属自校验，可安全重复）。
- **生命周期**：停机协议优先（helper `stop --socket` 子命令）→ pkill/PowerShell 兜底；`will-quit` 清理（app 会话制 daemon 生命周期，强杀残留属可接受残余——launchd PPID=1 无内建看门狗，cua 仅有 spawn 附着形态的 `--parent-liveness-stdio`）。
- **Windows 骨架**：`IS_WIN` 分支全就位（exe 直跑 spawn、`\\.\pipe\nuwax-computer-use` 端点、PowerShell 按命令行停机、requestCuaPermissions 返回 unsupportedPlatform）——**真机验证未做（B4 待办）**。
- **探测收紧**：打包版只认 userData 稳定位+Resources；`/Applications` 回退仅 `!app.isPackaged`（dev 态），防同名近似条目误配（附录 D 教训）。
- **顺带三修**：check-base-purity 改 `--porcelain -uall`（overlay 新增目录折叠成 `?? dir/` 与 manifest 文件级精确匹配失配而误报）；locale 错误码键连字符→camelCase（`errors.helperNotInstalled` 等 4 键，存量 2 键同修，i18n 键格式红线）；tokenScopes 测试 electron mock 补 `app.on`。
- **遗留**：设置页四组交互用户目检、win-pc 真机链路（B4）、打包版 TCC 首授权全流程（须打包版才可验，Developer ID 签名身份在 CI）、合并 release 线时的 preload/electron.d.ts 整文件覆写再生成（基座 PR#16/#17 之后过期，直接合会回退 v1.0.15 的 refreshLoopbackGateway 修复）。

### 十.2 B4 win-pc 真机验证记录（2026-09-18，核心链路全绿）

win-pc（192.168.32.53，VS2022 BuildTools 14.44.35207 + Rust 1.98.1）源码构建+运行时验证：

- **构建**：clone trycua/cua@625118a90 → apply 0001-0002 补丁 → `cargo build --release -p cua-driver` → 组装 `NuwaxComputerUse.exe`（增量 3m07s）。**前置坑=VS Spectre 组件**：`regorus`（cua-driver-core 策略引擎）硬依赖 `msvc_spectre_libs`（找 `MSVC\<ver>\lib\spectre\x64`，注意是 lib\spectre\arch 不是 lib\arch\spectre）。正确组件 ID=**`Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64.Spectre`**（版本居中+小写 x86.x64 尾缀；猜 ID 会「Cannot find package in product graph」**且静默退出码 0**，用安装器目录 catalog.json 挖真 ID）。安装命令：`Installer\setup.exe modify --add <ID> --installPath "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools" --quiet`（installPath 含空格须独立数组元素+内嵌引号，整串传参会截断成 C:\Program）。GH 托管 windows runner 镜像自带 Spectre 组件（Windows2025-Readme 实查），CI 侧大概率无此坑（下个 tag 实证）。
- **运行时**：①**serve 拒绝 Session 0**（SSH 服务会话直接 `Error: requires an interactive Windows user session`）——须 `schtasks /create /it + /run` 派到用户交互会话（与 QA 安装包同坑同方）；②命名管道 `\\.\pipe\nuwax-computer-use` 就绪，**`mcp --socket` stdio 握手通过：driver 0.28.2 / protocol 2025-06-18 / 57 工具**（比 mac 56 多 1 个 win 专属）；③协议停机 `stop --socket` 干净。**测试伪影警示**：PowerShell 管道给原进程喂 CRLF 行尾会把 initialize 行打残（服务端按 Legacy era 拒后续请求 -32602「Missing required per-request MCP metadata」）——真实 MCP 客户端发 LF 无此问题；验证脚本须用 LF 载荷文件+`cmd type` 管道。
- **B4 剩余**：打包版全链（NSIS 内嵌 exe→客户端集成→会话侧用工具）随 B6 合并后的安装包验证。

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
- **2026-09-17 下午增量：形态拍板升级为方案 E（独立 helper App，单包集成，源码自建二进制）**——§0.7 / §3.6 / §五.6 / §八.1 / 风险 #11-13 / §十 P1 改写 / 附录 D spike。

## 附录 D：方案 E 机制 spike 记录（2026-09-17 实测，全记录）

**方法**：本机源码构建（`~/Documents/git-workspace/cua` @625118a90 = 0.28.2，`cargo build --release -p cua-driver` 约 4 分钟）→ 组装 mini helper .app（自写 Info.plist：LSUIElement + 自定 bundle id + CFBundleExecutable=cua-driver；ad-hoc 签名）→ `open -n` 拉起 `serve --socket /tmp/cua-spike/cua.sock` → node 经 `CuaDriver.connect(socketPath)` 验证。脚本与截图归档 `docs/computer-use-poc/spike-e/`。

**已实证结论（按证据强度）**：
1. ✅ **源码构建链路**：cargo 产物 `cua-driver 0.28.2` 与 npm SDK 四契约精确匹配（metadata handshake 一次通过，embedded:false = 独立 daemon 身份）；
2. ✅ **TCC 归属隔离（E 的核心机制）**：宿主进程链（ZCode）明明持有 AX+SR 双授权，helper 报 `permissions_pending`（错误码 75）——权限归属 helper 自身 bundle，不继承宿主链；用户授权 helper 后 `check_permissions` 双 granted，署名/条目均为 helper（「Nuwax Computer Use」+ 客户端同款黑标 icon，与 ZCode/Codex Computer Use 同款形态，同列表可见）；
3. ✅ **经私有 socket 全功能**：list_windows/元素树（170 元素）/截图落盘/`click`（element_token + Background 后台投递）——含真实效果验证（点「清除」后截图像素哈希变化、读屏确认 42→0；6×乘7=等于 五连击 = 42）；
4. ✅ **helper 重启即恢复**：多轮 kill→`open` 重拉后授权与功能即时恢复（含系统「退出并重新打开」路径），主进程/宿主客户端全程零感知、零重启；
5. ✅ **单进程形态**：helper 路径含 `/CuaDriver.app/Contents/MacOS/` 子串（如 `/Applications/Nuwax Computer Use/CuaDriver.app`）时无 disclaim re-exec，daemon 即 .app 本体（PPID=1 单进程），零 env/旗标——产品可用的两种实现：**目录命名技巧（零源码改动）或源码补丁 `bundle.rs:100-113`（把 bundle 判定参数化，正解）**；
6. ✅ **版本漂移实证**：官方 CuaDriver.app（v0.21.0）对 0.28.2 SDK 直接 `Protocol` 拒连；SDK 降到 0.21.0 后配对成功——「四契约精确锁 + 必须自建自带二进制」两个 P1 决策拿到活体证据。

**实现级坑（P1 必读）**：
- **bundle 白名单坑**：非 `CuaDriver.app` 命名的 bundle → 独立版启动时执行「责任 disclaim 重exec」（进程树双进程），干活子进程丢 .app 的 TCC 身份 → AX 读可用但**动作静默无效**（click 返回 ok、effect=Unverifiable，UI 不变）。临时解法 `open --env CUA_DRIVER_RS_RESPONSIBILITY_DISCLAIMED=1`（跳过 re-exec，但该 env 会让权限门按裸二进制自检产生误报，需配合 `--no-permissions-gate`）——**产品正解=源码补丁**；
- **ad-hoc cdhash 坑**：改 bundle 内容（哪怕只加图标）/挪动路径 → TCC 条目失效，且开关 off→on 不救、必须删条目重加。**产品用 Developer ID 签名后按「团队+bundle id」锚定，图标/版本/路径变化均不影响授权**（spike 的 ad-hoc 专属坑）；
- **TCC 手动条目 UX 差**：macOS 无 API 写 TCC，首次授权只能引导用户去系统设置（＋添加）。产品 launcher 必须做 `AXIsProcessTrustedWithOptions(prompt)` 主动弹窗 + ScreenCaptureKit direct consent（官方 grant 流程同款），把「＋添加」变成「点弹窗按钮」；
- **effect=Unverifiable 不可信**：动作返回 ok/effect=2 不代表 UI 真变了，终验一律截图（与 §6 反例互证）。

**✅正式签名终态（2026-09-17 深夜二轮，全链路产品级）**：发现钥匙串有真 Developer ID 证书（Dong Luo, 89GQ2RJVW7）→ 以其签名 helper（`codesign --timestamp=none` 本地省时间戳）→ **ad-hoc 全部怪象消失**：AX 走正规弹窗流（权限宿主触发「Nuwax Computer Use 想要控制…」→ 打开系统设置 → 条目自动正确锚定+显示黑标图标）、SR 开关直接生效（需 daemon 重启后评估）。终态：单进程/AX+SR 双 granted/元素树 146/Background 五连击 42。**结论固化：ad-hoc 签名的 TCC 怪象（弹窗不弹、条目不锚定、改包即废、显示名回退）全部源于无稳定 designated requirement——正式 Developer ID 签名一次性解决，P1 按 CI 签名产线走即可**。附：本机调试全程经 Microsoft Remote Desktop 会话（截图/点击经 RDP 转发有效，坐标 zoom 子图法可靠）；自签证书方案（openssl+security 导入）未走通（PKCS12 兼容问题），被钥匙串现成 Developer ID 取代。

**终态验证（源码补丁版，2026-09-17 晚）**：cua 仓本地分支 `nuwax-helper-bundle` 两个补丁（`0001` bundle 白名单参数化：Nuwax/NuwaClaw Computer Use.app + `CUA_DRIVER_BUNDLE_DIR_NAMES` env；`0002` `app_bundle_path()` 动态取运行中 bundle——权限宿主/relaunch 不再指向官方 app）→ 重建装配 `/Applications/Nuwax Computer Use.app`（顶层直命名+客户端图标+LSUIElement）。终态全绿：**单进程（PPID=1）、零 env/零旗标、权限门双 granted（helper 自身 TCC 身份）、元素树 146、截图、Background 五连击真实生效（clear→6×乘7=等于 → 42，截图内容寻址比对）**。patch 文件归档 `docs/computer-use-poc/0001-0002-cua-nuwax-helper-bundle.patch`（CI 构建时对锁版 tag 应用）。**授权流新发现（P1 直接采用）**：权限宿主机制可直接触发 TCC 弹窗——`open -n -g <helper.app> --args __permissions-host-request --result-file "$TMPDIR/cua-driver-permissions-*.json" --probe-direct-capture`（结果文件名必须 `cua-driver-permissions-*.json` 且在 `$TMPDIR`，否则静默退出）；AX 走系统弹窗引导、SR 经 SCK direct consent 即时生效。另实证：**ad-hoc 手动添加的 app 在 TCC 列表按可执行文件名显示**（我们的 helper 显示为「CuaDriver.app」——显示名陷阱，正式 Developer ID 签名后按 bundle 名显示）。

### 十.3 Linux 支持加回（2026-09-18 用户改口径：三平台全做）

此前「不做 Linux」口径作废。实现：`computerUse.ts` 平台三分（linux=裸二进制 `NuwaxComputerUse`，UDS 端点与 mac 同、直跑 spawn、chmod 755、无授权流）；`build-helper.sh` 增 linux 分支（x86_64/aarch64-unknown-linux-gnu，CI 腿 apt 装 libwayland-dev/libxkbcommon-dev——wayland-client 经 pkg-config 链接，x11rb 纯 Rust 零 libxcb）；双 workflow 五平台全矩阵解除 Linux 跳过。权限口径见 `docs/20260918-nuwax-permissions-matrix.md`（X11 零授权；Wayland 截屏走 portal、输入依赖 compositor/wlr 协议）。⚠️Linux 真机链路未验证（CI 构建实证随下个 prerelease）。
