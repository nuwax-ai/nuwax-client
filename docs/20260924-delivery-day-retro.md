# 2026-09-24 交付日复盘（nuwax-client + nuwax 前端）

> 快照时间：2026-09-24 11:52（CST）；P0-1、P0-3、P0-5 与第 6 节已于 14:15 复核更新。本文只基于只读排查：未改代码、未推送、未触发 workflow（仅 `git fetch` 刷新远端跟踪引用）。标「推断」处为未经实测的判断。
> 覆盖范围：`nuwax-client`（含基座 submodule `nuwa-electron-shell`）与 `~/workspace/nuwax`（前端，客户端 `nuwax/` submodule 的源仓）。

## 0. 结论

1. **v1.0.34 已全部构建成功，但还没进通道。** v1.0.33 已作废：Windows 构建在 Computer Use helper 打补丁一步失败，其余四个平台随后被取消。v1.0.34（11:00 打 tag，带修复）于 12:48 五平台全部成功，Draft 有 27 个资产，其中 Windows 包是 `Nuwax-Setup-1.0.34-unsigned.exe`，尚未签名。
2. **构建全绿也不会自动进 beta 通道。** 09-23 23:26 起发布流程改了：先人工签 Windows 包（SimplySign 需手机 2FA），再手动触发 `sync-electron-to-oss.yml`，这套新门禁今天第一次实跑。线上 beta 指针仍是 1.0.32（其 Windows 包未签名），stable 指针仍是 1.0.4。
3. **真机验收没有记录。** Windows 覆盖安装 W1–W6、0912 批次遗留的四项真机项、v1.0.2x/1.0.3x 各 tag 的验收记录，全部为空。
4. **ttyd 终端修复已合入；另有两项修复只在本地，未推送。** ttyd 三批修复都已在 v1.0.34 中：2526 乱码与目录、按 projectId 反查、service_type/cwd 契约与 normalProject 三轨制。另外两项只存在于本机分支：bug2537 的 loopback 生命周期串行化（外层 overlay）和主 webview 加载失败诊断与恢复面板（基座）。收银台避让（bug2489）与切换加载模式时丢弃过期 URL，发布线已用 `512f0dd3`、`webviewEpoch` 各自另行实现，本地版本不需要再合。基座 PR #18 做的是「终端 cwd 按真实会话路由」，属于在 main 已有逻辑之上的增强，目前仍 OPEN 且有冲突，需人工决定是否合入。详见 P0-3。
5. **交付日仍有大改动在进行，且已进入发布线。** 11:27 发布线新增 `98d6e3f1`（soddygo），把 pin 前进到基座 `3a9fac2a`、前端 `b2af5e45a`。前端这一步带入了今天 10:32 的 style3 大提交（`4a252c0b1`，`src` 下 83 文件 +3432/−397）。这些改动都不在 v1.0.34 中，但下一个 tag 会带上。另外，前端工作区有未提交修改，另一个 codex worktree 正在改 NSIS 安装器（未提交）。

建议今天的主线：**以 v1.0.34 为交付候选 → 签名 → beta 同步 → 真机验收签字**。其余改动一律进下一版。

## 1. 需要拍板的决策

| # | 决策点 | 建议 | 不拍板的后果 |
|---|---|---|---|
| D1 | 今天「交付」指 beta 1.0.34 进 beta 通道，还是出正式版（stable 目前 1.0.4）？ | 先完成 beta 通道闭环与真机验收；正式版走 `scripts/release-stable.sh`，版本号须 >1.0.4，源码与验收通过的 beta 为同一提交 | 流程与验收范围无法确定 |
| D2 | 仅本地的两项修复（2537 loopback 串行化、webview 失败恢复）与基座 PR #18 是否纳入今天？ | 不纳入；先推送备份；发布说明列为已知问题 | 两仓改动 + pin + 全量门禁 + 重打包 + Windows 复测 |
| D3 | 下一个 tag 的前端基线：保留发布线已 bump 的 `b2af5e45a`（含 style3），还是回退到 v1.0.34 的 `d37084895`？ | 交付以 v1.0.34 为准；若必须再出 tag，先确认 style3 已评审和验收 | 91 文件 UI 改动未经评审就进包 |
| D4 | 在途的 NSIS 安装器改动（`codex/windows-installer-reliability`）怎么处理？ | 先问清起因：若是修实测出的覆盖安装缺陷，v1.0.34 的 Windows 包同样有此问题，直接影响 go/no-go；否则冻结 | Windows 升级路径风险不明 |
| D5 | Web 端（测试环境/线上）从 GitHub 还是 GitLab 部署？GitLab 是否要同步？ | 明确部署来源后，把 GitHub `feat-2026.9.30` 同步到 GitLab | Web 与客户端内嵌前端不一致 |

## 2. P0：今天必须完成（按执行顺序）

### P0-1 跟进 v1.0.34 构建

- 现状（14:15）：run [35949745614](https://github.com/nuwax-ai/nuwax-client/actions/runs/35949745614) 于 12:48 全部成功（三道门禁 + Prepare + 五平台构建）。Windows 的 cua helper 步骤通过，说明 PR #10 的修复生效。Draft 共 27 个资产，beta 指针仍是 1.0.32。
- `prerelease-v1.0.34` 指向 `3fdfb8d7`（PR #10 合并提交），已包含 WS ticket 修复 `bb01414c` 和 CRLF 修复 `d1b197c1`。pin：基座 `b4d6762b`，前端 `d37084895`，与 v1.0.33 相同。
- 动作：对照 v1.0.32 的资产清单逐项核对 Draft（EXE/blockmap、mac 双架构、Linux 双架构、yml、build-manifest、provenance），然后进入 P0-2。

### P0-2 beta 通道发布（新流程首次实跑）

前提：D1 选定 beta。v1.0.34 已全部构建完成，可以开始。

1. 签名机（win-pc）检出更新到 `prerelease-v1.0.34`，包括 `scripts/sign-prerelease-win.sh` 和新基座 pin（`--skip-download/--skip-upload` 已确认在 pin `b4d6762b` 的 `sign-release-win-v2.sh` 中支持）。
2. SimplySign Desktop 登录（手机 2FA，只能人工）。
3. 签名机执行 `scripts/sign-prerelease-win.sh 1.0.34`，上传 `Nuwax.Setup.1.0.34.exe`。
4. 触发同步，**必须带 `--ref release/v1.0.x`**。默认分支 `main` 上的同名 workflow 落后 191 个提交，没有来源核验，也没有 `osslsigncode` 签名门禁：

   ```bash
   gh workflow run sync-electron-to-oss.yml --repo nuwax-ai/nuwax-client --ref release/v1.0.x -f tag=prerelease-v1.0.34 -f channel=beta
   ```

5. 核验 `nuwax-electron/beta/latest.json` = 1.0.34，再用 1.0.32 客户端在「关于」页检查更新，完整走一次升级。

风险：新同步门禁（provenance 字节核对、签名校验、回读 sha256、指针备份与回滚）从未在生产跑过，`sync-electron-to-oss.yml` 历史上只跑过一次（09-15，stable 1.0.4）。预留排障时间。

若 D1 选正式版：先提交 `release-notes/electron-v<version>.md`，再执行 `scripts/release-stable.sh <version> --notes`。cua 修复在 `build-helper.sh` 中，stable workflow 同样生效。

### P0-3 本地分支逐项核对（14:10 复核）

已合入，不需要再合：

| 修复 | 发布线中的提交 | 所在版本 |
|---|---|---|
| ttyd 终端中文乱码与目录落点（禅道 2526） | 基座 `d48d324d` | v1.0.34 起 |
| ttyd cwd 按 projectId 反查、信号退出清理链（基座分支 `fix/ttyd-project-cwd-pnpm`） | 基座 `6ee8aac4`，经 `f862a893` 合流 | v1.0.34 起 |
| ttyd service_type/cwd 契约、normalProject 三轨制、空目录可用 | 基座 `84226e7c`、`1435efa1` | v1.0.34 起 |
| 内嵌终端提示符补当前目录（`feat/ttyd-shell-prompt-cwd`） | 基座 `4e8efcfe`，经 `3a9fac2a` | 只在 11:27 bump 之后的发布线，不在 v1.0.34 |
| 收银台避让 Windows 工具栏（bug2489） | overlay `512f0dd3`（`GuestPageViewport`） | v1.0.32 起 |
| 配置切换丢弃过期 URL 解析、同源重载 | 基座 `e5f53cc1` 起的 `webviewEpoch` | v1.0.34 起 |
| 前端首屏启动失败反馈（bug2537 前端侧） | 前端 `92730e0ec` | 前端 pin 已含 |

只在本地，远端没有：

| 修复 | 本地位置 | 状态 |
|---|---|---|
| bug2537 loopback 生命周期串行化（快速开关加载模式时，迟到的 start 不再覆盖 DIRECT） | 外层 `codex/bug2537-rapid-loadmode`（`173f722a`）、`codex/audit-batch-fixes`（`4c001d41`+`3f002282`，同一修复） | 发布线 overlay 无对应实现；两个分支都未推送 |
| 主 webview 加载失败诊断与手动恢复面板 | 基座本地分支 `codex/bug2537-webview-recovery`（`070d51e9`、`6ede5093`） | 基座 main 无对应实现；未推送 |

远端有 PR，但未合：

- 基座 PR #18（`codex/audit-batch-fixes`，终端 cwd 优先用真实会话 `session.cwd`，未匹配时不借用最近其他会话的目录）：OPEN，与 main 冲突。main 已有 projectId 反查，但默认轨道的最终兜底仍是「最近活跃会话工作区」。是否合入需人工决定。

动作（需确认）：两项仅本地的修复先推送到远端作备份；是否纳入下一版另行决定。

### P0-4 真机验收（交付签字的前提）

每个候选 tag 复制一份 `docs/release-acceptance-template.md` 填写，证据指向同一安装包 SHA256；未做的项写「未验证」。

- Windows（交互桌面会话，签名版 1.0.34）：
  - 覆盖安装 W1–W6（`plans/20260923-windows-upgrade-install-plan.md` 明确写着「本轮未运行测试或构建」）；
  - 从 1.0.32 经 beta 通道升级；
  - cookie 登录；
  - 服务启停。
- macOS（双架构）：签名、公证、Gatekeeper；从 1.0.32 升级。
- `bb01414c` 跨站 WS：在 gateway 模式下验证业务域 WebSocket 握手能带上 ticket。前端自行 `new WebSocket` 的只有终端两处，且用 `window.location.host` 拼接，gateway 模式下连的是同源网关，不受影响。实际触发面推断为 `VncPreview` 以 `${serviceUrl}/computer/desktop/<id>/vnc.html` 嵌入的远程桌面：noVNC 在业务域 iframe 内发起握手，而顶层是 loopback 文档，整条链算跨站，Lax cookie 不会随握手发送。需在包内打开远程桌面实测。
- 0912 遗留未验证项（`plans/20260912-delivery-closeout-acceptance.md` §6）：
  - 企业域名 A→B→A 往返；
  - 上传、下载、图片另存；
  - 与 NuwaClaw 同机共存；
  - 离线启动与重启。

### P0-5 冻结在途改动

- 发布线 pin 已前进（14:15 复核）：11:27 的 `98d6e3f1` 把基座 pin 从 `b4d6762b` 推进到 `3a9fac2a`（新增终端提示符补当前目录 `4e8efcfe`），前端 pin 从 `d37084895` 推进到 `b2af5e45a`（新增 style3 `4a252c0b1`）。`b2af5e45a` 在 `feat-dong.0930` 上，不在 `feat-2026.9.30` 集成线上，与此前「pin 跟随 9.30」的做法不同。该提交 CI 全绿（run 35951913950），但未走 PR。
- 前端 style3：`4a252c0b1 feat(style3): 保活会话页面并完善首页与渲染`（10:32，91 文件 +3774/−417）涉及 Chat、ConversationAgent、AppDevPro、新增 ConversationPageModelProvider 与 appTabKeepAlive。现已随上一条进入发布线 pin。
- 前端工作区：`~/workspace/nuwax` 有 `src/constants/version.ts`（10:56）和 `presentation-v2/react/index.less`（11:01）两处未提交修改。
- NSIS 安装器：`~/.codex/worktrees/windows-installer-reliability`（基于 `3fdfb8d7`）中 `installer.nsh` 有未提交修改 +79/−26（11:22），内容是 all-users 模式查找进程、按注册表规范化旧安装目录。可见有 codex 会话在并行改动。
- 动作：
  - 构建和签名期间，不向 `release/v1.0.x` 推提交、不打新 tag（prerelease workflow 没有 concurrency 组，新 tag 会并行起一轮构建）；
  - pin 已被 11:27 的提交前进；再出 tag 前按 D3 决定前端基线；
  - 与并行会话约定冻结，避免撞车。

## 3. P1：交付前尽量完成

- **P1-1 GitLab 漂移，Web 与客户端不一致。**
  - 前端 `gitlab/feat-2026.9.30`（`95141ee8e`）比 GitHub 落后 27 个提交（按 patch-id 去重后 22 个真正缺失），`src/` 内容差 90 个文件 +1895/−1091。缺的是 09-23 整条 ticket cookie 鉴权链：`033cd84a2 feat(auth): use ticket cookie across PC web requests and host bridge`、`12174ad9a`（桌面宿主内 cookie 登录页稳定）、`61659d213`（恢复本地 Umi token 登录），以及上传/对话修复和 pin 中的 `b25202929`/`d37084895`。
  - `gitlab/feat-dong.0930` 落后 48 个提交。
  - `gitlab/dev` 与 `gitlab/feat-2026.9.30` 同为 `95141ee8e`，有 42 个 GitHub dev 没有的提交。推断 dev 环境从 GitLab 部署，停在 09-23 20:41。
  - `test` 分支（dist 部署快照）两边一致，最后更新 09-23 21:59，早于 pin 中的两个提交。
  - QA 若同时看 Web 和客户端，两边前端版本不同，结论会串。处理方式见 D5。
- **P1-2 主检出陈旧，不要用它做本地验证。**
  - `~/workspace/nuwax-client` 本地 `release/v1.0.x` 已快进到 `98d6e3f1`（与 origin 一致）。
  - 子模块停在 v1.0.32 的 pin（基座 `335ddeeb`、前端 `31fe5be98`），新 pin 对象都没拉取。
  - `nuwax/` 里还有 42 个 dist 修改和两个未跟踪备份目录（`dist.codex-before-2537-3e0207956/`、`dist.codex-pre-takeover-20260922/`）。
  - 本地复核请在 `prerelease-v1.0.34` 的隔离检出中进行（`base:test` 本来就要求隔离副本）。
- **P1-3 发布说明补充已知问题。**
  - 2537 loopback 快速切换、主 webview 失败恢复面板未纳入（按 D2 不纳入时）；
  - bug2427 遗留：点击顶行拖拽区不会收起菜单；
  - bug2473 遗留：视频/音频无右键菜单；
  - Windows beta 更新走全量下载（`SIGN_SKIP_BLOCKMAP=true`）。
- **P1-4 作废草稿。** `prerelease-v1.0.33` 的 Draft Release（0 资产）容易造成混淆，交付后删除 Draft（需确认），tag 保留作记录。

## 4. P2：交付后治理

1. **main 与发布线分叉。** `origin/main` 落后 `release/v1.0.x` 191 个提交，没有独有提交，可以直接快进。AGENTS.md 和 README 写的是「单主干，feat PR 进 main，pin 跟随 main」，实际却在 `release/v1.0.x` 上发版。凡是基于默认分支的操作（不带 `--ref` 的 dispatch、新 clone、新 PR 的默认 base）都会拿到过时代码。二选一：快进 main，或把「发布线模型」写进文档。
2. **评审与分支保护。** 现状与 REVIEW.md「approve 永远是人，writer 不自批」不符：
   - PR #8/#9/#10 都是作者本人合并，review 为 0；
   - `bb01414c` 直接推到发布线，没走 PR（GitHub 上没有关联 PR）；
   - `main` 和 `release/v1.0.x` 都没有分支保护，仓库也没有 ruleset；
   - PR #9 共 6 个提交、54 文件 +3772/−1226（其中主提交 `3f532570` 占 40 文件 +2950/−407），描述里有测试计数，但没有 `/quality-review` 三问的证据。

   建议发布线开启「必需状态检查 + 至少 1 人批准」。
3. **CI 缺 Windows 预检，补丁格式不规范。** 这次补丁回归直到 tag 构建的 Windows job 跑了约 10 分钟才暴露。建议：
   - 加 `.gitattributes`（`*.patch -text` 或 `eol=lf`）；
   - 重新生成 PATCH 4/4，让空上下文行带上前导空格；
   - PR CI 增加 `git apply --check`（windows-latest 或模拟 CRLF）。

   PR #10 在消费端 `tr -d '\r'` 是有效的兜底，但补丁本身没修。
4. **发版节奏。** 09-20 到 09-24 共 11 个 prerelease tag（v1.0.24–v1.0.34），09-23 一天就有 6 个，v1.0.33 只存活了 32 分钟。建议批次完整后再打 tag，打 tag 前做 Windows 预检，交付前冻结单一候选版本。
5. **前端 CI 与 dist。**
   - 前端仓只在 PR 上跑 conversation-tests，9.30/dong 的 push 没有 CI，main 最后一次（09-14）是红的。目前 pinned 前端实际只由客户端仓的 frontend source gate 把关。
   - pin `d37084895` 中提交的 `dist/` 最后由 `1eeb4c063`（09-23 21:29）刷新，`dist/version.json` 记录的 gitHash 是 `52e285998`，之后源码又有 `b25202929`、`d37084895` 等改动。发布构建经 `scripts/prepare-nuwax-dist.sh` 从锁定源码重建 dist，安装包不受影响；直接使用仓内 dist 的场景（dev）会与源码不一致。
6. **文档陈旧。**
   - `plans/20260912-login-sync-audit-fixes-plan.md` 的「遗留待决 1：deviceId 盐」已在 1.0.4 落地（`nuwax:device:v1`，见 `commercialAuth.ts:177` 与 0912 closeout），应标为已解决。
   - README 的分支模型见第 1 条。
7. **CI 改动 `bff08839` 评估：没有削弱门禁。** 测试步骤仍会让 job 失败；它只是调整了顺序，并让架构检查在测试失败时也输出结果。无需处理。

## 5. 复盘

### 5.1 时间线（CST）

| 时间 | 事件 |
|---|---|
| 09-23 22:27 | `prerelease-v1.0.32`：旧流程构建后自动写 beta 指针（Windows 包未签名） |
| 09-23 23:26 – 09-24 01:06 | `247217cc`/`5269088c`/`3f532570`：发布门禁改造（锁来源、签名门禁、beta 改为手动同步）；`3f532570` 向 cua 补丁追加 PATCH 4/4（+487 行） |
| 09:56 | 前端 PR #185 合入 `feat-2026.9.30`（`0a2b1bbd7`），pin `d37084895` 是它的父提交 |
| 10:28 | PR #8、#9 合入 → `1f82fbc9`，打 `prerelease-v1.0.33` |
| 10:32 | 前端 style3 大提交 `4a252c0b1` 推到 `feat-dong.0930` |
| 10:35 | `bb01414c`（WS ticket）直推发布线，不在 v1.0.33 中 |
| 10:45 | v1.0.33 Windows 构建失败：`corrupt patch at ...0001-0003-cua-nuwax-helper-bundle.patch:319` |
| 10:53 | `d1b197c1` 修复，开 PR #10 |
| 11:00 | PR #10 合入 → `3fdfb8d7`，打 `prerelease-v1.0.34` |
| 11:02 | v1.0.33 其余四个平台被取消；v1.0.34 开始构建 |
| 11:22 | `windows-installer-reliability` 出现未提交的 NSIS 改动 |
| 11:27 | `98d6e3f1` 直推发布线：pin 前进到基座 `3a9fac2a`、前端 `b2af5e45a`（含 style3） |
| ~11:30 | v1.0.34 Windows 通过 cua helper 步骤 |
| 11:39–11:45 | v1.0.34 Linux arm64、Linux x64、Windows x64 相继构建成功 |
| 12:48 | v1.0.34 五平台全部成功，Draft 27 个资产 |

### 5.2 v1.0.33 失败根因（已本地复现）

1. `3f532570` 向 `docs/computer-use-poc/0001-0003-cua-nuwax-helper-bundle.patch` 追加的 PATCH 4/4 中，hunk 里有 18 行空上下文行缺少前导空格（第 319、321、400 行等）。前三个补丁的空上下文行都是规范的 `" "`。推断这段内容经过了「去行尾空白」处理。
2. 仓库没有 `.gitattributes`。Windows runner 的 `core.autocrlf` 把补丁检出为 CRLF，裸空行变成 `"\r"`，`git apply` 不再把它视为空上下文行，于是判为 corrupt。
3. 复现：在 `/tmp` 中，同一补丁的 LF 版本解析正常，CRLF 版本报 `corrupt patch at line 319`；v1.0.32 的补丁 CRLF 化后仍能正常解析。
4. PR CI 只在 Linux 上跑门禁，Windows 构建只出现在 tag 流水线，所以问题到 tag 后才暴露。

### 5.3 做得好的

- 发布链补上了来源锁定、Windows 签名门禁、上传回读核对，指针最后发布且可回滚。
- 打 tag 构建前会复跑双轨 + 前端三道门禁。
- v1.0.33 失败后 8 分钟定位，15 分钟完成修复并重新打 tag。
- WS ticket 修复同时带了单测和真实 Electron 验收脚本。

### 5.4 问题与根因

| 问题 | 根因 | 对应改进 |
|---|---|---|
| 交付日第一个 tag 失败 | 补丁格式 + CRLF + 无 Windows 预检 | P2-3 |
| 交付日首次实跑新发布流程 | 流程在交付前夜大改，没有演练 | 今天预留排障时间；以后改流程后先演练一次 |
| 两项修复在本地滞留两天 | 未推送、未开 PR | P0-3；以后当日推送 |
| 自合并、零评审、直推发布线 | 无分支保护 | P2-2 |
| GitHub/GitLab 漂移 | 多远端靠手工同步 | D5、P1-1 |
| 文档与实际分支模型不符 | main 长期不跟进 | P2-1 |
| 交付日仍有大改动在途 | 缺冻结纪律 | P0-5 |
| 11 个 beta tag 都没有逐 tag 验收记录 | 模板已有但未执行 | P0-4 |

## 6. 现状快照

### 6.1 nuwax-client

| 项 | 状态 |
|---|---|
| 发布线 | `origin/release/v1.0.x` = `98d6e3f1`（11:27 pin bump）；本地主检出在 `bb01414c` |
| pin | 发布线：基座 `3a9fac2a`、前端 `b2af5e45a`；v1.0.34：基座 `b4d6762b`、前端 `d37084895` |
| CI | `98d6e3f1` 的 push：run 35951913950，三道门禁全绿 |
| tag / Release | v1.0.24–v1.0.34 全是 Draft。v1.0.33：0 资产，已作废；v1.0.34：27 个资产，五平台成功，Windows 未签名；v1.0.32：22 个资产（含 `Nuwax-Setup-1.0.32-unsigned.exe`） |
| 通道 | beta = 1.0.32（09-23 22:27 发布）；stable（`latest/latest.json`）= 1.0.4（09-15） |
| 打开的 PR | 外层无；基座 #18（终端 cwd 按真实会话，OPEN，与 main 冲突） |
| worktree | 15 个，见 §7 |

### 6.2 nuwax 前端（`~/workspace/nuwax`）

| 项 | 状态 |
|---|---|
| 当前检出 | `feat-dong.0930` = `b2af5e45a`，与 origin 同步；2 个文件有未提交修改（+6/−1）；stash 30 条（`stash@{1}` 标注「勿丢」） |
| 集成线 | `origin/feat-2026.9.30` = `0a2b1bbd7`（PR #185），v1.0.34 的前端 pin `d37084895` 是它的父提交；发布线当前前端 pin `b2af5e45a` 在 `feat-dong.0930` 上 |
| dong 线领先 9.30 | `4a252c0b1` style3（91 文件） |
| GitLab | 9.30 落后 27，dong 落后 48，dev 有 42 个 GitLab 独有提交；main/test 两边一致 |
| 打开的 PR | #184（导出文件名修复 → main，09-15）、#176（依赖升级，07-16，已陈旧）、#164（文档） |
| CI | 仅 PR 跑 conversation-tests（09-23 绿）；9.30/dong 的 push 无 CI；main 最后一次（09-14）红 |

## 7. 清理清单（交付后执行，均需确认）

- 已合入、可删除的 worktree/分支：
  - `codex/loopback-login-sync`
  - `codex/windows-installer-beta-1031`
  - `card-B-2428`
  - `card-I-2530-2526`
  - `nuwax-client-ebuild`（detached）
  - `wave2-client-merge`
  - `feat/client-engineering-gates`
  - `feat/client-risk-remediation-stacked`
  - `codex/ci-patch-line-endings`
  - `feat/client-risk-remediation`（仅本地，从未推送；是 PR #9 的第一版。PR #9 实际合入的是由它重整后的 `feat/client-risk-remediation-stacked`，20 个小提交压成 1 个主提交。两者最终内容只差两处：stacked 多了 `prerelease-v1.0.33.md` 说明；`computerUse.test.ts` 在 stacked 上已由 `8f7286c3` 修复，旧分支里仍是 CI 失败 15/26 的那版。旧分支没有需要补合的内容）
- 需保留：
  - `codex/audit-batch-fixes`、`codex/bug2537-rapid-loadmode`，以及基座本地分支 `codex/bug2537-webview-recovery`（含仅本地的两项修复，先推送）
  - `feat/plan-mode-mcp`（1 个文档提交，已推送）
  - `codex/windows-installer-reliability`（在途）
- 主检出：同步到最新发布线和 pin；`nuwax/` 下两个备份目录确认无用后再删。
- 前端：`~/.codex/worktrees/p2-streaming/nuwax`（09-04 的诊断改动）；stash 逐条确认后再清理。
- GitHub：`prerelease-v1.0.33` 的 Draft。

## 8. 证据索引

- v1.0.33 失败：https://github.com/nuwax-ai/nuwax-client/actions/runs/35947458777（job 107469871156，step 24）
- v1.0.34 构建：https://github.com/nuwax-ai/nuwax-client/actions/runs/35949745614
- PR：https://github.com/nuwax-ai/nuwax-client/pull/8 、https://github.com/nuwax-ai/nuwax-client/pull/9 、https://github.com/nuwax-ai/nuwax-client/pull/10 ；前端 https://github.com/nuwax-ai/nuwax/pull/185
- beta 指针：https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwax-electron/beta/latest.json
- stable 指针：https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwax-electron/latest/latest.json
- 发布流程：`.github/workflows/release-electron-dev.yml`（头注释）、`.github/workflows/sync-electron-to-oss.yml`（来源与签名核验约 261–271 行，指针发布约 394 行起）、`docs/sign-windows.md`、`scripts/sign-prerelease-win.sh`、`scripts/release-stable.sh`
