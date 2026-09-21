# macOS 全磁盘访问重启闭环修复计划

## 问题

开发态从客户端打开「完全磁盘访问权限」并开启 `Electron` 后，客户端没有提示重启。
现有实现要求授权前启动的 Electron 父进程派生的新子进程探针立刻由 denied 变为
granted，才弹重启提示；本机实测该条件在同一应用会话内不会成立。

## 目标

- 客户端打开 FDA 系统设置后，只有确认客户端窗口曾失焦、用户再返回客户端时，
  才弹一次重启提示。
- 当前已授权，或用户曾点过「暂不开启」，任何自动复查/返回设置旁路都不再提示。
- 不把返回系统设置等同于「已确认授权」，文案明确为「完成授权后需重启」。
- 保留探针用于启动后的实际访问结果检测；探针若能观察到翻转仍可提前提示。
- 「立即重启」在开发态和打包态都真实执行 `relaunch + exit`。

## 验证

- 单测覆盖：打开设置但未失焦不弹、失焦后返回即使探针仍 denied 也弹、每会话只弹
  一次、用户点过「暂不开启」后设置返回与探针翻转均不弹、打开设置失败不留下待处理
  状态、立即重启在 dev/package 均生效。
- 同步 overlay 后运行 `fullDiskAccess.test.ts`，再执行商业门禁相关检查。
- dev 实机验证：去开启 -> 系统设置 -> 返回客户端 -> 重启提示 -> 立即重启。

## 验证结果（2026-09-21）

- `fullDiskAccess.test.ts`：32/32 通过。
- `npm run test:commercial`：122 个测试文件通过、1 个跳过；1482 个测试通过、
  18 个跳过。
- `node scripts/sync-overlay.js --check`：40 个托管文件一致。
- dev 真机日志：`returned from settings after blocked state; prompting restart`，随后
  `restart dialog response=restart_now`；Electron 与 file-server 均由新 PID 重新拉起。
- `npm run check:pin` 仍被基座已有的 4 个非 overlay 改动阻断；本批未触碰这些文件。
- 当前 macOS FDA 列表只有一个 `Electron` 条目，但机器同时运行两个不同路径/版本
  的 Electron；Nuwax dev 重启后仍对 `~/Library/Mail` 返回 EPERM，需将当前 Nuwax
  dev 的精确 `Electron.app` 重新加入系统设置后再做最终权限真值验收。
