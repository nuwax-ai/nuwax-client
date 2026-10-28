# 文件面板 + GIF · Windows 实机验证（win-dbg）

- 执行方：ZCode 会话 `session_cb2fb9c54189a13a41e6ed10966fcebb`（win-dbg @ 192.168.32.235，Windows 10.0.26200 x64）。
- 配合方：Codex 主会话（Mac 侧，冻结代码 / 产物 pin）。
- 基线：主验证在 **`f67e887f`**；Codex 后续追加 `e07b3687`（Linux 大小写判重修正，声明 Windows 行为不变）后**已复核：文件域 vitest 81/81 全绿**（新增 Linux 回归用例在 Windows 通过，印证行为不变）。GIF/走查结论不受该修正影响（transcode 与面板路径未变）。
- 状态：**已完成**（除注明的两个环境受限项）。

## 结果

### 1. 文件域 vitest · 真实 Windows 首跑 ✅（10:56 / 复核 11:01）

- 命令：crate 内 `vitest run src/main/features/local-files src/preload/features/local-files.test.ts src/shared/features/local-files src/main/features/capture/transcode.test.ts`（与 Codex Mac 隔离副本同口径）。
- **8 个文件 / 80 项全部通过**（5.85s / 复核 3.44s）。
- 这批测试首次在真 win32 上执行的关键分支：transfers 的 `C:/escape`、`C:\escape`、`\\server\share` 注入拒绝、junction 父目录拒绝、原子替换与外部并发编辑冲突（`conflict` 语义）、分块重放/超限拒绝、ZIP 符号链接条目拒绝、完整工作区 ZIP 的硬链接/符号链接/空目录/>100MiB 语义（operations），以及 transcode 高画质 `bayer:bayer_scale=5` 滤镜图断言。
- 结论：**transfers/transcode 改动在 Windows 语义下无回归**。

### 2. GIF 高画质转码 before/after · 生产 ffmpeg 实测 ✅（11:54）

- ffmpeg：**v3.0.25-beta.1 NSIS 包内 `resources/capture/win32-x64/ffmpeg.exe`**（9,587,712 B，sha256 `93b2d5c9…14c14c`，版本 8.1.3 静态构建，MSYS2 gcc 16.2.0，含 libvpx/gif/palettegen/paletteuse，经 resource.json 溯源）。
- 方法：与 Mac 基准同口径——同一 `input.webm`（testsrc2 1280x720@30，5 秒，2.51MB），before=`v3.0.25-beta.1` 的 transcode.ts，after=工作区（即 `72aa90c3`），quality=high，交替三轮。
- 结果（每轮明细在 `.cache/acceptance/gif-file-panel-20261028-win32.json`）：

| | before（sierra2_4a） | after（bayer:bayer_scale=5） | 差异 |
|---|---|---|---|
| 平均耗时 | **4198 ms**（4146/4279/4170） | **2613 ms**（2588/2630/2620） | **-37.8%** |
| 产物大小 | 7,614,708 B | 6,716,517 B | -11.8% |
| 尺寸/帧数/时长 | 1280x720 / 75 帧 / 5.000s | 1280x720 / 75 帧 / 5.000s | 一致 |
| SSIM vs 源（Mac 端复检） | All 0.9566（Y 0.9695） | **All 0.9610（Y 0.9749）** | after 略优 |

- 对照 Mac 结果（2.75s→1.07s，-61%）：Windows 提升幅度较小但依然显著；**测试同学反馈的「生成慢」在 Windows 真机上确认为同向改善，且画质（SSIM）不降反微升**。

### 3. 文件面板真实客户端走查 ✅（11:15–11:55）

- 形态：`scripts/acceptance/file-panel-dev.mjs`（隔离 profile + 随包 nuwax-file-server + 业务网络阻断）+ umi dev（:3000）+ Electron（CDP 9333 可信输入驱动，session 0）。win 副本仅两处非功能性改动：spawn 加 `--remote-debugging-port`、file-server 就绪等待 10s→60s（Windows 冷启动慢）。
- 逐项结果（磁盘级核对）：

| 操作 | 结果 | 证据 |
|---|---|---|
| 文件树加载（本机直连路线） | ✅ | fixture 工作区 6 项全部列出 |
| Markdown 预览 | ✅ | 中文列表/断网读取渲染 |
| 图片预览 | ✅ | `<img src="nuwax-local://…/pixel.svg">` |
| HTML 预览（自定义协议 iframe + 子资源） | ✅ | `nuwax-local://` iframe 挂载（Windows 协议注册正常） |
| 重命名（树内联编辑） | ✅ | `docs/renamed.md` 落盘 |
| 新建文件 | ✅ | `新建笔记.md`（中文文件名，根目录）落盘 |
| 编辑保存（Monaco） | ✅ | `renamed.md` 内容替换为「# Windows 编辑保存验证…-EDITED」 |
| 上传（分块传输桥） | ✅ | `docs/upload.txt` 字节级一致（"Native upload fixture"） |
| 跨目录移动 | ✅ | `archive/index.html` 落盘、原位消失 |
| 删除 → 系统回收站 | ✅ ×2 | PowerShell `Shell.Application` 回收站计数 2（pixel、import），工作区对应消失 |
| ZIP 导入（面板 UI） | ⚠️ 未走通 UI 入口 | fixture 面板未渲染导入入口（真实入口在会话页工具栏）；Windows 侧以 transfers 单测覆盖（路径注入/符号链接/失败不报成功） |

### 环境受限项（保留待验）

1. **系统目录选择器（原生保存/打开对话框）**：Electron 跑在 SSH session 0，原生对话框无法呈现；需 schtasks /IT 派交互会话或真桌面会话验证（fixture 的「选择本机目录」按钮走 `pickLocalWorkspaceDirectory` 桥）。
2. ZIP 导入真实 UI 流（见上表 ⚠️）。

## 环境与复现备注（win-dbg）

- 检出 `C:\soddy-git-workspace\nuwax-client` @ `release/v3.0.25`（f67e887f），双子模块对 pin（nuwax-dist 因 GitHub fetch 不稳未拉取，不影响本验证）。
- 依赖：shell workspace + 外层 `pnpm install`（root postinstall 的 agent-kit 快照 lockfile 不匹配会失败，不影响测试/基准）；crate 内 vitest 2.1.9 直接可用；前端 `pnpm install`（2m4s）。
- 生产 ffmpeg 提取路径：NSIS exe →7z→ `$PLUGINSDIR/app-64.zip` →7z→ `resources\capture\win32-x64\ffmpeg.exe`（MSI 的 msiexec /a 在 session 0 会挂起，勿走）。
- 基准脚本：`C:\soddy-git-workspace\win-gif-actual-benchmark.mjs`（Mac 原版 `/tmp/nuwax-gif-actual-benchmark.mjs` 的 Windows 适配：ff 路径/ffprobe 兜底/报告名 `-win32`）。
- 产物：`.cache/acceptance/gif-file-panel-20261028-win32.json`、`.cache/acceptance/file-panel-dev.json`（fixture 工作区位置）、走查日志 `C:\soddy-git-workspace\panel-walk-a*.json`。
- 截至 12:00 fixture（Electron+umi+file-server）仍在 win-dbg 运行，可直接接管复验。
