# Windows 应用内一键升级

- 状态：实现及当前用户真包验收完成；本地功能分支保存，未推送或发布。
- 验收证据：[Windows 一键升级验收](../docs/acceptance/20261016-windows-one-click-update.md)。

## 范围与约束

- 基座提供默认关闭的 `installAfterDownload` 策略；商业组合根仅对 Windows NSIS 启用，MSI、macOS、Linux 保持现有行为。
- 关于页、业务徽标、菜单和托盘共用主进程任务；点击后下载、校验、清理、安装并打开新版。并发操作复用任务，检查更新不得打断下载或安装，失败可重试。
- 共享桥增加 `installing` 状态和可选能力位，旧宿主缺省关闭；前端及商业桥快照已同步到 `3aa6484eb`。
- NSIS 更新沿用当前范围和目录，仅显示安装进度并自动关闭、启动新版；首次安装保留向导，必要的 Windows 授权仍保留。

## 集成与验证

- 基座中立实现与商业 overlay 分别提交；本地 `codex/windows-one-click-update` 用于保存完整依赖，发布线未推进。基座工作分支仍须经 PR 合入 main，再将产品发布线 pin 对齐 main。
- Windows QA 使用独立身份及目录完成 `.1` → `.3` 升级，原目录和用户文件保留；正式签名、全用户安装 UAC、生产 CDN 不属于这次验收范围。
- 原始事件、截图与产物来源保存在 `.cache/acceptance/windows-one-click-update/final/`；重复的 intent/spec 和绑定本轮版本的一次性验收驱动已清理。
- 回退时成对撤销基座依赖与商业策略，不改远端发布状态或现有安装。
