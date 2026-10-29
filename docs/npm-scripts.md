# npm 脚本参考

所有日常开发、测试、打包与发布命令从 **nuwax-client 仓库根目录**运行。根 `scripts/client/cli.mjs` 统一编排，本仓 `nuwa-electron-shell/crates/agent-electron-client/` 提供 Electron 构建、签名和资源准备实现。

## 仓库根命令

| 命令 | 行为 |
|---|---|
| `npm run setup` | 初始化缺失的前端子模块，构建 agent-kit、安装依赖、重编原生模块并准备资源 |
| `npm run dev` | 自动准备并启动客户端；`--frontend source` 使用前端源码热更新 |
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
