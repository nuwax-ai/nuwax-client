# 实施计划:内置 codex ACP 适配器升级至 @nuwax-ai/nuwax-harness-acp-ts

- 对应 spec:无(中等需求,仅 plan;变更收敛于既有适配器分发链路,无新对外契约)
- 状态:已完成(2026-10-29,含偏离记录)

## 背景

壳内已内置 codex 引擎的 TS 适配器旧包 `@nuwax-ai/nuwax-codex-acp-ts@^1.2.8`(npm 旧包名停更于
1.2.19)。新包 `@nuwax-ai/nuwax-harness-acp-ts@1.2.21`(内部 pin 引擎包 `@nuwax-ai/nuwax-harness@0.18.21`)
与本仓 fork 同源。新旧行为差异(已核实源码):

1. **postinstall 下载位置**:旧=适配器包内 `vendor/nuwax-codex/<ver>/`;新=`~/.nuwax-harness-cache/<引擎版本>/<平台三元组>/`(postinstall 属于引擎包 `@nuwax-ai/nuwax-harness`,适配器自身无 postinstall)。
2. **引擎文件集**:旧=单二进制 `nuwax-codex`;新=整组文件(主二进制 `nuwax-harness` ≈256MB、`codex-code-mode-host` ≈65MB,Linux 另有 `codex-resources/bwrap`,Windows 另有 `codex-windows-sandbox-setup.exe`/`codex-command-runner.exe`)。权威清单=引擎包 `bin/runtime.js` 的 `requiredBundleFiles()`。
3. **运行时引擎解析**:旧=包相对路径 `<pkgRoot>/vendor/nuwax-codex/<ver>/<bin>`;新=仅 `NUWAX_PATH`/`CODEX_PATH` env,兜底 `homedir()/.nuwax-harness-cache/<ver>/<triple>/<bin>`。**壳的 ACP 子进程恒定隔离 HOME**(`acpClient.ts` `HOME: isolatedHome`),兜底路径必然落空 → 注入 `NUWAX_PATH` 是必须项,非可选。
4. **网关 env 兼容**:新适配器所有网关变量经 `resolveEnvAlias` 同时接受 `CODEX_*` 别名,壳现有 `CODEX_API_KEY`/`CODEX_BASE_URL`/`CODEX_MODEL`/`CODEX_WIRE_API` 注入无需改名。
5. 适配器 `dist/index.js` 仍为 esbuild 自包含单文件(≈2MB,引擎版本号已内联),bundled 布局不再需要旧版 `node_modules/nuwax-codex/package.json` 占位文件。

## 改动文件清单

| # | 文件 | 动作 | 说明 |
|---|---|---|---|
| 1 | `nuwa-electron-shell/crates/agent-electron-client/package.json` | 改 | devDep 换 `@nuwax-ai/nuwax-harness-acp-ts@^1.2.21`;extraResources `from/to` 改 `nuwax-harness-acp-ts`(npm script 名 `prepare:codex-acp-ts` 保持不变,减少联动) |
| 2 | `nuwa-electron-shell/package.json` | 改 | pnpm `onlyBuiltDependencies`:`@nuwax-ai/nuwax-codex-acp-ts` → `@nuwax-ai/nuwax-harness`(postinstall 现属引擎包) |
| 3 | `nuwa-electron-shell/crates/agent-electron-client/scripts/prepare/prepare-codex-acp-ts.js` | 改(重写主体) | 引擎源改 `~/.nuwax-harness-cache/<ver>/<triple>/`(版本读自 node_modules 内引擎包 package.json);缓存缺失时先 spawn 引擎包 launcher `--version` 自动补下再校验(fail fast);**整目录复制**三元组目录到 `resources/nuwax-harness-acp-ts/vendor/nuwax-harness/<ver>/`(见布局);全部文件 chmod 0755 保留、macOS 对可执行文件逐个 ad-hoc 签名 |
| 4 | `scripts/client/prepare.mjs` | 改 | resourceSpecs `codex-acp-ts` 期望文件路径改 `nuwax-harness-acp-ts/dist/index.js` |
| 5 | `nuwa-electron-shell/crates/agent-electron-client/src/main/services/system/binaryLocator.ts` | 改 | `getCodexAcpTsBundledDir()` 目录名改 `nuwax-harness-acp-ts`;新增导出 `resolveBundledHarnessEnginePath()`:bundled vendor(扫描版本目录)→ npm 兜底(`~/.nuwax/node_modules/@nuwax-ai/nuwax-harness/package.json` 读版本 + 真实 `os.homedir()` 缓存目录),返回引擎主二进制绝对路径或 null |
| 6 | `nuwa-electron-shell/crates/agent-electron-client/src/main/services/engines/acp/acpClient.ts` | 改 | codex env 分支:注入 `NUWAX_PATH`(=resolveBundledHarnessEnginePath(),null 则不注入并 warn);`APP_SERVER_LOGS` 指向既有 codex 日志目录(适配器日志,文档确认不含 Key) |
| 7 | `nuwa-electron-shell/crates/agent-electron-client/src/main/services/system/dependencies.ts` | 改 | case 与 npm 兜底目录名改 `nuwax-harness-acp-ts` / `@nuwax-ai/nuwax-harness-acp-ts` |
| 8 | `nuwa-electron-shell/crates/agent-electron-client/src/main/services/system/dependencyChecker.ts` | 改 | 依赖条目 name/binName 改 `nuwax-harness-acp-ts`,`installVersion`/`npmFallback` 改新包 `1.2.21` |
| 9 | `nuwa-electron-shell/crates/agent-electron-client/src/main/services/engines/agentHelpers.ts` | 改 | `mapAgentCommand` 增加 `"nuwax-harness-acp-ts"`(保留全部旧名,服务端下发旧名不受影响) |
| 10 | `nuwa-electron-shell/crates/agent-kit/src/index.ts` | 改 | `CODEX_ACP_PACKAGE`/`CODEX_ACP_ENTRY` 改 `@nuwax-ai/nuwax-harness-acp-ts`(影响 npm 宿主默认 require.resolve;Electron 路径走 entryOverride 不受影响) |
| 11 | `nuwa-electron-shell/crates/agent-electron-client/scripts/build/after-sign.js` | 改 | macOS/Windows 签名路径 `nuwax-codex-acp-ts/vendor/nuwax-codex` → `nuwax-harness-acp-ts/vendor/nuwax-harness`,改为枚举 vendor 下全部可执行文件逐个签 |
| 12 | `nuwa-electron-shell/crates/agent-electron-client/scripts/dev/ensure-resources.js` | 改 | dev 资源目录名改 `nuwax-harness-acp-ts` |
| 13 | `nuwa-electron-shell/crates/agent-electron-client/src/main/services/engines/agentHelpers.test.ts` | 改 | 补 `"nuwax-harness-acp-ts"` → codex-cli 映射断言 |
| 14 | `nuwa-electron-shell/crates/agent-electron-client/src/main/services/system/` 相关测试 | 改/查 | dependencyChecker/dependencies 若有名字快照测试,同步新目录/包名 |

bundled 目标布局(`resources/nuwax-harness-acp-ts/`):

```
dist/index.js                    适配器自包含 bundle
package.json                     精简(name=@nuwax-ai/nuwax-harness-acp-ts, bin, main)
vendor/nuwax-harness/<ver>/      整个三元组目录原样复制:
  nuwax-harness[.exe]            主二进制(NUWAX_PATH 指向它)
  codex-code-mode-host[.exe]
  SHA256SUMS
  (linux) codex-resources/bwrap  (win) codex-windows-sandbox-setup.exe / codex-command-runner.exe
```

## 实施顺序

1. 依赖声明(1、2)→ `pnpm install`(触发引擎包 postinstall 下载,本机已有 0.18.21 缓存可直接命中)。
2. prepare 脚本(3)+ 外层 resourceSpecs(4)→ 跑 `prepare:codex-acp-ts` 验证产物布局与签名。
3. 运行时(5、6、7、8、9)+ agent-kit(10)+ 构建脚本(11、12)+ 测试(13、14)。
4. 域内测试与手工验证(dev 起一次 codex 会话,确认 `NUWAX_PATH` 注入与引擎 spawn 链、会话可收发)。

步骤 2 与 3 无相互依赖,可交叉;1 必须最先(脚本与运行时都依赖新包装好)。

## 证明成立的测试

- 新增/修改:`agentHelpers.test.ts`(命令映射);prepare 脚本产物自校验(缺失即 exit 1,沿用 fail fast)。
- 回归范围:crate 内 `npm run test:run -- src/main/services/engines/agentHelpers.test.ts src/main/services/system/` 相关文件;脚本测试 `npm run test:scripts`;外层门禁 `npm run test:commercial`。
- 手工:dev 模式发起 codex 引擎会话一轮对话;`npm run pack` 产物抽查 `.app/Contents/Resources/nuwax-harness-acp-ts/` 布局与签名(留待发版验证,不在本次 commit 强制)。

## 风险与回退

| 风险 | 缓解 | 回退方式 |
|---|---|---|
| 安装包体积 +≈65MB(codex-code-mode-host) | 发版前 `pack` 实测各平台体积,超出预期再评估压缩/裁剪 | revert 本批文件 |
| npm 兜底场景适配器找不到引擎(HOME 隔离) | resolveBundledHarnessEnginePath 的 npm 分支用真实 HOME 缓存 + 引擎包版本定位;仍失败时 warn 并让适配器报清晰错误 | 兜底场景非主路径,资源 bundled 恒有 NUWAX_PATH |
| 新适配器与后端网关协议不匹配(tool_search 线格式) | 实测;必要时 env 加 `NUWAX_TOOL_SEARCH=false`(文档 §2.3) | env 开关,零代码回退 |
| after-sign 遗漏新增二进制导致 macOS 公证失败 | after-sign 改为枚举 vendor 全部可执行逐个签;实机 pack 验证 | 仅影响发版,源码运行不受影响 |
| CI 每次全新 install 触发 130MB 引擎下载 | 新缓存路径为稳定 HOME 目录,后续可纳入 CI 资源缓存(独立优化,不阻塞本次) | 现状旧包同样每 run 下载,非回归 |

## 偏离记录

(实现中偏离原计划的逐条补记:原因 + 同步的 commit)

1. **agent-kit 改动面扩大**(原计划只列常量):实际还改了 `peerDependencies`(旧 peer 会被 pnpm auto-install 拉回旧包及其旧引擎)、包内 `pnpm.onlyBuiltDependencies`、壳根 `update:codex-acp` 维护脚本包名;agent-kit 独立 pnpm-lock.yaml 未跟踪(prepare 按 --no-frozen-lockfile 处理),无需提交。
2. **prepare 脚本从"整目录复制"改为按权威清单选择性复制**:实测发现本机 `~/.nuwax-harness-cache/<ver>/<triple>/` 残留旧名 `nuwax-codex` 二进制,整目录复制会把 576MB 带进包;改为动态 import 引擎包 `bin/runtime.js` 的 `requiredBundleFiles()` 选择性复制(322MB),后续引擎加文件自动跟上。
3. **dependencies.ts 增加 re-export**:`resolveBundledHarnessEnginePath` 除在 binaryLocator 定义外,经 dependencies.ts re-export 给 acpClient(沿用 `getCodexAcpTsBundledDir` 的既有 re-export 模式)。
4. **壳根 .gitignore 增加新资源目录条目** `resources/nuwax-harness-acp-ts/`(旧目录已有同类条目,惯例沿用)。
5. **环境准备(非仓库变更)**:darwin 构建的 `build-mac-notification-permission.cjs` 依赖外层根 devDep `node-api-headers`(经祖先 node_modules 解析),本机需先在外层根 `npm install`;全量测试套件前需 `npm run prepare:mcp-proxy`(CI 同序)。

验证结果(2026-10-29):构建(main+renderer)通过;agentHelpers 19、system 域 46、crate 脚本测试 40、agent-kit 84 全绿;外层 `test:commercial` 302 文件/3694 用例通过(mcp.test.ts 首跑失败系本机缺 prepare:mcp-proxy 资源,补跑后 60/60);stdio 冒烟:隔离 HOME + 仅 `NUWAX_PATH` 下 adapter 1.2.21 握手成功,`session/new` 返回文档预期的网关鉴权结构化错误,证明 adapter→engine 全链路可达。`pack` 实机体积与签名验证留待发版流程。
