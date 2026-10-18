# Windows 卸载数据保全与安全项

依据：罗东 2026-10-18 授权先修 U1，再处理导航、openExternal、agentRunner；卸载增加删除本地数据选项，默认不勾选。均从 7503d15c 开独立 worktree，只在 nuwax-client 本地提交，不发布或改主工作区。

## U1（codex/windows-uninstall-data）

- 卸载按构建时程序文件清单删除，不再递归删除整个安装目录。清单嵌入卸载器，不信任安装目录内可被改写的清单。
- 独立卸载时，安装目录中的未知文件、工作区保留原位置，外部项目不删除；默认保留全部应用数据。
- 交互卸载提供默认未勾选的“同时删除当前 Windows 用户的本地数据（不可恢复）”，明确列出应用管理的配置/会话/内置工作区、Electron 数据和更新缓存范围。不遍历其他 Windows 账号。
- 静默卸载和升级不删除本地数据；拒绝 vendor 的 --delete-app-data 旁路，升级沿用已有备份/恢复链路。
- 删除不跟随 junction/symlink；路径校验、占用、权限失败保留卸载登记和卸载器供重试。已知程序文件内用户追加的未知文件同样保留。
- UTM 使用独立 QA 身份、数据名和安装目录，只对本轮生成的文件进行勾选/不勾选/静默/升级/失败重试验收。原 beta.5 QA 副本、Mac 日常数据、已安装应用和系统权限不动。

## 后续独立任务

1. 宿主主窗口导航来源校验：保留受信业务页、登录和下载行为。
2. openExternal：主进程统一校验协议及调用来源，不以 renderer 过滤代替。
3. agentRunner：去掉 shell，移出 argv 的 API Key；先确认 runner 支持的输入通道，商业实现放 overlay，不提交基座仓。

每项按 REVIEW.md 核对一次、运行对应测试，再用 UTM 隔离候选验证；将提交号、实测与未覆盖场景更新到现有交接回执。权限引导、Computer Use 决策、暂停项、发布和清理约束不变。

## 2026-10-18 验证与环境状态

- U1 第一候选包：真实 NSIS GUI 的取消、默认不勾选、勾选删除均已通过；安装目录内未知工作区、resources 内额外文件及外部文件保留。第二候选补充安装/数据路径重叠保护，Windows 脚本 8 项通过。
- 同版本升级保留了三处本地数据及顶层未知工作区；另发现既有 normalizer 将 resources 内未知文件留在恢复备份而不原位恢复。此升级缺口单列，不宣称修好。
- C 盘从 3.06 GiB 增至 9.53 GiB：本轮 payload、安装包和恢复副本迁至 D:\nuwax-qa\u1-20261018-offload，63,046 文件逐一 SHA-256 校验后移走 C 盘副本。安装、注册表和分区未改。
- 空间迁移完成之后，UTM 进入固件 Synchronous Exception 画面，SSH/RDP 均断开。已询问罗东是否正在手动操作，以避免并发重启；在回复前不操作 VM 电源。余下静默/失败重试和安全项真机验证待环境恢复。
- agentRunner 已确认是未挂载商业 UI 的旧自定义二进制入口，本仓不交付其内核、没有已知安全凭据输入契约。处理方式改为在 preload 与主进程同时拒绝旧启动，而非猜测环境变量/stdin 支持；内置 ACP 引擎维持既有实现。

## 2026-10-18 组合包验收（codex/windows-data-security-integration）

- 从 `7503d15c` 新建 `/Users/apple/workspace/nuwax-client-windows-integration`，cherry-pick U1、宿主导航、openExternal、旧 runner 入口封闭及升级嵌套文件恢复，保留原分支。246 项相关 Vitest 与 8 项安装清单/更新配置脚本通过；主进程、preload、宿主 renderer 已从组合源码重新构建。
- QA 包复用原 Windows x64 依赖/资源，替换为本 worktree 生产构建的 main/preload/renderer。只增加 QA 入口以隔离 profile 与端口；原商业标识和实际 handler 保持，数据通过专属 QA 目录链接映射至 NSIS 展示的 QA 数据路径。所有 profile 环境覆盖仅限 QA 进程，未调整系统环境/权限。
- 矩阵：旧 QA 完整包首次安装与运行/安全 handler；应用内从本机回环 feed 下载新包并自动重启；默认不勾选卸载及取消；重装目标包后勾选删除；未知顶层/嵌套文件、实际 QA 配置与新程序完整性；勾选删除本地数据后的卸载；占用/静默重试及 Windows 脚本边界。每个子项以实际产物 SHA 和观测结果记入验收 JSON，不用脚本夹具冒充完整包结果。
- 纠错记录：首次 cherry-pick 误在主工作区执行，已立即报告并保存 `codex/windows-integration-safety-copy=e9acf294`。罗东明确批准仅为纠错执行一次 `git reset --keep 7503d15c`；恢复前确认无 tracked WIP，恢复后主工作区及原未跟踪项与起点一致。后续所有集成操作只在新 worktree，原保护/不推送/不发布约束不变。

- QA 工具修复：首次自制包中的 ASAR 因库返回 writable stream 后同步封包而为空，已等待 `finished(stream)`、读取版本和逐字比对 main 后再封包。空包及手工替换归档的启动诊断仅算排错，未计为最终包验收。候选启动期间曾记录 NSIS `System.dll` 的 `0xc0000005`，继续核对最终包的真实运行结果，不用重建成功替代实机结果。
