# 实施计划：IM 原生通知与未读角标

- 状态：仅商业 Nuwax，按现有 IM 接口接入；IM 仓库由其他团队负责，用户已回滚此前越界提交。签名macOS包及Windows实机验收待进行。
- 对应规格：specs/im-native-notifications.md。
- 当前工作目录：原客户端 /Users/apple/workspace/nuwax-client；PC Web为其nuwax子模块。IM源码 /Users/apple/workspace/nuwax-im 仅用于只读核对接口，不属于本功能的修改、提交、推送或部署范围。用户要求直接在原目录继续，已有WIP保留。

1. 只读核对既有IM设备注册、WS、unread-total及会话详情接口，PC Web仅完成原生通知桥和原开关适配。
2. 商业overlay新增receiver、生命周期、native角标/通知与受信桥。依赖由商业仓根package.json/pnpm-lock.yaml管理，prepare/in-base及发布CI准备后由esbuild打进bundle；社区入口不准备商业依赖，社区身份不初始化receiver。
3. PC Web仅适配通知互斥及原开关forward/hydrate；无新增菜单Badge、页面消息同步或会话点击导航。保持原IM适配pin。
4. 做receiver真实本地WS/HTTP及fake-clock生命周期测试、前端微应用通知合同和商业构建；社区基线在一次性副本只读验证，不清原目录overlay。不运行IM后端修改或发布流程。
5. 核查macOS/Windows原生角标、托盘、后台通知与恢复点击；独立报告缺少的签名安装包/真实平台证据。除用户明确要求发布外，不推送或部署。

关键场景：未打开IM即可收取，角标只用total（免打扰会话不计入，不累加dndTotal）且DND会话不产生无资格弹窗，0清空，99/100边界，托盘/主窗延迟创建补数，突发合并，断网恢复、锁屏睡眠暂停，旧响应/旧点击不跨账号，反复暂停恢复资源不增长。现有服务端扫描上限及统计完整性不由客户端改写或补算。

回退只针对商业壳与PC宿主适配的任务白名单；不回退无关WIP，不强推、不改写已pin提交。禁止恢复或再次推送用户已回滚的IM提交。

## 验证证据

以下完整回归和构建为本次边界调整前的记录；本次现有接口兼容检查另列，不将已回滚的IM服务端测试作为当前验收依据。

| 检查 | 结果 |
| --- | --- |
| 壳商业完整回归 | 范围校正后167文件、2101通过、18跳过 |
| 社区基线 | 此前一次性副本127文件、1534通过、18跳过；本次基座HEAD树与接入前396a45fd完全相同；社区测试只检查回归 |
| IM/原生/IPC复核 | 校正后6文件148通过，含社区身份零请求/零原生展示/零监听检查；此前独立147项verifier PASS |
| 商业依赖/工具链 | 120项Node测试通过；覆盖社区入口不安装、商业缓存失效与失败回收、基座依赖文件保持不变 |
| PC最小适配 | 130 Vitest、60构建管线合同、原Web通知42通过；IM适配tsc零诊断，lint:arch通过 |
| 构建 | 商业main/preload production bundle、PC Web及两个微应用完整构建通过 |
| overlay/pin | overlay一致、check:pin及staged纯净守卫通过、diff --check通过 |
| 全库TypeScript | 227条既有诊断，复核诊断集合不变；本次IM新增源码无诊断 |
| 客户端暂存候选 | 按现有发布基座pin导出并只覆盖已暂存overlay：161文件、2037通过、1跳过（排除sandbox-integration）；production main/preload构建通过 |
| PC暂存候选 | 原生开关、消息适配和微应用集成共15文件、86通过；构建管线60通过；lint:arch通过；提交hook后的源码树与验证候选完全一致 |
| 本次现有接口兼容 | receiver、真实本地HTTP/WS、原生展示共3文件82通过；新增null/缺省用例修复前均失败，修复后通过 |

按用户「社区不需要」校正，88c2e5da依赖增量已用独立本地反向提交830220a3撤回，无历史改写。当时基座HEAD树与396a45fd完全一致；WS/JSON依赖及锁文件全部移至商业仓根，商业源码均留在overlay。商业壳与PC宿主适配已按此前请求提交并推送；IM此前越界提交已由用户回滚，本功能不再包含IM服务端增量。原工作目录及各自现有分支保持。

此前客户端日志：/tmp/nuwax-im-commercial-only-20260929.log、/tmp/nuwax-im-commercial-scope-scripts-20260929.log、/tmp/nuwax-im-commercial-scope-native-20260929.log、/tmp/nuwax-im-commercial-scope-build-20260929.log、/tmp/nuwax-im-commercial-scope-tsc-20260929.log；社区日志为/tmp/nuwax-im-community-20260929.log。PC产物为nuwax/dist；本功能当时未同步或发布nuwax-dist产物仓。

真实签名macOS/Windows安装包的Dock/任务栏、托盘、OS通知历史和系统锁屏/唤醒尚未验收；本地HTTP/WS协议和fake-clock生命周期通过不等同这些平台证据。24/72小时耐久运行未执行。通知中心历史由OS管理，本地仅保留最新20个通知回调；不建立自有系统消息列表。

最终修复回归：HTTP非JSON401/403阻断；IM_10402重新登录清旧计数/代次；Windows通知timedOut保留通知中心点击；旧账号WS Cookie镜像迟到失败不停止新账号。基座依赖提交hook的pnpm过滤器未匹配项目，以上完整测试均由显式命令实际执行。

此前运行态排查：使用已登录业务页只读请求测试域 `/api/instant-message/unread-total`，返回 code=0000、total=54、dndTotal=0、unreadConvs=2、authoritative=true。当时运行的商业 Electron 来自另一个 payment-window-runtime 验收目录，其 main bundle 和桥源码均没有 IM receiver；原工作目录新构建含接收器。接口有未读不等于旧进程已经接入，需运行新源码版本再验收原生角标。未读为0清空角标、请求失败不清空最后成功数已在单测覆盖。

本功能后续提交仅包含壳/PC宿主适配与本仓文档。此前共用文件中的电脑列表改动已分段保留；本次边界修正继续保留其他任务改动和既有子模块pin，发布整合另行处理。

有效配套提交：商业壳 `394ebea6`，PC前端 `90374b7d2`。IM越界提交 `880a201` 及合并提交 `76f1e8b` 已由用户回滚；不得作为依赖、发布前提或重新推送。本仓边界修正不修改现有三个gitlink。

现有接口兼容：只读核对用户回滚后的IM源码（本次检查HEAD为757bcf0），设备注册、WS、unread-total及通知元数据接口均已存在。角标只展示接口提供的total（不含免打扰，2026-10-09 与后端确认），不累加dndTotal；不新增接口或全会话扫描。

本次日志：/tmp/nuwax-im-existing-api-red-20260929.log（修复前51通过、2失败）；/tmp/nuwax-im-existing-api-green-20260929.log（修复后82通过）。本次仅更新商业receiver及回归测试、本仓intent/spec/plan；IM仓库HEAD和工作区与检查前一致。

## 提交前质量自查

- 内聚：通过。连接、未读失效、重试与暂停状态由 `overlay/crates/agent-electron-client/src/main/services/imReceiver.ts:42` 统一管理；原生展示由 `imNativePresentation.ts:51` 管理。现有接口的可空统计兼容也留在receiver内，不改IM服务端。
- 分层：通过。`imReceiverRuntime.ts:19` 连接 Electron 会话与传输，receiver不依赖页面；`src/features/client-shell/imNotificationPreference.ts:14` 仅消费宿主通知开关桥，`src/utils/hostBridge/index.ts:401` 保持最小能力检测。商业依赖留在外层，社区入口零请求/零原生展示由专项测试覆盖。
- 维护：通过。`imReceiver.ts:103` / `:136` 对应代次失效与请求、定时器、socket回收；`imNativePresentation.ts:49` / `:50` 固定去重和通知回调上限。WS事件表、暂停恢复策略、可空统计和IM只读维护边界写入规格；客户端不维护服务端扫描或自愈逻辑。
- 结论：本功能可本地提交。暂存候选回归与构建通过；真实系统图标、通知历史和耐久运行验收仍按上述证据边界保留，不作为已验收结果。

## 2026-09-30 菜单角标修复

现状证据：loopback 顶层 origin=http://127.0.0.1:46800，消息菜单 code=message、path=https://testagent.xspaceagi.com/instant-message、openType=1；unread-total 返回 total=1、dndTotal=0，但父页面 window.__im 缺失，商业桥仅有通知偏好。生产 BASE_URL 为空导致业务域菜单未归一，且 Web 未读订阅等待 IM 页面挂载。

1. 商业 runtime 发布既有快照及清零；IPC 仅向已握手、账号代次有效的受信顶层文档提供快照与推送；preload 配对事件订阅/退订。社区不暴露。
2. PC 客户端聚合初始化接入壳层未读；先订阅再读取、校验代次/修订，登出清零并丢弃迟到响应。IM 页面仍保留自定义事件，商业未读展示以壳为准。
3. 菜单 API 使用已验证的商业 loopback 上下文归一化 IM/资料库地址，浏览器和第三方地址沿用原策略。
4. 回归 IPC 信任边界、真实本地 HTTP/WS 到快照、未打开 IM 页面时的菜单展示、0/99/99+、退出/换账号、旧回调与资源清理；通过后对本批做三问自查。
5. 只提交本次文件，隔离构建已提交 PC 源码，发布配套产物与外层双 pin；loopback 在主页实际验收。IM 原仓及子模块保持原 HEAD/工作区。

本批质量自查：
- 内聚通过：壳接收器统一发布快照（imReceiverRuntime.ts），页面展示及账号清理集中于 imEventBridge.ts；菜单无需认识 WS/HTTP。
- 分层通过：IPC 信任检查沿用当前文档/账号门禁，preload 只暴露计数；PC 服务仅通过 hostBridge 访问商业能力，lint:arch 无新增违规。
- 维护通过：一个顶层文档一个推送目标，销毁/换域/换代回收；事件与登录监听配对退订，初始快照与推送竞态、0/99/99+ 均有行为回归。
- 本批门禁：PC 13 文件 140 测试通过，商业壳 7 文件 158 测试通过；商业 main/preload production bundle 成功。全库 TypeScript 仍有既有错误，本批改动的源码及新增测试文件无诊断。
