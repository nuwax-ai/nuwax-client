# 实施计划：Computer Use P3 设置收敛与同意书精简

- 对应 spec：无（中等需求，仅本 plan）
- 状态：已完成（任务：consent copy + settings consolidation；draft PR → `release/v3.0.23`）
- 基线：`release/v3.0.23` @ `2621c375`（已含 P0 #61 / P1 #63 / helper cache #62）

## 已证实缺口

1. **同意书过长、授权对象不醒目。** `consentDescription` 一段话同时讲能力、截图、询问式/全部开启、黑名单、容器 beta。用户要授权的是 **Nuwax Computer Use**，不是笼统 Agent；询问式/黑名单/容器边界已在设置页重复。
2. **设置面扁平散落。** 启用、待授权、系统授权、光标、授权模式、黑名单、隐私、任务模型、锁屏各占一行，下一步不突出；待授权单独成行，与启用开关重复。
3. **授权页与设置页入口未对齐。** `PermissionGuide.helperDisabled` 只说「开启后再完成」，没有指到设置 → Computer Use 这一处完成启用 + helper 授权。

不改：权限模型、IPC、轮询/linger、overlay、element_index、发版/tag。

## 改动文件清单

| # | 文件 | 动作 | 说明 |
|---|---|---|---|
| 1 | `renderer/.../permissionUx.ts` + `.test.ts` | 改 | `cuaNextAction` / 状态文案键；不改权限判定 |
| 2 | `renderer/.../ComputerUseSettings.tsx` + `.module.css` | 改 | 三簇：启用与授权 / 操作偏好 / 隐私；待授权并入启用行 |
| 3 | `renderer/.../ComputerUseSettings.test.tsx` | 增 | 分组渲染、同意弹窗键、必要控件仍在 |
| 4 | `shared/locales/{zh-CN,zh-TW,zh-HK,en-US}.json` | 改 | 短同意书 + 分组/下一步键；四语同步 |
| 5 | `shared/types/permissionOnboarding.test.ts` | 改 | 同意书含 Nuwax Computer Use、必要法律含义、短于旧稿 |

## 实施顺序

1. 抽出下一步谓词并单测。
2. 四语文案。
3. 设置页分组与同意弹窗。
4. 设置渲染 + locale 断言。

## 证明成立的测试

- `permissionUx.test.ts`：下一步 = 安装 / 开启 / 授权 / 就绪。
- `ComputerUseSettings.test.tsx`：三簇、同意键、取消启用在启用行、偏好与隐私控件仍在。
- `permissionOnboarding.test.ts`：四语 consent 含「Nuwax Computer Use」、截图本机、可随时关、mac 对象（不要 Nuwax.app）。
- 回归：`permissionUx` / `CuaControls` / `PermissionsPage` / feature-boundaries。

## 风险与回退

| 风险 | 缓解 | 回退 |
|---|---|---|
| 同意书删掉询问式/黑名单被审为「少披露」 | 设置页仍保留授权模式与黑名单；同意书保留能力+截图本机+打码+可关+正确授权对象 | 把询问式一句加回 consent |
| 分组 CSS 破坏 settings 行分割线 | 簇内继续用注入的 Row；簇标题不占 Row | 去掉簇标题，只并 pending 行 |

## 偏离记录

- 未拆 `consentGrant` / `consentMac` 多键：单条缩短的 `consentDescription` 已含授权对象、能力、截图本机、打码、可关、不要勾 Nuwax.app。
- 授权页 helper 行保留（首次引导仍需要）；只改 `helperDisabled` 指向设置 → Computer Use。
