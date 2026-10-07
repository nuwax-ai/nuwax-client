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
- 今日排障回退 `dd43c1730` 曾把既有桥类型契约一并删除；恢复四个纯类型文件和全局引用，不恢复其它被回退的运行时功能。同步脚本的单位夹具独立于当前前端检出，缺失 canonical 明确失败，保留严格 consumer/provider 与逐字节快照门。
- 同一回退还删除了既有 CI 类型门；恢复原检查器、19 条自测、四域范围与空基线，修复真实 X6 API、表单类型和公共依赖边界。域外 284 条诊断仍如实报告，原 97 条架构豁免保留。
- 正确调用 X6 `getGraphRef` 后，潜在自动排列回调同步 proxy 坐标、批次标脏一次并进入原保存链；10 条回归修前 5 失败，修后全部通过。当前 AgentFlow Header 隐藏，未恢复自动排列按钮，此项验证回调契约。

## 质量门与真实运行

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 商业完整门，独立 verifier | 2214 通过，18 跳过，0 失败；170 文件通过，1 跳过 | 同步后的 overlay，Electron 40.8.2 |
| 社区隔离完整门 | 1534 通过，18 跳过，0 失败；127 文件通过，1 跳过 | 干净固定基座副本；复用本机依赖与 mcp-proxy dist |
| 访问相关专项 | 226 通过 | 注入、mirror、window policy、native、真实 preload 模块 |
| 独立前端矩形/store/lifecycle | 14 通过 | 冻结候选 `4239d467`；旧实例续跑和活跃分页分别验证 |
| 前端生产构建 | 通过，受跟踪源码干净 | 最终 `d16531c8e5f0ebb066e3ff40116cb488fb01599f` |
| 前端桥/事件/IM | 90 通过 | 纯类型契约恢复后 |
| 前端完整 CI 门，独立 verifier | 19 工具自测、355 文件/3294 用例通过、6 跳过、0 失败 | 最终源码 `d16531c8e`；319 域内文件 0 类型诊断，架构 0 新违规，54.32 秒 |
| 严格桥契约门，独立 verifier | 12 通过，0 失败；host-bridge:check 通过 | canonical/overlay 一致，旧宿主能力保持可选 |
| 最终完整脚本门，独立 verifier | 162 通过，0 失败 | 最终冻结双 pin，67.47 秒；host-bridge:check/overlay:check/check:pin 同时通过 |
| macOS arm64 本地 pack | 通过 | 最终 3.0.8-qa.2，标准入口，未做 Developer ID 分发签名 |
| 最终包静态检查，独立 verifier | 989/989 前端文件零差异，3 个 main/preload 文件一致 | 3.0.8-qa.2；Info 身份、Electron/ABI、图标与签名边界核实 |
| 最终包内资源隔离运行 | 通过 | 实际 main/guest/API、共享 popup、跨域返回与桥隔离；空白账号，stamp `d16531c8e` |
| overlay/check:pin | 130 个托管路径一致，0 待同步；130 基座脏文件全部为 overlay 产物 | 未清理原工作区；以 --untracked-files=all 计数 |
| 真实窗口夹具 | 通过 | direct/gateway × BrowserWindow/webview；anchor/window.open、混合 iframe、跨域原窗口/回跳/302、自有第三方 Cookie |

真实窗口夹具编译实际 `webviewPerfBridge`，验证跨域后桥消失、返回业务页恢复。临时 profile 与模拟 ticket，不读取真实账号。原窗口关闭问题曾先复现失败，再改源码使 32 个 HostActivity 用例通过。

iframe 真实 Electron 夹具另外通过：默认/临时/持久会话、XFO 与多 CSP 策略、重定向和嵌套 iframe、保留其余 CSP、`/page` 资源与重启 Cookie 恢复（79 请求、2 个 Cookie 重启进程）。

原工作区和首个冻结候选脚本门均为 151 通过、7 失败，暴露了 canonical 契约缺失。首个候选的真实原因是上述排障回退；不能用快照兜底或弱化类型门掩盖。恢复后 12 个严格门和 162 项完整脚本门全部通过。

## 三问质量走查

- 内聚通过：票据来源状态收在 `SessionTicketProvenance`，每个 listener 独立；native 与 popup 共用 `trackPopupWindow/loadPopupDocument`。
- 分层通过：商业策略只落在 overlay；preload 按实际文档判定，API 在主进程按 frame 判定；前端构建与微应用适配归前端仓。
- 可维护性通过：轮换、恢复、换域并发、异常 callback、导航和窗口清理均有回归。独立 review 找到的空窗口清理与 `/api` 根路径授权问题已修复；过时注释已更新，无未解决 Important。

前端补修的独立三问走查也通过：原检查器、自测和空基线逐字保留，全部生产目录和前缀保持；使用 X6 公开类型与真实动画实现，桌面事件经过会话公共入口。回调回归保留真实 X6/proxy/save/hooks，当前隐藏按钮边界如上。

## 冻结记录与交付边界

最终前端：`d16531c8e5f0ebb066e3ff40116cb488fb01599f`，远端分支 `codex/fix-micro-app-build-frozen-20261007`，草稿 [PR #187](https://github.com/nuwax-ai/nuwax/pull/187)。message pin `f3a568275c0b3ed21537df98a7eedd6bdbf6b070`，repo pin `18ae973c890c699c678b086ad1da3b95275a3c86`。

对应最终前端产物已提交推送 `nuwax-dist` main 的 `cded09ab0fd93d2128bad42a3f4ba25d58e445c3`。stamp `d16531c8e`，989 文件，按 `release-provenance.mjs` 文件排序/摘要算法的 SHA256 tree `c1ce9bf5aa745f85ec2c22920f7a968fd69df3a0c6e51fbdeb79dbb11901eb4f`，独立包核验一致。客户端双 pin 固定在 `c46c9661bd542174903cde5602cbe518b42aaab9`。

首个候选 `3.0.8-qa.1`（前端 `bbebed854`、产物 `756de5ae`）和日志完整保留；后续 CI 类型门补修独立产生新候选，没有覆盖旧验收产物。

## 本地候选包

最终产物与日志保存在 `release/3.0.8-qa.2-20261007/`（本地忽略目录），应用为 `mac-arm64/Nuwax.app`。标准 pack 使用固定 helper 源码 `625118a9076e51da2f57b6a5d475972030197443` 加声明补丁；反向补丁检查确认无额外源码变更，合法重建当前商业图标的 helper。

包内 main/preload 与打包输入逐字节一致。Computer Use helper 的 ad-hoc strict 验证通过，图标等于当前商业图标；主应用与普通 Electron Helper 未做 Developer ID 分发签名，二进制仍有 linker ad-hoc、无资源封印，严格分发签名验证不通过。不能称整个应用完全没有任何签名字节，也不能称其已满足正式签名验收。

隔离运行夹具使用匹配的 Electron 40.8.2 加载实际包内主进程与资源，强制临时 home/appData/session 目录。空白账号下验证 host/guest 启动、API 路由、任意域 popup 共享会话、无异域业务桥/票据、原 guest 跨域返回与桥恢复、最终前端印记。它没有模拟注册/登录后端，不代替真实账号、安装器或正式签名的系统权限验收。

Beta 3.0.8 首轮预检重试后 `ok=true`，0 findings，随后创建 tag `prerelease-v3.0.8@0dd4330bac80f81eb05b91b5a368fe6ff5b0f3d8`。该次 [CI run 37599838681](https://github.com/nuwax-ai/nuwax-client/actions/runs/37599838681) 的商业/社区门通过，但前端初始化私有子模块失败，后续五平台构建和发布跳过。Release 查询为 404，run 安装资产为 0；不能将本次 beta 称为已发布。

现有 `YICHAMAO_GIT_TOKEN` Secret 名称存在，但 CI 步骤解析到的值为空。本机对两份私有 Git 源均可鉴权；当前前端确实依赖 `submodules/nuwax-im` 与 `submodules/nuwax-repo-web`，不能跳过它们或改成不存在的公开源。本地凭据转入 CI 属于新的凭据使用范围，需要明确授权。

补修会改变发布提交，已创建的 tag 仍保留原 SHA。发布入口 `scripts/client/release.mjs` 明确禁止将已有 tag 指向另一提交；该失败 tag 的删除与重建也需要明确授权。客户端草稿 [PR #12](https://github.com/nuwax-ai/nuwax-client/pull/12) 保留完整变更用于评审。

远端已使用 3.0.7，因此本次 beta 目标为 3.0.8，不能继续旧任务的 3.0.4。真实账号、Windows/Linux 设备、正式安装包签名/公证与远端全平台发布状态需要各自证据；本地源码与临时 profile 验收不代替这些环节。
