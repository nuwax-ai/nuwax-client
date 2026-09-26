# 客户端工具链实施与验证记录

## 源码与产物

- 隔离实现分支：`codex/nuwax-toolchain`，基于 `release/v1.0.x` 的 `951aa597`。
- 前端版本线移除 dist 跟踪：[nuwax PR #186](https://github.com/nuwax-ai/nuwax/pull/186)，已合入 `feat-2026.9.30`，源码 `3bab563d547248463796980ff04f6ccf0f495ee3`。
- 新建 public 产物仓：[nuwax-dist](https://github.com/nuwax-ai/nuwax-dist)，声明分支 `main`。
- 首包从目标源码生产构建；实际 `sub:update --force-build` 刷新后，产物提交 `54268bf5303ce6340af21698b6e7545f9db96e53` 已推送并通过 `ls-remote` 对拍。
- 外层双 pin 提交 `71bc9e37`：源码 `3bab563d547248463796980ff04f6ccf0f495ee3`，产物 `54268bf5303ce6340af21698b6e7545f9db96e53`；基座保持 `52bd898f97d0a22e2d677a1c4bffab8fbeac2cf5`。
- 当前产物戳 `3bab563d54` 与源码一致。更新后 `nuwax`、`nuwax-dist` 工作树干净，产物 README 保留。
- CI workflow 仅修改 smoke 的旧 dist 存在断言；正式与 beta 发布流程仍从源码 pin 重建，`release-provenance.mjs` 未修改。

## 质量走查

| 问题 | 结论与证据 |
|---|---|
| 功能逻辑是否内聚 | 准备与缓存集中于 `scripts/client/prepare.mjs:256`；构建/生成文件恢复集中于 `scripts/client/frontend.mjs:14`；Git 竞争与双 pin 集中于 `scripts/client/update.mjs:185`、`:262`；发布续跑集中于 `scripts/client/release.mjs:285`。兼容入口仅转发。 |
| 分层是否正确 | CLI 解析与操作锁 → 功能模块 → `scripts/client/core.mjs:14`、`:84` 的进程/Git/缓存工具；商业运行时代码仍在 overlay；未改基座 pin。 |
| 后续是否便于维护 | 配置集中于 `client.config.mjs:2`；资源所有权 `scripts/client/prepare.mjs:189`、受管 overlay `:171`、版本戳 `scripts/client/update.mjs:158`、远端 pin 可达性 `:93` 与不强推守卫 `:205` 均有针对性测试。README/AGENTS 已同步。 |

只读交叉评审发现的资源覆盖、doctor 漏检和受管 overlay 阻断问题均已修复。真实准备还修复了无独立 kit 锁文件、子脚本 pnpm 版本、生成锁文件导致缓存失效等问题。Git 更新通过部分获取避免下载历史 dist blob；Computer Use 仅检出固定提交的 Rust 工作区。

最终 Git 复核发现并修复单分支检出中的远端引用过期问题：过滤拉取时显式刷新所有远端 heads 并 prune，删除/改写分支的回归测试验证旧引用不能授权外层推送。

最终独立只读复核未发现阻塞代码问题，prepare/pack 的 19 项针对性测试通过。代码质量三问通过；提交供 PR 评审，完整跨平台运行验收仍受下述限制，保持 draft。

## 已验证

- 最终脚本门禁：108 项通过、0 失败、0 跳过（47.07 秒）；包含集中配置和用户内存参数优先、远端删除/改写引用回归。
- 隔离商业轨：138 个文件通过、1 个文件跳过；1722 项通过、18 项按原配置跳过。
- 前端真实生产构建：`index.html` 与正确 `version.json`，生成版本文件恢复，独立构建保留本地 dist。
- 更新器真实链：构建 → 产物提交/推送 → 外层 pin 提交 → 本地暂存清理。
- Computer Use：固定源码与现有补丁真实 Rust 构建成功，macOS helper bundle 已生成。
- macOS arm64 真实准备与重复准备成功，第二轮约 0.6 秒，复用依赖、Electron ABI 143 原生模块及资源。`doctor --json` 返回 ready=true、issues=[]。
- 默认 `npm run pack` 生成无签名 DMG 与 ZIP；应用身份为 `com.nuwax-ai.nuwax` / Nuwax / 女娲Nuwax，前端戳为 `3bab563d54`，`index.html` 哈希与产物 pin 相同，未夹带产物仓 README 或 Git 元数据。
- DMG 经 `hdiutil verify` 校验通过；`Nuwax-1.0.37-dev-arm64.dmg` SHA256 为 `0510b4fea2b244f16a29702cc124295191cf8031a0c1f41d2320acacb3112a37`，ZIP 为 `8d2391dffed83d438b98228002c1d6303fae958beb2bce1c0877bce914dda5ad`。
- 解包应用的 Electron 40.8.2 实际加载包内 SQLite 并完成内存查询。默认包与源码模式包均完成构建。
- 源码模式真实构建打包包含本轮临时前端修改，默认包不含该修改；前后外层/源码/产物 HEAD 均不变，生成版本文件恢复，开发改动保留。验证后仅删除本轮临时标记文件。
- 发布真实只读 dry-run：能报告缺失说明、未推分支等前置条件；未创建发布 tag、触发 CI/签名或正式发布。

## 验证限制与待验收

- 开发默认端口已有其他任务的进程占用；暂时停止与恢复这些进程的确认仍待用户回复，尚未完成新入口真实启动验收。
- 两台已配置 Windows 主机 SSH 均关闭连接；原生 Windows 准备、构建、开发、打包与交互安装验收尚未完成。
- 首次正式发布仍需具体版本授权、SimplySign 手机认证及线上全链验证。
- macOS 安装包已生成并检查结构、品牌和载荷；由于现有开发实例占用端口，尚未完成新入口 GUI 启动和安装后的交互验收。

执行日志保存在隔离工作树的 `.cache/client-toolchain/`，不提交日志与安装包。
