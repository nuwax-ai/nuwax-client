# DSH 插件运行宿主

## 插件工作台

本机会话侧栏中的「插件工作台」打开独立的 DSH 原生工作台。主进程解析当前会话工作区，按服务域和账号隔离 Profile，使用 DSH 原生 Agent 生命周期持有插件会话。现有 ACP Agent 通过会话专属的 `nuwax-workbench` MCP 操作工作台。设置页「允许 Agent 编排」授权后，在后续会话轮次生效，撤销立即阻断已有调用。

工作台独立启动，提供文件预览、终端和共享浏览器。Agent 可以发现原生组件，打开或关闭面板，调整显隐、分栏、浮动和尺寸，并撤销或重做布局。修改先读取 `workbench_state` 的 `layoutVersion`，工具携带 `expectedVersion`，用户修改造成冲突时重新读取。用户可以在工作台锁定 Agent 布局调整。浏览器接管会阻断 Agent 控制并断开已有 CDP 连接。

工作台提供命名布局的保存、恢复和删除入口，MCP 使用同一套 `workbench_layout_preset` 操作。先用 `action: "list"` 读取方案修订号；写入、恢复或删除时同时提供 `expectedRevision` 和当前布局的 `expectedVersion`。尚未写入状态时修订号为 `null`；空列表也可能已有修订号，例如用户曾设置布局锁。每个会话最多保存 20 个方案。方案包含面板及打开时的导航配置、分栏比例、浮动位置和尺寸；恢复复用仍打开的面板，重新打开已关闭的面板，额外面板保留。缺少插件时恢复失败，原生布局应用失败时尝试撤销到之前的状态，并报告回退结果。

命名方案和用户布局锁由主进程写入当前账号档案的 `workbench-layouts/<会话哈希>.json`。此存储不依赖临时 HTTP 端口，重启后仍可读取方案及锁；恢复方案由用户或已授权 Agent 发起。文件写入检查修订号并原子替换；写入失败或数据损坏不会覆盖原数据。入口只接受宿主已经绑定的会话，沿用顶层文档及账号代次授权。

`workbench_state.layoutCapabilities` 返回锁定版本实际支持的区域和栏数。DSH 0.2.1-rc.5 原生侧栏最多两个停靠栏，支持左、右和居中移动及浮动；上下停靠尚未提供。`workbench_layout` 的 `resize-split` 调整两栏比例，`sizes` 为两个合计为 1 的数值，各自在 0.2–0.8 之间。无效的面板或区域返回错误，原生操作未改变布局时返回 `changed: false`。

已安装第三方插件的公开配置由 `workbench_plugins` 返回描述和修订号，Agent 使用 `workbench_plugin_configure` 更新；底层沿用原生 DSH Settings 服务的验证与并发检查，核心和私有配置继续受保护。

第三方包由原生 Plugins 页面管理。当前锁定 DSH 0.2.1-rc.5，better-sidebar 使用 `dsh-better-sidebar@0.28.2`。布局适配绑定该版本的 Sidebar Controller/store 接口，升级 DSH 时须一起运行真实 Electron 验收。

本批交付覆盖 V0 兼容原型、首批 V1 面板和 V2 基础编排。临时生成插件、自动诊断修复、更多业务页面迁移分别安排在 V3–V5。深度依赖模型循环的插件按原生 DSH 能力单独验收。

```sh
npm run prepare:dsh
npm --prefix nuwa-electron-shell/crates/dsh-runtime test
# 在 agent-electron-client 目录执行真实 Electron 验收
node node_modules/electron/cli.js tests/workbench-desktop-smoke.mjs --ecosystem --resources
```

该配方使用临时账号档案和本机测试页面，覆盖真实文件内容、终端命令输出、共享浏览器、人工接管、会话隔离、布局冲突与锁定、浮动和撤销，以及 better-sidebar 安装、禁用和恢复。当前证据为 macOS arm64 源码及准备资源层级，安装包和其他平台另行验收。

## DS-Bot

客户端设置中的「DS-Bot」先选择并授权 Nuwax 模型，再打开独立窗口。关闭窗口保留后台运行；「停止」关闭当前账号的自动恢复。应用退出、账号失效或换域会先撤销本轮模型及浏览器权限，再结束所属进程。原有 Nuwax 会话引擎继续运行。

运行包位于 `nuwa-electron-shell/crates/dsh-runtime`，固定 DS-Bot 0.2.7、DSH 0.2.1-rc.5 和完整 npm lock。`host.mjs` 使用公开 `runProfile` 组合 Base、Web App、Voice、Nuwax Provider 和原 DS-Bot Bundle；用户插件由原生 Plugin Manager 安装和管理。核心 Bundle 从安装包优先解析，DS-Bot / DSH 自更新关闭。第三方插件按受信本地代码运行，进程隔离不提供系统沙箱。

宿主特性 `dsh-runtime` 仅向客户端设置页提供管理 IPC。插件窗口使用独立持久会话分区和专用 preload，不加载商业桥。数据目录是产品档案下的 `dsh-runtime/<sha256(服务域+账号)>`，不读取个人 DSH 或其他产品数据。Bot 浏览器分区进一步包含 Bot ID，外部页不获得插件 preload。文档代次、IPC 所有者、浏览器租约和自动化令牌随生命周期失效，已有 CDP 连接在销毁时结束。

平台模型目录、授权和 Key 操作由主进程的 `FeaturePlatform` 完成。专用 Key 只在主进程内存中使用，设置仅保存 Key ID 和模型 ID。插件 Provider 取得代次绑定的回环令牌，转发 OpenAI / Anthropic 原生请求及 SSE；请求模型必须在授权范围内，登出立即撤权。上游协议、工具、图像、推理及用量由固定版本 pi-ai 适配器承载；不按名称推断协议或思考参数。不支持外部调用、文本会话或工具调用的模型在授权页注明原因。真实模型目录可能包含配置或额度失效的模型，仍需按通路联调。

Office 使用上游锁定的 Node 24.21.0、Python 3.12.14、wheel 哈希和 Office 技能，LibreOffice Kit 固定 0.1.5。子进程禁止 Python 写入字节码缓存，避免首次导入修改已签名的应用资源。语音使用原语音 Bundle 的 SenseVoice / Silero 本地模型，原生库随包，权重由插件首次明确准备时下载并验证。权限仅授予插件窗口的顶层音频请求，macOS 包包含麦克风用途及 entitlement；播报沿用系统 speech synthesis。

开发准备在仓库根执行 `npm run prepare:dsh`；完整 setup / dev / pack 会准备此资源。`node scripts/check-dsh-resources.mjs` 检查当前平台的锁版、语音原生库和 Office 引擎。资源来源与修改记录在 `vendor/UPSTREAM.json`；完整第三方目录、许可证和 Office 的聚合许可证随资源保留。macOS 自定义签名入口用已解析的应用身份先签署嵌套原生库及解释器，再调用现有签名器完成应用封装；仅限制文件探测的并发量，保留原有签名、重试和严格校验。

Dev 与安装包均消费准备后的 DSH 资源。构建时 `bot-client-profile.mjs` 对锁定的 DS Bot 0.2.7 Client 校验 SHA-256 和适配位置，生成仅展示 Bot 工作台、运行设置跳回 Nuwax 的产物；上游来源变化时拒绝生成，升级须重新审查适配点。生成文件标记修改来源，保留上游开源链接及许可证；运行时不改写已签名资源，不更改 Bot 会话、记忆或任务数据。

定向验证：

```sh
npm --prefix nuwa-electron-shell/crates/dsh-runtime test
npm --prefix nuwa-electron-shell/crates/dsh-runtime run smoke
node nuwa-electron-shell/crates/dsh-runtime/test/plugin-smoke.mjs
# 以下命令的工作目录是 crates/dsh-runtime
node test/office-smoke.mjs
node test/voice-smoke.mjs
# Electron 源码级窗口 / 浏览器验证的工作目录是 agent-electron-client
node node_modules/electron/cli.js tests/dsh-desktop-smoke.mjs
```

`smoke` 使用真实 DSH 与 DS-Bot、固定响应的测试模型，验证工具续轮、Bot 消息、记忆、定时任务和重启恢复。`plugin-smoke` 验证额外插件安装、Host / Client 发现、启停及移除。Office 实际创建和编辑三种文档，完成 PDF 转换、图片渲染和公式重算。voice 验证固定哈希模型的准备、取消、重试及本地转写；系统生成的音频不能替代真实麦克风验收。Electron 用隔离测试档案验证原 DS-Bot Client 渲染、Cookie 隔离和 CDP 自动化。

`test/platform-runtime.mjs` / `platform-contract.mjs` 是明确触发的测试环境联调入口，接收已经登录的调用通道，创建限模型的临时 Key 并在 finally 删除。可将 `platform-team.mjs` / `platform-context.mjs` 的验收回调传入前者，验证真实协作和检查点；检查点配方将测试模型窗口缩小到 45,056 Token，模型调用仍走平台。凭据不进入文件或证据。平台真实工具续轮、权限、用量和账单必须独立验收；本地测试、doctor 和进程启动不能替代安装包和跨平台验收。

CI 增加五平台 DSH 资源与原生 Office 验证。安装包沿用独立 package-validation 流程、已有版本和四次启动限制，不创建发布，不变更更新指针。本特性独立分支交付，未自动合入发布线。
