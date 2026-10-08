# 客户端 iframe 加载兼容验收

日期：2026-10-04。范围：商业客户端 overlay，沿用现有并排 iframe。按用户已确认选择，所有域名默认解除响应头中的防嵌入限制，无白名单或设置开关。

## 实现与来源

- `frameEmbeddingPolicy.ts` 只改写 HTTP/HTTPS 的主文档、子文档响应：删除全部 `X-Frame-Options`；逐条删除 CSP 和 Report-Only 中的 `frame-ancestors`，保留其他指令和 Cookie 头。
- `main.ts` 在窗口导航前安装默认 Session 策略，商业后续 Session 同样安装；开发 CORS 修复共用一个监听器，未变化的响应不回写头。
- `/page` 登记为后端文档根，顶层打开和 iframe 均走上游；相对资源、根相对资源、模块/CSS 子资源沿用现有路由归一机制。
- 根仓基线：`release/v3.0.x@76bfc5a3`；隔离验证基座：`6e361961e1b161bb22967e3ea7dc9b03c0633829`，叠加本轮商业 overlay。
- 打包前端采用根仓既有 pin：源码 `cb5aa08d4d8a5dac6a01991b57c797ff037fd7ad`、产物 `4df84e6a4e14454c8c19a45397f3799079642443`。原仓前端工作区已有其他 HEAD，本轮未改 pin、未重置原仓工作区。

## 本轮验证

质量门运行于隔离副本，社区测试清理 overlay 未影响原仓。证据保存在 `artifacts/iframe-embedding-20261004/`，仅复制测试日志、摘要、截图，不复制验收 profile 或 Cookie 数据库。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 社区完整回归 | 127 文件通过、1 跳过；1534 项通过、18 跳过、0 失败 | `community-test.log` |
| 商业完整质量门 | 169 文件通过、1 跳过；2138 项通过、18 跳过、0 失败 | `commercial-test.log` |
| 独立定向复核 | 4 文件、94 项通过，0 失败；未发现本次实现阻断问题 | `independent-review.txt` |
| 完整主进程类型检查 | 失败：现有 `autoUpdater.ts:224` 的 `display` 可能为 null；该文件未改且基座 HEAD 已有相同代码 | `TS18047`，本次不扩大修改范围 |
| overlay 一致性与导入边界 | 隔离副本 132 个文件一致、0 待同步；导入边界检查通过 | 本轮终端检查 |
| 真实 Electron 源码夹具 | Electron 40.8.2；79 次本地请求；默认、临时、持久会话通过；两个进程验证 Cookie 恢复 | `electron-source-fixture/initial-evidence.json`、`restart-evidence.json`、`request-summary.json` |
| 真实外网匿名页面 | demo 与学院明确断言标题、正文、脚本、图片，均完成加载；无 `did-fail-load` | `electron-source-fixture/live-evidence.json`、`live-1.png`、`live-2.png` |
| 真实学院经 loopback | 绝对上游 URL iframe 归一为本机 `/page/.../prod/`；iframe、顶层及刷新均显示学院内容；JS/CSS 200 且 MIME 正确，6 张图片完成加载 | `live-academy-loopback-iframe.png`、`live-academy-loopback-top-level.png` |

源码夹具先复现未调整头时的 `ERR_BLOCKED_BY_RESPONSE`，再验证 XFO/CSP/Report-Only、大小写、多条和合并策略、重定向、多层 iframe，以及保留其他 CSP 指令。夹具页面通过 `postMessage` 报告结果；`/page` 验证 HTML、相对资源、根相对资源、CSS 图片、模块导入及刷新。

同一个被改写的文档响应携带多个 Cookie，验证 HttpOnly ticket 登录、轮换、登出、请求使用当前 ticket，以及默认和持久会话跨第二进程恢复。Cookie 为夹具虚构数据，此证据不替代真实账号认证和续期验收。

外网验收使用全新匿名 profile，仅允许 GET/HEAD/OPTIONS，阻止 40 次网站自动写请求；不允许 WebSocket、弹窗，ticket Cookie 为空。学院根相对 `/sdk/dev-monitor.js` 被正确路由到 `/__backend/agent.nuwax.com/sdk/dev-monitor.js`，不再返回主站 HTML。

## 构建包验收

- 已通过商业主进程 esbuild、renderer Vite 与真实 electron-builder，生成 macOS arm64 无签名 `Nuwax.app`，版本 `3.0.7-iframe.1`、Electron 40.8.2。文件保存在 `artifacts/iframe-embedding-20261004/mac-arm64/Nuwax.app`，未发布。
- 构建调用项目现有 `pack()`，准备阶段通过已有 DI 复用逐项验证的资源。双 pin、商业依赖、kit 入口、Electron ABI 143/SQLite 查询、必要资源入口与摘要及 Computer Use arm64 payload 均已检查；未安装、未重建共享依赖，未伪造准备缓存。这不代表全新机器完整准备流程已通过。
- 包内 `app.asar` 主入口与本轮隔离构建字节相同，SHA256 为 `3d50c7615849b3ec1332c09566d5593728960128fce225b0a87760e23ba77bc1`；响应头服务、`session-created` 覆盖及 `/page` 注册均存在，4 个生产输入与当前 overlay 摘要一致。
- 包内 SQLite 二进制与 ABI 实测文件一致。整包 17 个符号链接均为相对链接且目标在包体内，asar 无链接，不依赖源码目录。
- 构建证据：`package-build/package-validation.log`、`package-input-validation.json`、`package-helper-validation.json`、`package-asar-validation.json`、`package-symlink-validation.json`。
- 已打包主入口与资源的隔离 QA 通过：同版本通用 Electron runtime 装载上述 `app.asar`，实际生产 shell 创建业务 guest，匿名 dist loopback 初始落在登录页；在真实 guest 中验证受 CSP+XFO 保护的外源 iframe、多个 Cookie、`/page` 上游内容和根相对模块/CSS、iframe 与顶层刷新，31 次本地请求，0 页面加载失败。截图已查看。
- QA bootstrap 在加载生产入口前隔离 Electron home/appData/userData/sessionData/logs/crashDumps、`os.homedir()` 和子进程环境的 home；配置只写入临时 DB，全部端口与用户客户端分离，未使用真实 ticket。退出后 3 个测试端口均关闭，无 QA 主进程或业务子进程残留。
- QA 运行证据：`packaged-main-qa/result.json`、`requests.json`、`packaged-main-shell-iframe.png`、`packaged-main-guest-iframe.png`、`port-cleanup.json`。该方式验证包内生产入口和资源，不代替 dmg 原生安装或签名验收。
- QA 退出时另记录已有 `hostActivity.ts:219–222` 的 `Object has been destroyed`：窗口 `closed` 回调访问已销毁的 `win.webContents`，对应包内主入口第 73066 行。该模块不在本轮改动中，页面断言已经完成，退出清理与测试端口关闭成功；本轮不扩大修改范围，保留该退出异常记录。

## 尚未覆盖的验收

- macOS 原生安装及启动、Windows 交互桌面下的真实安装包启动、页面加载和登录持久化。
- 正式签名、公证、Gatekeeper、安装升级，以及真实账号的 OAuth/登录、续期、登出与重启恢复。
- 真实业务页面父子通信全流程；当前夹具只验证 `postMessage` 通信与刷新。

全域解除防嵌入响应头符合本次明确选择；网站脚本主动阻止嵌入、登录策略或其他浏览器能力限制仍可能独立存在。本轮未取消其他 CSP 指令，未扩大业务凭据的接收域范围，也未改前端接口和布局。
