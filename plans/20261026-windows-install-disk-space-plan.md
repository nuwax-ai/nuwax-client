# Windows 安装磁盘空间预检

- 分级：安装域中等需求，仅此计划；用户已明确要求实施，不依赖原故障归因。
- 基线：`origin/release/v3.0.23` / `e8a69795`；商业 overlay，独立工作树。
- 状态：代码走查和完善完成，已集成到 `fix/stable-3.0.22`；合入后安装/发布域 40 项检查全绿，真实完整包验收随该版本统一进行。
- 最新集成决定：按用户要求先合入现有 `fix/stable-3.0.22`，完整包低空间/UAC/自动更新随 3.0.22 一起验收；停止独立扩展验收。代码五遍自查见既有验收文档，无新增阻塞性缺陷，不额外生成工件。

## 范围与模型

- 首装、升级、修复，以及静默/UAC 内层安装，在旧版停止/保全/卸载和大载荷解压前检查。
- 使用 builder 各架构 `APP_*_UNPACKED_SIZE`（KiB）；当前 EXE 实际长度用于安装器缓存和临时归档的保守上界（不重复计已下载原 EXE）。7z QA 额外计临时展开。
- 按 Windows 实际卷身份合并安装、临时、缓存需求；每卷加 5% 或至少 256 MiB 的余量。保留旧版/旧缓存，不抵扣预计删除的空间。
- 此为预检预算，不是空间预留或安装必成保证；散文件簇开销和并发占用仍可能变化，开始安装前重新检查。
- 空间不足列出卷、所需/可用/缺口；交互可返回目录页和清理后重查；静默以非零退出。路径/卷查询失败单独说明，不能冒充空间不足。
- 不修改全局 TEMP、缓存位置、用户数据/恢复备份或自动更新协议；不将通用解压错误改为空间不足。

## 改动

1. `build/installer-space.ps1`：64 位预算、Windows 卷查询、结果文本，逻辑与原生查询分开以便夹具覆盖。
2. `build/windows-install-space.nsh` 与 `build/installer.nsh`：最终范围下预检；目录选择后错误页与执行前重查。
3. `scripts/test-installer-space.ps1`：同/异卷、边界、64 位、查询失败、真实卷检查，均在临时目录。
4. `scripts/installer-space.test.mjs`：真实 NSIS 预处理/编译和时序集成检查。
5. `scripts/acceptance/windows-installer-space.cjs`、`scripts/test-installer-space-ui.ps1`：随机身份的原生静默/交互 NSIS 验证；Windows 构建现有夹具步骤增加空间 helper gate。
6. Stable/Beta 两条发布 workflow 均运行同一 Windows PowerShell 5.1 空间 helper gate；`scripts/release-workflows.test.mjs` 固定两条渠道的条件、退出码和资源准备前执行时机。

## 验证

- 先提交失败测试，再实现。
- Windows PowerShell 5.1 原生夹具（不运行生产安装器、不写生产注册表）；NSIS 合成脚本使用实际 3.0.4.1 SDK 编译。
- 相关安装脚本/归档回归；不在共享检出运行会清 overlay 的 base:test。
- 真实全载荷低空间安装、普通用户/UAC UI 操作及安装途中耗尽空间若未验证，明确保留验收项，不计完成。
- 结果见 `docs/acceptance/20261026-windows-install-disk-space.md`：独立相关回归 39 项、Windows PowerShell 原生 9 项、合成 NSIS 静默/交互 4 项通过；不使用这些结果代替全载荷和 UAC 验收。

## 实现补充

- 不新增归档大小生成 hook；完整 EXE 长度为内嵌归档的保守上界，随包自动变化。
- helper 使用 UTF-8 BOM（兼容 Windows PowerShell 5.1），报告用 UTF-16 供 NSIS 直接读取；正缺口显示向上取整到 0.01 GiB，避免拦截时显示缺少零空间。
- 空间页读取 SDK 最终目录规整结果；失败可返回目录，下一次进入重新检查，安装执行前再次检查。NSIS 阶段必须延迟到 customHeader 才发出 helper 函数，以保证 vendor 架构宏和 installMode 已声明。
- GUI 夹具首次使用 GetWindowText 跨进程读取 Edit 得到假阴性；改为检查所属 PID 后使用有超时的 WM_GETTEXT。生产 PageLeave 逻辑未为测试放宽。
- 3.0.22 集成前补查发现最初仅 Beta 存在空间夹具 gate；用 4978c925 先提交失败断言，再补 Stable 同脚本入口。此次不改安装运行逻辑，发布域针对性测试 7 项通过。

## 回退

删除空间预检 include/hook 与新增 helper 即可回退；不修改安装格式、pin 或已有恢复逻辑。
