# 截图 UI 优化与 Windows 菜单排查

日期：2026-10-13；开发分支：`codex/native-capture`。

## win-pc 安装包核对

通过 SSH 连接用户确认的 `win-pc`（192.168.32.235），读取正在运行的 Nuwax 安装目录和 `resources/app.asar`。未修改安装目录，未替换程序。

- ASAR 中 `package.json` 为 `nuwax@3.0.14-beta.1`；EXE 文件版本为 `3.0.14`。
- 实际 renderer 产物 `dist/assets/index-DQjFAMuw.js` 的 `topbar-app-menu` 仍是 `trigger:["click"]`，未包含 hover 修复。
- 此产物没有 `Claw.Capture.title` 或 `capture-screenshot`；主进程没有 `capture-window:init`，preload 也没有 `captureWindow.js`。
- 发布标签 `v3.0.14-beta.1` 同样不含 capture 特性目录。GitHub 已发布版本查询与真机安装版本一致。

结论：最新 beta 包尚未包含本特性分支，所以升级后没有 hover 效果和截图/录屏入口。另发现特性分支中 Windows 顶部自绘菜单未接 capture，需要与后续发布一起修复。上述为真机安装文件检查，不等同于已在新包上完成鼠标交互验收。

## 本轮实现

- 截图操作面板按工具、编辑、样式和范围/完成分组，统一选中、禁用、焦点和悬停反馈。
- 5 个常用颜色与 14/24/36 字号快捷按钮；保留自定义颜色及 8–144 字号输入，线宽显示数值。
- 样式区跟随工具与选中对象，文字编辑背景适配颜色；工具提示、尺寸标签避开面板并留在屏幕内。
- 录制控制条增加停止文字、区分录制/暂停/处理状态；直角录制边框保留。
- Windows 自绘「截图与录屏」菜单含截图、MP4、WebM、GIF，复用 CaptureLauncher 的并发保护、预览及保存流程。菜单同步收起并经过绘制后才开始采集，避免把菜单采入画面。

## 已运行检查

- 捕获域及语言资源共 194 项通过；新增菜单接线及调度时序回归共 27 项通过。
- 隔离 Electron 原生鼠标/键盘回归通过：文字重编辑、输入中快捷样式不失焦、颜色/字号预设、撤销重做、PNG 像素、多屏放大框、480/960 宽度布局及 440×60 录屏控件状态。
- 合成画面截图人工检查通过；底边选区尺寸标签避让面板，文字尺寸标签保持单行。
- features 严格类型检查、main 开发构建、特性边界 11 项、overlay 一致性、pin 和桥快照检查通过。

## Windows 登录桌面补充验收

使用 `win-pc`（192.168.32.235）当前登录桌面，在 `C:\Users\soddygo\nuwax-capture-acceptance-20261013` 运行独立 Electron 40.8.2 / Chromium 144 应用。主捕获脚本直接使用本分支生产捕获服务、窗口、preload 和编码资源，真实调用 Windows 的 desktopCapturer / getUserMedia；只将自建动态测试板保存为图像和视频。

当前会话暴露一个 1280×800、缩放 100% 的屏幕。合成三屏回归只证明事件隔离与布局，不能代替 Windows 物理多屏、混合 DPI 或 HDR 验收。

已完成：

- 生产 React / antd 菜单在 Windows 实际 renderer 中通过 4 项检查：文件悬停展开、切到编辑、截图/MP4/WebM/GIF 入口及快捷键、点击截图只触发一次且触发前菜单隐藏。
- 合成 UI 输入回归通过，退出码 0：文字/图形再次选中编辑、字号/颜色、撤销重做、PNG 像素、窄屏布局、录制控制条、三窗口放大框事件隔离。
- 真实窗口枚举、源画面捕获、窗口选择、文字和矩形标注、640×420 PNG 导出、结果分块读取与释放通过；取消后可再次截图，临时捕获窗口与 scratch 无残留。
- 修复后的生产实现连续两轮全新进程验收均为 8/8、退出码 0（北京时间 11:10:46–11:11:26、11:11:56–11:12:36）。MP4 / WebM / GIF 均真实框选 616×396 区域，暂停约 1 秒后恢复、停止并导出。有效录制约 2.5 秒；MP4/WebM 全量解码及 Chromium 播放进度通过，GIF 38 帧；色块、动画帧变化、边缘均检查通过，未混入红框或控制条。
- 128×96 的 Windows MP4 小区域真实转码回退、播放器播放、输出尺寸和解码通过。
- 捕获域及菜单 216 项测试、资源与声明 27 项测试通过；Winpthreads 来源记录与复用校验已由独立 verifier 复核。

真机发现的缺陷及处理：

- Windows 构建路径须转换为所选 MSYS shell 的路径；Media Foundation 编译须显式启用 D3D11；运行库须静态链接，避免客户端依赖开发环境中的 `libwinpthread-1.dll`。
- 原 MP4 能力探测使用 128×96，在本机返回 `MF_E_INVALIDMEDIATYPE`，错误地隐藏 MP4。改为 320×240 探测，并增加回归。
- 实际小区域的硬件编码也存在尺寸限制；Windows MP4 仅在硬件编码明确返回 `MF_E_INVALIDMEDIATYPE` 时，回退到系统 Media Foundation 软件编码，不改变所选尺寸。其他错误和取消保持原语义。
- Windows 将选择窗初始高度限制在任务栏上方：源为 1280×800，窗口却为 1280×752，导致预期 396 像素高的选区输出 421/422 像素。现在构造后重新设置请求的窗口边界，真实选择窗、viewport 和原始显示器尺寸完全一致。
- 首轮实际录制曾返回 `No desktop recording frames were written`。随后隔离采集、生产 preload/IPC 对照、两轮带诊断完整采集均能写帧，修复后的两轮无诊断生产实现也全部通过。该首次现象未再复现、原因未证实，未据此修改录制数据链路；后续仍应观察首次启动、桌面锁定/解锁和 RDP 会话变化。

本地证据保存于 `logs/acceptance/20261013-windows-capture/`（忽略目录）：`menu/`、`ui/`、`initial-real/`、`capture-results/`、`capture-results-repeat/`、`small-region-validation/`，包括原始 JSON、截图和 MP4/WebM/GIF。独立窗口测试未替换用户安装目录，不等同于新安装包的安装/升级验收；win-pc 已安装的 Nuwax 仍是 `3.0.14-beta.1`。物理多屏/混合 DPI/HDR、长时间录制、真实 IM 回填及正式新安装包仍需专项验收。
