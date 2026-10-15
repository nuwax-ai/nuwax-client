# 截图悬停自动识别窗口 / 整屏

参照飞书、微信截图：鼠标移到应用窗口上自动框出该窗口，移到桌面空白处框出整屏；单击采用高亮框，拖动仍为自由选区。macOS、Windows、Linux X11 支持；Linux Wayland 由系统选择来源，拿不到窗口桌面坐标，保持现状。

状态：实现、资源准备与打包注入已完成；macOS 开发客户端已完成截图和 MP4 录制验证。Windows/Linux 原生窗口识别真机、真实多屏与安全软件验收仍待完成（见文末）。

2026-10-14 Codex 接手两个 Claude Code 会话：`afcd2974-9b2b-433e-ac6b-69093c37656f` 与 `72ff6787-57e3-4446-a2c0-532ed8a12100`。开发分支 `codex/capture-window-autodetect`。发布由其他 Agent 负责；授权页对齐与 Computer Use 面板显隐两处额外修改按用户最后决定撤回，不并入本需求。

用户补充：截屏和录制默认隐藏客户端自己的主窗口及其附属窗口。参数、权限及忙碌检查通过后隐藏，等待桌面合成器刷新，再冻结屏幕/枚举窗口；截图完成/取消/失败后恢复，录制全程隐藏到停止/取消/失败后恢复。原先隐藏或最小化的窗口维持原状，应用退出不重新显示窗口。共用主进程服务，覆盖宿主与业务页两个入口，不接入 Computer Use。

用户补充：录制默认最大 30 分钟，在客户端「截图与录屏」设置里提供最大录制时长配置并保存到本机。沿用现有 API 的 1 小时技术上限，界面允许 1–60 分钟；宿主、菜单、业务页与 IM 入口共用主进程读取的当前偏好，调用方仅能进一步缩短本次录制。录制控制条显示已录制时间与剩余时间，到达上限自动停止、关闭采集流并生成文件。暂停不累加文件时长，现有墙钟兜底保持最多设定时长的两倍。

用户补充：托盘下拉菜单新增「设置」，显示/恢复主窗口后打开设置弹层；移除设置页中非 compact 的 Computer Use 操作面板。Computer Use 的开关和独立配置不在本轮删除范围。开发托盘图标按 `app.getAppPath()` 查找，不依赖 esbuild 模块目录。

本机证据：macOS 经 LaunchServices 启动开发 Electron，屏幕录制权限为 granted；截图自动框选、确认预览成功。触发截图/录制前主窗口隐藏，Esc 取消截图后恢复。实际 MP4 区域录制 400×300、38.8 秒、0.68 MB，控制条显示剩余 29:30，停止后主窗口恢复并生成预览。默认 30 分钟设置与 Computer Use 面板移除已在界面核验。商业回归 3018 项、脚本测试 339 项通过；录制最大时长自动停止生成文件用假时钟驱动真实录制状态机测试验证；TypeScript 本轮 capture/设置相关文件零错误，全仓仍有 236 条既有基线错误。

## 方案

- 冻结每屏帧后立即在主进程读取顶层窗口的桌面坐标和 Z 序（早于任何覆盖窗出现），按显示器换算为该屏冻结帧像素矩形（`selection.regions`，最上层在前）交给覆盖层。覆盖层只做纯前端命中测试，结果仍是 `sourceKind:'screen'` 加 crop，复用现有标注、确认和录屏区域链路。对外 API 与 `apiVersion` 不变。
- 主进程 `main/features/capture/windowRegions/`：
  - `project.ts`：DIP 和物理像素两种空间到帧像素的纯换算，裁剪到屏内，丢弃小于 8px 的窗口，最多 256 个。
  - `darwin.ts`：`CGWindowListCopyWindowInfo`，取 layer 0 且 alpha>0 的窗口。
  - `win32.ts`：`GetTopWindow`/`GetWindow` 按 Z 序遍历，边界取 `DWMWA_EXTENDED_FRAME_BOUNDS`，排除隐藏、最小化、cloaked、`WS_EX_TRANSPARENT` 以及 `Progman`/`WorkerW`。
  - `linux.ts`：Xlib 读 EWMH `_NET_CLIENT_LIST_STACKING`，叠加 `_NET_FRAME_EXTENTS`，扣除 `_GTK_FRAME_EXTENTS`，跳过隐藏、桌面类型和非当前工作区窗口；扫描期间临时安装吞错的 X 错误处理器，结束后恢复原处理器。
  - `index.ts`：懒绑定，失败返回 null，覆盖层退回手动框选，截图本身不依赖识别。
- 覆盖层 `windowRuntime.ts`：未选区时悬停高亮（命中最上层窗口，否则整屏），单击采用；按下后移动超过 4px 转为拖框。preview（Wayland）形态与窗口缩略图模式不变。

## koffi 集成（用户选定）与安全约束

- 只调用只读窗口查询 API，不使用回调（X11 错误处理器除外，仅在扫描期间安装）。不打开进程句柄，不调用钩子、注入、输入相关 API；函数签名写死，IPC 无法传入任何原生参数。
- 只有 `windowRegions/` 引用 koffi，主进程懒加载，渲染进程和 preload 不可达。
- `koffi.node` 作为 capture 资源放在 `resources/capture/<platform>-<arch>/`，不进 asar，以免 Electron 解包到临时目录后再加载（Windows 上「从 %TEMP% 加载未签名 DLL」是典型的杀软启发式规则）。运行时先校验 `koffi.json` 记录的 SHA256，不匹配则拒绝加载。
- 只携带目标平台的预编译文件；Windows 随应用签名，macOS 走现有 codesign 和公证；第三方声明登记 MIT。

## 验证

- 单测：`windowRegions/project.test.ts`、`readers.test.ts`（三平台以内存假 OS API 驱动读取器）、`selectionWindows.test.ts`（每屏 regions、失败回退、portal 不枚举）。
- 质量门：捕获域测试、`npm run test:commercial`、特性边界检查、`overlay:check`、`check:pin`。
- 真机：macOS Retina 加外接屏；win-pc 125%/150% 缩放与最大化窗口；Linux X11（GNOME、Xfce）；Wayland 行为不变。
- 安全软件闸门：在 win-pc 上用签名安装包对照基线，检查 Defender/SmartScreen、火绒、360、腾讯电脑管家，安装、首次截图、悬停全程无拦截。VirusTotal 外部扫描须用户另行同意。若误报不可接受，改用自建签名 helper，其余设计不变。

## 提交前质量自查（2026-10-14）

- 内聚：隐藏/恢复和录制最大时长统一由 `overlay/crates/agent-electron-client/src/main/features/capture/captureService.ts:170` 的采集会话管理，两个受信 IPC 入口共用服务。窗口查询集中在 `windowRegions/`，界面只接收帧像素矩形。
- 分层：本机偏好通过 `_kit/types.ts` 的只读 `getSetting` 接缝注入，capture 不直接访问客户端数据库；渲染进程不加载原生模块。11 项特性边界检查通过。
- 维护：默认时长、设置键和可配置上限集中在 `overlay/crates/agent-electron-client/src/shared/features/capture/recordingPreferences.ts:2`；API 校验共用该上限。资源下载/提取/声明都在 `scripts/client/capture-window-resources.mjs:68` 核验固定归档与模块 SHA256，打包文件清单由同一模块导出。
- 自查修复：时长输入在保存期间不再禁用，保存请求按顺序执行；录制等待最新保存结果。旧请求不会覆盖较新的输入，最后一次保存失败恢复到最后成功值。并发保存回归通过。
- 最终门禁：商业 3018 项通过、18 项跳过；本次资源/打包/边界专项 54 项通过。全量脚本此前 339 项通过。overlay 一致性、check:pin、diff 空白检查通过。本轮 capture/设置/托盘 TypeScript 零诊断，全仓仍保留 236 条既有基线错误。
- 三问通过，可提交。未执行合并或发布；新窗口识别的 Windows/Linux 真机、真实多屏与安全软件验收仍待完成。


## 正式版整合（2026-10-14）

- 用户要求并入 `release/v3.0.x`，更新相关子模块后走正式版流程；待发布版本选用远端尚未占用的 `3.0.14`，当前正式版为 `3.0.13`。
- 本次仅隐藏应用菜单中的「截图与录屏」。macOS 菜单项保留但 `visible:false`，截图/MP4 的 accelerator 明确允许隐藏时执行；Win/Linux 顶栏由同一个共享展示策略控制。特性注册、IPC、业务桥、常驻控制器、设置、托盘和已有快捷键保持可用。新增回归覆盖隐藏菜单后宿主三种动作仍可执行。
- 授权页状态标签改为在动作容器中垂直居中；开发客户端已核验，授权页 6 项回归通过。
- 核对并更新 nuwax-file-server 为 `1.6.0`，来源 `main@69c9d199302a87e0f9b2a387ac3d41de84706cc2`；声明清单同步更新，发布资源构建会再次 fetch 远端并校验实际随包版本。
- 与远端 release 合并时保留新基座 `eb0eeaca` 的 Linux 更新授权 4 项文案，各语言保留全部 935 个基座键和本轮捕获文案，四语言各 1254 键，兼容审查绑定重新生成。
- 本轮隔离检出用于整合、更新与打包，原工作区的前端嵌套子模块指针改动不进入发布。
- 质量自查：采集状态和回收仍集中在 capture 服务；应用菜单展示策略独立于能力开关，主进程和渲染进程共用；签名、资源哈希和许可证沿用既有流水线。三问通过。
- 新基座社区回归 1640 项通过，18 项跳过。最终合并商业回归 3040 项通过、18 项跳过，脚本门禁 339 项全部通过；正式版保持 Draft 到签名及安装包验收完成。

- 用户确认：本次紧急项为基座 NW-041 普通项目多会话隔离修复，file-server 仅例行升级。目标基座 `eb0eeaca96ac32b1a671bf1bd570dc3a5dd059d0` 包含 PR #30 / `e75c9d5c`；本轮社区门禁已验证同目录两对话并行、取消 B 不打断 A、同对话新 turn 仍替换旧 turn。
- 子模块更新完成：前端源码 `d7d0ff622a5c416162dc95b686fbaeff3fd79796`，产物 `0bf94615a304472155db5b994da8f0f362aa8112` 已推送产物仓，版本戳 `d7d0ff622` 一致；消息微应用 `b3ca206f40b535cabe998240b4247b68b1f5a29e`，资料库 `d223ab9e7ac9f70c1e613503d901d6cbedc98dc1`。
- 前端发布门禁：4029 项通过、6 项跳过（按 CI 排除既有支付结算专项）；类型门禁自测 19 项通过，四个受管类型域零诊断，架构检查无新增违规。壳代码本轮应用菜单/捕获新增文件 TypeScript 零诊断；全仓仍有既有诊断。
- 资源核验：实际构建的 nuwax-file-server `1.6.0` 记录来源 `69c9d199302a87e0f9b2a387ac3d41de84706cc2`，运行入口存在；原始工作区未升级或覆盖开发者资源。


## Windows 打包修复与新正式版号

- `v3.0.14@dd483a01` 的正式流水线 `38556492076` 在 Windows 的「Prepare and admit capture release resources」失败：Git Bash 的 GNU tar 将 `D:` 盘符识别成远程主机。源自窗口识别资源提取时对 PATH 中 tar 类型的错误假设。
- Windows 改为明确执行 `%SystemRoot%\System32\tar.exe`，macOS/Linux 继续使用各自的 tar。所有目标仍只提取锁定的两个成员，归档及模块 SHA256 校验不变。六目标准备回归同时检查 Windows 调用为系统 tar 绝对路径，资源/打包专项 43 项通过。
- 遵守不可变 tag 规则：保留 `v3.0.14`，修复后的正式版本改为 `3.0.15`。多会话修复、子模块 pin、file-server 1.6.0、应用菜单隐藏范围与原候选一致。
