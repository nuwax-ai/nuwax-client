# Nuwax 商业版打包与发布流程

> 当前版本号、通道与续跑入口见 [发布与更新通道](./release-channels.md)。v3.0.10 由 `v3.0.10` tag push 触发 GitHub Actions；stable 消费锁定的 `nuwax-dist` pin，beta 仍从源码 pin 构建。stable 构建后保持 Draft，完成 Windows 签名与安装验收，再显式同步公开。下文的 v3.0.2–v3.0.6 耗时和执行口径为历史记录。

## 本次问题暴露的缺口

`electron-v3.0.2` 与 `electron-v3.0.3` 的构建门禁可以通过，但安装后的 `/repo`、`/instant-message` 仍可能因 Electron 请求路由错误而加载 HTML 代替 JavaScript。构建成功、来源哈希正确，只能证明产物可生成且未被替换，不能证明安装包里的 WebView 能打开业务页。

当时 `sub:update` 构建并推送 `nuwax-dist`，正式发布工作流却从 `nuwax` 源码 pin 在五个平台各重建一次前端，`nuwax-dist` pin 不参与打包。这使“双 pin”看起来锁定了发布载荷，实际安装包使用的是五次现场构建的结果；stable 后续已改为消费产物 pin。

## 实测耗时与优化顺序

以 `electron-v3.0.3` 的成功构建为基线：前端门禁约 5 分 29 秒，随后五平台并行。最慢的 macOS x64 job 约 1 小时 42 分，其中重复构建前端约 8 分、Computer Use helper 约 7 分 31 秒、`Build Electron app` 约 1 小时 20 分。该步在 20:36 完成 DMG blockmap，直到 21:31 才完成 ZIP blockmap；约 55 分钟集中在 macOS ZIP 产出阶段。macOS arm64 的 `Build Electron app` 也约 1 小时 14 分。Windows 与 Linux 分别约 37 分、29 分，因此只缩短前端构建不会解决总耗时。

优化按影响和风险依次进行：

1. **先测 ZIP/包体。** 现有 `dist:mac` 命令显式设置 `compression=maximum`，对应 ZIP level 9；v3.0.6 候选构建用环境变量调到 level 1，保留 DMG 与 ZIP 双目标、签名和公证。ZIP 是 macOS 更新载荷，不能省去；压缩级别下降也会增加下载体积。
2. **裁剪包内资源。** 当前本地准备的 Electron `resources/` 约 1.7 GB，其中 `claude-code-acp-ts/node_modules` 约 382 MB、`nuwax-codex-acp-ts/vendor` 约 271 MB、`nuwax-file-server/node_modules` 约 132 MB；这些不是最终安装包的精确大小，但值得逐项核对运行必需文件、平台/架构文件和开发依赖。裁剪后运行对应功能的安装包验收。
3. **前端只构建一次。** 正式版已改为让锁定的 `nuwax-dist` 作为五平台共同输入：逐平台校验产物 gitlink、工作树纯净和源码版本戳后复制到待打包目录，省去五次 `pnpm install + build:prod`。预期缩短每个平台约 5–8 分钟并减少 CI 总算力；总时长仍由 macOS ZIP 决定。beta 暂保持源码构建，后续统一。
4. **缓存确定性构件。** 按源码 SHA、工具链版本、平台和架构缓存 Computer Use helper、agent-kit 与可复用资源；命中后仍核对产物 SHA 和 ABI。不要缓存最终安装包，也不要用无校验缓存掩盖缺失资源（v3.0.2 Windows 首轮故障属于此类准备缺口）。
5. **避免无效重打包。** 在昂贵的五平台矩阵前完成前端/双轨测试、路由冒烟及产物 pin 检查。打包失败时只重跑失败平台，继续使用相同 tag/SHA；绝不为了提速跳过签名、公证和安装包验收。

## v3.0.6 候选实测（2026-09-30）

v3.0.5 由用户取消，因此完整发布耗时用成功的 v3.0.3 作对照；两版壳基座相同、前端源码 pin 不同，以下是实际发布对照，并非完全相同输入的基准实验。

| 指标 | v3.0.3 | v3.0.6 候选 | 变化 |
| --- | ---: | ---: | ---: |
| 五平台 CI 总耗时 | 1 小时 48 分 31 秒 | 50 分 02 秒 | 缩短 58 分 29 秒（53.9%） |
| macOS x64 `Build Electron app` | 80 分 18 秒 | 30 分 11 秒 | 缩短 50 分 07 秒 |
| macOS x64 DMG blockmap 到 ZIP blockmap | 55 分 36 秒 | 5 分 19 秒 | 缩短 50 分 17 秒 |
| macOS arm64 ZIP | 699,475,021 B | 736,581,718 B | +5.30% |
| macOS x64 ZIP | 721,797,598 B | 761,250,870 B | +5.47% |
| macOS arm64 DMG | 648,203,146 B | 807,598,670 B | +24.59% |
| macOS x64 DMG | 667,390,776 B | 834,536,539 B | +25.04% |

五个平台的前端装载步骤均为 0–2 秒，清单记录同一个前端目录 SHA256。Linux/Windows 包体与 v3.0.3 基本一致，Mac DMG 额外增大与本次压缩参数相关；下一轮应分别控制 ZIP 和 DMG 的压缩，同时保留签名、公证、自动更新 ZIP 与安装包验收。v3.0.6 已完成 CI、Windows 签名及本机 arm64 DMG 的哈希/签名/公证校验，仍待登录态资料库和女娲智联验收，保持 Draft。

## 推荐的阶段与准入条件

| 阶段 | 动作 | 必须留存的证据 |
| --- | --- | --- |
| 1. 锁定输入 | 在隔离工作树更新并提交壳、前端源码与前端产物 pin；提交 overlay 修复和发布说明；推送发布分支 | 外层 commit、三个 gitlink、前端产物的完整源码 SHA 与内容 SHA256 |
| 2. 预检 | 检查远端 pin 可达、工作树无非托管改动、overlay 与基座同步、前端产物来源一致 | `check:pin`、`overlay:check`、双轨测试、前端测试与架构检查 |
| 3. 候选构建 | 以不可变 tag 构建五平台安装包，仅上传 Draft Release | 每个平台的源码、前端载荷与安装包哈希清单；签名/公证结果 |
| 4. 安装包验收 | 从 Draft 下载**本次 CI 产物**安装到隔离环境；登录测试账号，打开首页、资料库、女娲智联，并分别刷新或重启后直达；检查 Network/Console 无错误的 chunk 与资源 MIME；验证更新路径 | 平台、安装包 SHA256、测试账号环境、页面结果、失败日志/截图；至少 macOS 与 Windows 必过，Linux 在支持的桌面环境检查 |
| 5. 签名与提升 | Windows 对 Draft 的 unsigned 安装包签名，核对签名前后来源；验收报告通过后单独触发 stable 同步 | 签名证书/PE 校验、签名安装包哈希、验收报告、GitHub/S3/OSS 镜像哈希与 `latest.json` |

任何阶段失败都在相同 tag/SHA 上续跑可重试的构建或签名步骤；如果修复需要改源码，则升新版本，不能移动已有 tag。`latest.json` 只在安装包验收和签名均通过后更新。

## 本次 v3.0.5 执行口径

现有 CI 已由 tag 启动，仍按源码 pin 重建前端。保留此来源并核对五平台清单，不在构建中途切换前端载荷。CI 成功后使用 `npm run release -- --channel stable --version 3.0.5 --stage sign` 处理 Windows 签名。先验收 CI 的真实安装包，确认 `/repo` 和 `/instant-message` 点击、刷新及重启直达都正常，再用 `--stage sync` 同步 stable。未验收通过前保持 Draft，不更新通道指针。

## 下一版要落实到脚本和 CI 的改动

1. 已将 `nuwax-dist` pin 设为正式包的唯一前端载荷；下一步让产物仓额外写入完整前端源码 SHA 和内容 SHA256，发布预检及每个平台在打包前校验它们，并让 beta 共用相同机制。
2. 增加真实 Electron/loopback 的路由冒烟测试：主文档 `/repo`、`/instant-message` 返回 SPA HTML，同一路径下加载的动态 JS/CSS 返回对应资源，后端 iframe/API 仍走代理。该测试应使用最终待打包前端目录运行；不可仅模拟 `Content-Type` 而忽略实际响应体。
3. 将安装包验收作为 Draft 到 stable 的自动阻断条件。同步工作流读取与 tag、五平台清单、安装包 SHA256 绑定的验收结果；缺失或失败时拒绝发布。签名可以先完成，但不能代替运行验收。
4. 将 `release` CLI 的默认稳定版流程改成显式候选构建、签名、验收、同步四阶段，并提供清晰的当前阶段及续跑命令，避免一条命令在无人确认安装包时直接推动 stable 指针。
