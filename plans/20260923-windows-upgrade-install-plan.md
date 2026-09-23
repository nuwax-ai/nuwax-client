# 实施计划：Windows 升级安装关闭应用进程树

- 对应 spec：`specs/windows-upgrade-install.md`
- 状态：已接受并已实施；Windows 安装包验收待完成

## 改动文件清单

| # | 文件 | 动作(增/改/删) | 说明 |
|---|---|---|---|
| 1 | `overlay/crates/agent-electron-client/build/installer.nsh` | 改 | 覆盖 NSIS `customCheckAppRunning`：优雅关闭、10 秒等待、进程树强制结束、手动兜底 |
| 2 | `plans/20260923-windows-upgrade-install-intent.md` | 增 | 记录用户问题与范围 |
| 3 | `specs/windows-upgrade-install.md` | 增 | 记录行为契约及场景验收 |
| 4 | `plans/20260923-windows-upgrade-install-plan.md` | 增 | 记录实施边界与验收状态 |

## 实施顺序

1. 只在 overlay 安装器文件接管进程关闭逻辑，保留当前仓库及 submodule 既有改动。
2. 检查宏与 electron-builder 25.1.8 模板的插入顺序及 per-user/per-machine 过滤行为。
3. 后续在 Windows 交互式桌面构建/安装包验证 W1-W6；没有真机证据前不宣称安装验收通过。

## 证明成立的测试

- 本轮未运行测试或构建。
- 待验收：Windows NSIS assisted 安装包覆盖安装及上述 W1-W6；需在已登录的 Windows 桌面会话验证。

## 风险与回退

| 风险 | 缓解 | 回退方式 |
|---|---|---|
| 权限高于安装器的进程无法被结束 | 保留重试/取消提示和手动关闭路径 | 回退 overlay 宏，由 electron-builder 默认检查接管 |
| 强制结束会中断未完成的会话任务 | 先请求正常退出并等待 10 秒，仅超时后强杀 | 回退 overlay 宏 |
| NSIS 宏编译或进程过滤语法与预期不符 | Windows 包构建和真实交互安装作为后续验收门 | 在 Windows 验收后再进入发布链 |

## 偏离记录

- 当前实现沿用 NSIS 原有权限模型，不增加 UAC 提权强杀；按本次接手时确定的范围执行。
