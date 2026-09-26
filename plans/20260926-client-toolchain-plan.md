# 实施计划：client-toolchain

- 对应 spec：specs/client-toolchain.md
- 状态：已接受（用户请求实施）

## 改动文件清单

| 模块 | 动作 | 说明 |
|---|---|---|
| client.config.mjs / scripts/client | 新增 | 配置、准备、前端、开发、打包、更新、发布和 doctor |
| package.json / Makefile / 兼容脚本 | 修改 | 统一入口及旧命令转发 |
| .gitmodules / gitlinks / overlay 网关路径 | 修改 | 产物仓、本地消费和双 pin |
| scripts/*.test.mjs / 商业网关测试 | 增改 | 脏改动、缓存、竞争、发布状态机、路径 |
| README / AGENTS / smoke | 修改 | 新命令、源码线 dist 口径及源码探针 |

## 实施顺序

1. 隔离 worktree；并行实现准备/dev/pack、更新器、发布器，根负责共享契约与前端。
2. 源码 dist 移除提交经 PR 进入版本线；构建该目标源码，创建并推送产物仓。
3. 集成 CLI、本地消费与文档；收口完整更新链与双 pin。
4. 测试、质量走查、真实运行/包验证，提交特性支并提供 PR。

## 证明成立的测试

test:scripts；独立副本 test:commercial；前端 index/version；双 gitlink/远端可达；本地 dev 二次缓存与包载荷；Windows 原生命令行；release dry-run。

## 风险与回退

源码迁移与产物发布分阶段记录；失败停止外层 bump。所有任务代码在隔离支，共享 WIP 保持原状。不强推、不重写引用历史。正式版本发布仅接受显式版本授权。

## 偏离记录

实施中补记验证限制或必要调整。
