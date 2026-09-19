# Nuwax 客户端与 Nuwax Computer Use 权限矩阵（多平台）

> 2026-09-18 定稿；适用 v1.0.16+（Computer Use Linux 支持自 v1.0.18）。
> 双视角：**Nuwax 客户端**（Electron 壳）与 **Nuwax Computer Use**（独立 helper）。
> 事实来源：mac 实证（spike+v1.0.16 载荷验证+mac-mini 真机）、win 实证（win-pc 真机链路）、
> Linux 为代码落地+上游文档口径（真机验证待做，标注 ⚠️）。

## 总表

| 平台 | 组件 | 需要的授权 | 授权时机 | 持久性 |
|---|---|---|---|---|
| macOS | 客户端 | **无必需项**（自身不做截屏/AX）；file-server 读用户所选工作目录时触发 桌面/文稿/下载 文件夹 TCC（系统文件选择器内确认，按目录授权） | 首次选目录 | 持久 |
| macOS | Helper | **辅助功能 + 屏幕录制**（两项，一次性）；首次 SR 捕获可能再弹一次 SCK 同意框（同授权会话内点一次） | 设置页「去授权」引导 | **跨版本保留**（Developer ID 正签+稳定 bundle id com.nuwax-ai.nuwax-computer-use，Team 89GQ2RJVW7） |
| Windows | 客户端 | 无 per-app 授权概念；beta 未签名触发 SmartScreen（正式版手签后消失） | 安装时 | — |
| Windows | Helper | **零授权**（UIA/MSAA+PrintWindow 开箱即用）；WGC 捕获首次仅弹不可拒绝系统黄条（提示非授权） | 无 | — |
| Linux ⚠️ | 客户端 | 无 portal 必需项 | — | — |
| Linux ⚠️ | Helper | X11 会话：**零授权**；Wayland 会话：截屏走 xdg-desktop-portal（桌面环境弹授权）、全局输入依赖 compositor 通路（wlroots/Hyprland/KWin 有 wlr 协议支持，GNOME Wayland 受限——上游边界） | 首次截屏（Wayland） | 按 portal 策略 |

## 明确不需要的（常被问）

- **macOS 完全磁盘访问**：helper 工具面为纯 UI 自动化（56 工具实测清单：窗口/元素/键鼠/剪贴板/截屏/浏览器 CDP/会话，**无文件工具、无 shell**）。文件操作的权限主体永远是**被操控的应用**（保存到桌面=文本编辑在写、移动文件=Finder 在动）。macOS 对桌面/文稿/下载的独立 TCC 门只拦「进程自己直接读」，本链路不触发。
- **网络入站授权**：daemon 仅监听本机 UDS/命名管道（0600，同用户鉴权），无监听端口。

## 边界与治理红线

- **UIPI（Windows）**：目标是管理员权限窗口时，普通权限 helper 被隔离挡住；UWP 应用操控需 uiAccess=true 提升进程（后续分发项）。
- **无人值守**：授权是一次性的，不是障碍；真门槛是**系统锁屏/休眠**（锁屏下 AX 不可达、截屏只得锁屏画面——机器要配不锁屏+防休眠）与**密码/身份验证框**（不该也常不能被自动化替输）。
- **治理红线**：上游工具清单含 `check_for_update`/`install_ffmpeg`——版本已锁死，**agent 不得调用 update 类工具**（提测口径告知 QA）。
- **审批浮层（未来项）**：Bounded 权限模式+审批链未接线（当前 serve 未传 permission-mode）；接入后无人值守需配自动批准策略。

## 权限自检路径

- 产品内：设置页 Computer Use 权限行（仅 mac）→「去授权 / 检查」；
- 工具面：会话内 agent 可调 `check_permissions` 自检（mac/win/linux 均在工具清单）。
