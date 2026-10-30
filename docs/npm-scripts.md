# npm 脚本参考

所有日常开发、测试、打包与发布命令从 **nuwax-client 仓库根目录**运行。根 `scripts/client/cli.mjs` 统一编排，本仓 `nuwa-electron-shell/crates/agent-electron-client/` 提供 Electron 构建、签名和资源准备实现。

## 仓库根命令

| 命令 | 行为 |
|---|---|
| `npm run setup` | 初始化缺失的前端子模块，构建 agent-kit、安装依赖、重编原生模块并准备资源 |
| `npm run dev` | 自动准备并启动客户端；`--frontend source` 使用前端源码热更新；`--frontend remote` 调试客户端壳，业务页使用设置中的域名与 Cookie 登录 |
| `npm run pack` | 当前平台无签名包；`--frontend source` 将当前前端源码构建入包 |
| `npm run frontend:build` | 构建前端，保留输出 `nuwax/dist` |
| `npm run sub:update` | 更新前端源码、构建并推送产物仓，再提交前端双 pin；`--push` 才推外层分支 |
| `npm run doctor -- --json` | 只读检查环境、依赖、资源及前端 pin |
| `npm run test:commercial` | 完整客户端测试，准备依赖但不注入构建身份；专项 env 测试验证产品差异 |
| `npm run test:scripts` | 外层工具链和发布脚本测试 |
| `npm run host-bridge:check` | 核对前端事实源与本仓宿主桥类型快照 |
| `npm run release -- --version X.Y.Z[-beta.N] --dry-run` | 发布预检，版本推导通道；去掉 `--dry-run` 启动正式流程 |
| `npm run diagnostics:export` | 导出诊断包 |

壳代码与构建脚本直接随本仓提交。旧 `base:*` 别名、覆写层同步及基座 pin 门禁已移除；不要执行迁移前文档中的旧命令。根 Makefile 是同一 CLI 的兼容入口。

## 安装版与开发版同时运行

`npm run dev` 的所有前端模式均使用独立开发档案，显示名带 `Dev`。商业产品标识保持 `nuwax`，因此沿用相同的 Cookie 登录与切环境/切域名入口。

| 项目 | 安装版 | 开发版 |
|---|---|---|
| Electron 浏览器档案 | `Nuwax` | `Nuwax Dev` |
| 配置、数据库、日志 | `~/.nuwax` | `~/.nuwax-dev` |
| 默认工作目录 | `~/Nuwax` | `~/Nuwax Dev` |
| 域名与 Cookie 登录 | 安装版自行设置 | 开发版自行设置，首次需要登录 |
| 设备注册与 Computer Use 端点 | 安装版独立保存 | 开发版独立保存 |
| 默认电脑名称 | 原电脑名称 | 原电脑名称加 ` Dev`，例如 `MBP128 Dev` |
| 本地业务服务端口 | 自动分配 | 沿用自动分配 |

开发档案不复制安装版数据或凭据，也不共享注销、域名切换及后台服务退出。正式打包会在构建期移除开发档案开关，即使构建机环境中残留 `NUWAX_DEV_PROFILE=1`，也仍使用原安装版档案。

早期已注册的开发电脑会在注册后同步一次名称：只给仍使用默认 hostname 的本开发设备加 `Dev`，保留用户自定义名称；不会重命名列表中的其他设备。

仅调试壳和 Computer Use 时运行：

```bash
npm run dev -- --frontend remote
```

业务 Webview 使用**开发版设置中选择的域名**，不是 `localhost:3000`；壳自身仍从本地 Vite 加载。`--frontend source` 用于需要联调前端源码的场景。

开发版不注册系统自启动，也不占用全局截图和 Computer Use 急停快捷键；截图菜单、按钮与 Computer Use 暂停/停止面板可照常使用。系统权限、桌面焦点和键鼠仍由同一操作系统共享；需要不干扰用户的真实键鼠测试时，应使用独立测试机或虚拟机。

macOS 的开发主程序使用缓存副本 `Nuwax Dev.app`（`com.nuwax-ai.nuwax.dev`），授权给主程序的屏幕、文件和通知权限会显示这个名称。电脑操作助手单独显示 `Nuwax Computer Use Dev`（`com.nuwax-ai.nuwax-computer-use.dev`），需要为它授予辅助功能与屏幕录制权限。开发身份首次需要单独授权；更换 Electron 或签名身份后，macOS 可能要求重新授权。

开发助手在后台准备，首次原生构建可能较慢；默认最多两个编译任务，后续复用缓存和增量产物。主界面可以先打开；终端出现 `Computer Use Dev 助手已就绪` 后可开启电脑操作。

## 壳命令包装器

`npm run shell:exec -- [--no-inject | --no-env] -- <命令> [参数...]` 在本仓 `nuwa-electron-shell/` 目录执行低层命令。通常使用上表入口，以下仅供 CI 和定向检查：

- 默认准备根依赖并注入 `client.config.mjs` 对应的构建身份。
- `--no-env` 准备依赖、不注入身份；完整商业测试使用此模式。
- `--no-inject` 不准备依赖、不注入身份，供已显式准备环境的 CI 步骤使用。

例如，从仓库根执行壳内定向测试：

```bash
npm run shell:exec -- --no-env -- npm run test:electron -- <测试文件>
```

单独的客户端测试通常直接使用：

```bash
npm --prefix nuwa-electron-shell/crates/agent-electron-client run test:run -- <测试文件>
```

## 构建与资源准备

以下脚本属于本仓客户端 crate，路径为 `nuwa-electron-shell/crates/agent-electron-client/`。它们由根编排和 CI 使用，直接执行不会替代完整的产品配置与发布准入。

| crate 命令 | 行为 |
|---|---|
| `build` / `build:main` / `build:renderer` | 主进程和 renderer 构建 |
| `build:electron` | 应用构建与 electron-builder 打包 |
| `dist:mac*` / `dist:win*` / `dist:linux*` | 平台打包实现 |
| `dist:unsigned:local` | 根 `pack` 使用的无签名打包实现 |
| `prepare:all`、各项 `prepare:*` | Node、uv、git、ripgrep、MCP 代理、引擎和文件服务等运行资源准备 |
| `electron-rebuild` | 重编 Electron 原生依赖 |
| `test:run` / `test:scripts` | 客户端行为与构建脚本测试 |
| `check:boundaries` / `check:appdir` | 源码导入及应用数据目录检查 |
| `clean:release` / `clean:electron-cache` | 清理相应生成物与缓存 |

当前 Computer Use 使用 CUA helper。保留的旧 GUI/沙箱组件不属于商业资源准备及打包入口；不要通过旧 Makefile 或过往资源下载脚本另起准备链。资源覆盖和缓存规则见根 README。

## 发布与签名

- `release` 固定本仓提交与前端输入，以不可变 tag 触发五平台构建。beta 自动同步并公开 prerelease；stable 默认停在签名阶段，安装验收后显式 `--stage sync`。失败续跑已有 tag，不移动历史 tag。
- `scripts/release-stable.sh` 保留为 Node 发布状态机的参数透传兼容入口；常规操作使用根 `npm run release`。
- `sign:win` / `verify:sign:win` / `sync:oss` 经 `scripts/client/forward.mjs` 转发到本仓客户端 crate，注入本产品仓库、资产名称及同步分支；仅作人工兜底，常规操作由 `release` 编排。
- stable 签名工具从本仓当前自动化提交读取，经 SSH stdin 交给 win-pc；签名机核验 unsigned 来源后签名、验签、上传，不需要客户端源码检出或 npm 安装。SimplySign 手机认证保留人工操作。
- `sign:win:v1` 是仍保留的低层签名回退实现；beta Windows 包使用 CI 原产 unsigned EXE，不另走人工签名入口。

版本与 CI 路由见[发布与更新通道](./release-channels.md)，签名细节见[Windows 签名](./sign-windows.md)。S3/OSS 镜像来源、资产哈希、指针回读及失败回滚继续由现有发布脚本执行。

## Windows 首装归档

Windows NSIS 默认使用 ZIP 直接解压到安装目录，压缩级别为 normal，并生成独立 blockmap。安装耗时和包体积需用真实安装包验证；对照测试的 `NUWAX_WINDOWS_INSTALLER_ARCHIVE=7z-qa|zip-qa` 仅供独立 Windows 目标使用，不绕过发布保护。
