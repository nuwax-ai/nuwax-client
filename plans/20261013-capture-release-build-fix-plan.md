# beta.4 编码资源构建失败修复

目标：修复 beta.4 Windows 与 macOS Intel 编码资源准备失败，在原生 runner 验证后创建新的不可变 beta tag；不改变截图/录屏公共接口或前端 pin。

## 证据

- beta.4 [Windows job](https://github.com/nuwax-ai/nuwax-client/actions/runs/38393162796/job/115285770157) 在 `pacman-key --verify` 报权限错误。独立 [复现任务](https://github.com/nuwax-ai/nuwax-client/actions/runs/38396838864) 确认 `--init` 成功，但 gpg.conf 缺少 wrapper 所要求的 `lock-never`；更换 PATH 不改变结果。
- beta.4 [Intel Mac job](https://github.com/nuwax-ai/nuwax-client/actions/runs/38393162796/job/115285770108) 拒绝 `x86_64-darwin-gcc`。源码锁对应的 libvpx configure 支持 `x86_64-darwin20-gcc` 至 `darwin25`，仅 ARM 支持不带版本的 Darwin target。
- 原生复现进一步确认 Intel runner 未安装 NASM/YASM。
- Windows 通过签名安装后，GNU tar 将原生盘符 `D:` 解释为远程主机；解压路径也必须通过 MSYS `cygpath` 转换，不能只处理 configure 的 prefix。

## 实施与验证

1. Windows 使用 pacman/libalpm 安装事务验证签名，独立配置强制 `SigLevel` 和 `LocalFileSigLevel` 为 `Required TrustedOnly`；保留固定包 SHA、版本以及安装后的实际工具链检查，不改全局 keyring 配置。
2. macOS 两种架构使用锁定源码支持的 Darwin 20 target；20–25 使用相同 macOS 编译与 SDK 规则。稳定及 beta 工作流显式准备 NASM、pkg-config。
   Windows 源码解压在对应 MSYS shell 中转换归档和目标目录两个位置参数，保留空格与跨盘路径。
3. 单测检查签名策略、失败后禁止准入及两个发布工作流的编译依赖顺序；独立原生 Windows runner 验证坏签名拒绝且安装包版本未改变，再验证真签名与固定版本安装。
4. Windows、Intel Mac、Apple Silicon Mac 各自从锁定源实际构建并准入编码器；不把参数断言当成原生编译证据。
5. 合并修复和发布说明，预检新 beta，保留 beta.4 tag/SHA；新版本五平台构建、签名、安装包资源校验和公开发布仍由正式流水线完成。

边界：原生编码器编译通过不等于签名安装包或真实桌面录制验收；原有 Linux Sway、多屏和 IM 验收边界继续有效。

## 最终验证

- [Windows 原生构建](https://github.com/nuwax-ai/nuwax-client/actions/runs/38398505176/job/115299764425) 通过：实际坏签名被 pacman 拒绝且包版本未改变；真实可信签名通过，固定 Winpthreads 安装并准入；libvpx 1.17.0 和 FFmpeg 8.1.3 从锁定源编译、资源检查成功。日志确认此前 Perl 来自 Git 安装目录，安装 MSYS2 Perl 后来自 `/usr/bin/perl`，汇编依赖生成恢复。
- [Intel Mac 与 Apple Silicon 原生构建](https://github.com/nuwax-ai/nuwax-client/actions/runs/38397896014) 的两个 macOS job 均成功；该轮 Windows 仍失败于 Perl，不能将整条 run 称为成功，Windows 以后一轮的独立通过记录为准。
- 本地脚本全量 323 项通过；后续增加 Windows 解压路径回归后，捕获资源和发布工作流域 35 项通过；最后 Perl 依赖声明补充后，工作流 3 项再次通过。`git diff --check` 通过。
- 维护性自查：平台路径差异收在 `extractCaptureArchive`；可信签名策略收在 `configureWindowsCaptureToolchain`；工作流只声明平台依赖。公共捕获 API、前端 pin、既有子模块工作区均未改变。
