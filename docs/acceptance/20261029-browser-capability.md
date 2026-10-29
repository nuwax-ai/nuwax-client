# v3.1.0 浏览器扩展能力验收

2026-10-29。客户端分支 `release/v3.1.0`，浏览器实现已提交，并合入该发布线的远端修复。前端源码固定为 `51c51043775fca4a2d06fa33ccafc37f7bba92c8`，产物固定为 `47363d15d`，两者均已推送并提交双 pin。以下为源码和本机 Electron 证据，不代表正式安装包验收。

## 实现

- `browser` 按现有 DesktopFeature 静态注册，仅 nuwax 默认启用，关闭/注册失败回退系统浏览器。首次打开才创建网页窗口。
- 客户端设置选择应用内独立窗口或默认浏览器，保存后下一次点击立即生效；能力不可用时不展示应用内选项。
- 独立窗口具备标题/域名/完整链接查看、后退/前进/刷新/停止、复制、外部打开、查找、50%–300% 缩放、打印和原生置顶。
- 复用 electron-browser-shell 固定提交 `3817c4236f8511156086eb4541f364679b277b40` 的网页承载代码。源码旁保留原始 MIT 文本与改造说明，并通过独立 `third-party/source-components.json` 在打包阶段合并声明。原生采集配方、总清单及生成器保持原字节，capture-only 声明字节等价测试通过。
- 普通外链统一分流。支付显式用途及旧前端未标注的外域 native.openWindow 调用保留专用窗口；业务窗口中的普通外链仍遵循偏好。POST、referrer、opener、登录凭据、下载和离开确认继续由宿主策略负责。

## 已通过

| 检查 | 结果 |
| --- | --- |
| `npm run test:commercial` | 合入远端修复后 3771 通过，18 按既有条件跳过；无失败/未处理错误 |
| 前端支付、hostBridge 及更新入口定向测试 | 109 通过，含显式 payment、普通外链 page 用途兼容和日志内更新操作 |
| 特性边界、桥快照及许可证脚本测试 | 43 通过，打包/原生缓存检查另有 26 项通过；特性边界与桥快照检查通过 |
| 主进程与 renderer 构建 | 通过，包含独立 browser.html 和专用 preload |
| 全库 TypeScript 与 HEAD 对照 | 均为 249 项现存错误，规范化错误集合无新增；全库类型检查本身尚非全绿 |
| `browser-feature-electron.cjs` | Electron 40.8.2：加载、历史、刷新、弹窗 guest/opener、释放、真实工具栏 IPC、远程页面隔离、查找、缩放、原生置顶及关闭通过 |
| `popup-login-session.cjs` | direct/gateway × window/webview：首文档与后续 API 登录、第三方自身 Cookie、业务票据/网关能力过滤、实际 preload 桥及跨域往返通过；使用虚构 HttpOnly ticket |
| `download-popup.cjs` | 14 次真实下载、18 个专用窗口：完整字节、取消、重定向、已有文档保留、失败与空窗口清理通过；使用本地夹具 |
| 本机 GUI | 实际观察到工具栏与网页内容分别显示；更多菜单包含已确认项目 |

复现：从根运行 `node scripts/acceptance/browser-feature-electron.cjs`、`node scripts/acceptance/popup-login-session.cjs`、`node scripts/acceptance/download-popup.cjs`。前两项需要先构建客户端的主进程/preload 和 renderer。浏览器夹具使用临时 profile，不读取实际登录账号；`NUWAX_BROWSER_SHOW=1` 可临时显示窗口做界面检查。

## 尚待安装包阶段验证

| 平台/场景 | 本轮状态 |
| --- | --- |
| macOS 已安装商业包、签名与公证 | 未执行；本轮仅 Electron 40.8.2 本机源码运行 |
| Windows / Linux 实际安装包与桌面操作 | 未执行 |
| 系统默认浏览器真实交接、系统打印对话框/PDF、跨应用置顶效果 | 接口与菜单已实现；仍待安装包实测，不能仅凭 API 返回值关闭验收项 |
| 官方源码/产物双 pin 与发布 | 双 pin 已冻结，Beta.8 按该输入发布；安装验收仍待完成 |

独立安装包验证沿用 package-validation 流程和既有 Beta/Stable 版本基线，同一问题最多四次；本轮未启动该 workflow。用户已授权提交代码并发布新的 Beta，正式 Beta 发布使用根目录 release 入口。

## 发布前质量自查

- 内聚：网页窗口状态、工具栏命令和销毁收在 `main/features/browser/windows.ts`；链接分类、会话和下载策略由宿主的 `webviewPolicy.ts` 编排。
- 分层：宿主只经特性公开入口调用浏览器；工具栏只能控制所属窗口，远程网页不具备该控制桥。特性边界及桥契约检查通过。
- 维护：开源来源、固定提交及 MIT 许可证随模块保留；打包声明使用独立源码清单，原生采集缓存配方无本轮改动。浏览器状态与设置契约集中定义，生命周期及拒绝路径有测试。
