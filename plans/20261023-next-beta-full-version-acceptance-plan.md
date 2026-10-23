# 下一 Beta 完整版本问题整合与验收计划

用户要求：整合 mac-dbg / win-dbg Beta.4 问题与上一轮真机遗留，并覆盖 Computer Use 以外的需求、Bug 与优化。本文是计划/证据索引，不是新版本通过的证明。本次没有执行产品测试、构建、安装或 GUI。

## 工作分支统一（后续更新）

用户进一步要求统一开发入口。`fix/stable-3.0.22`已快进合入完整Computer Use集成源码及`9ee2bfe9`设置留白修复；后续开发和下一Beta均从本仓该分支继续。原文下述`dc055d7`和两文件WIP状态是编制时快照；两文件现已提交，但尚未进入新安装包。打包性能仍未验证。归并质量检查与范围见[归并记录](../docs/acceptance/20261023-stable-3.0.22-consolidation.md)。

## 基线

- 已发布 Beta4：`v3.0.22-beta.4@413ba206261e2d03adfc7357cc89f7268958ad2b`；对比基线 `v3.0.21`，223 个变化文件。
- 集成线观测HEAD：`dc055d7ef4af5fb937b691e5c31299b857f29d34`，已含 `55ead7a` 打包优化与 `badd804` 文档；这些不在Beta4正式包。
- base / frontend / dist 三pin在上述两个tag相同；业务变化主要在商业overlay及外层。两文件设置布局WIP尚待入包。打包优化虽已合入源码，按用户要求未验证，仅用户下次Beta构建观察。

## 交付清单

完整材料：[下一 Beta 验收入口](/Users/apple/Documents/Codex/2026-10-23/computer-use-ui-r5-01a162b4/next-beta-acceptance/README.md)。

- [20条问题/遗留](/Users/apple/Documents/Codex/2026-10-23/computer-use-ui-r5-01a162b4/next-beta-acceptance/issue-register.md)。
- [20组版本范围](/Users/apple/Documents/Codex/2026-10-23/computer-use-ui-r5-01a162b4/next-beta-acceptance/version-change-catalog.md)、[74条用例](/Users/apple/Documents/Codex/2026-10-23/computer-use-ui-r5-01a162b4/next-beta-acceptance/acceptance-matrix.md)、[机器索引](/Users/apple/Documents/Codex/2026-10-23/computer-use-ui-r5-01a162b4/next-beta-acceptance/acceptance-index.json)。
- [历史修复/重测证据账](/Users/apple/Documents/Codex/2026-10-23/computer-use-ui-r5-01a162b4/next-beta-acceptance/history-and-evidence.md)；旧原始目录缺失明确保留为来源缺口。

## 最小处理批次

1. 设置卡底部留白修复入包（NB-001）；更新退出阶段化/超时/重入通用加强（NB-003），保留旧版正常退出与正式DMG覆盖恢复路线。本机已恢复Beta4，但最终退出源未知，不能据最终安装成功宣称共性风险已解决。
2. Windows首轮工具误选（NB-002）收敛查证；旧安装目录消失、残留登记且无/D入口exit2（NB-004）复现，明确修复/安全恢复结论；干净复测或已知说明不能算代码修复。
3. B0矩阵包含双平台原生任务/必要预览交互/安全撤权、真实旧版本升级退出、首次授权，以及实际变更的非CUA主路径；B1补8小时长稳、多屏/物理输入、并发、复杂安装/终端异常；B2列匹配平台资源缺口。B0用例按短版导航合并操作，不要求每条重装/重新登录。
4. 非CUA覆盖：NW-151鉴权401复核、NW-173服务清理降级、老Win10内置终端、标准用户安装/UAC、Dock与自启动、非空会话行、截图录屏/托盘、桌面桥/宿主导航、旧Runner拒绝/local-files保持关闭、四语言更新文案与前端关键回归。版本目录逐项映射代码/用例。

## 边界

下一Beta结果全部“待验”，Beta4图只作参照。GUI只使用指定真机；首次权限/破坏性安装用隔离账户或可还原环境，人确认系统授权，不重置现有TCC、不保存覆盖用户文档。Harness / pi-agent / Nuwa Browser 产品能力不纳入；旧CUA桌面GUI夹具不等于浏览器集成。下一Beta编号未指定，此文不创建tag/发布。
