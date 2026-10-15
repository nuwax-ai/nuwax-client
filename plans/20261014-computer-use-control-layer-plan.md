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

## 执行记录（2026-10-15）

第 0 到第 9 步已全部完成，基准测试和质量门结果见 `docs/acceptance/20261014-computer-use-control-layer.md`。风险项的结论：

- 观察摘要：窗口元素树和 `semantic_v2` 快照都能反映滚动进展（N2 改造后成功）；默认的 `dom_refs_v1` 快照不带视口信息，只能靠兜底规则。
- 绑定回复字段已实测确认：`target_id`、`tabs[].tab_id`。
- 接管收紧已写入验收文档和给模型的指引。

### 合并前质量自查（pre-commit-quality-review）

范围：`release/v3.0.x...HEAD` 的 overlay 与脚本改动（24 个文件）。

1. **功能内聚**：回复分级集中在 `cuaOutcome.ts`，状态与额度在 `taskController.ts`，作用范围与浏览器绑定在 `windowScope.ts`，给模型的文字在 `cuaGuidance.ts`，网关只负责串联。发现并修复一处：「每次观察允许 3 次写操作」原来在控制器默认值和指引文字里各写一份，已收敛为 `CUA_WRITES_PER_OBSERVATION`。
2. **代码分层**：依赖单向（网关 → 控制器 / 分级 / 指引 / 作用范围；共享层不依赖主进程）。网关新增的两个可选参数 `scope`、`onResult` 有默认行为，旧调用方无须修改。测试脚本直接引用 overlay 源码，只用于测试。
3. **便于维护**：注释只写约束（例如运行时才产生的标签页 id 无法写进 helper 策略、所以只能由网关校验）。发现并修复一处边界：越权次数达到上限停止任务时，进行中的调用要立即返回取消，与用户手动停止一致，已补测试。

Nit（不阻塞）：`shared/cuaPresentation.ts` 的 `actionKind` 和 `cuaOutcome.ts` 的只读工具集合各自维护一份工具分类，原因是共享层不能依赖主进程代码；这是改造前就有的重复。

结论：可合并。修复后质量门复跑：商业 3070 通过，`check:pin` 通过，主进程类型错误数与基线相同。
