# Windows 安装成功后清理备份

## 2026-11-19 跟进 · 升级后回收保留目录

**状态：安装器改动已完成，待打 Beta 验收。** 本项覆盖当前安装目录旁本次升级和历史遗留的 `Nuwax-preserved-install-files-*`。

- [x] 核对 Beta.9 的实际清理结果。11 月 18 日 23:09，`win-dbg` 清完 52 份升级备份，包含最近一次，回收 87.76 GiB。次日仍有 50 个保留目录，递归统计普通文件约 32.64 GiB（含事务材料）。此前日志的 18.95 GiB 漏计了整目录转存的内容。
- [x] 核对最近一份。其主程序摘要与历史清单不同，另有五个资源文件未列入历史清单。这六个文件被移入同一份保留目录；50 个目录中有 15 个缺少旧载荷清单。
- [x] 安装和个人文件恢复成功后，后台核对保留目录对应的安装路径和事务状态。对确认的旧程序按摘要或已知的六条完整相对路径清理，保留归属不明的冲突副本及路径映射。占用文件短暂重试，仍失败时由后续成功安装接续处理。
- [x] 增加历史保留目录、文件占用重试、同名个人文件和其他安装隔离的回归场景。按约定由 Beta 验收实际清理结果。
- [ ] 升级后查看 `%TEMP%\Nuwax-installer-recovery-active-*-cleanup.log` 中的 `Preserved cleanup:`，对比升级前后的保留目录和递归文件字节数，核对最近一次升级是否留下旧程序。对仍保留的目录查看逐目录原因及 `transaction\manifest.jsonl`。

## 目标与边界

安装事务和个人文件恢复成功后，后台清理当前安装目录对应的全部已完成备份，包括最近一次和七天内备份。失败、未完成、另一安装目录及无法核验归属的事务不参与清理。扫描与删除不阻塞安装完成和应用启动。

历史摘要错误不能变成按文件名递归删除。按旧事务中可核验的内嵌清单，或本次安装器的内嵌清单，逐文件核对内容：确认的程序文件删除；未知或被修改的文件移动到同磁盘独立的保全目录，并保留原路径映射和事务材料，不覆盖现有文件。归属不明的文件不会因目录被清理而丢失。路径重解析、冲突、占用及中断均保留剩余现场，可重试。

卸载继续只消费当前卸载器内嵌的载荷清单；不依赖旧备份。默认卸载保留用户数据，失败保留重试入口，更新过程中和卸载中的 Reconcile 不触发成功清理。

## 实施

1. 将清理调度从 Restore 移至安装成功末尾；显式完成入口验证载荷、卸载器和恢复状态后启动自有后台进程。
2. 去掉最近一次/七天保留；对已完成历史事务逐文件清理，并保全不明内容与诊断映射。
3. 补 Windows 合成回归：最近及历史目录、旧摘要失配、缺失旧清单、嵌套用户文件、链接、其他安装、失败与恢复中断、后台让路和重试。
4. 验证清理后卸载及失败重试；自查后提交 PR 至 release/v3.2.0，不发布或合并。

## 验证记录

- Windows 11 build 26200 / Windows PowerShell 5.1：`scripts/test-installer-backup-retention.ps1` 33 项通过，使用随机 Temp 目录的合成文件；涵盖全部已完成备份（含最近一次）、旧摘要失配、缺失旧清单、空目录、锁定和重试、既有/悬空重解析路径、活动恢复及后台让路；持有清理锁时，安装成功调度仍可在 10 秒内返回，随后后台完成清理。证据根为 `nuwax-backup-retention-test-90f0d856bed84c4a9ec3120b6adfd50f`，没有操作实际用户数据。
- 本机：`node --test scripts/installer-completion.test.mjs scripts/installer-space.test.mjs scripts/uninstall-payload.test.mjs scripts/windows-installer-orchestration.test.mjs scripts/windows-update-signing.test.mjs`，27 项通过；包括固定 builder 25.1.8 / NSIS 3.0.4.1 的安装器和卸载器编译。
- Windows 原生、随机产品身份的无签名合成包：`scripts/test-installer-maintenance.ps1 -PackageRoot <QA包目录> -Scope CurrentUser -CleanupOnly` 已通过“清理最近一次备份”和“清理后卸载失败保留入口、解锁重试并保留个人文件”。最终源码快照（package-cleanup-final）重复通过；证据根 `nuwax-maintenance-fixture-7fa7a0aaca5b4bfaa8be93f1614e9e61`。
- 已把 33 项清理回归接入 CI 的 Windows desktop-platform job。集成全量由 PR CI 执行。

## 自查

- 内聚：删除资格、摘要核验、保全和后台让路均归 `build/installer-backup-retention.ps1`；原生文件变更在同文件内的 `NuwaxRecoveryRetentionIO.Prune`，不散落到应用或 renderer。
- 分层：安装成功编排仅在 `build/installer.nsh:598` 后调用 Complete；`build/normalize-old-install.ps1:418` 核对程序、卸载器和活动恢复后调度后台任务。正常卸载仍消费自己的内嵌清单。成功调度不获取恢复锁，后台进程用 ShellExecute 分离句柄并自行写日志，避免输出管道继承让 NSIS 等待清理结束。
- 维护性：用户/不明文件先保全再删程序文件；未知个人目录整树原子移动，不遍历或重建其内容，结构、目录属性与 ACL 有独立行为回归；路径、冲突、悬空链接和重试有行为回归。元数据收尾不在删除清单中途让路，清单最后移除，避免下一次无记录可续接。只读属性仅对已核验程序文件临时解除，不改 ACL。三问及 REVIEW.md 的数据边界检查通过。

## 验收边界与未通过的扩展尝试

- 此处是无签名合成包与源码行为验证；未发布版本，未把真实 Nuwax 安装或个人文件作为夹具，完整签名大包及交互 UAC 仍需安装包验收。
- 原维护全流程夹具的卷根目录拒绝断言未通过：合成包落到了默认 QA 目录，卷根未写入载荷；未把该全流程算作通过。新增 CleanupOnly 使用校验过的随机 QA 产品身份及默认目录，仅验证本次清理和卸载链路。
- 现有 `test-uninstall-data.ps1` 的 6,002 文件性能场景在此测试机触发 90 秒超时，未通过、未计入通过数；该卸载实现与该性能断言本轮均未修改。大载荷卸载性能不以本次小载荷定向结果代替。


## 与其他任务的分工

[排查 Windows 安装失败](codex://threads/01a1e32c-dd87-7950-8d8b-7beda0616f44) 负责默认用户安装目录/权限、Windows 版本兼容和 `LICENSE.electron.txt` 卸载失败。本 PR 只负责成功后的 `Nuwax-installer-recovery-*` 程序备份清理，不修改 `windows-per-user-install.nsh`、`windows-install-path.nsh`、`uninstall-data.ps1` 或卸载勾选删除历史的实现；`installer.nsh` 仅追加成功阶段调度。卸载链路的操作只作为清理不破坏卸载的定向回归。不重复签名、发布、更新指针或实际客户端包验收。

所有用户范围合成包安装曾在非交互运行中超过 120 秒等待上限，未计通过；停止继续扩展该路径排查，留给安装失败任务统一验收。该随机 QA 产品的程序、登记与进程已按其载荷摘要和 GUID 核验后清理，未操作实际产品。
