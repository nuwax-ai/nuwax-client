---
name: verify-nuwax-client
description: 验证 Nuwax 客户端开发工具链的 doctor 输出、CLI 参数、启动管理和资源缓存回归。用于这些脚本的验证与恢复；Electron 界面、安装包和真机验收需另选配方。
---

# Nuwax client tooling verification

在仓库根目录执行：

```sh
node scripts/sdlc-verify.mjs --root . --recipe .verification/client-tooling.json --output <仓外证据目录>
```

运行器依次预检 doctor 的输出结构、运行现有 CLI、启动管理和缓存回归测试，返回机器可读 JSON。退出码 0 且 `passed=true` 才表示本配方通过；每项 predicate 与日志保存在 `verification.json`。

doctor 的 `ready=false` 表示桌面运行环境尚未就绪。此配方只验证它是否准确提供结构化状态，不据此声称 Electron 可运行。资源构建在现有测试隔离 fixture 内验证；没有执行产品构建。

同一代码、工具链和证据仍有效时可加 `--reuse` 复用；输入或日志变化会重新执行。诊断失败应修复脚本或环境，不改变期望来放行。清理只处理本次测试创建的资源，证据留在指定目录。
