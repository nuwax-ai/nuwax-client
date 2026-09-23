# 规格：Windows 升级安装关闭 Nuwax 进程树

- 日期：2026-09-23；对应 intent：`plans/20260923-windows-upgrade-install-intent.md`。
- 状态：已按用户接手指令授权实施；安装包与真实 Windows 验收待记录。

## 1. 现状与原因

截图显示 electron-builder 25.1.8 的 NSIS assisted 安装器报 `appCannotBeClosed`。默认 `CHECK_APP_RUNNING` 主要按应用映像名关闭进程，短重试后仍发现 `Nuwax.exe` 就提示用户手动关闭。Electron 应用还会启动子进程；主进程关闭链运行较慢或子进程仍存活时，安装目录可能继续被占用。

## 2. 行为契约

1. 手动安装且检测到应用运行时，保留 NSIS 原有 `appRunning` 提示；应用内更新保持静默关闭行为。
2. 先请求关闭 `Nuwax.exe` 及其子进程，并等待最多 10 秒，给应用的有序退出清理留出时间。
3. 仍在运行时，最多三次强制结束 Nuwax 进程树并复查。
4. 仍无法结束（例如应用以更高权限运行）时，保留 `appCannotBeClosed` 的重试/取消提示；不自动请求 UAC。
5. per-user 安装的关闭命令只匹配当前用户名，并排除安装器自身 PID；per-machine 分支沿用 electron-builder 的全用户进程查询语义。

## 3. 范围

- 改动：外层仓库 `overlay/crates/agent-electron-client/build/installer.nsh`。
- 不改：基座 submodule、前端、应用服务生命周期、NSIS 安装类型与 UAC 策略。

## 4. 验收

| 编号 | 场景 | 预期 |
|---|---|---|
| W1 | 应用已退出 | 安装器继续安装 |
| W2 | 普通权限应用运行、手动启动安装 | 保留运行提示，应用退出后安装继续 |
| W3 | 普通权限应用处于更新/清理退出阶段 | 安装器最多等待 10 秒后检查状态，不因短暂清理延迟立即失败 |
| W4 | 普通权限应用不响应 | 安装器强制结束应用及子进程树后继续 |
| W5 | 应用以更高权限运行或重试仍杀不掉 | 显示手动关闭提示；Retry 重试，Cancel 退出安装 |
| W6 | 其他 Windows 用户也运行 Nuwax（per-user 安装） | 不结束其他用户的应用进程 |

自动构建检查与交互式 Windows 安装包验收分别记录；当前代码修改本身不等于 Windows 安装验收通过。
