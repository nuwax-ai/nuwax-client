# 实施计划：Computer Use P0 运行时授权顺滑

- 对应 spec：无（中等需求，仅本 plan）
- 状态：已完成（dong「全做，你排期」；P0 = 运行时顺滑，不加清单行）
- 基线：`release/v3.0.23` @ `6efe1eb2`

## 已证实缺口（不重做清单）

1. 设置页 CU 权限点只在 `focus` / `cua:runtime` 刷新；授权页已有 1.5s 可见轮询。用户在系统设置勾完回到设置页，绿点可能滞后。
2. 权限宿主 20s 硬超时会删结果文件并 pkill；慢速勾选「Nuwax Computer Use」会超时且迟到结果被丢，必须再点一次。
3. 文案未把「必须授权 **Nuwax Computer Use**，勾 Nuwax.app 无效」写死；`PermissionGuide.helperPending` 仍误称「本版本尚未接入检测」。
4. CU 已启用但 daemon 未运行时，`getCuaStatus` 回退 `lastPermissionHint`，可能把过期的 `true` 显示成已授权。

## 改动文件清单

| # | 文件 | 动作 | 说明 |
|---|---|---|---|
| 1 | `overlay/.../permissionPolling.ts` | 改 | 泛化为 `watchVisibleSnapshot<T>`，授权页与 CU 设置共用 1.5s 可见轮询 |
| 2 | `overlay/.../ComputerUseSettings.tsx` | 改 | 接入轮询；权限行内写清 helper 对象；缺权/失败恢复按钮（开系统面板 / 复查 / 重装） |
| 3 | `overlay/.../computerUse.ts` | 改 | 20s 软超时后继续看结果文件；启用但 daemon 宕时不把过期 granted 当活证据 |
| 4 | `overlay/.../locales/{zh-CN,zh-TW,zh-HK,en-US}.json` | 改 | 中英一致：helper 对象、超时续看、安装失败可读错误 |
| 5 | `overlay/.../computer-use/permissionUx.ts` | 增 | 错误码映射与是否展示恢复（可单测） |
| 6 | 对应 `*.test.ts(x)` | 改/增 | 迟到结果续看、daemon 宕不报假绿、轮询泛型、文案/恢复谓词 |

不改：overlay 重设计、element_index、同意书、黑名单、发版/tag。

## 实施顺序

1. 抽出 `permissionUx` 与轮询泛型（无行为依赖）。
2. 主进程：软超时 + linger；`getCuaStatus` 中和过期 granted。
3. 设置页接入轮询与行内引导/恢复。
4. 四语 locale。
5. 域测试。

## 证明成立的测试

- `computerUse.test.ts`：超时后迟到结果写入 `lastPermissionHint`；用户取消仍丢弃；enabled && !running 不报告 stale `true`。
- `permissionPolling.test.ts`：原 1.5s/focus/hide 行为保持。
- `permissionUx.test.ts`：错误前缀映射、恢复谓词。
- 回归：上述文件 + `permissionOnboarding` locale 槽位。

## 风险与回退

| 风险 | 缓解 | 回退 |
|---|---|---|
| linger 拖住退出 | 取消/退出立即 abort linger 并 pkill；`suspendCua` 一并等待 linger cleanup | 去掉 linger，只留轮询+文案 |
| 轮询打 daemon | 沿用授权页 1.5s；隐藏/卸载即停 | 退回 focus-only |
| 误开主程序屏幕录制登记 | 打开面板走 `permissionOnboarding` 的 helper_*，不走会 `getSources` 的主程序 SR 通道 | 只保留「去授权 / 检查」 |

## 偏离记录

- 未新增 CU IPC：打开系统面板复用已有 `permissionOnboarding.openSettings(helper_*)`，避免主程序 SR 的 `getSources` 误登记 Nuwax.app。
- 20s 仍是启用流程软上限（开关不空转 90s）；迟到结果靠 linger + 设置页 1.5s 轮询变绿。
