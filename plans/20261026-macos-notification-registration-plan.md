# macOS IM 通知注册修复

目标：用户点击通知权限“添加”时，以 Nuwax 主进程身份请求 macOS 通知授权，再进入系统设置；检测权限不触发请求。保持 IM 私聊/群聊现有后台接收、免打扰和账号隔离规则。

1. 核对 Mac dbg 3.0.23 安装包、通知权限入口、IM 连接日志与系统通知状态。
2. 在现有原生通知模块增加显式授权请求，共用系统设置入口调用；合并并发请求、处理拒绝/失败。
3. 将 macOS IM 投递统一到现代 UNUserNotificationCenter，保持其他平台现有 Electron 后端；保留点击唤回、账号代次和有界监听清理。原生 delegate 只处理本模块通知，并转发其他通知给已有 delegate。
4. 补充行为回归并验证修复前失败、修复后通过；在隔离副本运行商业质量门，编译 arm64/x64 原生模块。
5. 保存真机观察、测试结果与剩余验收边界。需要用户决定的系统授权保留人工选择，不变更发布指针。

## 结果

代码修复已完成，位于 `codex/macos-notification-registration`（基线 `c6de2d70`），按回归测试、实现分开提交，尚未出包或发布。所有产品修改通过 overlay 托管，未修改安装的 `/Applications/Nuwax.app`，未变更版本、tag、Release 或更新指针。

确认两个根因：

1. “添加”只打开系统设置，没有请求授权；macOS 通知设置没有手动添加应用入口。已改为用户主动操作时先请求 alert/sound/badge，再进入设置；普通状态检查保持只读。
2. 已安装的 Electron 40.8.2 通过 NSUserNotificationCenter 投递，但权限检测已经使用 UNUserNotificationCenter。正常主进程 PID 4645 于 14:17:26 建立现代连接，之后旧接口被 usernoted 拒绝（`You can't mix modern clients with legacy clients`）。已将 macOS IM 投递、回调及清理统一到现代 API，其他平台保持 Electron 后端。

保留前台抑制、免打扰、账号代次检查、最多 20 个活跃监听与点击唤回规则；补充异步投递完成前关闭的处理，防止清理后迟到通知。

## 验证证据

证据目录：`/Users/apple/Documents/Codex/2026-10-26/macos-notifications/`。

| 项目 | 结果 | 证据文件 |
| --- | --- | --- |
| 修复前回归 | 旧 macOS 生产后端无法调用现代投递，新增回归失败 | `legacy-backend-regression.log` |
| 商业质量门，最终代码 | 283 个测试文件通过、1 跳过；3,495 项通过、18 跳过 | `commercial-tests-final.log` |
| 社区质量门，隔离副本 | 138 个测试文件通过、1 跳过；1,682 项通过、18 跳过；已恢复 overlay | `community-tests.log` |
| 原生与主进程构建 | arm64/x64 universal 模块与生产 esbuild 通过 | `main-build-final.log` |
| 基座与 overlay | `check:pin` 通过，427 个脏文件均属 overlay；`overlay:check` 零差异；`git diff --check` 通过 | 本次命令结果 |
| 真机旧/新 API 冲突 | 正常客户端现代连接在先，旧投递报混用错误 | `system-notification-api-conflict.log` |
| 真机通知显示 | 生产 presentation + adapter + 原生模块在签名 Nuwax 身份下运行，本机通知出现在通知中心；应用页显示消息通知已授权 | `driver-18.png`、`presentation_probe.js`、`presentation.cjs` |
| 最终原生模块立即撤销 | add 后立即 release/close，等待后 delivered=0、pending=0、events=[] | `native-cancellation.log`、`cancellation_probe.js` |
| 测试通知清理 | 删除 1 条残留测试通知，复查剩余 0 条 | `native-cleanup.log` |

真机环境为 macOS 26.5.1（25F80），应用 UI 为 3.0.23-beta.4，Info.plist 为 3.0.23；签名验签通过。IM 已连接，未读角标有变化，应用内通知开关为 true。用户明确授权后，Nuwax 出现在系统通知列表并开启通知，原生 API 返回 authorizationStatus=2。原有授权请求在 `ELECTRON_RUN_AS_NODE` 诊断模式下首次等待超时，因此这不能作为正常 GUI 首次弹框通过的证据。

## 验收边界与收尾

- 生产代码临时夹具使用本机合成消息，窗口 restore/show/focus 为计数桩；未向真实 IM 会话发送消息，未宣称服务器入站到安装包展示链路通过。
- 实际点击通知的真机回调尚未补验：原远程 GUI 会话续接被自动审批策略拒绝，当前禁止弹出审批。已有行为测试覆盖点击回调和窗口唤回、失效账号与清理后的回调抑制。
- 修复后签名安装包仍需验证首次授权弹框、后台收到真实私聊/群聊、点击唤回；打包验收须走现有版本的 package-validation，当前本问题启动次数为 0。
- 诊断进程已退出，本地 GUI 桥接已关闭，临时通知与本次 `/tmp` 文件已清理；共享 CU helper 未停止或重配，原安装包仍运行且签名复核通过。mac-dbg GUI 已交回协调任务。系统通知授权按用户选择保持开启。

## Windows 代码核对（2026-10-26）

结论：没有发现与本次 macOS 相同的根因。该结论来自当前代码与锁定依赖，不代表 Windows 真机投递验收通过。

| 检查点 | 代码证据与判断 |
| --- | --- |
| 通知“添加” | `appHandlers.ts` 的 permissions:check 在非 darwin 返回空列表；`permissionOnboarding.ts` 的快照/设置操作与 `macNotificationPermission.ts` 均限制 darwin。Windows 不走本次缺失授权请求的入口。 |
| 投递 API | `imNativePresentation.ts` 仅 darwin 选择现代 macOS 模块，Windows 使用 Electron Notification。Electron 40.8.2 的 `windows_toast_notification.cc` 使用 Windows.UI.Notifications 并按 AUMID 创建 ToastNotifier，不涉及 Apple 新旧 API 混用。 |
| 应用身份与安装注册 | `main.ts` 在 ready 前设置 `com.nuwax-ai.nuwax`；`client.config.mjs`、`scripts/client/pack.mjs`、Beta/Stable 工作流打包 appId 相同。锁定 app-builder-lib 25.1.8 的 NSIS 模板用 APP_ID 设置开始菜单/桌面快捷方式 AUMI；MSI 用 appInfo.id 写 System.AppUserModel.ID。快捷方式修复脚本保存并复核这个属性。未发现当前配置身份不一致。 |
| 后台消息与点击 | 共用 IM 接收器保留应用内开关、前台/锁屏/睡眠、DND、账号代次门禁。已有 Windows timedOut 用例保留通知中心点击监听，用户主动关闭才清理。 |
| 诊断缺口 | 没有 Windows 系统通知开关状态读取或系统通知设置引导；Notification.isSupported 仅检测能力，不能代表用户允许展示。failed 监听仅写固定日志，丢弃 Electron 传回的错误原因。系统禁用、安装注册损坏等情况下仍可能出现相似症状，目前不能仅靠应用内开关或这条日志区分。此处记录为排障缺口，本次不据此宣称 Windows 已存在投递故障。 |

补充复核：5 个通知/权限测试文件共 69 项通过（含 Windows 后端选择与 timedOut 回调）；本地打包与系统名称配置测试通过。证据分别为 `windows-code-review-tests.log` 与 `windows-packaging-review-tests.log`。这些是代码行为与配置检查，没有运行 Windows 真机，也没有触发新打包。

官方实现依据：[Electron 40.8.2 Windows Toast](https://github.com/electron/electron/blob/v40.8.2/shell/browser/notifications/win/windows_toast_notification.cc)、[Presenter 与 activator 注册](https://github.com/electron/electron/blob/v40.8.2/shell/browser/notifications/win/notification_presenter_win.cc)。
