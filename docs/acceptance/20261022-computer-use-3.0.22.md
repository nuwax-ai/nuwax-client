# Computer Use · 3.0.22 整合验收候选

本候选从 3.0.22 基线 `0f16fc665b` 整合，运行时代码冻结于 `658b915c`，分支 `feat/computer-use-3.0.22-integration`。已按用户追加要求安装到 `mac-dbg` 做真机验证。完整 Agent 任务仍在等待可用会话模型，Windows 真机未验收；本候选未发布到更新源。

## 来源完整性与保全

盘点了 53 个来源 worktree，另建独立整合 worktree，不改动来源工作区。逐工作区 HEAD、未提交改动及逐文件整合动作/摘要见 [来源清单](20261022-computer-use-3.0.22-sources.json)。对所有相关已提交历史进行行为核对，未用“旧 SHA 是否为祖先”单独判断是否遗漏。

Claude Code 两个已结束会话 `b373cfa2-a92a-4b2a-91cd-6b85633bb222`、`e7157a29-0021-42e7-b9eb-535d9fe3c8e1` 的最后实现已包含在原多窗口工作区快照 `286916f31664dd8d68c89cb4584c4c964af59f7b`，保留于 `chore/cua-source-snapshot-20261022` 及仓外 bundle。来源暂存区与未提交代码均保留。原会话监控定时任务已删除。

最终再次核对：来源 Computer Use 代码未新增变化；多窗口验收文档新增了未完成的 Mac 7×5 历史结果，已原样保留在 [原记录](20261019-computer-use-multiwindow.md)，不计作本候选的验收通过。另一个工作区更新至 `6d0082c7`，该提交已是本次 3.0.22 基线的祖先。

| 来源 | 内容及本候选落点 | 结论 |
| --- | --- | --- |
| `8e19234c` | `features/computer-use/{computerUse,sessionAuthority,taskController}`：会话隔离、预算、取消撤权、诊断 | 纳入，保留 3.0 边界 |
| `b865254c`、`afb2ae13`、`3e8927c7` | `cuaOutcome`、`cuaGuidance`、`mcpGateway`：结果分类、按目标观察额度、无进展与拒绝计数 | 纳入 |
| `4b391e7a`、`28556807`、`220b0616`、`eb05b6a5` | 限定窗口内的浏览器工具、失败呈现、唯一额度归属、scope/diagnostics 设置 | 纳入 |
| `2dbc6221` / 3.0 等价修复 | `vlmDiagnostics`、`ComputerUseSettings`：真实图像测试、推理响应兼容及可读错误 | 保留并迁移 |
| `69bcd5c6`、`c57e43b5` / 3.0 等价修复 | helper 身份诊断、签名主体及商业图标 | 保留 |
| `62fa3c71`、Claude 权限引导 WIP | `permissionOnboarding`、`permissionDragChip`、权限页、独立 preload、四语言 | 纳入，并补齐 helper 权限适配器接线 |
| `ca89aa34` | `features/_kit`、`featureHost`、ACP 会话参与者 | 仅纳入 Computer Use 所需通用端口；移除旧 CUA 注册入口 |
| `61703d91`、`f74ed5cb`、最终 WIP 快照 | `taskRegistry`、窗口绑定/撤权/drain、`previewController`、画中画、badge、原生补丁 | 纳入最终版本 |
| `93c6f078`、Claude Windows 基准修复 | 接管验收标准、Windows 后台锚窗、基准脚本和历史证据 | 纳入；不将未完成基准算通过 |
| `b744305b`、3.0 退出/更新修复 | 服务清理降级、有限等待、退出顺序、原生终止兜底 | 保留并修复失效路径 |

明确排除 nuwax-harness、pi-agent 产品/引擎、Nuwa Browser 新整合；相关源码保留在各自来源。基准目录的 `bench/harness.ts` 是测试框架，不是 nuwax-harness 产品。本机文件直访延续 3.0 的强制关闭；未因通用特性迁移意外启用。NW-151 鉴权、自动端口、老 Windows 终端、当前用户安装和 UAC 修复、原有更新提示继续沿用 3.0.22。

## 默认关闭、退出与更新

- `computerUse.ts:617` 只在持久化 `computerUseEnabled === true` 时开启；未设置时关闭。特性清单中的 `enabledByDefault` 负责注册设置/IPC 入口，不代表启动 Computer Use。回归测试证明：即使 bundle 带有 helper，默认启动只清除旧 CUA MCP 配置，不安装、不启动 helper，其他 MCP 配置保留。已有用户的显式启用偏好保留。
- `commercialAuth.ts:24` 给可选特性停止设置 1500ms 上限；失败或悬挂不阻塞主服务停止，撤权立即生效。删除可能在新服务启动后再次撤权的延迟重试。
- `computerUse.ts:568` 协议停机调用有 1500ms 超时。macOS/Linux 兜底使用 SIGKILL，按 helper 可执行文件和 serve/socket 参数锚定；Windows 同时校验 exe 名与产品 socket 参数。不会以宽泛产品名杀其他命令。
- `features/index.ts:219` 共享幂等退出 promise；`main.ts:574` 的退出步骤有上限，Computer Use 提前清理，`controlWindow.ts` 在 before-quit/dispose 后不再重建浮窗或接收迟到帧。
- 更新仍由既有 `autoUpdater.ts` 的 10 秒安装前清理上限及安装交接处理。删除清理前启动的 macOS 5 秒 `app.exit` 竞态，更新 before-quit 路径不阻止安装器退出，并保留 500ms 最终兜底。

## 验证

证据目录：`/Users/apple/Documents/Codex/2026-10-22/computer-use-consolidation-01a162b4`。

| 检查 | 结果与证据 |
| --- | --- |
| 商业完整测试 | 262 文件通过，1 文件跳过；3290 项通过、18 跳过；`commercial-acceptance-final.log` |
| 社区隔离测试 | 1682 项通过、18 跳过；`community-tests.log`；在独立副本运行，不清理整合 overlay |
| 外层脚本 | 374 项通过；`outer-scripts-verified.log` |
| Electron 控制层 fixture | 正常退出并 PASS；独立 userData；真实 preload/IPC、陌生 sender、任务目标、预览迟到帧、收起不停止和清理；`electron-fixture-isolated.log` |
| 新编译原生 helper | 固定上游 `625118a9076e51da2f57b6a5d475972030197443` 加本候选补丁；真实 endpoint proof、鉴权拒绝、MCP、窗口任务隔离及不支持操作拒绝检查通过；`native-*-verified.log` |
| 原生宿主单元测试 | `cua-driver`、contract、core、macOS 的 lib/bin 1292 项通过、2 跳过；`native-host-unit-verified.log`。直接测试整个上游 workspace 会因 Linux 专用测试在 macOS 引用 cfg 排除模块而编译失败，记录于 `native-unit-verified.log`；未计作全平台通过 |
| 构建 | 生产 main/renderer 构建成功；现存大 chunk 提示；`package-build.log` |
| 边界/pin | import boundary、app data dir、overlay 检查及 `check:pin` 通过；基座脏文件均为 overlay 同步产物 |
| TypeScript / ESLint | 无新增错误。全仓主进程 TypeScript 仍有基线 8 个错误；ESLint 从基线 70 个降至 64 个，无新增错误族。全仓静态检查未全绿，不声称通过；`tsc-main-*.log`、`eslint-*.json` |

## 整批质量自查

按 `pre-commit-quality-review` 三问与 `REVIEW.md` 五遍检查本次全部集成差异；这是 writer 自查，不是 PR 自批。

1. 内聚：CUA 状态、执行额度、取消、原生清理归属 `features/computer-use`；统一注册位于 `index.ts:26`，退出资源位于 `computerUse.ts:1071`，调用方只调用通用生命周期。已修复服务停止悬挂和原生终止无强杀的发现项。
2. 分层：主进程特性通过 `_kit/types.ts`、`ports.ts` 和 `services/featureHost.ts:38` 获取宿主能力；renderer 与 preload 依赖共享契约，ACP 只使用通用会话参与者。删除旧 `services/cua` 与 `ipc/cuaRuntimeHandlers` 入口，避免重复注册。helper 权限适配在 `computer-use/index.ts:36` 注册、dispose 对称释放。
3. 维护：原生补丁只有一个构建输入；任务 ID/绑定/epoch 由宿主管理；预览独立于模型观察，不入观察额度或磁盘。测试覆盖越权、迟到恢复、暂停、撤权/drain、默认关闭与有限等待。发现并恢复 local-files 的 `lockedOff` 边界。

五遍复核：竞态与失败路径有回归；受信 IPC 与精确窗口/权限主体未放宽；共享协议、preload、UI 和四语言同步；代码仅在外层 overlay；测试记录区分自动化、合成 Electron 与真实设备。原生强杀回归在 `edd7850a` 先暴露失败，`658b915c` 修复后通过。

结论：本批次相关自动化门通过，可作为本地验收候选；全仓既有静态检查债务保留，正式发布仍需安装包和真实升级验收。

## 包与用户验收

Mac arm64 3.0.22 验收包、整合源码 bundle、签名/版本/资源核验结果及 SHA256 统一记录于证据目录的 `acceptance-package.json`、`SHA256SUMS`；仓内另存 [包与真机摘要](20261022-computer-use-3.0.22-package.json)。ZIP 为 718541199 字节，SHA256 `6bc51e0f912b6d1bc2f2c1e92849f96839d78679d5b9c07d07617f55b5efe152`。包使用公司 Developer ID 签名，未公证；本次未创建 release/tag 或修改线上更新指针。

### mac-dbg 真机检查点

设备为 `mac-dbg` / macOS 26.5.1 (25F80) / arm64，用户 louis。原 `/Applications/Nuwax.app` 为 3.0.21，原程序和数据库已保留在该机 `Downloads/cua-3.0.22-acceptance-20261022/backup`；数据库备份留在设备，不回传。新包传输前后 SHA256 相同，安装后深度签名校验通过。当前电脑未安装或启动该验收包做真机测试。

| 真机检查 | 结果及限度 |
| --- | --- |
| 默认关闭 | 保留账号和模型配置，仅移除已备份的历史开关字段进行测试：enabled=false、running=false、mcpInjected=false，无 helper 运行 |
| 显式启用 | 成功安装/升级固定路径 helper；辅助功能和屏幕录制均 granted；daemon、策略、gateway 自检通过；多窗口开关开启成功 |
| 权限 UI | 从真实菜单打开设置页，无白屏；权限引导浮层显示 5 项主体及 2 项 helper 授权；独立拖拽卡片实际显示/关闭。未将此记录等同于完成 System Settings 的物理拖放 |
| 视觉连接 | 设备现有 glm-5.3-flash 配置，真实图像请求通过，13672ms；不读取或导出密钥 |
| 原生目标窗口 | 独立 helper 测试进程、独立随机端点及自生成令牌，仅作用于本次创建的 TextEdit 文档：绑定、960×618 目标预览、146 元素观察、后台写入 PASS、重新观察确认、revoke/drain 和撤权后拒绝均通过。该项不冒充 Agent 会话端到端通过 |
| 正常退出 | CUA 和多窗口开启、helper 运行时发送正常退出信号；主进程 0.628s 结束，记录的全部 17 个相关进程 5.549s 内结束，剩余 0；`quit-enabled.json` |
| 更新交接 | 本机 loopback 更新源，运行时仅将 updater.currentVersion 模拟为 3.0.21，实际正在运行的是 3.0.22 候选；通过产品 check/download/安装前清理与真实 Squirrel 替换，helper 停止、旧主进程退出、新主进程重新启动。未改签名包，也未触碰线上更新源 |
| 更新后代码 | 安装版本仍为 3.0.22，深度签名校验通过，app.asar SHA256 为 `f2fa1a8bcea4ef6e6552ee277643c08b3bf5d073d1fc71cf53ae40a07fbfd982`，与构建候选一致 |
| Agent 完整任务 | 默认 Claude Code 返回 Authentication required，系统授权完成后仍复现；用户正在该机配置可用的会话模型。未记为通过 |

真机原始结果与截图在证据目录 `mac-dbg-evidence/`，该机的原始文件保留于 `Downloads/cua-3.0.22-acceptance-20261022/`。更新测试期间临时使用 stable 订阅及本机 feed，原 Beta 订阅已单独记录，收尾时恢复；最终 CUA 开关应保持关闭。

剩余：使用有效会话模型验证多窗口任务、画中画、暂停/接管/停止及活动任务退出；权限卡片的真实系统设置拖放；Windows 安装/更新、MSVC 签名包、DPI/多屏和长时间运行。旧历史基准的未完成项和浏览器后台滚动能力边界见原始记录。
