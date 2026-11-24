# Linux 原生件构建镜像（glibc 2.28）

## 这个镜像解决什么问题

发布 runner 是 Ubuntu 24.04（glibc 2.39）。在那里编出来的原生件带 `GLIBC_2.34`～`GLIBC_2.39` 的符号，
在 UOS 20 Pro 1050（glibc 2.28）上加载即失败：

```
Database initialization failed: Error: /lib/aarch64-linux-gnu/libm.so.6:
  version `GLIBC_2.29' not found (required by .../better_sqlite3.node)
```

安装不受影响（dpkg 只拷文件），Electron 自身也不受影响（它只需要 glibc 2.25）。
出问题的只有我们自己编的三个原生件：

| 原生件 | 在仓库里的构建入口 |
|---|---|
| `better_sqlite3.node` | `npm run rebuild:better-sqlite3` |
| capture `ffmpeg`（录屏） | `scripts/prepare-release-capture.mjs` |
| `NuwaxComputerUse`（电脑操作，cua-driver） | `scripts/computer-use/build-helper.sh` |

这个镜像提供 Debian 10 buster（glibc 2.28）环境，把这三者编成最高 `GLIBC_2.28` 的产物。
**只有编译在镜像里做，打包仍在 runner 上** —— Linux 打包 job 有三十多步，依赖 runner 上的
fpm、rpm、上传工具等；arm64 打包还要用系统 fpm，buster 的 ruby 太老。

## 怎么用

发布 workflow 里的三个编译步骤通过复合 action `.github/actions/linux-native-step` 执行。
它在 Linux 上把命令交给镜像，在 macOS / Windows 上原样执行，所以同一步骤定义五个平台共用。

```yaml
- name: Rebuild native modules for Electron
  uses: ./.github/actions/linux-native-step
  with:
    command: npm run rebuild:better-sqlite3
    working-directory: nuwa-electron-shell/crates/agent-electron-client
    arch: ${{ matrix.arch }}
```

复合 action 的 `uses:` 步骤上不能写 `timeout-minutes`，改用 action 的同名输入，由执行脚本加 `timeout`。

## 三个文件

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 镜像定义，一份覆盖 amd64 与 arm64 |
| `versions.env` | 所有版本号与校验和的**单一事实源**；Dockerfile 不写死任何版本 |
| `gxx-shim.sh` | `g++` 垫片，把 `-std=c++20` 改写为 `-std=c++2a` |

## 镜像 tag 由内容决定

tag 是 `Dockerfile`、`versions.env`、`gxx-shim.sh` 三个文件的内容哈希（`linux-native-image.mjs tag`）。
任何一个改了，tag 就变，所以不存在被 "latest" 悄悄换掉的可能；同一个 tag 重复构建是幂等的。

```
node scripts/client/linux-native-image.mjs tag         # 当前内容对应的 tag
node scripts/client/linux-native-image.mjs ref         # ghcr.io/nuwax-ai/nuwax-linux-native:<tag>
node scripts/client/linux-native-image.mjs build-args  # docker build 的 --build-arg
```

## 镜像里装了什么，以及为什么

buster 已停止维护，自带工具普遍落后于上游代码的要求。下面每一项都是实际撞到过的问题。

| 组件 | 版本 | 来源 | 不自己装的后果 |
|---|---|---|---|
| 基础镜像 | Debian 10.13 | 按 digest 锁定 | — |
| gcc / g++ / make | 8.3 | buster 自带 | — |
| `g++` 垫片 | — | `gxx-shim.sh` | gcc 8.3 不认识 `-std=c++20`，better-sqlite3 13 的构建脚本写死了它 |
| Python | 3.12.16 | python-build-standalone | node-gyp 13 要 Python ≥ 3.8（gyp 用了海象运算符），buster 只有 3.7 |
| Node | 24.14.0 | 官方二进制 | 镜像里没有 node，node-gyp 和构建脚本都跑不了 |
| git | 2.47.1 | 源码编译 | buster 的 2.20.1 不支持 `fetch --filter=blob:none` 和 `sparse-checkout`，`build-helper.sh` 在克隆源码时以 128 退出 |
| nasm | 2.16.03 | 源码编译 | buster 的 2.14 汇编不了 FFmpeg 8 的 x86 代码（`ALLOC_STACK` 报错），**x64 的 capture 构建失败**；arm64 没有 x86 汇编，不受影响 |
| curl | 7.74 | buster-backports | buster 的 7.64 不支持 `--retry-all-errors`（7.71 起才有），仓库有 3 处下载脚本用了它 |
| rustup + Rust | 1.29.3 + 1.97.1 | 官方归档 | 与 `.github/actions/native-build-cache` 锁定的工具链一致 |
| X11 / dbus / xkbcommon 开发库 | buster 自带 | apt | cua-driver 链接时需要 |
| sudo、ca-certificates、xz-utils 等 | buster 自带 | apt | GitHub 的 action 需要 |

几个实现上的约束：

- **apt 源指向 `archive.debian.org`**。buster-backports 只在装 curl 时启用，装完即移除，
  以免镜像里其他包意外升到回移植版本。
- **`RUSTUP_HOME` / `CARGO_HOME` 用 `ENV` 声明**，在 `rustup-init` 运行之前就生效。
  以行内环境变量的方式给，工具链会装到一处，而同层后面的 `rustc --version` 去另一处找。
- **rustup-init 从带版本的归档路径下载**，不用滚动的 `sh.rustup.rs` 脚本。
- **Node 的包名是 `linux-x64` / `linux-arm64`**，而 Docker 的 `TARGETARCH` 是 `amd64` / `arm64`，两者要分开映射。

### 校验和的来源

| 组件 | 校验和怎么来的 |
|---|---|
| Node | 对照 nodejs.org 的 `SHASUMS256.txt` |
| rustup-init | 对照 static.rust-lang.org 的 `.sha256` |
| 基础镜像 | `docker buildx imagetools inspect` 的清单 digest |
| Python、git、nasm | 上游不发布校验文件，是从固定版本的压缩包自行计算的 |

## 复合 action 做了什么

`scripts/client/linux-native-step.mjs`：

1. **workspace 挂载到与 runner 上完全相同的路径**。仓库的 capture 脚本会把产物的绝对路径写进
   `package.json`，路径一变打包就找不到录屏资源。这不是优化，是让现有脚本不改一行就能工作的前提。
2. **以 runner 的 uid/gid 运行**，产物不会变成 root 所有。
3. **PATH 显式指定**，让垫片和独立工具链排在系统自带的前面。
4. **`HOME` 指到 `RUNNER_TEMP` 下**并挂载出来，pnpm / node-gyp 的缓存在重跑时复用。
5. **步骤级超时**用 `timeout` 包在最外层；超时后退出码是 124。

## 重建镜像

镜像是低频变更，只在升级工具链时重建。改 `docker/linux-native/` 下的文件并推送后，
`linux-native-image.yml` 会自动构建并推送；也可以手动触发。

```bash
# 本地构建（以 arm64 为例）
ARGS=(); while IFS= read -r line; do ARGS+=(--build-arg "$line"); done < <(
  node --input-type=module -e 'import { buildArgs } from "./scripts/client/linux-native-image.mjs"; for (const a of buildArgs()) console.log(a);')
docker buildx build --platform linux/arm64 --load "${ARGS[@]}" \
  -f docker/linux-native/Dockerfile docker/linux-native
```

推送后的镜像会经过两道验证，任何一道不过都不该被 CI 使用：

1. 镜像自身的 glibc 必须是 2.28，且几个关键工具能运行；
2. 用复合 action（与发布 workflow 相同的入口）把三个原生件各编一遍，再由
   `scripts/client/linux-glibc-gate.mjs` 判定都不得超过 2.28。

## glibc 门禁

`scripts/client/linux-glibc-gate.mjs --verify-output <产物目录> --platform linux --arch <arm64|x64>`：

遍历安装目录里所有 ELF，自己解析 `.gnu.version_r` 段（不依赖 `readelf`，结论不随 runner 装了什么而变），
任何文件需要的 glibc 高于 2.28 即失败，并指出是哪个文件、需要哪个版本。

带豁免清单，每项必须写明原因和处置办法：

| 路径（相对安装目录） | 原因 |
|---|---|
| `resources/agent-desktop/*/agent-desktop-linux-*` | 上游 npm 包的预编译二进制，不是我们编的；UOS 上不支持 Agent Desktop 引擎，默认的 CUA Driver 不受影响 |

## 相关文件

| 文件 | 作用 |
|---|---|
| `docker/linux-native/` | 镜像定义 |
| `.github/workflows/linux-native-image.yml` | 构建并推送镜像，推送后自检 |
| `.github/actions/linux-native-step/action.yml` | 复合 action |
| `scripts/client/linux-native-step.mjs` | 复合 action 的实现 |
| `scripts/client/linux-native-image.mjs` | 镜像 tag、构建参数、版本清单解析 |
| `scripts/client/linux-glibc-gate.mjs` | glibc 门禁 |
| `plans/20261124-glibc-2.28-container-native-builds-plan.md` | 方案与实施记录 |
