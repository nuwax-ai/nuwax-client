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

2026-10-30：im-web/repo 子模块仅走 overlay/样式复写，不侵入原码。所有验证、安装与改动在本 worktree；不推送、不发布，验收包沿用既有基线且同一问题至多四次。

Devkit 当前适配器的两项 reserved openai provider 参数不兼容 Codex 0.165；仓外任务级兼容入口仅过滤这两项，保留 fresh exec / sandbox / JSON / 不加载用户规则。首批执行因其 token 预算门停止，未记为执行成功或零实耗；源码由主控修正并独立验证。
