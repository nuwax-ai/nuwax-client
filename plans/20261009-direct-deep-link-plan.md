# 客户端 direct 模式深链兼容

- 状态：客户端实现及本机验证完成；跨平台真实安装验收待完成。
- 范围：商业 overlay；不修改业务站点配置、前端源码或 submodule pin。
- 用户补充边界：仅主窗口内 webview 当前页；新开窗口、独立窗口和 iframe 均不纳入。

## 实施

1. 商业主进程在首个窗口创建前安装唯一 onBeforeRequest 分发器；loopback 只更新其归一配置。
2. 通过 hostWebContents 校验主窗口归属；只将主 webview 的 direct 受信顶层 GET 微应用页面改为同域 /home，通过私有 fragment 携带原始业务路径。
3. 轻量 preload 仅在主窗口 guest 私有启动参数存在时，在主站脚本运行前验证并 replaceState 恢复路径；不增加公开桥接口或历史条目。
4. 排除新开/独立窗口、其他窗口 webview、iframe、API/WS/静态资源、POST、第三方源和社区宿主；记录完整导航 URL 保留 hash。

## 验证

- 路由策略、preload 及监听器生命周期单测；现有 gateway 回归。
- 真实 Electron 隔离夹具：旧独立 HTML、主站初始化、主 webview 刷新、历史、查询/hash、登录回跳；验证新开/独立窗口、iframe 及其他排除路径保持原行为。
- 商业质量门、主进程/preload 构建和本机包验收；Windows 安装验收需可用 Windows 主机。

## 风险与回退

- /home 必须提供包含微应用路由的主站 HTML；加载失败沿用既有失败界面，禁止自动退回旧独立页面。
- 恢复必须发生在 Umi 创建 history 前；真实 Electron 首脚本/路由初始化断言作为门。
- 回退本批 overlay 和私有恢复协议即可；不改变 direct 默认值和登录凭据策略。

## 完成记录

- 商业质量门：2,381 项通过、18 跳过；180 个测试文件通过、1 跳过。
- Electron 40.8.2 macOS ARM64 真实夹具通过 18 组检查，包内生产 preload 也通过。
- macOS ARM64 无签名本地 `.app` 已生成；base / 前端 / dist pins 未改变，尚未发布。
- 完整主进程 TypeScript 检查仅余既有 autoUpdater.ts:224 TS18047。
- Windows 主机及真实生产账号验收未完成；详细证据、复验命令和边界见 [验收记录](../docs/acceptance/20261009-direct-deep-link.md)。
