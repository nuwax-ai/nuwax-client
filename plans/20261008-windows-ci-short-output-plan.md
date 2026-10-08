# Windows Actions 打包长路径修正

v3.0.11-beta.3 的 Windows job 113231822050 在 WiX light.exe 链接 MSI 时返回 LGHT0103。日志声明的 PreferOptionalChainOptions.d.ts 完整路径为 260 字符；这与旧 QA 包失败及已通过的短目录 QA 方案一致。取消原 run，保留 tag/SHA、Draft 和已有资产，公开与同步不执行。

- 将短目录配置抽成一个脚本，stable、beta 与 QA 的 Windows Actions 共用；按 runner 临时目录、run ID、attempt 和 arch 隔离输出。
- 只改 builder 的输出目录。完整版本、安装包文件名、签名、归档策略、资源载荷和非 Windows 默认目录保持现有规则。
- 构建、来源清单、Release 上传、QA artifact staging 使用同一个输出变量；无配置时提前失败，避免错误读取旧目录。
- 校验 runner Windows 绝对路径、长度、run ID、attempt 与架构；非法输入在写 package.json/GITHUB_ENV 前失败。
- 执行真实脚本回归，核对固定 builder schema、完整 payload 与版本保持，核对两套 workflow 的 Windows 分支、来源和上传目录一致。
- 通过脚本、pin 和 GitHub 三轨门禁后合入 release/v3.0.x，重新查远端占用，以 v3.0.11-beta.4 tag push 触发五平台重建。
- 新 run 验证 MSI 构建、五平台来源、S3 服务端 SHA256 与 Verify S3 步骤耗时；beta 两镜像字节一致，stable 保持原 3.0.10 指针。

用户接管真机和 QA 客户端验证，本任务只完成自动化检查、Actions 打包和镜像同步，不启动或替换真实客户端。

本地完成：20 项针对性测试及 252 项全量脚本测试通过；四 workflow actionlint、overlay:check、host-bridge:check、check:pin --remote origin/main 与 diff 检查通过。三问与失败证据落在 docs/acceptance/20261008-release-channels.md。

2026-10-08 实测完成：PR #17 的三轨检查通过，合入 release/v3.0.x 后，v3.0.11-beta.4@21f4500f 的 run 37760448840 五平台全部成功。Windows 实际输出为 D:/a/_temp/nw-37760448840-1-x64，原 260 字符文件路径缩至 190 字符，MSI/NSIS、来源记录和 Release 上传全部成功。后续同步 job 113295991814 通过，Verify S3 upload 从 v3.0.10 的 322 秒缩至本轮约 6 秒；实际观察到服务端 SHA256 COMPOSITE/FULL_OBJECT，大安装包未完整读回。beta 两镜像为 3.0.11-beta.4 且字节一致，stable 两镜像保留 3.0.10 原字节。完整日志、UTC 时间及指针 SHA256 已补入上述验收文档；真实安装/升级仍由用户验收。
