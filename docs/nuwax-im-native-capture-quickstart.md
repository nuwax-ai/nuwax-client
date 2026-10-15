# Nuwax 客户端原生截图 / 录屏 · IM 接入速览（一页版）

面向 nuwax-im 开发同学及其 Agent。更新：2026-10-15。接口版本 v1。本页是摘要，细节以完整文档为准：

- 接入交接（主文档）：https://github.com/nuwax-ai/nuwax-client/blob/release/v3.0.x/docs/nuwax-im-native-capture-integration.md
- API 参考：https://github.com/nuwax-ai/nuwax-client/blob/release/v3.0.x/docs/native-capture-api.md
- 能力探测与复制：https://github.com/nuwax-ai/nuwax-client/blob/release/v3.0.x/docs/host-capabilities-api.md

## 一句话

IM 菜单点「截图 / MP4 / GIF」→ 调客户端桥 `window.NuwaClawBridge.capture` → Promise 返回结果句柄 → 分块读成 `File` → 放进**发起会话**的待发送附件区 → 用户点发送走你们原有上传流程。客户端不认识会话 ID，不自动上传、不自动发送。

## 前置条件

- 只有**客户端内受信的顶层业务页**能用。联调须从测试业务域 `https://testagent.xspaceagi.com` 进入主站 IM；独立 localhost 页面即使在 Electron 里也不受信。
- 普通浏览器 / 旧客户端没有这个桥：截图可保留原 `getDisplayMedia` 降级，录屏入口隐藏。
- 基础采集已随 v3.0.14-beta.6 发布；`canUse`、`copy` 和预览复制按钮**尚未公开发布**，旧客户端可能缺失，需要兼容。

## 接口（调用时再取，不要在模块加载时缓存）

```ts
const capture = window.NuwaClawBridge?.capture;
capture.getCapabilities()            // 以返回的 formats / available 为准，不要硬编码
capture.screenshot({ format?, compression? })            // 等用户确认
capture.record({ output: 'mp4' | 'gif', fps?, compression?, maxDurationMs? }) // 等停止 + 编码完成才返回
capture.readChunk(resultId, offset, length)  // 每次 ≤ 4 MiB
capture.release(resultId)                    // 用完必须释放
capture.cancel()
capture.onStateChange(cb)                    // 仅用于显示状态，idle ≠ 文件已读完
capture.copy?.(resultId)                     // 可选，新客户端才有
```

能力名（`NuwaClawBridge.canUse(name)`，新客户端必须尊重 false）：`capture.screenshot`、`capture.record.mp4`、`capture.record.gif`、`capture.copy.image`、`capture.copy.file`。普通菜单只展示 MP4 / GIF，WebM 仅兼容。

## 最小流程

```ts
const CHUNK = 4 * 1024 * 1024;
const target = { conversationId, draftEpoch };   // 第一个 await 前固定目标会话 + IM 自己的登录/草稿代次

const result = await capture.screenshot({ compression: { quality: 'high', maxBytes: maxUploadBytes } });
if (!result.success) { if (result.code !== 'canceled') toastByCode(result.code); return; }

try {
  if (result.bytes > maxUploadBytes || result.exceedsMaxBytes) throw new Error('超过发送限制');
  const parts: ArrayBuffer[] = [];
  for (let off = 0; off < result.bytes; off += CHUNK) {
    const len = Math.min(CHUNK, result.bytes - off);
    const part = await capture.readChunk(result.resultId, off, len);
    if (!part || part.byteLength !== len) throw new Error('结果已失效');
    parts.push(part);
  }
  const file = new File(parts, `截图-${Date.now()}.png`, { type: result.mime }); // 扩展名按真实 MIME
  // 复核 target 仍有效、有发送权限后，追加到 target 会话草稿；不自动发送
} finally {
  await capture.release(result.resultId).catch(() => undefined);
}
```

## 要点

1. **不绕过原规则**：复用 `addPending`、`canUpload`、`composerLocked` 的大小 / 数量 / 禁言校验，不增加消息类型、后端接口或第二条上传链。
2. **会话归属**：A 会话发起后切到 B，结果回填 A 的草稿并提示，不切走用户正在看的 B；做不到就丢弃并提示，**不能回填到 B**。能力查询后、采集返回后、读块后各复核一次目标。
3. **pending 要覆盖全程**（调用 + 读块 + 回填），不能在 `state=idle` 时清除；宽窄两套菜单共用同一把锁。全客户端同时只有一个采集会话，要处理 `busy`。
4. **无效 / 放弃的结果也必须 `release`**；`resultId` 是临时句柄，不是 URL / 路径 / 服务端文件 ID，导航、登出、换域、锁屏等都会使其失效。
5. **体积**：`maxBytes`（1–2147483648）只是逐档降质量的目标，最低档仍超限会返回 `exceedsMaxBytes: true`，要拒绝入队并提示缩短录制或降画质。不缩放像素。PNG 无损，控体积请选 `jpeg`。
6. 不要在聊天组件卸载时无条件调 `cancel()`（会取消其他入口的采集）；IM 真正卸载才终止回填。卸载 / 移除附件时释放自己的 Blob URL 和 `onStateChange` 订阅。
7. 不要用 `window.top`、postMessage 或自建 IPC 绕过受信边界；不要把 `NuwaxHost`（导航桥）写成 `NuwaxHost.capture`。

## 失败码处理

| code | IM 行为 |
| --- | --- |
| `canceled` | 静默结束，不提示、不生成附件 |
| `permission-denied` | 提示在系统设置里允许屏幕采集后重试 |
| `busy` | 提示先完成当前采集 |
| `encoder-unavailable` / `unsupported` | 隐藏或禁用该格式；实际失败时提示，**不要再自动弹浏览器采集** |
| `untrusted` | 提示刷新页面；仍失败则反馈主站 / 客户端检查受信来源 |
| `invalid-argument` / `failed` | 统一提示「截图/录屏失败，请重试」，记录诊断，不展示底层错误原文 |

## 验收清单

- 普通浏览器、旧客户端不报错，截图降级可用；新客户端按 MP4 / GIF 能力显示入口。
- 菜单只发起一次；取消不产生附件；停止并编码完成后才回填。
- 截图 / MP4 / 动画 GIF 进入原会话草稿，发送后对端内容正确；录制中切会话不误回填。
- 卸载、登出、换域、权限变化、超限、句柄失效时不继续发送，监听和 Blob URL 不累积。
- macOS / Windows / Linux 分别在安装包 + 实际 IM 上验收，不互相代替。

已知限制：无音频；不支持跨屏选区；HDR 暂无真实色调映射；Linux 录制中用托盘或 `Ctrl+Alt+R` 停止、`Ctrl+Alt+P` 暂停 / 继续。

## 交付记录请包含

客户端版本、IM 提交 / 部署版本、接入形态、OS / 屏幕布局与缩放率、格式 / 画质 / 尺寸 / 时长、失败 code 与复现步骤、对端接收表现。不附账号或凭据。
