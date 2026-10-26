# Nuwax 客户端能力目录与 canUse API

面向主站、IM 和其他业务页开发者。更新：2026-10-14。`canUse` 为本次新增的可选接口，尚未进入已发布的 `v3.0.14-beta.6`；旧版没有此方法时必须降级。截图/录屏的基础 v1 API 已在 beta.6 提供。

## 快速使用

```ts
// 每次使用前取桥；普通浏览器没有这个全局变量。
const bridge = window.NuwaClawBridge;
const available = await bridge?.canUse?.('capture.record.mp4').catch(() => false) ?? false;
if (available && bridge?.capture?.record) {
  // 仍需处理 permission-denied、busy、canceled 等实际调用结果。
  const result = await bridge.capture.record({ output: 'mp4' });
}
```

独立项目直接按本文协议调用即可，不需要安装 SDK 或拷贝示例/类型文件；无桥、无 canUse 或查询失败时在业务端视为 false。不要用 UA、`_shell=1`、URL 或 `host.getProduct()` 的存在性代替能力探测。

```ts
canUse(capability: string): Promise<boolean>
```

- 能力名区分大小写。未知名称、缺实际方法、未启用/未注册功能、非受信页面、过期文档、IPC 不可用均返回 false。
- 查询不打开采集/权限对话框，不启动录制、不写剪贴板、不触发登录或上传。capture 查询读取实际编码器能力。
- true 表示当前页面能调用对应能力；不保证已有屏幕录制授权、设备空闲、会话仍有效、存在结果句柄或目标应用支持粘贴。最终以操作返回值为准。
- `capture.record.mp4` / `.gif` / `.webm` 分别检查本机编码器；WebP 虽在类型中预留，当前探测为 false。
- 命名空间（如 `native`）表示至少有一个成员可用。按钮应查询确切能力名，不能用 `canUse('capture')` 推断支持所有格式。
- 不缓存跨登录、换域或页面导航的 true；点击前重新探测。主进程还会独立校验每次实际操作，探测不是授权凭据。

商业客户端只向当前允许的业务来源提供桥。普通浏览器没有桥；iframe 子 document、外部站点与旧文档不能通过 `window.top` 或自行代理 IPC 获取权限。同 document 的 qiankun IM 使用主站已初始化的桥；`props.host` / `NuwaxHost` 是独立导航协议。

主站启动时先走现有 `auth.getContext()` 绑定文档代次。只有 `canUse('auth.getContext')` 可在绑定前探测启动能力；其余能力在绑定完成后探测。IM 不需要重建认证或设备注册链。

## 能力清单

下表是公开白名单。每一行的命名空间本身也可探测；完整方法名为“命名空间.方法”。同步和只读能力仅供主站使用，不应给最终用户新增技术菜单。

| 命名空间 | 可探测方法 | 用途 |
| --- | --- | --- |
| `capture` | `getCapabilities`、`screenshot`、`record`、`cancel`、`onStateChange`、`readChunk`、`release`、`copy` | 原生截图/标注/录屏、状态、结果读取与复制 |
| `native` | `saveImage`、`saveFile`、`openWindow`、`openClientSettings` | 保存远端产物、打开窗口/客户端设置 |
| `localFiles` | `pickDirectory`、`getCapabilities`、`resolveContext`、`releaseContext`、`listFiles`、`searchFiles`、`stat`、`preparePreview`、`releasePreview`、`openPath`、`revealInFolder`、`updateFiles`、`saveFile`、`exportWorkspace`、`cancel` | 当前客户端本地工作区访问、预览、编辑/新增/回收站删除与保存/ZIP 导出；写能力须探测 v2/writable，复用上下文授权 |
| `im` | `setNotificationEnabled`、`getUnreadSnapshot`、`onUnreadChanged` | 宿主通知偏好与未读快照；不含消息发送或上传 |
| `updater` | `getState`、`check`、`download`、`install` | 更新状态与操作；不表示此刻有更新可安装 |
| `auth` | `getContext`、`syncSession`、`beginLogin`、`clear`、`configureServerHost` | 主站现有 cookie 会话生命周期，不读取凭据 |
| `host` | `getProduct` | 宿主产品标识，仅供元信息 |
| `events` | `onHostCommand` | 主站监听客户端命令 |
| `theme` | `syncTheme` | 主站同步主题 |
| `layout` | `setNewTaskAvailable`、`setSecondMenuAvailable`、`setSecondMenuCollapsed`、`setTitlebarDragRegions` | 主站同步壳布局与拖动区域 |
| `titlebar` | `beginDrag`、`endDrag`、`toggleMaximize` | 主站的窗口交互 |
| `i18n` | `syncLang` | 主站同步语言 |
| `meta` | `syncWebInfo` | 主站同步前端版本 |
| `perf` | `enabled`、`mark`、`markOnce` | 启用性能诊断时的打点；关闭时返回 false |

格式与复制种类提供更精确的能力名：

| 能力名 | 检查 |
| --- | --- |
| `capture.screenshot.png` / `.jpeg` / `.webp` | still 格式列表 |
| `capture.record.mp4` / `.webm` / `.gif` | video 格式列表或 gif 标志 |
| `capture.copy.image` | copy 方法与采集可用性；截图写入图片剪贴板 |
| `capture.copy.file` | copy 方法与平台文件剪贴板；MP4/GIF/WebM 写入原文件引用 |

`auth.getToken` 和 `auth.persistToken` 是已退休的兼容入口，canUse 永远为 false。`electronAPI`、壳专用 capture.save、原生菜单通道、窗口内部控制、任意文件读写和服务器消息发送不属于公开白名单。

`localFiles` 同时检查特性启用、注册、`getCapabilities().available` 和当前文档代次。宿主的登录与本地服务身份未就绪时返回 false；true 仍不代表已取得某个工作区上下文。先按 [本地文件 API](local-file-access-api.md) 调用 resolveContext，其他操作继续校验 contextId、相对路径及权限。API v2 写能力当前在本机文件候选分支中，安装包状态以实际源码/产物 pin 和验收结果为准。

## 复制截图和录屏

```ts
const capture = window.NuwaClawBridge?.capture;
// result 是同一页面刚完成的成功结果，尚未 release。
const capability = result.mime.startsWith('image/') && result.mime !== 'image/gif'
  ? 'capture.copy.image' : 'capture.copy.file';
const canCopy = await window.NuwaClawBridge?.canUse?.(capability).catch(() => false) ?? false;
if (capture?.copy && canCopy) {
  const copied = await capture.copy(result.resultId);
  if (!copied.success) showCopyError(copied.code);
}
// 复制完成后仍可读取/保存原件，随后必须 release。
```

```ts
capture.copy?(resultId: string): Promise<
  | { success: true; kind: 'image' | 'file' }
  | { success: false; code: CaptureErrorCode; error?: string }
>
```

| 结果 | 剪贴板内容 | 粘贴表现 |
| --- | --- | --- |
| PNG/JPEG/WebP 截图 | 系统图片/位图 | 可粘贴到支持图片的输入区，接收端可重新编码 |
| MP4/WebM 录屏 | 原始视频文件 | 支持文件粘贴的应用可接收视频附件 |
| GIF 录屏 | 原始 GIF 文件 | 保留动画；按接收应用的图片/文件规则处理 |

MP4 不写成图片或路径文本。目标聊天应用、编辑器或系统文件管理器需要支持文件粘贴；复制成功不代表接收应用一定会接受。IM 的原生菜单接入应直接读取为 `File` 回填草稿，避免依赖剪贴板来完成主业务。

copy 仅允许原发起页面导出仍有效的句柄。不返回本地路径，不上传、不发送消息、不释放原件。失败保留原件可重试，`invalid-argument` 也可能表示句柄已失效；无权页面返回 untrusted。Unix 文件副本权限为 0600、目录为 0700；Windows 继承用户数据目录的 ACL。副本独立于原件释放，按 24 小时清理并在运行中定期检查。关闭预览后可继续粘贴；不作为长期文件保存方式，Linux 应用退出后的剪贴板持有取决于桌面环境。

## 旧客户端与 IM 交接

旧客户端无 canUse 时，新能力探测视为 false；基础采集可另外兼容：新 canUse 存在时尊重其结果，旧版按基础方法存在性与 getCapabilities 探测截图/录屏，不因缺 copy 而禁用已有采集。IM Agent 按交接指南实现自己的业务适配，不依赖配套示例。

普通浏览器截图可保留 IM 原有 `getDisplayMedia` 降级；没有录屏实现时隐藏原生录屏项。原生流程已返回取消、权限拒绝、busy 或失败后，不再自动触发浏览器采集。

完整交接：[nuwax-im-native-capture-integration.md](nuwax-im-native-capture-integration.md)。采集协议：[native-capture-api.md](native-capture-api.md)。客户端白名单源：`src/shared/hostCapabilities.ts`；公共类型事实源：nuwax 前端 `src/types/interfaces/hostBridge.ts`，由客户端同步脚本生成快照。

平台实现依据：[Electron 40.8.2 clipboard](https://github.com/electron/electron/blob/v40.8.2/docs/api/clipboard.md)、[Windows FileDrop](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.clipboard.setfiledroplist)、[AppKit NSPasteboard](https://developer.apple.com/documentation/appkit/nspasteboard)、[GTK FileList](https://gnome.pages.gitlab.gnome.org/gtk/gdk4/struct.FileList.html)。跨端真实粘贴结果以本次验收记录为准。
