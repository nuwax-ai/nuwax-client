# 本机文件直访：恢复开启与 Windows 实机验收

日期：2026-10-15。release 在 `672ca584` 为 3.0.14/3.0.15 上线强制关闭了本机文件直访；本轮在原分支上恢复按设置开关加载，并补齐 Codex 未能执行的 Windows 实机 Electron 验收。真实账户已加载本机会话的人工回归与签名安装包验收仍待提测时进行。

## 分支与基线

- 壳：托管 worktree `/Users/apple/.codex/worktrees/local-file-access/nuwax-client`，分支 `codex/local-file-access`。原分支三个提交已全部在 release 中，本轮先 fast-forward 到 `origin/release/v3.0.x` 尖 `25aea924` 再继续。
- 前端（nuwax PC web）：同 worktree 的 `nuwax/` 独立 clone，分支 `codex/local-file-access`，已 fast-forward 到 `origin/feat-2026.9.30` 尖 `b30f4ae17`。前端本轮无需改动，未提交；壳不改 `nuwax`/`nuwax-dist` pin（仍为 release 的配对 pin `d7d0ff622` / `0bf94615`）。
- 基座 `eb0eeaca`、产物仓 `0bf94615` 与 release 一致。pin 的产物仓 `umi.1415370e.js` 已含 `releaseContext`/`nuwax-local` 消费代码，即线上前端早已具备本机路线，唯一开关在壳。

## 改动

| 改动 | 说明 |
| --- | --- |
| `startDesktopFeatures` 移除 local-files 硬门控 | 恢复 `features.local-files.enabled` 设置覆盖 ?? 清单默认（开启）。设置为 `false` 时零注册、`canUse` 返回 false，前端探测 `available:false` 回原 API 路线 |
| `index.test.ts` | 原「历史开关不得恢复」用例改为三态：未设置/true 注册，false 零注册且桥能力不可用。先在门控存在时确认 3 例失败，再移除门控 |
| 验收脚本新增宿主路径语义检查 | 显式绝对文件（Windows 下 `C:\` 与 `C:/` 两种形式）存在即读；反斜杠相对路径解析；`..\` 越界返回 `permission-denied` |
| 验收脚本 `--bundle-only <dir>` | 在开发机打包 main/preload/视频夹具，供无仓库检出的主机运行 |
| `scripts/acceptance/local-files-electron-windows.ps1` | Windows 运行器：取 electron 缓存 zip、在 `%USERPROFILE%` 下建夹具（避开 `%TEMP%` 8.3 短名）、失败时非零退出 |
| 验收脚本 `NUWAX_QA_REAL_FILE_SERVER_PORT` | 可选：经真实 IPC 对运行中的 nuwax-file-server 做列表/搜索（只读） |

适用范围仅商业版 Nuwax：特性声明 `products: ["nuwax"]` 且只存在于 overlay；商业 `canUse` 要求 `APP_NAME_IDENTIFIER === 'nuwax'`；前端 `hostBridge.localFiles` 只在 `getProduct() === 'nuwax'` 时返回。社区基座只保留原 `localFiles:pickDirectory`，社区版 NuwaClaw 不受影响（`base:test` 在干净基座通过）。

当前状态：仍在各自开发分支（壳、前端均为 `codex/local-file-access`），未提测、未合入 release；release 维持 `672ca584` 的关闭状态。提测合入后商业版默认开启，需要时可用 `features.local-files.enabled=false` 回退。

## 实际 Electron 验收

| 平台 | 结果 | 报告 |
| --- | --- | --- |
| macOS arm64，Electron 40.8.2 | 18/18 通过，含真实 nuwax-file-server 1.5.8（端口 61005）列表/搜索 | [mac](./20261015-local-file-access-reenable-mac-electron.json) |
| Windows 11 专业版 x64（win-pc，192.168.32.235），Electron 40.8.2 | 17/17 通过；开发者模式下软链 ZIP 条目实测（`symlinkVerified:true`），junction 别名目录导出排除输出/临时文件 | [windows](./20261015-local-file-access-reenable-windows-electron.json) |

Windows 覆盖：GET/HEAD/单段 Range/416、110MiB Range、H.264 实际解码与 seek（像素验证）、110MiB 完整 ZIP（隐藏项/空目录/硬链/软链）、HTML 相对 CSS/JS 与无宿主桥、业务/loopback 请求拒绝、opaque 导航拦截、跨窗口拒绝、授权释放、登出撤销、完整重载撤销、无 `/api/computer/static/*` 请求，以及盘符绝对路径与反斜杠路径。

Windows 经 OpenSSH 非交互会话运行，stderr 的 GPU 进程退出与 os_crypt 报错来自无桌面会话，不影响任何检查（视频走软件解码通过）。此前 Codex 连接超时是因为使用了旧地址 192.168.32.53；`~/.ssh/config` 中 `win-pc` 现为 192.168.32.235。

复现：

```bash
node scripts/acceptance/local-files-electron.mjs
NUWAX_QA_REAL_FILE_SERVER_PORT=61005 node scripts/acceptance/local-files-electron.mjs
node scripts/acceptance/local-files-electron.mjs --bundle-only /tmp/lf-bundle
```

Windows：把 `/tmp/lf-bundle` 与 `local-files-electron-windows.ps1` 复制到目标机后执行 `powershell -NoProfile -ExecutionPolicy Bypass -File local-files-electron-windows.ps1 -BundleDir <bundle>`。

## 质量门

| 检查 | 结果 |
| --- | --- |
| `npm run test:commercial` | 244 文件通过、1 跳过；3,041 测试通过、18 跳过 |
| `npm run base:test`（本 worktree 无运行实例，独占执行） | 135 文件通过、1 跳过；1,640 测试通过、18 跳过 |
| 主进程 features 全目录 | 32 文件、334 测试通过 |
| `npm run test:scripts` | 339 测试通过 |
| 前端 local-files 相关回归（`b30f4ae17`，15 文件） | 192 测试通过 |
| `host-bridge:check` / `check-feature-boundaries` / `check:pin` | 通过；基座脏文件 0 |
| 基座内商业生产构建（`build:main` + `build:renderer`） | 通过 |

## 前端覆盖复核

Codex 最终前端提交之后（`d1992b353..b30f4ae17`，含其后合入的 release 前端各线）文件访问相关代码仅有 locale 与桥类型变化，没有新增绕过本机路线的入口。剩余直连 `/api/computer/static/*` 的引用均属预期：`.gitignore` 读取是「加入 .gitignore」写操作的前半段（写操作保持原接口）、分享链接、远端回退及非本机会话。

## 正式提测前需补齐

- 真实账户、已加载本机会话的客户端内人工回归（文件树、预览、搜索、提及/工具路径点击、OpenUI、下载与整包导出、打开/定位），macOS 与 Windows 各一轮。本机正运行已安装的 release 版 Nuwax（占用 `~/.nuwax` 与 61xxx 端口），本轮未停用户实例起 dev 客户端。
- 签名安装包内的真实保存对话框、媒体拖动与完整 ZIP。
