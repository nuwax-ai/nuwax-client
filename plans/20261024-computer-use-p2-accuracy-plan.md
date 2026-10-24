# 实施计划：Computer Use P2 点击准度与敏感区硬拦

- 对应 spec：无（中等需求，仅本 plan）
- 状态：已接受（任务：prefer `element_index` + 敏感 UI 黑名单；draft PR → `release/v3.0.23`）
- 基线：`release/v3.0.23` @ `2621c375`（含 #61 P0 / #63 P1 / #62 helper cache）

## 已证实缺口（对照 #59/#60/#61/#63）

只读 tip 后能用代码证伪；**不是**授权刷新 / linger / 浮层手感 / 应用黑名单配置 UI。

1. **element_index 只在指导与窗口 scope 里，不在桌面执行路径。** `cuaGuidance` 写「优先 element_index，坐标最后手段」；`scopeCuaCall` 在 window 模式拒绝 x/y。但 desktop 模式 `transformCall` 原样转发坐标，宿主机**从不**用最新观察的 AX 元素把点按改写成 `element_index`。真机 Mac 点偏/点错的假设与此一致：模型猜像素，helper 按像素打。
2. **敏感区没有点击硬拦。** 现有三层不可替代、也未覆盖本缺口：
   - `cuaPrivacy`：密码框/锁屏只打码截图，不拦 click/set_value；
   - `isSensitiveCuaCall`：付款/杀进程等在 **ask 模式**走 `confirmationRequired` + `allowCuaSensitiveOnce`（已有允许路径，保留）；
   - `matchesCuaBlacklist`：用户配置的**应用**黑名单，不含密码框、卡号栏、TCC/SecurityAgent 授权钮。
3. 坐标点在密码框上时，args 往往只有 `{x,y}`，现有 label 正则看不到，会直接点下去。

## 改动文件清单

| # | 文件 | 动作 | 说明 |
|---|---|---|---|
| 1 | `overlay/.../computer-use/cuaTargeting.ts` | 增 | 解析观察元素；有 `element_index` 则丢掉 x/y；纯坐标命中元素则改写为 index |
| 2 | `overlay/.../computer-use/cuaTargeting.test.ts` | 增 | (a) index 优先；(b) 敏感目标拒绝 |
| 3 | `overlay/.../computer-use/cuaSafety.ts` | 改 | 内置特权应用；密码/支付栏/授权对话框硬拦（不另起平行系统） |
| 4 | `overlay/.../computer-use/cuaSafety.test.ts` | 改 | 内置应用 + 敏感控件分类 |
| 5 | `overlay/.../computer-use/computerUse.ts` | 改 | 记住最近一次观察；`transformCall` 先解析再 scope |
| 6 | `overlay/.../computer-use/mcpGateway.ts` | 改 | `sensitiveTarget` 列入 CALL_REJECTIONS |
| 7 | `overlay/.../computer-use/cuaGuidance.ts` + 测试 | 改 | 配方写明宿主会改写坐标；拒绝文案 |
| 8 | `shared/features/computer-use/presentation.ts` | 改 | `CUA_REASON_KEYS` 加 `sensitiveTarget` |
| 9 | `shared/locales/{zh-CN,zh-TW,zh-HK,en-US}.json` | 改 | 与 #61/#63 同风格的人话 |
| 10 | `shared/types/permissionOnboarding.test.ts` | 改 | 四语新键（locale 断言不进 CU feature，守 R1） |
| 11 | `overlay/.../mcpGateway.test.ts` | 改 | 网关层：观察后坐标被改写；密码框拒绝 |

不改：同意书流程、应用黑名单 UI、发版/tag、P0 权限轮询、P1 浮层、无关模块。

## 实施顺序

1. 纯函数 `cuaTargeting` + 扩展 `cuaSafety`（无网关依赖）。
2. `computerUse` / `mcpGateway` 接入：观察入索引，写操作先解析再 scope。
3. guidance + 四语 + `CUA_REASON_KEYS`。
4. 域测试 + `check-feature-boundaries`。

## 证明成立的测试

- `cuaTargeting.test.ts`：同时给 index 与 x/y 时只保留 index；坐标落在观察元素上则改写；画布无元素则保留坐标；密码/卡号/授权钮抛 `sensitiveTarget`；「忘记密码」链接不拦；ask 模式付款钮仍走既有 `confirmationRequired` 而不是硬拦。
- `cuaSafety.test.ts`：SecurityAgent / loginwindow 命中内置名单；普通 Safari 不误伤。
- `mcpGateway.test.ts`：desktop 观察后 `{x,y}` 转发为 `element_index`；点到 `AXSecureTextField` 回 `sensitiveTarget`。
- 回归：上列文件 + `cuaGuidance.test.ts` + locale 四语 + `node --test scripts/check-feature-boundaries.test.mjs`。

## 风险与回退

| 风险 | 缓解 | 回退 |
|---|---|---|
| 误把「允许」饼干横幅当 TCC | 授权钮必须同时命中辅助功能/屏幕录制等主体，或窗口属于 SecurityAgent/loginwindow | 收窄到仅 secure role + 内置应用 |
| 改写用了过期快照 | 索引只在 ok 观察后覆盖；pause 后 controller 仍要求新观察才会放行写入 | 解析失败则不改写 |
| 挡住用户已确认的付款 | 付款/转账**按钮**仍只走 `isSensitiveCuaCall` → ask 确认；硬拦只针对密码栏/卡号栏/特权对话框 | 保持 #60 确认路径不动 |

## 偏离记录

- 网关 `onResult` 一律带上 `permit.owner`（桌面与多窗口同一套索引键），否则桌面会话会把观察记在 `""`、点击按会话 owner 查找而改写失败。
- ask 模式 `requireConfirmation` 也会先按最新观察解析控件，避免坐标点在「付款」钮上绕过既有确认路径。
- 既有 `mcpGateway` 断言补了 owner 第五参，行为未变。
