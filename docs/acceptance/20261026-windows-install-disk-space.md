# Windows 安装磁盘空间预检专项验证（2026-10-26）

实现基线：`release/v3.0.23` / `e8a69795`。用户要求将空间预检作为独立防护，不依赖本次外部用户故障是否最终确认为磁盘不足。

## 已实现

- 商业 NSIS 安装：首装、升级及修复均在原有关闭应用/Prepare/旧版卸载前检查；静默和提升后的实际执行路径仍调用同一前置检查。
- 目标盘展开大小来自固定 builder 25.1.8 的 `APP_*_UNPACKED_SIZE`（KiB）。临时归档按当前完整 EXE 大小保守预算，更新缓存按完整 EXE 大小计；7z QA 另计临时展开。已下载原 EXE 不重复计，旧版/旧缓存/备份不预先抵扣。
- 通过原生 API 获取真实卷身份和当前用户可用空间，按卷合并后加 max(5%, 256 MiB) 余量，64 位比较。此为预算而非实际空间预留，对非常大的文件簇/其他进程同时写盘不保证足够。
- 交互不足页列出卷、用途、需要、可用、缺口；可重新检查或返回目录。实际执行前再检查；静默失败 exit 2。查询失败和不足分开报告，不把通用解压错误都改为磁盘不足。
- 小的正缺口向上显示为至少 0.01 GiB，避免“缺少 0.00”却不能继续；执行前失败弹窗明确取消会结束本次安装。
- helper 查询有 30 秒无输出超时；失败诊断尽力追加到 `%TEMP%\Nuwax-installer-space.log`，写日志失败不会使预检放行。
- Beta Windows 构建在已有 recovery fixture 步骤追加原生空间 helper 测试；Stable Windows 构建在商业依赖安装后、资源准备前运行同一脚本。两处均显式使用 Windows PowerShell 5.1 并检查退出码。

## 已通过的验证

1. **独立相关 Node 回归：39 项通过，0 失败、0 跳过。** 覆盖 installer-space（3 项）、installer-archive-policy、uninstall-payload、system-app-name、release-workflows、release-stable。格式/提示最终改动后，新增 3 项和 workflow 6 项再次通过，复跑不重复计数。
2. **Windows PowerShell 5.1 原生夹具：9 项通过。** 同卷合并、分卷临时/缓存、精确边界及差 1 字节（含不显示零缺口）、超过 4 GiB、查询失败/溢出、真实卷及尚未创建的目标、真实 helper 入口成功/不足/不可用盘。新目标不因检查而创建。
3. **合成 NSIS 原生夹具：4 项通过。** good 静默 exit 0 且后续 marker 存在；low 和 invalid 静默均 exit 2 且 shutdown/Prepare/uninstall 三类 marker 均不存在。随机产品名，只有自建 TEMP 目录，不运行生产应用或修改生产注册表。
4. **真实交互页。** 在既有已登录测试账户中，以唯一临时计划任务 InteractiveToken + Limited 运行同一随机夹具。预算文本可见、Next 禁用、空间仍不足时重查不能绕过、Back 返回目录并再次确认触发重新检查已验证；实际账户/权限未改变。正常 SSH 非交互桌面不能枚举 GUI，该结果未被记成通过。
5. **编译与静态检查。** 固定 electron-builder/app-builder-lib 25.1.8 的完整 vendor installer/uninstaller 两阶段实际编译通过（不执行生成的 uninstaller）；NSIS 3.0.4.1 对 ZIP/7z、x64/ARM64 组合和完整空间页宏编译通过。`git diff --check`、新增 CJS 语法检查通过。

测试入口：

```sh
node --test scripts/installer-space.test.mjs
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test-installer-space.ps1
```

合成运行器先用 `scripts/acceptance/windows-installer-space.cjs` 指定全新输出目录和固定 NSIS SDK 生成随机产物；只在隔离 TEMP 目录运行 `scripts/test-installer-space-ui.ps1 -FixtureDir <目录>`。不足用超大预算对真实卷做比较触发，没有填满测试机 C 盘。

## 尚未验证

- 真实全载荷安装包在受限容量磁盘上的首装、升级及修复。
- 实际产品普通用户 / UAC 内外层与自动更新完整路径；本轮覆盖源码顺序和编译，原生运行使用随机合成产品。
- 清理空间后重查成功并继续的实际磁盘容量变化、安装中途被其他进程耗尽空间。
- base:test / test:commercial 全应用双轨，本轮仅安装域专项检查，不触发共享 overlay 清理。

没有创建版本、tag、发布物、推送、合并或更新公开指针；不迁移 TEMP/缓存，不删除用户文件或恢复备份。

清理核验：测试机临时计划任务和自建 fixture 目录已移除，所属运行进程为零；未改生产应用/注册表。标准临时诊断日志保留，不清理其他用户文件。

## 随 3.0.22 集成前代码自查

用户最新决定：停止独立完整包/VHD/UAC/自动更新专项验收，先完善代码，合入现有 `fix/stable-3.0.22` 后随该版本整体验收。此前未验项目继续如实保留，不作为本次代码集成的额外审批门槛；外部用户这次故障的具体根因仍未确认。本专项不切换或修改集成目标分支。

按根 `REVIEW.md` 五遍自查，结论：**没有发现新的安装逻辑缺陷；补齐 Stable 发布渠道空间夹具门禁后，供父任务集成。** 这是实现者自查，不是 PR 自批。

| 检查遍 | 本轮核对及证据 |
| --- | --- |
| 逻辑与边界 | `installer.nsh` 的 `customCheckAppRunning` 在 `nuwaxFindAppProcess`、关闭进程、Prepare 前插入预检。vendor `installSection.nsh` 随后才调用旧版卸载；提升的 inner 在 `customInit` 明确设为 all-users 后调用同一检查。首装、升级、修复不依赖“已有旧路径才检查”的条件。预算使用 decimal 累加及 64 位最终值，同卷合并后加余量，不抵扣待删除文件；原生 1 字节、超 4 GiB、同/异卷夹具已覆盖。 |
| 安全与身份 | helper 只读目标/卷信息，不创建安装目录或删除用户数据。缓存路径与固定 SDK `include/installer.nsh` 的 `SetShellVarContext current` + `$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}` 一致，完成后恢复 all-users shell context；临时卷来自实际进程 `$PLUGINSDIR`。未知架构/缺失元数据、查询失败、报告缺失或超时均不会放行。未新增特权、环境变量/命令行绕过入口或修改公开更新源。实际过肩 UAC 行为仍由整体验收验证。 |
| 范围与契约 | 只补安装前预算及交互，不迁移 TEMP/缓存、不改卸载恢复数据规则、压缩格式或更新器协议。目录页按当前最终目录规整；重查后 Next 依据新结果启停，Leave 和执行前均再查；既有原生 GUI 证明 Back 返回及再次确认不能绕过。空间不足和路径/查询失败保持不同报告，未替换通用解压错误或确认本次用户根因。 |
| 分层与维护 | 商业逻辑只在 overlay；预算/格式/卷查询位于独立 PS helper，NSIS 负责架构、范围和 UI 组合。函数在 customHeader 发出，避免 vendor 架构宏/范围变量尚未声明；BUILD_UNINSTALLER 不嵌入安装空间代码。helper 通过 NSIS `File` 从 BUILD_RESOURCES_DIR 内嵌，不依赖安装后程序或网络。 |
| 测试与证据 | 保留 ef3cf7e1 的失败测试先行、87e02cd1 的实现与前述 39/9/4 结果；完整固定 SDK installer/uninstaller 编译已通过。本次补查发现 Stable workflow 缺少同一空间 fixture gate，先补发布渠道断言并观察失败，再补工作流；`release-workflows` 与 `release-stable` 本轮 7 项全绿、0 跳过（较原有 39 项新增 1 个独立门禁用例）。NSIS/PS 安装逻辑未变，未启动新 GUI/完整包验收。`git diff --check` 再次通过；原有未验项随 3.0.22 一起验收。 |

停止独立验收时只进行了本地 UTM 状态和设备硬件只读查询，没有恢复/操作虚拟机、创建 VHD/账号/新任务或启动新验收进程，无本轮新增远端资源需清理。
