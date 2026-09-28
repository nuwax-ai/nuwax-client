# Nuwax 客户端与 PC Web 常驻性能审计及修复记录

日期：2026-09-28。范围包含商业 Electron 壳、主进程/后台服务、主窗口与二级业务窗口、webview，以及 nuwax PC Web（含 AppDev 与 AppDevPro）。

## 当前结论

已实施连接回收、卸载代次失效、隐藏 UI 查询暂停、会话展示缓存归属和预览观察器回收等源码修复。不能据此声称长期运行的所有资源已有硬上界：ComputerServer 业务输出积压、长会话整体投影/DOM、真实 ttyd 暂停协作以及 MCP 活跃日志仍需后续验证或协议能力。

本次把源码修复与安装包验收分开记录。未完成 macOS/Windows 真实安装包的 24/72 小时运行验收；开发构建或单测通过不能代替这些证据。AppDev 已按用户最终要求纳入本次实现。

## 必须保持的业务约束

- 登录/注册、token/cookie/storage、权限、路由和服务启动编排沿用现有逻辑。
- 消息内容、顺序、工具与计划尾包保持完整；通用 SSE 的 await 仍等待流结束，正常完成保留既有 500 ms 尾窗。
- 隐藏策略只暂停 UI 查询与标题观察，不停止正在执行的任务或必要的容器保活。
- 不截断业务 HTML、不通过丢事件或杀 PTY 达到资源限额；日志清理不删除任务文件。
- 商业实现归外层 overlay，中性 ComputerServer/日志改动单独提交基座。保留共享工作区的其他工作。

## 修复清单

| 编号 | 评估与本次实现 | 当前边界 |
| --- | --- | --- |
| R01 | 通用 SSE 同步提供 `.abort`/`.finish`，但 Promise 完成契约不变；每连接独立 watchdog；AppDev 前置/会话两阶段各自持有 controller。取消、错误、卸载真正释放网络，完成保留尾包窗口。 | 60 秒静默监控沿用原值；未增加等待响应头超时。解析/单条回调异常仍不截断后续消息。 |
| R02 | gateway 登记自身的 socket 与在途升级请求，关闭时销毁；关闭幂等，并设 1 秒最终 deadline。 | 只收尾本实例资源；真实应用退出/隧道切换仍需安装包验证。 |
| R03 | ComputerServer 观测真实 `writableLength`/峰值/积压时长/段数，积压期间跳过冗余 ping；每段仅警告一次，drain/close/error 与注销成对解绑。业务帧仍有序完整写入。 | **仅缓解，业务积压没有硬上界。** 无逐事件 id/序号/Last-Event-ID，离线 50 条缓存不能提供完整重放；不能直接断开慢消费者或丢消息。 |
| R04 | AppDevPro envPod 卸载令 generation 失效，迟到成功或节流响应不能重新启动 keepalive。 | 必要保活仍沿用原周期，不接 UI 暂停信号。 |
| R05 | 思考锚点与解析缓存归当前会话展示器，随实例释放；移除节点后清锚点，纯函数兼容入口仅保留当前输入。WeakMap 不延长消息对象寿命。 | 当前会话历史仍保留；没有任意裁掉业务历史。 |
| R06 | 缓存未变消息的词法解析，校验相同对象的 text 变化；胶囊与 renderer 各自持有投影器，保持 active 切换触发原有投影行为。 | **部分优化。** 整体分组/投影仍遍历历史，DOM 未改为虚拟列表；单个长会话没有固定容量上限。 |
| R07 | Embedded 终端按未解析 UTF-8 字节发送 ttyd PAUSE/RESUME，1,000,000/400,000 字节高低水位；write 回调释放预算，断连先 RESUME，旧回调不污染新连接。保留原尺寸握手及 plain 协议。 | **前端控制已接入，服务端配合未验收。** 构建默认 ttyd 1.7.7 的暂停实现存在疑点，当前包是否有补丁待核对；不声称在途数据/单帧已有绝对硬上界。 |
| R08 | 普通预览只观察标题，不序列化正文；失活/宿主隐藏暂停标题观察，恢复不重挂/重载 iframe。重复 load 释放旧文档观察器；导航 timer/尾沿 timer 卸载清理。 | navigate 业务正文上报在隐藏时继续，保持完整 HTML/Markdown、requestId、Nginx 特殊反馈和 500 ms 合批行为。 |
| R09 | AppDevPro tasks/logs UI 查询接宿主可见性；壳的 8 组 IPC 状态查询串行，手动刷新排动作后新查询，恢复补查、隐藏停自动查询，卸载拒绝迟到更新。native:openWindow 与受信 window.open 弹窗独立管理可见性，不进入主窗动作广播。休眠设置成功保存后立即刷新所有窗口。 | 必要服务、任务和容器保活不暂停；失焦不等于隐藏；休眠关闭时全部恢复活跃，开启时按各窗口可见性与锁屏状态决定。设置失败及返回值沿用原逻辑。 |
| R10 | 订阅既有 UserService 登录保存/失效事实，匿名/登录页不启动通知 collect；注销/卸载的迟到 clear 响应不能复活旧轮询。 | 只增加只读订阅，认证存储和导航逻辑不变；真实账号登出重登未操作。 |
| R11 | preload 仅缓存并重播最新 host-activity；动作不重播。guest 订阅前事件、新文档同步与 did-finish-load 均覆盖；壳先订阅再快照，迟到快照不能覆盖新事件。 | 真实 Electron 隐藏加载/重载、锁屏/唤醒仍需实机；已锁屏状态下冷启动的系统查询能力仍有限。 |
| R12 | 主进程启动和每小时异步清理全部 MCP 项目日归档，覆盖已停止项目；30/7 天 TTL，256 MiB 冷归档预算，24 小时 mtime 活跃保护；扫描不重叠，保护 latest/硬链接/非日志/符号链接目标。 | **归档已收敛，活跃日志仍无大小轮转。** installed mcp-proxy-ts 1.5.4 无现成 rotation 开关；不截断仍在写的文件，预算不等于整个日志目录上界。 |

## 原始问题的可复现证据

以下用于证明因果链，不代表生产 CPU/RSS 或增长速率。

- R01：真实本地 HTTP SSE 完成后，旧实现 `onClose=1` 但 signal 未 abort、Promise 仍 pending，后续消息继续到达；并发流共享 watchdog。修复回归覆盖完成尾窗、显式/外部/预先取消、未响应取消、并发、HTTP/网络/消息异常。
- R02：旧 gateway 在临时升级连接未结束时 close 持续等待；销毁实验 socket 后立即完成。新回归覆盖连接隔离、101 前关闭、异步 101、最终 deadline 与幂等。
- R03：停滞 Writable 的 1,000 个约 8 KiB 事件产生约 8.2 MB 待写数据且逐条告警。新测试使用真实 ServerResponse/Socket，慢读取的 8×128 KiB 业务帧完整 wire 比对，证明未丢帧；这不证明业务缓冲有硬上界。
- R04：真实 React/ahooks ensure pending → 卸载 → 成功/节流返回，旧实现重新 run keepalive。新回归验证迟到响应失效及正常挂载仍保活。
- R05：旧模块 Map 经 2,000 个不同思考节点累计后，投影空列表仍保留 2,000 条。新回归覆盖会话隔离、淘汰后清理、原地 text 更新、无 text 消息以及 active 翻转兼容。
- R06：原始合成 10/100/500/1,000 轮投影中位耗时约 0.078/0.682/3.458/6.646 ms；该结果只反映增长趋势。本次没有把这些读数当作浏览器帧耗时或优化后收益。
- R07：xterm 队列达到安全阈值可抛出丢写提示，scrollback 只限制已解析历史。新回归保留 12×120 KiB 有序输出，并验证 PAUSE/RESUME/断连/旧代次与 plain 协议。
- R08：旧普通同源预览在判断是否上报前读取整段 innerHTML。新真实 DOM 回归证明普通预览零正文读取、标题变化有效、隐藏恢复不导航、业务内容完整、重复 load 与卸载回收。
- R12：真实临时目录中，旧顶层清理不会删除停止项目的过期日志；新回归覆盖 TTL、预算、活跃/链接/任务文件、扫描后写入及失败隔离。

## 源码与本地保存边界

实现位于 `/Users/apple/.codex/worktrees/resident-lifecycle/nuwax-client` 的 `codex/resident-lifecycle` 分支；客户端实现提交 `beb8ad3c`。PC Web 在独立 `/Users/apple/workspace/nuwax` 检出提交，并在隔离客户端中更新源码 pin。基座中性修复分支 `codex/resident-lifecycle-base`，实现提交 `42ef6136`；Web 实现提交 `367a6b732e`，客户端源码 pin `2936f6a70` 另保留原有两份恢复计划。产物仓 pin 未冒充更新，没有推送/发版。

完成验证后，已将源码集成提交 `5c428f3f` fast-forward 回 `/Users/apple/workspace/nuwax-client` 的本地 `release/v1.0.x`，更新两个源码子模块并同步商业 overlay。早期重复的任务文件先保存到 scoped stash，并由 `codex/resident-early-copies-20260928` 保护；没有覆盖独立 Web 检出的并行滚动交互 WIP，产物仓仍是原 pin。

共享客户端 checkout 在本次实施期间被外部流程回退到 `9db49113`；此前保存的提交仍由 `codex/local-checkpoint-20260928 @ f34e803e` 保护。集成前逐文件核对共享 root/base，确认其仍保留 checkpoint 的业务恢复输出；隔离分支合并该 checkpoint，保留已有菜单语言、新任务可用性、窗口权限及前端恢复计划，然后统一验证。Web 测试提交 `2c55c5fb06` 同时包含共享索引中另一流程加入的计划文档删除；后续提交使用明确文件列表隔离。

## 验证记录

各组有重叠，不能相加作为独立用例总数。

| 验证 | 结果 | 证据边界 |
| --- | --- | --- |
| PC Web 会话完整合同 | 108 文件 / 1047 通过 | 随后新增 active 兼容用例与 lint 等价收敛另跑定向回归。 |
| Web 生命周期/终端/预览定向整合 | 11 文件 / 61 通过 | 使用真实 HTTP SSE、React/ahooks/Umi；认证及业务 API 部分为 mock。 |
| 独立只读 Web 验证 | 10 文件 / 65 通过 | 独立 agent 未修改文件；覆盖尾包、迟到响应、缓存/预览和终端顺序。 |
| 独立只读基座验证 | 5 文件 / 47 通过 | 真实 HTTP Socket 与临时文件树；确认消息顺序与归档保护。 |
| checkpoint 合并后独立客户端验证 | 9 文件 / 138 通过，0 失败/跳过 | 窗口 policy、新任务 gate、最小尺寸、IPC 信任范围、活动桥/休眠设置与单飞查询；未修改任何文件。 |
| 最后 lint 等价收敛回归 | 4 文件 / 37 通过 | SSE/通知、projection/胶囊；提交 hook 已通过，无绕过。 |
| 客户端定向 | 12 文件 / 160 通过 | gateway、主/二级窗口、受信 popup、桥、信任范围、UI 查询及休眠开关即时同步。 |
| 商业版完整门禁 | 156 文件通过，1 文件跳过；1906 项通过，18 项跳过，0 失败 | 合并 checkpoint 后运行，覆盖原有业务回归及本次修复。 |
| 社区版完整门禁 | 124 文件通过，1 文件跳过；1497 项通过，18 项跳过，0 失败 | 仅在隔离检出清除 overlay 后运行；中性源码保留，随后重新同步商业版。 |
| ComputerServer 分域 | 14 文件 / 106 通过，1 跳过 | 正常/慢写 wire、离线缓存和关闭监听回收。 |
| MCP 日志 | 3 文件 / 26 通过 | 真实临时目录；定向主进程 TypeScript 与生产文件 ESLint 通过。 |
| Web 分层 | 通过，0 新违规 | 97 条既有 baseline 违规被忽略，不称全库无历史违规。 |
| 生产构建 | Web、客户端 main/preload 与 renderer 已通过 | 最终客户端在双轨完成并重同步商业 overlay 后再次构建；产物存在于隔离工作区 dist。 |
| overlay/pin 纯度 | 104 文件一致、0 待同步；check:pin 通过 | 基座全部 dirty 均为商业注入，未把 overlay 托管路径提交进基座。 |
| 类型检查 | 全库 tsc 仍非绿；本次生产源码无新增诊断 | 历史错误与任务新增错误分别核对，不能把存量失败写成全绿。 |
| 真实包/长稳 | 未完成 | 不把源码测试或开发工具 RSS 当作安装包的长期稳定结论。 |

最终双轨命令（隔离检出）：

```sh
npm run base:test -- -- -- --maxWorkers=2 --minWorkers=1
npm run test:commercial -- -- -- --maxWorkers=2 --minWorkers=1
node scripts/in-base.js -- npm --prefix crates/agent-electron-client run build:main
node scripts/in-base.js -- npm --prefix crates/agent-electron-client run build:renderer
node scripts/sync-overlay.js --check
npm run check:pin
```

日志：`/tmp/nuwax-resident-community-full.log`、`/tmp/nuwax-resident-commercial-full.log`、`/tmp/nuwax-resident-client-main-final.log`、`/tmp/nuwax-resident-client-renderer-final.log`。商业首跑因隔离目录缺 MCP 资源缓存，以及旧最小尺寸窗口 mock 未提供 activity 所需的实际窗口接口失败；链接已有缓存并补齐 mock 后完整重跑通过，未删减原有成功/尺寸断言。

## 质量三问

1. **内聚**：连接的 watchdog/controller/finish 由连接持有；UI 查询的在途/排队/timer/代次由 uiStatusPoller 持有；投影器回收锚点与弱缓存；日志 runner 管理不重叠扫描。不存在第二条任务/登录启动链。
2. **分层**：商业实现只经 overlay 注入；ComputerServer/日志中性源码独立提交并通过 staged pin 守卫；PC Web 沿页面→组件→hooks/services/utils 接入，分层检查无新违规。
3. **可维护**：资源建立与清理配对，具名水位/归档预算，旧宿主/浏览器兜底；真实依赖与生命周期回归覆盖竞态。修正 active 翻转兼容边界，保留必要业务尾包和保活。

结论：本轮源码修复已完成双轨、生产构建和本地集成；尚不能宣称全部资源预算已达标或已通过发行包长期验收。

## 后续长期验收

用固定源码/产物版本的真实 macOS 与 Windows 安装包做 24 小时初验、72 小时复验；PC Web 用生产构建对照。覆盖空闲、托盘/锁屏、运行任务、100 次页面切换、慢网络、断网恢复、睡眠唤醒、二级窗口隐藏/关闭、登出重登和应用退出。

分进程低频记录 CPU、RSS、JS heap、GPU/子进程、连接/句柄/timer/listener、缓存实例/字节、待写队列及日志/数据库体积。预热后同场景应趋于平台，关闭资源后回到约定数量；隐藏 UI 停高频查询，任务继续，恢复不重复建流，退出具有生效 deadline。产品预算需从发布包基线制定。

R03 的完整重放/慢端预算、R06 的历史窗口化、R07 的真实 ttyd 配合和 R12 活跃日志 rotation，应作为明确未完成项继续跟踪。
