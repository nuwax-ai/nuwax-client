# 客户端 iframe 加载兼容方案

- 状态：代码已实现，双轨质量门、真实 Electron 与已打包主入口隔离验证通过；原生安装、Windows 真机和真实账号验收待补。
- 范围：商业客户端 overlay，无新增前端接口或布局改造。

## 背景与已确认现象

- 2026-10-04 飞书「智能体平台研发组」罗东与冯飞讨论了域名映射、独立窗口、多网页视图以及客户端解除嵌入限制。
- `https://demo-x.yichamao.com/` 的 CSP `frame-ancestors` 不含 loopback；学院应用 `https://agent.nuwax.com/page/5814571981017088-33289485/prod/` 当前无 CSP/XFO 响应头限制。
- 当前 `/page` 未登记业务文档根，本机网关该路径与 `/home` 返回完全相同的主站 HTML。
- 用户明确选择可用性优先：全域默认生效，不做域名白名单或设置开关，保留现有并排 iframe。

## 实施

1. 商业客户端所有 HTTP/HTTPS 文档响应删除 X-Frame-Options，并从 CSP/Report-Only 的全部策略中删除 frame-ancestors；保留其他指令及完整 Cookie 响应头。
2. 默认 Session 与后续临时 Session 使用统一的响应头策略。每 Session 只注册一个 listener，与既有开发 CORS 修复合并；只有实际修改才回写响应头。
3. `/page` 纳入后端文档根，顶层与 iframe 都代理上游，根相对资源正确归上游；现有 `/repo`、`/instant-message` 顶层主站路由保持本地 SPA。
4. 商业代码仅落 overlay，使用隔离副本执行质量门，保留当前基座和前端的无关工作区改动。

## 验证

- 单元测试：大小写、多头、逗号 CSP、默认/临时 Session、单 listener、CORS 合并、未改动不回写；页面与相对资源路由。
- 真实 Electron 临时 profile：XFO/CSP、重定向、多层 iframe、默认和隔离 Session；同一改写响应多个 Cookie、ticket 登录/轮换/登出与跨进程持久化。
- 真实线上页面只读验收：demo 与学院应用加载、资源、刷新；源代码夹具结果与安装包结果分别记录。
- 在隔离副本运行商业质量门与社区回归，构建商业客户端；macOS 包和 Windows 包须各有实际运行证据，缺失时明确记录。

## 边界

客户端内网站的防嵌入响应头保护将失效，这是本次明确选择。该方案不保证解决网站脚本主动阻止嵌入、登录策略或其他浏览器能力限制；不通过取消其他 CSP 指令或扩大业务凭据范围来隐式处理它们。

## 验收记录

见 [验收记录](../docs/acceptance/20261004-iframe-embedding-compat.md)。社区 1534 项、商业 2138 项、独立相关检查 94 项通过；真实 Electron 验证 Cookie 跨进程恢复和两个线上页面，学院通过 loopback `/page` 的 iframe、顶层与刷新均成功。已生成 `3.0.7-iframe.1` macOS arm64 无签名包，并通过包内生产入口和实际 webview 的隔离 QA。完整类型检查发现未改动基座的 `autoUpdater.ts:224` 已有空值错误，QA 退出另记录既有 hostActivity 窗口销毁异常；原生安装、Windows 真机和真实账号认证验收尚未覆盖。
