# IM 接收恢复修复

用户报告：客户端长时间运行后，菜单未读气泡与 IM、系统通知失去同步，重启恢复；需核对各平台的重试和网络恢复。

## 已确认与边界

- 菜单未读与原生通知由跨平台主进程 IMReceiver 共用连接；已有握手超时、PONG 超时、指数重连、离线探测及恢复补拉。
- `imReceiverRuntime` 唤醒时只置锁、不清锁；漏收解锁事件后，接收器可能一直暂停。
- 未读请求临时失败仅等待前台 120 秒、后台 300 秒的兜底，没有独立退避重试。
- 当前本机日志未提供足以认定原始故障根因的证据，原始长时间失联不能直接标记已修复。
- IM 原仓按 `specs/im-native-notifications.md` 的维护边界只读核对，不改动子模块或后端。此前浏览器标题栏样式改动保留。

## 实施

1. 为唤醒时遗留锁屏状态、漏解锁事件、未读临时失败建立回归证据。
2. 以系统当前 idle 状态校正锁屏门禁；保留 unknown/查询失败时的已有门禁。增加会话内本地状态校验，睡眠期间不做校验和网络操作，退出时清理。
3. 未读请求临时失败保留最后成功值，使用 1/2/4/8/16/30 秒封顶退避；成功重置，保留 authoritative=false 的每分钟上限。认证/配额阻断及账号代次隔离保持原契约。
4. 检查断网恢复、半开连接、持续重连、长时间保活，以及 macOS/Windows/Linux 的通知呈现测试；跑类型检查和商业质量门。

## 验收限制

自动化覆盖共用状态机与本地 HTTP/WS 链路。真实 macOS 长时间挂机及睡眠、Windows/Linux 安装包、系统通知中心送达仍需实机证据，不能用平台模拟测试代替。

官方 API 核对（read-docs）：[Electron powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor)；idle 状态可能为 active/idle/locked/unknown，locked 仅部分系统支持。

## 当前验证结果与 IM 交接

- 新增 4 条回归先失败，修复后通过；本地 HTTP/WS 验证未读接口 503 后自动恢复气泡及原生角标，通知不重复。
- 共享接收器通过模拟 24 小时后台保活、3 小时离线后自动恢复测试；这是模拟时间，不是实机挂机。
- `npm run test:commercial`：302 文件，3720 通过、1 项既有跳过；`npm run typecheck` 通过。随后扩充 macOS/Windows/Linux 呈现分支，单独运行 `imNativePresentation.test.ts`，32 项通过。
- 无在线 Windows/Linux 验证设备；尚未构建、发布安装包或完成真实系统通知送达验收。
- IM 页面独立 `ImSocket.ts` 只发送 PING，未用 PONG 超时淘汰半开连接；CONNECT 等待也没有 ACK 超时。已在隔离的假 WS 测试中分别复现：无 close 事件时四个心跳周期后仍 connected，以及一分钟无 ACK 后仍 connecting。
- IM 维护方可从客户端根运行 `node scripts/acceptance/im-page-recovery-audit.cjs`。该脚本只读取上游 IM 原源码，在临时目录编译测试；原源码的两项预期行为仍失败，不属于商业壳测试失败。PC 网页随后通过宿主适配补丁修复了这两项，见下节；上游 IM 子模块未修改。
- 原始“长时间开启后整体失效”仍待实机闭环；当前已修复客户端及 PC 网页中可独立复现的恢复缺口，不能将模拟时钟或本地故障夹具当作多平台长期挂机验收。

## PC 网页继续处理（用户已授权）

在 `/Users/apple/workspace/nuwax` 的 `codex/pc-web-im-recovery` 分支通过正式 message 适配补丁修复连接；不改上游 IM 仓、后端、子模块 pin 或客户端前端 pin，保留现有无关文件。补齐 WS/CONNECT 10 秒握手超时、协商心跳 3 周期 PONG 失联检测、退避重连、离线等待及 online/返回前台恢复，并覆盖卸载、认证阻断与旧连接隔离。宿主未打开 IM 时补齐未读校准及失败重试。验证正式补丁后的源码、微应用生产构建、宿主受影响测试与架构门，并用 ego-browser 对本地 HTTP/WS 故障夹具做浏览器验收。当前任务不包含上线部署。

PC 网页验证已完成：

- 正式适配后的连接测试、微应用生命周期和导航测试：17 文件、168 项通过；随后补充服务重启指令与真实 store 重连刷新未读的断言，相关两文件 30 项通过（新增 3 项）。覆盖模拟 24 小时保活、3 小时离线、认证/配额拒绝及卸载清理。
- `sync:micro-apps`（含 message TypeScript 和生产构建）、主站 production 构建通过；架构门无新增违规，分域类型门通过。全库 TypeScript 存量诊断仍在，修改路径无诊断。
- ego-browser Space 10 使用正式适配的 ImSocket 和真实宿主未读服务、本地 HTTP/WS 服务端与浏览器原生 WebSocket，验证无 PONG/close、无 CONNECT_ACK、CDP 断网/联网、真实页面冻结超过三心跳后恢复，以及 HTTP 503 后未读自动重试，均通过。恢复后补回消息与气泡，保持一条连接；这是本地故障验收，不是线上账号收发或真实长时间挂机。
- 浏览器验证 Space 和本地服务已关闭，构建产生的 tracked dist 变动已恢复，原有 image.png 保留。改动保留在前端个人分支工作区，尚未提交、推送或部署；客户端现有修复与源码/产物 pin 均未被覆盖。
