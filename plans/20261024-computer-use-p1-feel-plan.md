# 实施计划：Computer Use P1 操作手感

- 对应 spec：无（中等需求，仅本 plan）
- 状态：已接受（dong「全做，你排期」；P1 = 浮层响应 / 失败人话 / 急停）
- 基线：`release/v3.0.23` @ `32a50e90`（已含 P0 #61）

## 已证实缺口（对照 #59/#60 精简浮层 + P0，不重做）

只读 tip 后能用代码证伪的缺口；**不是**授权刷新 / linger / 假绿 / 黑名单 / element_index。

1. **精简浮层故意不展示会话失败原因。** `CuaControlBar` 只画 `phase` / `stopping`；`permissionsRequired`、`daemonNotReady`、`uncertainResult`、`gatewayFailed`、`connectionClosed` 已在 `runtime.reason` 且四语齐全，但主浮层不渲染（`CuaControls.tsx` 状态行；测试明确断言 `noProgress` / `userTakingControl` 不出现——这些运营暂停仍归托盘）。用户在会话里会「卡住无反馈」。
2. **任务中心单任务失败永远 generic。** `CuaTaskCenter.tsx` 固定 `Claw.Cua.reason.generic`；同特性 `CuaTaskPanel` 已按 `CUA_REASON_KEYS` 映射。
3. **IPC 人话缺键。** `index.ts` 会回 `operationFailed` / `loginRequired`；`recover` 等会回 `operationCancelled`。三者不在 `CUA_REASON_KEYS`，面板/浮层 toast 掉进 generic，locale 也没有对应句。
4. **急停收尾浮层被拆掉。** `taskController.stop` 立刻把 `phase` 置 `stopped`，`suspendCua` 的 daemon/MCP drain 期间 `controlPending` 仍为 true。浮层 visibility 只认 `running|paused`，主卡和 PiP 在「正在停止输入…」未结束时消失；`helperStillRunning` 文案要求「再点立即停止」，但按钮已卸。
5. **急停藏在 hover 后。** 主卡 `.actions` 与 PiP `#toolbar` 默认 `opacity: 0`，未悬停/聚焦看不到停止。与「立刻停住」冲突，且未回退成重 UI。

**不是缺口（本批不改）：** `cua:runtime` 推送 + revision 防旧快照；`controlPending` 时停止钮不禁用；P0 设置页轮询 / linger / helper 对象文案 / daemon 宕不假绿；#59 精简卡（不恢复范围/诊断/历史）；#60 黑名单与 ask 确认；`toolFailed` 有文案但主进程未赋值——点按失败走已有 `uncertainResult`（写可能已生效，不能谎称「未成功」）。不把 `toolFailed` 硬接上去。

## 改动文件清单

| # | 文件 | 动作 | 说明 |
|---|---|---|---|
| 1 | `shared/features/computer-use/presentation.ts` | 改 | `isCuaLivePhase` / `canShowCuaOverlay` / `cuaReasonKey` / `cuaOverlayNotice`；`CUA_REASON_KEYS` 补 IPC 三码；`canPreviewCuaTask` 覆盖急停收尾 |
| 2 | `shared/features/computer-use/presentation.test.ts` | 增 | 谓词单测（不 import locale JSON，守 R1） |
| 3 | `renderer/.../CuaControls.tsx` + `.module.css` | 改 | 急停收尾仍显示；可执行失败一行；动作条常显 |
| 4 | `renderer/.../CuaTaskCenter.tsx` | 改 | 失败 toast 与面板同一套 `cuaReasonKey` |
| 5 | `renderer/.../CuaTaskPanel.tsx` | 改 | 复用 `cuaReasonKey` |
| 6 | `main/.../taskPreviewWindow.ts` | 改 | PiP 急停收尾 + 失败人话；工具条常显停止 |
| 7 | `main/.../index.ts` | 改 | 托盘急停在 `controlPending` 收尾期间仍在 |
| 8 | `shared/locales/{zh-CN,zh-TW,zh-HK,en-US}.json` | 改 | `operationFailed` / `loginRequired` / `operationCancelled` |
| 9 | `shared/constants.ts` | 改 | 对应 REASON_* 槽 |
| 10 | `shared/types/permissionOnboarding.test.ts` | 改 | 四语新键存在（locale 断言不能放进 CU feature，守 R1） |
| 11 | 对应 `CuaControls` / `CuaTaskCenter` / `taskPreviewWindow` / `controlWindow` / `runtimeHandlers` 测试 | 改/增 | 见下 |

不改：`permissionPolling`、onboarding 类型、element_index、黑名单、同意书、发版/tag。

## 实施顺序

1. `presentation` 谓词 + 单测（无 UI 依赖）。
2. 主浮层 / 任务中心 / PiP / 托盘接入同一套 live + notice。
3. 四语 + constants。
4. 域测试 + `check-feature-boundaries`。

## 证明成立的测试

- `presentation.test.ts`：running/paused 可见；stopped+pending / failed+helperStillRunning 可见；completed/idle 不可见；notice 只覆盖可执行失败，不含 `noProgress` / `userPaused`。
- `CuaControls.test.tsx`：暂停运营原因仍不进主卡；`permissionsRequired` / `uncertainResult` 进主卡；急停收尾仍显示 stopping + 可点停止。
- `CuaTaskCenter.test.tsx`：单任务失败 toast 用 `loginRequired` 而非 generic。
- `taskPreviewWindow.test.ts`：stopped+pending 仍可 stop；暂停权限原因写入 `#error`。
- `runtimeHandlers.test.ts`：`stopped + controlPending` 托盘仍有 stop。
- 回归：`node --test scripts/check-feature-boundaries.test.mjs` + 上列 vitest。

## 风险与回退

| 风险 | 缓解 | 回退 |
|---|---|---|
| 浮层回退成重 UI | 只加一行 clamp 人话 + 常显停止，不恢复范围/诊断/历史 | 去掉 notice，只留急停收尾 |
| 急停收尾卡死不消失 | visibility 仍看 `controlPending`；pending 清零即卸 | 退回 phase-only 隐藏 |
| 误把运营暂停画上主卡 | notice 白名单，测试锁 `noProgress` / `userTakingControl` | 缩小白名单 |

## 真机手感（macOS，本环境不跑）

1. 开电脑操作，看主浮层：停止钮无需悬停即可点。
2. 会话中关掉辅助功能或杀掉 helper：浮层立刻出现「授给 Nuwax Computer Use / 复查」人话，无假绿、无技术栈。
3. 操作中点「立即停止」或 `⌘⇧F12`：状态先变「正在停止输入…」，浮层不闪没；drain 完再卸。若 helper 没停干净，浮层留下「再点立即停止」。
4. 多窗口 PiP：同上，工具条停止常显。
5. 对照：未登录 / 权限页轮询 / 黑名单仍走 P0/#60，不回归重 UI。

## 偏离记录

（实现中逐条补记）
