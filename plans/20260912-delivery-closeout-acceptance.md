# Nuwax 客户端 1.0.4 提测验收记录

> 最新包为 **QA.4**；QA.3 存在真实 302 另存失败。以 [QA.4 验收记录](20260912-qa4-redirect-acceptance.md) 为准；本文早轮哈希与“可提测”结论仅供追溯。

- 对应计划：`plans/20260912-delivery-closeout-plan.md`（登录/启停/隔离/文件/动画收尾）、[历史记录](https://github.com/nuwax-ai/nuwax-client/blob/a65c537a143c167e774feb18c22ceccab24b0b69/plans/20260912-remove-experimental-features-plan.md)（移除两个实验功能）
- 版本：**1.0.4-qa.20260912**，仅预发布测试包，**未更新正式渠道**
- 记录时间：2026-09-12 13:20（CST）

## 接手续验（2026-09-12，QA.2 最新进展见下方链接）

**后续发现正常退出残留业务进程，旧包不得作为最终交付包。修复及新包请看 [QA.2 验收记录](20260912-qa2-acceptance.md)。**

**已产出预发布测试包，但尚未达到原计划的完整验收门禁。** 首次设备注册仍有后端阻塞；真实文件上传/下载/图片另存、登录中切域及双产品完整业务共存尚未验证。不得把测试包可安装等同于所有交付条件通过。

- 当前源码：外层 `299d89dc`（产品代码映射 `9b23e7af`），基座 pin `801c1aa6`。保留接手任务已确认的 **3000ms 呼吸启动屏**及商业版自身 savedKey 升级保留策略。
- 独立重跑商业测试：**111 files / 1309 passed / 17 skipped**。overlay 11 文件一致；本小节统计时仅修正一处测试格式漂移；随后发现退出残留并修复，见 QA.2 记录。
- 独立重算两个最终安装包 SHA256，与文末最终交付表一致。
- macOS 最终包载荷在隔离 profile 下，通过真实 preload/IPC 完成 `testagent.xspaceagi.com → agent.nuwax.com → testagent.xspaceagi.com`。每次返回 success，网关登录页 redirect 指向对应域，企业登录入口可见，四个业务服务均停止。**这证明未登录壳接口换域；不替代已登录 UI 点击、在途注册取消及旧站点存储清除的真机验收。**
- Windows 安装态抽查发现旧载荷 `148b9a43…`，最终 win-unpacked 载荷是 `5b7bdaf4…`。早轮安装截图不能证明最终包已安装；正在以最终安装包执行交互会话升级，结果另行记录。
- 本轮原始证据归档到交付目录 `takeover-evidence/`；截图 `mac-takeover-domain-roundtrip.png`。社区、类型与构建结果仍为前轮记录，本轮未修改源码，不重复宣称已重新运行这些门禁。

以下保留前轮记录用于追溯；旧提交/哈希及“可提测”措辞不覆盖本节结论。

## 提交映射（早轮历史，最终映射见文末）

| 仓库 | 分支 | 提交 | 说明 |
|---|---|---|---|
| `nuwa-electron-shell`（基座） | `feat/electron-1.0.4-fixes` | `ae7e21aa` | 中立机制层：登录生命周期编排、未登录门禁、停服失败如实返回、设备身份独立盐 |
| `nuwax-client`（外层） | `feat/electron-1.0.4-fixes` | `b7173320` | overlay 商业语义 + 基座 pin `ae7e21aa` |

两仓提交均**仅本地**（未 push）。复现构建：

```
git checkout b7173320 && git submodule update --init nuwa-electron-shell
node scripts/sync-overlay.js                       # 商业语义进工作树
cd nuwa-electron-shell/crates/agent-electron-client
NUWAX_APP_IDENTIFIER=nuwax NUWAX_APP_DISPLAY_NAME=Nuwax NUWAX_PORT_OFFSET=1000 npm run build
```

基座提交**有意不含** 11 个 overlay 托管文件（`migrate.ts`、`migrate.commercial.test.ts`、`nuwaxBridgeHandlers.ts` + tokenScopes 测试、`loopbackGateway/{index,gateway}.ts` 及测试、`SettingsPage.tsx`、`commercialAuth.ts` 及测试）——商业代码不得泄回中立基座；提交后基座工作树仍有这 11 个文件的改动属预期。

## 1. 结论（早轮记录，最终状态见本文顶部复核）

**早轮判断**：双平台测试包已从上述提交构建，代码门禁全绿，macOS 与 Windows 均完成安装/启动态验收；登录态驱动的服务起停、未登录只起页面网关、旧产品目录零迁移、随包前端 + 企业登录入口均经真实进程验证。

**一项后端阻塞**：全新设备首次注册接口仍不可用（见 §5.1），因此「全新机器 登录→注册→业务服务全量起来」的闭环当前只能验到注册失败态（客户端行为正确：显式报错、业务服务保持停止）。

**两项未验证**（明确标注，不计入通过）：企业域名 A→B→A 真机往返、上传/下载/图片另存真机业务闭环（见 §6）。

## 2. 代码门禁

| 门禁 | 命令 | 结果 |
|---|---|---|
| 商业侧回归 | `node scripts/sync-overlay.js` 后 `npx vitest run` | **111 files / 1309 passed**，17 skipped，0 failed |
| 社区基线 | 隔离副本 `npm run base:test`（overlay 托管文件确认为 HEAD 版） | **107 files / 1263 passed**，17 skipped，0 failed |
| 类型检查 | `npx tsc --noEmit` | 全仓 **202** 条错误，全部位于本次未改动文件；**本次改动/新增 42 个文件 0 条**。基线对照：同目录 HEAD 检出 `212` 条（`git worktree add` 独立跑），净减 10 |
| overlay 一致性 | `node scripts/sync-overlay.js --check` | 0 个待同步（11 个一致） |
| 空白符 | `git diff --check` / `git -C nuwa-electron-shell diff --check` | 干净 |

本轮修复的两条新增类型错误（均在 overlay 文件）：

- `loopbackGateway/index.test.ts`：`process.resourcesPath` 为只读，改 `Object.defineProperty`。
- `migrate.commercial.test.ts`：mock 实现签名与 `vi.fn((...args: unknown[]) => ...)` 不兼容，参数收敛为 `unknown`。

另修复一处**覆盖事故**：上一轮以 `cat >` 重写 `deviceId.test.ts` 时把原有 7 条用例（64 位十六进制、`machineIdSync(true)`、缓存、首调日志、hostname 回退、不同 machineId 不同值）替换成了 2 条。已恢复为 9 条（原 7 条 + 商业身份隔离 2 条），两轨均通过。

## 3. 交付物与校验值

### macOS（arm64，未签名）

| 项 | 值 |
|---|---|
| 交付文件 | `~/Documents/Nuwax-delivery/20260912/Nuwax-1.0.4-qa.20260912-arm64-unsigned.app.zip` |
| 大小 / SHA256 | 786,165,144 B / `523ed7687b414dd15609b9abff4bd8ee076991b7c3bff97e55a7c98c91fdd548` |
| App 目录 | `~/Documents/Nuwax-delivery/20260912/mac/mac-arm64/Nuwax.app`（2.2 GB） |
| 代码载荷 SHA256 | `app.asar` = `a44809625e65c57c845b70e0ee3f15d7e5fc2396565fb33c280da9378c495103` |
| 版本 / 名称 | `CFBundleShortVersionString=1.0.4-qa.20260912`、`CFBundleName=Nuwax` |
| 签名 | `identity=null` → 未签名（adhoc，TeamIdentifier 未设置）；本机 `spctl` 判定 accepted |
| 随包前端 | `Contents/Resources/nuwax-dist`，91 MB |

### Windows（x64，未签名）

| 项 | 值 |
|---|---|
| 交付文件 | `win-pc:C:\Users\soddygo\Nuwax-delivery\20260912\windows\Nuwax-Setup-1.0.4-qa.20260912-unsigned.exe` |
| 大小 / SHA256 | 795,385,707 B / `0477e5650f640b167864c3b1320b95d85b11cc533ed7ba216b6289a8dced6450` |
| 安装包元数据 | ProductName `Nuwax`、ProductVersion `1.0.4-qa.20260912`、CompanyName `Nuwax Team` |
| 代码载荷 SHA256 | `app.asar` = `148b9a439ea3c766be7d267436edcacb87967ead331e11ccd817a1305da8fd79`（安装后同值，见 §4.3） |
| 签名 | 未签名（`signAndEditExecutable=false`，故 `Nuwax.exe` 文件属性显示 Electron 40.8.2 属预期） |
| 随包前端 | `resources\nuwa-dist`→`nuwax-dist`，794 files / 81,366,586 B |

两个包的 `dist/main/main.js` 均含本轮最后的失效清理逻辑（`if (["4010","4011"].includes(payload.code)) expired?.()` 与 `nuwax:device:v1` 盐），即包与提交一致，非早先快照。

## 4. 真实运行态验收

### 4.1 macOS 包启动 + 登录恢复

`playwright-core` 驱动已打包 App（真实用户目录）：`name=Nuwax`、`version=1.0.4-qa.20260912`、`userData=/Users/apple/Library/Application Support/Nuwax`（独立于 NuwaClaw）、webview 载入既有登录域 `https://testagent.xspaceagi.com/home`。

### 4.2 macOS 干净首次启动（隔离 profile + 旧目录哨兵）

以隔离 HOME 启动打包资源，并预置 `.nuwaclaw`/`.nuwawork`/`.nuwax-agent`/`.nuwaxbot` 哨兵文件：

- 四个业务服务 `fileServer/lanproxy/ttyd/computerServer` 状态全部 `running=false`；
- webview `http://127.0.0.1:46800/login?redirect=…agent.nuwax.com` 正常出图，正文含「企业登录」，`NuwaClawBridge` 存在；
- 断言输出 `LEGACY_DATA_UNCHANGED`：四个旧产品目录未被读改删。

截图：`~/Documents/Nuwax-delivery/20260912/mac-clean-bundled.png`。

### 4.3 Windows 干净安装 + 安装态启动

- 静默安装（**必须在交互会话内执行**，见 §5.2）：安装到 `%LOCALAPPDATA%\Programs\Nuwax`，33,380 files / 2.87 GB；
- 卸载登记项：`Nuwax 1.0.4-qa.20260912`，Publisher `Nuwax Team`；
- 安装后 `resources\app.asar` SHA256 与打包产物一致（`148b9a43…`），随包前端 794 files / 81.37 MB；
- 启动安装后程序：5 个 `Nuwax` 进程正常起来，界面渲染**登录页**（密码登录 / 验证码登录注册 / 「企业登录」/ `Powered by nuwax`），窗口无异常；
- 未登录态下 61000–66000 端口段内**没有本应用监听**（该段仅有开发实例 64487 与 WorkBuddy 64516/64526），与「未登录只运行页面网关」一致。

截图：`win-pc:C:\Users\soddygo\nuwa-win-runtime.png`（归档于本机 `/tmp/nuwa-win-runtime.png`）。

> 说明：Windows 安装包**保留安装状态**在 win-pc 上供后续人工验收；验收启动的应用进程（session 3）验收后未强杀，可自行关闭。

## 5. 已知问题与影响

### 5.1 后端：全新设备首登注册不可用（阻塞，非客户端缺陷）

以网页登录 ACCESS_TOKEN + 商业版独立 deviceId、且不携带旧 savedKey 调 `/api/sandbox/config/reg`，返回 `4000：动态认证码或密码不能为空`。因此全新安装即使网页登录成功也无法完成设备注册。客户端行为符合要求（明确暴露注册失败、业务服务保持停止，不用旧 savedKey 绕过独立设备注册）。**待后端放开首登接口后客户端无需再改**。

### 5.2 Windows 安装器在非交互会话中不可安装（环境事实，非包缺陷）

经 SSH 直接执行安装包（session 0，无桌面）时退出码 `0xC0000005`，并残留挂起的安装进程；同一包经计划任务派发到已登录的交互会话（session 3）安装正常。安装包本体完好（7z 可完整列出 794 MB 载荷）。**给测试人员的口径：双击安装（交互桌面），不要在远程非交互 shell 里装**；安装耗时约 5 分钟（2.87 GB 落盘）。

### 5.3 设备身份盐变更 ⇒ 同机会被服务端视为新设备

`deviceId` 由盐 `nuwax-agent` 改为产品独立盐 `nuwax:device:v1`。同机安装 1.0.4 后，服务端会按新 deviceId 重新注册，即「原来的电脑」记录会被就地刷新/新建。旧记录不自动删除；因 §5.1 阻塞，该路径当前会停在注册失败。上市前需确认后端对首登的支持，并在提测说明中告知测试人员。

### 5.4 实验功能移除对老用户的影响

Sandbox / GUI MCP 开关不再有 UI 入口，且迁移期会强制把历史 `guiMcpEnabled=true`、`sandbox_policy.enabled=true` 关闭（幂等，仅发现开启才写）。v1.0.0–v1.0.3 已带该设置页发布，故老用户升级后这两个实验能力不可再开启——预期行为，社区基座不受影响。

### 5.5 包未签名

mac 为 adhoc/未签名，Windows 未签名。测试机若开启 Gatekeeper/SmartScreen 需人工放行。

## 6. 未验证项（不计入通过）

| 项 | 状态 | 原因 / 建议 |
|---|---|---|
| 企业域名 A→B→A 真机往返 | 未做 | 换域事务（阻止旧任务→清认证→停服→切网关→载新域）有单测覆盖（`nuwaxBridgeHandlers.tokenScopes.test.ts`、`loopbackGateway/gateway.test.ts`），但未做真机 UI 往返；建议测试人员在包内点「企业登录」切 A→B→A 观察服务与页面 |
| 上传 / 下载 / 图片另存真机闭环 | 未做 | 需真实登录 + 工作区；代码侧已改为临时文件原子落盘 + 失败清理 |
| 与 NuwaClaw 同机共存 | 部分 | 已验数据目录独立（`Application Support/Nuwax`）、商业版不按端口杀未知进程；未在同一台机器上同时跑两个产品的完整业务流 |
| 离线启动与恢复、退出重启 | 未做 | 建议在真机断网/重启场景补验 |
| 全新机器「登录→注册→服务全起」闭环 | 阻塞 | §5.1 后端接口 |

## 7. 测试人员用例（可直接执行）

1. **干净安装**：Windows 双击 `Nuwax-Setup-1.0.4-qa.20260912-unsigned.exe`（勿在远程 shell 内静默装）；mac 解压 zip 后右键打开。
2. **未登录态**：启动后应只见登录页/企业登录入口；任务管理器确认无 fileServer/lanproxy/ttyd/ComputerServer 业务进程。
3. **登录联动**：网页登录成功 → 观察业务服务自动拉起；登出 → 观察业务服务全部停止。
4. **企业登录切域**：点「企业登录」从域 A 切到域 B，再切回 A；每次切换后旧域页面不应继续用旧凭据，业务服务应先停后起。
5. **与社区版同机**：同时安装 NuwaClaw，确认两者数据目录互不读写、Nuwax 不会杀掉 NuwaClaw/CLI 的进程。
6. **文件链路**：登录后上传、下载、图片另存；断网中途取消，确认无残留临时文件、无损坏文件。
7. **启动动画**：冷启动观察 loading 至少可见 3000ms（用户后续确认），初始化失败时应给出可重试提示而非白屏。

## 8. 证据留档

- 商业/社区测试日志、tsc 日志、安装与启动截图：本机 `/tmp/nuwax-full-now.log`、`/tmp/nuwax-community-now.log`、`/tmp/nuwax-tsc-now.log`、`/tmp/nuwa-base-head-tsc.log`（HEAD 基线）、`/tmp/nuwa-win-runtime.png`
- macOS 交付目录：`~/Documents/Nuwax-delivery/20260912/`
- Windows 交付目录：`win-pc:C:\Users\soddygo\Nuwax-delivery\20260912\windows\`（含 `.blockmap`、`latest.yml`）

---

## 追加轮（2026-09-12 晚，用户实测反馈驱动的四项修复 + 一项重大发现）

本轮全部经 PR 进基座 main（单主干，merge commit 不 rebase）+ 外层 overlay 直提；双平台包已按最终提交重建。

### 修复清单

| # | 项 | 内容 | 落点 |
|---|---|---|---|
| 1 | 启动屏图标居中 | flex 整组居中把图标顶到中心上方（实测 dy=-45px）→ 图标绝对定位钉全窗口正中，Spin/文案/重试收进 `.app-loading-body` 置于图标下方；打包版复测 dy=1px | 基座 PR #7 |
| 2 | 最少展示时长 | `MIN_SPLASH_MS` 800→**3000**（用户拍板暂定值，仅改常量）；测试改引用常量；打包版实测可见 ~2.9s（150ms 轮询误差） | 基座 PR #7 |
| 3 | 启动动画形态 | 移除图标下方 Spin 转圈，改**图标自身呼吸缩放**（scale 1↔1.08、1.6s 循环；失败态静态不动画）；打包版复测：Spin 节点 0、动画名 `app-loading-breathe`、缩放中中心点不移 | 基座 PR #8 |
| 4 | 升级注册阻断 | 盐变更迁移曾把 `auth.saved_key` 一并清掉，而后端 reg 必须携带 savedKey → **1.0.3 存量用户升级后永远无法重新注册**（本机真机复现：清空后 4000，从备份种回即恢复且「旧 savedKey+新 deviceId」被后端接受）。修复=迁移时保留 savedKey，其余注册派生凭据照清 | 外层 overlay `075338ce` |
| 5 | **renderer 品牌身份（重大）** | `constants.ts` 的 `typeof process` 守卫在渲染进程运行时恒走 undefined 分支，**丢弃 vite define 注入的品牌字面量——商业版渲染层身份自 v1.0.0 起一直是社区缺省 nuwaclaw/端口 0**（主进程/preload 正确；此前靠社区版 AutoReconnect 与商业主进程桥的意外拼合兜底，真机日志实证）。修复=去守卫直读 env | 基座 PR #9 `801c1aa6` |

另修 CI flaky：`gateway.test.ts` x-client-type 用例 ubuntu 上两次 `UND_ERR_SOCKET` → 用例 fetch 改 `connection: close` + 瞬断重试一次（外层 `baa93abd`）。

### 修复 #5 的真机验证（商业主链首次按设计端到端跑通）

修复后打包版（真实登录态）：**renderer AutoReconnect 0 次**（按设计禁用），主进程生命周期 `getToken → registering → starting → ready` 约 9 秒闭环，fileServer/lanproxy/ttyd/ComputerServer 全部 running，webview 停在已登录 home。修复前同机日志显示走的是社区 AutoReconnect 拼合链。

### 最终提交映射（替代正文旧映射）

| 仓库 | 分支 | 提交 | 含 |
|---|---|---|---|
| 基座 | main | `801c1aa6`（merge PR #9） | 1.0.4 全部基座改动 + 居中/3s（#7）+ 呼吸（#8）+ 身份修复（#9） |
| 外层 | main | `9b23e7af` | overlay（含 savedKey 保留 `075338ce`、flaky 修复 `baa93abd`）+ pin `801c1aa6` |

### 最终交付物（覆盖正文 §3 旧哈希）

| 平台 | 文件 | SHA256 |
|---|---|---|
| macOS arm64 | `~/Documents/Nuwax-delivery/20260912/Nuwax-1.0.4-qa.20260912-arm64-unsigned.app.zip` | `84179a15b7dbec9164782742e79684ba4432e9bca5761d980625e569928f8d7c`（app.asar `e7bb999d…`） |
| Windows x64 | `win-pc:…\windows\Nuwax-Setup-1.0.4-qa.20260912-unsigned.exe`（796,330,589 B） | `7c58c3681dcb684a13498ad72c2442677b21096f958eefb1e3538a04234c8d48`（含呼吸+身份修复核验：`app-loading-body`×11、`--pulse`×7、`typeof process` 守卫品牌注入 0） |

### 事件记录（对测试人员的影响说明）

- 本机 `~/.nuwax` 曾在 1.0.4 包冒烟中被盐迁移清掉 savedKey（修复 #4 之前的行为），已从 `nuwax.db.bak-20260911-150813` 备份种回并验证自愈；修复后不再发生。
- §5.3 的悬念就此收口：后端接受「旧 savedKey + 新 deviceId」重注册；存量升级路径 = 迁移保留 savedKey → reg 成功 → 服务起（真机实证）。
