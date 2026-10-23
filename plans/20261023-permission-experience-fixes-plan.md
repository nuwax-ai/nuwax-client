# 权限体验生命周期修复

承接用户要求的客户端与 Computer Use 权限体验审查，修复可确定的生命周期缺口；保持默认关闭、商业登录门禁和现有产品边界。

- [x] 首次授权页关闭后卸载组件，停止轮询。
- [x] 拖拽授权卡片归属主窗口，随隐藏、最小化、关闭同步；退出释放，异步加载不能复活，显示不抢系统设置焦点。
- [x] 正常 daemon 启动禁用原生权限 gate；仍在注入 MCP 前静默验证权限，只有明确继续启用才请求授权。
- [x] 权限请求 single-flight，绑定当前代次、独立结果文件与宿主命令；取消、禁用、会话失效、退出及时撤销，20 秒有界等待，精确回收本次宿主，迟到结果不能更改状态。
- [x] 总览区分 helper 已安装与启用意图；关闭状态不显示为必需项、不提供不可执行的 helper 操作；单项导航只开对应系统面板。
- [x] 运行对应权限与 Computer Use 回归；真机弹窗、系统设置拖拽与退出验收由主代理在指定 mac-dbg / win-dbg 执行。

协作边界：本任务不修改 Computer Use index、预览/托盘中心、locales 或 preload；这些接线交由主代理。源文件以 overlay 为事实源，不运行会清除 overlay 的社区测试，不提交。

验证：初次 5 个测试文件 87 项通过；补充退出取消后 request ownership 5 项通过（44 项未重复），权限/IPC/polling 7 文件 56 项通过。合计覆盖 Computer Use 49 项与权限相关 57 项（最后补充 hide 打断未完成 enable 探测，onboarding 18 项通过）。ESLint 0 问题，主进程 TypeScript 仅原有 8 项错误，本次权限文件没有新增错误。日志保存在 /Users/apple/Documents/Codex/2026-10-22/computer-use-consolidation-01a162b4/permission-fixes-20261023/。需由主代理继续指定真机验收，不将 mock 结果当作系统权限弹窗或真实拖拽验收。

待主代理接手的原生补强：LaunchServices 派生可迟于 JS 的一次 exact pkill。上游 cli.rs 的权限宿主当前在请求完成后才打开 result-file，建议商业 native patch 将 O_NOFOLLOW 打开、当前用户私有普通文件校验移到请求前，持有句柄用于写回。JS 取消已先 unlink 再回收进程；原生补强前不能把极早取消视为封闭证明。
