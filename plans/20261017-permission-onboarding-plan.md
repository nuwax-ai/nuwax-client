# Nuwax 客户端授权引导式 UI

## 目标与范围

- 本 worktree / `codex/permission-onboarding`，基线 `7503d15c`；只提交本分支，不 push、tag、发布、触发 CI，不修改其他分支或本机权限。
- 第一阶段只提交本方案；第二阶段实现、相关测试和一次 REVIEW.md 检查后单独提交。每阶段在终端打印进度。
- 一个入口覆盖首次总览、逐项授权、状态跟踪、故障排查与功能受阻跳转；允许跳过。权限只限制依赖功能，不阻止登录和普通聊天。
- Computer Use 只定义独立 helper 的检测/请求适配接口和定向导航；不合并、不修改 `codex/computer-use-product`。当前基线虽有历史 cua 服务，不能据此假定新 helper 产品接口已接通。

## 已核实的现状与取舍

- `permissions:check` 只有 macOS 四项：主程序辅助功能、屏幕录制、全磁盘访问占位 unknown、通知；新引导按实际消费者只列屏幕/FDA/通知。通知必须使用原生授权检测，不能用 Notification.isSupported 冒充授权。
- FDA 子进程探针区分 granted/denied/unknown，但目前检测函数还会弹重启框，boot 另弹引导框。新 UI 必须让探针无交互，取消旧 boot 原生弹窗，防止两套流程叠加。
- 截屏已有权限失败回调及 desktopCapturer 预触发。失败回调改为打开统一引导；预触发移至用户明确点击「打开系统设置」时，进入引导和轮询不能请求系统权限。
- 进一步核实 `windowRegions/darwin.ts`：当前窗口识别通过 CoreGraphics 的 CGWindowListCopyWindowInfo 读取边界/图层，不使用 AX。主程序无需辅助功能，新引导不列此项；旧 permissions API 保持兼容。Computer Use 键鼠操作依赖 helper 自身辅助功能，身份独立。
- FDA 建议用于受保护目录的本地文件直访；文件拒绝也可能来自 ACL、路径边界或沙箱策略，只有真实 OS EACCES/EPERM 且 macOS FDA 明确 denied 时才引导，不能把安全校验拒绝解释为系统授权问题。
- Windows 不列 macOS TCC 项，不鼓励提升整个客户端；说明普通权限进程不能操作管理员窗口。Linux 说明 X11 与 Wayland portal 差异，允许手动发起截屏自测，不将 unknown 伪装成成功。

## 信息架构与交互

### 统一设置页

- 「设置 → 授权」所有平台可达，重用现有设置浮层与四种语言，不新增启动窗口。
- 顶部：盾牌/标题「设置系统权限」、说明「按需开启，随时可以稍后设置」、完成数、稍后设置/完成按钮。
- 首次主 UI 就绪后读取持久化版本标记；未看过则打开授权总览。跳过、完成或关闭首次浮层均写入本地 settings，后续启动不重复打开。兼容旧 FDA dismissed，已跳过旧引导的用户不再被主动打扰。标记只表示看过，不能充当权限真值。
- 总览卡片包含名称、状态、授权对象、用途/关联功能、必要性（使用某功能时必需/建议/可选）；点击卡片进入该步。已授权徽标也可进入详情，方便撤权后恢复。
- 详情保留总览导航，可上一步/下一步；完成某项后不自动切换，避免读说明时界面跳动。支持直接定位某一步，返回后不会自动重试截屏、文件写入或启用 CU。

### macOS 各步

| 步骤 | 主体 | 用途与必要性 | 具体操作 |
| --- | --- | --- | --- |
| 屏幕与系统录音（旧系统：屏幕录制） | 安装版 Nuwax / dev Electron | 截图、录屏必需 | 打开隐私面板 → 找到并开启当前主体 → 按系统提示退出并重开 → 回到本页确认；点击时预触发最小捕获，使应用进入列表 |
| 全磁盘访问 | Nuwax / Electron | 受保护目录的文件直访、工作区读写建议 | 隐私与安全性 → 全磁盘访问 → 点 + → 在应用程序中选 Nuwax.app（dev 选择显示的 Electron.app 路径）→ 开启；给出应用路径并可在 Finder 显示 |
| 通知 | Nuwax / Electron | IM 消息提醒，可选 | 系统设置 → 通知 → 当前主体 → 允许通知；原生模块缺失显示未知 |
| helper 辅助功能、屏幕录制（适配器接入后） | Nuwax Computer Use | Computer Use 必需 | 始终明确选择 Nuwax Computer Use；不复用主程序状态，helper 未安装/未接通时说明未接入，不展示假的已授权；请求只能经 helper 适配器 |

- 用有序步骤、面板路径、主体名与应用路径组成可访问的图文结构；不使用容易随 OS/语言失真的系统截图。
- 屏幕录制说明：系统可能再次确认捕获，按系统弹窗操作，不因弹窗本身判为撤权；不承诺固定每周/月周期。
- 排障折叠区：确认主体与安装路径；重试检测；完全退出再开；仍失败可由用户在系统列表移除对应条目后重新添加。应用自身不执行移除/重置。

## 状态与轮询

- 共享类型 `granted | denied | unknown | restart_required`，另保留探测原始状态；平台不适用通过不生成条目表达。
- 每项检测独立容错，一项异常仅该项 unknown，不能把整个列表清空。未知文案「暂时无法确认，可重试或检查系统设置」。
- 屏幕/FDA 在本进程观察 denied → granted 时标记 restart_required；启动即 granted 不要求重启。撤销后回 denied；unknown 不能清掉已知待重启状态。屏幕 API 可能保持 denied 时给「已开启但未生效？重启后重试」辅助操作，不以仅打开设置或焦点返回假定已授权。
- 一键重启仅用户点击触发 `app.relaunch(); app.quit()`，保留 before-quit 服务清理，不使用 app.exit 绕过清理。先提示保存正在进行的工作。
- 主进程检测 single-flight，避免 FDA 探针重叠。仅授权页面挂载且文档可见时每 1.5 秒刷新；focus/visibility 恢复立即刷新。打开系统设置导致失焦时仍轮询，因为引导页仍可见；切 tab、关闭浮层、隐藏应用/文档或卸载停止定时器。迟到响应通过取消/代次守卫丢弃。
- 不持久化授权快照；重启后的真值重新检测。仅持久化看过/跳过标记，不因升级清除系统权限。

## 深链与错误处理

- `macPermissions.ts` 集中映射：`Privacy_ScreenCapture`、`Privacy_AllFiles`、`Privacy_Accessibility`，通知使用 `com.apple.Notifications-Settings.extension`。
- 面板打开异常退回 `x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension`（通知退系统设置），两层失败在 UI 显示错误和手动路径。协议 resolve 并不证明跳到正确页面，手动路径始终可见。
- IPC 只接受类型白名单中的权限键和目标主体；所有新增读取/操作限当前可信宿主主 frame。网页不能传任意 URL、应用路径或触发 restart。
- Windows/Linux 不发送 macOS 深链，不把 Windows 隐私页当作 Win32 授权开关。

## 对接点

- 新 `permissionOnboarding` 宿主 API：读取快照/首次状态、记录已看过、打开单项设置、显示当前应用位置、重启；preload 暴露类型，事件 `permissions:guide` 仅允许主进程推给宿主。
- 主进程统一 `openPermissionGuide(target)`：目标为主程序 screen_recording/file_access/notifications 或 helper 两项；绑定主窗口 getter，唤起并发送事件；renderer 打开设置并选中对应步。目标白名单阻止任意导航。
- 截屏：permission-denied 回调导航 screen_recording，不再弹另一种原生框；失败结果维持原契约，用户授权后主动重试。
- 本地直访：仅真实 OS EACCES/EPERM 后静默确认 FDA denied，再导航 file_access；原错误和沙箱安全边界保持原契约。file-server HTTP 返回错误仅明确权限错误才可进入相同处理，不能将网络故障映射成授权缺失。
- CU：预留注册适配器（check 不得启动 helper/发请求；request 只在用户点击时执行；返回 helper 自身两项状态）。无适配器时显示接入说明；将来产品分支的 permission-required 错误调用统一导航即可。本任务不启用 CU，不改其运行/确认策略。
- 现行权限矩阵补充新入口、状态含义、主体隔离和待验收范围，纠正旧「启动弹原生 FDA 框」描述。

## 文案与多语言

- 四套完整文案：zh-CN / en-US / zh-TW / zh-HK，含必需性、主体、系统路径、+ 添加、dev 路径、未知、重启、非 mac 说明、错误、排障。
- 例：「截图和录屏需要读取屏幕内容。只在你主动截图或录屏时使用。」
- 例：「请开启 {0}。Nuwax 与 Nuwax Computer Use 的系统授权互不继承。」
- 例：「重启后生效。请先保存正在进行的工作，再重启 Nuwax。」

## 测试与验收计划

1. 主进程状态机：启动已授权、拒绝→授权→待重启、撤权、unknown、单项异常、非 mac 空条目、single-flight、helper 状态隔离、跳过持久化和旧 dismissed 兼容。
2. IPC：可信宿主/非主 frame/guest 拒绝、键白名单、点击才触发 desktopCapturer、深链映射及两层失败、重启使用 quit。
3. renderer：总览与定向步骤、前后导航、主体/用途/必要性、状态四态、错误不空白；fake timers 验证 1.5s 轮询、focus、visibility、卸载/关闭/切 tab 与迟到响应。
4. 集成：截屏拒绝统一导航；真实 OS 文件拒绝触发、路径安全拒绝不触发；CU 适配器未注册时无主程序权限冒充；四语言 key 完整性。
5. 同步本 worktree 基座 overlay，运行相关 Vitest、overlay:check、check:pin、相关类型/构建检查；不运行会清 overlay 的 base:test。依赖安装不变更锁文件。
6. 一次 REVIEW.md 核查并记录结果；提交仅本任务文件，基座 gitlink 不变。
7. 真机验收单独列出：macOS 13/14/15/26 深链、签名包 Nuwax/Electron 主体、屏幕/FDA 重启实际生效；Windows/Linux/Wayland 自测。本任务不修改本机 TCC，不自动点系统设置，因此自动化证据不能替代这些人工验收。

## 参考

- [Electron systemPreferences](https://www.electronjs.org/docs/latest/api/system-preferences)：被拒绝后在设置中修改可能需要重启；检测与请求是不同操作。
- [Microsoft Windows file system access and privacy](https://support.microsoft.com/en-us/windows/privacy/windows-file-system-access-and-privacy)：桌面程序不受同一应用文件系统开关约束。
- [Claude Computer Use](https://code.claude.com/docs/en/computer-use)：辅助功能/屏幕录制分项、系统设置入口和重试。
- 本仓现行契约：[权限矩阵](../docs/20260918-nuwax-permissions-matrix.md)。

## 阶段进度

- 第一阶段：方案独立提交 `6c3e30d0`，之后才进入实现。
- 第二阶段：总览/逐步引导/实时状态/四语言/可信 IPC/截屏与文件错误导航已实现；CU 仅预留适配器，local-files 原关闭门控不变。
- REVIEW.md 单次核查：已检查功能、清理配对、来源/主 frame、文件路径安全与异步会话代次；修正了文件错误在登出后迟到时可能打开引导的竞态，补充回归用例。没有遗留的阻断性发现。
- 自动验证：51 个相关 Vitest 文件 / 548 项全部通过；feature-boundaries 及其 11 项脚本测试、overlay:check、check:pin、git diff --check 通过；主进程与 renderer 构建通过。仅在本 worktree 安装/构建 agent-kit，未改锁文件或依赖声明。
- 全量 tsc 非绿色：同依赖环境的基线和本次均为 238 条已有诊断，归一化路径/行号后没有新增诊断。不能将构建通过宣称为全量类型检查通过。
- ego-browser 使用模拟权限快照完成三项总览、逐步说明、设置点击、待重启、四语言、Windows/Linux 无 macOS 按钮、稍后关闭的交互检查。截图接口两次 CDP 超时，未取得像素级验收证据；该检查不操作真实系统设置或权限。
- 人工待验收：正式安装包、macOS 各版本深链/真实主体、实际授权与重启后生效、Windows/Linux/Wayland 真机、CU 产品适配器接通后的 helper 授权。未 push/tag/发布/触发 CI，未改其他分支或系统权限。
