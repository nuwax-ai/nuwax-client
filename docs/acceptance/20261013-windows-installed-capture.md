# Windows 安装包录屏资源漏包修复

时间：2026-10-13，Asia/Shanghai。真机：`win-pc`，192.168.32.235。

## 原因与现场修复

用户已安装 `3.0.14-beta.2`，菜单和截图/录屏主进程代码都在 ASAR 中，但安装目录完全没有 `resources/capture`。运行时严格从这个目录读取编码器，故 MP4、WebM、GIF 全部被判为不可用。

本地统一 pack 已包含编码资源准备和打包；稳定及 beta/QA 发布工作流却直接调用基座 `dist:*`，基座 `prepare:all` 不准备商业 capture 资源。上轮源码隔离测试携带了编码器，未覆盖这个发布遗漏。

已在当前安装目录补入本轮固定源码构建并核验的 `capture/win32-x64/{ffmpeg.exe,resource.json}`，同时放入独立 `third-party/capture` 声明、许可证和源码。用户客户端已重启以清除首次初始化缓存的不可用能力，安装 ASAR 未改动。

- 安装路径：`C:\Users\soddygo\AppData\Local\Programs\Nuwax`。
- ASAR SHA256：`328f42d1bd3ee77b1ffa655b9876a122fdc8427e73180f142a247418d9063ec7`，补资源前后相同。
- FFmpeg SHA256：`3131a88c85947362416e0e832e207bac6ec43b78fff5ed82b7f6528a883d9c31`。
- 编码器仅在普通 Windows 系统 PATH 环境下运行，MP4、WebM、GIF 三种实际编码探针均返回 0。

## 安装 ASAR 验收

`scripts/acceptance/packaged-capture.cjs` 使用匹配的 Electron 40.8.2 加载当前安装包真实 ASAR main、preload、IPC 和 renderer 录屏桥，不重编或替换 capture 实现。仅隔离 home/appData/userData 和测试进程，避免使用用户账号；资源读取仍走安装包默认 `process.resourcesPath/capture`。录制对象为本进程自建动态测试板。

连续两轮各 5/5 通过，退出码 0：

- 15:06:54–15:07:29：真实桥能力、截图选择/保存/分块读取/释放、MP4/WebM/GIF 录制/暂停继续/保存/Chromium 播放。
- 15:09:56–15:10:31：增加截图和视频 RGB 检查、运动帧 hash 差异后再次全部通过，排除黑帧或静止画面。
- 两轮视频均为 616×396，实际播放进度前进，时长约 2.5 秒；GIF 为 38 帧。能力返回 `video: [mp4, webm]` 和 `gif: true`。
- 发布资源 helper 的 `--verify-output` 也已针对真实安装目录运行，通过编码器、metadata、声明、许可证和源码文件逐字节核验。
- 最新验收脚本的短能力/清理回归通过，三个编码格式可用；测试派生进程按主 PID、父子关系和创建时间清理，残留列表为空，用户原客户端继续运行。子进程包装保留 `util.promisify.custom` 等原始 Node 协议，Windows 和本地回归均通过。

证据保存在忽略目录 `logs/acceptance/20261013-windows-installed-capture/`，第二轮在 `pixels/`，包含 JSON、截图和三种录制产物。现场补资源是可复核的临时修复，不等同于重新发布/安装新的完整安装器；本次未验收真实账号、IM 回填、物理多屏或长时间录制。

## 发布防回归

稳定和 beta/QA 工作流共用 `scripts/prepare-release-capture.mjs`：builder 前准备并核验固定来源资源，写入实际 builder 消费的打包配置；builder 后检查 unpacked 应用的默认资源目录和完整 capture 声明。缺失或改变均使构建失败，避免再次发布没有编码器的功能包。

Windows 显式准备 MSYS2 原生 x64 工具链及固定 Winpthreads 双包，校验官方归档 SHA 和签名；macOS x64 使用原生 Intel runner；Linux 不携带录屏编码器。capture 声明只描述该模块，不替代其它客户端组件声明。正式 GitHub Actions 五平台构建及签名链尚未执行。

macOS 正式签名先在独立副本中签定编码器、记录最终 SHA 和原始来源 hash，并只对该已签 FFmpeg 禁用 builder 重签。打包后继续绑定来源、校验签名及最终字节，源码缓存不变。已对真实 arm64 FFmpeg 做 ad-hoc 签名、运行和打包目录核验；正式 Developer ID/公证仍待 CI。

资源准备、打包配置、工作流和子进程回归累计 67 项通过；独立 verifier 针对核心路径 49 项通过，原签名/SHA 阻断已关闭。overlay、pin 和差异检查通过。本轮未提交或发布新的安装包。
