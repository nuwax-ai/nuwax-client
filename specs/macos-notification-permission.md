# 规格：macOS 消息通知授权与投递

- 对应 intent：plans/20261008-macos-notification-permission-intent.md
- 范围依据：当前 macOS PermissionsPage 和 permissions:check/openSettings 契约。

## 设计

使用主进程内 Node-API 原生模块调用 Apple `UNUserNotificationCenter.getNotificationSettingsWithCompletionHandler`，保证身份与实际发通知的 Electron 进程相同。后台线程异步查询，超时 1.5 秒，不读系统私有 plist/数据库。页面加载、刷新和返回检测均保持只读，不安装通知 delegate。

复用 permissions:check 的列表结构，增补 key=notifications。authorizationStatus 为 notDetermined/denied 时显示「未开启」，authorized/provisional 时显示「已开启」，异常、未识别状态或原生模块缺失时显示「未知」。开启仅指系统通知授权，不保证专注模式、横幅样式或应用内 IM 开关允许展示。

用户显式点击通知“添加 / 打开系统设置”时，共用 `openMacPrivacySettings("notifications")` 先在宿主身份下调用 `requestAuthorization`，申请 alert/sound/badge，再打开系统通知面板。macOS 通知面板没有手工添加应用的入口，只打开面板无法完成首次注册。请求等待最多 60 秒，并发点击共用一次请求；拒绝、超时或原生模块不可用时仍打开设置供用户处理，不把打开设置成功当作授权成功。授权选择由用户完成，已拒绝时不重复弹框。

permissions:openSettings 与权限引导复用该入口。打开面板失败兜底打开 System Settings.app，仍失败返回既有 success=false。页面检查这个结果，回到窗口时复查，并保留手动刷新和既有设置后轮询。

macOS IM 投递通过同一原生模块的 `UNUserNotificationCenter.addNotificationRequest`，不调用 Electron 40 的旧式 `NSUserNotificationCenter`。在 macOS 26.5.1 真机，同一应用身份混用现代查询和旧式投递会被 usernoted 拒绝。Windows/Linux 继续使用 Electron Notification。

`MacNativeNotification` 将原生回调适配为现有 click/close/failed 事件。原生 delegate 只处理 `nuwax.im.` 前缀的通知，对其他通知转发原有现代 delegate；不改动 Electron 的旧式 delegate。展示与声音尊重现有应用内免打扰、业务窗口前台抑制和系统设置，收到消息不会隐式申请授权。点击仍走账号代次检查，再恢复、显示并聚焦主窗口。

保持最多 20 个活跃通知监听；超出时释放本地回调并保留系统通知历史。账号清理或主动关闭则撤销投递并删除对应系统通知。若异步添加尚未完成，完成后再次撤销，防止清理后迟到。线程安全回调在终结、释放或 Node 环境退出时释放；已排队的旧回调不会唤回其他账号。

编译使用官方 node-api-headers（商业根依赖），macOS main 构建自动产出 arm64+x64 universal `.node` 到 dist/main；打包时显式 asarUnpack，签名由既有 electron-builder 路径执行。非 macOS 构建不编译该模块。

## 验证

- 行为回归：授权状态映射、失败/超时/并发、非 macOS、设置成功/失败与未知 key；生产后端选择、原生事件适配、监听清理、前台抑制、免打扰与账号隔离。
- 两架构原生编译、主进程与 renderer 构建、商业测试；社区在隔离副本运行。
- 独立 Electron 进程只读调用实际 API，验证不使用 osascript/helper 的身份。
- Mac dbg 已在用户明确授权后开启系统通知，并在当前签名 Nuwax 身份下运行临时生产代码验证显示。首次授权弹框、真实 IM 接收与点击唤回仍需修复后的签名安装包验收；自动化单元测试不改用户权限。具体证据与边界见 [修复记录](../plans/20261026-macos-notification-registration-plan.md)。

参考：[Apple 查询 API](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/getnotificationsettings(completionhandler:))、[Apple 授权流程](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications)、[Electron 40.8.2 macOS 投递实现](https://github.com/electron/electron/blob/v40.8.2/shell/browser/notifications/mac/cocoa_notification.mm)、[官方 Node-API headers](https://github.com/nodejs/node-api-headers)。
