# nuwax-client · Agent 速览

## 开发与验证

- 小修按行为风险判断，直接修改并验证受影响部分，不按文件数量升级流程。复杂需求最多维护一份 `plans/*-plan.md`；已有计划直接更新，长期接口约束写入现行契约文档。
- 不要求 intent → spec → plan 串行工件、测试先提交或为已覆盖的小修新增测试。注释解释约束、并发或平台差异；不记录开发流水账。
- 评审统一按 `REVIEW.md` 检查一次，复用已有结果；日常不自动启动额外质量自查或独立验证代理。
- 本地优先运行相关测试：脚本用 `node --test scripts/<name>.test.mjs`；商业源码在已同步的基座 crate 内运行 `vitest run <相关文件>`。修改后需要同步时使用 `npm run overlay:sync`，保留无关 WIP。
- CI 按改动域选择检查，发布调用完整门禁；未知代码或依赖改动回退完整源码检查。完整测试入口和触发规则见 `docs/npm-scripts.md`。
- 保留凭证与发布保护。`.claude/` 与 `.agents/` 的技能内容保持一致，按需读取；不默认遍历历史计划、规格或验收记录。


## 术语速记：Nuwax 客户端 vs nuwax 前端（同名不同物）

- **Nuwax 客户端**（文档/对话中也称**商业版**，相对社区版 NuwaClaw）= 本仓（nuwax-client）产出的 Electron 桌面壳产品：productName=Nuwax、identifier=nuwax、数据目录 `~/.nuwax`、通道 nuwax-electron。
- **nuwax 前端** = 仓库 [nuwax-ai/nuwax](https://github.com/nuwax-ai/nuwax)（包名 `nuwax-frontend`）：线上 PC web 与客户端 webview 内嵌 UI **同源**；本仓以壳根 `nuwax/` submodule 引用源码（feat-2026.9.30 线 pin），`nuwax-dist/` submodule 固定对应产物仓 `main`。`nuwax/dist` 仅作本地构建暂存，永不提交源码仓；mac dev 另有独立检出 `~/workspace/nuwax`。
- 判别口径：代码/请求里作为**宿主标识**出现的 `nuwax`（`x-client-type` 头、桥 `getProduct()`/HostProductId）指「Nuwax 客户端宿主」，与前端仓名同字不同义；作为仓库名/包名/路径/分支出现则指前端项目。详见 README「术语区分」一节。

## Agent / 开发者脚本入口

- 从壳根运行 `npm run doctor -- --json` 检查环境；`npm run dev` 自动准备并消费产物 pin，前端开发用 `npm run dev -- --frontend source`。
- `npm run frontend:build` 单独生成并保留 `nuwax/dist`；`npm run pack` 生成当前平台无签名商业包，`--frontend source` 将当前源码改动构建入包。Windows 原生命令行可直接运行 npm 入口。
- `npm run sub:update` 拉源码、构建、提交并默认推送产物仓、提交双 pin；`--push` 才推外层当前分支。`--no-commit` 全链不提交推送，不得配 `--push`。所有推送不强推，保留无关 WIP。
- 非敏感配置集中在 `client.config.mjs`；缓存按输入与 ABI/平台/架构校验，自有源码资源缓存不覆盖开发者 `sources/`。`--refresh-resources` 显式刷新资源，开发保留 Vite 缓存。
- `npm run release -- --version X.Y.Z[-beta.N] --dry-run` 先预检；新 tag 统一 v，通道由完整版本推导（--channel 仅校验），--tag 续跑历史发布。stable 默认停在签名阶段，安装包验收后 --stage sync 公开；SimplySign 手机认证保留人工操作。stable CI 消费 nuwax-dist pin，beta CI 从源码 pin 构建；产物仓不得重写仍被引用的提交历史。

## 商业版登录与服务边界

- 商业版不导入任何历史产品目录；后端签发的 `ticket` cookie 为登录事实源，`savedKey/configKey` 仅为当前设备注册结果。升级后清除旧 `ACCESS_TOKEN` 并重新登录。
- 注册、启停、登出失效与换域统一由主进程 commercialAuth + AuthLifecycle 编排；renderer 不另起自动注册或启动链。迟到注册响应必须在写库前校验会话代次。
- 企业登录和设置页修改域名必须共用 configureServerHost；不得直接写域名后继续使用旧 cookie 会话或代理配置。
- 未登录只运行页面所需的 loopback gateway。商业版不按端口杀未知进程，避免干扰 NuwaClaw/CLI。
- base:test 会清 overlay，必须在隔离副本运行；商业测试需同步 overlay 后单独运行，提测还须验证真实安装包。
- 双轨门禁命令：社区 `npm run base:test`、商业 `npm run test:commercial`（--no-env：同步 overlay 不注 env）；CI（ci.yml）双 job 各跑一轨。
- 外层版本线使用 `release/v<major>.<minor>`（当前 `release/v3.1`）；人和 Agent 统一按工作性质使用 `feat/`、`fix/`、`refactor/`、`chore/`、`docs/`，从目标线创建并经 PR 回流；隔离 QA 用 `qa/<完整 QA 版本>`。分支与合并方向见 `docs/branch-naming.md`。
- 提交基座前必须 `npm run check:pin`：基座脏文件/staged 不得混入 overlay 托管路径（CI 另有 --remote origin/main 字节级防线）。基座保持单主干（任务线 PR 进基座 main，pin 跟随 main），勿 rebase 改写已 pin 的基座 SHA。
