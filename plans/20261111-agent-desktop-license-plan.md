# Agent Desktop 商用声明与 Beta 发布

- 范围：保留现有引擎下拉和默认项；核对 1.2.0 固定源码 2b0a7334fc111730454b726e6800aa41cdafc093 的 Apache-2.0 许可、五平台依赖闭包和 Windows 修改；完成声明后合入 Release，发布下一个可用 Beta。
- 事实：最新 Beta.24 中 Agent Desktop 三个平台缓存恢复约 4 秒，没有重复编译；现有正式发布仅注入 capture 专用声明，完整声明需接到发布入口并校验实际包。
- 实现：按 Cargo.lock 的精确版本和校验和生成可复核依赖清单，保存许可证原文及归属来源；完整声明在应用包装边界合并，不修改 capture/helper/core 缓存配方。页面显示现有 notes，按实际平台标明修改。
- 商用判断：Apache-2.0 允许商业与闭源集成；分发保留 LICENSE/归属/适用 NOTICE，修改文件明确标注；不暗示获得 Vercel 商标或背书。逐项核查依赖，未知或缺许可全文禁止新声明入包。
- 验证：依赖清单与原文完整性、平台过滤、版本失配拒绝、声明生成/包内校验、页面/loader 读取、现有 native 缓存配方不变；CI 通过后合入，正式 Beta 五平台与双镜像校验。按需将同一修复同步 Alpha。
- 提速：复用已生效的固定依赖缓存及 Windows 并行；本轮不引入未验证的压缩/安装器策略，不另起验包版本试错。记录 Beta.24/新 Beta 实际耗时，区分编译、下载、签名、公证及归档。

## 提交前验证与自查

- 商业测试：314 文件、3862 通过、1 跳过；脚本测试：437 通过、3 跳过；主进程类型检查、renderer 生产构建通过。真实本机资源完整声明生成 473 条，problems 为空；五平台闭包、文本校验和、失配拒绝与实际包装校验均有回归。
- 内聚：Agent Desktop 许可身份及平台选择集中于 `scripts/client/agent-desktop-notices.mjs:23`，包装组合集中于 `scripts/client/source-notices.mjs:9`；界面复用已有 notes 与全文读取契约。
- 分层：发布生成/只读验证由 `scripts/prepare-release-notices.mjs:16` 统一承担，在签名前注入，签名后核验；native capture/helper 配方相关源码无修改。
- 维护：精确源码、归档 SHA256、许可证全文、再生成命令与 Rust 版本更新方式均保存在 `third-party/agent-desktop/`；严格失败防止升级后沿用旧审计。
- 基线门禁修复：PR #118 的时间戳工具跨 feature 引用导致脚本门禁失败；仅将同一实现移入 main feature `_kit`，宿主走 features 公共出口，不改文件名行为。边界门禁与日志导出/时间戳测试已通过。
- 缓存修复：固定下载归档的配方仅包含实际下载器及其共用工具和有效上游地址；Agent Desktop/Harness/传输层/通用 core 的无关改动不再驱逐固定归档。Windows Agent Desktop 因新增源码修改标注将有意冷编一次。
- 结论：三问通过，可提交 PR；完整 CI、正式包声明校验、发布和实机验收仍按各自证据层级执行。
