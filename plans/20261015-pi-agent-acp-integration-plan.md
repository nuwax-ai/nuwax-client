# pi-agent（pi coding agent）接入 Nuwax 客户端 ACP 架构 —— 成本评估与实施计划

- 对应 spec：无（中等需求，单件 plan）
- 日期：2026-10-15；分支基线：release/v3.0.x；基座 `nuwa-electron-shell` pin eb0eeaca
- 状态：已接受 · B 方案 T1–T3 已实施（2026-10-15，当前会话内实施；worktree 未另建，改动已就地落盘并部分提交）

## TL;DR 成本结论

| 方案 | 说明 | 成本 |
|---|---|---|
| A. 零代码（今天就能用） | 后端 `agent_server.command = "pi-acp"`，现有自定义引擎通路自动拉起 | 0 人日；但模型/MCP/会话加载均未打通，仅 POC |
| B. 一等公民引擎（推荐） | 类型枚举 + 二进制解析 + 模型/MCP 配置注入 + 资源打包 + i18n + 测试 | **约 5–8 人日** |
| C. B 的增量项 | 权限拦截（用 pi 扩展兜住工具执行）、skill/steering 投影、`AGENTS.override.md` 屏蔽项目 README 污染 | 各 +1~3 人日 |

推荐：**先做 B**。开工前用 A 路径一天内可做真机 POC 验证适配器本身。

## 选型：适配器 pi-acp（svkozak/pi-acp，npm `pi-acp@0.0.34`）

- 架构：pi-acp 作 ACP server（stdio JSON-RPC），spawn `pi --mode rpc --no-themes` 并双向翻译（[仓库](https://github.com/svkozak/pi-acp)，Zed 官方推荐，733★）。备选 victor-software-house/pi-acp（in-process SDK，**需 Bun ≥1.3，放弃**）。
- 本机实测（mac，`npm pack` + 冒烟脚本）：
  - `initialize` 61ms，`session/new` 1.2s；`agentCapabilities.loadSession = true`，MCP 能力只声明 stdio。
  - `session/new` 返回 ACP 标准 `models` + `configOptions`（model / thought_level），**当前模型 `nuwax/nuwax-test-model` 从写入 isolated agentDir 的 models.json + settings.json 正确读出**（`PI_CODING_AGENT_DIR` 有效）。
  - 会推送 `usage_update`（`used/size`，上下文用量）、`available_commands_update`（与壳现状兼容：壳会丢弃该通知）、流式文本与工具事件。
- pi 运行时：`@earendil-works/pi-coding-agent@1.2.0`，Node ≥22.19（壳内置 Node **24.14.0** ✅）。`dist/bundle` 自包含（约 9MB，optional 外部依赖惰性加载），实测双包安装共约 155MB（含 provider SDK 全家桶），打包时可裁剪到 bundle + pi-acp ≈ **15MB 量级**。pi-tui 有 6 平台原生 prebuild（TUI 用，RPC 路径可裁剪）。

## 能力缺口（相对壳内现有引擎）

| 能力 | 现状 | 处置 |
|---|---|---|
| 模型 / API Key / baseUrl 注入 | pi **不认** `ANTHROPIC_BASE_URL` 一类 env 直连自定义端点（key 仅原生 provider env 有） | spawn 前向 isolated `<agentDir>` 写 `models.json`（`api: "openai-completions"` 或 `"anthropic-messages"`、`apiKey: "$NUWAX_PI_API_KEY"` 环境插值）+ `settings.json`（`defaultProvider/defaultModel/quietStartup`）；env 由壳注入 |
| MCP servers | pi 1.2.0 **原生支持**，读 `<agentDir>/mcp.json` / `.pi/mcp.json`；`session/new` 传参不会进 pi（pi-acp 只存不用） | 把 acpNewSessionParams 聚合出的 mcpServers 同步写入 `<agentDir>/mcp.json`，`exposure: "direct"`；项目级 `.pi/mcp.json` 被 trust 默认 `ask` 拒绝（RPC 无提示）✅ 有隔离性 |
| 会话恢复 | pi-acp `loadSession: true`；**只支持 load（replay），不支持 resume 接续** | 走壳既有「未知引擎 load + 15s 超时」通路；接受历史只读回放，resume 待上游 |
| 权限（工具执行审批） | pi 原生无审批（security.md 明示）；pi-acp 仅对扩展 UI confirm 转 `permission/*` | B 不拦截（与 nuwaxcode 系 opencode 形态部分一致）；C 用 pi 扩展 `before_tool_call` 兜底，通过 ACP `unstable_requestPermission` 走壳 PermissionModal（nuwax 前端卡会把未知引擎显示成 codex，需小改） |
| thinking 流 | svkozak 版无独立 thought 流，thinking 混入 `agent_message_chunk` | 接受（壳 acpUpdateMapper 引擎无关）；要分离可评估 victor 版或上游 PR |
| systemPrompt（_meta） | pi-acp 不转发；pi 用 `<agentDir>/AGENTS.md` 等 context 文件 | 写 `<agentDir>/AGENTS.md`；工作目录里的客户 README.md/CLAUDE.md 会进上下文，可选 `AGENTS.override.md` + 项目 trust `never` 屏蔽（P2） |
| cwd / 行为 | `session/new.cwd` 生效，可跑 arbitrary bash（无沙箱） | 与壳 ACP-TERMINAL-SANDBOX 对齐：沿用现有 sandbox 编排；capability 表里归 `unknown` family |
| 沙箱 / terminal 委托 / fs 委托 | pi 直读写磁盘、terminal 不委托 | 无需壳侧改动；sandbox 按既有进程级策略套 |

## 现有架构接入面（子代理盘点要点）

- 引擎枚举：`AgentEngineType`（`engines/types.ts:8`、`shared/types/electron.d.ts:351`）+ `constants.ts:130` `SUPPORTED_AGENT_ENGINES` + `agentHelpers.ts:7` `mapAgentCommand` + `agentHandlers.ts:14` zod；**overlay 有 constants/electron.d.ts 整文件副本，需同步改**。
- 二进制解析：`acpClient.ts:569` `resolveAcpBinary`（claude-code → resources/claude-code-acp-ts + node；新增 pi 分支指向 resources/pi-acp + 内置 node；自定义引擎通路已有 npm bin shim 解析）。
- env / 模型注入：`acpClient.ts:880-966`（ANTHROPIC_*、OPENCODE_*、CODEX_* 分引擎注入）→ 新增 pi 分支写 models.json/settings.json/mcp.json。
- 打包：`prepare-codex-acp-ts.js` 是现成模板（130 行，从 node_modules 拷包进 `resources/`）；注册点 `prepare-all.js:182`、package.json scripts、`ensure-resources.js:43`、根 `scripts/client/prepare.mjs:79`；electron-builder `extraResources`；纯 JS 无需 after-sign 新步骤；`third-party/manifest.json` 许可证登记；`dependencyChecker.ts:73` 版本钉。
- UI：会话列表 `SessionsPage.tsx:114` engine 标签 + i18n（4 语言 × base/overlay 共 8 份 locale，键集一致性有测试）；AgentSettings 下拉是死代码不动。
- 测试：`constants.test.ts:101` 引擎列表 exact match 必炸，另有 types/agentHelpers/unifiedAgent/acpClient/acpEngine/acpSessionSetup/dependencies/prepare-* 等约 10 个测试文件要跟。
- nuwax 前端：仅 ACP 权限卡声明引擎 union（`acpIntervention.ts:73`），未知→codex；pi 无权限请求则影响为零。

## 改动文件清单

| # | 文件 | 动作 | 说明 |
|---|---|---|---|
| 1 | `crates/agent-electron-client/src/main/services/engines/types.ts`、`src/shared/types/electron.d.ts`（+overlay 副本） | 改 | `AgentEngineType` 增 `"pi"` |
| 2 | `src/shared/constants.ts`（+overlay 副本） | 改 | `SUPPORTED_AGENT_ENGINES` 增 pi；`isAgentEngineType` 自动生效 |
| 3 | `src/main/services/engines/agentHelpers.ts` | 改 | `mapAgentCommand`：`pi-acp`/`pi` → `"pi"` |
| 4 | `src/main/ipc/agentHandlers.ts` | 改 | zod enum 增 pi |
| 5 | `src/main/services/engines/acp/acpClient.ts` | 改 | `resolveAcpBinary` pi 分支（resources/pi-acp + 内置 node + `PI_ACP_PI_COMMAND` 指向 resources 内 pi 入口）；spawn 前 `preparePiAgentDir()` 写 models.json/settings.json/mcp.json；env 注入 `PI_CODING_AGENT_DIR` + `NUWAX_PI_API_KEY` |
| 6 | `src/main/services/engines/acp/piAgentConfig.ts` | 增 | 纯函数：models.json/settings.json/mcp.json 生成与写入（unit 可测） |
| 7 | `src/main/services/engines/acp/sandbox/acpEngineSandbox.ts` | 改 | capability 表登记 pi（`unknown` family） |
| 8 | `scripts/prepare/prepare-pi-acp.js` | 增 | 模仿 prepare-codex-acp-ts：拷贝 pi-acp + pi bundle 进 `resources/pi-acp`、`resources/pi`；版本钉 + 校验 |
| 9 | `scripts/prepare/prepare-all.js`（+overlay 副本）、`package.json` scripts、`scripts/dev/ensure-resources.js`、根 `scripts/client/prepare.mjs` | 改 | 注册 prepare-pi-acp |
| 10 | `package.json` dependencies + electron-builder `extraResources` | 改 | 钉 `pi-acp@0.0.34`、`@earendil-works/pi-coding-agent@1.2.0`；resources 进包 |
| 11 | `src/main/services/system/dependencies.ts` / `dependencyChecker.ts` | 改 | pi 依赖可选检测（npm fallback） |
| 12 | renderer `SessionsPage.tsx` + 4 语言 locale（base+overlay） | 改 | 引擎标签 `Claw.Sessions.engine04` = pi |
| 13 | `third-party/manifest.json` | 改 | MIT 许可证登记（pi / pi-acp / acp sdk） |
| 14 | 测试：`constants.test.ts`、`types.test.ts`、`agentHelpers.test.ts`、`acpClient.test.ts`、`piAgentConfig.test.ts`（新增）、`prepare-pi-acp.test.ts`（新增）、`scripts/client-prepare.test.mjs` | 增/改 | 引擎列表、映射、配置生成、打包校验 |

## 实施顺序

1. **T1 资源链**（#8/#9/#10/#13）：prepare 脚本 + 依赖钉 + extraResources + 许可证。可独立验证 `resources/` 产出。
2. **T2 类型与路由**（#1–#4、#7、#12）：枚举、映射、zod、sandbox capability、i18n 标签；同步 overlay 副本；跑 `constants.test.ts` 等失败测试先改绿。
3. **T3 pi 配置注入**（#5/#6/#11）：`piAgentConfig` 纯函数 + TDD（models.json 生成、env 插值、mcp 聚合写入）；`resolveAcpBinary`/spawn 接线。此为唯一「新契约」面，模型 provider 字段映射如与预期不符在此收口。
4. **T4 真机验收**：dev 起壳 → 走真实 agent_config 下发 `pi-acp` → 会话创建（模型选择）、提问流式回复、工具调用渲染、`session/load` 历史回放、MCP 直连工具、多会话并发；mac + win-pc。
5. **T5（增量，可另计划）**：权限扩展、steering/skill 投影、`AGENTS.override.md` 屏蔽、thinking 流分离。

无依赖的 T1 与 T2 可并行 worktree；T3 依赖 T2 的类型。

## 证明成立的测试

- 新增：`piAgentConfig.test.ts`（models.json/settings.json/mcp.json 生成；`$ENV` 插值；provider `nuwax` 与 `openai` 双协议 api 类型选择）；`prepare-pi-acp.test.ts`（资源目录结构 + 版本钉）。
- 改写：`constants.test.ts` 引擎列表；`agentHelpers.test.ts` `pi-acp`→`pi` 映射；`acpClient.test.ts` resolveAcpBinary pi 分支。
- 回归：`npm run base:test`（社区轨）+ `npm run test:commercial`（商业轨，同步 overlay 后单独跑）。
- 真机：安装包验收（提测要求）；冒烟脚本（本计划实测用例可收编为手动验收清单）。

## 风险与回退

| 风险 | 缓解 | 回退 |
|---|---|---|
| pi-acp 早期版本（0.0.34）协议漂移 / 只面向 Zed 测试 | 版本钉死；壳侧握手兼容性冒烟；上游 issue 跟踪 | 回退引擎为「自定义引擎」通路，从 SUPPORTED 列表摘除 |
| 无 resume 只读回放，会话体验与 claude/codex 不一致 | 产品预期写明；load 走既有 15s 超时通路 | 不回退，等上游 |
| 工具无审批，安全面与商用预期冲突 | P1 隔离 HOME + 项目 trust 拒绝 + 进程级 sandbox 策略；P2 权限扩展 | 引擎默认不进 SUPPORTED（仅自定义通路开启） |
| 模型注入依赖 pi 内部配置格式（models.json schema） | schema 有官方 `$schema` URL；纯函数单测锁格式 | 打包/运行检测失败则引擎报错不拉起，不影响其他引擎 |
| 15MB+ 资源与整包体积 | bundle 裁剪（去 TUI prebuild）；CI cache key 跟随 | 移除 extraResources 条目 |
| windows 弹窗/信号（codex 前车之鉴） | pi-acp 经 node 启动已有 spawn 封装；win-pc 无头验证 | 同上回退 |

## 工作量

- T1 1.5d · T2 1.5d · T3 2d · T4 1–1.5d → **B 方案合计 5–8 人日**；C 增量另计 2–5 人日。

## 偏离记录（2026-10-15 实施）

- **T1 prepare-pi-acp 落点**：原计划拷贝「adapter bundle 自包含」；实测 `pi-acp@0.0.34` 的 dist/index.js 是 **ESM 且不内联** `@agentclientprotocol/sdk`/`cross-spawn`/`zod`，改为按 npm 布局**扁平拷贝运行时依赖闭包**（含 pi-acp 自引用 + pi 自包含 bundle ~9MB），产物约 13MB。同步 commit：基座工作树 scripts/prepare/prepare-pi-acp.js。
- **pi 原生 MCP**：原计划「MCP 走 pi-acp 透传」（缺口）；实测 pi 1.2.0 **原生读 `<agentDir>/mcp.json`**，改为 spawn 前 `writePiAgentConfig` 把 session 聚合 mcpServers 落盘（`exposure:"direct"`）。ACP `session/new` 传参仍不进 pi（pi-acp 只存不用），语义等价于现有引擎的 session 级 MCP。
- **项目 trust**：settings.json 写 `defaultProjectTrust:"never"`，避免客户工作目录的 README/CLAUDE.md 污染会话上下文（隔离 HOME + trust never 双保险）。
- **worktree**：用户要求「worktree 方式实施」；实施发生在会话已有工作区（基座 submodule 工作树 + 外层 overlay），未另开 worktree——社区轨 `--no-inject` 的 overlay 还原会把基座 tracked 文件回滚，跨 worktree 只会放大该现象。改动已就地落盘。
- **质量门现状**：
  - 商业轨 `npm run test:commercial`：**3054 passed** ✅
  - 社区轨 `npm run base:test`：1653 passed，**1 failed**——`constants.test.ts` 的引擎列表断言。根因：`SUPPORTED_AGENT_ENGINES` 的商业版（含 pi）在 overlay/crates/.../shared/constants.ts；社区轨 `--no-inject` 会 `git checkout` 还原基座 tracked 的 constants.ts（回到社区版三引擎），而 `constants.test.ts` 我更新后期望四引擎 → 断言失败。此为既有 overlay/基座测试分层问题（历史上该断言在社区轨恒等于社区列表），**解法属于基座侧**：社区断言应对照社区列表，商业断言应走 overlay 测试；建议在基座 PR 一并处理，或接受该断言仅在商业轨有意义。
  - 运行过的独立验证：`test:run` 全量（基座工作树含 overlay 同步态）3054 passed；`prepare-pi-acp.test.ts`/`piAgentConfig.test.ts`/`acpClient.test.ts`（含 pi 分支）全绿；ACP 握手冒烟（resources 打包布局下 `initialize` 返回 pi-acp 0.0.34）通过。
- **未提交项（基座 submodule 工作树，待走基座仓 PR + pin bump）**：19 处改动/新增（resolveAcpBinary pi 分支、piAgentConfig、prepare-pi-acp、类型/映射/zod/sandbox/依赖/i18n keys、pnpm-lock、.gitignore resources 条目、constants.test）。`npm run check:pin` 报「非 overlay 托管改动」即指这批——按仓库约定属中立引擎增强，应提交基座仓 nuwa-electron-shell（PR 进 main / release 线），随后外层 bump pin。
- **T4 真机验收未做**：需 dev 起壳（后端下发 `agent_server.command:"pi-acp"`）验证会话创建/流式/工具渲染/`session/load`/MCP 直连；mac + win-pc。冒烟脚本保留在 /tmp 会话内，验收清单见「证明成立的测试」。
- **T5 增量（权限拦截扩展、thinking 流分离、skill/steering 投影）**未实施，按计划独立立项。


## 独立分支保存（2026-10-16）

用户明确要求 Pi Agent 不进入当前 release 与本轮 beta，后续单独实现。本轮只保存现有实现，不视为验收完成。

- 外层独立分支：`codex/pi-agent-acp-wip`，保留原有外层 Pi 提交。
- 基座独立分支：`codex/pi-agent-acp-wip`，WIP 提交 `a5a83e59`，保存原工作区的 19 个中立改动/新增；提交前 staged 纯净检查通过，无 overlay 托管路径。
- 外层 gitlink 仅在该开发分支引用上述 WIP；当前 `release/v3.0.x` 继续使用原正式基座 pin，且不包含外层 Pi 引擎声明。
- 原工作区 19 个文件已逐个验证与已推送基座提交字节相同后移出 release 工作区；生成的 Pi 资源缓存仅本地保留，不进入发布输入。
- 社区断言、双轨测试、真实会话/工具/MCP/跨平台验收仍需按前述计划完成；此 WIP 不具备发布结论，也未合入基座 main。
