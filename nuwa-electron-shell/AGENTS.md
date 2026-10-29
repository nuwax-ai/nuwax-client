# nuwa-electron-shell 商业壳开发指南

默认使用中文回复。

## 仓库边界

- 本目录已作为商业壳源码并入 nuwax-client，客户端位于 `crates/agent-electron-client`，引擎 SDK 位于 `crates/agent-kit`；以外层根目录 `AGENTS.md` 为准。
- 客户端改动直接在本目录维护，与根目录工具链共用提交、评审和发布。
- 日常命令从仓库根运行；本目录是源码组成部分，不是独立仓库。

## 开发与验证

- 小修直接修改并验证相关行为；复杂需求最多维护一份计划，不要求 intent/spec/plan 串行工件或测试先提交。
- 客户端内的具体约束见 `crates/agent-electron-client/AGENTS.md`。只读与任务相关的文档，不默认遍历历史设计和验收记录。
- `npm run test:electron` 执行客户端全量测试；日常在 crate 内使用 `npm run test:run -- <相关文件>`。
- `npm run test:electron:scripts` 检查构建脚本；构建 agent-kit 使用 `npm run build:agent-kit`。
- 提交钩子仅格式化暂存文件。测试按改动域执行，已有结果足够且代码未变时不重复全量验证。
- 新增测试覆盖真实行为和未覆盖的风险；注释保留原因、协议、平台差异及单位，不记录开发流水账。

## 产品隔离

- 产品数据路径来自共享 constants 与构建身份，不硬编码其他产品目录；商业身份为 nuwax，数据目录为 `~/.nuwax`。
- 外层 `npm run test:commercial` 为完整商业测试入口；定向测试与完整门禁使用本仓同一份源码。
- 提交前检查 diff，保留无关 WIP；源码测试不代替真实安装包和平台验收。
