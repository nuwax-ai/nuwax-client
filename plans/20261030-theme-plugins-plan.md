# 实施计划：第三方主题与暗黑模式

- 状态：代码实施完成；源码与组件门禁通过；客户端出包验收未完成（4/4 次停止）
- 基线：09bb9191；worktree theme-plugins，分支 codex/theme-plugins
- 对应规格：specs/theme-plugins.md

## 批次

- [x] 主题核心：公开格式、官方明暗、示例、校验器；53 个核心测试及模板生成/校验通过。
- [x] Web：IndexedDB 安装事务、主题运行时、外观设置、历史迁移。
- [x] 桌面：同步核心、受信 themes 桥、安装/关联目录/监听、壳跟随与启动恢复。
- [x] 界面：主站独立主题组件，message/repo overlay 样式复写；不改上游子模块。
- [ ] 集成：自动化、微应用生产构建、test:commercial、真实浏览器主题组件与 macOS 文件监听已通过；完整真实客户端及跨平台验收未完成。详见 docs/verification/theme-plugins-20261030.md。

## 执行与回退

使用已安装 nuwax-devkit：短 brief、明确文件归属与预算，doctor → prepare → run → reconcile；主控审查和集成。每个包原子验证，错误保留最近有效配置。恢复默认可绕过自定义 CSS。数据持久层故障不可把失败安装写成成功。

## 用户补充

2026-11-04 最新 PC Web 再同步：两端 feat-2026.11 同为 cf403d24c4，前端合并为 0c90339f8b。保留原主题工作与发布排除项，仅补新版资料引导需要的主题变量别名；原 PC Web 独立调试与客户端 Cookie 开发兼容编排均不改。

2026-11-04 视觉兼容回归：以真实开发客户端复现为准，主控负责主题 base.less、共享中性色适配、message/repo overlay 和壳工具栏；不改上游子模块或独立开发/登录配置。验收主页、系统概览、表格/表单/弹层、消息气泡/工具栏及资料库导航/列表，覆盖明暗切换且不重建业务文档。Devkit 只读审查按 doctor → prepare → run → reconcile 执行；16k 预算门停止，不重试、不计为成功。源码门禁与真实页面验证分别记录，安装包仍维持 4/4 停止。

2026-11-04 开发兼容修复：仅修改客户端启动脚本和壳，不修改 PC Web 的独立开发逻辑，不修改 agent-platform。`dev --frontend source` 调用已有 `build:prod`，将构建移入客户端临时缓存并恢复原 `nuwax/dist`；客户端通过同源 loopback 消费本地生产资源，使用既有 Cookie 会话。移除客户端对 UMI dev server 的自动启动与 localhost 页面覆盖。验证启动编排、目录恢复、会话与网关回归、真实 Electron 和测试环境登录；不重新启动安装包验收。

2026-10-30：im-web/repo 子模块仅走 overlay/样式复写，不侵入原码。所有验证、安装与改动在本 worktree；不推送、不发布，验收包沿用既有基线且同一问题至多四次。

Devkit 当前适配器的两项 reserved openai provider 参数不兼容 Codex 0.165；仓外任务级兼容入口仅过滤这两项，保留 fresh exec / sandbox / JSON / 不加载用户规则。首批执行因其 token 预算门停止，未记为执行成功或零实耗；源码由主控修正并独立验证。
