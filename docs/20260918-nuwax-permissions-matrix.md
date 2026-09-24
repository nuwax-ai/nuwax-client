# Nuwax 客户端与 Nuwax Computer Use 权限矩阵（多平台）

> 2026-09-18 定稿；适用 v1.0.16+（Computer Use Linux 支持自 v1.0.18）。
> 双视角：**Nuwax 客户端**（Electron 壳）与 **Nuwax Computer Use**（独立 helper）。
> 事实来源：mac 实证（spike+v1.0.16 载荷验证+mac-mini 真机）、win 实证（win-pc 真机链路）、
> Linux 为代码落地+上游文档口径（真机验证待做，标注 ⚠️）。
> 2026-09-24 实现更新：开启 Computer Use 时客户端一次确认全范围操作；macOS 随后由系统分别授权辅助功能、屏幕录制和直接捕获，全部实测就绪才启用。未完成时确认状态持久保留，设置页回来可继续；关闭清除待办。Windows/Linux 无 macOS TCC，Wayland portal 的系统授权仍按 compositor 会话要求出现。正式安装包验收待做。

## 总表

| 平台 | 组件 | 需要的授权 | 授权时机 | 持久性 |
|---|---|---|---|---|
| macOS | 客户端 | **全磁盘访问（建议）**：文件链路（file-server 浏览「我的电脑」`fs/roots`/`fs/children`、引擎读写工作区）是**裸 readdir/IO，不经系统文件选择器**，被 TCC 拦时静默 EPERM 不弹系统授权框——桌面/文稿/下载/资源库等受保护目录只有 FDA 一次覆盖（文件夹级 TCC 在本链路无采集入口）。初始化检测+一次性引导+设置页状态行（2026-09-21 批次起，`services/fullDiskAccess.ts`） | 初始化弹窗（拒绝后永不再弹，设置页为唯一再入口） | 持久（注意 dev 身份漂移，见下「授权对象」） |
| macOS | Helper | **辅助功能 + 屏幕录制**（两项，一次性）；首次 SR 捕获可能再弹一次 SCK 同意框（同授权会话内点一次） | 设置页「去授权」引导 | **跨版本保留**（Developer ID 正签+稳定 bundle id com.nuwax-ai.nuwax-computer-use，Team 89GQ2RJVW7） |
| Windows | 客户端 | 无 per-app 授权概念；beta 未签名触发 SmartScreen（正式版手签后消失） | 安装时 | — |
| Windows | Helper | **零授权**（UIA/MSAA+PrintWindow 开箱即用）；WGC 捕获首次仅弹不可拒绝系统黄条（提示非授权） | 无 | — |
| Linux ⚠️ | 客户端 | 无 portal 必需项 | — | — |
| Linux ⚠️ | Helper | X11 会话：**零授权**；Wayland 会话：截屏走 xdg-desktop-portal Screenshot（每会话首用弹授权）；输入经 libei/RemoteDesktop portal（**自 v1.0.18 构建启用 portal-input feature**——GNOME/KDE Wayland 首用弹 xdg-desktop-portal 远程控制同意框，同意后 **restore token 落 `~/.nuwax/computer-use/libei-persistent.token`（v1.0.18 起 CUA_DRIVER_DATA_HOME 内聚）**，同 compositor 会话内不再重复弹；未装 portal-input 的旧版在 GNOME Wayland 输入无兜底直接拒绝） | 首次截屏/首次输入（Wayland） | portal restore token（会话级） |

## 明确不需要的（常被问）

- **macOS 完全磁盘访问（仅 helper 视角）**：helper 工具面为纯 UI 自动化（56 工具实测清单：窗口/元素/键鼠/剪贴板/截屏/浏览器 CDP/会话，**无文件工具、无 shell**）。文件操作的权限主体永远是**被操控的应用**（保存到桌面=文本编辑在写、移动文件=Finder 在动）。macOS 对桌面/文稿/下载的独立 TCC 门只拦「进程自己直接读」，本链路不触发。**注意主体区分：客户端本体的文件链路（file-server/引擎）按自身身份读盘，FDA 对它是有效授权面（见总表第一行）**。
- **网络入站授权**：daemon 仅监听随机私有 UDS/命名管道，无 TCP 监听；Unix 目录 0700/socket 0600，Windows pipe 使用当前用户 SID ACL 和首实例独占，协议还要求能力文件与 HMAC 端点证明。**同 UID 进程可以读取该用户的 0600 能力文件，这不是同 UID 隔离边界。**

## 授权对象（macOS TCC 按应用身份，授错=无效）

| 环境 | 文件链路的 TCC 身份 | 系统设置 FDA 列表里的显示名 |
|---|---|---|
| 安装版 | `/Applications/Nuwax.app`（file-server/引擎/ttyd 均为其直系子进程或进程本体） | **Nuwax** |
| dev（`npm run base:dev`） | `node_modules` 里的 Electron.app（pnpm 路径随依赖重装/版本变化漂移，TCC 条目随之失效需重授） | **Electron** |
| Computer Use helper | `Nuwax Computer Use.app`（launchd 拉起，独立身份） | Nuwax Computer Use |

三者互不继承。「授权了没看到生效」的第一嫌疑=授错对象（如 dev 环境授给了 Nuwax）；客户端自 v1.0.x 全磁盘访问状态行（设置页，仅 mac）显示以**当前进程身份**实测的真值，可作判别入口（探针=open 系统 TCC.db，macOS 26.6 实证无授权时 Operation not permitted）。

## 边界与治理红线

- **UIPI（Windows）**：目标是管理员权限窗口时，普通权限 helper 被隔离挡住；UWP 应用操控需 uiAccess=true 提升进程（后续分发项）。
- **无人值守**：授权是一次性的，不是障碍；真门槛是**系统锁屏/休眠**（锁屏下 AX 不可达、截屏只得锁屏画面——机器要配不锁屏+防休眠）与**密码/身份验证框**（不该也常不能被自动化替输）。
- **治理红线**：上游工具清单含 `check_for_update`/`install_ffmpeg`；托管驱动策略与 MCP `denyTools` 均拦截，agent 不得调用。
- **一次确认范围**：daemon 使用 `unrestricted` 且跳过逐次审批，工具清单仍受本产品预审 allowlist 与 denylist 限制；关闭、系统撤权、端点/策略校验失败时移除 MCP 并停机。若将来切换 bounded，须重新设计交互与授权记录。

## 权限自检路径

- 产品内：设置页 Computer Use 开关一次确认 → macOS helper 的辅助功能、屏幕录制、直接捕获检查；未完成时返回设置页继续，不再重复客户端确认；
- 产品内：设置页「全磁盘访问」状态行（仅 mac，2026-09-21 批次起）→「去开启 / 检查」（红✗/绿✓ 为当前进程身份实测真值）；
- 工具面：会话内 agent 可调 `check_permissions` 自检（mac/win/linux 均在工具清单）。
