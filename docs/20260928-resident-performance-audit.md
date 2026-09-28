# Nuwax 客户端与 PC Web 长期常驻性能审计

日期：2026-09-28。范围：商业 Electron 主进程、宿主窗口/webview、后台服务、loopback gateway，以及 nuwax PC Web 的会话、IDE、应用预览、终端、连接和轮询。

## 当前处理范围（复评与业务优先级调整）

当前审计与修复范围包括商业客户端、PC Web 核心会话以及 AppDev / AppDevPro。R04 的 AppDevPro 环境保活、R09 中 AppDevPro 的任务/日志轮询，以及 R01 的 AppDev 专属 controller 接线均纳入当前范围。后续重构不作为暂缓这些生命周期问题的理由。

共享实现统一评估并验证各入口：通用 SSE 用于智能体优化、工作流试运行和 AppDev；EmbeddedConsoleTerminal 用于 Chat、ConversationAgent、EditAgent 和 AppDevPro；PagePreviewIframe 用于 Chat、应用标签、智能体详情和开发预览。同名日志 hook 按路径分别检查 AppDevPro/hooks 与 ConversationAgent/hooks，避免遗漏独立生命周期。

复评确认 R01、R02 和 R04 的具体生命周期缺陷，但当前处理优先级以本节为准。R03 是慢消费者负载下的缓冲风险；R06、R08、R09 和 R12 需结合实测确定优化投入。现有缓存有数量限制，终端有队列阈值，不能将整份清单统称为正常空闲时的持续内存泄漏。

## 结论与证据边界

当前存在连接不能真正关闭、慢消费者缓冲持续积累、卸载后重新保活等可复现问题。已有的页面缓存数量限制和部分休眠策略有效，但尚不足以保证长期常驻时的资源上界。

本次完成源码走查、受控模拟和针对性既有测试；没有完成真实安装包的 24/72 小时运行验收。模拟结果用于证明具体因果链，不代表实际 CPU、RSS 或泄漏速度。审计新增本文件，业务源码未由本次审计修改；工作区原有及并行品牌/设备 ID 改动应分别保留。

主审版本：客户端分支 `release/v1.0.x`，基座 `52bd898f97d0a22e2d677a1c4bffab8fbeac2cf5`，前端 submodule `1b6005d1ea01e4013315af00693a0bf1de8abfcd`。独立 PC Web checkout `/Users/apple/workspace/nuwax` 为 `feat-dong.0930 @740bc44896c6536fdd811b724cf0beacfbf853f8`。报告涉及的前端连接、缓存、渲染和终端核心文件已比较，两处相关实现一致；不能据此推断整个前端或线上部署完全一致。商业定制以外层 `overlay/` 为源码归属。

P1 表示优先修复的资源或退出可靠性问题；P2 表示常驻开销、生命周期覆盖或性能上界问题。以下清单均给出触发条件，不把正常有界缓存或运行任务的必要连接直接判为泄漏。

## 审计发现（处理范围以本节前的业务调整为准）

| 编号 | 优先级 | 问题 | 证据 |
| --- | --- | --- | --- |
| R01 | P1 | 旧通用 SSE 的关闭没有实际 abort；并发连接互相清除超时监控 | 受控模拟复现 |
| R02 | P1 | gateway 未销毁升级后的 WebSocket，关闭可永久等待 | 临时隔离连接复现 |
| R03 | P1 | ComputerServer SSE 忽略写入背压，慢客户端使主进程缓冲持续增长 | 停滞 Writable 模拟复现 |
| R04 | P2，确定缺陷 | IDE 环境初始化迟到响应在页面卸载后重新启动保活 | 生命周期复现；纳入当前修复批次 |
| R05 | P2 | 思考耗时 Map 脱离页面回收，SPA 生命周期内持续累计 | 投影模拟复现 |
| R06 | P2 | 长会话反复全文投影，历史内容和 DOM 无窗口上界 | 源码与合成耗时实验 |
| R07 | P2 | 当前底部终端缺少背压，输入队列积压后可丢输出 | 源码与 xterm 队列模拟 |
| R08 | P2 | 隐藏的同源预览仍观察全文并序列化 HTML | 源码因果链 |
| R09 | 待测，策略项 | IDE 任务/日志轮询、壳状态查询和二级窗口均保留评估 | 源码因果链；后台任务保活单独决策 |
| R10 | P2 | 通知轮询没有登录门，登录页仍持续请求 | 源码因果链 |
| R11 | P2 | 隐藏时新建/重载 guest 的休眠初态可能被桥丢弃 | 跨层源码时序；待真机补验 |
| R12 | P2 | MCP 项目日志缺少跨项目 TTL、单文件及目录总量预算 | 当前随包实现与主进程清理源码 |

### R01：通用 SSE 关闭与超时监控

[fetchEventSource.ts:82](/Users/apple/workspace/nuwax-client/nuwax/src/utils/fetchEventSource.ts:82) 的关闭函数延迟 500 ms 后只设置标记、清定时器并通知 UI，真正的 `controller.abort()` 被注释。该函数还在等待整个流结束后才返回取消句柄（158、250 行）；后续消息没有因关闭标记而被拦截。新流启动会清除模块共享 watchdog（100、109 行）。可达入口包括智能体优化、工作流试运行、ChatTemp，以及 AppDev 前置 AI chat；[useAppDevChat.ts:145](/Users/apple/workspace/nuwax-client/nuwax/src/hooks/useAppDevChat.ts:145) 的对应 controller ref 未被创建/赋值。

模拟完成事件并推进 500 ms：`onClose=1`、`signal.aborted=false`、取消句柄 Promise 仍 pending，后续消息依然分发。两条流并发并静默 60 秒：只有第二条被中止，第一条的 watchdog 已被清掉。异常路径已有真正 abort，不能覆盖完成/取消路径。

建议同步提供每连接取消句柄，显式取消应实际 abort 网络，每连接独立 watchdog；完成事件的断流时机需保留协议尾部消息。共享入口与 AppDev 两阶段请求的专属 controller 接线均纳入修复范围。主会话使用的 `fetchEventSourceConversationInfo.ts` 已有独立实现，可参考。

### R02：gateway 关闭等待升级连接

[gateway.ts:677](/Users/apple/workspace/nuwax-client/overlay/crates/agent-electron-client/src/main/services/loopbackGateway/gateway.ts:677) 只调用 `server.close()` 和 `closeAllConnections()`，没有登记并销毁升级后的 socket。持续 WebSocket 可使关闭 Promise 无法结束。[main.ts:897](/Users/apple/workspace/nuwax-client/overlay/crates/agent-electron-client/src/main/main.ts:897) 在 gateway 收尾完成后才执行 `app.exit()`；超时预算仅在等待之后检查，不能截断此次等待。gateway 的串行生命周期队列也可能因此阻塞后续刷新。

隔离实验建立临时 WebSocket 后调用关闭，350 ms 后仍未完成，客户端和上游仍存活；销毁实验 socket 后关闭立即完成。350 ms 不是生产超时指标，它证明关闭仍依赖外部连接结束。

建议记录本实例的升级连接，停止接入后销毁客户端/上游 socket，并为整个关闭流程提供实际生效的最终 deadline。

### R03：ComputerServer SSE 缓冲

[sseManager.ts:426](/Users/apple/workspace/nuwax-client/nuwa-electron-shell/crates/agent-electron-client/src/main/services/computer/sseManager.ts:426) 在 `client.write(payload)` 返回 false 时仅告警，仍发送后续事件及心跳。没有按待写字节限额降载或移除慢客户端。跨隧道慢链路、暂停读取或半开连接下，持续任务输出可积累在 Electron 主进程。已有每会话最多 50 条离线事件的限制，但已连接客户端的 Writable 缓冲不受该限制。

模拟 `highWaterMark=1024` 的停滞 Writable，100 个约 8 KiB 事件产生 822,700 字节待写数据；1,000 个产生 8,227,000 字节，告警 1,000 次但客户端仍被保留。这是受控写入模型，不是生产流量速率。

建议按客户端设置待写字节和等待时间预算；背压时暂停/合并可恢复事件，超限断开慢客户端并通过现有恢复协议补齐。不能简单丢弃业务消息。

### R04：卸载后重新启动容器保活（AppDev 专属，纳入当前批次）

[useUserAppEnvPod.ts:47](/Users/apple/workspace/nuwax-client/nuwax/src/pages/AppDevPro/hooks/useUserAppEnvPod.ts:47) 初始化递增 generation，但 cleanup 只 cancel 保活，没有使在途 ensure 失效。迟到成功或节流响应仍可通过代次检查并运行 60 秒保活（85–105 行）。ahooks 的卸载 cancel 不能阻止之后再次调用 run。

受控顺序为：ensure pending → 卸载 cancel → resolve 成功 → `runKeepalive(afterUnmount)`。已有代次检查能防环境/会话切换，漏掉最终卸载。

建议卸载递增 generation 或设置 disposed，并在所有重新启动保活的分支复核生命周期。是否继续维持远端运行任务，应由独立的任务所有者决定。普通路由失活已有代次保护，本项触发边界是请求未完成时直接卸载。

### R05：思考锚点累计

[projectConversation.ts:62](/Users/apple/workspace/nuwax-client/nuwax/src/features/conversation/presentation-v2/projectConversation.ts:62) 的模块级 `thinkTimingAnchors` 每个思考节点加入记录，唯一 clear 是测试入口。页面卸载、会话删除和 LRU 淘汰不能释放。每条记录较小，但数量随新任务累计。

模拟 2,000 个不同节点的 thinking→finished 后保留 2,000 条；随后投影空消息列表仍为 2,000 条。建议归属到会话实例，随实例淘汰释放，并给终态记录容量或 TTL。

### R06：长会话计算与 DOM

[ConversationRendererV2.tsx:315](/Users/apple/workspace/nuwax-client/nuwax/src/features/conversation/presentation-v2/react/ConversationRendererV2.tsx:315) 对变化的 messageList 重新投影整段历史，349 行渲染全部轮次；[selectProgressCapsule.ts:161](/Users/apple/workspace/nuwax-client/nuwax/src/components/business-component/UnifiedChatSession/components/ConversationProgressCapsule/selectProgressCapsule.ts:161) 再投影一次。历史加载不裁剪消息。页数限制不能约束单页消息量。

已有 TurnRow memo 和 Markdown rAF/差量 push 优化，应保留。建议先缓存未变消息的解析和终态轮投影、让胶囊复用投影，再做历史轮虚拟列表；为历史数据、预览内容分别设资源预算。

合成 Node 实验每轮 USER+ASSISTANT、约 2 KB 正文与思考标签，预热 10 次、采样 40 次：10/100/500/1,000 轮的中位投影耗时为 0.078/0.682/3.458/6.646 ms，P95 为 0.106/0.815/4.311/7.547 ms。它说明随内容增长的计算成本，不等价于浏览器帧耗时。

### R07：终端大量输出

Chat 和 AppDevPro 底部控制台实际使用 [EmbeddedConsoleTerminal.tsx:577](/Users/apple/workspace/nuwax-client/nuwax/src/components/business-component/Terminal/EmbeddedConsoleTerminal.tsx:577)，直接 `term.write(data)`，没有 ttyd PAUSE/RESUME 或待解析字节预算。5,000 行 scrollback 仅限制已解析的滚动内容。另一套 `Terminal/index.tsx:260` 已有背压，可提为共享能力。

当前 xterm 队列模拟连续写入 1,000,000 字符块，51 块入队后下一次写入抛出 `write data discarded, use flow control to avoid losing data`。存在安全阈值，因此不能称该队列无限增长；达到阈值会丢显示输出。隐藏页面断连、卸载 dispose 已存在，应保留。

### R08：隐藏预览持续抽取全文

[PagePreviewIframe/index.tsx:433](/Users/apple/workspace/nuwax-client/nuwax/src/components/business-component/PagePreviewIframe/index.tsx:433) 对可访问的同源 body 子树观察变化。回调 500 ms 合批后先读取完整 `innerHTML`（394 行），再判断是否需要上报（412 行）。普通预览也会进行这次抽取；缓存容器 CSS 隐藏未将 active 传到底层，所以动态隐藏预览仍可能执行全文序列化。

跨域读取失败会退出，卸载会 disconnect，缓存数量也有限；本项适用于可访问的同源动态页面。建议失活暂停观察，仅标题需求观察 title，需要上报时才抽取正文，并限制长度和频率。

### R09：后台策略覆盖缺口

主窗口已有 hostActivity 事件；全局通知、会话恢复和积分余额已消费。缺口包括 AppDevPro 的 [tasksActive:76](/Users/apple/workspace/nuwax-client/nuwax/src/pages/AppDevPro/hooks/useUserAppTasksActive.ts:76) 与 [devLogs:217](/Users/apple/workspace/nuwax-client/nuwax/src/pages/AppDevPro/hooks/useConversationAgentDevLogs.ts:217) 的 5 秒轮询，及 envPod 的 60 秒保活，仅依赖 route active / document.hidden。宿主最小化或锁屏时 route active 不变，webview 也不能只依赖 document 可见性。

壳 [App.tsx:1535](/Users/apple/workspace/nuwax-client/overlay/crates/agent-electron-client/src/renderer/App.tsx:1535) 每 5 秒并行查询 8 个服务状态，无应用级可见性降频或在途互斥；它本身有卸载清理，属于固定后台开销和慢响应重叠风险。独立业务窗口 [nuwaxBridgeHandlers.ts:792](/Users/apple/workspace/nuwax-client/overlay/crates/agent-electron-client/src/main/ipc/nuwaxBridgeHandlers.ts:792) 未接主窗口休眠通道。

建议统一 UI 轮询许可为路由激活、页面可见与宿主可见；状态查询优先事件推送、后台低频核对并限制在途请求。远端任务/容器保活应单独决策，避免暂停任务执行。Electron 默认提供后台计时器节流，但仍[建议隐藏时主动暂停昂贵操作](https://www.electronjs.org/docs/latest/api/browser-window#page-visibility)，不能把节流当作资源释放保证。

### R10：未登录通知轮询

[app.tsx:384](/Users/apple/workspace/nuwax-client/nuwax/src/app.tsx:384) 注释称登录后启动，但实际只排除壳预览页。根 AppContainer 挂载 GlobalEventPolling，[useEventPolling.ts:110](/Users/apple/workspace/nuwax-client/nuwax/src/hooks/useEventPolling.ts:110) 自动首跑、5 秒间隔且无限错误重试。SPA 登出不卸载根组件；未登录响应处理只抑制重复导航。隐藏态已有暂停，但可见登录页仍持续 collect。

建议由可订阅登录态控制挂载/ready，失效立即 cancel；异步事件处理结束后重新启动轮询前复核登录态及实例是否仍有效。本次未操作真实用户登出。

### R11：隐藏初态没有重播

[hostActivity.ts:116](/Users/apple/workspace/nuwax-client/nuwa-electron-shell/crates/agent-electron-client/src/main/services/hostActivity.ts:116) 在 guest attach 时发送一次 visible=false；[webviewPerfBridge.ts:246](/Users/apple/workspace/nuwax-client/overlay/crates/agent-electron-client/src/preload/webviewPerfBridge.ts:246) 只调用当前 handler，没有保留最新状态。handler 在前端布局 effect 中注册，hostVisibility 初值为 true。隐藏期间新建 guest 时，初态事件若早于 handler 注册便被丢弃；同一 guest 重载文档时，前端状态重置，attach 又不会因此再次触发，当前代码也没有文档 ready 后补发。之后没有可见性变化时，页面可持续按可见运行。

建议 preload 保存并在订阅时重播最新 host-activity，或由 guest ready 主动读取宿主状态；跨文档重载也要补初态。本项为代码时序风险，现有主进程单测只断言发送，尚未做真实隐藏重载验收。

### R12：MCP 项目日志没有全局预算

[mcp.ts:1003](/Users/apple/workspace/nuwax-client/nuwa-electron-shell/crates/agent-electron-client/src/main/services/packages/mcp.ts:1003) 将日志目录和项目 ID 提供给 Host Adapter。当前随包代理将日志写入 `logs/mcp-proxy/<project>/<server>-<date>.log`，只保留当前目录、当前 server 最近 7 个日文件，没有单文件大小上限；停用项目不再启动，也不触发其日志清理。主进程 [logConfig.ts:148](/Users/apple/workspace/nuwax-client/nuwa-electron-shell/crates/agent-electron-client/src/main/bootstrap/logConfig.ts:148) 只遍历 logs 顶层文件，不递归覆盖这些项目目录。

长期新增项目时，旧目录和日志可持续保留。建议统一项目日志 TTL、总目录预算和单文件大小轮转；运行任务所需文件应与日志分别管理。本项已确认清理规则覆盖缺口，尚未测量真实磁盘增长速率。依据当前随包适配器实现，依赖升级后需重新核对。

## 已有有效回收机制

- style3 整页最多 5 个，IDE 最多 2 个；隐藏终态页 60 秒释放，离开适用布局及登出/删除有失效机制。应用入口最多 5 个标签。VNC 单实例策略已有实现。
- 主会话新 SSE 同步提供 abort，真正中断网络，watchdog 按连接管理；恢复轮询消费宿主可见性，终态降频，离开取消轮询/流。
- Embedded 终端断连清心跳和重连 timer，卸载断开 ResizeObserver、dispose xterm/addon；旧 socket 回调有身份校验。
- 主要事件总线、主题、visibility 监听成对注销；商业鉴权有会话代次保护，避免迟到注册覆盖新会话。
- 主日志和 PERF 日志已有轮转/保留机制，MCP tail 的停止也有 interval 回收。全局跨项目日志/缓存总量及 SQLite 长期体积仍需实包观测，不能仅凭单目录保留规则判定磁盘预算达标。

## 已完成验证

直接在当前已注入 checkout 跑定向 Vitest，未调用会清 overlay 的 `base:test`：

```sh
# 工作目录：/Users/apple/workspace/nuwax-client/nuwa-electron-shell/crates/agent-electron-client
pnpm exec vitest run src/main/services/hostActivity.test.ts src/main/services/system/webviewPolicy.test.ts src/main/bootstrap/logConfig.test.ts src/main/bootstrap/stopManagedProcesses.test.ts --maxWorkers=1 --minWorkers=1
# 4 文件 / 48 测试通过

# 工作目录：/Users/apple/workspace/nuwax-client/nuwax
pnpm exec vitest run src/features/conversation/runtime/fullPageInstanceCacheManager.test.ts src/layouts/SidebarShell/ClientConversationKeepAlive.test.tsx src/services/hostVisibility.test.ts src/services/hostBridgeEvents.test.ts tests/openedAppTabsKeepAlive.test.tsx tests/conversationDetailsKeepAlive.test.tsx --maxWorkers=1 --minWorkers=1
# 6 文件 / 41 测试通过
```

缓存/渲染专项另跑 4 文件、62 项既有测试通过；服务专项另跑 7 文件、110 项通过。它们和上面存在重叠，不累加为独立总数。受控模拟读取当前源码，通过内存转译/构建加 VM 执行，mock 传输或计时器；gateway 实验使用独立临时连接。没有使用业务任务、真实终端命令或用户登出来复现。

ego-browser 的独立审计空间成功打开 `localhost:3001` 已登录首页；进入既有 IDE 时出现资源加载异常，随后端口连接被拒绝，没得到可比的切换前后内存样本。开发服务的编译内存不能当作发布客户端的常驻内存。工具提示 Ego Lite 0.5.1.11 有更新，本次未升级工具。

## 修复与长期验收顺序

1. 当前优先处理 R02 gateway 连接收尾与有效退出 deadline、R01 通用及 AppDev SSE 的显式取消与独立 watchdog、R04 卸载后迟到响应失效；同批设计 R03 慢消费者预算与恢复完整性。
2. 核心会话、AppDevPro 任务/日志轮询、共享终端/预览、宿主隐藏初态和登录态轮询继续评估；根据真实生产构建的测量结果决定渲染与后台轮询改造幅度。隐藏时优先暂停 UI 工作，必要的运行任务与保活单独决策。
3. 用固定源码版本的真实安装包做 24 小时初验、72 小时复验，分别覆盖 macOS/Windows；PC Web 使用生产构建对照。执行空闲、托盘/锁屏、运行任务、100 次页面切换、慢网络、断网恢复、睡眠唤醒、登出重登、关二级窗口和退出。
4. 分进程低频记录 CPU、RSS、JS heap、GPU/子进程、连接、句柄、timer/listener、缓存实例/字节、待写队列及日志/数据库体积。预热后同一场景应趋于平台，关闭资源后数量回到约定上界；登录页无鉴权轮询，隐藏 UI 无高频状态查询，任务正常继续，恢复无重复流，退出有明确 deadline。

CPU、内存和磁盘的具体产品预算需从发布包空闲/典型任务基线制定，本报告不把开发环境单次读数作为合格阈值。
