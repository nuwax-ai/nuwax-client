# 下载弹窗鉴权与生命周期修复

## 问题

- 可信弹窗首文档尚未提交时没有登记初始 URL，业务 ticket 被鉴权钩子剥离，下载接口返回 4010。
- 下载重定向创建可见隔离窗口；附件不会提交 HTML，下载结束后留下空白窗口。

## 范围与步骤

1. `webviewPolicy.ts` 在 Electron 创建子窗口回调内提前登记可信 URL，保留传入 webContents、referrer、POST 与隔离会话。消息正文的 `noopener noreferrer` 文件 GET 单独鉴权，无业务 preload/IPC 桥；只有窗口全部 frame 的实际 origin 均可信时才借用首请求鉴权。
2. 商业弹窗先隐藏；主文档提交后保留，DOM 就绪后显示。只清理没有提交文档的下载窗口，成功、取消、失败均覆盖。
3. `sessionAuthInjection.ts` 的初始文档授权补齐确切的当前 gateway origin，继续要求主进程登记、精确 URL、空白窗口和 mainFrame。
4. 增补对应单测，并使用独立 profile、随机端口的真实 Electron 验收验证 Cookie、302、下载字节与窗口生命周期。

## 验证

- 定向 Vitest：webviewPolicy、sessionAuthInjection。
- `node scripts/acceptance/download-popup.cjs`；既有 loopback 登录同步验收。
- 同步商业 overlay、构建主进程、检查 pin 与差异。

## 恢复边界

四个现有源码/测试文件改前均与外层 HEAD `261d3036766ede6d8c6f8a89110adb7b27d03cf6` 一致，并已单独备份。只处理上述文件、新验收脚本和本计划；保留其它工作区改动。

## 验证结果

- 定向 Vitest：2 个文件，51 项通过。
- 真实 Electron 40.8.2 下载验收：19 个场景，14 次真实下载；覆盖 anchor / window.open 及消息同款 `noopener noreferrer`、业务 302 / 外域直出、取消、网络失败、4010 / 404 正文、已有页面与慢资源页面；下载专用窗口从未显示、终态后清理，无未处理 Promise。
- `--frame-provenance` 模式：6 条真实入口，顶层与同源 iframe 可下载，外域 iframe 隐藏 referrer 也不能借用 ticket，使用隔离会话且无业务桥。
- 既有 loopback 登录同步验收通过，43 次请求；覆盖双写、轮换、登出与请求边界。
- 商业 overlay 同步、主进程 dev 构建、pin 与差异检查通过；独立复核无剩余阻断。
- 当前开发客户端已完整重启（PID 4500，2026-09-29 16:38:39），并实际点击“冯飞1”消息中的原始业务域名 ZIP 链接，完成系统保存对话框后返回消息页面，没有 4010 或残留空白窗。
- 保存文件 `/Users/apple/Downloads/nuwax-im-download-20260929-1642.zip`：1,416,702 字节，ZIP 签名 `504b0304`，20 个条目，CRC 校验通过；SHA256 `aa4e0e40adb179cadcc7e7d954f54b9e6b4720c8fcec742b23cc9e6c866c0825`。
- 其他机器仍需要更新包含本修复的安装包。

## 实际入口复验

用户反馈“测试没有变化”后，实际点击消息链接复现了 4010，且已确认主进程加载第一版修复。第一版模拟链接仅设置 href/target，漏掉实际 Markdown 强制的 `rel="noopener noreferrer"`，因此验收未覆盖空 referrer 导致的首请求鉴权问题。本次补入与产物一致的链接属性、外域 iframe 负例以及当前客户端实际下载证据。
