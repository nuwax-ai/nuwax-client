# 实施计划：系统通知点击直达会话（macOS / Windows）

- 状态：已完成

## 需求概述

当系统通知（macOS / Windows 系统消息列表中的通知）被点击时，不仅将客户端主窗口呼出并聚焦（restore/show/focus），还需自动导航进入“伙伴”标签（`/instant-message`），并直达对应的会话（群组、私信或智能体会话）。

## 改动文件清单

| # | 文件 | 动作(增/改/删) | 说明 |
|---|---|---|---|
| 1 | `nuwax/src/types/interfaces/hostBridge.ts` | 改 | 在 `HostCommand` 契约中扩展 `{ type: 'open-conversation'; convId: string }` |
| 2 | `overlay/crates/agent-electron-client/src/shared/types/hostBridge.ts` | 改 | 通过 `sync-host-bridge-contract.mjs` 同步上述契约快照 |
| 3 | `nuwax/src/services/hostBridgeEvents.ts` | 改 | `HostBridgeEventHandlers` 增加 `openConversation?: (convId: string) => void`，并在 `handleHostCommand` 中处理 `open-conversation` 命令 |
| 4 | `nuwax/src/layouts/DynamicMenusLayout/SidebarNavLayout/index.tsx` | 改 | 注入 `openConversation: (convId) => jumpTo('/instant-message?convId=' + encodeURIComponent(convId))` |
| 5 | `nuwax/src/layouts/DynamicMenusLayout/ClassicLayout/index.tsx` | 改 | 经典布局同等注入 `openConversation` |
| 6 | `nuwax/src/services/hostBridgeEvents.test.ts` | 改 | 增加 `open-conversation` 宿主命令分发的单测覆盖 |
| 7 | `overlay/crates/agent-electron-client/src/main/services/imNativePresentation.ts` | 改 | `IMNativePresentationOptions` 增加 `onNotificationClick`，并在通知点击回调恢复窗口后触发该回调携带 `sessionGeneration` 和 `convId` |
| 8 | `overlay/crates/agent-electron-client/src/main/services/imReceiverRuntime.ts` | 改 | 将 `onNotificationClick` 接入 `sendHostCommandToMainWindowGuests({ type: 'open-conversation', convId })` |
| 9 | `overlay/crates/agent-electron-client/src/main/services/imNativePresentation.test.ts` | 改 | 补充通知点击时触发 `onNotificationClick` 且受代次/清理门控的单元测试 |
| 10 | `overlay/crates/agent-electron-client/src/main/services/imReceiverRuntime.test.ts` | 改 | 补充通知点击转发 `sendHostCommandToMainWindowGuests` 的单元测试 |

## 实施顺序

1. 更新 `nuwax/src/types/interfaces/hostBridge.ts` 契约，并运行 `node scripts/sync-host-bridge-contract.mjs` 同步。
2. 更新 `nuwax/src/services/hostBridgeEvents.ts` 及其单测，并在 `SidebarNavLayout` 和 `ClassicLayout` 中接入 `openConversation`。
3. 运行 `cd nuwax && npx vitest run src/services/hostBridgeEvents.test.ts` 验证前端测试。
4. 更新 `overlay` 中的 `imNativePresentation.ts` 和 `imReceiverRuntime.ts`，支持点击回调派发。
5. 更新 `overlay` 中的测试 `imNativePresentation.test.ts` 和 `imReceiverRuntime.test.ts`。
6. 运行 `node scripts/sync-overlay.js` 同步到基座。
7. 运行 `node scripts/in-base.js --no-env -- npm run test:electron -- src/main/services/imNativePresentation.test.ts src/main/services/imReceiverRuntime.test.ts` 验证桌面端测试。

## 证明成立的测试

- 前端单测：`cd nuwax && npx vitest run src/services/hostBridgeEvents.test.ts` 全部通过，覆盖非法参数/未注入/正常分发。
- 桌面壳单测：`imNativePresentation.test.ts` 与 `imReceiverRuntime.test.ts` 全部通过，覆盖还原窗口、聚焦以及跨代次校验。
- 契约检查：`node scripts/sync-host-bridge-contract.mjs --check` 必须通过。
- 基座测试门禁：`npm run check:pin` 和相关测试通过。

## 风险与回退

| 风险 | 缓解 | 回退方式 |
|---|---|---|
| 通知点击发生在换账号或登出之后 | `imNativePresentation` 校验 `sessionCurrent(generation)` 与 `currentEpoch === epoch`，`imReceiverRuntime` 校验 `receiver.isGenerationCurrent`，迟到点击直接忽略 | 恢复旧代码，点击仅还原窗口 |
| 用户已停留在 `/instant-message` 且同一会话 | `jumpTo`（`history.push`）触发新 key，`MicroAppEntry` 和 `microAppHostStore` 自增 `navigationRevision`，`nuwax-im-web` 监听到 revision 变化执行 `openHostDirectConversation` | 不影响既有状态 |
