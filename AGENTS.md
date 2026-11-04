# nuwax-client · Agent 速览

开发工具链验收优先使用仓内 `.agents/skills/verify-nuwax-client/SKILL.md`：
`npm run verify:tooling -- --output <仓外证据目录>`。配方覆盖 doctor 结构、CLI、启动管理和缓存回归，结果为 source-tooling 层级；真实 Electron 界面及安装包另行验收。

（由 nuwa-sdlc-kit 创建骨架，仓库内容请自行补全。）

<!-- nuwa-sdlc-kit:begin v1（安装器托管区间，勿手工增删行；本节外的 AGENTS.md 内容归仓库所有） -->

## AI SDLC 规则层

- **需求分级，按大小走流程（勿为小修生成工件拖时间）**：① 小修/BUG 修复——改动 ≤3 文件、无新接口契约、无跨模块联动、无需产品拍板，且改前能一句话说清「改什么、为什么」——不建 intent/spec/plan，直接改 + 跑该域质量门测试；② 中等需求只出 `plans/*-plan.md` 一件；③ 新功能/大需求/跨模块才走完整链 skills `requirement-analysis` → `plans/*-intent.md`、`grill-with-docs` → `specs/<slug>.md` → Plan mode 产物 `plans/*-plan.md`（模板在 `templates/`）。
- 源码首改会被 `.claude/hooks/plan-gate.mjs` 提醒一次（同会话只问一次）：**小修/BUG 直接重试刚才的编辑即放行，无需任何工件**；大需求先备 `plans/` 工件再动源码。`NUWACLAW_SKIP_PLAN_GATE=1` 停用；秘钥由 `.claude/hooks/guard-paths.mjs` 拦截（`.env*`/证书/credential 类拒读写，example 豁免）。
- 大量代码合并主干分支前（提测/发版/特性分支大批量合入）走 skills `pre-commit-quality-review`（slash command `/quality-review` 可直接点名）三问自查整个待合并批次——功能逻辑内聚 / 代码分层 / 可维护性，带证据给结论、质量门测试绿了再合并；日常小 commit 可跳过。
- **CI 缓存配方纪律**：`scripts/client/native-build-cache.mjs` 的 HELPER_RECIPE/CAPTURE_RECIPE 只收「字节影响产物」的文件；传输/上报层（`build-resource-artifacts.mjs`、`resource-report.mjs`）刻意不在配方内——改它们（告警、日志、上传策略）不得灭缓存。要**有意**全平台冷编（暂存文件集/manifest 准入契约变更）时 bump `core.mjs` 的 `RESOURCE_STAGING_CONTRACT`；可观测性小改动攒批次上，别单独付五平台冷编税（beta.9/beta.11 各付过一次）。
- PR 评审对照根目录 `REVIEW.md` 五遍清单（nit≤5；writer 不自批）。
- **单一事实源**：本文件是正文（根 CLAUDE.md 已存在，建议人工收敛为单行 `@AGENTS.md` 指针）；勿复制出第二份。

### 非 Claude Code agent 兼容

- 本文件、`templates/`、`REVIEW.md`、skills 正文全是纯 markdown：skills 双落点播种 `.claude/skills/` 与 `.agents/skills/`（后者供 ZCode workspace 级自动发现）；codex / opencode / cursor 等**直接读任一副本即可**，需要某条流程时让 agent `cat <落点>/<name>/SKILL.md` 照做。
- 强制机制差异：PreToolUse hooks 在 Claude Code（`.claude/settings.json`）与 ZCode（`.zcode/config.json`，v1.3.0 起由安装器合入）都强制执行；其余 agent 的兜底 = 提交前按同一规则自查，非协商护栏建议下沉 git pre-commit / CI（agent 无关的强制地板）。
- verifier 等价物：任何 agent 跑 `npm run test:commercial` 按报告格式贴结论即可，不必有子代理机制。

<!-- nuwa-sdlc-kit:end -->

## 本仓效率规则（优先于上方安装器默认流程）

- 已取消源码首次编辑的 plan hook，不因缺少工件阻断编辑。按需求不确定性和行为风险分级，不以文件数量机械判级；小修直接改和验证，中等改动最多一份计划，大需求只为尚待确认的边界补必要规格。
- 日常验证选择覆盖改动行为的最小测试集；文案、样式和无行为变化的整理不要求新增单测。不要求“失败测试先提交”的提交顺序，也不要求每个 PR 在本地重跑商业全量。
- 单测保护可观察行为、错误恢复和权限/数据边界；不为限制函数拆分或纯源码写法写测试。命名、数据格式若参与运行逻辑，仍属需验证的契约。无生产调用的旧实现与其孤立测试一起清理，重复断言可合并；不能用删失败用例掩盖未解决的缺陷。
- 涉及同一批代码且输入、环境仍有效的验证结果可复用。集成/发布仍执行 CI 完整门禁；平台相关行为保留相应实机或安装包验收。审查和验证按风险选取，不要求机械重复五遍或重复生成报告。
- 凭据、页面来源授权、产品数据隔离、宿主桥契约和发布来源校验继续保留；已取消的 plan hook 不应随工具升级重新启用。

## 术语速记：Nuwax 客户端 vs nuwax 前端（同名不同物）

- **Nuwax 客户端**（文档/对话中也称**商业版**，相对社区版 NuwaClaw）= 本仓（nuwax-client）产出的 Electron 桌面壳产品：productName=Nuwax、identifier=nuwax、数据目录 `~/.nuwax`、通道 nuwax-electron。
- **nuwax 前端** = 仓库 [nuwax-ai/nuwax](https://github.com/nuwax-ai/nuwax)（包名 `nuwax-frontend`）：线上 PC web 与客户端 webview 内嵌 UI **同源**；本仓以壳根 `nuwax/` submodule 引用源码（当前 feat-2026.11 线 pin），`nuwax-dist/` submodule 固定对应产物仓 `main`。`nuwax/dist` 仅作本地构建暂存，永不提交源码仓；mac dev 另有独立检出 `~/workspace/nuwax`。
- 判别口径：代码/请求里作为**宿主标识**出现的 `nuwax`（`x-client-type` 头、桥 `getProduct()`/HostProductId）指「Nuwax 客户端宿主」，与前端仓名同字不同义；作为仓库名/包名/路径/分支出现则指前端项目。详见 README「术语区分」一节。

## Agent / 开发者脚本入口

- 从壳根运行 `npm run doctor -- --json` 检查环境；`npm run dev` 自动准备并消费产物 pin，前端开发用 `npm run dev -- --frontend source`。
- `npm run frontend:build` 单独生成并保留 `nuwax/dist`；`npm run pack` 生成当前平台无签名商业包，`--frontend source` 将当前源码改动构建入包。Windows 原生命令行可直接运行 npm 入口。
- `npm run sub:update` 拉源码、构建、提交并默认推送产物仓、提交双 pin；`--push` 才推外层当前分支。`--no-commit` 全链不提交推送，不得配 `--push`。所有推送不强推，保留无关 WIP。
- 非敏感配置集中在 `client.config.mjs`；缓存按输入与 ABI/平台/架构校验，自有源码资源缓存不覆盖开发者 `sources/`。`--refresh-resources` 显式刷新资源，开发保留 Vite 缓存。
- `npm run release -- --version X.Y.Z[-beta.N] --dry-run` 先预检；新 tag 统一 v，通道由完整版本推导（--channel 仅校验），--tag 续跑历史发布。stable 默认停在签名阶段，安装包验收后 --stage sync 公开；SimplySign 手机认证保留人工操作。stable CI 消费 nuwax-dist pin，beta CI 从源码 pin 构建；产物仓不得重写仍被引用的提交历史。
- 正式打包仅 Beta / Stable。构建验证走独立 `package-validation.yml`，应用版本沿用已存在的 Beta/Stable 基线，产物用 SHA/run id 区分；不占用新版本，不创建 tag/Release，不改更新指针。同一问题跨 commit、run、rerun 最多启动 4 次，达到上限停止并报告；不得换版本或系列绕过。停止后保留证据，须用户明确重新启动验收，不能自行继续出包。

## 当前发布排除项（2026-11-02）

- 按用户决定，终端持久化、跨会话终端保活、多终端及运行实例管理暂不进入 `release/v3.1.0`。更新 `nuwax/` 源码与 `nuwax-dist/` 产物 pin 时须同时核对排除项，不能从 `feat-2026.11` / `dev` / `test` 间接带入。候选保留在独立历史/分支，重新纳入须用户明确授权；任务终态恢复修复（NW-081）继续保留。

## 商业版登录与服务边界

- 商业版不导入任何历史产品目录；后端签发的 `ticket` cookie 为登录事实源，`savedKey/configKey` 仅为当前设备注册结果。升级后清除旧 `ACCESS_TOKEN` 并重新登录。
- 注册、启停、登出失效与换域统一由主进程 commercialAuth + AuthLifecycle 编排；renderer 不另起自动注册或启动链。迟到注册响应必须在写库前校验会话代次。
- 企业登录和设置页修改域名必须共用 configureServerHost；不得直接写域名后继续使用旧 cookie 会话或代理配置。
- 未登录只运行页面所需的 loopback gateway。商业版不按端口杀未知进程，避免干扰 NuwaClaw/CLI。
- **壳（`nuwa-electron-shell/`）是本仓直接维护的源码目录**。客户端能力、产品行为和构建实现都随 nuwax-client 提交与评审，开发和发布入口统一从仓库根执行。
- 门禁命令：`npm run test:commercial`（不注入构建身份，保留缺省值与专项身份断言）；CI（ci.yml）单 commercial job。提测还须验证真实安装包。分支模型为单主干（feat 线 PR 进 main）；仅 `nuwax/`、`nuwax-dist/` 仍为 submodule pin，勿 rebase 改写已 pin 的 SHA。

## 文件面板回归边界

- 文件入口按 `specs/local-file-management.md` 分工；文件树面板功能与会话附件发送是两条链路，会话框此次仅含目录选择。
- 修改本机来源或恢复逻辑时，须覆盖“同电脑新会话服务未就绪”和“首次工作区解析失败后主动重试”；仅测已成功解析的会话，不能证明失败不回云端或重试可恢复。

## 当前入口与历史资料

- 当前开发流程以根 README、`docs/architecture.md`、`docs/npm-scripts.md`、`docs/release-channels.md` 为准。
- 带日期的设计、计划、验收和历史发布记录保留当时事实；其中独立基座、覆写层及旧命令不作为当前操作指令。第三方来源与许可证信息保留。
- 日常使用根 `setup / dev / pack / release / test:commercial`；定向壳命令使用 `shell:exec`。内部包名、协议字段和兼容标识不随文档清理改名。
