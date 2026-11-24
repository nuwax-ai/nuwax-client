# 实施计划：electron-43-upgrade

- 状态：实施完成，已提交到 `release/v3.3.0`；本机与 UOS 复验已完成，安装包的真机验收待做

## 背景

- 仓库原锁定 Electron 40.8.2。该版本线自 2026-07 起不再发布（最后一次 v40.10.6），拿不到 Chromium 安全补丁；UOS 20 上带系统边框的窗口在 Electron 42 及以前会崩溃，43 起正常。
- 选 43 而不是最新稳定版：44 起不再支持 macOS 12，目前没有必须升 45 的需求。已知代价：43 在 2027 年 1 月出官方支持期，届时需要再升一次。
- 原生 Wayland 下隐藏窗口等不到 `ready-to-show`（electron/electron#48859，上游未修，43/44/45/46 均复现），升级解决不了，所以同时合入 `revealWhenReady`。

## 改动文件清单

路径前缀 `client/` 指 `nuwa-electron-shell/crates/agent-electron-client/`。

| # | 文件 | 动作(增/改/删) | 说明 |
|---|---|---|---|
| 1 | `client/package.json` | 改 | `electron` → `^43.0.0`，`better-sqlite3` → `^13.2.0`；删除 `@electron/rebuild`，直接依赖 `node-gyp`；脚本 `electron-rebuild` → `rebuild:better-sqlite3`（强制从源码构建）；`build.npmRebuild=false`；`files` 排除 better-sqlite3 的 `prebuilds`、`build/Release/obj` 和 `test_extension.node`；`asarUnpack`、`extraResources` 只取 `better_sqlite3.node` |
| 2 | `nuwa-electron-shell/pnpm-lock.yaml` | 改 | pnpm 9.15.5 重新生成：Electron 43.8.12、better-sqlite3 13.2.0；移除 `@electron/rebuild` 4.x、`node-abi` 4.x 和 prebuild-install 系列 |
| 3 | `scripts/client/prepare.mjs` | 改 | Electron 二进制缺失时执行 `node_modules/electron/install.js`；重编改为调用 `rebuild:better-sqlite3` |
| 4 | `scripts/client-prepare.test.mjs` | 改 | 夹具和断言跟随新流程；新增 2 个用例 |
| 5 | `.github/workflows/release-electron.yml`、`release-electron-dev.yml` | 改 | `npm run electron-rebuild` → `npm run rebuild:better-sqlite3` |
| 6 | `client/scripts/build/run-build-electron.js`、`scripts/client/package-payload.mjs`、`scripts/installer-archive-policy.test.mjs`、`scripts/windows-installer-orchestration.test.mjs`、`scripts/package-payload.test.mjs` | 改 | `dist:*` 入口在原生模块缺失时先构建；发布前校验 better-sqlite3 的预编译文件和构建副产物没有进包；测试夹具跟上，新增 2 个用例 |
| 7 | `scripts/acceptance/download-popup.cjs`、`scripts/acceptance/local-files-electron-windows.ps1`、`scripts/acceptance/windows-installer-recovery.cjs`、`scripts/installer-space.test.mjs` | 改 | 写死的 Electron 40 / 40.8.2 改为 43 / 43.8.12 |
| 8 | `client/src/main/window/revealWhenReady.ts`、`revealWhenReady.test.ts` | 增 | 隐藏窗口的显示时机：`ready-to-show` 优先，页面加载完成后 150ms 或 3 秒硬上限兜底，只显示一次 |
| 9 | `client/src/main/main.ts`、`client/src/main/ipc/sessionHandlers.ts` | 改 | 主窗口和 `webview:openWindow` 窗口改用 `revealWhenReady` |
| 10 | `docs/npm-scripts.md`、`docs/host-capabilities-api.md`、`client/docs/operations/STARTUP-CHECKLIST.md` | 改 | 脚本名和操作说明同步 |

## 实施顺序

1. 应用 `revealWhenReady` 补丁。
2. 改依赖清单，重新生成锁文件。
3. 改 prepare 流程及其测试、CI、验收夹具、文档。
4. 本机验证，再同步到 UOS 开发副本复验。

## 证明成立的测试

- 验证方式：现有门禁加一次真实打包。打包配置的调整靠检查包内文件和用包内运行时加载原生模块来证明。
- 回归范围与结果（最终状态）：

| 项目 | 结果 |
|---|---|
| 本机 `npm run setup` | Electron 43.8.12 由官方安装器下载；better-sqlite3 13.2.0 经 node-gyp 11.5.0 源码构建；Electron 内 `select 1` 通过（ABI 148） |
| `npm run doctor -- --json` | ready，无 issue |
| `npm run typecheck` | 通过 |
| `npm run test:scripts` | 464 个用例：459 通过、0 失败、5 跳过 |
| `npm run test:commercial` | 322 个文件；3989 通过、1 跳过、0 失败 |
| `npm run verify:tooling -- --output <仓外目录>` | 通过（source-tooling） |
| `npm run dev`（macOS） | 开发版包版本 43.8.12；主窗口 34 秒内显示，未走兜底；干净退出，无残留进程 |
| `npm run pack`（macOS arm64 无签名） | electron-builder 25.1.8 打包成功；包内运行时为 electron 43.8.12 / node 24.22.1 / chrome 150.0.7871.250；用包内运行时加载包内原生模块，查询、FTS5、`quick_check` 通过；`app.asar` 内没有 prebuilds、`test_extension.node`、`obj/gen` |
| UOS 20 1050 arm64（开发副本） | `typecheck:main` 通过；vitest 3982 通过、4 失败、4 跳过，失败全部是 `computer-use/mcpGateway.test.ts` 的 `listen EPERM`（该机器既有问题）；原生 Wayland 下窗口经 `did-finish-load` 兜底显示，内存数据库初始化成功；`frame: true` 和 `hiddenInset` 窗口探针正常 |

- 没有做的验证：
  - CI 五平台打包（`package-validation.yml` 和两个 release workflow）。
  - Windows 真机目检：托盘角标、三个未指定默认目录的保存对话框的落点。
  - 没有启动打包产物的界面。正式档案首次启动可能注册登录项和系统权限，没有用一次性构建在本机冒险；同一份源码的界面只在 dev 模式验证过。
- 验证备注：本机 `npm run pack` 会在 Computer Use 助手的 Rust 构建处失败（strip 后的派生宏动态库无法加载，E0463），与本次升级无关。验证时用 `CARGO_PROFILE_RELEASE_STRIP=none` 绕过，验证后已删除它产生的助手目录、状态文件和缓存条目。
- 提交前质量自查（三问）：显示时机的状态和清理都在 `revealWhenReady` 内，调用方只传显示动作；新模块没有依赖，`ipc` 到 `window` 的引用通过导入边界检查；关键决策都有原因注释，新增行为都有用例。自查中修正：新文件的 ESLint 报错；按 `package-payload` 既有模式补上“预编译文件和构建副产物不得进包”的发布前校验及用例。

## 风险与回退

| 风险 | 缓解 | 回退方式 |
|---|---|---|
| electron-builder 25.1.8 与 Electron 43 的兼容性只在 macOS arm64 无签名路径上验证过 | CI 跑 `package-validation.yml` 覆盖五个平台 | 单独评估升级 electron-builder，或整体回退 |
| 强制源码构建要求各平台有 C++ 工具链 | 原来的 `electron-rebuild` 同样需要，没有新增要求 | 改用 better-sqlite3 13 自带的预编译产物，需同步改打包路径 |
| 未签名的 macOS 构建从 Electron 42 起没有系统通知 | 只影响开发和本机验证 | 无需回退 |
| Electron 43 在 2027 年 1 月出支持期 | 到时再升一次；44 起不再支持 macOS 12 | — |

回退方式：改动都在工作区、未提交，还原这些文件后按旧锁文件重新安装依赖即可。

## 偏离记录

1. **关闭 electron-builder 自带的重编，并让 `dist:*` 入口自己保证原生模块已构建。** 原计划判断“打包配置不用动”，依据是根 `pack` 已设 `npmRebuild: false`。实际 crate 的 `dist:*` 入口不经过根 `pack`，而 electron-builder 25.1.8 自带重编用的 `node-abi` 3.88.0 对 43.8.12 抛 `Could not detect abi`（对 40.8.2 正常）。处理：`build.npmRebuild=false`，`run-build-electron.js` 在原生模块缺失时先执行 `rebuild:better-sqlite3`。
2. **排除 better-sqlite3 的预编译产物和构建副产物。** better-sqlite3 13 自带 8 个平台的 `.node`，electron-builder 会把含 `.node` 的依赖包大量文件放到 `app.asar.unpacked`，新包因此多出约 27 MB 的外平台二进制和生成源码，签名构建存在对这些文件执行签名的风险；强制源码构建还会产出旧包没有的 `test_extension.node`。处理：`files` 排除 `prebuilds`、`build/Release/obj`、`test_extension.node`，`asarUnpack` 和 `extraResources` 收紧到 `better_sqlite3.node`，并在 `package-payload` 的发布前校验里加一条，防止以后被改回去。
3. **同步两处文档。** `client/docs/operations/STARTUP-CHECKLIST.md` 里的 `npx @electron/rebuild` 对 better-sqlite3 13 不再编译，改为新脚本；`docs/host-capabilities-api.md` 的 Electron 文档链接改到 43.8.12。
4. **两个打包入口测试的夹具调整。** 它们断言命令序列，新增的“先构建”步骤需要夹具带上已构建的原生模块，并补一个覆盖该行为的用例。
5. **安装阶段不再执行 better-sqlite3 的安装脚本。** 推送后 CI 的 Windows 任务在 `pnpm install` 失败：13.x 的安装脚本改为走 node-gyp 配置，而 pnpm 9.15.5 自带的 node-gyp 10.2.0 在 Windows 构建机上探测 Visual Studio 失败。该脚本只做空配置，真正的构建由 `rebuild:better-sqlite3` 用仓库锁定的 node-gyp 完成，因此从两份构建脚本白名单（`onlyBuiltDependencies`、`allowBuilds`）里移除。

## 后续核对项

以下注释记录的是针对 Electron 40 实测行为的规避，本次没有逐项在 43 上复测，代码保持不变：

- `client/src/main/services/rendererRecovery.ts`（Electron 40 实测触发 NOTREACHED）
- `client/src/main/main.ts`（回环 gateway guest 的 goBack/goForward）
- `client/src/main/ipc/nuwaxBridgeHandlers.ts`（setMinimumSize、回环网关 origin）
- `client/src/main/features/local-files/index.ts`（protocol handler 注册时机）
- `client/src/main/features/capture/hdr.ts`、`portalRequest.ts`
- `client/src/main/services/system/macNativeNotification.ts`
