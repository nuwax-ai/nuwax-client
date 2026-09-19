# Nuwax Computer Use 三平台能力矩阵（功能确认对照）

> 2026-09-19 建立；适用 v1.0.16+（Linux 支持与 portal-input 构建启用均自 v1.0.18）。
> 用途：QA 功能确认对照（能力点 × 平台）。授权/弹窗细节见 `20260918-nuwax-permissions-matrix.md`，
> 链路设计与验收实录见 `20260917-computer-use-integration-v2.md`。
> 事实来源：mac = spike + v1.0.16 载荷验证 + mac-mini 真机；win = win-pc 真机（B4）；
> Linux = 代码落地 + **容器实证**（OrbStack ubuntu:24.04 arm64 与 CI 腿同构：portal-input 构建、无头 serve、MCP 握手、ldd 依赖）+ 上游源码（trycua/cua v0.28.2 @625118a）口径，**桌面会话真机验证待做 ⚠️**。

## 一、能力总表（三平台 × 能力点）

| 能力点 | macOS | Windows | Linux ⚠️ |
|---|---|---|---|
| MCP 工具数（握手） | **56**（真机实证） | **57**（真机实证）＝56 ＋ `debug_window_info`（win 专属窗口诊断工具） | **60**（容器 arm64 无头实证）＝56 ＋ 4 个 X11 专属（`mouse_button_down`/`mouse_button_up`/`mouse_drag`/`parallel_mouse_drag`） |
| 窗口/元素语义层 | AX API | UIA / MSAA | 注册面一致，后端实现真机待验 |
| 输入合成（键鼠/文字） | AX / CGEvent | UIA ＋ Win32 SendInput | X11：XTest/libXtst ✅；Wayland：wlroots 系（Hyprland/Sway 等）经 wlr 虚拟指针 ✅；GNOME 47+/KDE Plasma 6+ 经 portal-input＋libei（v1.0.18 起构建启用，首用弹同意框） |
| 截屏 | ScreenCaptureKit（首次 SR 捕获可能再弹一次 SCK 同意框） | PrintWindow（常规）＋ WGC（首次捕获黄条，提示非授权） | 四级瀑布：compositor helper → wlroots screencopy → ext-image-copy-capture-v1 → xdg-desktop-portal Screenshot（Wayland 首用授权）；X11 会话直读 |
| 逐窗 PipeWire 截屏（portal-capture） | 不涉及 | 不涉及 | **不启用**（上游截屏主瀑布未接此路径、仅 Nix 包启用；对截屏能力零影响） |
| 浏览器 CDP 工具组（browser_* 9 个） | ✅ | ✅ | 注册面一致，真机待验 |
| 光标叠加 / 轨迹录制 / 会话生命周期 | ✅ | ✅ | 同上 |
| daemon 通道 | UDS `$TMPDIR/nuwax-computer-use.sock`（0600，本机同用户） | 命名管道 `\\.\pipe\nuwax-computer-use` | 同 mac UDS（容器实证 0600 建立，无 DISPLAY 可起——上游懒加载；pid/telemetry·install 标记/history/浏览器 profile/restore token 自 v1.0.18 全部经 CUA_DRIVER_DATA_HOME 内聚到 ~/.nuwax/computer-use，机器无 cua-* 外部目录）；**三平台均无 TCP 监听端口** |
| Helper 授权 | 辅助功能＋屏幕录制（一次性，跨版本保留） | **零授权** | X11 零授权；Wayland 见输入/截屏两行（细节见权限矩阵文档） |
| 设置页权限行 UI | 有（去授权/检查） | 无（v1.0.18 起不渲染，win 无 TCC 概念） | 无 |

## 二、feature 开关现状（与上游 cargo feature 对照）

| feature | 状态 | 影响与说明 |
|---|---|---|
| `portal-input` | **v1.0.18 起构建启用**（build-helper.sh `--features portal-input`，2026-09-19 拍板，对齐上游官方 Linux 发行物） | 仅作用于 Linux 非 wlroots 合成器（GNOME 47+/KDE Plasma 6+）的输入兜底；X11/wlroots 路径不经过它；**不改变 tools/list 条目**（feature 只改行为/错误形态/健康报告）。首用弹 xdg-desktop-portal 远程控制同意框，restore token 落 `~/.nuwax/computer-use/libei-persistent.token`（compositor 会话级）。**构建已经 OrbStack 容器实证**（ubuntu:24.04 arm64 与 CI 腿同构，47MB 产物）；ldd 实证 `libxkbcommon.so.0` 为其真实运行时依赖（deb 默认 depends 经 libgtk-3-0 传递覆盖，AppImage 极简环境留意）；CI x64/arm64 双腿产物确认随 v1.0.18 |
| `portal-capture` | 不启用 | 上游截屏主瀑布未接 PipeWire 逐窗路径（上游官方发行也不开，仅 Nix 包启用）；构建需 pipewire 0.8/libspa 0.8 头文件＋bindgen；对三平台截屏能力零影响 |
| 策略引擎 yaml/rego（cua-driver-core 默认 feature） | 随构建默认启用 | PolicyEngine 可用；但当前 serve 未传 `--permission-mode`，策略面未接线（见缺口 ②） |
| nuwax 本地补丁 ×2 | 恒应用（锁版 625118a90 ＋ `git apply`） | ① bundle 白名单参数化（含 `Nuwax Computer Use.app`，否则 driver re-exec 丢宿主 TCC、动作静默失败）；② `app_bundle_path()` 动态取运行中 bundle。均为方案 E 宿主化必需，上游无此概念（发行差异，非缺口） |

## 三、与原始开源方案（trycua/cua v0.28.2 @625118a）对照

**已对齐**

- 工具面全量：mac 56 / win 57 实测握手＝上游 `list-tools` 全集（cargo feature 不增删工具清单）。
- 构建可复现：锁版＋补丁＋五平台矩阵（mac arm64/x64、win x64、linux x64/arm64）；mac 产物预签 Developer ID 后进包；linux arm64 腿经 OrbStack 容器同构实证（含 portal-input，无头 serve+握手 60 工具）。
- Linux 两缺陷修复（453d5c0e）：首装流 dest 名对齐探测名（原装成 .app 名致 installed 恒 false）＋ CI apt 清单对齐上游官方（x11 FFI 头文件），此前 Linux 实际不可用。
- portal-input 启用后，与上游官方 Linux 发行物 feature 口径一致（此前唯一 feature 级差异消除）。

**已知缺口 / 偏差（按影响排序，QA 对照时注意）**

1. **Linux 桌面会话真机零验证 ⚠️**：X11 回归、GNOME Wayland portal-input 首用弹框与 restore token、wlroots 场景均未真机跑过；**无头链路已容器实证**（构建/serve/UDS/握手 60 工具/ldd 依赖）；CI x64/arm64 两腿产物确认随 v1.0.18。
2. **Bounded 权限模式 / 审批浮层未接线**：serve 未传 `--permission-mode`（上游有能力，本仓未消费）。
3. **MCP 条目无 allowTools/denyTools**：`check_for_update` / `install_ffmpeg` 红线目前仅 QA 口径，未代码强制。
4. **mac 元素树无只读文本**：计算器显示屏反例（AX 不暴露）——涉值确认的用例必须以截图终验。
5. **无人值守真门槛＝锁屏/休眠与密码框**（授权本身是一次性非障碍）；v1.0.17 起电源保活三档缓解。
6. **win UIPI**：目标是管理员权限窗口时普通权限 helper 被挡（预期行为）；UWP 操控需 uiAccess 提升进程（后续分发项）。
7. **上游 0.x 契约破坏性变更风险**：以锁版（CUA_COMMIT＋四契约精确锁）兜底。

## 四、QA 功能确认对照清单

**macOS（v1.0.17 已实证一轮，回归用）**

- [ ] 首装流：设置页 Computer Use 权限行 →「去授权」→ TCC 辅助功能＋屏幕录制两项
- [ ] daemon：UDS socket 存在；`lsof` 抽查无 TCP 监听
- [ ] 会话握手：56 工具（附录清单逐一对照）
- [ ] 输入 / 截屏 / 元素树 / 剪贴板样例动作通过
- [ ] 升级新版本后权限保留（不重弹 TCC）

**Windows**

- [ ] 安装即用、零授权；命名管道握手 57 工具（56＋`debug_window_info`）
- [ ] WGC 首次捕获出现黄条一次（系统提示，不可拒绝、非授权）
- [ ] 管理员权限窗口被 UIPI 挡（预期行为，非缺陷）
- [ ] （红线）确认 agent 未调用 `check_for_update` / `install_ffmpeg`

**Linux ⚠️（待真机，按三场景）**

- [ ] X11 会话：零授权全链路（输入 libXtst、截屏 X11 直读）
- [ ] Wayland wlroots 系（Hyprland/Sway 等）：wlr 协议输入＋screencopy 截屏，全程无弹框
- [ ] Wayland GNOME/KDE（须 v1.0.18+ 产物）：首用截屏 portal 授权框；首用输入远程控制同意框；同 compositor 会话内重启 daemon 不重复弹（restore token `~/.nuwax/computer-use/libei-persistent.token`）
- [ ] 构建产物确认：portal-input 已编入（x64/arm64 两腿）——源码级已经容器实证（arm64），产物级随 v1.0.18 CI

**通用**

- [ ] tools/list 数量与附录一致（feature 开关不改工具清单）
- [ ] `stop --socket` 协议停机干净，无残留进程

## 附录：工具清单（56，mac 实测 `list-tools`；Windows＝56＋`debug_window_info`）

```text
bring_to_front        browser_click         browser_dialog        browser_download
browser_navigate      browser_pointer       browser_prepare       browser_set_input_files
browser_type          check_for_update*     check_permissions     click
clipboard_read        clipboard_write       double_click          drag
end_session           escalate_session      get_accessibility_tree get_agent_cursor_state
get_browser_state     get_config            get_cursor_position   get_desktop_state
get_recording_state   get_screen_size       get_session           get_session_state
get_window_state      health_report         hotkey                install_ffmpeg*
invoke_menu           kill_app              launch_app            list_apps
list_sessions         list_windows          move_cursor           page
press_key             replay_trajectory     right_click           scroll
set_agent_cursor_enabled set_agent_cursor_motion set_agent_cursor_theme set_config
set_value             set_window_frame      start_recording       start_session
stop_recording        type_text             verify_state          zoom
```

`*`＝治理红线工具，agent 不得调用（版本已锁死）；`debug_window_info` 仅 Windows 注册；
Linux＝56 ＋ 4 个 X11 专属（`mouse_button_down`、`mouse_button_up`、`mouse_drag`、`parallel_mouse_drag`，容器实测共 **60**）。
