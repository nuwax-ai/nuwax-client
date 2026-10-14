# 规格：原生截屏 / 录屏特性模块

- 对应 intent：`plans/20261012-native-capture-intent.md`
- 对应 plan：`plans/20261012-native-capture-plan.md`
- 状态：设计已批准，原生截图交互与录屏已实施并通过 macOS 开发验证；HDR、Windows 与真实安装包仍待验收，见 `docs/acceptance/20261012-native-capture-dev.md`。

## 需求基线

提供商业客户端原生截屏、录屏（视频 mp4/webm、GIF）能力，经 `NuwaClawBridge.capture` 供受信顶层业务页（IM）调用；交互界面全部为客户端原生窗口。全部实现位于 nuwax-client，**不修改基座仓**（`nuwa-electron-shell`）。

## 特性模块边界

- 目录：`overlay/crates/agent-electron-client/src/main/features/capture/`，另有 `preload/features/capture.ts`、`renderer/features/capture/`、`shared/features/capture/`；全部为新增文件。
- 静态注册表与运行时在 `main/features/index.ts`（公开入口），不做动态插件加载；`_kit` 现含：特性清单类型、注册（按产品与开关过滤、单个失败隔离）、受信 IPC、生命周期事件、临时目录；托盘贡献与 i18n 语言包等到 Phase 3 / 有实际需求时再增补。特性上下文提供两条 IPC：`ipc`（受信顶层业务页，复用 `isIMSender`）与 `hostIpc`（宿主壳渲染进程，复用 `isHostSender`，供「关于」页使用）。
- 边界规则由 `scripts/check-feature-boundaries.test.mjs` 强制：特性只能引用自身、`_kit`、`shared/types/hostBridge`、第三方与 Node/Electron；外部只能经 `main/features/index`、`preload/features/index`、`renderer/features/<id>`、`shared/features/<id>/contract` 引用特性；`_kit` 不依赖特性；特性内不出现 `APP_NAME_IDENTIFIER`。
- 开启：特性清单的 `enabledByDefault` 为默认，运行期可由设置项 `features.<id>.enabled` 覆盖，无需发版。关闭时：主进程不注册 IPC、不建窗口、不占托盘、不创建临时目录；桥上 `capture` 命名空间仍在，但 `getCapabilities().available === false`，其余调用返回 `unsupported`（preload 把「No handler registered」映射为此结果，真实处理函数报错则返回 `failed` 并带信息）。
- 既有代码的接缝（均为 overlay 里已有的整文件覆写版本，改动落在 overlay 副本，须小且通过 `overlay:compat`，并在 `overlay/README.md` 清单登记）：`nuwaxBridgeHandlers.ts`（一次 `startDesktopFeatures`；`cancelTransfers` 在每个会话边界通知特性 `sessionEnd`，登出/换域带原因）、`main.ts`（退出清理一步 `disposeDesktopFeatures`）、`webviewPerfBridge.ts`（受信顶层页展开 `featureNamespaces`）、`preload/index.ts`（壳渲染进程展开 `hostFeatureNamespaces`）、`renderer/App.tsx`（`AboutPage` 的 import 指向 `CommercialAboutPage`）、四语言 locale JSON（新增键）。`hostBridge.ts` 快照与 `trayManager.ts` 待契约落地 / Phase 3 再改。
- 文案：渲染进程特性不得 import 客户端 i18n，翻译函数由调用方传入；文案键加在 overlay 四语言 JSON（严格超集，`i18nLocales.test.ts` 守卫键集与占位符一致）。

## 对外契约

公开类型事实源在前端仓 `src/types/interfaces/hostBridge.ts`，客户端快照经 `host-bridge:sync` 生成；契约只增不改，`getCapabilities().apiVersion` 为整型。

```ts
type CaptureQuality = 'lossless' | 'high' | 'medium' | 'low';
interface CaptureCompression { quality: CaptureQuality; maxBytes?: number }
capture: {
  getCapabilities(): Promise<{ apiVersion: number; available: boolean; platform;
    permission: 'granted' | 'denied' | 'not-determined' | 'n/a';
    displays: { id; hdr: boolean; scale: number }[];
    formats: { still: ('png' | 'jpeg' | 'webp')[]; video: ('mp4' | 'webm')[]; gif: boolean };
    tiers: Record<CaptureQuality, TierDescriptor> }>;
  screenshot(opts?: { format?; compression? }): Promise<CaptureResult>;
  record(opts: { output: 'mp4' | 'webm' | 'gif'; fps?; compression?; maxDurationMs? }): Promise<CaptureResult>;
  cancel(): Promise<void>;
  onStateChange(cb): () => void;
  readChunk(resultId, offset, length): Promise<ArrayBuffer>;
  release(resultId): Promise<void>;
}
CaptureResult = { success: true; resultId; mime; bytes; width; height; durationMs?; qualityUsed; hdrToneMapped }
  | { success: false; code: 'canceled' | 'permission-denied' | 'busy' | 'encoder-unavailable' | 'unsupported' | 'untrusted' | 'failed'; error? }
```

`canceled` 是正常结果；其余 `code` 调用方必须显式提示。渲染进程只持有不透明 `resultId`，不接触文件路径。

## 交互设计

- 当前引擎：`screenshot()` 先冻结显示器与窗口来源，再显示每屏原生覆盖窗口供选择、标注与确认；输出按物理像素裁剪。`record()` 复用来源选择，之后进入独立采集窗口与录制控制条。

- 截图：先对每块显示器全分辨率抓冻结帧，再为每块屏起透明置顶覆盖窗口；选区旁浮层 `整屏 | 窗口 | 区域`；窗口选择为缩略图网格（窗口源无边界信息，不做悬停高亮）；区域带尺寸提示与放大镜；选区限单屏。高频工具用带本地化悬停提示与无障碍名称的图标表达，关键确认/开始动作保留文字。选区后工具条提供标注（矩形、椭圆、箭头、画笔、文字、马赛克、撤销重做）与取消/确认（`Esc`/`Enter`）。
- 确认后在物理像素上无损裁剪并叠加标注，输出尺寸等于选区物理尺寸（DIP 到物理像素按 `display.scaleFactor` 换算）。
- 录屏：覆盖层选来源，3-2-1 倒计时；录制中有控制条（计时、暂停、停止）、区域边框窗口、托盘停止入口；控制条与边框窗口设内容保护以免入镜（待验证）。区域录制先录整屏，转码阶段用 ffmpeg 裁剪。截图操作条与录制控制条使用同一定位规则：选区下方优先，空间不足依次上方、侧边；无外部空间时退到所选屏的工作区底部，避开菜单栏和 Dock。录制倒计时、暂停、继续、处理过程中不自动改变工具栏位置，允许手动拖动；边框为无圆角、无阴影的直角矩形，暂停时边框为黄色虚线，处理时撤去边框。窗口来源缺少实际桌面边界，控制条保留在发起窗口选择的屏幕，不伪造窗口位置。

## 压缩档

数值由 `shared/features/capture/tiers.ts` 唯一定义（main 与 preload 共用），Phase 0 实测后定稿。
- 静态图：当前基于 Electron `nativeImage`，**零新增依赖**（不引入 sharp：它在本检出里没有平台二进制，打包只解包了 better-sqlite3，且会带入 LGPL 的 libvips）。`png` 严格无损，所有档位输出同一份 PNG、`qualityUsed` 如实报告 `lossless`（`maxBytes` 无法靠换档达标，如实标记 `exceedsMaxBytes`）；`jpeg` 质量取自档位（`lossless` 档对 JPEG 表示该格式最高质量，仍属有损）。未指定格式时：无损档默认 PNG，有损档默认 JPEG。`webp`、PNG 调色板量化、4:4:4 色度要等 ffmpeg 编码器（Phase 3）提供，`getCapabilities().formats.still` 只如实列出当前可用格式。`nativeImage` 的 JPEG 色度采样与文字边缘观感待 Phase 0 实测，不理想时由 ffmpeg 路径补。
- 视频按每像素每帧比特数换算码率，VP9 用 CRF。GIF 用 `palettegen/paletteuse`，档位调帧率上限、色数、抖动、帧间差分。
- `maxBytes` 从所选档逐级下探，仍超则如实返回 `qualityUsed` 与大小，不缩放像素。H.264 yuv420p 要求偶数宽高，选区几何优先向右/下（其次向左/上）多取 1 像素真实内容，整轴都是奇数时才由编码器补 1 像素，并在结果标注。

## HDR 策略

输出一律 SDR/sRGB：静态图嵌 sRGB ICC，视频打 BT.709 标签；覆盖层冻结帧与最终输出必须同一色彩管线。判定与路径待 Phase 0 三选一：A Chromium 采集已是正确 SDR，仅打标签；B 主进程做 HDR→SDR 色调映射（视频链要求 ffmpeg 含 libzimg）；C 才引入 WGC / ScreenCaptureKit 原生引擎。

当前状态：`hdr.ts` 的 HDR / 广色域判据是对 `display.colorSpace` 字符串的关键字匹配，属临时判据，需用 Electron 40 真机取值核对后收紧；当前截图与录屏引擎未做 HDR 色调映射，`hdrToneMapped` 恒为 `false`。BT.709 标签不能代替转换或真机验收。

## 安全与合规

- 仅 nuwax 商业版、受信顶层业务页、主 frame、当前文档；校验集中在 `_kit` 受信 IPC。
- 用户手势触发；默认录制时长上限；单会话（`busy`）；登出、换域、关窗、锁屏、拔屏均取消并清理。
- macOS 用 `systemPreferences.getMediaAccessStatus('screen')`，缺失返回 `permission-denied` 并引导系统设置。
- 临时文件在 `~/.nuwax/capture/<resultId>/`，权限 0600，`release` 即删，启动时按 TTL 清扫。
- 编码：优先系统编码器（macOS VideoToolbox、Windows MediaFoundation），不打包 libx264；ffmpeg 必须为 LGPL 构建，作为 `resources/` 内独立可执行文件由子进程调用。H.264 授权归属由法务确认。

## 开源组件声明

「关于」页新增「开源组件声明」链接与页面：表格五列（名称、版本号、许可证、是否经过修改、源代码地址）加页首声明与许可证全文，应用内渲染安装包内的 `third-party-notices.json`，`licenses/` 目录随包分发；源码包自托管于 OSS `third-party-source/`。守卫测试要求每个 `resources/*` 与每个特性资源有声明，GPL/未知许可证判红，ffmpeg 的 `configuration` 含 `--enable-gpl` 或 `--enable-nonfree` 判红。实现全部在 nuwax-client 内，**不修改基座仓**：overlay 新增 `renderer/features/open-source-notices/`，其中 `CommercialAboutPage` 组合基座 `AboutPage` 并追加「开源组件声明」一行与页面；`overlay/.../renderer/App.tsx`（已是 overlay 覆写文件，第 77、2247 行引用 `AboutPage`）只改 import 与渲染两处，不分叉 790 行的 `AboutPage.tsx`。仅商业版有此入口，社区 NuwaClaw 不含。manifest、`licenses/` 在商业仓 `third-party/`，生成脚本与守卫在 `scripts/`；基座自带的 `resources/*` 组件也登记在商业仓 manifest 里；`extraResources` 经商业打包配置追加（具体文件开工时定位）。用户协议「第三方软件或技术」条款文本交产品/法务定稿。

## 平台矩阵

2026-10-13 增量：Linux 支持按 `specs/linux-native-capture.md` 实施；以下表格保留首版设计基线，不再代表当前 Linux 能力。实际环境验收见 `docs/acceptance/20261013-linux-native-capture.md`。

| 项 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| 截图 / 录屏 | 支持，需屏幕录制授权 | 支持 | `unsupported` |
| 编码器 | VideoToolbox + LGPL ffmpeg | MediaFoundation + LGPL ffmpeg | 不适用 |
| HDR | Phase 0 判定路径 | Phase 0 判定路径 | 不适用 |

## 异常与失败场景

用户取消返回 `canceled`；授权缺失返回 `permission-denied`；已有会话返回 `busy`；硬编不可用返回 `encoder-unavailable`；显示器拔插、锁屏、登出中途取消并清理临时文件；转码失败返回 `failed` 并保留错误摘要，不留残留文件。

## 测试计划

- 单测：档位映射、`maxBytes` 下探、全档×全格式的尺寸不变性属性测试、DIP 与物理像素换算（含混合 DPI）、标注叠加顺序、HDR 判定、信任/越权/`busy`、特性关闭零痕迹。
- 守卫：`check-feature-boundaries`、`third-party-notices`（构造违规须判红）、`host-bridge:check`、`overlay:check`、`check:pin`；社区 `base:test` 在隔离副本确认不受影响。
- 真实 Electron 临时 profile 冒烟；真实安装包实机验收：Win11 HDR 开/关与双屏混合 DPI、macOS Retina/HDR，整屏/窗口/区域×截图/mp4/webm/gif×四档，授权拒绝、录制中登出/锁屏/拔屏、控制条未入镜。

## 备选方案

- 只注册 `setDisplayMediaRequestHandler` 让页面 `getDisplayMedia` 可用：不能满足压缩档、GIF、HDR 与统一交互，已否决。
- 交互界面放 nuwax PC web：页面内无法框选其他应用区域；用户已选全部原生窗口。
- 全部交给原生助手（Rust）采集：成本高，仅在 HDR 路径 C 才引入。
- 用 ffmpeg 直接做屏幕采集：窗口选择、权限与 HDR 控制困难。
