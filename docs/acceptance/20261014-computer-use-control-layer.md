# 验收：Computer Use 控制层修正与浏览器通道

- 规格：`specs/computer-use-control-layer.md`；计划：`plans/20261014-computer-use-control-layer-plan.md`
- 分支：`codex/computer-use-product`

## 一、基准测试：改造前（基线）

- 代码：`6ac61ca2`（改造前的控制层）
- 时间：2026-10-14，本机 macOS，Nuwax Computer Use 0.28.2（`/Applications`，正式签名，已授权）
- 方法与任务说明：`scripts/computer-use/bench/README.md`
- 原始结果：`docs/acceptance/computer-use-bench/results-baseline-*.json`

| 任务 | 第 1 轮 | 第 2 轮 | Agent 调用 | 被"先观察"拒绝 | 驱动拒绝 | 暂停原因 | 人工恢复 |
|---|---|---|---|---|---|---|---|
| N1 计算器 6×7 | 成功 | 成功 | 19 / 19 | 5 / 5 | 0 / 0 | 无 | 0 / 0 |
| N2 原生滚动长页面 | **失败** | **失败** | 15 / 15 | 1 / 1 | 0 / 3 | 第 1 轮：重复动作；第 2 轮：报错停机 ×3、重复动作 | 1 / 4 |
| W1 表单 | 成功 | 成功 | 19 / 19 | 4 / 4 | 1 / 1 | 无 | 0 / 0 |
| W2 浏览器滚动 | 成功 | 成功 | 10 / 10 | 1 / 1 | 0 / 0 | 无 | 0 / 0 |
| W3 跳转后用旧引用 | 成功 | 成功 | 13 / 13 | 2 / 2 | 1 / 1 | 无 | 0 / 0 |

观察：

1. **N2 两轮都失败**：页面每次滚动都有进展，但第 4 次相同参数的滚动被判定为"重复动作"，并且不能恢复，任务直接终止。
2. **N2 第 2 轮**：Nuwax Computer Use 有 3 次拒绝带了 `isError`，每次都让任务暂停、等待人工恢复（"报错就停机"）。
3. **W1 和 W3 的浏览器拒绝**（可信输入路径不可用、引用过期）都没有设置 `isError`，被现有网关当成了成功。规格 R2 描述的就是这个问题。
4. **"先观察"门禁的开销**：N1 有 5 次、W1 有 4 次调用因为"每次写操作后都必须重新观察"被拒绝，要额外再观察一次。连打开应用（`launch_app`）也要求先观察。

## 二、实测确认的事实

- **T7 第一部分（R4 的前提）**：在当前启动参数（`--permission-mode unrestricted --dangerously-bypass-approvals`）下，`browser_prepare` 带上 `strategy.kind=existing_profile` 就能直接接管一个已打开调试端口的 Chrome 实例。回复是 `action:"attached_existing_profile"`、`displayed_consent_prompt:false`，没有经过宿主审批。验证对象是另起的独立测试实例，没有动用户的浏览器。
- **另开隔离浏览器在常见的 Mac 上不可用**：本机的 Chrome 是拖拽安装的（属主是当前用户），`browser_prepare` 的隔离启动返回 `browser_route_unavailable`，原因是"no vendor-signed system Chromium executable is available for isolated launch"。cua 只接受系统管理员拥有的安装位置。
- 浏览器绑定回复的字段：`target_id`，以及 `tabs[].tab_id` / `tabs[].active`。
- `semantic_v2` 快照里每个元素带有 `visibility`（`in_viewport` / `offscreen`），可以作为"是否有进展"的依据；默认的 `dom_refs_v1` 快照不带视口信息。
- macOS 上，浏览器默认的可信输入路径会被拒绝（`browser_input_trust_unavailable`），需要改用 `input_route:"dom_event"`；成功后回复是 `effect:"unverifiable"`。

## 三、基准测试：改造后

（待第 1 到第 5 步完成后填写）
