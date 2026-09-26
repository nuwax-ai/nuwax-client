# 客户端 release/v1.0.x 修复合流验收

## 合流结果

- 用户授权目标 `release/v1.0.x`；待合流批次来源 `codex/bugs-client-toolchain-20260926@88c9db1e`。
- 隔离工作树 `/Users/apple/workspace/nuwax-client-merge-release-20260926`，分支 `codex/merge-bugs-client-release-20260926`。
- 合流提交 `a0eb7bf599f874a7da5a925a3187dffc98bef299`，两父提交为目标 `50ab2083be9f8082ae643a5e0fcc3afaff02410d` 与来源 `88c9db1eed9daa9d0a9cad57340928c29d2e9320`。本报告另提交，不改源代码。
- 保留 release 现有 `b2764fa3` 的 ticket 有效性与镜像有界等待、cookie 策略和 Webview 语言事实源；保留 `50ab2083` 的 file-server 客户端配置 1.5.3。
- 叠加客户端下载、Webview 失败恢复、主菜单语言、loopback 串行生命周期、双 pin 构建工具链及对应测试。
- 源码和产物 pin 保持 `f7bbe57e65bcfc49d6df88a4741ab815b1686b6c` / `35fa79cf737ec300736006aba523cbca2c3b522e`；中立基座保持 `f7e3f9319cf31eb03a9906e4a1eb7aa7096c0cd2`。

## 冲突处理与三问自查

- `nuwaxBridgeHandlers.tokenScopes.test.ts`：保留 release 的语言持久化与不支持语言回退断言，同时保留来源的 saveFile 下载保护用例。
- `loopbackGateway/index.test.ts`：保留 release 的 afterEach 定时器清理与 ticket 镜像测试；保留来源的路径 import、产物目录及 lifecycle 并发测试。
- `renderer/services/core/i18n.ts`：保留 release 的 Webview 语言恢复来源，叠加来源 revision guard 以防迟到设置回调改变当前语言。
- 自动合成实现 `nuwaxBridgeHandlers.ts` / `loopbackGateway/index.ts` 已审阅，两侧行为共同保留。
- 功能内聚：下载共用单一 `performSaveDownload` 属主（`overlay/crates/agent-electron-client/src/main/ipc/nuwaxBridgeHandlers.ts:919`），loopback 起停与刷新共用队列（`overlay/crates/agent-electron-client/src/main/services/loopbackGateway/index.ts:104`）。
- 分层：可信发送方与 cookie 权限仍在主进程 bridge（`nuwaxBridgeHandlers.ts:1050`）；renderer 语言服务只处理壳状态，沿用 Webview 主语言来源（`renderer/services/core/i18n.ts:358`）。商业代码均来自外层 overlay，基座 Gitlink 指向中立提交。
- 可维护：HTML/JSON 来源扩展名与重定向目的扩展名同查（`nuwaxBridgeHandlers.ts:1024`），语言 revision guard（`renderer/services/core/i18n.ts:343`）及并发起停测试防回归；工具链统一校验双 pin（`scripts/client/prepare.mjs:123`）。
- writer 自查三问通过，无已知 Important；根 agent 已独立审查冲突与主要生产 diff，无阻塞意见。writer 不自批。

## 本轮门禁

日志目录 `/Users/apple/workspace/bug-batch-20260926/evidence/client-release-merge/`。

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| 脚本测试 | 108 通过，0 失败/跳过 | scripts.log |
| 商业测试 | 144 文件通过、1 跳过；1802 项通过、18 跳过、0 失败 | commercial.log |
| 社区基座测试 | 123 文件通过、1 跳过；1500 项通过、18 跳过、0 失败 | base.log |
| 生产构建 | main esbuild 成功；renderer 3574 模块成功 | build.log |
| 源/产物 pin | 实际 validatePinnedFrontend 通过，版本戳 f7bbe57e6 匹配 | frontend-pin.log |
| overlay | 76 文件一致，0 待同步 | overlay.log |
| 基座纯净 | 默认全部 76 dirty 均 overlay 托管；staged 0；HEAD 字节检查 76 中立 | pin.log / pin-staged.log / pin-head.log |
| Git 差异格式 | 通过 | 终端复核 |

生产构建使用商业 env、NODE_ENV=production、SKIP_PREPARE=1，消费独立 COW 复制的已验证依赖资源。社区测试只清理此隔离副本 overlay，完成后已完整恢复商业 overlay。

## 工作树与交付范围

- 此隔离 worktree 的外层仅显示基座 expected dirty（76 overlay 同步产物），源码与产物子仓干净，可以从此入口继续开发和打包。
- 共享 `/Users/apple/workspace/nuwax-client` 的旧基座检出和 WIP 未更新或同步；根 agent 更新外层目标分支后仍须保留其已有 WIP。共享目录不能仅凭外层合并视为运行时已切到新基座。
- 本轮未推送、未发布、未更新目标 release（由根 agent 审查后快进）；未修改 Java/移动端，未停止共享 GUI。
- 三个本地 pin 不代表正式远端可获取性或 CI 已通过；本轮未重跑安装包/Windows 真机验收。
