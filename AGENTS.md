# nuwax-client · Agent 速览

（由 nuwa-sdlc-kit 创建骨架，仓库内容请自行补全。）

<!-- nuwa-sdlc-kit:begin v1（安装器托管区间，勿手工增删行；本节外的 AGENTS.md 内容归仓库所有） -->

## AI SDLC 规则层

- 需求→规格→计划链：skills `requirement-analysis` → `plans/*-intent.md`、`grill-with-docs` → `specs/<slug>.md` → Plan mode 产物 `plans/*-plan.md`（模板在 `templates/`）。
- 源码首改会被 `.claude/hooks/plan-gate.mjs` 追问一次计划工件（同会话只问一次；`NUWACLAW_SKIP_PLAN_GATE=1` 停用）；秘钥由 `.claude/hooks/guard-paths.mjs` 拦截（`.env*`/证书/credential 类拒读写，example 豁免）。
- 大量代码合并主干分支前（提测/发版/特性分支大批量合入）走 skills `pre-commit-quality-review`（slash command `/quality-review` 可直接点名）三问自查整个待合并批次——功能逻辑内聚 / 代码分层 / 可维护性，带证据给结论、质量门测试绿了再合并；日常小 commit 可跳过。
- PR 评审对照根目录 `REVIEW.md` 五遍清单（nit≤5；writer 不自批）。
- **单一事实源**：本文件是正文（根 CLAUDE.md 已存在，建议人工收敛为单行 `@AGENTS.md` 指针）；勿复制出第二份。

### 非 Claude Code agent 兼容

- 本文件、`templates/`、`REVIEW.md`、skills 正文全是纯 markdown：skills 双落点播种 `.claude/skills/` 与 `.agents/skills/`（后者供 ZCode workspace 级自动发现）；codex / opencode / cursor 等**直接读任一副本即可**，需要某条流程时让 agent `cat <落点>/<name>/SKILL.md` 照做。
- 强制机制差异：PreToolUse hooks 在 Claude Code（`.claude/settings.json`）与 ZCode（`.zcode/config.json`，v1.3.0 起由安装器合入）都强制执行；其余 agent 的兜底 = 提交前按同一规则自查，非协商护栏建议下沉 git pre-commit / CI（agent 无关的强制地板）。
- verifier 等价物：任何 agent 跑 `npm run base:test` 按报告格式贴结论即可，不必有子代理机制。

<!-- nuwa-sdlc-kit:end -->

## 术语速记：Nuwax 客户端 vs nuwax 前端（同名不同物）

- **Nuwax 客户端**（文档/对话中也称**商业版**，相对社区版 NuwaClaw）= 本仓（nuwax-client）产出的 Electron 桌面壳产品：productName=Nuwax、identifier=nuwax、数据目录 `~/.nuwax`、通道 nuwax-electron。
- **nuwax 前端** = 仓库 [nuwax-ai/nuwax](https://github.com/nuwax-ai/nuwax)（包名 `nuwax-frontend`）：线上 PC web 与客户端 webview 内嵌 UI **同源**；本仓以壳根 `nuwax/` submodule 引用（feat-dong.0930 线 pin、dist 随仓提交），mac dev 另有独立检出 `~/workspace/nuwax`。
- 判别口径：代码/请求里作为**宿主标识**出现的 `nuwax`（`x-client-type` 头、桥 `getProduct()`/HostProductId）指「Nuwax 客户端宿主」，与前端仓名同字不同义；作为仓库名/包名/路径/分支出现则指前端项目。详见 README「术语区分」一节。

## 商业版登录与服务边界

- 商业版不导入任何历史产品目录；ACCESS_TOKEN 为登录事实源，savedKey/configKey 仅为当前设备注册结果。
- 注册、启停、登出失效与换域统一由主进程 commercialAuth + AuthLifecycle 编排；renderer 不另起自动注册或启动链。迟到注册响应必须在写库前校验会话代次。
- 企业登录和设置页修改域名必须共用 configureServerHost；不得直接写域名后继续使用旧 token 或代理配置。
- 未登录只运行页面所需的 loopback gateway。商业版不按端口杀未知进程，避免干扰 NuwaClaw/CLI。
- base:test 会清 overlay，必须在隔离副本运行；商业测试需同步 overlay 后单独运行，提测还须验证真实安装包。
- 双轨门禁命令：社区 `npm run base:test`、商业 `npm run test:commercial`（--no-env：同步 overlay 不注 env）；CI（ci.yml）双 job 各跑一轨。
- 提交基座前必须 `npm run check:pin`：基座脏文件/staged 不得混入 overlay 托管路径（CI 另有 --remote origin/main 字节级防线）。分支模型为单主干（feat 线 PR 进 main，pin 跟随 main），勿 rebase 改写已 pin 的基座 SHA。
