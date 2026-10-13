# 规格：Linux 原生截图与录屏

- 对应 intent：`plans/20261013-linux-native-capture-intent.md`。
- 状态：实施设计已完成；开发验证及正式桌面验收分别记录。
- 基线：`specs/native-capture.md`；此增量替代原规格中 Linux 不支持的范围。

## 方案与内契约

按用户追加要求，平台差异由主进程平台适配器集中处理：macOS、Windows、Linux（X11/Wayland）的来源获取、选择窗/控件行为和录制准备策略分开实现；入口选择后注入共用状态机。编码器使用独立平台 profile。IPC 信任校验、选区/标注、计时、sink、结果与释放共用，不复制整套采集流程。Renderer 只消费采集协议/能力，不按操作系统分支。

1. CaptureService 支持 Linux，具体格式仍由已验证资源探针决定。截图不依赖视频编码器。
2. Linux 会话环境识别集中在采集模块。X11 保持桌面覆盖层；Wayland 不调用全局鼠标/窗口定位，而使用来源内预览编辑器。
3. 预览编辑器复用既有标注与物理像素裁剪。内部 CaptureSelection 增来源坐标标识；普通窗口的 UI 坐标与来源像素分开，来源窗口录屏也尊重用户选区。
4. Portal 采集使用私有 BrowserWindow/session，屏幕分享请求只接受本轮拥有的主框架及当前文档；一次系统来源选择，snapshot/record 共用实际帧尺寸。录制首帧与后续视频保持同一流，绝不再次询问来源。取消、权限拒绝、流结束、renderer 退出均清理。
5. Linux 不调用内容保护作为排除承诺，不建立桌面录制红框。无法避开来源的录制控制窗在开始前隐藏，托盘提供暂停/继续/停止；选择/编码结束后收尾。
6. 菜单仅截图、MP4、GIF，Linux 应用内 Ctrl+Alt+S/R 与 Windows 共用宿主动作通路；录制中 Ctrl+Alt+R 停止、Ctrl+Alt+P 暂停/继续，需客户端获得焦点。不新增对外 pause/stop API；IM Promise 返回、readChunk/release 契约不变。
7. linux-x64/arm64 原生构建固定 OpenH264 静态库及 libvpx，再构建 LGPL FFmpeg。资源 metadata、配置、版本、SHA、源码/许可证和短编码探针必须齐全；本地 pack 和两条发行 workflow 同时消费。

## 平台矩阵

| 行为 | Linux X11 | Linux Wayland |
|---|---|---|
| 来源选择 | 每屏覆盖层与窗口列表 | 系统 portal 选择一个屏幕/窗口 |
| 区域及标注 | 桌面上框选 | 已授权来源预览内框选 |
| 录屏 | 同一来源录制，输出选区 | 预览与录制共用同一授权流 |
| 控制 UI | 选择后普通控制窗，录制时隐藏 | 普通控制窗，录制时隐藏 |
| 暂停/继续/停止 | 托盘或客户端应用内快捷键 | 托盘或客户端应用内快捷键 |
| MP4/GIF | LGPL FFmpeg + OpenH264/GIF | 相同 |

## 异常与回退

不支持的平台保持 unsupported；用户取消为 canceled；授权拒绝为 permission-denied；资源缺失只让相应格式不可用；不使用 PATH fallback。Portal 取消/失败后不可退到未经授权的桌面抓取。特性关闭与会话结束保持既有清理。

Wayland 私有 session 将唯一受信请求直接交给 PipeWire 的来源选择，不先调用 `desktopCapturer.getSources()`，避免创建第二个系统授权会话。显式关闭 `WebRTCPipeWireCapturer` 时能力为不可用。系统未区分关闭选择器与权限拒绝时，按 Chromium 实际暴露的错误返回，不编造原因。

X11 选择窗口使用所选屏的原生全屏，初始化等待实际内容尺寸稳定，避免 GNOME 工作区限制导致坐标偏移。Linux 录制从倒计时前到结束持有 `prevent-display-sleep`；结束/取消释放，不改变用户息屏设置，手动锁屏仍按会话中断处理。

Linux MP4 选区按偶数像素对齐后至少为 16×16；更小选区在启动前拒绝，不偷偷放大。停止后等录制桥完成最终分块并关闭采集窗，才重新显示编码 UI，避免尾帧录入控件。

录制开始前，平台录制准备策略隐藏不能排除的控件，并等待同一来源产生可用于录制的新帧；不能用单纯固定 sleep 作为帧已更新的证明。Wayland 验收分别检查首/中/尾帧的像素基线，避免只凭非黑、文件可播放或运动存在就遗漏 UI 入画。

Wayland 的来源可能只在画面变化时出帧。录制适配器把同一次授权产生的实际帧按原尺寸保存在 canvas，再按请求帧率输出最后一帧的连续视频轨道；不重新选择来源、不缩放、不伪造运动。原轨道、观察轨道、派生轨道及定时器都属于同一采集生命周期，停止和取消统一释放。Linux X11 保留原始 MediaRecorder 输入，通过观察轨道建立隐藏后的新帧屏障，避免额外 canvas 改变颜色；Mac/Windows 使用既有直接录制策略。

## 验证计划

Linux 平台能力、环境选择、菜单动作、私有请求越权/重复、真实帧/选区、同流复用、取消/超时清理、托盘状态及转码测试；资源来源/许可证/发行注入测试；真实 Linux arm64 编码和 X11 Electron 截图/短录制；X11 双屏/混合 DPI、Wayland portal 权限/多屏及安装包验收单列。

## 已否决的方案

- 仅打开平台开关：没有编码器、菜单与 portal 适配。
- 所有 Linux 强制 Xwayland：不能保证获取 Wayland 原生应用的桌面内容。
- 预览后重新申请来源：可能弹两次授权并采到错误屏幕。
- libx264 或系统任意 FFmpeg：改变既有 GPL/nonfree 与来源校验边界。

## 技术依据

- Electron 40.8.2 desktopCapturer：PipeWire 单来源，https://raw.githubusercontent.com/electron/electron/v40.8.2/docs/api/desktop-capturer.md 。
- Electron BrowserWindow：Wayland 坐标/置顶与内容保护平台限制，https://www.electronjs.org/docs/latest/api/browser-window 。
- OpenH264 自编译与 Cisco 二进制的授权差异：https://www.openh264.org/faq.html 。
