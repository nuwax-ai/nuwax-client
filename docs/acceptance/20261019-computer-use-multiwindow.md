# Computer Use 后台多窗口：本地实现与验证

状态：本地实现候选；尚未完成真实软件和安装包验收。

## 源码与实现

- worktree：`/Users/apple/.codex/worktrees/computer-use-multiwindow/nuwax-client`。
- 分支：`feat/computer-use-multiwindow`；起点 `release/v3.1@488673578ac9f9b2742bc81c45cd833d7c4cb932`。
- 基座固定 `c08080d127544b7e191e11fe722fa50a1b977679`；驱动固定 `625118a9076e51da2f57b6a5d475972030197443`。所有子模块 pin 保持不变；商业实现保留在 overlay。
- 现行契约：[Computer Use 产品运行闭环](../../specs/computer-use-product.md)。本轮范围是软件窗口 GUI 控制，不包含 Nuwa Browser 或微信消息指令入口。
- 原生改动完整保存在 `docs/computer-use-poc/0001-0003-cua-nuwax-helper-bundle.patch`；本地驱动检出位于 `.cache/cua-source`。组合补丁已对固定上游执行干净 index 的 apply 检查，新模块不是仅存在于缓存中的未交付文件。

实现包括可信 ACP prompt 任务身份、最多四个活动任务、窗口唯一归属、同 PID 观察/动作串行、独立预算与观察门禁、后台/前台显式切换、原生代次和窗口生命周期验证、单任务撤权与排空、用户激活目标窗口时暂停、全局急停及重新准备。等待选窗或人工接管会保留工具调用；恢复要求重新观察，不自动重放。

后台第一批允许精确元素点击、设值和滚动。通用键盘、像素输入和拖拽需要前台模式。AX/UIA 提供者不支持相应操作时暂停，不能据“后台”模式名称推断任意应用的任意控件都能操作。目标程序自身打开弹窗、激活窗口等行为仍需实机验证。

## 已运行检查

| 检查 | 结果 | 证据 |
|---|---|---|
| overlay 同步后的商业 crate：`./node_modules/.bin/vitest run` | 257 文件、3,229 项通过；18 项原有跳过 | `.cache/cua-commercial-tests.log` |
| 独立基线副本：`npm run base:test` | 135 文件、1,653 项通过；18 项原有跳过 | `.cache/cua-community-tests.log` |
| 相关壳脚本测试 | 21 项通过 | `.cache/cua-script-tests.log` |
| helper 构建脚本自测 | 通过 | `.cache/cua-build-script-test.log` |
| macOS 原生任务模块单测 | 6 项通过 | `/tmp/nuwax-cu-native-final.log` |
| macOS 原生 helper build | 通过 | 同上；`.cache/cua-source/libs/cua-driver/rust/target/debug/cua-driver` |
| helper 私有端点 + 实际 MCP 转发 | 通过 | `.cache/cua-native-protocol.log` |
| 真实 Electron 控制浮窗及窗口标记 | 通过 | `.cache/cua-controls.log`、`.cache/cua-controls-evidence/` |
| 主进程 esbuild / renderer Vite build | 通过；保留原有 chunk 体积提示 | `.cache/cua-main-build.log`、`.cache/cua-renderer-build.log` |
| 主进程 TypeScript | 未全绿；诊断与同 pin 的干净商业基线逐条一致 | `.cache/cua-current-tsc.log`、`.cache/cua-baseline-tsc.log` |
| overlay 一致性、基座纯度、import 边界、diff 空白检查 | 通过 | `.cache/cua-overlay-check.log`、`.cache/cua-pin-check.log`、`.cache/cua-boundaries.log` |
| Windows 新原生任务适配器类型检查 | 独立检查壳通过；核心会话/光标接口用 stub，仅验证新模块及真实 Win32 API 类型 | `.cache/windows-task-check.log` |
| 完整 Windows 原生 helper 交叉检查 | 环境阻断：缺少 `x86_64-w64-mingw32-gcc`；不计为通过 | `/tmp/nuwax-cu-win-check.log` |

新 worktree 首次全量测试缺少固定 MCP Proxy 1.5.4 生成资源；补齐与依赖中 `dist/host/rewrite.js` 字节一致的资源后，以上最终商业/社区检查通过。依赖通过只读符号链接复用；基座纯度检查仅额外忽略这些 node_modules 链接，不忽略源码。

原生协议 smoke 不派发任何输入：验证能力标记、无 token 拒绝、无任务上下文拒绝、外窗拒绝、后台全局输入拒绝、观察坐标放行到任务校验，以及宿主上下文穿过真实 MCP proxy 后仍被原生绑定校验识别。

Electron fixture 只控制自有合成任务窗口：双任务呈现、目标选择不隐式恢复、过期登录拒绝继续/前台/恢复、外部窗口不能控制任务、标题安全渲染、关闭即停、不取焦点的标记、光标颜色更新及清理。它没有证明真实第三方应用的后台输入效果。

可重跑的局部入口：

```sh
npm run overlay:sync
node scripts/acceptance/cua-controls.cjs .cache/cua-controls-evidence
node scripts/computer-use/verify-helper-window-tasks.cjs .cache/cua-source/libs/cua-driver/rust/target/debug/cua-driver
bash scripts/computer-use/build-helper.test.sh
```

商业测试应在已同步的基座 crate 内执行；社区 `base:test` 会清除 overlay，只能在隔离副本运行。

## 发布前仍需验收

- macOS 原生文本编辑器/文件管理器、Windows 对应应用：两个不同应用及同一进程两个窗口；未绑定窗口不被操作。
- 真实鼠标和键盘持续使用时的后台输入、用户激活目标窗口后的停机延迟、在途操作排空；无法撤销已经执行的动作，不把它显示成未发生。
- 前台独占、其他任务不自动恢复、弹窗和新窗口、窗口关闭/ID 复用、同 PID 的焦点和元素缓存。
- 多屏、缩放/DPI、遮挡/最小化/全屏、移动窗口时标记及虚拟光标位置。
- 真实模型选窗等待、暂停后继续规划、取消/登出/锁屏/休眠/崩溃及八小时稳定性。
- 两平台签名安装包、原有授权迁移、helper 更新和能力不匹配时拒绝启用。当前只有本地开发构建，没有发布 tag 或更新源变更。

## 本批变更评审

按 `REVIEW.md` 检查行为、维护、安全边界和验证，复用上述结果。已修正等待选窗时 ACP 回合提前结束、暂停期间排队调用丢失、旧恢复请求跨绑定代次生效、发现工具读取整桌面、全局急停后租约/恢复入口及徽标颜色不一致等问题，并补充相关回归覆盖。真实应用和 Windows 安装包验证仍是本候选的明确限制。

## 2026-10-20 画中画、状态胶囊与接管增量

发布线已快进到 `748748a9`，保留此前多窗口 WIP。当前前端/产物 pin 为发布线的 `95788407878e3e7dfe01b723eee976df07802bb6` / `20b6ff7fb0630c139df46716e0c119f1f5299735`；基座和 cua-driver pin 不变。以上旧起点/旧前端记录保留为历史证据，不能代替本轮状态。

实现：窗口状态胶囊、紧凑画中画及叠放切换、悬停操作栏、选窗菜单、偏好和窗口位置、私有内存预览通道、收起停采、暂停排空后的精确接管。仅选中任务持续采集，其他任务最多保留两张上次选中时的内存缩略图；绑定/代次/生命周期变化清除缩略图。采集使用 SCK / WGC 的目标窗口路径，禁止桌面裁切与 shell 临时文件兜底。

| 验证 | 本轮结果与证据 |
|---|---|
| 商业全量 | 259 文件通过、1 文件跳过；3,247 项通过、18 项跳过；`.cache/cua-preview-commercial.log` |
| Computer Use 定向行为 | 大帧、观察预算不变、迟到帧、撤权失败不得激活、原生排空后接管及原多窗口行为；包含于商业全量 |
| 预览调度 | 单帧在途、2 FPS、不积压、切换/重绑/锁屏清理、收起停止；包含于商业全量 |
| 原生 Mac | 7 项任务/预览授权单测及 helper debug build；`.cache/cua-preview-native-test.log`、`.cache/cua-preview-native-build.log` |
| 原生/MCP 只读 smoke | 新能力、无 token 拒绝预览、未绑定拒绝预览/接管、模型不暴露宿主控制方法；`.cache/cua-preview-native-smoke.log` |
| 真实 Electron fixture | 图片 Blob 渲染、任务切换、收起不停止且不被状态强制展开、可信 sender、胶囊点击、颜色/隐藏/销毁；`.cache/cua-preview-electron.log` |
| 界面证据 | `.cache/cua-preview-evidence/multiwindow-controls.png`；画面来自自建测试窗口，不是第三方应用验收 |
| 构建 | main / renderer 构建通过；`.cache/cua-preview-build.log`，保留原有 chunk 体积提示 |
| 主进程类型 | 11 项，与 `.cache/cua-baseline-tsc.log` 错误指纹一致，无新增；`.cache/cua-preview-tsc-main.log` |
| 脚本/边界 | 18 项脚本测试、helper 构建脚本自测、特性边界及 import 边界通过；`.cache/cua-preview-script-tests.log`、`.cache/cua-preview-feature-boundaries.log` |
| overlay / 基座纯度 | 同步一致；纯度只额外排除已验证为符号链接的两处本地 node_modules，377 项脏文件均属于 overlay；`.cache/cua-preview-pin-check.log` |
| helper 补丁复现 | 完整补丁对 `625118a9076e51da2f57b6a5d475972030197443` 的独立干净 index 通过 apply check，不依赖缓存中的遗漏文件 |
| 社区轨 | 基座 pin 与注入机制未改变，复用上文隔离社区 1,653 项通过结果；未在商业工作树运行 base:test |

本轮补齐 MinGW 后，Windows GNU 目标完整 `cargo check -p cua-driver --target x86_64-pc-windows-gnu` 已通过，证据 `.cache/cua-preview-win-check.log`；随后 Windows GNU 目标 `cargo build` 也通过，产生 PE32+ x86-64 EXE，证据 `.cache/cua-preview-win-build.log`，开发二进制位于 `.cache/cua-source/libs/cua-driver/rust/target-win-check/x86_64-pc-windows-gnu/debug/cua-driver.exe`。这些结果不等同于 Windows 运行、MSVC 生产包或安装验收。

本轮没有完成 Windows 实机、真实模型/第三方应用、多屏/DPI/物理接管、双平台签名安装包或八小时稳定性验收；不能据上述 fixture 和单测宣称这些项目通过。没有公开 tag、发布或更新源变更。

本批已按 `REVIEW.md` 检查行为/维护、凭证及来源边界、取消/采集竞态、清理和验证证据。修正了徽标遮挡判定仍使用旧坐标、关闭预览误用停止入口、解锁预览与自动恢复混淆，以及浮窗收起后高度记忆丢失等问题。剩余风险为上述尚待实机验证的范围。

## 2026-10-21 真实模型基准试点

沿用 `feat/computer-use-multiwindow@748748a9` 和上文三个子模块 pin，保留多窗口/预览 WIP。新增入口 [real-run.mjs](../../scripts/computer-use/bench/real-run.mjs)，运行步骤、任务及数据边界见 [基准说明](../../scripts/computer-use/bench/README.md)。

本次使用实际随包 `nuwaxcode 1.17.11`、用户已有 `glm-5.3-flash` 配置、真实 Rust helper 和产品任务注册/授权/MCP 网关。模型只看到窗口工具，自行选择动作；表单状态及编辑器正文由独立 oracle 验证。图片预检使用合成红色图，实际任务报告另外统计图片输入，不能把图片预检当任务通过。密钥只在现有系统解密后经内存代理转发，没有复制到 Windows 或报告。

### 设备边界修正

用户明确要求不使用同事的 Windows 电脑调试。此前误用该设备的运行结果已撤出下表、证据包和后续优化依据，Windows 仅使用本地 ARM 虚拟机。已关闭本机到该设备的测试隧道，不再调试或收集结果。只针对本轮自建进程、`Nuwax-CU-Bench-20261021` 计划任务及临时目录发起了清理；SSH 连接超时，远端清理状态尚未确认，不能写成清理成功。

### 第一轮结果（desktop-v1、background + hybrid、每项一次）

| 任务 | Mac 修复前 | Mac 修复后 |
|---|---|---|
| F01 中文表单 | 失败 | 通过 |
| F02 替换备注 | 失败 | 通过 |
| F03 单选/复选 | 失败 | 通过 |
| F04 滚动找目标 | 失败 | 需要前台，暂停 |
| F05 延迟加载 | 超时 | 通过 |
| F06 刷新后重新定位 | 失败 | 通过 |
| N01 原生编辑器 | TextEdit 失败（单独基线） | TextEdit 通过 |

Mac 修复后 **6/7**；这是试点样本，不是稳定成功率。Windows 本地 ARM VM 尚未进入真实模型动作阶段：安装的 x64 Agent 连 `--version` 都以 `0xC0000005` 退出，单列环境阻断，不计为通过。

- 原始报告：`.cache/cua-real-bench/mac-baseline-06.json`（六项夹具）、`mac-baseline-05.json`（含 N01 单独基线）、`mac-after-01.json`。报告保留任务版本、模态、模式、OS/Node、代码/WIP/二进制哈希、逐工具结果、usage、oracle 与排空结果。
- Mac 报告及原文件 SHA-256 保存到 [脱敏证据包](evidence/20261021-cua-real-bench.json)，另保留本地 ARM Windows 的 Agent 启动探针。包内不含截图、提示词、窗口正文或密钥；后续复跑与首轮分开保存，不覆盖原成绩。
- macOS 为本机 arm64，目标 Chrome 独立配置和 TextEdit。F 系列是 **GUI 夹具**，不计作第三方业务软件验收；N01 才是系统原生应用。两者均未经过 Nuwax 完整 UI/登录与签名安装流程。
- 首轮 Mac helper 使用开发 debug 构建（同 Team Developer ID 签名），不能据其耗时得出生产性能结论。模型价格未提供，费用保持 `null`；部分取消尝试 usage 不完整，token 也保持未知，未以零补齐。
- 已保存的 Mac 任务均完成原生排空。这不替代物理输入、窗口句柄复用、锁屏/登出、预览竞态或八小时验收。

### 已依据失败修复的项目

1. **观察标识丢失**：helper 在 `structuredContent` 返回快照 ID，Agent 的 MCP 适配把文本/图片交给模型，索引却没有对应快照。模型出现裸索引/虚构 ID，被原生正确拒绝，随后误选前台输入。网关现只对有效、成功的窗口观察把 helper 原始 `snapshot_id` 补到文本头；不生成替代标识，不处理预览或迟到回包。补充索引+快照的使用指引，token 必须来自实际观察。Mac F01 从失败变为七次工具调用完成并通过业务核验；计数代理也检测到模型收到真实快照字段。
2. **基准准备与证据**：按测试 PID 找窗口，避免完整窗口列表突破控制消息上限；使用运行器自有状态窗建立后台条件，原生仍判断前台就阻断。Windows 记事本按新建可见窗口进程隔离，清理失败不能判通过。取消先失效任务许可、通知 Agent，再撤权排空；只清理本轮自有资源。AX-only 诊断显式使用 `include_screenshot=false`。
3. **滚动 oracle**：首版 F04 只检查选中值，不能证明视觉滚动定位；`desktop-v1.1` 追加实际滚动和点击时目标完整可见条件，新增回归。旧版成绩保留，不重写为新版成绩。
4. **实际执行模式上下文**：每次有效窗口观察的文本头声明宿主实际 `background` / `foreground`，用户切换后新观察更新该说明；未改工具权限或自动恢复逻辑。Mac release helper 下 F01 定向复跑两次均通过，耗时 58.2 / 86.4 秒、7 / 10 次工具调用；第二次发生一次 `invalid_element_token`，模型重新观察后恢复。`mac-mode-01.json` 单独保存，不覆盖第一轮，也不据两次通过声称稳定。

### 尚未解决的失败与交付缺口

- Chromium 后台滚动在当前 helper 能力边界内不可用，保持暂停；没有放宽后台权限。显式前台的 v1.1 F04 定向试跑中，Mac 选中值及滚动为真，但点击时目标不可见，独立 oracle 拒绝通过。额外滚动提示未改善该例，已撤回该提示；保留两次失败报告 `mac-foreground-01/02.json`，后续优先处理视觉可见性/定位与动作结果核验。
- ARM Windows VM：helper 和图片探针通过，但安装的 x64 Agent 在启动阶段崩溃；须先解决本地 VM 的 Agent 架构/运行兼容性，再建立 Windows 真实模型基线。没有用同事设备结果填补这一缺口。
- 每任务五次、50 核心+20 异常及留出集、第三方真实业务、多屏/DPI、物理输入、双平台正式签名安装包及八小时稳定性均未完成。本轮不发布、不更新下载源。

### 本轮验证

- 基准脚本 10 项通过：独立 oracle/可见性、阻断分母、未知费用、ACP 工具限制、代理计数与不保存内容、取消、AX 模态、Agent 启动失败清理和子进程凭证隔离；`.cache/cua-real-bench/script-tests.log`。
- 最新相关商业网关/任务注册表 31 项通过，包含内容型 Agent 的快照传递、无效/失败观察不注入和实际模式更新；`.cache/cua-real-bench/commercial-tests.log`。
- 最新主进程构建通过；`.cache/cua-real-bench/main-build.log`。import 边界、overlay 一致性及 diff 空白检查通过。基座、注入机制、renderer 和原生补丁未改，复用此前社区隔离 1,653 项、原生 7 项和 renderer 的有效结果，没有在商业工作树运行 `base:test`。
- 本地同源 Mac / Windows GNU release helper 构建通过；`.cache/cua-real-bench/mac-release-build.log`、`windows-release-build.log`。交叉构建不等同 Windows 运行或正式签名安装包验收。
- Mac release helper 对照：N01 通过，F01 曾再次因模型请求前台输入而失败，均完成排空；`mac-release-01.json`。已在实际模式补充后完成上述两次定向复跑，完整稳定性仍未验收。
- 按 `REVIEW.md` 检查本次行为、并发/取消、清理配对、凭证和证据边界；修正 Agent 启动失败清理、子进程凭证继承及代理随机凭证问题，复用上述相关检查。保留原有多窗口/预览 WIP 和三个子模块 pin，未提交、推送或发布。

## 2026-10-21 继续：本地 VM 启动与悬浮预览交互

用户将 UI 交互调整为当前优先项。基准结果已保存，Mac 在途动作收到撤权排空确认后退出；本地 VM 测试已结束，专用计划任务、模型桥接凭证、本地模型代理及到 VM 的隧道已清理。本轮未连接同事电脑。

### 本地 Windows VM 的启动修复证据

- 同版本官方 `1.17.11` ARM64 与 x64 baseline 归档校验 GitHub SHA-256 后，在本地 ARM Windows 交互会话均正常退出并输出版本号；原安装 x64 构建本轮超时，之前有 `0xC0000005`。确认构建兼容性差异，未把具体 CPU 指令或 OS 原因当作已证实根因。
- 使用独立测试目录的 ARM64 候选，F01 完成真实模型输入与提交：51.7 秒、7 次工具调用，独立业务 oracle 通过、`drained=true`。其余 6 项准备阶段报 `backgroundTargetInForeground`，未进入模型动作；下一步需修复测试窗口后台准备，不绕过原生前台检查。已安装客户端未替换，产品打包路径也未调整，不能宣称安装包崩溃已修复。
- 本轮 Mac release 全套尝试中 F01/F03/F05 通过，F02 窗口生命周期中断，F04 前台状态中断；用户要求转 UI 时 F06 取消，N01 未运行。取消和未执行单独解释，不覆盖上一轮成绩。报告和原始 SHA-256 已追加到现有证据包。
- 基准新增启动预检：在打开目标应用和请求模型前检查 Agent 版本，记录 PE 架构、超时/访问异常，失败日志不写入报告。相关脚本测试 11 项通过；`.cache/cua-real-bench/script-tests-vm-fix.log`。

### 悬浮小窗口候选

- 主页面不再额外弹出多任务管理面板，独立宿主预览是唯一运行浮层；设置页保留任务管理及急停后显式恢复。移除重复标题栏、整块面板底色和边框；画面保留自身比例，阴影和圆角直接作用于窗口缩略图。多任务向左下错位叠放，非选中任务只保留已授权的最近缩略图，未查看任务显示明确占位。
- 关闭/接管悬浮在画面上方；暂停/继续、停止、任务菜单、全部急停在悬停或键盘聚焦时显示。暂停状态用轻量胶囊提示；详细选窗和模式切换从默认视图移入任务菜单折叠项。
- 初始尺寸 420×320；原偏好继续生效。关闭/收起仅变为 42px 控制胶囊，点击任务名可展开。保持原有单任务采集、授权、撤权排空、精确接管和不抢目标焦点的控制链。
- 真实 Electron 夹具通过：原 preload/IPC、外部 sender 拒绝、XSS 安全文本、任务选择与迟到帧、关闭不停止/状态不强制展开、偏好恢复、键盘显示操作、任务菜单与 Escape、胶囊任务名展开、接管等待禁用和完成清帧。明暗主题截图来自合成任务，未模拟真实安装包验收。
- 相关商业主进程/预览 40 项、renderer 控件 9 项共 49 项通过，主进程和 renderer 构建、import 边界及 overlay 一致性检查通过；`.cache/cua-pip-refinement/` 保存日志和截图。按 `REVIEW.md` 检查一次，复用未受影响的原生与社区隔离结果；没有发布或提交。

视觉证据（合成任务的真实 Electron 渲染）：[展开与悬停](evidence/20261021-cua-pip-expanded.png)、[收起胶囊](evidence/20261021-cua-pip-compact.png)。
