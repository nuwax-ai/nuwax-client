# nuwax-im 原生截图与录屏接入交接

面向：nuwax-im 项目负责人、IM Web 开发与联调同事。更新日期：2026-10-12。接口版本：1。

目标：让 IM 的截图入口优先使用 Nuwax 客户端的原生选区、标注和录屏能力，把结果转为 `File` 后放入现有待发送附件区。用户确认发送后，继续走 IM 原有上传与消息链。

## 当前交付与职责

客户端已有截图、标注、MP4 / WebM / GIF 录屏，以及客户端设置页签和原生菜单入口。macOS 开发验证已完成；这份文档交付接口与接入方法，IM 业务代码尚未改造或部署，不能把客户端本地保存通过视为 IM 发消息验收通过。

| 负责人 | 本次工作 |
| --- | --- |
| Nuwax 客户端 | 多屏选择、物理像素采集、标注、原生录制控制、编码、权限/信任校验、结果读写与会话清理 |
| nuwax 主站 | 将 IM 加载到客户端的受信业务 document，维持主站登录与宿主桥初始化 |
| nuwax-im | 可选能力探测、按钮接线、错误提示、结果转 File、待发送附件预览、上传限制、组件生命周期与发送验收 |

IM 保持独立项目：不引入 Electron、qiankun、nuwax 前端路径别名或客户端 SDK。IM 后端、WebSocket 消息协议与登录注册链无需为此新增接口。

完整 API 说明：[native-capture-api.md](native-capture-api.md)。可复制的独立 TypeScript 读取示例：[examples/im-native-capture.ts](examples/im-native-capture.ts)。示例采用最小结构类型，完整契约事实源仍是 nuwax 前端的 `src/types/interfaces/hostBridge.ts`。

## 两种入口与完成结果的归属

| 发起入口 | 完成后的行为 |
| --- | --- |
| 客户端设置页签 / 客户端原生菜单 | 壳自己的结果预览，可选择保存到本地 |
| IM 会话框菜单 | IM 调用 `window.NuwaClawBridge.capture.screenshot/record`，完成后结果回到该次 Promise，读取为 File 并进入发起会话的待发送附件区 |

**IM 菜单 → 选择屏幕/区域 → 开始录制 → 停止并完成编码 → Promise 返回 → File → 发起会话的附件草稿 → 用户确认发送**。业务调用不要求先保存本地文件，也不会弹壳的独立预览/保存框。暂停、继续、停止用客户端原生 UI，IM 无需重复实现录制工具条。

`record()` 的 Promise 代表完整录制流程；不是开始录制后立即返回。结果由这次调用返回，不通过全局“完成事件”分发。`onStateChange('idle')` 只用于状态显示，**不能当作附件完成通知**；此时结果读取/回填可能尚未完成，菜单 busy 必须持续到回填结束。

IM 会话 ID 和草稿代次由 IM 保存在调用上下文，不传入 `record()`（未知参数会被拒绝）。返回的 resultId 已绑定发起页面；客户端不认识 IM 会话 ID，也不会替 IM 上传、发消息或寻找当前聊天窗口。

独立示例现在提供 `createCaptureAttachmentController`，把能力探测、完整流程等待、分块读取、释放、重复点击门禁、迟到结果与会话回填串起来。建议 IM 应用层只保留一份控制器，宽窄两套菜单共用。下面的会话/草稿函数为 **IM 需要接入的业务适配点**，不是新增的客户端 API：

```ts
import { createCaptureAttachmentController } from './lib/nativeCapture';

const captureAttachments = createCaptureAttachmentController({
  // 返回值必须是不可变快照；只保存 ID 不保存会变化的 ref 对象。
  getTarget: () => snapshotCaptureDraft(), // { conversationId, draftRevision } | null
  isTargetValid: target => canAppendToDraft(target),
  getMaxUploadBytes: () => UPLOAD_MAX_MB * 1024 * 1024,
  addPending: (target, files) => appendToDraft(target, files),
  onBusyChange: busy => setCapturePending(busy),
  onStateChange: state => setCaptureState(state),
});

async function onRecordMenuClick(output: 'mp4' | 'webm' | 'gif') {
  const outcome = await captureAttachments.run({
    kind: 'record',
    options: {
      output,
      maxDurationMs: recordingLimitMs,
      compression: { quality: 'high', maxBytes: UPLOAD_MAX_MB * 1024 * 1024 },
    },
  });
  if (outcome.status === 'failed') showCaptureErrorByCode(outcome.code);
  if (outcome.status === 'unavailable') showCaptureUnavailable();
  if (outcome.status === 'invalid-target') showCaptureDraftExpired();
  // attached：附件已回填；canceled：静默结束；均不要再次调用 addPending。
}

// 截图菜单共用控制器：
// await captureAttachments.run({ kind: 'screenshot', options: { format: 'png' } });
// IM 应用卸载：captureAttachments.dispose();
```

`appendToDraft(target, files)` 必须同步写到指定草稿，不能内部重新读取当前 conversationId。若 IM 有按会话维护的草稿，录制中从 A 切到 B 后仍回填 A 的草稿，并提示用户；不要擅自切换正在阅读的 B。若现有 `addPending` 仅面向当前 ChatWindow，`canAppendToDraft` 必须额外核对当前会话、组件代次和权限，切换后返回 invalid-target 并提示重新录制，不能错放到 B。业务接线完成前不宣称当前 IM 已有跨会话草稿存储。

`dispose()` 停止后续回填并退订状态，迟到的成功结果仍释放；它不会对共享业务 document 无条件调用 cancel。控制器返回 File 前后均检查目标有效性。File 入队后 Blob URL、附件移除、上传和发送仍由 IM 管理。

## 正确的宿主入口

每次点击时重新读取：

```ts
const capture = window.NuwaClawBridge?.capture;
```

普通浏览器、旧客户端或关闭特性的客户端可能没有该桥，或返回 `available:false`。IM 必须可独立运行，不能在模块顶层缓存桥，也不能因为桥不存在就导致 IM 页面报错。

当前主站以 qiankun 的同 document 沙箱加载 IM，宿主注入的可选全局桥可读取。`props.host` / `window.NuwaxHost` 当前是导航桥，只有 `navigate`，不能写成 `NuwaxHost.capture`。

此接口只授权客户端内当前受信的顶层业务 document。独立 localhost IM、普通浏览器、iframe 子 document 和过期页面不因“在 Electron 内”就获得权限。不要用 `window.top`、跨源访问、postMessage 代理或自建 IPC 绕过边界。若接入形态仍是旧 iframe，先与主站确认切换到当前微应用集成方式。

联调应在 Nuwax 开发客户端中打开配置的测试业务域 `https://testagent.xspaceagi.com`，再从主站进入 IM；由主站完成既有登录和桥初始化。`untrusted` 应反馈主站/客户端检查当前页面代次与受信来源，IM 不自行注册设备、改服务域名或重建认证链。

## IM 需要改的接线位置

以下位置根据 2026-10-12 的 IM 工作树核对，负责人实施时以当时源码为准：

| 位置（nuwax-im 仓库内） | 改造方式 |
| --- | --- |
| `nuwax-im-web/src/components/ChatWindow.tsx` 的 `captureScreen` | 原函数目前直接调用 `getDisplayMedia`；前面加原生能力探测，原生成功后用读取示例生成 File 并 `addPending([file])` |
| 同文件的 `addPending`、`canUpload` 与会话状态 | 保留上传权限/发送锁门禁；在采集前记住目标会话和组件代次，完成后复核，避免把迟到结果放进另一会话 |
| `nuwax-im-web/src/components/ComposerToolbar.tsx` 的截图下拉及窄窗 `MORE_ROWS.shot` 平铺入口 | 保留截图和剪贴板入口；两套渲染均按真实 capabilities 增加 MP4 / WebM / GIF 操作、同步 busy 门禁，避免窄窗缺入口 |
| `nuwax-im-web/src/lib/attachment.ts` 与现有上传/预览链 | 按 File 的实际 MIME 识别图片、视频或文件；继续复用原消息形态和附件上传，不把 resultId 当服务端文件 ID |

原 `captureScreen` 中 `getDisplayMedia` 的第一段 `catch { return; }` 会把所有采集失败都当取消。保留浏览器降级时也应区分取消与真正失败，不能继续静默吞掉系统/配置错误。

客户端原生菜单启动的是客户端自己的本地预览和保存流程，不会自动把文件放进 IM。IM 发附件必须由 IM 自己调用业务桥取得结果；不要监听客户端菜单的结果并自动发送到当前聊天。

## 能力探测与调用顺序

1. 先做 IM 既有 `canUpload`、会话可发送和 busy 检查。
2. 点击时取桥，检查方法存在性，再调用 `getCapabilities()`。
3. `available:true` 只表示特性可用，不代表屏幕录制已授权，也不代表所有格式均可用；分别看 `permission`、`formats.still`、`formats.video`、`formats.gif`。
4. 调用前订阅状态并设置本地 pending；进行中不能重复发起。
5. `screenshot()` 等待用户选区、标注、确认；`record()` 等待用户选择、倒计时、录制、停止与编码完成。
6. 失败按 code 处理；成功后检查目标会话、组件代次和文件大小，分块读取为 File，并释放客户端临时原件。
7. 再次复核发起会话的草稿仍有效，放入该草稿的待发送附件区；用户点击发送后才上传/发送消息。只有当前组件附件列表的实现必须额外确认会话未切换。
8. `finally` 退订状态并清本地 pending。若创建 Blob URL，在移除附件或组件卸载时 revoke。

缺桥或 `available:false` 时，截图可保留现有浏览器 `getDisplayMedia` 降级；当前 IM 若没有浏览器录屏实现，应隐藏或禁用原生录屏项，不承诺凭空可用的录制降级。原生调用已经返回取消、权限拒绝、busy 或失败时，不要偷偷再打开浏览器采集弹窗。

## 调用参数与结果

接口签名见完整 API 文档；常用调用：

```ts
await capture.screenshot({
  format: 'jpeg',
  compression: { quality: 'high', maxBytes: imageUploadLimitBytes },
});

await capture.record({
  output: 'mp4', // 或 capabilities 已声明支持的 webm / gif
  fps: 30,
  maxDurationMs: recordingLimitMs,
  compression: { quality: 'high', maxBytes: videoUploadLimitBytes },
});
```

上传和录制限制由 IM 产品及现有上传服务给定，上面变量不是客户端或后端固定限额。

当前 IM 的已有上传大小约束来自 `nuwax-im-web/src/api/upload.ts` 的 `UPLOAD_MAX_MB`，实施时复用该事实源并转换为字节，避免在截图/录屏适配器里另外写一套不一致上限。

| 参数 | 实际规则 |
| --- | --- |
| `compression` | 可以完全省略，此时默认 high；传入后 quality 必填，不能仅写 `{ maxBytes }` |
| `quality` | lossless / high / medium / low；只改质量，不缩小像素尺寸 |
| `maxBytes` | 安全整数 1–2147483648；从指定档下探，最低档仍超限则成功结果带 `exceedsMaxBytes:true`，不是硬限额保证 |
| 静态格式缺省 | lossless 默认 PNG，其他档默认 JPEG；当前只有 PNG/JPEG，WebP 为类型预留 |
| `record.output` | 必填 mp4 / webm / gif，并先按 capabilities 探测 |
| `fps` | 整数 1–60，缺省 30；GIF 还受所选画质档的帧率上限约束 |
| `maxDurationMs` | 整数 1000–3600000，接口缺省 600000（10 分钟）；客户端设置入口目前显式设置 5 分钟，IM 可设置自己的限制 |
| 未知字段 | 严格拒绝，返回 invalid-argument |

PNG 在所有档位仍严格无损，不能靠换档保证更小体积。JPEG、视频和 GIF 的 lossless 档表示最高质量档，不承诺数学无损。录制有效时长不含暂停；另有墙钟时限防止一直暂停占用设备，暂停也不能无限期保持。

成功结果含不透明 `resultId`、真实 `mime`、`bytes`、物理像素 `width/height`、`qualityUsed` 和 `hdrToneMapped`，录制另含 `durationMs`。还可能包含 `exceedsMaxBytes`、`paddedForEvenSize`。`resultId` 不是路径、URL 或服务器文件 ID。

业务桥没有 `save`、`pause`、`resume` 或 `stop` 方法。暂停、继续与停止通过原生控制条/托盘完成；`cancel()` 直接丢弃进行中的采集。`window.electronAPI.capture.save()` 仅属于壳自己的接口，IM 不应调用它。

## 分块读取与生命周期

可复制示例的 `readCaptureFile(capture, result, maxUploadBytes)` 会：

- 在读大文件前检查 IM 上传限额及 exceedsMaxBytes。
- 每次请求不超过 4 MiB，按实际 byteLength 推进，要求长度与请求一致。
- 根据真实 MIME 选择 PNG/JPG/WebP/MP4/WebM/GIF 扩展名。
- 无论成功、超限或读取失败，均在 finally 释放结果。

`readChunk` 超过 4 MiB 会被截断；null 表示失效、无权或读取失败，不能继续拼出空附件。文件组装会占用 renderer 内存，IM 必须先限制 bytes，不能承诺无限时长或无限大录像可发送。

```ts
import { readCaptureFile } from './lib/nativeCapture'; // 将独立示例复制到 IM 自己的 lib

// 下面展示接线顺序；isCurrentCaptureTarget、上传限制和提示函数由 IM 现有状态提供。
const result = await capture.screenshot({ compression: { quality: 'high' } });
if (!result.success) {
  if (result.code !== 'canceled') showNativeCaptureError(result.code);
  return;
}
if (!isCurrentCaptureTarget()) {
  await capture.release(result.resultId).catch(() => undefined);
  return;
}
const file = await readCaptureFile(capture, result, imageUploadLimitBytes);
if (isCurrentCaptureTarget()) addPending([file]);
```

`isCurrentCaptureTarget()` 至少检查组件仍挂载、目标会话未变、仍有发送权限、操作代次未过期；读取异常由外层 catch 显示稳定提示。截图/录屏结果进入待发送区，不自动发送。

`onStateChange` 没有初始快照，也不是全局广播；仅发起业务 document 收到本次会话的 selecting / recording / paused / encoding / idle。客户端设置页签发起的操作不会广播给 IM，所以本地 pending 和 busy 返回仍需处理。

整个客户端只能有一个采集会话。所有权以 WebContents 为单位，qiankun IM 与主站同页共享该身份。IM 应集中管理操作与 owner token，只有确认是自己发起、仍进行中的操作才允许取消；不要在每个聊天组件卸载时无条件 `cancel()`，否则可能取消同页其他入口。

整页导航/关闭、登出、换域、会话过期、锁屏/挂起、显示器移除或退出会取消并清理。SPA 路由和 qiankun 卸载不会被主进程当作整页导航：IM 需退订、释放已有句柄和预览 URL；迟到结果仅清理，不能附到新聊天里。

## 错误提示

| code | IM 处理 |
| --- | --- |
| canceled | 安静返回，清 pending，不生成附件 |
| permission-denied | 显示屏幕录制权限指引；macOS 在系统设置的隐私与安全性中授权后重试 |
| busy | 提示先完成当前截图/录屏；不再发起第二轮，不取消别人的操作 |
| encoder-unavailable | 提示当前格式不可用，刷新能力后选其他格式 |
| unsupported | 提示该能力/格式不可用；仅在预先探测缺能力时走约定的浏览器降级 |
| untrusted | 提示页面或登录会话已失效，刷新后重试；反馈主站/客户端检查信任初始化 |
| invalid-argument | 提示操作失败并记录接入参数问题，负责人修正调用 |
| failed | 显示截图/录屏失败，可重试；诊断只记录 code、阶段、格式、尺寸/体积等必要字段 |

不要将 resultId、媒体字节、屏幕内容、账号凭据或 token 写入诊断日志；界面提示以稳定 code 文案为主，不直接展示底层编码器的全部错误文本。

## 多屏联调与验收清单

来源选择由客户端完成，IM 无需指定 displayId、猜测主屏或自己转换 DPI。每个显示器有自己的冻结覆盖层，可以在任一屏选择整屏、窗口或单屏区域；Esc/取消结束整轮覆盖层。物理像素按实际采集帧及各屏缩放率计算。

当前不支持跨显示器拖一块大区域；外接屏可以单独选取。窗口来源以真正采集帧尺寸为准，不能用列表缩略图尺寸作为最终输出。MP4 为满足偶数宽高可能扩展真实边界 1 个像素，无法扩展时补像素；以结果 width/height/paddedForEvenSize 为准。

- [ ] 新客户端主站内进入 IM，桥探测可用；独立浏览器/旧客户端没有报错，截图降级可用。
- [ ] 单聊与群聊的截图、MP4、WebM、GIF分别进入待发送区，带说明发送后对端可预览/播放/下载，文件名、MIME 与消息形态正确。
- [ ] 原生选区有标注、撤销重做；取消不弹失败，也不生成空附件；真正失败有提示。
- [ ] 客户端设置/原生菜单发起一轮后 IM 再点击得到 busy；不会二次弹采集器或取消已有操作。
- [ ] 在主屏和副屏分别测试整屏、窗口、区域，包含屏幕在左/右/上/下、负坐标、横竖屏与不同缩放率；四档输出尺寸不因画质缩小。
- [ ] 区域录屏控制条/边框未进入结果，包括 MP4 奇数选区与边缘扩展；副屏开始后控制条应跟随该屏的选区，靠底部区域自动翻到上方；暂停/继续/停止保持位置，不跳回主屏。窗口模式控制条位于执行窗口选择的屏幕，暂不跟随目标窗口的跨屏移动。
- [ ] 按 Esc 或在任一显示器取消，所有覆盖层消失，再次发起可用。
- [ ] 录制中移除显示器、锁屏、登出或换域，操作取消/结果失效，IM 不继续上传旧媒体。
- [ ] 开始采集后切换聊天：有会话草稿仓库时回填原会话；仅支持当前组件时提示目标失效，绝不附到新会话。关闭 IM 或卸载微应用后不再回填，监听与 Blob URL 不累积。
- [ ] 权限拒绝、缺编码器、最低档仍超过 maxBytes、上传限制、大文件读块失效等路径按上表处理，finally release 得到覆盖。
- [ ] Windows、HDR 与正式安装包分别记录实机结果；不能用 macOS 开发记录或模拟双屏测试代替。

交付验收时请附：客户端版本/构建来源、IM 提交与部署版本、接入形态、OS/显示器布局与缩放率、格式/画质/输出尺寸/时长、失败 code 和步骤、对端收到附件后的表现。只记录测试媒体，不带账号或 token。

## 已知限制与联调基线

无音频、无跨屏选区、当前 WebP 不可用。HDR 尚未真实色调映射，hdrToneMapped 为 false；Windows 与真实安装包仍待实机验证。macOS 单屏整屏录制的控制条排除仍须解码画面验证，不能只凭 contentProtection 调用宣称通过。

客户端基线和验证记录：[20261012-native-capture-dev.md](acceptance/20261012-native-capture-dev.md)。IM 负责人需独立完成本节清单后，才可把 IM 的截图/录屏按钮标为已接入。
