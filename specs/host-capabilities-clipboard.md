# 规格：host-capabilities-clipboard

- 对应 intent：plans/20261014-host-capabilities-clipboard-intent.md
- 状态：技术自查通过；基于现有主进程文档代次、受信顶层 IPC 和采集结果所有权机制。

## 需求基线

实现统一环境与能力探测、图片/媒体文件复制、录制控制条去阴影，并将 IM 接入指南整理成可交接材料。

## 方案设计

### 架构落点

- 能力名称使用明确清单；preload 提供 NuwaClawBridge.canUse，主进程对每次查询重新检查当前受信顶层文档和特性注册情况；查询不改变现有业务 API 的权限校验。
- capture 格式查询复用 getCapabilities 的实际编码能力。普通浏览器的可复制消费者 helper 返回 false；旧客户端通过已存在的 capture 能力探测降级，不能通过 window.top 或代理 IPC 绕过边界。
- 能力清单覆盖当前公开命名空间，区分业务入口与宿主同步/内部入口；未列出的名称返回 false，废弃 token 接口不宣布可用。
- 采集模块新增复制结果操作，校验句柄、发起 WebContents 与当前信任上下文；宿主与业务页沿用各自 IPC 边界。
- 主进程创建独立媒体副本再复制；文件缓存不归 release(resultId) 删除，使用私有目录、固定 MIME 扩展名、随机名称和 24 小时清理策略（Unix 0600/0700；Windows 继承用户目录 ACL）。
- 图片写入 Electron 原生图片剪贴板；文件复制由 macOS、Windows、Linux 各自适配。代码以项目实际 Electron 40.8.2 API 为准。
- 预览提供带图标的复制按钮、成功/失败提示和异步门禁；复制成功后预览仍可保存或关闭。录制控制条 hasShadow=false。

### 数据与契约

```ts
canUse(capability: string): Promise<boolean>;
capture.copy?(resultId: string): Promise<
  | { success: true; kind: 'image' | 'file' }
  | { success: false; code: CaptureErrorCode; error?: string }
>;
```

- canUse 为增量可选接口；未知、缺方法、无 IPC、查询失败都返回 false。
- capture.copy 在旧宿主可缺失；getNativeCapture 的既有读取路径继续兼容。
- 能力探测成功不表示已有屏幕录制权限、结果句柄或空闲设备，仍按调用结果处理。
- 同步前端契约事实源与客户端生成快照；截图/录屏现有 API v1、Promise 返回、分块读取与释放保持兼容。
- IM 会话 ID/草稿代次保存在 IM 业务上下文；不增加 capture.record 的未知参数。

### 平台矩阵

| 行为 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| PNG/JPEG 图片复制 | Electron 主进程 writeImage | 同左 | 同左 |
| MP4/GIF 文件复制 | 原生文件 URL 剪贴板 | 原生 FileDrop，STA | 标准文件 URI 剪贴板，验证 GNOME |
| 预览关闭后粘贴 | 复制副本持续可用 | 同左 | 同左；剪贴板所有权遵循桌面实现 |
| 控制条阴影 | 关闭窗口阴影 | 同左 | 控制窗原有录制时隐藏策略 |

## 异常与失败场景

普通浏览器/旧宿主、未知名称、非受信/子 frame/导航后旧文档、关闭的特性、缺编码器、缺复制接口均保守返回不可用。复制失败保留预览和原件可重试；无权/失效句柄不得导出。复制期间重复点击受门禁控制，卸载后不更新 UI。权限拒绝、busy、超限、会话切换、IM 卸载仍按原桥与适配器结果处理。

## 测试计划

- canUse：名称清单、真实方法形状、未知/无 IPC、信任与代次、关闭特性、MP4/GIF 格式差异、旧宿主兼容；核对查询不发起采集。
- copy：所有权、失效句柄、PNG/JPEG 图片、MP4/GIF/WebM 文件、字节一致、关闭预览后副本、错误与缓存清理；平台适配验证文件 MIME 和安全参数传递。
- UI：复制按钮类型、成功/失败、重复点击、关闭/卸载；controls 和 border 的窗口阴影策略。
- 现有 IM 独立示例、capture 域和商业回归；社区回归只在隔离副本中运行。
- 尽可能运行 macOS 原生复制及 Windows/Linux 真机文件粘贴检查；不以模拟证明跨端真实粘贴。

## 设计取舍

保持能力探测与实际操作分离，避免查询弹出权限/采集 UI。保留结果直接回填 IM 的主流程，剪贴板用于用户主动跨应用粘贴。文件导出不使用假 MP4 MIME 写入图片剪贴板，也不向 renderer 暴露文件路径。


## 实施结果

实现与三端原生复制验证完成，最新 release 本地文件能力也已纳入 canUse；详见 docs/acceptance/20261014-host-capabilities-clipboard.md。新增 API 尚未进入 beta.6；IM 实际业务接线与发送由 IM 同事按指南完成。

交接偏好更新：同事通过 Agent 实施，只提供可执行的 API/业务步骤文档，不要求拷贝示例或类型。已有历史例程保留作内部验证，不新增 SDK 依赖。
