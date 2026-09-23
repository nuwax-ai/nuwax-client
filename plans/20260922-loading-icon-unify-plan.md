# 实施计划：启动/安装 loading 统一为应用图标动效，并覆盖 webview 加载期

- 日期：2026-09-22 · 状态：**已实施，验证通过**（见文末验证记录；提交/合并流程待走）
- 对应 spec：无独立 spec（口头需求直接立项，口径见下）
- 落点定案（沿用 plans/20260916-settings-modal-restyle-plan.md 用户拍板先例）：
  **基座统一改**（nuwa-electron-shell，社区+商业同时生效，不扩 overlay 清单）。
  商业品牌经既有 overlay `public/icon.png` 自动带入，动效对两轨中立。

## 需求口径（三条）

1. **启动 loading 去文案 + 动效改扫光**：去掉「加载中...」文字；图标动效由现有呼吸
   缩放（`app-loading-icon--pulse`）**替换为扫光动效**（高光带周期性斜向扫过图标，
   见下方规格），全局统一。失败/重试等错误态**保留**（静止图标 + 文案）。
2. **初始安装展示统一**：首次安装/依赖补装（SetupDependencies 的
   checking / installing / completed 态）从「Spin + 状态文案 + 进度条」整体替换为
   同款应用图标**扫光**动效全屏界面。error / system-deps-missing（含重试按钮）**保留**。
3. **覆盖 webview 自身 loading**：图标动效层不再让位于 webview 白屏/前端 loading，
   而是持续盖在 webview 之上，直到 guest 加载停止 + 宽限期（「尽量覆盖」前端
   authWithLoading），超时上限兜底防止永挂。

## 扫光动效规格（替换呼吸缩放）

- 结构：`.app-loading-icon-frame`（88×88、border-radius 20px、overflow hidden，
  `filter: drop-shadow` 保留）内含 `<img src="./icon.png">` + `::after` 高光带。
  两轨图标（社区紫标 / 商业黑砖）自动生效，**无需新资源**。
- 高光带：`linear-gradient(105deg, transparent 42%, rgba(255,255,255,.35) 50%,
  transparent 58%)`，自框左外 `translateX(-120%)` → 右外 `translateX(120%)`，
  单次扫过 ≈0.9s ease-in-out，整周期 2.6s（含停顿），infinite。
- 状态语义：加载/等待态启用扫光；失败态静止无扫光（沿用 1c 失败态现状）。
- 删除既有 `@keyframes app-loading-breathe` 与 `--pulse` 修改器（暗色变体同步）。

## 现状锚点（探索结论）

- 「加载中...」硬编码：`src/renderer/main.tsx:75-87` `resolveBootLoadingText()`；
  i18n 文案：`App.tsx:1777` `t("Claw.App.Loading")`（zh-CN.json:202）。
- 现有图标动效：`src/renderer/index.css:842-905` `.app-loading` /
  `app-loading-icon--pulse`（呼吸缩放，暗色变体 :1198-1206）——本计划**替换为扫光**
  （见规格）。1c 服务门禁**等待态已是图标-only**
  （App.tsx:1851-1854 注释即本需求方向），结构无需改。
- 安装展示：`components/setup/SetupDependencies.tsx:580-638`（Spin+phaseText+Progress）。
- webview 让位缺口：壳 splash 在 `servicesGate.ok && splashFloorMet`（MIN_SPLASH_MS=3000，
  `bootTiming.ts` VisibleSplashClock）即卸载，之后 `NuwaxHostWebview` 异步读 3 段
  settings 才 setUrl → webview 加载 → 前端 authWithLoading（最少 500ms）。全仓无
  did-stop-loading/did-finish-load 监听，壳对 guest 加载状态零感知。

（以下路径均相对 `nuwa-electron-shell/crates/agent-electron-client/`）

## 改动文件清单

| # | 文件 | 动作 | 说明 |
|---|---|---|---|
| 1 | `src/shared/constants.ts` | 改 | 新增 `WEBVIEW_COVER_GRACE_MS = 1200`（did-stop-loading 后再盖 1.2s，覆盖前端 authWithLoading 最少 500ms+请求）、`MAX_LOADING_OVERLAY_MS = 12000`（硬上限兜底）。`MIN_SPLASH_MS=3000` 保留为下限 |
| 2 | `src/renderer/bootTiming.ts` | 改 | 新增纯函数 `resolveLoadingCovered({guestState, stoppedAt, mountAt, now})`（或独立 `loadingCover.ts`）：`stoppedAt + GRACE` 或 `mountAt + MAX` 命中即 true；可单测 |
| 3 | `src/renderer/bootTiming.test.ts`（或 `loadingCover.test.ts`） | 增 | 覆盖判定用例：提前 stop 不足 GRACE 不隐藏、足 GRACE 隐藏、reset 回 loading、超 MAX 兜底 |
| 4 | `src/renderer/components/AppIconLoading.tsx` | 增 | 共享图标动效层：`.app-loading` + 图标框（扫光，见规格；失败态 `animated=false` 静止），`children` 落 `.app-loading-body`（错误内容插槽）；供 4 处复用保持统一 |
| 5 | `src/renderer/main.tsx` | 改 | 删 `resolveBootLoadingText` 与文案 DOM，换 `<AppIconLoading/>`（req 1） |
| 6 | `src/renderer/App.tsx` | 改 | ① 1b splash 去文案（req 1）；② 1c 失败态 body 内容不动、结构迁移到组件插槽；③ 主界面分支叠加 `{!loadingCovered && <AppIconLoading/>}` 全窗覆盖层（zIndex > webview 1000），接线 `onGuestLoadStateChange` 状态机 + 计时（req 3） |
| 7 | `src/renderer/components/setup/SetupDependencies.tsx` | 改 | checking/installing/completed 三态整体替换为 `<AppIconLoading/>` 全屏（req 2）；删 Spin/phaseText/Progress 及未用导入；error/system-deps-missing 分支保留（居中于 `.app-loading-body` 布局） |
| 8 | `src/renderer/components/pages/NuwaxHostWebview.tsx` | 改 | ① 补 `did-start-navigation`/`did-navigate` → loading、`did-stop-loading`/`did-finish-load`/`did-fail-load` → stopped，经新 prop `onGuestLoadStateChange` 上抛；② `!url` 兜底去 Spin，改图标呼吸（与全局统一） |
| 9 | `src/renderer/index.css` | 改 | 删 `.app-loading-text`（含暗色变体，先 grep 确认无其他引用）；**呼吸 keyframes/`--pulse` 换扫光实现（见规格，暗色同步）**；新增 `.app-loading--overlay`（`position:fixed; inset:0; z-index:2000`）；`.app-loading-body` 保留（错误插槽） |
| 10 | `src/main/main.ts` | 改 | BrowserWindow 补 `backgroundColor` 对齐 `.app-loading` 底色（light `#f8f9fa` / dark 取 index.css:1198-1206 同值，按 `nativeTheme.shouldUseDarkColors`），消除窗口首帧白→灰跳变 |

不动（有意）：locales 四份（`Claw.App.Loading` 等键保留不删，避免 overlay 超集联动）；
`nuwax/` 前端 submodule（authWithLoading 自身不动）；overlay/ 零改动。

## 实施顺序

1. 纯逻辑先行：#1 常量 → #2 判定函数 → #3 失败测试先行的单测。
2. 视觉层：#4 组件 + #9 样式（可用 story 式 dev 截图自检）。
3. req 1：#5 main.tsx + #6①② App.tsx 去文案。
4. req 2：#7 SetupDependencies 替换。
5. req 3：#8 事件上抛 + #6③ 覆盖层接线（依赖 1-4 完成后联调）。
6. 收尾：#10 backgroundColor。

## 验证（证明成立）——实施结果 2026-09-22

- 单测：`bootTiming.test.ts` 新增 5 用例（宽限/上限/resolving 不吃额度/取小/永挂兜底）
  先行红→绿，文件 7/7 绿。
- 商业门禁：`npm run test:commercial` **1545 passed | 18 skipped，零失败**
  （127 测试文件；对比 09-16 基线 1450 为用例自然增长，18 skipped 持平）。
- 类型：tsc 本批 8 个改动文件**零错误**；全量 206 ≈ 基线 205（漂移在未触碰的既有
  测试文件上）。
- 真机冒烟（Playwright `_electron` 驱动 + 页面级截图/DOM 断言，mac）：
  1. +1.4s：splash 图标扫光（`animationName=app-loading-sheen`），无任何文案；
  2. +4.2s：进入主界面，`app-loading--overlay` 覆盖层兜盖 webview（webview 已在底下加载）；
  3. +7.1s：guest `did-stop-loading` + 1.2s 宽限后掀开，nuwax 主页完整呈现；
  4. 全程探针 bannedText（加载中/載入中/Loading...）恒 false —— 从 splash 到内容无
     任何帧露出 webview 自身 loading，图标动效连续约 5.7s 直达真实内容。
- SetupDependencies 安装态视觉：未真机强制触发（复用的 AppIconLoading 已由其余 3 处
  启动路径实证）；error/system-deps-missing 分支代码未动。
- 流程门禁：提交基座前 `npm run check:pin -- --staged`；外层 bump pin 后
  `npm run overlay:check`（待走提交流程时执行）。

## 风险与回退

| 风险 | 缓解 | 回退方式 |
|---|---|---|
| 依赖安装时长可能分钟级，纯图标无进度是否显得「卡住」 | 扫光动效持续表征存活；error 态完整暴露失败与重试 | 恢复 SetupDependencies 的 phaseText+Progress 分支（单文件可回退） |
| 扫光在浅色图标上对比度不足 | 高光带半透明白 + 105° 斜扫，现有两轨图标（紫标/黑砖）均为深底 | 调高 `rgba(255,255,255,.35)` 透明度或改 `mix-blend-mode: overlay` |
| did-stop-loading 在重定向/多跳时反复触发 | 状态机 start→loading / stop→stopped 重置计时 | 纯函数单测覆盖；cap 兜底 |
| webview 长加载超 12s 露出 web 自身 loading | MAX 可调常量 | 调大 MAX_LOADING_OVERLAY_MS |
| 基座改动同时进社区 NuwaClaw | 与 20260916 拍板口径一致（中立 UX，社区同享） | 该先例不可拆回 overlay；如反悔需另立商业覆写（不建议） |
| 精确盖到前端 authWithLoading 结束需前端配合 | 本轮 shell 侧 stop+1.2s 宽限已达「尽量覆盖」 | 后续可选：nuwax authWithLoading 经桥上报 page-ready（另立批次） |

## 偏离记录

1. **`.app-loading-text` 样式保留**（计划预设「先 grep 确认」）：bootError 与 1c 失败态
   仍在使用该类展示错误文案，仅移除等待态文案；CSS 未删。
2. **SetupDependencies 错误态布局不动**：计划曾写「居中于 .app-loading-body」，实施时
   改为保持 error/system-deps-missing 原有布局（依赖列表较高，塞进 body 槽会溢出视口）；
   仅 checking/installing/completed 三态替换为 `<AppIconLoading />`。
3. **覆盖判定落成单函数**：`loadingCoverRemainingMs(hasStopped, opts)`（返回 0 即掀开）
   取代计划中的 resolveLoadingCovered 双签名；`GuestLoadPhase` 增加 `"resolving"`
   （URL 重解析期：域名/形态切换重新兜盖，对应验证项）；hook 定名 `useLoadingCover`，
   `active` 传主界面成立条件（`mainUiActive`，与早退分支互补），启动 splash 不吃上限额度。
4. **冒烟方式改为 Playwright 驱动**：mac `screencapture` 被系统 TCC（屏幕录制）拒绝，
   改用 playwright-core `_electron` 启动真窗口做页面级截图 + DOM 断言（一次性脚本
   /tmp/pwdriver/drive.mjs，未入库；可考虑后续沉淀为项目 run skill）。
5. installProgress/currentInstalling 状态随进度条一并移除（仅服务于已删的 Progress 展示）。
6. **扫光 v2（实施中用户追加口径）**：光条仅在 logo 白色字形区显形 + 光条加大。实现从
   `::after` 白色渐变（动画层提升后 mix-blend-mode 不可靠，且整砖扫过）改为独立
   `.app-loading-icon-sheen` span：**icon.png 亮度做 mask**（白字形显形、黑砖≈全遮）+
   灰色光条 30%→70%（2.5 倍宽）；mask url 走行内运行时解析（dev/loadFile 打包同源）。
   定格取证帧 icon-frozen-center.png 确认：光条只扫过白色字形，黑砖无痕。
7. **webview 页内 loading 统一口径（实施中用户三连定案）**：曾拟在 nuwax 前端把
   authWithLoading 换成同款图标动效组件，用户叫停（「不单独在 webview 里实现」
   「只在外层壳子的 loading 能覆盖 loading 时间就可以了」）——**前端零改动**，
   统一入口只在壳层：`WEBVIEW_COVER_GRACE_MS` 1200→**3500ms**，盖住 guest
   did-stop-loading 后的页内 loading 全程（JS 启动 + authWithLoading 最少 500ms +
   拉用户信息）。驱动探针实证：页内「加载中」全程处于盖层之下（under-cover ok），
   揭开前已消失，外露计数 **PASS**。
