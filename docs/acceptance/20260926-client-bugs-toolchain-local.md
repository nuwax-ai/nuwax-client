# 客户端 Bug 与工具链本地集成验收

## 范围与提交

- 独立工作树：`/Users/apple/workspace/nuwax-client-bugs-toolchain-20260926`。
- 分支：`codex/bugs-client-toolchain-20260926`，从工具链 `1e1c9304` 创建；原 PR #11 分支保持不变。
- 本轮只整合 Web 前端及已授权桌面客户端，不改 Java 或移动端。
- 客户端修复按原顺序 cherry-pick，全部无冲突：`726793ce → d570f79c`、`63181189 → 7febca80`、`85a1b04c → 922cfe1a`、`c2ba72bb → 19c85c60`、`6ba6757f → 38897f89`。
- file-server 配置：`50ab2083 → 2a702ce8`，installVersion 与 npmFallback 均为 `1.5.3`。
- 本地双 pin 提交：`0626649e801941bc3f0205c3ba0b0b5432b17646`。此报告在其后单独提交。

| 仓库 | 最终固定提交 |
| --- | --- |
| nuwa-electron-shell | `f7e3f9319cf31eb03a9906e4a1eb7aa7096c0cd2` |
| nuwax 源码 | `f7bbe57e65bcfc49d6df88a4741ab815b1686b6c` |
| nuwax-dist 产物 | `35fa79cf737ec300736006aba523cbca2c3b522e` |

## 合流与资源证据

- 基座 `52bd898f` 是 `f7e3f931` 的祖先，两者间只有既有中立终端修复提交。本次未修改或提交基座源码。
- loopback 自动合入同时保留生命周期串行队列、迟到 start 清理和工具链的 `nuwax-dist` 目录解析；相关测试随完整商业测试通过。
- 新前端源码以移除 dist 跟踪的 `3bab563d54` 为祖先；使用根 agent 已验证的生产构建，未沿用旧 combined 源码 pin。
- 独立产物仓保留原 README 与 Git 元数据；832 个构建文件逐字节与 `/Users/apple/workspace/nuwax-bugs-toolchain-20260926/dist` 相同。版本戳为 `f7bbe57e6`，index.html SHA256 为 `aa006b05a87428be6f82da8c337449dc719c99c68b0f92125fca8bc5b388102e`。
- `validatePinnedFrontend` 实际检查通过：源码/产物 HEAD、外层双 gitlink 与版本戳匹配，产物工作树干净。源码工作树干净，`git ls-files dist` 无输出。
- 三个子仓库均为独立检出；依赖及资源使用本机 COW 文件复制，不共用可写源码工作树。本轮没有执行默认 `sub:update`。
- 实际 file-server 资源为 `1.5.3`，资源 commit 标记为 `0cffa11c7340b032a69121f60bff8194ebbd2d13`；CLI、server 入口及运行依赖完整，配置与资源版本一致。
- 工具链原工作树的 Computer Use 生成资源未被 Git 忽略，导致原工作树默认 check:pin 报 5 个未托管产物。本次保留原目录，仅在隔离基座 `.git/info/exclude` 精确忽略 `crates/agent-electron-client/resources/computer-use/`。生成资源未暂存进基座。
- file-server bundledSources 仍声明 Git main。本轮记录的是实际资源 commit，未来刷新 main 的结果仍需重新核验。

## 本地门禁

日志目录：`/Users/apple/workspace/bug-batch-20260926/evidence/client-toolchain-integration/`。

| 检查 | 本轮结果 | 证据 |
| --- | --- | --- |
| npm run test:scripts | 108 通过，0 失败、0 跳过 | scripts.log |
| npm run test:commercial | 143 文件通过、1 文件跳过；1765 项通过、18 项跳过、0 失败 | commercial.log |
| 商业生产构建 | 主进程 esbuild 成功；renderer 3574 模块构建成功 | build.log |
| Electron 原生模块 | Electron 40.8.2、ABI 143 实际加载隔离 SQLite，内存 select 1 成功 | native-abi.log |
| overlay --check | 74 文件一致，0 待同步 | 终端复核 |
| check:pin 默认模式 | 基座 74 个脏文件全部为 overlay 托管同步产物 | 终端复核 |
| check:pin --staged | 0 暂存文件，0 overlay 泄漏 | 终端复核 |
| check:pin --remote HEAD | 基座 HEAD 的 74 个托管路径均保持中立版本 | 终端复核 |
| git diff --check | 通过 | 终端复核 |

生产构建使用工具链 `commercialEnv`，设置 `NODE_ENV=production`、`SKIP_PREPARE=1`，消费隔离的既有完整资源。该结果验证源码构建与现有资源兼容，没有重跑全新机器的完整准备流程。`--remote HEAD` 是针对基座当前 commit 的字节检查，不代表正式远端可达性核验。

## 交付边界

- 本轮源码、基座修复和产物 pin 尚未完成正式远端可达性核验；本轮没有向任何仓库推送。外层本地提交不能据此称为 CI 已可复现或已发布。
- 原 PR #11 工作树、共享运行进程及全局服务未操作；未发 PR 评论、未停止共享 GUI。
- 本轮未执行安装包构建、共享 GUI 操作或 Windows 真机验收。此前独立 Electron fixture 的语言/菜单/下载证据仍属于原修复验证，不能替代此新合流安装包验收。
- 原前端 987 项测试与前端生产构建由根 agent 完成；本报告只将其构建产物作逐字节复制核验。本轮独立执行的是客户端脚本、商业测试、壳生产构建及 Electron ABI 查询。
- 历史验收报告保留原基线和限制；本报告为本次工具链合流的新增记录。合流与证据由根 agent 独立评审，writer 不自批。
