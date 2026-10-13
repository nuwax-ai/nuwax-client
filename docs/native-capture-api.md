# 原生截屏 / 录屏 API（供 IM 等业务页接入）

适用：Nuwax 商业桌面客户端内的受信业务页（IM 以微应用形态运行在其中）。普通浏览器没有这套能力，需自行降级。
契约版本：`apiVersion = 1`（只增不改）。当前 IPC 类型定义见 `overlay/crates/agent-electron-client/src/shared/features/capture/contract.ts`；公共类型事实源在前端仓 `src/types/interfaces/hostBridge.ts` 的 `capture` 命名空间。

IM 项目负责人请先看[接入交接指南](nuwax-im-native-capture-integration.md)，其中包含当前 IM 接线位置、独立项目边界、分块读取示例与多屏联调清单。

## 当前可用范围（随阶段更新）

| 能力 | 状态 |
| --- | --- |
| `screenshot()` | 原生覆盖层：整屏 / 窗口 / 单屏区域选择，矩形、椭圆、箭头、画笔、文字、马赛克，撤销重做、确认 / 取消；物理像素裁剪 |
| `record()` | 原生来源选择、3 秒倒计时、暂停 / 继续、停止 / 取消；macOS/Windows 提供控制条与区域边框，Linux 使用托盘/应用内快捷键；MP4 / WebM / GIF 按本机独立编码器实际探针提供 |
| 平台 | macOS、Windows、Linux；Linux X11 使用桌面覆盖层，Wayland 使用系统来源选择和来源内预览；正式安装包与桌面环境的验收范围分别记录 |
| 静态图格式 | `png`、`jpeg`（以 `getCapabilities().formats.still` 为准；`webp` 待后续） |

> 以 `getCapabilities()` 返回的实际能力为准，不要硬编码上表。

## 取得桥对象（调用时再取，不要在模块加载时缓存）

```ts
const capture = window.NuwaClawBridge?.capture;
```

桥对象的存在性在运行期会变（宿主后注入、特性被关闭），所以每次使用前取一次。若 `capture` 为 `undefined`（普通浏览器、旧客户端）或 `getCapabilities().available === false`，请走你自己的降级路径。

## 接口

```ts
interface CaptureBridge {
  getCapabilities(): Promise<CaptureCapabilities>;
  screenshot(options?: { format?: 'png' | 'jpeg' | 'webp'; compression?: CaptureCompression }): Promise<CaptureResult>;
  record(options: { output: 'mp4' | 'webm' | 'gif'; fps?: number; compression?: CaptureCompression; maxDurationMs?: number }): Promise<CaptureResult>;
  cancel(): Promise<void>;
  onStateChange(listener: (state: 'idle' | 'selecting' | 'recording' | 'paused' | 'encoding') => void): () => void;
  readChunk(resultId: string, offset: number, length: number): Promise<ArrayBuffer | null>;
  release(resultId: string): Promise<void>;
}
```

- **同一时刻只有一个会话**。进行中再发起返回 `busy`。
- **支持独立使用与 IM 回填**：IM 菜单直接调用本桥；`screenshot()` 等待确认，`record()` 等待停止和编码完成，成功结果从原 Promise 返回。读取成 File 后由 IM 放入发起会话的待发送附件区，无需先保存本地文件。客户端相机/原生菜单的预览保存由壳自己的入口处理。
- **结果以 Promise 为准**：状态 `idle` 不等于附件已准备好，不要通过状态事件拼接“录制完成回调”；IM 的 pending 应覆盖读块与回填全过程。会话 ID 留在调用方上下文，不作为本桥的新参数。
- 渲染进程**拿不到文件路径**，只拿不透明的 `resultId`；用 `readChunk` 分块取回字节（单次最多 4 MiB），用完务必 `release`。
- 登出、换域、客户端退出都会取消进行中的会话并清空全部结果。
- 页面导航 / 关闭、锁屏 / 挂起、显示器移除也会取消并清理；结果仅可由原发起页面读取和释放。
- 参数是**严格校验**的：未知字段、类型或范围不对返回 `invalid-argument`，不会被静默纠正。
- `compression` 可以省略，但传了就必须包含 `quality`；仅传 `{ maxBytes }` 不合法。`fps` 为整数 1–60（缺省 30），`maxDurationMs` 为整数 1000–3600000（接口缺省 600000 毫秒），`maxBytes` 为安全整数 1–2147483648。

## 压缩档与 `maxBytes`

压缩**只降质量，不改像素尺寸**。四档：`lossless`、`high`、`medium`、`low`；每档的实际含义以 `getCapabilities().tiers` 为准。

- `compression.quality`：起始档位；完全省略 `compression` 时默认 `high`，传入 `compression` 时 `quality` 必填。
- `compression.maxBytes`：给了则从起始档逐级下探直到不超过上限；**永远不会缩放**。若最低档仍超限，结果里 `exceedsMaxBytes: true`，由你决定放弃还是照发。
- `qualityUsed` 如实告诉你最终用了哪一档。注意 `png` 是无损格式：所有档位输出同一份 PNG，`qualityUsed` 为 `lossless`，`maxBytes` 无法靠换档达标——要控制体积请选 `jpeg`。
- 未指定 `format`：`lossless` 档默认 PNG，其余档默认 JPEG。
- 画质档位不会缩放像素，`width` / `height` 表示最终输出的物理像素尺寸；MP4 奇数边界可能多取 1 像素真实内容或补齐偶数尺寸，见下方已知限制。
- `lossless` 档仅对 PNG 承诺严格无损；对 JPEG、视频与 GIF 表示该格式的最高质量档。

## HDR

输出的目标是 SDR / sRGB。`CaptureResult.hdrToneMapped` 表示这次采集是否来自 HDR 屏并已做过转换。当前阶段尚未做色调映射，该值恒为 `false`；`getCapabilities().displays[].hdr` 可知各显示器是否为 HDR。

## 错误码

`canceled` 是**正常结果**（用户点了取消 / 按了 Esc），不要弹错误。**其余失败都必须让用户看到提示**——这是本次排查原问题时发现的教训：不要把失败当作「用户取消」静默吞掉。

| code | 含义 | 建议提示 |
| --- | --- | --- |
| `canceled` | 用户取消 | 不提示 |
| `permission-denied` | macOS 未授予「屏幕录制」权限 | 「请在 系统设置 > 隐私与安全性 > 屏幕录制 中允许本应用，然后重试」 |
| `busy` | 已有进行中的截屏/录屏 | 「正在截屏/录屏，请先完成当前操作」 |
| `encoder-unavailable` | 所选输出格式的编码器不可用 | 提示改选其他格式 |
| `unsupported` | 平台 / 格式 / 功能不支持，或特性被关闭 | 探测缺能力时隐藏入口或按约定降级；原生调用失败后不静默再次唤起浏览器采集 |
| `untrusted` | 调用方不是受信的当前业务页 | 一般是页面已过期，刷新后重试 |
| `invalid-argument` | 参数不合法（`error` 里有原因） | 属于调用方 bug，记日志 |
| `failed` | 其他失败（`error` 里有原因） | 「截图/录屏失败，请重试」；记录必要诊断，不直接展示全部底层错误 |

## 示例：替换 `captureScreen`

```ts
const CHUNK = 4 * 1024 * 1024;

async function captureScreenToFile(maxUploadBytes: number): Promise<File | null> {
  const capture = window.NuwaClawBridge?.capture;
  if (!capture) return captureViaBrowser();               // 普通浏览器：你原来的 getDisplayMedia 流程

  const caps = await capture.getCapabilities();
  if (!caps.available) return captureViaBrowser();

  const result = await capture.screenshot({ compression: { quality: 'high', maxBytes: maxUploadBytes } });
  if (!result.success) {
    if (result.code === 'canceled') return null;           // 用户取消：安静返回
    showCaptureError(result);                              // 其余都要提示，并记日志
    return null;
  }

  try {
    if (result.bytes > maxUploadBytes || result.exceedsMaxBytes) {
      throw new Error('截图超过发送限制，请降低画质或选择更小区域');
    }
    const parts: ArrayBuffer[] = [];
    for (let offset = 0; offset < result.bytes; offset += CHUNK) {
      const part = await capture.readChunk(result.resultId, offset, Math.min(CHUNK, result.bytes - offset));
      if (!part || part.byteLength !== Math.min(CHUNK, result.bytes - offset)) throw new Error('capture result expired');
      parts.push(part);
    }
    const ext = result.mime === 'image/png' ? 'png' : 'jpg';
    return new File(parts, `截图-${Date.now()}.${ext}`, { type: result.mime });
  } finally {
    await capture.release(result.resultId).catch(() => undefined);
  }
}
```

`maxUploadBytes` 应来自调用方实际上传限制。IM 可直接复用[完整读取示例](examples/im-native-capture.ts)中的 `readCaptureFile`，它还校验长度、MIME 并统一处理释放。

同一示例的 `createCaptureAttachmentController` 提供从 IM 菜单触发到指定会话草稿回填的完整适配器；支持截图、MP4/WebM/GIF、busy、取消、超限、目标失效和 IM 卸载。业务接线与原会话草稿策略见[接入交接指南](nuwax-im-native-capture-integration.md#两种入口与完成结果的归属)。

`onStateChange` 可用来在「选区中 / 录制中 / 编码中」时禁用入口按钮：

订阅没有初始快照，仅发起业务 document 收到本次状态，并非全局广播；请在发起前订阅，自己维护 pending。业务桥不提供 pause/resume/stop/save，录制控制使用原生控制条与托盘，IM 读取 File 后复用自己的附件链。

```ts
const off = capture.onStateChange((state) => setBusy(state !== 'idle'));
// 组件卸载时 off()
```

## 假桥（IM 在客户端能力就绪前并行开发 / 写单测）

```ts
export function createFakeCaptureBridge(overrides: Partial<CaptureBridge> = {}): CaptureBridge {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
  return {
    getCapabilities: async () => ({
      apiVersion: 1, available: true, platform: 'darwin', permission: 'granted',
      displays: [{ id: '1', hdr: false, scale: 2 }],
      formats: { still: ['png', 'jpeg'], video: [], gif: false },
      tiers: {} as never,
    }),
    screenshot: async () => ({
      success: true, resultId: 'fake0001', mime: 'image/png', bytes: 4,
      width: 800, height: 600, qualityUsed: 'lossless', hdrToneMapped: false,
    }),
    record: async () => ({ success: false, code: 'unsupported' }),
    cancel: async () => undefined,
    onStateChange: () => () => undefined,
    readChunk: async (_id, offset, length) => png.slice(offset, offset + length),
    release: async () => undefined,
    ...overrides,
  };
}
```

建议至少覆盖：成功、`canceled`、`permission-denied`、`busy`、桥缺失、`available:false` 这几条路径。

## 已知限制

- 无音频；不支持跨屏选区；X11/macOS/Windows 窗口选择为缩略图列表（不做悬停高亮）。Wayland 由系统选择屏幕或窗口，再在授权来源内选择区域/标注。
- HDR 尚未做真实色调映射，`hdrToneMapped` 仍为 `false`；不能把 BT.709 标签当作 HDR 转换验收通过。
- macOS 单屏整屏录制时，控制条能否完全排除需实机验证；区域录制将边框置于选区之外，控制条贴近选区并留在所选显示器；整屏或没有外部空间时停靠该屏工作区底部。
- Windows 已有实际安装包 ASAR 验证，见 `acceptance/20261013-windows-installed-capture.md`。Linux 实施与验证见 `acceptance/20261013-linux-native-capture.md`；未经验证的桌面环境不能据此宣称验收通过。
- Linux 不支持 Electron 的内容保护排除：录制前隐藏控制窗且不创建桌面红框。通过托盘暂停/继续/停止；无托盘图标时切回客户端使用下面的应用内快捷键。
- Linux Wayland 复用同一次授权的 PipeWire 来源完成预览与录制，不再次选择来源，以来源实际帧构造连续轨道，使静止画面也有可播放的视频；像素尺寸不缩放。X11 保留原始录制输入并等待隐藏后的新帧。`permission:'n/a'` 不代表系统已授予采集；实际请求仍可能返回权限或设备错误。显式禁用 `WebRTCPipeWireCapturer` 时不回退到 Xwayland 抓取，能力为 unavailable。
- Wayland 系统选择器的取消与拒绝原因由 Chromium 映射：应用取消及 `AbortError` 为 `canceled`，`NotAllowedError/SecurityError` 为 `permission-denied`，其他设备失败为 `failed`，不猜测设备失败等于取消。
- 将设置项 `features.capture.enabled` 置为 `false` 并重启客户端后，`getCapabilities().available` 为 `false`，其余调用返回 `unsupported`。
- MP4 为满足 H.264 的偶数尺寸可能多取 1 像素真实内容；仅无法扩展、由编码器补像素时 `paddedForEvenSize` 才为 `true`。
- Linux MP4 偶数对齐后的选区至少 16×16；更小区域在启动前拒绝。Linux 录制期间阻止自动息屏，完成/取消后释放，不修改用户系统设置。

## 客户端直接验收入口

客户端设置的「截图与录屏」页签和应用菜单提供截图、MP4 / GIF 入口及画质选择。截图确认或录屏停止后显示预览与尺寸、体积、时长，点击「保存」打开系统保存对话框。API 继续兼容 WebM。录制期间托盘提供暂停/继续和停止。

macOS 使用系统菜单，Windows/Linux 使用客户端自绘应用菜单。应用内截图快捷键为 macOS `⌘⌥S` / Windows、Linux `Ctrl+Alt+S`；MP4 录屏为 `⌘⌥R` / `Ctrl+Alt+R`。Linux 录制中 `Ctrl+Alt+R` 停止并生成结果，`Ctrl+Alt+P` 暂停/继续。快捷键需要客户端主窗口或业务页获得焦点，不是后台全局快捷键。

该壳入口使用独立的 host IPC 与同一捕获服务，不扩大业务页信任范围。IM 接入仍由 IM 团队负责，现有 IM 按钮不能作为本次原生实现的验收入口。

本地编码资源准备：`npm run prepare:capture`。资源锁、LGPL / GPL 构建检查、SHA256 与真实编码探针同时生效，缺失编码器时不展示对应可用格式。完整安装包的第三方声明门禁与本模块资源校验分别记录，模块检查通过不代表整个安装包已通过。
