# 计划：UOS 1050 的 Linux deb 硬链接修复 + arm64 本地调试入口

## 背景与结论

UOS 20 Pro 1050 上安装 Linux deb 失败（dpkg 报跨设备链接错误），本地启动客户端调试也需要一条专用命令。
本计划覆盖两件事：**修掉 deb 里的硬链接**，以及**新增一个面向 UOS 1050 arm64 的本地启动命令**。
UOS 适配的其余工作（glibc 2.28、Wayland 可用性等）不在本计划内，单独跟踪。

## 一、deb 硬链接：机制、证据、修复

### 机制（已在 Linux 容器与 macOS 上实测）

三个条件叠加才会产生包内硬链接：

1. `builder-util/out/fs.js:124`
   `const _isUseHardLink = process.platform !== "win32" && process.env.USE_HARD_LINKS !== "false" && (isCI || process.env.USE_HARD_LINKS === "true");`
   CI 环境默认用**硬链接**复制文件，因此同一源文件被复制到两个目标路径时，两份共享同一 inode。
2. `fpm/lib/fpm/util.rb:337`
   `filetype = if st.ftype == "file" && st.nlink > 1 then "hardlink"`，fpm 在源文件 `nlink > 1` 时**保留硬链接关系**。
3. `tar` 遇到同一 inode 的第二个路径，写成 `h`（hard link）条目，而不是重复的数据。

因此：**同一个源文件在包里出现两次 → 包内出现硬链接 → dpkg 装到跨文件系统的目标位置时失败。**

### 已发布的 3.3.0-beta.2（arm64 与 amd64 各查一遍）

`data.tar.xz` 里各有且只有 2 条硬链接，正好对应仓库里的两处重复输入：

| 硬链接条目 | 链接目标 | 重复输入 |
|---|---|---|
| `./usr/share/icons/hicolor/512x512/apps/nuwax.png` | `./opt/Nuwax/resources/icon.png` | `build.linux.icon` 与 `extraResources` 都指向 `public/icon.png` |
| `./opt/Nuwax/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node` | `./opt/Nuwax/resources/better-sqlite3/better_sqlite3.node` | `asarUnpack` 与 `extraResources` 都指向 `node_modules/better-sqlite3/build/Release/better_sqlite3.node` |

第一条跨 `/opt` 与 `/usr`。UOS 上 `/opt`、`/var`、`/home` 挂在 `/data`，`/usr` 在系统分区，两者是不同文件系统，
`dpkg` 建这个链接必然报 `Invalid cross-device link`，安装直接失败。第二条虽然同在 `/opt`，但同样是硬链接，
属于同类隐患，且那份 `resources/better-sqlite3/` 副本全仓无人读取。

### 判定实验（Linux amd64 容器，真实 electron-builder 25.1.8 + fpm 1.9.3）

| 变体 | deb 内硬链接条目 |
|---|---|
| 默认（CI） | **1**：`/usr/share/icons/.../linklab.png` → `/opt/LinkLab/resources/icon.png` |
| `USE_HARD_LINKS=false` | **0** |
| 只删掉重复输入（保留 `linux.icon`） | 仍为 **1** |

结论：electron-builder 自带的 `USE_HARD_LINKS=false` 是有效手段；只删重复输入不足以消除图标那条。

macOS 上对 unpacked 目录做 inode 统计，结果一致：默认 5 个文件共享 inode，`USE_HARD_LINKS=false` 后为 0。

### 改动清单

| # | 文件 | 动作 | 说明 |
|---|---|---|---|
| 1 | `nuwa-electron-shell/crates/agent-electron-client/package.json` | 改 | 删除 `extraResources` 里 `better-sqlite3` 那条重复副本（全仓无人读取） |
| 2 | `scripts/client/pack.mjs` | 改 | Linux 打包时注入 `USE_HARD_LINKS=false`；非 Linux 平台行为不变 |
| 3 | `nuwa-electron-shell/crates/agent-electron-client/scripts/build/run-build-electron.js` | 改 | CI 走这条入口，同样按目标平台注入 `USE_HARD_LINKS=false` |
| 4 | `scripts/client/package-payload.mjs` | 改 | 新增打包产物校验：deb/rpm 内不得出现硬链接条目 |
| 5 | `scripts/package-payload.test.mjs` | 改 | 新增用例：构造含硬链接的 deb，校验必须报错 |
| 6 | `nuwa-electron-shell/crates/agent-electron-client/src/main/main.ts` | 改 | dev 模式下 Linux 沙箱开关改为可用环境变量保留（`NUWAX_DEV_KEEP_SANDBOX=1`），正式包行为不变 |

第 6 项的原因见「三、本地启动」。

### 验证

- 本机：`npm run test:scripts`（474 项，469 通过 / 5 项既有条件跳过）、`npm run typecheck`。
- 容器（Linux amd64，真实 electron-builder 25.1.8 + fpm 1.9.3）：用与客户端相同的重复结构打 deb，
  修复后 `verifyLinuxPackageLinks` 报告 **硬链接条目 0**（修复前 1）。
- 检测器在真实产物上验证：`Nuwax-3.3.0-beta.2-arm64.deb` 与 `-amd64.deb` 各报出 2 条硬链接，
  与 tar 手工查看结果一致。
- UOS 真机：修复后的 deb 需 CI 出包后才能装（本次未出新 beta 包），验收点见「五、待验证」。

## 二、arm64 Linux deb 是否可行

**可行，且 CI 已经在出包。** `release-electron.yml` 的矩阵里已有 `ubuntu-24.04-arm` + `dist:linux:arm64`，
3.3.0-beta.2 已发布 `Nuwax-3.3.0-beta.2-arm64.deb`（525 MB，arm64 架构正确）。

真正的障碍不在"能不能构建"，而在**装得上、跑得起来**：

- 装不上：deb 硬链接（本计划第一部分解决）。
- 跑不起来：包里 `better_sqlite3.node` 等原生件是 CI 机器（glibc 2.39）编出来的，
  UOS 1050 只有 glibc 2.28 → 需要在 glibc ≤ 2.28 的环境里重编（配方已在 UOS 机器上用 Zig 验证过）。
- AppImage：arm64 版运行时缺无版本号的 `libz.so`。

## 三、本地启动客户端调试：现存问题与新命令

### 现存问题（UOS 1050 arm64 上用 `make dev` 起不来的原因）

| # | 问题 | 说明 |
|---|---|---|
| 1 | `make dev` 依赖 git 元数据 | 开发副本是 rsync 过去的，没有 `.git`，子模块/pin 检查直接失败 |
| 2 | `make dev` 要从源码编 ffmpeg | 需要 nasm，机器上没有 |
| 3 | `make dev` 要 Rust | Computer Use 助手是 Rust 产物，机器上没有 Rust 工具链 |
| 4 | 原生模块必须按 glibc 2.28 编 | 系统 GCC 8 编不过 Electron 43 的 V8 头；要用 Zig 0.13 当编译器 |
| 5 | node-gyp 需要 Python ≥ 3.8 | 系统只有 3.7，要用 uv 装的独立 3.12 |
| 6 | 无系统 Node | 只能用已装包里的 `/opt/Nuwax/resources/node/linux-arm64/bin/node`（24.14.0） |
| 7 | GitHub 不可达 | Electron/部分资源要走国内镜像，GitHub 走 Mac 上的 Surge 代理 |
| 8 | dev 模式的 `--no-sandbox` 会打死沙箱化 webview | 用 `app.commandLine.appendSwitch` 追加的开关来得太晚：宿主仍会派生受沙箱限制的 zygote，来宾渲染进程在 `/dev/shm` 上崩溃，页面显示"意外中断"。UOS 允许非特权 user namespace，所以必现；生产包不受影响 |

第 8 条是产品代码里的问题：沙箱开关在 dev 模式被无条件关闭，
但真正需要关闭沙箱的是"环境不支持"的情况，而不是"处于 dev 模式"。改成由环境变量显式表达，
默认仍保持 dev 关沙箱（本地开发最常见诉求），需要保留沙箱时用 `NUWAX_DEV_KEEP_SANDBOX=1`。

### 新增命令

`make dev-uos` —— 面向 UOS 1050 arm64 的本地启动入口。它不做通用准备，只做这台机器需要的事：

1. 校验平台：必须是 Linux + arm64，否则直接报错退出（避免误用）。
2. 校验并使用 bundled Node（`/opt/Nuwax/resources/node/linux-arm64/bin`），缺失时给出明确提示。
3. 校验 `better_sqlite3.node` 存在且其最高 GLIBC 符号 ≤ 2.28，不满足就报出重编命令。
4. 设置 `NUWAX_DEV_PROFILE=1`（独立数据目录 `.nuwax-dev`）、`NUWAX_DEV_KEEP_SANDBOX=1`。
5. 复用已有的 `make dev-direct` 入口起客户端（它已经处理了商业身份注入与 vite/electron 编排）。

实现放 `scripts/client/dev-uos.mjs`（Node，跨平台可测），Makefile 只做转发。

启动方式用 systemd 用户单元（`systemd-run --user`）：图形会话变量（`DISPLAY` / `WAYLAND_DISPLAY`）
只存在于登录会话，SSH 直连的 shell 没有；用户单元继承 systemd 用户管理器里的会话环境。
单元不继承调用方进程的环境，所以 `PATH` 要显式传过去 —— 这台机器既没有系统 Node 也没有系统 pnpm。

### 改动清单（续）

| # | 文件 | 动作 | 说明 |
|---|---|---|---|
| 7 | `scripts/client/dev-uos.mjs` | 增 | UOS 1050 arm64 的启动前置检查与环境装配 |
| 8 | `scripts/client-dev-uos.test.mjs` | 增 | 单测：平台校验、glibc 上限判定、环境装配结果、systemd 单元参数 |
| 9 | `Makefile` | 改 | 新增 `dev-uos` 目标 |
| 10 | `docs/npm-scripts.md` | 改 | 补 `make dev-uos` 的用途与前置条件 |

### 实测结果（UOS 1050 arm64 真机，2026-11-24）

- `make dev-uos --check-only`：平台校验通过，找到 bundled Node（`/opt/Nuwax/resources/node/linux-arm64/bin/node`），
  `better_sqlite3.node` 的最高 GLIBC 符号为 **2.28**，在目标上限内。
- `make dev-uos`：单元 `nuwax-dev` 起来后所有服务健康检查通过
  （mcpProxy / agent / fileServer / computerServer / ttyd / lanproxy），桥接服务状态 ready。
- 窗口确认显示：日志出现 `Main window shown by fallback { fallback: 'did-finish-load' }` 与
  `Main window shown (maximized)`。原生 Wayland 下 `ready-to-show` 不触发，走的是 revealWhenReady 的兜底路径
  （上游 Electron 的已知问题），窗口本身正常显示。
- 沙箱确认启用：日志 `[Production] Sandbox enabled (SUID for deb/rpm, namespace for AppImage)`，
  即 `NUWAX_DEV_KEEP_SANDBOX=1` 生效。

## 四、实施顺序

1. 改 `package.json`（删重复副本）+ 注入 `USE_HARD_LINKS=false`（两处入口）。
2. 改 `main.ts` 的 dev 沙箱开关。
3. 加打包产物校验与单测。
4. 新增 `dev-uos.mjs`、Makefile 目标、单测、文档。
5. 本机验证（单测、类型检查）。
6. 容器里真实打一次 deb，确认 0 条硬链接。
7. UOS 真机验证：`dpkg -i` 安装成功；`make dev-uos` 能起客户端。

## 五、风险

| 风险 | 缓解 |
|---|---|
| `USE_HARD_LINKS=false` 让 CI 打包变慢、磁盘占用变大（不再共享 inode） | 只在 Linux 目标注入；其他平台行为不变 |
| 删除 `extraResources` 的 better-sqlite3 副本影响某个未发现的读取方 | 已全仓搜索确认无读取方；`asarUnpacked` 里的那份仍在，运行时加载路径不变 |
| 打包校验误报 | 只针对 deb/rpm 的 tar 条目类型，不检查文件内容 |
| `dev-uos` 与现有 `dev-direct` 行为漂移 | `dev-uos` 只做前置检查与环境装配，实际启动仍走 `dev-direct` |

## 六、不在本计划内

- glibc 2.28 的原生件重编与 CI 门禁（另一条线）。
- Wayland 的 1x 缩放、输入法、托盘/通知/自启动验收。
- x64 的 UOS 1050 真机验收。

## 七、待验证（需要新出包）

硬链接修复要等 CI 用修复后的配置出一个 beta 包才能在 UOS 上验收安装：

1. CI 出 `Nuwax-<版本>-arm64.deb`，先跑 `node scripts/client/package-payload.mjs --verify-output <产物目录> --arch arm64`，
   确认输出「No hard links in 1 Linux package(s)」；
2. UOS 上 `sudo dpkg -i` 安装，确认不再报 `Invalid cross-device link`；
3. 装上后仍需解决 glibc 2.28 的原生件问题才能真正运行（见另一条线）。

## 八、附带修复

执行 `make harness-local` 时发现 `nuwa-electron-shell/crates/agent-electron-client/package.json` 里
`@nuwax-ai/nuwax-harness-acp-ts` 已是 `^1.2.51`，而 `pnpm-lock.yaml` 仍锁 `1.2.50`，
`pnpm install --frozen-lockfile` 报 `ERR_PNPM_OUTDATED_LOCKFILE`。
用仓库锁定的 pnpm 9.15.5 只更新这一条依赖的锁文件条目（连带 `graceful-fs`、`tar` 的补丁版本），
`--frozen-lockfile` 安装随即通过，`make harness-local` 恢复正常。
