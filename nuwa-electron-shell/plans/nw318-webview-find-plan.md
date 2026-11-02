# NW-318 shell 页内查找实施

- 在现有 guest 键盘处理末尾增加 Cmd/Ctrl+F，保留 N、Shift+I 的判断顺序。
- 用同窗口 WebContentsView + 沙箱 preload + 本地 data HTML 提供查找条；复用 Claw.Browser 文案，不改 web 仓和 browser/windows.ts。
- 每个宿主窗口最多一个查找条，绑定快捷键事件源 guest；输入 100ms 防抖，记录 requestId，过滤迟到计数；关闭、销毁、导航及焦点离开时清理。
- 在 webviewPolicy.test.ts 验证快捷键、查找参数、计数、焦点及生命周期；运行相关既有测试、类型/构建检查，将输出和范围证据写入 shell/artifacts/nw318。
