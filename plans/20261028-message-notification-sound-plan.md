# 实施计划：message-notification-sound（新消息音效提醒）

- 对应 spec：specs/message-notification-sound.md
- 状态：待接受（实现不得先于本计划被接受；Q1–Q5 为建议默认，负责人可推翻，推翻点见 spec 需求基线表）
- 改动仓：nuwax 前端仓（单仓全部改动）。nuwax-client 仅消费 dist + bump pin，无代码改动。
- 前端仓开发纪律：不碰 `~/workspace/nuwax` 主检出与本仓 `nuwax/` 子模块工作区；从 origin/feat-2026.9.30 尖端 fetch + 独立 worktree 开分支实现，动前核对尖端。

## 改动文件清单

| # | 文件（nuwax 前端仓） | 动作 | 说明 |
|---|---|---|---|
| 1 | `src/assets/sounds/message.mp3` | 增 | CC0 短音 ≤1s（spec Q4 选型待复核；实现时在提交信息记录出处与许可） |
| 2 | `src/utils/messageSoundPreference.ts` | 增 | 键 `nuwax.message-sound`，`'0'`=关、缺席/其余=开；读写 try/catch 回退默认开。判定时直读 localStorage（每消息一次读，开销可忽略），跨标签页自然同步，免 storage 事件监听——比 spec 所写「仿 imNotificationPreference 同步」更简（轻微简化，行为等价） |
| 3 | `src/services/messageSound.ts` | 增 | 判定链 `isMessageSoundEnabled() → !selfSent → senderType!==3 且 msgType!=='system' → !isPageLooking() → 冷却(3000ms, 常量 SOUND_COOLDOWN_MS)已过 → !isPlaying` → 单例 HTMLAudioElement play()（currentTime 归零；Promise catch 静默；ended/error 清除 isPlaying）。`isPageLooking = document.visibilityState==='visible' && document.hasFocus()`。导出 `handleImMessageEvent(event: ImMessageEvent)` 供订阅侧调用 |
| 4 | `src/services/imEventBridge.ts` | 改 | `subscribeImEvents()` 内、onCustomEvent 订阅之后新增 `if (typeof im.onMessage === 'function')` 订阅：`isCurrent()` 守卫 + 调 `handleImMessageEvent`。不设 hasNativeUnread 门控（消息事件与原生未读路径正交） |
| 5 | `src/types/enums/menus.ts` | 改 | `SettingActionEnum` 新增 `Notification`（带注释，沿现有风格） |
| 6 | `src/constants/menus.constants.tsx` | 改 | `SETTING_ACTIONS` 新增 `{ type: SettingActionEnum.Notification, label: dict('PC.Pages.Setting.Notification') }`（label 字段沿现有条目形态；实际渲染走 getActionLabel） |
| 7 | `src/layouts/Setting/NotificationPanel/index.tsx` | 增 | 「通知」分区面板（目录形态沿兄弟面板）：一行开关「新消息提示音」+ 一行说明文案；受控 Switch 读 `isMessageSoundEnabled()`，onChange 写偏好即时生效 |
| 8 | `src/layouts/Setting/index.tsx` | 改 | `renderContent` 加 `case Notification: return <NotificationPanel />`；`getActionLabel` 加 `case` 返回 `dict('PC.Pages.Setting.Notification')`；import 新面板 |
| 9 | `src/locales/i18n/{zh-CN,zh-TW,zh-HK,en-US,ja-JP}.ts` | 改 | 3 键 ×5 文件：`PC.Pages.Setting.Notification`（通知）、`PC.Pages.Setting.NotificationSound`（新消息提示音）、`PC.Pages.Setting.NotificationSoundDesc`（说明：收到新消息时播放提示音，可在失焦/后台时提醒）——文案以 zh-CN 定稿后翻译 |
| 10 | `docs/im-event-reference.md` | 改 | §2「本仓接线口径」表新增一行：音效提示（消费方 `src/services/messageSound.ts`，经 `onMessage` 订阅，过滤/冷却口径指向 specs/message-notification-sound.md） |
| 11 | `src/services/messageSound.test.ts` | 增 | vitest：过滤矩阵（selfSent/senderType=3/msgType=system/开关关各不响）、冷却窗口（vi.useFakeTimers：窗内第二条跳过、窗外重放）、isPlaying 跳过、isPageLooking 抑制（mock document）、play 异常静默 |
| 12 | `src/utils/messageSoundPreference.test.ts` | 增 | vitest：默认开、`'0'` 关、localStorage 抛异常回退开 |

## 实施顺序

1. **基建先行（无依赖）**：#1 资产 + #2 偏好 + #3 音效服务 + #11/#12 单测，TDD 顺序（先测试后实现）。
2. **接线**：#4 imEventBridge 订阅；现有 imEventBridge 相关测试增补订阅/退订/守卫用例。
3. **设置 UI**：#5–#9（enum → 常量表 → 面板 → 弹窗分支 → i18n 5 文件）。
4. **文档**：#10 im-event-reference.md 补行。
5. **门禁**：`npx vitest run`（全量）+ `npm run test:typecheck` + lint 通过后提交前端仓分支。
6. **消费链（nuwax-client 侧）**：前端 dist 重建（`npm run frontend:build` 或 sub 链）→ 外层 bump 子模块 pin → dev 冒烟（mac 双服务）：双账号互发消息验证 spec 测试计划的手动项。
7. **客户端真机项**（打包版或用户验收）：壳最小化/失焦时响（hasFocus 判据验证）；webview autoplay 直响。

步骤 1–4 在前端仓单 worktree 内串行即可（总改动量小，无需并行 worktree）；步骤 6 在 nuwax-client 仓执行。

## 证明成立的测试

- 新增测试：#11、#12（见清单）+ imEventBridge 增补用例。
- 回归范围：前端仓 `npx vitest run` 全量 + `npm run test:typecheck`。本仓（nuwax-client）无 overlay/基座改动，`base:test`/`test:commercial` 不涉；dist bump 后随打包链照常验证。
- 手动冒烟（dev，我来跑）：失焦收消息响一次；连发 20 条仅响一次；注视页面不响；开关即时生效且刷新保留；未开过消息页的会话不响（边界符合预期）。
- 真机项（需用户/打包版）：见顺序第 7 步。

## 风险与回退

| 风险 | 缓解 | 回退方式 |
|---|---|---|
| 前端仓并行开发冲突（用户高频提交） | 独立 worktree + 开分支前 fetch 核对 origin 尖端；不动主检出 | 丢弃 worktree 分支 |
| 音效资产版权/品质 | CC0 来源并在提交信息记录出处；Q4 本就待复核 | 换文件只动 #1 一处 |
| 浏览器 autoplay 拦截 | 登录交互已满足 sticky activation；被拦时静默漏响（spec 已接受口径） | 无需回退 |
| 客户端 hasFocus 判据不随壳窗口 | spec 测试计划真机验证项；若不成立，接入既有 `src/services/hostVisibility.ts`（壳 host-activity 通道）增强判据 | 判据函数单点改动 |
| 桥事件 P1 丢失导致漏响 | 既有口径，不补偿 | 无需回退 |
| 整体功能回退 | 前端分支 revert；外层未 bump pin 前客户端包不受影响 | revert 分支 / 回退 pin |

## 偏离记录

- 2026-10-28 计划时即记录：偏好跨标签同步用「判定时直读 localStorage」替代 spec 写的「storage 事件监听」（行为等价、实现更简）。
