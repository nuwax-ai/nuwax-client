# 客户端切窗交互状态修复

窗口失焦目前只收起宿主顶栏菜单，业务 webview 的 hover、tooltip、下拉及 DOM 焦点可能残留。切回窗口时应尽力恢复编辑位置。

- 主进程使用已登记的业务文档，按所属窗口发送失焦/获焦状态；失焦同时发送 Chromium mouseLeave，清除真实 CSS hover，不混入休眠可见性状态。
- 受信 preload 失焦时保存编辑元素及选区、释放焦点，并向空白处派发外部按下事件；不派发 click，不触发按钮或确认操作。
- 获焦时仅在原编辑元素仍可用、文档实际获焦且用户没有新交互时恢复；保留文本、滚动位置，已关闭的临时浮层不重开。
- 验证：窗口归属/生命周期单测、输入与选区恢复及用户交互竞争单测、真实 Electron/React/Ant Design 隔离验收、商业版门禁。

不改前端业务源码、发布版本或子模块 pin；源码和隔离页面验证不代表真实安装包及 Windows/Linux 验收。

验证结果：定向 73 项通过；`npm run test:commercial` 308 个文件通过、1 个跳过，3809 项通过、18 项跳过；`check:boundaries` 通过。macOS Electron 40.8.2 隔离页面使用实际 preload 和宿主活动服务，验证真实 CSS hover、Ant Design tooltip/点击下拉收起，切到另一窗口输入后切回恢复输入选区并继续输入、contenteditable 选区恢复，以及模态框保持打开。未进行真实安装包或 Windows/Linux 验收。
