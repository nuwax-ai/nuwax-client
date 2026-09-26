# 客户端集成 Bug 开发与验证计划

- 范围：C4 #2428 语言、C5 #2427 菜单、C6 #2526 macOS 终端。
- 隔离：parent 951aa597；基座 pin 52bd898f；不修改共享工作区，不推送/发包/改禅道。
- 语言：迁移共享树已接受的 webview 单一语言源意图，核对启动、可信来源、持久化、i18next 更新与异步竞态；仅语言 WIP，票据与加载模式不带入。
- 菜单：验证现有 guest pointerdown 桥；补拖拽 spacer 菜单打开时无法产生 DOM 点击的路径。菜单打开期间 spacer 改 no-drag，首次点击关闭菜单，关闭后恢复原生拖拽；保持 guest 与窗口失焦收起。
- 终端：先核对当前 pin 的显式 cwd、session.cwd、三轨道与 UTF-8 locale；若发现确定缺口补修，已有代码不重复改。分别验证 cwd/中文。
- 验证：定向 vitest、overlay sync/check:pin、必要构建。真实 macOS GUI 能使用当前包则取证；安装包与 Windows 未覆盖必须单独标记。
- 交付：各 ticket 独立记录代码/测试/GUI/原场景证据，自己的改动独立 commit。
