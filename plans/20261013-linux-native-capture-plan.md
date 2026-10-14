# 实施计划：Linux 原生截图与录屏

- 对应 spec：`specs/linux-native-capture.md`。
- 状态：实现与平台重构已完成，X11 真机和隔离 GNOME Wayland 动态/静止验收通过；正式包、多屏及其他桌面环境的剩余验收见记录。
- 分支：`codex/linux-native-capture`；保留切换前全部 WIP，不改子模块 pin。本任务未主动提交或发布；共享工作区已有其它会话提交资源/发布链改动，保留其历史。

## 改动文件与责任

| 范围 | 文件 | 责任 |
|---|---|---|
| 采集适配 | captureService、selectionWindows、recorder、recordingPage、windowRuntime、内部 window/recordingContract、相关测试 | Linux runtime worker |
| 菜单 | TrafficLightToolbar、main 应用内快捷键、菜单 fixture 与相关测试 | Linux UI worker |
| 编码 | capture-resources、prepare-release-capture、capture-sources、manifest/LICENSE、encodingResources/transcode、相关测试 | Linux encoding worker |
| 集成与质量 | feature context/tray 接缝、pack、两条 release workflow、文档、Linux 验收 fixture | 主 agent |

## 实施顺序

1. 落盘增量 intent/spec/plan，保护当前检出；资源、菜单、采集三条责任线可并行。
2. 补私有 portal 同流预览/录制及来源坐标；X11 原实现保持回归。
3. 主 agent 集成托盘暂停/继续与发布链，同步 overlay 后跑商业质量门和边界/契约/pin 检查。
4. 在任务自有 OrbStack Docker Linux 环境编译 arm64 编码器，在用户提供的 Ubuntu 24.04 x64 真机运行 Electron X11 采集和短视频检查；另在任务自有 Wayland/PipeWire 环境验证 portal。记录环境、命令和实测限制。
5. 独立 verifier 检查最终状态；真机/正式安装包尚未覆盖的项目留在验收记录，不冒充完成。

## 证明成立的测试

采集域 Vitest、菜单 React 回归、脚本资源/发布回归、特性边界及 overlay/pin 守卫；Linux 真实 MP4/GIF 解码/尺寸/帧数、X11 截图及暂停/停止/取消与结果读取。社区 base:test 仅在隔离副本运行，不在共享检出清 overlay。

## 风险与回退

Portal/桌面环境差异用单流与普通窗口解耦；Linux 内容排除用隐藏控制窗和托盘控制；自编译 H.264 的发行授权差异在声明中保留。若验证发现环境不满足条件，格式能力如实返回，特性可用既有开关关闭；不改既有 Mac/Windows API。

## 偏离记录

- 用户提供 Ubuntu 24.04 x64 GNOME X11 真机后，X11 验收移至该机；8 项端到端检查通过，正式安装包、物理多屏仍单列。
- PipeWire 请求直接委托 Chromium 选择来源，避免先枚举再授权创建两个会话；保持一次请求、来源内坐标和同流录制。
- GNOME 实测发现工作区限制选区窗口，改用该屏原生全屏并等待内容尺寸稳定。
- 自动息屏造成实测黑画面，Linux 录制增加生命周期绑定的阻止息屏 token；不修改系统设置。
- Linux 控件统一在录制期间隐藏，停止等流结束后才显示编码 UI；托盘及应用内快捷键控制。
- Wayland 环境与最终质量门结果见验收记录，未完成项不得标完成。

## 用户追加：按平台适配重构（2026-10-13）

目标：平台差异集中到 macOS、Windows、Linux（X11/Wayland）实现，通用选择/录制状态机不继续堆各端 if。保留 IPC 信任校验、标注、裁剪、文件与结果管理共用；不复制整套状态机，不将 platform 传入 renderer。

- runtime worker：新 `platforms/` 策略入口，来源获取、防休眠、Linux 首帧时序；拆通用 recordingSession，错误类型移至中立 captureErrors。`index` 选择并注入适配器。
- window worker：`selectionWindows` 与 `platforms/windowing/`，封装平台窗口/控件及 X11 全屏初始化；adapter 组合入口注入窗口策略。
- encoding worker：新 `encoding/` 平台 profile，集中 H264 codec、像素格式、最小尺寸和精确软件重试；共享 transcode 负责裁剪/质量/写文件/abort。
- 主 agent：加强 Wayland 首帧及尾帧像素检查、接口集成、文档、独立质量门。真实解码通过后人工 GIF 首帧看到倒计时 UI，原非黑/运动断言不足，修复后必须用像素基线再验收。
- 应保留的分支：coordinateSpace/sourceKind 是坐标能力，mode/state 是业务状态，getDisplayMedia/getUserMedia 是采集协议；不为消除这些分支重复实现。

验收：共享 recorder/selector/transcode 中不再散落平台行为；已有 macOS/Windows 回归和 Linux 真机/Wayland 真实流测试继续通过，5 次动作仅 5 次 portal 会话，结果与资源契约不变。

## 当前验证结果

- 平台重构已实施。编码参数重构前后 30 组严格一致，Linux 实际产物证明保留；X11 原始轨道与 Wayland 重复源帧分别由平台入口选择，renderer 仅消费能力，不判断操作系统。
- Ubuntu 24.04 x64 GNOME X11 真机：重构后动态完整 8/8、静止 MP4/GIF/WebM 各轮 3/3；首帧、中间帧、末帧与暂停继续停止、结果释放、取消后复用均覆盖。实际独立首帧解码人工查看未见控件。
- 独立最终 delta 采集域 238/238；X11 所选屏控制窗定位末次修复另独立回归 41/41，overlay 263 文件一致、桥契约/pin/diff 全部通过；主进程与 renderer 生产构建成功。完整仓库 TypeScript 基线仍有错误，未将其报为通过。
- 原生 GNOME 46 Wayland 隔离桌面动态、静止两轮完整通过，实际 PNG1280×800、MP4/GIF640×400，首/中/尾像素污染率为 0，暂停继续、取消后复用及清理通过；每轮 5 次操作对应 5 个系统授权会话。证据与任务环境已收尾。
- Ubuntu 22 headless pixman 静止源仍返回含旧 UI 的帧，独立原生截图已干净而原始 video/clone 同像素；Ubuntu 24 原生 headless pixman 有格式协商阻断，其测试后端补丁仅诊断用途。已记录这些环境的失败，不降低断言或将其冒充通过。
- 正式安装包、物理多屏/混合 DPI、GNOME/KDE 人工授权和真实账号 IM 回填仍在验收记录单列。
