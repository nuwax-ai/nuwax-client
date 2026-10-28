# 规格：message-notification-sound（新消息音效提醒）

- 对应 intent：plans/20261028-message-notification-sound-intent.md
- 状态：草稿（开放问题按 intent 建议默认推进，标注「⚠待复核」处负责人可推翻；推翻影响点已在文中标注）
- 改动仓：nuwax 前端仓（主站层）。nuwax-client 壳不改代码，仅消费 dist + bump pin。

## 需求基线

继承 intent 全部基线（背景/本期做/不做见 intent，不重复）。开放问题决议：

| # | 决议 | 状态 |
|---|---|---|
| Q1 抑制判据 | 一期「失焦/后台才响」：`document.visibilityState === 'visible' && document.hasFocus()` 时不响（与 IM 子应用 `notify.ts` 的 `shouldNotify`/`userPresence.isLooking` 同口径）。Discord 粒度（桥暴露 `activeConvId`）留二期 | ⚠待复核（若翻成二期不做→一期即为终态，无结构影响） |
| Q2 持久化 | localStorage 设备级，键 `nuwax.message-sound`，`'0'`=关、缺席或其余值=开（对齐 `nuwax-im.notify` 惯例，默认开） | ⚠待复核（翻成 userConfig 则设置行改读写接口，音效逻辑不变） |
| Q3 触发范围 | 全部会话类型（convType 不过滤）；`selfSent`、`senderType===3`（系统）、`msgType==='system'` 不响 | ⚠待复核（收紧口径只改过滤函数一处） |
| Q4 音效资产 | 内置单款短音（≤1s 轻量 ding 类、CC0 无人声），仅 mp3 单格式（主流浏览器全支持），常量冷却不暴露设置 | ⚠待复核 |
| Q5 冷却 | 全局冷却 3000ms（常量 `SOUND_COOLDOWN_MS`，不进设置 UI） + 播放中跳过 | ⚠待复核（仅数值） |

## 方案设计

### 架构落点

全部在 nuwax 前端仓主站层，IM 子应用（pin 死子模块 + patch）**零改动**：

1. **订阅**：`src/services/imEventBridge.ts` 的 `subscribeImEvents()` 内新增 `im.onMessage` 订阅（守卫 `typeof im.onMessage === 'function'`、`isCurrent()`），回调直接调用音效服务。沿用既有生命周期：IM 微应用挂载（`MicroAppHost` L125）订阅，登出/`AUTH_SESSION_CLEARED`/实例重建退订。订阅**不受** `hasNativeUnread()` 门控——商业壳原生未读路径与消息事件正交，webview 内 `window.__im` 照常存在。
2. **音效服务**（新建 `src/services/messageSound.ts`）：单例 `HTMLAudioElement`（`import soundUrl from '@/assets/sounds/message.mp3'`，umi typings 已支持 mp3 import）。纯函数式判定链：`开关开 → !selfSent → 非系统消息 → 页面不在注视(基线判据) → 冷却已过 → 未在播放` → `play()`，`play()` 的 Promise catch 静默（NotAllowedError/加载失败）。播放时置 `isPlaying`，`ended`/`error` 清除。
3. **偏好**（新建 `src/utils/messageSoundPreference.ts`）：仿 `chatPanelWidthPreference.ts` + `imNotificationPreference.ts` 的 storage 事件跨标签页同步；提供 `isMessageSoundEnabled()/setMessageSoundEnabled()`，读写 try/catch（隐私模式异常时回退默认开）。
4. **设置 UI**：`src/types/enums/menus.ts` `SettingActionEnum` 新增 `Notification`；`src/constants/menus.constants.tsx` `SETTING_ACTIONS` 新增列表项；`src/layouts/Setting/index.tsx` `renderContent` 新分支渲染开关行（Switch，改动即写偏好，无确定按钮）。不与 IM 子应用内的「桌面通知」开关（`nuwax-im.notify`）合并、不互相读写。
5. **音效资产**：`src/assets/sounds/message.mp3`（新建目录，随构建打包）。

### 数据与契约

- 无后端 API 变更、无桥契约变更、无 `docs/im-event-reference.md` §4 全键表变化。
- **需双同步的位置**：
  1. `docs/im-event-reference.md` §2「本仓接线口径」表新增一行：音效提示经 `onMessage` 订阅（消费方 `messageSound`，过滤与节流口径指向本 spec）。
  2. `src/locales/i18n/` 5 个语言文件（zh-CN/zh-TW/zh-HK/en-US/ja-JP）新增键：`PC.Pages.Setting.Notification`（分区标题）、`PC.Pages.Setting.NotificationSound`（开关标签）、`PC.Pages.Setting.NotificationSoundDesc`（说明文案，一行）。
  3. localStorage 新键 `nuwax.message-sound` 语义写入本 spec 即为契约。
- 客户端打包链：主站 dist 重建 + 外层 nuwax-client bump 子模块 pin（既有链路，无新契约）。

### 平台/引擎矩阵

| 行为点 | 纯浏览器 Web | 客户端 webview（Electron/Chromium） |
|---|---|---|
| 首次播放（autoplay） | 需 sticky user activation；登录交互本身已满足，仅「免交互自动登录+立刻来消息」理论窗口会被拦，静默漏响可接受 | Electron 默认 `autoplayPolicy=no-user-gesture-required`，直接可响 |
| 事件来源 | `window.__im.onMessage`（IM 微应用自有 WS） | 同左（webview 内同一微前端形态），与壳原生未读 WS 并存互不影响 |
| 失焦判据 | 标准页 API | 壳窗口失焦/最小化 → `document.hasFocus()`=false → 响（真机验证项，见测试计划） |
| 事件可用前提 | IM 微应用已挂载（本次会话打开过消息页，切菜单保活期间持续） | 同左；用户全程未开消息页则不响（与现有桌面通知、角标事件同一既有边界，不新增保活） |
| 多标签页 | 各标签独立订阅、独立响（deviceId 按 tab 隔离，≤5 连接），开关值经 storage 事件跨标签同步 | 不适用（单窗口） |

## 异常与失败场景

| 场景 | 处置 |
|---|---|
| IM 微应用未挂载（没开过消息页）/ IM 断线重连窗口 / P1 帧拥塞丢弃 | 无事件即无音效，漏响不补偿（与桥「尽力而为不补发」口径一致） |
| `selfSent=true`（本人其他设备/标签页回声） | 不响 |
| `senderType===3` 或 `msgType==='system'` | 不响 |
| 音频 play() 被拒（NotAllowedError）或加载失败 | catch 静默，不影响后续重试 |
| 洪峰：冷却窗口内任意会话任意条数 | 只在窗口起点响一次；正在播时再到达的消息全部跳过 |
| 登出 / `AUTH_SESSION_CLEARED` / IM 实例卸载 | 随 `subscribeImEvents` 退订，不响 |
| localStorage 不可用 | try/catch 回退默认开（内存态） |
| 用户注视页面（visible && hasFocus） | 不响，未读角标照常 |
| 开关关闭 | 订阅保持但不进判定链（或判定链首项短路），未读角标照常 |

## 测试计划

- **单测（前端仓，vitest）**：新建 `src/services/messageSound.test.ts`——过滤矩阵（selfSent/senderType/msgType/开关关）、冷却窗口与播放中跳过（fake timers）、注视判据（mock document）；`imEventBridge` 增补 onMessage 订阅/退订/守卫用例；`messageSoundPreference` 默认值与 `'0'` 语义。
- **dev 手动冒烟**（mac 本机双服务，我在 dev 环境跑）：开两条账号互发——失焦收消息响一次；连发 20 条只响一次；聚焦看消息页不响；开关即时生效且刷新保留。
- **客户端真机验证项**（需用户或打包版）：壳最小化/失焦时响（`hasFocus` 跟随验证）；webview 内 autoplay 直响。
- **打包链**：前端 dist 重建后外层 pin bump；商业侧 `test:commercial` 不涉（无 overlay 改动），前端仓自身测试门禁照跑。

## 已否决的备选方案

- **音效放壳主进程播放**：web 端无法复用、需新增桥；渲染层 HTMLAudio 自持即可两端通用。
- **走系统 Notification 的声音**：受系统通知中心设置摆布、节流粒度不可控，且商业壳已有独立的通知开关路径，会形成双开关。
- **桥暴露 `activeConvId` 做 Discord 粒度抑制**：要动 pin 死子模块契约（增量也动），一期失焦判据已覆盖核心诉求，留二期。
- **userConfig 后端持久化**：跨设备收益小、链路长；localStorage 与仓内两个既有先例一致。
- **Web Audio API/AudioContext**：解锁管理比 HTMLAudio 复杂，无收益。
- **Telegram 式双层节流（每会话 500ms + 全局层）**：单层全局 3s 已满足「几十条只响一次」；双层是 Telegram 多 toast 队列的配套复杂度。
- **onMessage 走 eventBus 分发**：当前消费方唯一且过滤逻辑专属，直调服务更直白；eventBus 键留给未来多消费方时再抽。
