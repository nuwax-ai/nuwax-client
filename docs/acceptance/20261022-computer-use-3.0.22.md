# Computer Use · 3.0.22 整合验收候选 r4

运行时代码固定于 `9528d28d0c8fd30439da7c02503a01172da7ac87`，分支 `feat/computer-use-3.0.22-integration`。原生驱动已从 0.28.2 更新到官方 0.38.0，固定上游 `85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19`，不跟随 main。商业补丁、权限主体和产品边界保留，迁移细节见 [上游更新记录](20261022-cua-driver-0.38-upgrade.md)。

## 来源完整性与保全

盘点 53 个来源 worktree，逐文件核对已提交历史和未提交实现，另建整合 worktree。来源代码、暂存区和用户 WIP 未覆盖。两条已结束 Claude 会话 `b373cfa2-a92a-4b2a-91cd-6b85633bb222`、`e7157a29-0021-42e7-b9eb-535d9fe3c8e1` 的实现保全于快照 `286916f31664dd8d68c89cb4584c4c964af59f7b`、分支 `chore/cua-source-snapshot-20261022` 和仓外 bundle。原监控定时已删除。

10 月 23 日收尾复查 53 个工作区 HEAD 均未再变；138 个相关来源文件与保全快照逐字节核对，仅有已知历史文档变化，无新增 CUA 代码遗漏。证据 `final-worktree-audit-20261023.json`。

逐来源处置见 [清单](20261022-computer-use-3.0.22-sources.json)。最终 r4 审计再次核对来源字节，CUA 源码无后续遗漏；只有多窗口历史验收文档新增，原样保留，不冒充当前验收。`6d0082c7` 已是集成基线祖先；原发布工作区后来新增的 `a092b5b6` 只隐藏 SessionsPage 按钮，在本次范围外，仍保留原处。

| 来源 | 内容及本候选落点 | 结论 |
| --- | --- | --- |
| `8e19234c` | `features/computer-use/{computerUse,sessionAuthority,taskController}`：会话隔离、预算、取消撤权、诊断 | 纳入，保留 3.0 边界 |
| `b865254c`、`afb2ae13`、`3e8927c7` | `cuaOutcome`、`cuaGuidance`、`mcpGateway`：结果分类、按目标观察额度、无进展与拒绝计数 | 纳入 |
| `4b391e7a`、`28556807`、`220b0616`、`eb05b6a5` | 限定窗口内的浏览器工具、失败呈现、唯一额度归属、scope/diagnostics 设置 | 纳入 |
| `2dbc6221` / 3.0 等价修复 | `vlmDiagnostics`、`ComputerUseSettings`：真实图像测试、推理响应兼容及可读错误 | 保留并迁移 |
| `69bcd5c6`、`c57e43b5` / 3.0 等价修复 | helper 身份诊断、签名主体及商业图标 | 保留 |
| `62fa3c71`、Claude 权限引导 WIP | `permissionOnboarding`、`permissionDragChip`、权限页、独立 preload、四语言 | 纳入，并补齐 helper 权限适配器接线 |
| `ca89aa34` | `features/_kit`、`featureHost`、ACP 会话参与者 | 仅纳入 Computer Use 所需通用端口；移除旧 CUA 注册入口 |
| `61703d91`、`f74ed5cb`、最终 WIP 快照 | `taskRegistry`、窗口绑定/撤权/drain、`previewController`、画中画、badge、原生补丁 | 纳入最终版本 |
| `93c6f078`、Claude Windows 基准修复 | 接管验收标准、Windows 后台锚窗、基准脚本和历史证据 | 纳入；不将未完成基准算通过 |
| `b744305b`、3.0 退出/更新修复 | 服务清理降级、有限等待、退出顺序、原生终止兜底 | 保留并修复失效路径 |

明确排除 nuwax-harness、pi-agent 产品/引擎、Nuwa Browser 新整合；相关源码保留在各自来源。基准目录的 `bench/harness.ts` 是测试框架，不是 nuwax-harness 产品。本机文件直访延续 3.0 的强制关闭；未因通用特性迁移意外启用。NW-151 鉴权、自动端口、老 Windows 终端、当前用户安装和 UAC 修复、原有更新提示继续沿用 3.0.22。

## 默认关闭、窗口归属、退出与更新

- 缺失开关只按 `computerUseEnabled === true` 启用；默认不安装、不启动 helper、不注入 CUA MCP。已显式启用的历史偏好保留；两台验收机收尾明确关闭。
- 普通模式使用客户端内现有控制条；多窗口预览是主窗口 `contentView` 内的 `WebContentsView`，默认收起。主窗口隐藏、关闭到托盘、最小化时同步隐藏，显示/恢复时同步显示；真正销毁时销毁拥有的视图，退出后迟到回调不能重建。没有独立桌面黑色控制窗，也不注册外部目标 badge。来源 badge 文件保留，这项呈现被用户新要求取代。
- 任务绑定、能力、epoch、观察、预算、取消撤权与 drain 仍由宿主管理。预览独立于模型观察，不入观察额度、模型日志或磁盘。
- 可选特性停止和原生协议停止各有 1500ms 上限；撤权先行，退出共享幂等清理 promise。兜底只按产品可执行路径与准确 serve/socket 参数终止，不按宽泛名称杀进程。保留安装前 10 秒清理上限，删除 macOS 提前 5 秒退出竞态。
- 真机故障注入发现的旧 Unix socket 残留已修复：仅回收当前用户私有目录、私有权限、拒绝连接且探测前后 inode 一致的 socket；活动端点、普通文件、符号链接和替换竞态均保留。
- 连续宿主读取使用新随机 host session，经 endpoint proof 和 session_begin 确认，EOF 清理自己的资源，避免过期隐式会话造成 session_ended。
- r4 原生 hide 事件先于 isVisible 更新的真实时序已有失败回归和修复；hide/minimize 直接设置拥有者隐藏状态，show/restore 延迟布局同步。

## 自动化与构建

证据目录：`/Users/apple/Documents/Codex/2026-10-22/computer-use-consolidation-01a162b4`。

| 检查 | 最终结果 / 证据 |
| --- | --- |
| 商业完整测试 | 3302 通过、18 跳过；263 文件通过、1 跳过；`commercial-r4-verified.log` |
| 社区隔离测试 | 1682 通过、18 跳过；独立副本，不清除整合 overlay；`community-tests.log` |
| 外层脚本 | 375 通过；含上游共享输入缓存与 Windows MSVC 链接器优先级回归；`outer-scripts-upstream-0.38.0-final.log` |
| macOS 原生测试 | driver/contract/core/macOS 的 lib/bin 2145 通过、8 跳过；`upstream-0.38.0-host-tests.log` |
| 原生协议 | 新 helper endpoint proof、鉴权拒绝、MCP、窗口隔离与撤权通过；`native-0.38.0-*.log`；Windows 交互桌面 session 2 检查通过，SSH session 0 的 GUI 失败不计通过 |
| 构建与包 | macOS release 与 Windows 真机 MSVC release、生产 main/renderer、NSIS/MSI 构建通过；最终 asar 与入口/资源摘要核对一致 |
| 静态 / 边界 | 修改文件 ESLint 无错误；主进程 TypeScript 仍有 8 个基线错误，不宣称全仓静态检查全绿；pin、overlay、导入与数据目录边界检查通过 |

原 Electron fixture 覆盖 preload/IPC、陌生 sender、任务目标、预览迟到帧与清理。新增主窗口内视图另有 6 项生命周期回归，以及下述双平台真实窗口检查，不将旧 fixture 冒充新版独立端到端证据。

## 真机安装与行为

仅使用指定 mac-dbg 和 win-dbg；未在当前工作电脑安装或运行验收包。两台均保留旧应用和数据库，模型/账号密钥不回传。真实任务沿正常客户端聊天，使用设备现有 GLM-5.3-Flash；没有新增模型配置要求。

| 项目 | mac-dbg | win-dbg |
| --- | --- | --- |
| 设备 | macOS 26.5.1 / arm64，louis，电脑 4418 | Windows 11 Pro 26200 / x64，soddygo，交互 session 2，电脑 soddy 4499 |
| 真实安装 | 原 3.0.21 已备份；最终 r4 已装 `/Applications/Nuwax.app` | 原 ASAR 3.0.22-beta.2 已备份；NSIS 原路径升级为 3.0.22，安装器 exit 0 |
| 驱动 | 公司同 Team helper，0.38.0；现有辅助功能/录屏授权有效 | MSVC helper 0.38.0；daemon/策略/gateway 及交互原生边界自检通过 |
| Agent 操作 | 聊天 1742493；任务 df9e2b40：TextEdit 观察 → set_value → 重新观察，正文完全等于 `Computer Use 3.0.22 mac-dbg 0.38.0 PASS` | 聊天 1742520；任务 1eb19caa：Notepad UIA 观察 → set_value → diff 复核，正文完全等于 `Computer Use 3.0.22 win-dbg 0.38.0 PASS` |
| 操作判定 | 3 步，0 拒绝/不确定/越权；后台 value_readback | 3 步，0 拒绝/不确定/越权；写入当下 effect=unverifiable，后续真实观察确认 2 行预期变化，不能只据写入返回判断成功 |
| 提示归属 | 真 hide/close-to-tray/show/minimize/restore 均同步，只有主窗口内视图 | 同样全部通过；只有 1 个 BrowserWindow，子视图在主窗口边界内 |
| 接管/停止 | 实际预览按钮，前台切到验收 TextEdit；userTakingControl → userStopped | 实际预览按钮，交互桌面 GetForegroundWindow=60293810，与验收 Notepad 相同；userTakingControl → userStopped |
| 活动任务退出 | helper SIGSTOP，暂停任务仍存在时正常退出：主进程 2.262s、helper 1.617s、全部 26 个相关进程 7.057s 内结束；重启旧 socket 安全恢复 | 存在 paused 任务 (userTakingControl) 与 2 个 helper 进程时退出更新：从监测启动计（含下载/交接），旧主进程及全部 28 个相关进程 29.774s 内退出、helper 20.324s~21.153s，无残留；这不是纯退出耗时。补做关闭状态正常 app.quit：监测后 3.962s 主进程退出、4.100s 全部 10 个相关进程结束（含派发延迟） |
| 更新交接 | loopback 源真实下载、签名校验、Squirrel 替换与重启；旧主进程/helper/12 个相关进程全部结束，最终 ASAR 一致；随后普通退出 0.329s | loopback 源真实下载安装，NSIS 自动交接与重启（过程中显示正在安装页面）；全部 28 个旧进程退出，4 分钟监测超时后，另行 WMI 观察到新进程 PID 25668 在 session 2 以 --updated 启动；原监测记录 newMainPid=null 保留，后续启动另有补充证据。安装完成后，ASAR SHA256 (a3b9babb...) 与构建产物完全一致 |
| 默认 OFF 收尾 | 移除开关真实重启：enabled/running/mcpInjected=false，helper=0，子视图=0；最终显式关闭，原 Beta 订阅已恢复 | 移除开关真实重启：enabled/running/mcpInjected=false，helper=0，子视图=0；设置页 UI 明确显示“● 已关闭”，截图 win-r4-settings-default-off.png，原 Beta 订阅及缺失的多窗口/scope 偏好已恢复，最终显式关闭；两个单次验收派发任务均已注销 |

10 月 23 日收尾再次真实移除 Windows 开关、重启最终安装包：缺少开关且 enabled/running/mcpInjected=false，helper=0、子视图=0。原订阅 beta 已恢复，账户/模型设置未改；最终持久化 false 并正常退出。此时商业登录门禁拒绝重新启用 CUA，未绕过登录；启用状态与活动任务证据来自前一晚真实会话。证据为 `final-default-off-{preflight,proof}-r4.json`、`final-preferences-r4.json`、`normal-quit-r4.json`。

Windows 首轮模型声称 CUA 未加载；实际 ACP 配置、relay 进程和工具发现均存在。让模型实际调用 `mcp__cua__get_window_state` 后正常触发选窗并完成任务，没有改模型配置或绕过工具。相关 nuwax-openui/ask-question 的连接失败仍是独立问题，不将其隐藏，也不阻断本次 CUA 三步验收。

两台更新交接测试仅把 updater.currentVersion 在内存模拟为 3.0.21，实际运行应用均为 3.0.22。用于证明真实下载、退出清理、安装器替换和重启，不冒充真实语义旧版本自动升级。Windows beta.2 → 3.0.22 则另有实际 NSIS 安装升级证据。

## 包、截图与验收边界

最新包和源码/依赖 pin 见 [包摘要](20261022-computer-use-3.0.22-package.json)、证据目录 `acceptance-package.json` 与 `SHA256SUMS`；r1/r2/r3 为历史候选，不能用于最终验收。

- Mac：`Nuwax-3.0.22-Computer-Use-acceptance-r4-mac-arm64.zip`，704205874 bytes，SHA256 `66e53176b6106bf6e7a8232299085fb94e621cc4f15853e402200f939a336616`；公司 Developer ID 签名，未公证。
- Windows：`Nuwax-3.0.22-Computer-Use-acceptance-r4-win-x64.exe`，950255569 bytes，SHA256 `d712be18e2f57e96128554876662bd339ad69cc70841be525478272e6cf151ef`；本地 unsigned NSIS 验收包。MSI 构建完成但未安装验收。
- 关键截图在 `mac-dbg-evidence/mac-r4-{about,settings-default-off,settings-enabled,contained-in-client,contained-preview,agent-result,textedit-result}.*` 和 `win-dbg-evidence/win-r4-{about,settings-default-off,settings-enabled,contained-in-client,contained-preview,agent-result,update-installer}.*`。均为指定真机真实页面，Windows initial 截图选择电脑前的旧状态不作为验收图。
- 尚未完成物理权限卡片拖放、多屏/DPI 与长时间稳定性；不声称全应用兼容、Windows 正式签名或全平台发布就绪。未创建 release/tag，未改线上更新指针。

## 整批质量自查

按 pre-commit-quality-review 三问与 REVIEW.md 五遍检查全部集成差异（writer 自查，不自批 PR）：功能状态/预算/撤权/清理内聚于 CUA；renderer/preload 依赖共享契约，特性通过通用宿主端口，ACP 只依赖通用会话参与者；唯一原生补丁、固定版本、严格工具白名单与独立预览可维护。旧 CUA 注册入口清除，local-files lockedOff、登录及更新边界保留。真实发现的退出悬挂、旧 socket、host session 和 hide 时序均先有失败证据，再修复并回归。
