# 规格：截图启动与入口偏好

对应 intent：plans/20261023-capture-entry-preferences-intent.md

## 行为

- capture.hideAppWindow 缺省 false；主进程每次采集读取，截图和录屏共用，仅恢复本会话实际隐藏的窗口。
- capture.screenshotShortcut 缺省 CmdOrCtrl+Shift+A，capture.recordShortcut 缺省 CmdOrCtrl+Shift+R；使用按键录入，限定修饰键加字母、数字或 F 键，拒绝纯修饰键和已有应用内常用命令冲突。保存失败保留原设置，菜单显示最后保存成功的组合。
- Win/Linux 在宿主和 guest 拦截当前快捷键，macOS 由原生应用菜单 accelerator 执行。保存设置后原生菜单重建、自绘菜单更新。两个快捷键不允许相同。
- 应用菜单显示截图、MP4、GIF；宿主选择浮层传入初始 action 和允许模式，切换不改变冻结帧和 crop；确认才执行所选动作。业务页面通过显式 interactive API 开放类型切换，既有 screenshot/record 保持固定返回类型。
- 截图服务与 FFmpeg 检测解耦；视频能力请求及录屏仍等待已验证的编码资源。截图使用轻量能力探测；默认能力调用保留完整能力语义。
- 同分辨率屏幕共用一次 getSources，混合分辨率按原生像素分组，窗口缩略图与屏幕冻结并发完成，所有采集完成后才创建覆盖层。

## 异常与验证

来源、选区、格式仍在主进程校验；取消、登出、退出、编码失败复用同会话清理；模式切换不释放 busy 锁。测试覆盖偏好保存回滚、动态菜单/按键、截图不等待编码器、宿主模式切换及业务桥隔离。Windows 性能结论以实机验收为准。

## IM 焦点路由

- 快捷键从触发时的 focused webContents 发起；菜单点击继续宿主预览。macOS 通过 triggeredByAccelerator 区分来源，Win/Linux 绑定 guest 时保留发起对象。
- 受信 IM 的 onShortcut 先同步判断当前编辑器焦点，再向主进程认领。200ms 内由原 sender/frame 回应才授予；页面收到授予后启动。过期拒绝，防止宿主回退后启动第二次采集。
- IM 原生采集优先使用 interactive，旧宿主回退 screenshot/record，普通浏览器保留原 display-media 路线。结果转 File，图片复用 addInlineImages/insertMedia，视频调用既有 addPending；读块前后校验原会话，切换时在 release 前 copy，不自动发送。
- 前端契约事实源 nuwax/src/types/interfaces/hostBridge.ts 和壳快照同步；独立 IM 使用可选桥，不依赖 Electron。
