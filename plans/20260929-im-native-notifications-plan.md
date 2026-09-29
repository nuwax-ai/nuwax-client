# 实施计划：IM 原生通知与未读角标

- 状态：仅商业 Nuwax，按最终原生范围完成源码实施和自动验证；签名macOS包及Windows实机验收待进行。
- 对应规格：specs/im-native-notifications.md。
- 当前工作目录：原客户端 /Users/apple/workspace/nuwax-client；PC Web为其nuwax子模块；IM为 /Users/apple/workspace/nuwax-im。用户要求直接在原目录继续，任务增量已三方合并迁回，已有WIP保留；迁移前逐文件快照存于临时migration备份。

1. IM服务端完整聚合和域测试，PC Web仅完成原生通知桥和原开关适配。
2. 商业overlay新增receiver、生命周期、native角标/通知与受信桥。依赖由商业仓根package.json/pnpm-lock.yaml管理，prepare/in-base及发布CI准备后由esbuild打进bundle；社区入口不准备商业依赖，社区身份不初始化receiver。
3. PC Web仅适配通知互斥及原开关forward/hydrate；无新增菜单Badge、页面消息同步或会话点击导航。保持原IM适配pin。
4. 做receiver真实本地WS/HTTP及fake-clock生命周期测试，前端微应用通知合同，IM聚合测试，商业构建；社区基线在一次性副本只读验证，不清原目录overlay。
5. 核查macOS/Windows原生角标、托盘、后台通知与恢复点击；独立报告缺少的签名安装包/真实平台证据。除用户明确要求发布外，不推送或部署。

关键场景：未打开IM即可收取，DND计入数量但不产生无资格弹窗，0清空，99/100边界，托盘/主窗延迟创建补数，突发合并，断网恢复、锁屏睡眠暂停，旧响应/旧点击不跨账号，500+会话完整统计，反复暂停恢复资源不增长。

回退按三个仓库的任务白名单移除；不回退无关WIP，不强推、不改写已pin提交。

## 当前验证结果

| 检查 | 结果 |
| --- | --- |
| 壳商业完整回归 | 范围校正后167文件、2101通过、18跳过 |
| 社区基线 | 此前一次性副本127文件、1534通过、18跳过；本次基座HEAD树与接入前396a45fd完全相同；社区测试只检查回归 |
| IM/原生/IPC复核 | 校正后6文件148通过，含社区身份零请求/零原生展示/零监听检查；此前独立147项verifier PASS |
| 商业依赖/工具链 | 120项Node测试通过；覆盖社区入口不安装、商业缓存失效与失败回收、基座依赖文件保持不变 |
| PC最小适配 | 130 Vitest、60构建管线合同、原Web通知42通过；IM适配tsc零诊断，lint:arch通过 |
| IM服务端 | 40 Maven测试通过；601会话/16分片/中途失败不回写覆盖 |
| 构建 | 商业main/preload production bundle、PC Web及两个微应用完整构建通过 |
| overlay/pin | overlay一致、check:pin及staged纯净守卫通过、diff --check通过 |
| 全库TypeScript | 227条既有诊断，复核诊断集合不变；本次IM新增源码无诊断 |
| 客户端暂存候选 | 按现有发布基座pin导出并只覆盖已暂存overlay：161文件、2037通过、1跳过（排除sandbox-integration）；production main/preload构建通过 |
| PC暂存候选 | 原生开关、消息适配和微应用集成共15文件、86通过；构建管线60通过；lint:arch通过；提交hook后的源码树与验证候选完全一致 |

按用户「社区不需要」校正，88c2e5da依赖增量已用独立本地反向提交830220a3撤回，无历史改写。基座HEAD树与396a45fd完全一致；WS/JSON依赖及锁文件全部移至商业仓根，商业源码均留在overlay。PC/后端/外层任务源码按本次用户请求分别作本地提交，未推送或部署。原工作目录及各自现有分支保持。

校正后日志：/tmp/nuwax-im-commercial-only-20260929.log、/tmp/nuwax-im-commercial-scope-scripts-20260929.log、/tmp/nuwax-im-commercial-scope-native-20260929.log、/tmp/nuwax-im-commercial-scope-build-20260929.log、/tmp/nuwax-im-commercial-scope-tsc-20260929.log。此前社区和服务端日志为/tmp/nuwax-im-community-20260929.log、/tmp/nuwax-im-unread-total-tests-20260929.log。PC产物为nuwax/dist，未同步或发布nuwax-dist产物仓。

真实签名macOS/Windows安装包的Dock/任务栏、托盘、OS通知历史和系统锁屏/唤醒尚未验收；本地HTTP/WS协议和fake-clock生命周期通过不等同这些平台证据。24/72小时耐久运行未执行。通知中心历史由OS管理，本地仅保留最新20个通知回调；不建立自有系统消息列表。

最终修复回归：HTTP非JSON401/403阻断；IM_10402重新登录清旧计数/代次；Windows通知timedOut保留通知中心点击；旧账号WS Cookie镜像迟到失败不停止新账号。基座依赖提交hook的pnpm过滤器未匹配项目，以上完整测试均由显式命令实际执行。

当前运行态排查：使用已登录业务页只读请求测试域 `/api/instant-message/unread-total`，返回 code=0000、total=54、dndTotal=0、unreadConvs=2、authoritative=true。正在运行的商业 Electron 来自另一个 payment-window-runtime 验收目录，其 main bundle 和桥源码均没有 IM receiver；原工作目录新构建含接收器。接口有未读不等于旧进程已经接入，需运行新源码版本再验收原生角标。未读为0清空角标、请求失败不清空最后成功数已在单测覆盖。

提交仅包含本功能的壳/PC/IM源码和文档，共用文件中的电脑列表改动分段保留。既有子模块发布pin属于并行支付工作，本次不回退或替换它们；前端功能以独立本地提交保存，发布整合另行处理。

配套本地提交：IM服务端 `880a201`，PC前端 `90374b7d2`。本仓提交仅保存商业overlay和工具链，不修改现有三个gitlink。

## 提交前质量自查

- 内聚：通过。连接、未读失效、重试与暂停状态由 `overlay/crates/agent-electron-client/src/main/services/imReceiver.ts:42` 统一管理；原生展示由 `imNativePresentation.ts:51` 管理；完整扫描聚合由 IM 后端 `ImSyncApplicationServiceImpl.java:522` 管理。提交候选不含电脑列表业务。
- 分层：通过。`imReceiverRuntime.ts:19` 连接 Electron 会话与传输，receiver不依赖页面；`src/features/client-shell/imNotificationPreference.ts:14` 仅消费宿主通知开关桥，`src/utils/hostBridge/index.ts:401` 保持最小能力检测。商业依赖留在外层，社区入口零请求/零原生展示由专项测试覆盖。
- 维护：通过。`imReceiver.ts:103` / `:136` 对应代次失效与请求、定时器、socket回收；`imNativePresentation.ts:49` / `:50` 固定去重和通知回调上限；服务端 `ConversationMemberRepositoryImpl.java:250` 游标分批扫描，失败传播避免部分统计自愈。接口说明与DB失败行为已对齐，WS事件表和暂停恢复策略写入规格。
- 结论：本功能可本地提交。暂存候选回归与构建通过；真实系统图标、通知历史和耐久运行验收仍按上述证据边界保留，不作为已验收结果。
