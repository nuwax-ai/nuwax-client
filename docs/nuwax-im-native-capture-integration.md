# nuwax-im 原生截图与录屏接入交接

面向 nuwax-im 项目负责人及其开发 Agent。更新：2026-10-14。本文是接入依据，不要求安装客户端 SDK、拷贝示例代码或类型文件。接口版本为 v1，canUse/copy 是兼容增量。

## 功能与版本

客户端应用菜单和设置「截图与录屏」页签提供截图、MP4、GIF。菜单发起的操作完成后，客户端弹出结果预览；底部保留「关闭」「保存」，增加带图标的「复制图片」或「复制文件」。截图写图片剪贴板，MP4/GIF 写原文件，GIF 保留动画。复制成功不关闭预览，仍可保存。

基础采集已在 v3.0.14-beta.6 发布；新增 canUse、copy 和预览复制按钮尚未公开发布。IM 业务菜单仍需按本文接线，不能把客户端预览验收视为 IM 已接入。

能力目录：[host-capabilities-api.md](host-capabilities-api.md)。完整采集参数、返回字段及限制：[native-capture-api.md](native-capture-api.md)。验证范围：[验收记录](acceptance/20261014-host-capabilities-clipboard.md)。

## 职责和入口

| 发起入口 | 结果归属 |
| --- | --- |
| 客户端应用菜单／设置页签 | 客户端自己的预览弹层，复制或保存到本地 |
| IM 会话框菜单 | 这次 screenshot/record Promise 返回给 IM，读取为 File 后加入发起会话的待发送附件区 |

IM 的完整链路：菜单点击 → 固定目标会话 → 选择来源/区域 → 用户截图确认或录制停止 → 编码完成 → Promise 返回 → 读取为 File → 原会话附件草稿 → 用户点击发送 → 原上传和消息流程。

客户端负责多屏来源、物理像素、标注、原生录制控制、编码、权限和结果清理；主站负责受信业务 document、既有登录和桥初始化；IM 负责菜单接线、草稿归属、上传限制、提示及真正发送。客户端不认识 IM 会话 ID，不自动上传或发送消息。

## 宿主入口与能力判断

每次点击时重新读取 `window.NuwaClawBridge?.capture`，不在模块加载时缓存。主站目前以 qiankun 同 document 沙箱加载 IM；`props.host`／`window.NuwaxHost` 是导航桥，不能写成 NuwaxHost.capture。IM 保持独立项目，不导入 Electron、qiankun、主站源码路径或客户端 SDK。

新客户端先调用 `NuwaClawBridge.canUse(name)`，返回 Promise<boolean>。IM 菜单使用精确名称：

| 操作 | 能力名 |
| --- | --- |
| 截图 | capture.screenshot 或 capture.screenshot.png/jpeg |
| MP4 | capture.record.mp4 |
| GIF | capture.record.gif |
| 复制截图 | capture.copy.image |
| 复制录屏 | capture.copy.file |

无桥、未知能力、未启用/未注册功能、外部页面、子 frame、过期 document 或查询失败均为 false。true 不保证系统授权、设备空闲或结果句柄有效，实际调用仍需处理失败。主站先按现有流程 auth.getContext 绑定文档代次；IM 不重建认证或设备注册链。

旧客户端缺 canUse 时，基础截图/录屏可按方法存在性与 capture.getCapabilities 兼容；新的 canUse 存在时必须尊重 false，不能再按方法存在性绕过。copy 缺失时隐藏复制入口，不禁用旧采集功能。分别检查 formats.still、formats.video 和 formats.gif，普通菜单只展示 MP4/GIF；WebM 仅保留兼容 API。

普通浏览器没有客户端桥，截图可保留原 getDisplayMedia 降级；若未实现浏览器录屏则隐藏录屏项。原生操作已经取消、拒绝权限、busy 或失败时，不再自动打开浏览器采集弹窗。

仅客户端当前受信顶层业务 document 可使用采集。不要通过 window.top、postMessage 或自建 IPC 绕过边界。联调从开发客户端配置的测试业务域 https://testagent.xspaceagi.com 进入主站 IM；独立 localhost IM 页面不因处在 Electron 中就受信。

## IM Agent 的实施位置

以下按 nuwax-im@518be4d 核对；实施前以当前源码复核。

| 位置 | 改造要求 |
| --- | --- |
| nuwax-im-web/src/components/ChatWindow.tsx 的 captureScreen | 从直接 getDisplayMedia 改为先探测原生能力；结果转 File 后回填固定目标草稿 |
| 同文件 addPending、canUpload、composerLocked | 复用原文件校验与发送权限/禁言门禁；增加指定会话追加附件的方法及业务草稿代次 |
| ComposerToolbar.tsx 截图下拉与窄窗 MORE_ROWS.shot | 两套入口都接截图、MP4、GIF；保留既有粘贴入口；共用 pending 锁 |
| api/upload.ts、lib/attachment.ts | 复用已有上传配置和 MIME 识别；不增加消息类型、后端接口或第二条上传链 |

现有 addPending 只写当前会话，但 pendingByConvRef 已保存非当前会话的附件草稿。抽取指定会话追加函数：目标是当前会话时仅更新 pending/pendingRef，目标不是当前会话时仅更新 pendingByConvRef，不重复写两个桶。复用文件大小、数量、空文件和权限校验，不直接绕开 addPending 的规则。

在第一个 await 前保存不可变目标：conversationId（保持 string）和 IM 自己的登录/草稿操作代次。能力查询后、采集返回后、读块完成后分别复核目标和发送权限。A 会话发起后切到 B，回填 A 的草稿并提示，不切换用户正在阅读的 B；若暂时只支持当前草稿，切换后应丢弃迟到结果并提示，不能回填 B。

IM 应用层统一管理 pending 和订阅，宽窄菜单共用；聊天切换不卸载整个采集控制器，真正 IM 卸载才终止回填。React Hook 放在 early return 之前，异步完成提示前检查组件仍挂载。不要在聊天组件卸载时无条件调用共享 document 的 cancel，避免取消其他入口的采集。

## 调用、读块与清理

1. 检查 canUpload、composerLocked、菜单 pending，固定目标会话并置 pending。
2. 探测精确能力，再读取 getCapabilities；订阅 onStateChange。
3. 截图调用 screenshot；录屏调用 record，output 为 mp4/gif。record Promise 要等待停止及编码完成，并非开始录制后立即返回。
4. success:false 按 code 处理；success:true 先检查目标有效性、bytes、mime 和上传限制。无效或放弃的结果也必须 release。
5. readChunk(resultId, offset, length) 每次不超过 4 MiB，按实际 byteLength 推进并要求长度完整；null、短块或未知 MIME 拒绝生成附件。
6. 用真实 MIME 和对应扩展名组装 File，finally release 原结果。随后复核目标并加入原会话草稿，不自动发送。
7. finally 退订监听并清 pending；附件移除/退出时由 IM 释放自己的 Blob URL。

resultId 是客户端临时句柄，不是 URL、路径或服务端文件 ID。它仅属于发起业务页面，导航、关闭、登出、换域、锁屏、挂起或显示器移除可令其失效。onStateChange 只发给发起 document；idle 不等于 File 已读完，pending 必须持续到回填完成。全客户端仅允许一个采集会话，仍需处理 busy。

当前 IM 前端限制来自 api/upload.ts 的 UPLOAD_MAX_MB：VITE_IM_UPLOAD_MAX_MB 可覆盖，缺省 100 MB。这只是前端占位限制，不是后端保证；与上传服务确认后复用现有配置。转换为整数 bytes，native maxBytes 范围 1–2147483648。现有上传路径缺省 /api/file/upload，用户点发送时才上传。

compression 可以省略；若传入则 quality 必填。maxBytes 为质量逐档下探的目标，最低档仍超限会返回 exceedsMaxBytes:true，IM 应拒绝入队并提示缩短录制或降低画质；不能把它当硬体积保证。尺寸不缩放，GIF/视频的 lossless 档也不承诺数学无损。

## 复制与 IM 回填的区别

客户端菜单完成后的复制按钮已经由壳实现，IM 不需要为此实现按钮。按钮把截图写为图片、MP4/GIF 写为原文件；目标应用需支持相应粘贴。文件副本独立于预览句柄，复制完成后关闭预览仍可粘贴，缓存按 24 小时清理，不能当长期保存。

若 IM 自己需要复制结果，可在 release 前调用 capture.copy(resultId)。成功返回 success:true 与 kind:image/file，失败返回 success:false 和 CaptureErrorCode；失败保留原结果可重试。copy 不返回路径、不释放原件、不上传或发送。

IM 主接入流程直接 File 回填草稿，不依赖剪贴板。若同时需要复制和回填，先 await copy，再读块并 release；否则释放后 copy 将因句柄失效失败。业务桥不提供 save、pause、resume 或 stop；停止/暂停由客户端原生 UI、托盘或应用内快捷键处理，cancel 表示丢弃。

## 失败处理与验收

| 场景 | IM 行为 |
| --- | --- |
| canceled | 静默结束，不生成附件 |
| permission-denied | 提示当前平台允许屏幕采集后重试；Linux n/a 不表示已授权 |
| busy | 提示先完成当前采集 |
| encoder-unavailable / unsupported | 按能力隐藏或禁用格式，实际失败时提示，不再触发第二个采集弹窗 |
| untrusted | 提示刷新并反馈主站/客户端检查受信来源和文档代次 |
| invalid-argument / failed | 稳定提示并记录必要诊断，不静默吞错或展示全部内部错误 |
| 超限、读块失效、目标失效 | 不回填/发送，释放句柄并提示 |

IM Agent 完成接线后必须验收：

- 普通浏览器和旧客户端不报错，截图降级可用；新客户端分别按 MP4/GIF 能力显示入口。
- 菜单只发起一次，取消没有附件；停止并编码完成才回填，idle 后读块期间也不能重复发起。
- 截图、MP4、动画 GIF 进入原会话草稿，用户发送后对端内容正确；录制中切到另一会话不误回填。
- 卸载、登出、换域、权限变化、超限和失效句柄均不继续发送，监听和 Blob URL 不累积。
- 客户端菜单的预览底部有复制按钮，复制不关预览；关闭预览后图片/文件仍可粘贴，GIF 保留动画。
- macOS、Windows、Linux 的安装包、实际 IM 和目标粘贴应用分别记录验收，不以隔离 runtime 或另一平台代替。

无音频、无跨屏选区、当前 WebP 不可用，HDR 真实色调映射仍未实现。Linux X11 使用覆盖层；Wayland 使用系统来源选择和授权来源预览。Linux 录制时控制窗隐藏，托盘或切回客户端按 Ctrl+Alt+R 停止、Ctrl+Alt+P 暂停/继续。实际格式以 capabilities 为准。

交付记录应含客户端版本、IM 提交/部署版本、接入形态、OS/屏幕布局与缩放率、格式/画质/尺寸/时长、失败 code 与复现步骤，以及对端接收表现；不附账号或凭据。
