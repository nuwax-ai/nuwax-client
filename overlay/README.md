# overlay/ —— 商业自有代码（文件覆写机制）

商业专属实现不进基座仓（基座产品中立，服务 nuwa-cli / nuwaclaw / Nuwax 三方），
以**整文件覆写**方式注入基座构建：

- 目录结构 = 基座仓相对路径：`overlay/crates/agent-electron-client/src/...`
  → 同步后覆写 `nuwa-electron-shell/crates/agent-electron-client/src/...` 同名文件。
- `overlay/README.md` 为机制说明，**不参与同步**。
- 同步：`node scripts/sync-overlay.js`（`--check` 干跑看差异，`--clean` 还原基座工作树）。
  统一开发/打包 CLI 和 `in-base.js` 已自动前置同步；CI 构建同样先 sync 再 build。
  准备引擎拒绝覆盖基座中未被工具链管理的本地改动。
- 已同步文件清单在根目录 `.overlay-sync.json`（gitignore）；overlay 删除文件时
  联动还原/清理基座工作树对应文件。
- bump 基座 pin 后请跑 `--check` 人工核对覆写文件与新版基座的差异，防止基座侧
  同文件演进导致覆写悄悄过期。
- **防泄回**：提交基座前跑 `npm run check:pin`（overlay 托管路径不得进基座提交，
  CI 另有 `--remote origin/main` 字节级防线）。

## 覆写面积纪律

只放商业专属实现的整文件；基座若为商业功能开插槽（可选注册/扩展点），优先用插槽
而不是大文件覆写，控制升级冲突面。bump 基座 pin 后必须跑 `npm run overlay:check`
核对差异。当前覆写清单（36 文件；下表列主干条目，图标四件套/tray 模板四件/
preload 与类型声明等配套见 `find overlay -type f`）：

| overlay 文件（基座同路径） | 内容 |
|---|---|
| `src/main/ipc/commercialAuth.ts` | 商业注册编排：`initializeCommercialAuth()` 以 ACCESS_TOKEN 为登录事实源（Bearer + 商业独立 deviceId 调 `/api/sandbox/config/reg`），401/4010/4011 判登录失效并回调主进程清理；换域/设备变更时 `clearRegistration()` 清注册派生凭据 |
| `src/main/ipc/commercialAuth.test.ts` | commercialAuth 的注册/清理用例 |
| `src/main/ipc/nuwaxBridgeHandlers.ts` | 基座中立桥的**超集**：auth 命名空间（token 按 origin 持久化 `nuwax.accessToken.<origin>`）+ 登录态驱动的服务编排（AuthLifecycle 接线、未登录业务 IPC 门禁）+ 换域事务（阻止旧任务→清认证→停服→切网关→载新域，会话代次拒绝迟到写回）+ saveImage 相对地址归一与原子落盘 |
| `src/main/ipc/nuwaxBridgeHandlers.tokenScopes.test.ts` | token 键空间 + 换域凭据清理 + saveImage 用例 |
| `src/main/services/loopbackGateway/index.ts` | 本地化承载编排（覆写基座 no-op 桩插槽；dist 解析优先 `NUWAX_FRONTEND_DIST` env=壳根 nuwax-dist，开发回落同一产物子模块，打包=resources/nuwax-dist）；运行时键携带 backend，域名变更经 refreshLoopbackGateway 通知 renderer 重载 webview |
| `src/main/services/loopbackGateway/gateway.ts` | 回环网关本体（dist 托管 + 后端反代 + Bearer/x-client-type 代注） |
| `src/main/services/loopbackGateway/{gateway,index}.test.ts` | 配套测试（随 sync 进基座工作树随全量跑） |
| `src/renderer/components/pages/SettingsPage.tsx` | **独立行式重构（非超集）**：商业版设置页自持实现——分组行列表 + 行内即点即存（2026-09-13 重构，不再跟随基座表单版）；无「实验功能」区块与 `guiMcpPort`；配套私有样式 `src/renderer/styles/components/SettingsPage.module.css` |
| `public/icon.{png,icns,ico}` + `public/icon-dock.png` | **商业黑标**：zinc 黑砖 + 反白字形（2026-09-13，由基座原紫标母版反解字形重绘，圆角轮廓沿用原 alpha）。覆盖 mac bundle/dock、win 安装包、加载屏与运行时 `app.dock.setIcon`；tray 模板图为单色语义不动。基座社区版保持原紫标 |
| `src/main/bootstrap/migrate.ts` | **有意行为性覆写（非超集）**：迁移链置空——不迁移 `.nuwaclaw`/`.nuwawork`/`.nuwax-agent`/`.nuwaxbot` 任何旧产品数据与登录态（2026-09-11 改名决策，商业版全新开始）；迁移期强制关闭历史遗留的 `guiMcpEnabled`/`sandbox_policy.enabled`（v1.0.4 起实验功能移除，防老用户幽灵开关） |
| `src/main/bootstrap/migrate.commercial.test.ts` | migrate.ts 的配套测试：目录隔离 + 实验开关清理 + workspaceDir 前缀重写（基座版测的是基座迁移行为，随 overlay 同步须一并覆写保持同步态自洽） |
| `build/installer.nsh` | **新增（非覆写）**：Windows NSIS 定制。`customHeader` 宏重写 `Name` 为中文营销名「女娲Nuwax」（向导标题与正文）；刻意**不重写 `BrandingText`**，底部「Nuwax \<ver\>」保持 ASCII。机制=该宏由 installer.nsi 在 common.nsh 之后插入，后写的同名指令覆盖先写的。`build/` 为 electron-builder 的 buildResources 目录，文件自动被拾取 |
| `src/shared/locales/{en-US,zh-CN,zh-TW,zh-HK}.json` | **严格超集**：基座四语言全量 + 换域确认弹窗 3 键（`Claw.Settings.messages.switchDomain{Title,Current,Next,Warn}`）。i18nLocales.test.ts 强制四语言 key 集合与占位符一致，基座新增 key 时须同步合入全部四份 |
| `src/main/services/fullDiskAccess.ts` + `.test.ts` | **新增（非覆写）**：全磁盘访问（macOS FDA）检测 + 初始化一次性引导（2026-09-21）——探针=open 系统 TCC.db；「暂不」持久化 `nuwax.fullDiskAccessPrompt` 永不再自动弹；聚焦/解锁只静默复查；boot 钩子挂 nuwaxBridgeHandlers（powerPolicy 旁），设置页状态行（仅 mac）为拒绝后唯一再入口 |
| `src/renderer/components/pages/PermissionsPage.tsx` | 基座超集（2026-09-21）：商业宿主存在 fullDiskAccess 命名空间时，「授权」页全磁盘访问行用 recheck 真值覆盖基座恒 unknown 的状态、前往设置走带兜底的 openSettings；社区版与基座逐字节同行为 |

维护规则：基座对应文件演进时，先 `overlay:check` 看 diff，把基座侧改动手工
合入 overlay 版本（overlay 版本必须是基座版本的严格超集；两类例外——
`migrate.ts` 及配套 commercial 测试（行为性覆写，须保留「迁移链置空」语义）、
`SettingsPage.tsx`（独立行式重构，基座侧同文件演进须手工评估合入，不得把
实验区块或「编辑解锁」范式带回））。

## 品牌显示名与文件名分离（2026-09-15）

商业身份要求**文件名/包名一律 ASCII**（`Nuwax-Setup-*.exe` / `Nuwax.app` /
deb 包名 `nuwax`），而 `productName` 一个值同时决定显示名与产物文件名，
故中文营销名「女娲Nuwax」只能在各平台的**显示名字段**单独覆盖：

| 平台 | 显示名载体 | 保持 ASCII 的部分 |
|---|---|---|
| Windows | overlay `build/installer.nsh`（向导）+ CI `build.nsis.shortcutName`（快捷方式） | 文件名、`BrandingText` 底部版本行、`Uninstall Nuwax.exe` |
| macOS | CI `build.mac.extendInfo.CFBundleDisplayName` | `CFBundleName`、`Nuwax.app`、dmg 文件名 |
| Linux | CI `build.linux.desktop.entry.Name` | `deb/rpm.packageName`、产物文件名 |

⚠️ **不得**把顶层 `productName` 或 `APP_NAME_IDENTIFIER` 改成中文：前者被
`autoUpdater` 用 `app.getName()` 拼「Uninstall \<name\>.exe」定位卸载程序
（改中文断更新链），后者派生数据目录 `~/.nuwax` 与 UA token。userData
（`app.setName("Nuwax")`）与工作空间（`~/Nuwax`）均为硬编码字面量，不受影响。
