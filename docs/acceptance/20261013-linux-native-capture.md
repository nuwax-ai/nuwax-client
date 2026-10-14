# Linux 原生截图与录屏实施验收

日期：2026-10-13，Asia/Shanghai。分支：`codex/linux-native-capture`。规格见 [Linux 增量规格](../../specs/linux-native-capture.md)，IM 接入见 [交接指南](../nuwax-im-native-capture-integration.md)。

## 实施范围

Linux 开放截图、标注和录屏。X11 使用桌面覆盖层与窗口来源；Wayland 使用私有 session 的系统 portal，请求一次来源，在同一条流的预览中框选后录制，坐标属于来源，不伪造桌面屏幕 ID。权限错误和资源能力按实际结果返回。

客户端壳菜单支持 hover 展开/切换，入口为截图、MP4、GIF；兼容 API 保留 WebM。录制期间 Linux 控件隐藏，通过托盘暂停/继续/停止，或切回客户端使用 `Ctrl+Alt+R` 停止、`Ctrl+Alt+P` 暂停/继续。应用内 `Ctrl+Alt+S` 截图，空闲时 `Ctrl+Alt+R` 启动 MP4。IM 继续使用现有 Promise、结果句柄、分块读取和释放接口。

linux-x64/arm64 固定源码构建 FFmpeg 8.1.3、libvpx 与 OpenH264 2.6.0；资源校验覆盖配置、版本、SHA、许可证、源码和短编码探针。pack、稳定及 beta 工作流都准备和核验这些资源，包括 Unix 执行权限。运行时不使用系统 PATH 编码器。Linux MP4 的偶数对齐后选区至少 16×16，小选区提前拒绝。

## Ubuntu X11 真机：通过

- 用户提供的 `swufe@192.168.32.163`，Ubuntu 24.04.4 LTS x86_64、GNOME X11、kernel 7.0.0-38-generic。
- 物理屏幕 3840×2160，缩放 1；GNOME 工作区为 `(66,32,3774,2128)`。
- Electron 40.8.2、Chromium 144；独立测试目录和 profile，使用本轮 overlay 编译的真实采集/renderer/preload，未使用用户登录数据。真实测试启用 Electron sandbox。
- 此验收为隔离源码测试应用，不等于完整 Nuwax 安装包安装/升级验收。

`tests/capture-linux.electron.ts` 在平台重构和 X11 原始轨道保护策略修复后，无过滤完整运行，18:55:51–18:56:44，共 8/8 通过。视频检查覆盖 0 秒首帧、中间帧和末帧；另使用独立 FFmpeg 解码实际第一个包并人工查看首帧：

| 项目 | 结果 |
|---|---|
| 真实编码器探针 | MP4、GIF、兼容 WebM 均可用 |
| 系统窗口枚举及原尺寸帧 | 来源窗口 640×420 |
| 截图选择、文本和矩形标注 | PNG 640×420，分块读取/释放成功 |
| MP4 区域录制、暂停继续、停止、播放解码 | 616×396，约 2.35 秒，运动帧、颜色与边缘检查通过 |
| WebM 相同流程 | 616×396，约 2.38 秒，相同检查通过 |
| GIF 相同流程 | 616×396，约 2.36 秒，相同检查通过 |
| 取消后再次截图 | 取消收尾成功，下一次截图可用 |
| 采集窗口、结果句柄和临时文件清理 | 残留窗口 0、scratch 项 0，测试 profile 已删除 |

另运行真实 Electron 壳菜单 fixture，6 项通过：无需点击的 hover 展开、菜单间 hover 切换、只显示三项采集入口、隐藏菜单后分发、截图/启动快捷键、录制中暂停/停止快捷键路由。最后一项使用模拟录制状态验证路由，真实录制生命周期由上述采集 fixture 覆盖。

现场修复：

1. GNOME 将普通选择窗限制在工作区，导致 UI 和物理选区偏移；X11 改用所选屏原生全屏，等待实际内容尺寸稳定后初始化。验收日志确认内容尺寸为 3840×2160。
2. 自动息屏使 X11 录制返回黑画面；Linux 录制新增 `prevent-display-sleep`，从倒计时到结束持有，取消/错误也释放。测试未修改用户息屏设置，手动锁屏仍遵守系统行为。
3. 停止时提前显示编码 UI 可能进入最后的视频帧；改为等待最终分块和停止确认、关闭采集窗后再显示。
4. 将 Wayland 的重复帧 canvas 策略用于 X11 会改变颜色；Linux 平台适配分别选择 X11 原始录制轨道加鲜帧屏障、Wayland 重复源帧策略。X11 动态三格式和静止 MP4 实测颜色恢复，不放宽 RGB 容差，也未强制颜色配置。
5. X11 普通控制窗显示前按所选屏和选区定位，避免二屏仍落默认屏。负坐标二屏、显示顺序与来源坐标不定位的回归已补齐；Wayland 继续由合成器定位普通窗口，不伪造显示器关联。此末次定位调整尚无物理双屏验收。

真机测试目录：`/home/swufe/nuwax-linux-capture-acceptance-20261013`。可复跑命令如下，须在未锁定的 X11 会话内运行，使用测试目录中的匹配 Electron 和资源：

```bash
cd /home/swufe/nuwax-linux-capture-acceptance-20261013
export DISPLAY=:0
export XAUTHORITY=/run/user/1000/gdm/Xauthority
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
NUWAX_CAPTURE_RESOURCE_ROOT="$PWD/encoder-project/resources/capture" \
NUWAX_CAPTURE_ACCEPTANCE_DIR="$PWD/x11-guarded-source-final" \
./electron/electron capture-linux.cjs --disable-gpu --disable-dev-shm-usage
```

证据为忽略目录 `logs/acceptance/20261013-linux-native-capture/x11-guarded-source-final/` 的 `result.json`、PNG、MP4/WebM/GIF 和独立首帧解码 PNG，以及 `menu/` 的 `menu-results.json`、菜单截图。此前 `x11-real-device/` 是重构前基线，不能混用为最终代码证明。19:05:59–19:08:38 分别补测静止 MP4、GIF、WebM，每轮编码器、录制与清理 3/3 通过；各轮暂停约 1 秒，产品约 2.36 秒，没有持续动画驱动源。三轮证据为 `x11-static-guarded-final/`、`x11-static-other-final/`、`x11-static-webm-final/`。

## 编码器原生构建：通过

| 架构 | 构建/运行 | FFmpeg SHA256 |
|---|---|---|
| x64 | Ubuntu 24.04 真机，GCC 13.3、NASM 2.16 | `1cf3d00028f252e98c1386bbe8778f16c4f1897a3c60be375c9a63ad66909286` |
| arm64 | Debian 12 构建，Ubuntu 22.04.5 运行 | `09bfdad34a5c4dc994289f5c290c51f4f7e4884b524f7fd7176d7f7218f03ec7` |

两种架构分别生成 3 格式 × 3 质量档共 9 个产品；用测试专用独立解码器验证编解码类型、尺寸、时长、6–9 个运动帧。独立解码器未打包，也不会被运行时选中。FFmpeg 关闭 GPL/nonfree/network，仅启用所需编解码器及滤镜；OpenH264 源码固定 commit `652bdb7719f30b52b08e506645a7322ff1b2cc6f`，归档 SHA256 `7a060916a9fcb63ba51d83a4f2388660c0b58797be547c4fa5c52e8d65660a85`。

证据：同目录 `encoding/` 中 x64、Debian 12、Ubuntu 22 编码报告及小选区报告。OpenH264 使用 BSD-2-Clause 源码构建，不能把 Cisco 官方二进制的专利费覆盖当作本产物的证明；Linux 发行授权由发布负责人确认，依据为 [OpenH264 FAQ](https://www.openh264.org/faq.html)。

## Wayland 验证

实现和私有请求、同流复用、权限/清理单元测试已补齐。真实流进入后，隐藏采集窗不触发 `requestVideoFrameCallback`，首帧等待改为有界回调加 `HAVE_CURRENT_DATA` 已解码帧回退，保留实际来源尺寸和同流语义。静止来源由同一授权流的实际像素重复输出，不伪造运动。最终画面检查为首帧、中间帧、末帧对源图像的 16×8 RGB 网格比较，每帧污染率须小于 2%；没有放宽断言或使用持续动画掩盖静止问题。

| 环境 | 实测结果 | 限制 |
|---|---|---|
| Ubuntu 24.04.4 x64 真机，GNOME Shell 46.0、Mutter 46.2、PipeWire 1.0.5、portal 1.18.4 / GNOME backend 46.2；独立 1280×800 Wayland 桌面 | 动态、静止两轮完整通过；PNG、MP4/GIF、暂停继续/停止、取消后再次截图及清理；每轮 5 次操作仅 5 个 CreateSession | 原生 GNOME 后端、真实系统授权窗口由 AT-SPI 操作；隔离虚拟屏，不代替物理多屏或人工授权/拒绝验收 |
| Ubuntu 22.04.5 arm64，Sway 1.7、wlroots 0.15.1、PipeWire 0.3.48、wlr portal 0.5.0；headless pixman 1280×800 | 动态整轮可通过，5 次动作仅 5 次系统会话；静止 GIF 首帧仍残留倒计时 UI，污染率 17.1875% | 自动选择虚拟来源，不是人工桌面验收；默认静止场景未通过 |
| Ubuntu 24.04 arm64，Sway 1.9、PipeWire 1.0.5、wlr portal 0.7.1；原生 headless pixman | 后端无法协商合法采集格式；无 DRM 节点的软件 GLES2 也不能启动 | 环境在客户端采集前阻断，不能称产品通过 |
| 上述 Ubuntu 24，测试后端改为 legacy SHM | 动态和静止 MP4/GIF 首、中、尾各 3 帧污染率 0，暂停继续、停止、播放及读取释放通过；连续操作仍超时，整轮失败 | 只为定位旧帧问题的两行后端补丁；不能当原生 Ubuntu 24 验收 |

旧环境中，同一静止 GIF 开始时，独立 `grim` 原生 screencopy 图像已经没有控件，但原授权 video 与 clone 的 PNG 像素完全相同且都残留 UI。失败因此位于授权流/PipeWire 摄取链，不能仅归因于窗口隐藏或 canvas。隐藏改为销毁、禁用 direct scan-out 的诊断也未使整轮通过；这些实验没有进入产品实现。

证据保存于忽略目录 `logs/acceptance/20261013-linux-native-capture/` 下的 `wayland-ubuntu22-evidence/`（原生、video、clone 对照与失败报告）、`wayland-ubuntu24/`（原生失败、两行补丁、版本/SHA、产物和失败报告）及 `wayland-gnome46/`（最终原生 GNOME 通过报告、授权计数、脚本、产物、独立首帧与 SHA）。本轮环境曾遇到缺少 `gdbus`、portal 启动竞态与 GTK4 按钮状态误判，修正测试环境后才进入真实来源，不能混用为产品失败证据。

GNOME 动态轮为 19:35:56–19:36:25，静止轮为 19:36:50–19:37:24。两轮实际来源均为 1280×800，MP4/GIF 选区产物为 640×400、约 1.7 秒；每种格式的首、中、尾帧网格污染率均为 0。独立 FFmpeg 解码实际首帧并人工查看，无授权窗或录制控件。静止轮没有持续动画，取消后截图复用、scratch/句柄/窗口与 profile 清理均通过。

该对照使用真实设备 NVIDIA GBM/EGL 与未修改的 GNOME 后端，在独立 DBus/runtime、隔离配置/缓存和内存 GSettings 下运行。AT-SPI 只操作该私有 portal 进程的真实授权窗口；通过私有 Shell 的公开 OverviewActive 属性关闭测试概览，避免窗口自动排版改变像素基线。未切换用户原有 X11 会话。最终核实两轮采集及桌面进程已退出，另清理了三条经隔离配置路径确认的早期试验 ibus 遗留进程；用户原会话仍为 X11、未锁屏。

## 质量门与维护性自查

按用户追加的重构要求，当前平台入口组合 `platforms/` 来源策略与 `platforms/windowing/` 窗口策略；编码细节集中在 `encoding/{macos,windows,linux}.ts`。通用 `recordingSession` 管安全 IPC/私有窗口，`recorder` 管状态机/计时/sink/清理，`transcode` 管裁剪/质量/文件/取消。Renderer 接收流能力配置，不识别操作系统。

编码重构 27 项域测试通过；重构前后 27 组常规参数与 3 组 Windows 软件参数严格一致。Linux x64 真机的 6 个 MP4/GIF 产品字节一致，3 个 WebM 产品的解码帧和时间戳一致（容器随机 UID 不作字节一致要求）。窗口策略重构及 X11 屏幕关联修复 41 项通过。

商业全量 Vitest 2806 通过 / 18 跳过，独立 Node 回归 85 通过；社区隔离副本 1611 通过 / 18 跳过；完整脚本回归 322 通过。全量之后的定时器与流清理修复由独立 verifier 补测 capture 域 236 项通过；metadata/X11 策略最后调整再次独立补测 238 项通过，X11 屏幕关联末次调整独立补测 41 项通过。主进程和 renderer 生产构建成功。18 项跳过为 macOS 上的 Linux bwrap 集成测试 17 项和既有 agentWorkDir 测试 1 项，与本次 Linux 实机截图/录屏检查不同。最终 overlay 263 文件一致、桥契约/pin/diff 守卫通过，特性边界检查已执行。完整仓库 TypeScript 检查有既有错误，不能声明全绿。

- 功能逻辑内聚：平台环境、portal 请求、采集流与清理在 capture 模块；壳只接菜单、托盘和生命周期。不同来源坐标有明确内部标识。
- 代码分层：共享内部 contract 不扩大 IM 公共 API；私有 IPC 校验当前窗口、主框架和文档；边界守卫覆盖依赖方向。
- 可维护性：固定源码/资源验证，失败提前返回，取消及停止统一释放；真实测试使用隔离 profile、测试板和产物记录，区分资源、源码和安装包证据。

## 仍需验收

合并前最终复核（2026-10-13）：商业全量重新运行，217 个测试文件通过、1 个跳过；2815 项通过、18 项跳过。`overlay:check`、`host-bridge:check`、`check:pin` 与 `git diff --check` 通过。平台组合入口见 `platforms/index.ts:21`，私有会话权限和释放见 `recordingSession.ts:132`、`:137`，编码差异入口见 `encoding/index.ts:11`；内聚、分层、维护性自查可合并。前述真机验收边界不因单元测试通过而扩大。

正式 Linux 安装包和 GitHub Actions 五平台发行链；物理双屏/混合 DPI、GNOME/KDE Wayland 人工授权与拒绝、系统锁屏/挂起、长时间录制、HDR/ICC 色彩一致性、真实账号 IM 回填尚未验收。此次通过范围为真机单屏 X11 与真机上的隔离 GNOME Wayland；旧版 Sway 静止源及连续采集的已知失败仍保留，不能宣称所有 Linux 桌面都通过。
