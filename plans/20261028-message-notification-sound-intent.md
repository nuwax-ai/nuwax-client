# 意图：新消息音效提醒（可开关 + 洪峰节流）

- 日期：2026-10-28　发起人：用户（会话口述需求）
- 状态：草案（Q1–Q5 已按建议默认落 specs/message-notification-sound.md，负责人复核后置「已接受」）
- 参考：市面产品调研结论见本 intent 附录（Telegram Desktop 源码级节流参数、Android setOnlyAlertOnce、Discord/Slack 聚焦抑制、微信合并通知、钉钉三独立开关、飞书免打扰+加急穿透）

## 问题

收到新消息时，用户在客户端/web 端没有音效提醒，人不在界面跟前就感知不到消息到达。同时不能简单「每条消息响一次」：会话高峰期（如群里几十条连发、多会话并发）会变成声音轰炸。

## 预期结果（可观察验收点）

1. 开关开启时，收到新消息播放一次提示音；自己发送的消息不响。
2. 设置 → 通知 里有「新消息提示音」开关，默认开启，改动即时生效、跨刷新保留。
3. 洪峰节流可演示：短时间内（任意会话混合）到达几十条消息，提示音最多每冷却窗口一次、不重叠、不连续轰炸。
4. 用户正盯着消息界面时不被打扰（一期判据见开放问题 Q1）。
5. 未读红点/角标行为完全不变——节流只作用于「声音」，信息一条不丢。
6. 纯浏览器端首次播放前用户点过页面即可正常响（autoplay 解锁）；客户端 webview 直接可响。

## 功能范围

**本期做**
- 主站（nuwax 前端）新增：音效播放服务、新消息事件订阅、设置「通知」分区与开关、提示音资产、节流逻辑。
- 开关持久化（存储介质见 Q2），默认开。
- 洪峰节流三板斧：冷却窗口（建议全局 3s，覆盖 Telegram 的每会话 500ms 语义）、播放中不重叠、用户正在看时不响（判据待 Q1）。

**本期不做（后续增强方向）**
- 勿扰时段、@/加急穿透（飞书模型）、仅私聊+提及才响（Slack 模型）、退避熔断（1 分钟响满 N 次自动静音）。
- 音效多选/自定义/音量调节（Telegram 8.7 模式）。
- 会话级单独静音。
- 跨设备同步设置（若 Q2 选 localStorage，则此项顺延）。

## 核心流程（草案，spec 阶段细化）

1. **挂点**：`nuwax/src/services/imEventBridge.ts` 新增订阅 `window.__im.onMessage`（桥契约 `ImWindowBridge.onMessage` 已存在、`ImMessageEvent` 已备好 convType/senderType/selfSent/mentionedMe 字段——主站目前未订阅，是现成挂点）。过滤：`selfSent=true` 不响；`senderType=3`（系统）建议不响。
2. **播放**：新建音效服务（全仓无音频播放先例），内置短音效（<1s，建议 mp3+ogg 双格式或单一 mp3）；`HTMLAudioElement` 播放，播放中置「正在播」标记。浏览器端首次用户交互时解锁（autoplay 策略）；客户端 Electron 默认 `no-user-gesture-required` 无需处理。
3. **节流**：全局冷却计时器（上次播放后 N 秒内到达的消息不触发，建议 N=3s 可配置常量）+ 「正在播」跳过。与抑制判据（Q1）串联后决定是否播放。
4. **设置**：`SETTING_ACTIONS`（`src/constants/menus.constants.tsx`）新增「通知」分区（enum + 列表项 + `Setting/index.tsx` renderContent 分支），内含提示音开关行；文案补 5 语言文件（`src/locales/i18n/{zh-CN,zh-TW,zh-HK,en-US,ja-JP}.ts`）。
5. **持久化**：仿 `chatPanelWidthPreference.ts`（localStorage）或走 `userConfig` KV 接口（跨设备），待 Q2。

## 受影响的能力面

- **nuwax 前端仓（主改动面）**：`src/services/imEventBridge.ts`（订阅）、新音效服务+资产、`src/constants/menus.constants.tsx` + `src/types/enums/menus.ts` + `src/layouts/Setting/index.tsx`（新分区）、偏好存储新文件、`src/locales/i18n/` 5 语言。主站是 umi4（非 Vite），`.umi` typings 已支持 mp3/ogg/wav import。
- **IM 子应用（`submodules/nuwax-im`，pin 死 + 构建期 patch/overlay）**：尽量不动；仅当 Q1 选「桥加 activeConvId」时改 `imBridge.ts` 契约（文档 `docs/im-event-reference.md` §5.3 允许的增量改动）。
- **nuwax-client 壳**：预期不动渲染层以外代码；随发版走既有「前端 dist 构建 + 外层 pin bump」链路。
- **外部暴露面**：无新 API；若走 userConfig 持久化仅在现有 KV 接口新增 key。

## 约束

- 桥事件是 P1 尽力而为、不补发（`docs/im-event-reference.md` 已知限制）：音效允许漏响，**不做**对账/补偿机制（与现有桌面通知同一口径）。
- IM 子应用现有桌面通知（子应用 `notify.ts`，仅后台/失焦时弹，localStorage `nuwax-im.notify`）与本功能相互独立，行为不得互相干扰；商业壳下已有 `setNotificationEnabled` 原生路径，音效不经过它。
- 浏览器 autoplay 策略：未交互过的页面首次播放会被拦，须首交互解锁；解锁前漏响可接受。
- i18n 五语言文件必须同步补齐（zh-CN/zh-TW/zh-HK/en-US/ja-JP），键命名沿 `PC.Pages.Setting.*` 四段式惯例。
- 前端仓并行开发纪律：动 `nuwax/` 须 fetch + worktree + rebase origin 尖端，勿碰用户主检出。

## 开放问题

- **Q1「正在看就不响」的一期判据**（待用户/产品拍板）：
  - 方案 A（建议一期）：与子应用 `notify.ts` 的 `shouldNotify` 同判据——窗口失焦/后台才响（`visibilityState === 'visible' && document.hasFocus()` 则不响）。主站侧自建判据即可，不动 IM 子应用。代价：用户聚焦在应用其他页面（没在看消息）时也不响。
  - 方案 B（完整版，建议二期）：`imBridge.ts` 暴露 `activeConvId`（或 onViewChange），实现「聚焦且当前会话==来消息会话才不响」（Discord 粒度）。需动 IM 子应用桥契约。
- **Q2 开关持久化介质**（待拍板）：localStorage（设备级，与现有 `nuwax-im.notify`、`chatPanelWidthPreference` 先例一致，实现最省）vs `userConfig` KV 接口（跨设备同步，走后端）。建议一期 localStorage。
- **Q3 提示音触发范围**（待拍板）：单聊+群聊+团队会话全响（微信模式，建议一期）vs 仅单聊/被提及才响（Slack 模型）。事件字段已支持两种（convType/mentionedMe）。
- **Q4 提示音资产**（待用户选）：默认用哪个音效文件、是否需要候选几款让用户挑。一期建议固定一款轻量短音。
- **Q5 冷却窗口具体数值**（低风险，可默认 3s 后续调）：Telegram=500ms/会话，微信体感秒级；建议全局 3s 起步。

决议（2026-10-28，按建议默认推进、待负责人复核；推翻时的影响面见 spec 需求基线表）：**Q1=失焦/后台才响（一期，Discord 粒度留二期）、Q2=localStorage `nuwax.message-sound`、Q3=全部会话+过滤 selfSent/系统消息、Q4=内置单款 CC0 mp3、Q5=全局冷却 3000ms**。已收敛至 specs/message-notification-sound.md。

## 附录：市面调研结论摘要（2026-10-28）

共识组合=全局开关（默认开）+三层降噪（正在看不响/冷却窗口只响一次/永不重叠），只节流声音、未读照常。关键参数与佐证：Telegram Desktop `notifications_manager.cpp` `kMinimalAlertDelay=500ms`（同会话合并窗口）+每 thread 队列只留最早一条+反应通知 1h 去重；Android `setOnlyAlertOnce(true)`+稳定通知 ID（平台级「更新不响」）；Discord 聚焦看频道不响（官方设计行为）；Slack 每频道三档+DND；微信合并通知只响一次+正在看不提醒；钉钉「桌面通知/提示音/免打扰」三独立开关；飞书免打扰+@穿透+加急独立强提醒通道。
