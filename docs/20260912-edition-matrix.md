# 三版横向对比：社区版 NuwaClaw · 基座 nuwa-electron-shell · 商业版 Nuwax

- 记录日期：2026-09-12
- 口径：**基座** = 共享 Electron 壳仓 `nuwax-ai/nuwa-electron-shell`；**社区版** = 外层仓 `nuwaclaw` 以子模块消费基座所得产品 NuwaClaw；**商业版** = 本仓 `nuwax-client` 以子模块消费基座 + `overlay/` 覆写所得产品 Nuwax。
- 核实方式：本文数据取自本轮实际执行的仓库检查（子模块 pin、`git show` 提交树、package.json、测试与打包运行结果）。**社区版本轮未做运行态验证**，其状态为代码与仓库事实，非运行实测。

## 一、仓库拓扑

```
nuwa-electron-shell（基座，公开仓）
├─ crates/agent-electron-client      共享 Electron 壳（默认社区身份 nuwaclaw）
├─ crates/agent-gui-server, agent-kit, windows-sandbox-helper …
└─ 被两个外层仓以 git submodule 消费
   ├─ nuwaclaw（社区版 NuwaClaw）     无 overlay；pin 9fb6f4f2（2026-09-09）
   └─ nuwax-client（商业版 Nuwax）    overlay/ 商业覆写 11 文件；pin ae7e21aa
```

外层仓的分工差异：

| | 社区版 nuwaclaw | 商业版 nuwax-client |
|---|---|---|
| 业务代码来源 | 基座子模块（仓内 `crates/` 只是构建产物目录） | 基座子模块 + `overlay/` 覆写 |
| 产品差异载体 | 无（直接跑基座默认身份） | `overlay/` 11 文件 + 构建期 env 注入 |
| 前端 | `nuwax` 子模块（dist 随仓提交） | 同左（`nuwax`@feat-dong.0930） |

## 二、构建与身份对照

| 维度 | 基座（默认值=社区身份） | 社区版 NuwaClaw | 商业版 Nuwax |
|---|---|---|---|
| 应用标识 `APP_NAME_IDENTIFIER` | 常量默认 `nuwaclaw` | `nuwaclaw`（构建无 env 注入） | `nuwax`（构建期注入 `NUWAX_APP_IDENTIFIER`） |
| productName / 包名 | 无（由消费方定） | NuwaClaw / `@nuwax-ai/nuwaclaw` | Nuwax / `@nuwax-ai/nuwax` |
| appId | 无 | `com.nuwax-ai.nuwaclaw` | `com.nuwax-ai.nuwax` |
| 数据目录 | `.${APP_NAME_IDENTIFIER}` | `~/.nuwaclaw` | `~/.nuwax` |
| Electron 用户目录 | 由 identifier 派生 | `%APPDATA%\NuwaClaw` 等同源值 | `Application Support/Nuwax`（实测） |
| 端口 | 基线 60xxx（常量直出） | 60002–60009、60173、18099 | **+1000**：61002–61009、61173、19099（`NUWAX_PORT_OFFSET` 构建期注入） |
| 设备身份盐 | 按 identifier 选盐 | `nuwax-agent` | `nuwax:device:v1` |
| 构建入口 | `base:install` / `base:dev` / `base:test` | 同上（社区默认身份） | 同步 overlay 后 `npm run build` + `electron-builder`（注 env） |
| 版本线 | — | 外层发布说明停在 **0.11.35**（差分更新验证版）；pin 内应用 version 1.0.0 | **1.0.3 已转正**；1.0.4 已出包（`1.0.4-qa.20260912`）待发 |

端口错开是三方同机共存的基础：社区 60xxx、商业 61xxx、nuwa-cli（gateway 60016 / file-server 60015 / lanproxy 10076）互不冲突，因此**同机可双开**。

> 注：基座常量 `DEFAULT_SERVER_HOST` 为 `https://agent.nuwax.com`，社区版是否覆盖该默认值本轮未核实。

## 三、能力对照

| 能力域 | 基座 | 社区版 NuwaClaw | 商业版 Nuwax |
|---|---|---|---|
| 登录态事实源 | webview 为准（基座 `a62e2802` 重构：`auth.*` 桥 + token 注入 + 启动大 loading） | **未跟进**（pin 落后，树内仍有 `SetupWizard.tsx` 与壳内登录表单） | 基座能力 + overlay `commercialAuth.ts` 商业注册编排 |
| 注册（reg） | 提供 `AuthLifecycle` 机制与注入点 | 基座原行为 | overlay 注入：仅 Bearer + 商业独立 deviceId；401/4010/4011 视为登录失效并回调清理 |
| 服务起停与登录联动 | 提供机制（`serviceHandler` 门禁、`startup.ts` 网关独立初始化） | 启动期无条件拉起 ComputerServer/ttyd/沙箱 | 跟随登录起停；未登录只运行页面网关；停服失败如实返回可重试 |
| 企业登录 / 换域 | 提供 `configureServerHost` 桥 | 基座原行为 | 事务化换域：阻止旧任务→清认证→停服→切网关→载新域；回切亦须重登 |
| 设备身份隔离 | 机制：按 identifier 选盐 | `nuwax-agent`（与商业旧值相同） | `nuwax:device:v1` |
| 旧产品目录隔离 | 目录名由 identifier 派生 | 只读写 `.nuwaclaw` | 不导入/不迁移/不删除 `.nuwaclaw` 等四个目录（迁移期显式早退） |
| 与 NuwaClaw 同机 | — | — | 不按端口杀未知进程；数据目录/端口/设备身份三重错开 |
| 文件链路 | 网关流式反代 + `saveResponse` 原子落盘 | 基座原行为 | 另存图片支持相对地址、临时文件原子替换、失败清理残片 |
| 首装初始化 | 依赖安装流（bundled > npm 兜底 > OSS 下载） | 未跟进（pin 落后） | 同基座 + 迁移期禁旧产品数据 |
| 启动动画 | `MIN_SPLASH_MS=800` 连续计时 + 探询超时降级 | 未跟进 | 同基座 |
| 壳层顶栏 UI | 一体化顶行 + 自绘菜单栏 + 侧栏整栏收起 + 平台化避让（`0d60ec3b` 一线） | 未跟进 | 同基座 + 电脑名 tooltip |
| 多语言 | 默认简体中文、webview→壳实时同步 | 未跟进 | 同基座 |
| 实验功能（Sandbox / GUI MCP） | **保留**（SettingsPage 22 处引用） | **保留**（22 处） | **移除**：无 UI 入口 + 迁移强制关闭历史开关（0 处） |
| 打包签名 | 提供构建脚本与符号链接清洗 | 沿用 | mac 双架构签名公证（1.0.3 起）；Windows 保留手签流程 |
| 更新通道 | — | `nuwaclaw` 通道（0.11.x 差分更新已验证） | `nuwax-electron` 通道 |

**关键差距**：社区版当前 pin（9fb6f4f2）落后基座本次分支点 **26 个提交**，上表中「未跟进」项即由此而来——这些能力都在中立基座里、社区兼容（社区基线 1263 条测试全绿），只是社区仓还没 bump pin。

## 四、代码构成：基座中立机制 vs overlay 商业覆写

商业版与社区版的**产品差异全部走 overlay**（改商业行为必须改 `overlay/` 源文件，直接改工作树会被 `sync-overlay` 单向覆写）：

| overlay 文件 | 商业语义 |
|---|---|
| `main/ipc/commercialAuth.ts`（+ 测试） | 注册编排：Bearer + 独立 deviceId、失效回调 |
| `main/ipc/nuwaxBridgeHandlers.ts`（+ tokenScopes 测试） | 桥总装：服务编排、换域事务、另存图片、会话代次 |
| `main/bootstrap/migrate.ts`（+ commercial 测试） | 迁移：不导入旧产品目录、强制关闭实验开关 |
| `main/services/loopbackGateway/index.ts`（+ gateway.ts 及测试） | 业务域网关：运行时键携带 backend、域名变更通知 |
| `renderer/components/pages/SettingsPage.tsx` | 移除实验功能区块与 guiMcpPort 字段 |

基座侧则只落**中立机制**（`APP_NAME_IDENTIFIER` 门控 / 可注入的 `AuthLifecycle`），社区路径行为不变。提交边界：基座提交**排除**这 11 个 overlay 产物，否则商业代码会泄回中立基座。

## 五、测试与门禁对照

| 门禁 | 命令 | 覆盖 | 本轮结果 |
|---|---|---|---|
| 社区基线 | 隔离副本 `npm run base:test` | 干净基座 + 社区默认身份（会先 `sync-overlay --clean`） | 107 files / **1263 passed** / 17 skipped |
| 商业侧 | `node scripts/sync-overlay.js` 后 `npx vitest run` | 基座 + overlay 产物 | 111 files / **1309 passed** / 17 skipped |
| 类型 | `npx tsc --noEmit` | 全仓 | 202 条（HEAD 基线 212 条），改动/新增文件 0 条 |

⚠️ `base:test` 会清理工作树内的 overlay 产物，**必须在隔离副本运行**，否则会破坏商业侧工作树。

## 六、商业版功能需求清单

### 已完成

**登录态架构（1.0.3 正式版交付）**：webview 为唯一事实源，壳侧不再维护独立登录体系；reg 与壳侧后端调用统一注入 Bearer；登录成功自动「注册同步 → 重启服务」；登出/失效自动停服清态；启动重连凭证优先，quickInit 无界面部署兼容；删除壳内登录表单与 SetupWizard。

**企业登录与换域（1.0.3 起，1.0.4 加固）**：登录页企业登录入口 + 连通性预检；换域事务化并清旧域凭据；旧文档/迟到响应按会话代次拒绝写回；设置页改域名与企业登录共用同一入口。

**服务生命周期与登录联动（1.0.4）**：主进程统一编排启停重试；未登录只运行页面网关；登出/失效/换域立即撤销在途启动；停服失败如实返回并保留进程引用供重试；不按端口杀未知进程。

**设备身份与隔离（1.0.4）**：产品独立盐 `nuwax:device:v1`；四个旧产品目录零读写；沙箱工作区不再写社区目录并加守卫脚本防回归。

**文件链路（1.0.4）**：网关流式反代；另存支持相对地址、原子落盘、失败清理；file-server 端口与版本对齐。

**首装与启动体验（1.0.3 起）**：依赖安装流补齐（可重试）；loading 最少 800ms；图标破图与跳变修复；探询超时降级。

**壳层 UI 与多语言（1.0.1–1.0.3）**：一体化顶行 + 自绘菜单栏；侧栏整栏收起；平台化避让；电脑名 tooltip；Start All 门禁对齐 webview 并浮出真实失败原因；默认简体中文 + webview→壳语言同步。

**移除两个实验功能（1.0.4 未发布）**：移除入口 + 迁移强制关闭历史开关。

**打包与签名（1.0.2–1.0.3）**：mac 符号链接清洗根治签名失败、双架构签名公证通过；Windows 手签流程；OSS 指针 + S3 产物通道。

### 未完成

| 类别 | 项 | 说明 |
|---|---|---|
| **阻塞** | 全新设备首登注册 | 后端对「仅 Bearer + 新 deviceId、不带 savedKey」返回 `4000 动态认证码或密码不能为空`，客户端已就绪，等后端放开 |
| **未验证** | 换域 A→B→A 真机往返 | 事务逻辑有单测，缺真机 UI 往返 |
| **未验证** | 上传/下载/图片另存真机闭环 | 需真实登录与工作区 |
| **未验证** | 离线启动恢复、退出重启 | — |
| **未验证** | 与 NuwaClaw 同机完整业务流 | 目录隔离与「不杀未知进程」已验，同跑业务流未验 |
| **功能缺口** | 工作目录选择 | 仅基座链路验收；商业壳 pin 未含；弹窗不支持新建/重命名/删除（需契约 + file-server ≥1.4.4 + 基座重打包 + 前端四层） |
| **技术债（有意保留）** | 网关未设 `requestTimeout`/`headersTimeout`；`localhost` 与 `127.0.0.1` 混用；前端 `OptimizedImage` 未归一化 `src`；`localFiles:pickDirectory` 死桥；实验功能主进程服务与基座 SettingsPage 分支成死代码；i18n 键保留；`~/.nuwaclaw/sandboxes` 内历史 Nuwax 工作区成孤儿（不迁移不删除） |
| **流程缺口** | 正式发布未收口 | 1.0.4 未发正式渠道；双平台包均未正式签名；tag/Release 未建；前端 dist 随仓提交，改前端须重建 dist + bump pin |
| **待决** | 设备身份盐变更的后果 | 同机安装 1.0.4 会被服务端按新 deviceId 重新注册，旧「原来的电脑」记录不自动删除——需决定后端一次性合并，或仅在提测说明中告知重新注册影响 |

## 七、差异带来的操作注意

1. **社区发版前必须 bump 基座 pin**：基座已有的登录态重构、顶栏、依赖安装流、设备身份盐等 26 个提交，社区当前 pin 全部未含；bump 后须跑社区基线（1263 条）确认无回归。
2. **商业改动只落 overlay**：基座工作树内的 overlay 产物是同步生成物，改它会被静默覆写。
3. **i18n 键不可删**：`Claw.Settings.experimental.*` / `sandbox.*` / `guiMcp.*` 等键社区版仍在使用，商业版只删 UI 入口。
4. **端口错开是双开前提**：商业版构建必须注入 `NUWAX_PORT_OFFSET`，否则会与社区版/CLI 抢端口。
5. **门禁双轨**：社区基线用隔离副本跑；商业侧先 `sync-overlay` 再跑；提测另需真实安装包验收。

## 八、证据来源

- 子模块 pin 与分叉：`git -C nuwa-electron-shell rev-list --count 9fb6f4f2..HEAD`（26）、`merge-base --is-ancestor` 逐提交核对
- 身份与端口：基座 `src/shared/constants.ts`、两外层仓 `package.json`、`.gitmodules`
- 实验功能三态：`git show HEAD:…/SettingsPage.tsx | grep -c` = 22（基座）、`git show 9fb6f4f2:…` = 22（社区）、工作树（overlay 后）= 0
- 登录重构前后：基座 `a62e2802`、社区 pin 树内仍有 `components/setup/SetupWizard.tsx`
- 门禁与交付：`plans/20260912-delivery-closeout-acceptance.md`（含双平台包 sha256、真实运行态证据、未验证项）
- 需求链：`plans/2026091{0,1,2}-*.md`、`release-notes/*.md`、两仓 `git log`

## 九、治理轮更新（2026-09-12 下午）

本文「提交映射」与各节 SHA 为合并前快照。同日下午的治理轮（`plans/20260912-repo-governance-plan.md`）完成：两仓 feat/electron-1.0.4-fixes 经 PR rebase 合并进 main（基座 ae7e21aa→f0ddd9fe、外层链 tip→209bdacf，树等价）；pin/nuwawork 线退役（.gitmodules 改 branch=main，单主干模型）；外层仓新增 ci.yml 双轨门禁与 check-base-purity 防泄回守卫；基座远端收敛至 main + archive + dependabot。§五 门禁表的本地口径不变，双轨已由 CI 强制。

## 十、增补（2026-09-13）：社区 0.14 线落地 + webview 加载链路差异

### 10.1 本文社区版事实的当日更新

- 社区版已不再走「pin main 旧点」路线：基座仓新建长线 **`community/main`**（复刻前基点 `3fe35df8` 起 + merge 0.13 final `19fa6d27` + 择优摘取 11 个中性提交；version **0.14.0**）。nuwaclaw 消费分支 `feature/electron-client-0.14` pin 该线（.gitmodules branch=community/main）。因此 §一「pin 9fb6f4f2」、§二「版本线停在 0.11.35 / 应用 version 1.0.0」、§三 各「未跟进（pin 落后）」**均以 community/main 线为准重读**——登录态重构、顶栏、启动动画等商业形态能力社区线**按产品决策永久不跟进**（商业单栏样式适配不在社区对接范围，社区 UI 只保 0.13 历史兼容；已写入基座 README 注入契约节）。
- 社区线版本序列进入 **0.14**：`prerelease-v0.14.0` 已于 09-08 触发构建（GitHub Draft + OSS beta 通道在线），tag 指向 0.13 final、构建版本由 tag 名覆盖。
- 社区线 guest preload 已补 `host.getProduct()`（返回构建期 `APP_NAME_IDENTIFIER`，默认 `nuwaclaw`）——与商业实现同契约。

### 10.2 加载 nuwax（PC Web）链路差异深潜

详见同日新增：**`docs/20260913-webview-loading-differences.md`**。一句话版：社区版 = 配置域单向直连 + ticket cookie 同步 + perf/host 最小桥面；商业版 = override/dev/loopback/step1 四级 URL 决策 + 回环网关同源形态 + webview 唯一事实源 token 桥 + 全量桥面（auth/native/localFiles/events/theme/layout/i18n/host）。
