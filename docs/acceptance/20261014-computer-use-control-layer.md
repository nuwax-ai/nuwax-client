# 验收：Computer Use 控制层修正与浏览器通道

- 规格：`specs/computer-use-control-layer.md`；计划：`plans/20261014-computer-use-control-layer-plan.md`
- 分支：`codex/computer-use-product`
- 环境：本机 macOS，Nuwax Computer Use 0.28.2（`/Applications`，正式签名，已授权）；网页任务使用另起的独立 Chrome 实例，没有碰用户自己的浏览器
- 方法：`scripts/computer-use/bench/README.md`；原始结果：`docs/acceptance/computer-use-bench/*.json`

## 一、基准测试结果（改造前后对比）

改造前用 `6ac61ca2` 的控制层（结果文件 `results-baseline-v2-*`，因为是从导出副本运行，文件里的 commit 字段为空）；改造后用 `b277525a`（`results-after-*`）。两边跑的是同一套任务脚本，每边两轮，两轮结果一致。

| 任务 | 改造前 | 改造后 | Agent 调用（前→后） | 被"先观察"拒绝（前→后） | 人工恢复（前→后） |
|---|---|---|---|---|---|
| N1 计算器 6×7 | 成功 | 成功 | 19 → 11 | 5 → 1 | 0 → 0 |
| N2 原生滚动长页面 | **失败**（第 4 次滚动被判"重复动作"，不可恢复） | 成功 | 15 → 27～29 | 1 → 1 | 1 → 0 |
| W1 浏览器表单 | 成功 | 成功 | 19 → 15 | 4 → 2 | 0 → 0 |
| W2 浏览器滚动 | 成功 | 成功 | 10 → 10 | 1 → 1 | 0 → 0 |
| W3 跳转后用旧引用 | 成功 | 成功 | 13 → 11 | 2 → 1 | 0 → 0 |
| **合计** | 4/5 | **5/5** | 76 → 74～76 | 13 → 6 | 1 → 0 |

N2 改造后调用变多，是因为它一路滚到了按钮所在位置（改造前在中途被终止）。

窗口模式（结果文件 `results-window-*`）：WS 任务两轮都成功。Agent 在不指定任何 id 的情况下接管并绑定选中的测试浏览器窗口，填表提交；中途故意越界两次（操作未绑定的标签页、另开隔离浏览器），都被拒绝为 `scopeViolation`，任务没有中断。

说明：改造后，整个桌面模式会拒绝接管已有浏览器配置（规格 R4）。为了和改造前同口径对比，网页任务用 `--bench-allow-attach` 放行了对测试实例的接管；这个开关只存在于测试脚本里，产品代码没有。

## 二、实测确认的事实

- **R4 的前提成立**：改造前的启动参数（`--permission-mode unrestricted --dangerously-bypass-approvals`）下，`browser_prepare` 带上 `strategy.kind=existing_profile` 就能直接接管一个已打开调试端口的 Chrome。回复为 `attached_existing_profile`、`displayed_consent_prompt:false`，没有经过宿主审批。
- **另开隔离浏览器在常见的 Mac 上不可用**：Chrome 是拖拽安装的（属主为当前用户）时，`browser_prepare` 隔离启动返回 `browser_route_unavailable`（no vendor-signed system Chromium executable）。因此浏览器通道在多数 Mac 上的主路径是**窗口模式**。
- 窗口模式下生成的策略文件（包括对 `browser_prepare` 的 pid/window_id 约束）被 Nuwax Computer Use 接受：`managed_policy_active` 和 `managed_policy_valid` 均为 true。
- 浏览器绑定回复的字段：`target_id`，以及 `tabs[].tab_id` / `tabs[].active`。
- `semantic_v2` 快照带 `visibility`（`in_viewport` / `offscreen`），默认 `dom_refs_v1` 不带视口信息；窗口元素树里屏幕外的网页元素会被压到窗口底边，高度为 1。
- macOS 上浏览器默认的可信输入路径会被拒绝（`browser_input_trust_unavailable`），需改用 `input_route:"dom_event"`；只有声明了 pointer 动作的引用才能滚动。
- 不带目标的按键滚动，在浏览器有多个窗口时会被拒绝（`same_pid_keyboard_ambiguity`）；带坐标的滚轮路径可用。
- 拒绝回复结构的回归脚本 `scripts/computer-use/verify-helper-refusals.cjs` 对 0.28.2 的 8 项检查全部通过。

## 三、测试中遇到的一次异常

改造后第 2 轮第一次运行时，Nuwax Computer Use 守护进程中途退出（进程消失、socket 文件残留），没有崩溃报告，系统日志里也没有记录。重启守护进程后重跑，全部通过，之后没有复现。它发生在网关之外，和本次改动的关系待观察；产品里守护进程退出会被现有的健康巡检发现并暂停任务。

## 四、质量门（合入 release/v3.0.x `25aea924` 之后）

| 检查 | 结果 |
|---|---|
| 商业 `npm run test:commercial` | 3069 通过，18 跳过 |
| 社区 `npm run base:test`（在本 worktree 中运行，之后重新同步 overlay） | 1640 通过，18 跳过 |
| 脚本 `npm run test:scripts` | 339 通过 |
| `npm run check:pin` | 通过，基座 327 个改动文件全部是 overlay 同步产物 |
| 类型检查（对比改造前基线） | 主进程 7 个、渲染进程 236 个错误，与改造前完全相同，均为既有问题；Computer Use 相关文件没有类型错误 |
| 拒绝回复结构回归（0.28.2） | 8/8 通过 |

合入的 release 提交没有改动 Computer Use 相关文件，第一节的基准测试结果仍然有效。

## 五、仍需在正式安装包上验收

- 打开 Computer Use 后，设置页卡片内出现"操作范围"和"诊断"两行（关闭时不显示）；在"操作范围"里选中浏览器窗口进入窗口模式，用真实模型完成网页任务（本轮只用了程序化 Agent；这两行的布局和下拉交互已在独立预览页面验证）。
- 控制条显示"无进展""结果不确定""越权次数过多"三个新原因，以及"已拒绝"的步骤。
- Windows 和 Linux 上浏览器工具的行为（本轮只在 macOS 上验证）。
