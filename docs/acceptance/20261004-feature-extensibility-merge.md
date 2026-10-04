# feature-extensibility 本地合入检查（2026-10-04）

## 合入范围

- 目标：`release/v3.0.x`，检查基线 `e7de5dc92343b1ce6b60d0ca2e8b0d75840a6ce2`。
- 来源：`codex/feature-extensibility`，分支尖 `d94b625e`，实现提交 `2dcb3b6f`。
- 前端源码 pin：`cb5aa08d4d8a5dac6a01991b57c797ff037fd7ad` → `e4bb29a8e453851667546b1821e5a5df0e7cf992`；基座与产物 pin 保持原值。
- 用户明确要求先合并该分支。源码与自动化质量门检查完成，后续提测、产物构建与真实安装包验收继续按下方事项推进。
- 检查在隔离工作树进行；保留共享工作区的前端检出与 iframe 兼容开发改动。没有推送、创建版本标签或发布。

## 三问走查

1. **逻辑内聚通过。** 托盘服务启停及迟到结果保护集中在 `overlay/crates/agent-electron-client/src/main/window/trayServiceActions.ts:14`；节点纯默认值归 `nuwax/src/pages/Antv-X6/v3/config/nodeDefinitions.ts:26`，行为 handler 与保存往返分别保留在原属主。
2. **分层通过。** 宿主契约由前端单一源码生成商业快照，入口为 `scripts/sync-host-bridge-contract.mjs:7`；preload 真实暴露对象及消费方类型均由编译回归检查。工作区兼容边界与原生表单适配各自集中，没有新增跨层环依赖。
3. **维护性通过。** 四域类型门、宿主契约门、节点注册/布局/分支往返与工作区挂载回归均通过；overlay 审查绑定目标 blob、mode 与商业内容摘要，避免旧审查失效后继续放行。

发现的 Important 已修复并独立复核：原 overlay 兼容检查在 `blob:none` 部分克隆中对全树执行相似重命名识别，会因无关缺失 blob 阻断合法更新。现在只读取提交树元数据，按 overlay 路径比较，重命名两端仍分别检查。新增真实部分克隆与不可用远端回归，确认不下载 blob、不改变索引/引用/HEAD。见 `scripts/check-overlay-compatibility.mjs:66` 与 `scripts/check-overlay-compatibility.test.mjs:31`。

## 当前快照质量门

| 检查 | 结果 |
| --- | --- |
| 外层脚本测试 | 158 通过，0 失败 |
| overlay 兼容守卫独立复核 | 17 通过，0 失败（已包含在脚本门中） |
| 社区测试 | 1534 通过，0 失败，18 跳过 |
| 商业测试 | 2125 通过，0 失败，18 跳过 |
| 前端受影响回归 | 28 文件，295 通过，0 失败 |
| 前端会话回归 | 111 文件，1085 通过，0 失败；与受影响回归有重叠 |
| 类型门自身回归 | 19 通过，0 失败 |
| 四域类型门 | 323 文件，contracts/conversation/nodes/workspace 均零诊断 |
| 前端架构门 | 零新增违规，97 条既有违规按已有基线忽略 |
| 商业 main/preload 生产构建 | 通过 |
| host-bridge:check / overlay:check / check:pin | 通过；128 个商业覆盖文件全部一致 |
| 基座 pin 兼容检查 / diff --check | 通过 |

社区门在干净基座运行，随后才在隔离副本展开商业 overlay。首次运行缺私有 pnpm store 与准备后的 MCP JS 资源，补齐后完整重跑通过。两个轨道测试前后源码状态一致。

## 交付后续

- `nuwax-dist` 仍为 `4df84e6a4e14454c8c19a45397f3799079642443`，对应旧源码 `cb5aa08d4`；需构建并验收此次源码对应的产物，再更新双 pin 后提测/发版。
- 真实后端保存刷新、X6 undo/redo、客户端登录重启升级与安装包验收尚待完成。
- 四域外仍报告 285 条类型诊断；本次未逐条对比域外错误，不据此宣称全库类型通过。
- `plans/20261002-feature-extensibility-plan.md` 中记录的保存并发及缺 UUID 历史兼容问题属于既有基线，需后续专项处理。
- Windows 登录修复与 `e7de5dc9` 的正常版本递增、beta/stable 交替及防通道指针降级规则保留。
