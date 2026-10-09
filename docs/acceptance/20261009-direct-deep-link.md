# direct 模式资料库 / 消息深链兼容验收

2026-10-09：客户端实现及本机验证完成；跨平台真实安装和生产账号验收待完成。本批提交仅包含商业 overlay、测试和验证记录，尚未发布。

用户补充的范围：仅处理客户端主窗口内 webview 当前页的导航和刷新；新开窗口、独立窗口及 iframe 不纳入兼容。

## 交付行为

- 商业窗口创建前安装唯一 Session `onBeforeRequest` 分发器。仅主窗口所属 webview 的 direct 当前业务源顶层 GET `/repo`、`/instant-message` 页面请求进入同域 `/home`；普通 Umi 菜单导航不触发文档请求。
- 主站入口 fragment 携带原 pathname、query、hash；现有商业 preload 仅在主窗口 guest 私有启动参数存在时，在业务脚本启动前同步验证并 `history.replaceState` 恢复，不增加历史条目或公开桥 API。
- 完整导航目标按 WebContents 跟踪，重定向跟随当前导航；失败/销毁清理。被取消或不匹配的旧失败事件不清除新目标。
- 根据 webview 的 `hostWebContents` 校验当前主窗口归属。新开窗口、独立窗口和其他窗口中的 webview 不接管，也不处理恢复标记；宿主 renderer、外域、iframe、接口、WebSocket、资源和 POST 保持原行为。
- gateway 与 direct 共用分发器，启停只更新策略；不覆盖/注销另一模式的监听器。主站失败没有退回独立子应用的逻辑，沿用现有客户端失败处理。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| `npm run test:commercial` | 180 个测试文件通过、1 跳过；2,381 项通过、18 跳过 |
| `node scripts/acceptance/direct-deep-link.cjs` | Electron 40.8.2，macOS ARM64 隔离夹具通过 |
| 使用包内 `webviewPerfBridge.js` 再跑夹具 | 全部 18 组通过；实际加载 app.asar 内的生产构建 preload |
| `npm run pack -- --dir --output /tmp/nuwax-direct-deep-link-package-20261009` | main/preload/renderer 生产构建及 macOS ARM64 无签名 `.app` 打包通过 |
| `node scripts/sync-overlay.js --check` / `git diff --check` | 通过；overlay 与基座工作树一致 |
| `tsc --noEmit -p tsconfig.main.json --pretty false` | 仍有既有 `autoUpdater.ts:224` TS18047（display 可能为空）；本次代码无新增诊断 |

夹具使用实际商业请求策略、完整 preload、React Router 主站和实际 `NuwaxHostWebview` 组件；HTTP 服务故意让业务路径返回无侧栏的独立应用，仅 `/home` 返回主站。断言主站首个脚本和路由初始化均看到原业务 URL，页面有侧栏，服务没有收到被接管的业务文档请求。

18 组覆盖主窗口 webview 初次 src 深链、菜单 SPA 跳转后刷新、Ctrl/Cmd+R 输入、程序 loadURL、搜索 location.assign、前进后退、同路径不同 hash 的快速导航、模拟未登录/登录回跳、真实 WebSocket/iframe/API/资源/POST 排除、第三方源、实际 Host 组件刷新 handle、非业务宿主排除、主站失败及显式原目标重试、gateway 文档归一和切回 direct、模式禁用。另有负向断言：真实 window.open、独立窗口的深链/刷新/私有标记、其他窗口内的 webview 都保持原行为，不加载兼容主站。query、hash、百分号多重编码和 `_shell=1` 均有断言；主窗口历史栈没有私有标记或额外入口项。

故障注入会有一次预期的 `ERR_EMPTY_RESPONSE` 输出，夹具随后验证重试成功。

原始请求和断言记录见 [fixture evidence](20261009-direct-deep-link-fixture.json)。

## 本地产物与复验

- 无签名本地版本：`3.0.11-beta.6-dev`。
- `.app`：`/tmp/nuwax-direct-deep-link-package-20261009/mac-arm64/Nuwax.app`。
- base pin `d078bb3c`、前端 pin `4dfea90c`、dist pin `4a497a05` 均未修改；默认仍是 direct。

```sh
npm run test:commercial
node scripts/acceptance/direct-deep-link.cjs
NUWAX_FIXTURE_PRELOAD=/tmp/nuwax-direct-deep-link-package-20261009/mac-arm64/Nuwax.app/Contents/Resources/app.asar/dist/preload/webviewPerfBridge.js node scripts/acceptance/direct-deep-link.cjs
```

## 待验收边界

- 夹具主站使用 React Router，不是完整线上 Umi 和资料库/消息应用；登录是本地模拟，不代表真实 ticket、IdP 或生产账号已验收。
- 包内 preload 已运行验证；完整 `.app` 的安装、GUI 启动和真实站点业务流程未验收。现有错误页的重挂载重试行为保持原样；夹具的原深链重试是显式再次导航到原目标。
- 当前只有 macOS 主机，Windows 真实安装、刷新快捷键及业务验收尚未完成。无签名本地包不代表正式签名、公证和发布资产验收。
- 发布前分别在 macOS、Windows 新安装包的 direct 模式登录：在主窗口从菜单进入资料库和消息后用工具栏刷新及 Ctrl/Cmd+R，主窗口直接打开深链、搜索整页兜底、登录返回目标，确认主站左侧导航与原页面保留；新开窗口和 iframe 验证不被改写。切到 gateway 再重复关键路径。
- 此改动仅通过客户端版本交付；普通浏览器的业务地址直开仍由服务端分流配置决定。
