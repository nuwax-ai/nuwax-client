# 计划：Computer Use 控制层修正与浏览器通道

- 对应：`plans/20261014-computer-use-control-layer-intent.md` → `specs/computer-use-control-layer.md`
- 分支：`codex/computer-use-product`（已合入 release/v3.0.x `1ea92ff3`）
- 范围：只改商业 overlay；不改社区基座和 Nuwax Computer Use 程序本身。
- 开工前提：负责人确认规格里的 R1（推迟并发）和 R4（接管用户浏览器只经限定窗口）。

## 步骤

| # | 内容 | 落点 | 完成标准 |
|---|---|---|---|
| 0 | **基线**：用现有代码跑一轮基准任务集 | `docs/acceptance/20261014-computer-use-control-layer.md`、`docs/acceptance/fixtures/` | 7 个任务各有结果和计数；需要真实模型和辅助功能授权，环境不具备时交给负责人跑 |
| 1 | 结果分级纯函数 | `cua/cuaOutcome.ts` 及其测试 | T1 通过，样本来自规格附录 B |
| 2 | 状态机改造：结果分级、按目标的观察额度、"无进展"、越权计数、`stats` | `cua/taskController.ts` 及其测试 | T2 通过；既有用例按规格改写，不删除覆盖面 |
| 3 | 网关接入分类；`onFailure` 只处理结果不确定和停止类原因；注入 `instructions` 和工具说明前缀 | `cua/mcpGateway.ts`、`cua/cuaGuidance.ts` 及其测试 | T3 通过 |
| 4 | 窗口模式支持浏览器；`browser_prepare` 接管检查；策略文件；清理 `debug_window_info` | `cua/windowScope.ts`、`cua/computerUse.ts` 及其测试 | T4 通过 |
| 5 | 类型、原因文案、四个语言文件、操作记录里"被拒绝"步骤的样式 | `shared/types/cuaRuntime.ts`、`shared/cuaPresentation.ts`、`shared/locales/*.json`、`CuaControls.tsx`、`controlWindow.ts` | 界面可以显示新原因；`CuaControls` 的测试通过 |
| 6 | 真实 helper 的拒绝结构回归测试 | `scripts/computer-use/verify-helper-refusals.cjs` | 用本地 helper 跑通；结构一变就失败 |
| 7 | 质量门 | — | `npm run test:commercial` 通过；`npm run base:test` 在隔离副本里通过；`npm run check:pin` 通过；类型检查对比改造前基线没有新增错误 |
| 8 | 真机验证 T7 和改造后基准 T8 | 验收文档 | 每项写明实测结果；没跑的项写明原因和负责人 |
| 9 | 合入 release/v3.0.x 前按 `pre-commit-quality-review` 自查 | — | 三问都有结论和证据 |

第 1 到第 5 步每步单独提交，便于评审和回退。

## 风险

- **观察摘要可能不稳定**：如果观察回复里每次都会变的字段识别不全，判定就会退化为只用兜底规则（连续超过 12 次）。在第 2 步用真实回复确认，结论写回本计划。
- **绑定回复的字段名未知**：窗口模式下，`get_browser_state` 绑定回复里 target_id 和 tab_id 的字段名，要在第 4 步用真机 Chrome 确认。确认之前，代码只认找到的字段，找不到一律拒绝。
- **接管能力被收紧**：R4 会让整个桌面模式下"接管用户浏览器"从目前可能可用变成被拒绝。验收文档要写明这一变化，以及用户该怎么做（在限定窗口里选中浏览器窗口）。
