# 规格：macOS 消息通知检测

- 对应 intent：plans/20261008-macos-notification-permission-intent.md
- 范围依据：当前 macOS PermissionsPage 和 permissions:check/openSettings 契约。

## 设计

使用主进程内 Node-API 原生模块调用 Apple `UNUserNotificationCenter.getNotificationSettingsWithCompletionHandler`，保证身份与实际发通知的 Electron 进程相同。后台线程异步查询，超时 1.5 秒，不读系统私有 plist/数据库，不申请通知权限，不修改通知 delegate。

复用 permissions:check 的列表结构，增补 key=notifications。authorizationStatus 为 notDetermined/denied 时显示「未开启」，authorized/provisional 时显示「已开启」，异常、未识别状态或原生模块缺失时显示「未知」。开启仅指系统通知授权，不保证专注模式、横幅样式或应用内 IM 开关允许展示。

permissions:openSettings 支持 notifications，仅打开系统通知面板；失败兜底打开 System Settings.app，仍失败返回既有 success=false。页面检查这个结果，回到窗口时复查，并保留手动刷新和既有设置后轮询。

编译使用官方 node-api-headers（商业根依赖），macOS main 构建自动产出 arm64+x64 universal `.node` 到 dist/main；打包时显式 asarUnpack，签名由既有 electron-builder 路径执行。非 macOS 构建不编译该模块。

## 验证

- 行为回归：授权状态映射、失败/超时/并发、非 macOS、设置成功/失败与未知 key。
- 两架构原生编译、主进程与 renderer 构建、商业测试；社区在隔离副本运行。
- 独立 Electron 进程只读调用实际 API，验证不使用 osascript/helper 的身份。
- 系统开关真实切换与签名安装包授权仍需实机验收；测试不改用户权限。

参考：[Apple API](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/getnotificationsettings(completionhandler:))、[Electron Notification.isSupported](https://www.electronjs.org/docs/latest/api/notification#notificationissupported)、[官方 Node-API headers](https://github.com/nodejs/node-api-headers)。
