# 实施计划：渐进扩展接缝

- 状态：五批已完成；四个核心域的生产源码与相关测试均为零类型诊断，提交前质量复核及最终门禁通过。按用户授权在独立 worktree 本地提交；前端 e4bb29a8e453851667546b1821e5a5df0e7cf992，外层记录该源码 pin。未推送、合并或发布。基线为 release/v3.0.x@76bfc5a3。
- worktree：/Users/apple/.codex/worktrees/feature-extensibility/nuwax-client
- 规格：specs/feature-extensibility.md

## 顺序与归属

1. 并行实施三个独立域：商业托盘生命周期；overlay pin 兼容守卫；会话工作区动作适配。
2. 主代理负责 package/CI 接线、依赖准备、整体验证和工件更新，不直接修改子任务拥有的文件。
3. 各域完成后根据实际接缝推进宿主桥类型和工作台控制器；每批限制职责，避免一次重写。
4. 节点专项：定义 worker 拥有纯数据定义与 palette/defaults/flowKinds/外观/类型映射/UI registry 消费接线；round-trip explorer 只读确认分支保存/重载链路，随后独立 worker 负责 handler 接线与真实配置回归。主代理负责工件、范围收敛与整体验证。
5. 类型门专项：gate worker 拥有前端 scripts/域配置/脚本自测；节点 worker 拥有 graph.ts 模型契约与 graphV3 动画 API 修复及动画回归。主代理负责精确历史基线审查、package/CI 接线和维护说明，稳定后独立 verifier 复核。
6. 节点生产清理：布局/表单 worker 拥有 indexV3、WorkflowLayout/ControlPanel 及其明确适配器与回归；模型 worker 拥有 node.ts、workflowProxyV3、commonNode、GraphContainer 四个准确类型修复。主代理负责基线收缩、工件与整体验证。表单边界先只读核准再实现。独立复核发现内置 Header 隐藏与按钮条件互斥后，将自动布局接到现有 ControlPanel，并改用真实布局组件验证入口。
7. 测试类型清理：节点 worker 拥有基线列出的 8 个节点测试，会话 worker 拥有 7 个会话测试；主代理负责快照、基线收缩、整合与工件。两域不修改生产契约，稳定后由全新 verifier 复核类型与行为覆盖。

## 验证与回退

- lifecycle 定向 Vitest、脚本真实 Git fixture 测试、前端定向与 test:conversation、lint:arch。
- 第一批整合后执行 test:scripts、社区/商业门禁；只复用依赖和 ignored 资源，不复用可改写源码/构建目录。
- 独立 verifier 只读复核；check:pin 验证商业实现未进入基座提交。
- 每个职责可独立撤回；不合并、不推送、不发布，按用户授权保留本地提交供审查。

## 当前证据

- 新 worktree 与三个直接子模块均从固定提交建立，基线干净。
- 节点专项改前基线：22 文件、259/259，通过 AgentFlow/extensions/flowKind/proxy/节点操作/保存/变量引用/生命周期回归。首批源码清单快照：`.cache/phase1-snapshot-20261002-154647`（ignored，未进入提交）。
- 第三批改前已保存第二批 45 个前端源码路径、patch 与工件到 `.cache/phase2-snapshot-20261002-typecheck`（ignored）；TS 日志基线包含全库历史诊断，待 gate 按域计数，不以全库 exit 2 判断本批失败。
- 第四批改前将前三批 55 个前端源码路径及工件存入 `.cache/phase3-snapshot-20261002-node-cleanup`（ignored）；现有门禁 60 个历史诊断，节点生产源码 10 条，第四批仅收缩已修复记录。
- 第五批改前将前四批 WIP 与目标测试共 79 个前端路径及工件存入 `.cache/phase4-snapshot-20261002-test-types`（ignored）；基线剩 26 个记录、50 条诊断，均属于 15 个测试文件。完整 TS 参考日志为 `/tmp/nuwax-node-cleanup-final-tsc.log`（335 条）。
- 原工作区仍在 release/v3.0.x@76bfc5a3，原 overlay 同步产生的脏文件保留。
- 已完成商业托盘生命周期、overlay 升级守卫与 updater/CI 接线、会话工作区动作注入、宿主桥统一类型与快照门禁、工作台静态面板定义和本地切换控制器。
- 社区门：126 文件，1522 通过、1 跳过。商业门：168 文件，2113 通过、1 跳过；main/preload production bundle 成功。
- 脚本全门初次 139/139；独立复核补上目标目录/符号链接/gitlink 阻断及 Windows 换行边界后，守卫定向 15/15、更新器定向 2/2、宿主桥生成/编译回归 8/8。未重复未改变的商业运行测试。
- 前端会话合同网：111 文件，1085/1085；宿主桥及窗口/命令/主题定向 95/95；工作台 8 文件、39/39（新增 16 个行为用例）。独立复核补上 ReactNode 为 0/false/null/undefined 的兼容边界后，该组件最终 11/11。lint:arch 2971 模块/12950 依赖通过，97 个存量豁免保持。
- 生产构建：商业 main/preload esbuild 和前端 `UMI_ENV=production pnpm exec max build` 成功；前端构建绕过会下载微应用和写版本的 pre/post hooks，产物只在本 worktree ignored dist，不更新产物 pin。
- TypeScript 全库仍有历史错误；本批 AppDevPro 和新增会话源码/新增测试零诊断。既有会话行为测试的 4 条诊断对照 HEAD 均为存量，未提高为全库门禁。
- overlay:check 一致 128 文件、0 待同步；check:pin 确认基座全部 128 个脏文件为 overlay 产物。商业来源授权/数据目录静态门均通过。
- 未执行 CI 远端、真实安装包、认证账号 E2E 或长时间运行验收；不能把源码门禁作为这些环节的通过证据。
- 独立 verifier 最终 39 通过、0 失败、0 跳过；发现的换行误漂移、非普通文件路径碰撞、面板 0 值兼容问题均已修复并复核。最终前端生产构建 exit 0。

### 节点专项最终证据

- Agent、RouteDecision、HumanInteraction 的 palette、默认配置/名称、flowKinds/顺序、外观资源与 backendType 已收敛到纯 NodeDefinition；属性表单仍由 NodeRegistry 管理，分支能力仍由 extensionRegistry 管理。其余 Workflow 节点未扩大迁移。
- graphV3 的分支重载边和 proxy 的端口能力识别接到 handler，新增可选 generateEdges；空数组表示已处理，null/未提供方法回落普通 nextNodeIds。真实 SaveService → 后端序列化 → 归一 → getEdges 往返覆盖原端口、OTHER、legacy default 和 Loop zIndex，并验证新增 handler 无须修改核心白名单。
- 两条 proxy 缺陷已先红后绿修复：Human SELECT 普通回落连接被清空，以及删除选项边后旧目标残留。真实 X6 undo/redo UI 尚未验收，测试覆盖其实际调用的 proxy 同步边界。
- AgentFlowCanvas 在模块初始化时幂等注册 handler，早于子树首次 render/effect；首次注册回归从空 registry 开始，覆盖 StrictMode，不靠测试预注册掩盖时序。
- 整合回归 30 文件、328/328；首次注册测试迁到根 tests 集成测试目录后 1/1，再由独立 verifier 复跑通过。独立复核共 11 文件、185 项用例通过，0 失败、0 跳过。
- lint:arch 最终 2976 模块、12986 依赖通过，原有 97 个豁免未增加。新测试初始跨页面目录违规已通过迁移至既有 tests 目录消除，未修改规则。
- 全库 noEmit 仍 exit 2；新增定义、handlers、proxy、round-trip 和首次注册路径无新增诊断。workflowV3 的 NodeMetadata.id、graphV3 的 Animation 及旧 route 测试诊断对照 HEAD 为存量。
- 最终直接 production build exit 0，Webpack 编译 50.40 秒；未运行下载微应用/写版本的 hooks，未更新产物 pin。入口 gzip 2.31 MB、最大异步块 1.82 MB，与首批基线一致。
- 本批仅变更前端节点域，未重复未改变的壳测试。原工作区 HEAD/分支与原基座脏状态保持，未提交、推送或合并。
- 缺 UUID 的生成/重载差异、旧 askConfig 归一和真实后端保存/重载仍需后续处理。维护入口：`nuwax/docs/ch/agentflow-node-extension-guide.md`。

### 分域类型门最终证据

- `pnpm typecheck` 使用当前 TypeScript 5.8.3 与现有严格配置，检查四个明确域；319 个域内文件：节点 139、会话核心 117、AppDevPro 60、宿主契约 3。域覆盖源码及相关测试，不冒称所有 Chat 页面、模型或布局都已检查。
- 人工审查初始基线 33 个精确键、60 条历史诊断：节点 39（生产源码 10、测试 29）、会话核心 21（均为测试）、工作台及宿主契约 0。所有记录的文件/码/次数均能对上改前日志；最终源码 before/after 全量消息计数比较新增 0。
- 诊断身份为域/相对路径/错误码/完整规范化消息，比较出现次数并忽略行列移动。只规范化明确 import/文件引用，保留普通类型字符串中的反斜线。新增或次数增加失败；旧记录消失提示 stale，prune 只能收缩且存在新增/故障时拒写。
- 生成 tsconfig/typings/exports 均须存在；生成源码加入同一 program 并核对诊断，拒绝外部工作区源码或声明，共享 node_modules 允许。严格子选项弱化、noCheck、空输入、漏编译、配置/全局/语法及所选域环境错误均失败。域外历史业务错误单独报告，不写入本域基线。
- 自测 `pnpm test:typecheck` 19/19，含真实临时 TS 项目的新增、清理、基线收缩、错误回流、生成插件缺失、外部源码引用和故障拒写。最终默认 gate exit 0，域外仍有 285 条诊断。
- 节点模型改为继承 X6 顶层 NodeMetadata；边动画使用真实关键帧 API。真实 X6 的 6 个动画回归先红后绿，确认旧回调不会产生位移，修复保持 600ms/无限循环/分支色/去重/取消/重启。相关域最终 31 文件、334/334。
- full noEmit 352 → 345，减少 7、新增 0：动画 2、graph.ts 旧 namespace 1、V3 元数据 id 2、V1 元数据 id 2。独立 verifier 以只读内存旧 API 对照再次确认；全库类型检查仍未通过。
- 独立 verifier：脚本 19、动画/保存/round-trip 45，共 64 通过，0 失败、0 跳过；默认 gate 通过。检查前后 68 个输入的 SHA256/大小/mtime 均未变化，包括基线、完整 .umi、配置、package/lock。之后 package 仅按既有格式调整新增命令位置，解析值不变。
- 架构检查 2976 模块/12986 依赖通过，97 个旧豁免保持；前端 production build exit 0，Webpack 46.85 秒。新 gate/script/config/baseline/package/workflow/维护说明格式检查及 diff check 通过。
- 前端独立 typecheck workflow 与外层 frontend job 共用入口；触发范围包括实际 config/\*\* Umi 配置。未执行远端 CI、实际画布/Electron 安装包验收；未更新产物 pin。pnpm-lock、业务 tsconfig 与原工作区均保持。
- 使用说明：`nuwax/docs/typecheck-domains.md`。合入顺序需先提交前端 gate/基线，再更新外层 gitlink，本 worktree 仍未提交或推送。

### 节点生产源码清理证据

- 自动布局使用实际 `GraphContainerRef.getGraphRef()`；按钮由现有 WorkflowLayout 转发到可见 ControlPanel，AgentFlow 嵌入、全屏和 ESC 返回后均可操作。内置 Header 保持隐藏，外部顶部栏只有一条；普通 Workflow 保留其 Header，不新增自动布局按钮。原 BFS 顺序、坐标及孤立节点策略保持。
- 布局回归挂载真实 AgentFlowCanvas、FlowKind/Fullscreen context、Layout、ControlPanel 及内外 Header，点击实际 AntD 按钮；仅隔离图 DOM，使用真实 X6 Model/Node/Edge 与 WorkflowSaveService.buildPayload 验证坐标。8 项覆盖实际入口、BFS、循环、断连、空图、尚未初始化及无 Start。入口先红 7 失败/1 通过，再绿 8/8。
- 节点配置的两处填充统一走 nodeConfigForm 窄适配；仅适配 contextParams/askConfig 的第三方声明差异，保留原对象与单次原生 setFieldsValue、IME/技能恢复顺序。真实 AntD Form 的 4 项回归验证不透明值、深合并/数组替换、遗漏键/显式 undefined、watch、变化字段清除错误及同值字段保留错误。
- 代理 getter 保留 EdgeV3 的双端口类型及深拷贝隔离；markup 使用 X6 CellMetadata 的实际类型，默认枚举运行值保持，图回调使用准确 Edge 类型。未修改后端 NodeConfig 或节点协议。
- 节点基线 39 → 29，生产源码 10 → 0，剩余全部为测试；node-only prune 仅删除原 7 个精确记录、10 条诊断，其它域与 metadata 原样保持。总体剩余 26 个记录、50 条诊断；范围增至 323 文件（节点 143、会话核心 117、工作台 60、宿主契约 3）。最终 full noEmit 仍有 335 条历史诊断，含 285 条域外诊断。
- 最终整合 34 文件、348/348；独立复核端口 2、真实 Form 4、真实入口/布局 8，共 14/14。架构检查 2977 模块/12988 依赖通过，原 97 个豁免保持。最终 production build exit 0，Webpack 49.01 秒；入口 gzip 2.31 MB、最大异步块 1.82 MB，未更新产物 pin。
- 独立默认类型门 exit 0、无新增或 stale；最终全量日志完整消息计数比较 345 → 335，仅减少对应 10 条、新增 0。未执行远端 CI、认证账号/真实后端、浏览器或 Electron 安装包验收。维护入口与表单/工具栏约束已补到节点指南及分域检查说明。

### 测试类型债务清理证据

- 第五批仅修正 15 个测试文件：节点 8 文件、原 99 项，会话 7 文件、原 46 项。补齐真实 ChildNode/CreatedNodeItem/MessageInfo/RequestResponse 元数据、枚举与必填参数，Mock、Ref 与 renderHook 使用实际契约。移除两处失效 expect-error，不增加类型绕过或放宽检查范围。
- 独立快照审查确认原用例标题序列及 314 个 expect 调用保持；缺 UUID、缺 nodeConfig、字符串节点 ID、未知端口、legacy default、流式消息 index 为 undefined 等运行边界保留。缺配置仍携带 nextNodeIds:[3]，继续验证不走普通回落；透传字段断言始终执行，字段丢失会失败。
- 最终 full noEmit 335 → 285，只删除原 26 个精确键、50 条诊断，新增 0；删除集合与改前基线逐记录对应。节点 29 → 0、会话核心 21 → 0，工作台及宿主契约继续为 0；四域 323 文件全部零诊断，基线已由 prune 收缩为空。
- 节点整合 34 文件、348/348；完整会话合同网 111 文件、1085/1085；目标 15 文件的 145 个用例由独立 verifier 复跑通过，异常夹具与 hook 类型最终修正分别追加 26/26 与 3/3 复核。门禁脚本自测 19/19，架构 2977 模块/12988 依赖通过，原 97 个豁免保持。
- 改前快照中的 41 个生产源码路径保持字节一致；package、lock、业务 tsconfig、domain 配置、gate 脚本及原工作区保持。测试限定改动沿用第四批生产构建证据，未重复生产构建、未更新产物 pin；本批不涉及新的 UI、后端或安装包行为。
- 最终独立默认类型门 exit 0，323 文件、四域零诊断、无新增或 stale；允许测试/基线/两份维护文档变化，其余 61 个快照成员保持字节一致。第五批验证完成时差异保留在独立 worktree，随后按下节复核并本地提交。维护说明已补四域零债务状态及测试夹具约束。

### 提交前质量复核（2026-10-03）

- 按整个待提交批次独立检查内聚、分层与可维护性；壳、会话/工作台和节点三组复核均通过，修复后无剩余 Important 或 Nit。托盘职责收在 `trayServiceActions.ts`，桥类型由前端单一契约生成，节点定义、属性面板与分支 handler 保持各自分层。
- 提交前发现并修复自动布局未触发保存：`indexV3.tsx` 只在坐标实际改变时调用既有 `workflowProxy.updateNodePosition`，统一标记 SaveService 并防抖保存一次。真实 persistence、proxy、beforeUnload 与 SaveService 回归覆盖成功/失败、保存坐标、刷新保护、立即卸载和无变化不保存；去掉修复后 5 条保存回归失败，恢复后 4 文件、65/65 通过。
- 仓库提交钩子发现新增测试的 Hook 命名、button 类型与 Promise executor 返回值问题，已修正；最终暂存批次 lint/格式门通过。格式化仅改变宿主桥契约排版，已重新生成商业镜像并同步 overlay。
- 最终节点整合 34 文件、352/352；脚本全门 147/147，格式化后的宿主桥定向 8/8。全新只读 verifier 验证真实自动布局、工作台与动作适配 3 文件、24/24，以及 gate 自测 19/19；四域 323 文件零诊断，域外仍有 285 条存量诊断。
- 架构检查 2977 模块/12988 依赖通过，原 97 个豁免保持；前端与外层工作区/暂存 diff check 通过。overlay 一致 128 文件，check:pin 确认全部基座脏文件为同步产物，商业实现未混入基座提交。
- 最终直接 production build exit 0，Webpack 46.08 秒，入口 gzip 2.31 MB、最大异步块 1.82 MB；未运行下载微应用/写版本 hooks，79 个前端提交输入均保持字节一致。前端源码已提交为 e4bb29a8e453851667546b1821e5a5df0e7cf992；产物 pin 仍为 4df84e6a4e14454c8c19a45397f3799079642443，不提交 ignored dist。
- 本地源码验证不代替远端 CI、认证账号/真实后端、长时间会话或实际安装包验收；这些仍待执行。

## 后续专项

1. **扩大类型门覆盖**：四个核心域的生产与测试已清零。后续按实际开发需求把其它 Chat 页面、模型或布局纳入明确 ownership，逐项处理剩余 285 条域外诊断；维持现有四域零债务，最终再提升全库门。
2. **节点协议兼容与扩大迁移**：先明确缺 UUID/旧 askConfig 的数据边界及真实后端验收，再按需求逐步迁移其余 Workflow 节点。沿用已经建立的定义、UI 注册和行为 handler 分层，禁止 services 倒依赖 React 面板。
3. **交付可重复性**：资源锁定、构建输入摘要和发布配置继续收敛；源码 pin、产物 pin、实际包、签名、发布指针分层核验。
4. **首屏包体**：入口 `umi` gzip 为 2.31 MB，最大异步块为 1.82 MB。先分析共享入口和依赖归属，再决定大依赖按需加载与体积预算，避免后续功能持续放大首屏成本。
5. **长期运行和协议功能**：长会话渲染/缓存上限、SSE 重放、多窗口及独立微应用升级分别立项，明确后端或宿主契约后实施。

## 后续开发入口

- 新会话入口可通过 `workspaceActions` prop 或 `ConversationWorkspaceProvider` 提供 `openFile`；旧入口由 `ConversationWorkspaceCompatBoundary` 保留动作事务。
- 工作台工具元信息及激活策略在 `nuwax/src/pages/AppDevPro/ConversationAgentFilePreview/previewToolDefinitions.ts`；工作区布局/返回规则在 `workspaceDefinitions.ts`，页面通过类型化 panels 映射提供 chrome/content。
- 宿主桥新增类型先改前端 `hostBridge.ts`，执行 `host-bridge:sync` 生成商业快照；IPC 实现和安全来源校验另行保持同步。
- 更新基座先执行 `overlay:compat`；源码对照后才记录 review。结构冲突必须修正路径；`overlay:check` 与 `check:pin` 分别验证同步和商业代码来源。
- 节点元信息维护 `nodeDefinitions.ts`；属性表单和分支行为各归原 registry。新增分支需验证保存 payload 到重载边的往返及首次注册；详见 `nuwax/docs/ch/agentflow-node-extension-guide.md`。
- `pnpm -C nuwax typecheck` 执行四域诊断门；旧错误修复后 `pnpm -C nuwax typecheck:prune` 仅删除已消失记录。配置范围及限制见 `nuwax/docs/typecheck-domains.md`。
