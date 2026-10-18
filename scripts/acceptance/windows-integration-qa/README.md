# Windows 组合包隔离验收

仅用于 `C:\nuwax-qa\integration-20261018` 的自有 UTM 测试目录，不作为生产打包入口。真实 main、preload 与宿主 renderer 必须先从当前 overlay 同步、生产构建，再上传 `dist.tgz` 解压到 `source/dist`。

1. 首次运行 `prepare.ps1`，遇到已有根目录或 QA 数据名立即停止。不得重复准备或指向日常目录。
2. 将 `build.cjs`、`bootstrap.cjs`、`foreign-preload.cjs` 与当前 overlay 的 NSIS include、恢复脚本和清单生成器放入 `source`。恢复脚本身份替换前另存 canonical 副本供脚本测试。
3. Windows Node 执行 `build.cjs prepare`，然后依次 `build.cjs 1`、`build.cjs 2`。复用已验证的 Windows x64 依赖/资源，仅替换本次构建的应用代码；重新封装 ASAR。等待归档流完成并读取版本/比对 main，再运行安装器构建。安装器显式 `--publish never`、不签名，QA 压缩等级为 1。
4. `inspect.cjs payload` 保存两个安装包 SHA-256 与新版完整文件哈希；`launch.ps1 Install1` 在当前交互桌面启动旧 QA 包首次安装向导。GUI 操作用电脑工具完成，禁止用 UIA/SendKeys 伪装人工步骤。
5. `launch.ps1 App` 运行实际安装包。`command.json` 中新的 `id` 配 `action=security` 验证实际 handler；`action=quit` 只退出自有 QA 进程。QA 入口把数据限制在专用 profile，通过 junction 映射至卸载器展示的三个 QA 数据目标；不修改系统环境或权限。
6. `inspect.cjs verify <label>` 比对新版所有程序文件；`seed` 只生成八个未知文件和测试标记；`data-snapshot <label>`、`data-verify <label>` 在应用完全退出后比对本地数据。`unknown <label>` 校验未知文件仍在原路径。
7. 在持有 SSH 的进程运行 `feed.cjs`，从旧 QA 版关于页检查、下载、安装、重启至新版，再比对文件。`finish-upgrade.ps1` 等待自动重启并校验新版完整性、八处原位文件及本地数据标记。随后验取消/默认保留卸载；重装新版后在实际卸载页勾选删除，只删除此流程创建的数据。`data-deleted` 验证三个 QA 目标已消失。

隔离差异：独立包名、appId、可执行文件名、预发布版本、端口与回环更新源；QA 入口及诊断桥额外封装，危险协议探针的最终 OS 派发被拦截。业务认证与安全 handler 使用真实生产构建。此 ARM 虚机曾在计划任务直接启动 NSIS 时于 System.dll 崩溃；同一 SHA/路径经 PowerShell Start-Process 和应用内升级可以正常启动，故计划任务通过 `interactive-installer.ps1` 启动 GUI。此差异已记录，未确认根因，也不等同于实体机稳定性结论。验收不覆盖生产签名/SmartScreen、公开 CDN、MSI、全用户提升安装、Win10 或实体 x64 机器。记录结果时必须保留这些边界。

原 beta.5 应用进程、安装目录及日常用户数据均不得作为目标。仅能清理描述匹配本流程的任务和进程；安装包、恢复备份及未知测试文件保留供复查。
