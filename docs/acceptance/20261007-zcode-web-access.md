# 今日 ZCode 任务接续与验收

## 需求与输入

会话 `sess_7142143c-3e46-41a8-bbd1-b4d07450801e` 及当日后续要求：更新子模块、提交修复后打包 beta；新窗口、原窗口和 iframe 可访问任意网页域。用户授权以今日任务为范围接手处理。

起点为客户端 `release/v3.0.x@25ac90e7`，基座固定 `6e361961e`。原工作区前端实际 HEAD 为 `9dba1b47`，与声明 pin 不同，且有既有未跟踪内容；全部保留。冻结前端和打包在 `/private/tmp/beta304` 完成，不把原工作区的旧前端检出混入发布。

## 修复

- 普通 HTTP(S) 导航留在原网页，新窗口与 webview 共享浏览器会话；轻量桥随实际文档来源决定是否暴露。
- 业务 GET 文档保留登录，页面中的无关第三方 iframe 不影响站内新窗口。API、POST、WebSocket 和下载继续校验来源。
- ticket 来源归属每个会话 listener，覆盖轮换、父域恢复和换域竞态；网关同主机其他端口或 Cookie 来源读取失败时保守过滤 ticket，其他 Cookie 保留。
- native 窗口共用 popup 加载/下载清理；页面就绪显示，加载失败、下载结束或 opener 销毁关闭空窗口。
- 修复关闭窗口时 HostActivity 访问 destroyed getter 的异常。
- 前端生产构建消费冻结微应用 pin，移除隐式自动升级；重制 message adapter，隔离卸载实例异步续跑，修正 repo portal 平移后的宽高。

## 质量门与真实运行

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 商业完整门，独立 verifier | 2214 通过，18 跳过，0 失败；170 文件通过，1 跳过 | 同步后的 overlay，Electron 40.8.2 |
| 社区隔离完整门 | 1534 通过，18 跳过，0 失败；127 文件通过，1 跳过 | 干净固定基座副本；复用本机依赖与 mcp-proxy dist |
| 访问相关专项 | 226 通过 | 注入、mirror、window policy、native、真实 preload 模块 |
| 独立前端矩形/store/lifecycle | 14 通过 | 冻结候选 `4239d467`；旧实例续跑和活跃分页分别验证 |
| 前端生产构建 | 通过，受跟踪源码干净 | `4239d4671437f0f886276c69a3484b4466d123da` |
| overlay/check:pin | 135 文件一致，0 待同步；130 基座脏文件全部为 overlay 产物 | 未清理原工作区 |
| 真实窗口夹具 | 通过 | direct/gateway × BrowserWindow/webview；anchor/window.open、混合 iframe、跨域原窗口/回跳/302、自有第三方 Cookie |

真实窗口夹具编译实际 `webviewPerfBridge`，验证跨域后桥消失、返回业务页恢复。临时 profile 与模拟 ticket，不读取真实账号。原窗口关闭问题曾先复现失败，再改源码使 32 个 HostActivity 用例通过。

原工作区脚本门最初 151 通过、7 失败，全部因该目录保留的旧前端缺少 hostBridge 契约文件；冻结候选集成后在打包台重新验证。此结果不能当作候选源码失败，也不能省略候选重跑。

## 三问质量走查

- 内聚通过：票据来源状态收在 `SessionTicketProvenance`，每个 listener 独立；native 与 popup 共用 `trackPopupWindow/loadPopupDocument`。
- 分层通过：商业策略只落在 overlay；preload 按实际文档判定，API 在主进程按 frame 判定；前端构建与微应用适配归前端仓。
- 可维护性通过：轮换、恢复、换域并发、异常 callback、导航和窗口清理均有回归。独立 review 找到的空窗口清理与 `/api` 根路径授权问题已修复；过时注释已更新，无未解决 Important。

## 冻结记录与交付边界

前端：`4239d4671437f0f886276c69a3484b4466d123da`，远端分支 `codex/fix-micro-app-build-frozen-20261007`，草稿 [PR #187](https://github.com/nuwax-ai/nuwax/pull/187)。message pin `f3a568275c0b3ed21537df98a7eedd6bdbf6b070`，repo pin `18ae973c890c699c678b086ad1da3b95275a3c86`。

对应前端产物已提交推送 `nuwax-dist` main 的 `d7d9bf8`。stamp `4239d4671`，989 文件，SHA256 tree `03399ab77ce35263f876a759299a468593f577eece4907284464132c55ba6003`。

远端已使用 3.0.7，因此本次 beta 目标为 3.0.8，不能继续旧任务的 3.0.4。真实账号、Windows/Linux 设备、正式安装包签名/公证与远端全平台发布状态需要各自证据；本地源码与临时 profile 验收不代替这些环节。
