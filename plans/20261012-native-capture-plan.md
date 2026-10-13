# 原生截屏 / 录屏特性模块

- 状态：**2026-10-12 由 Codex 接手，原生截图、标注、录屏和客户端验收入口已实施；macOS 开发验证通过。HDR、Windows 与完整安装包验收尚未完成**。
- 规格：`specs/native-capture.md`；意图：`plans/20261012-native-capture-intent.md`。
- 分支：`codex/native-capture`，保留交接时 `release/v3.0.x` 上已有未提交代码和子模块状态；不在发布分支直接提交新功能。合入目标与发布在实现和验收后单独处理。
- 范围：全部在 nuwax-client 内实现（overlay、商业 `scripts/`、`third-party/`、`resources/`），**不修改基座仓**；前端仓仅契约与 `utils/hostBridge` 封装；IM 不改，只交付接入文档。

## 已定决策

1. 不做临时修复，直接做客户端原生能力；原因：根因是主进程无 `setDisplayMediaRequestHandler` 且 IM 静默吞错，页面级方案满足不了压缩档、GIF、HDR 与统一交互。
2. 能力：截屏；录屏→视频（mp4/webm，调用方选）；录屏→GIF。压缩只降质量、尺寸不变，四档（lossless/high/medium/low）加可选 `maxBytes`。HDR 屏一律输出 SDR/sRGB。
3. 全部交互 UI 为原生窗口；v1 含整屏/窗口选择、区域框选、标注、录制控制条；不含音频、跨屏选区、窗口悬停高亮、Linux。
4. 做成独立特性模块：静态注册表 + 最小 `_kit` + 4 处通用接缝；守卫测试强制边界；开关可关，关闭零痕迹。
5. 编码走系统编码器（VideoToolbox / MediaFoundation），不打包 libx264；ffmpeg 必须 LGPL 构建、独立可执行文件；H.264 授权归属由法务确认。
6. 「关于」页新增「开源组件声明」（五列表格 + 页首声明 + 许可证全文）；仅商业版；ffmpeg 入包前必须通过其守卫。
7. IM 不由本仓修改，交付 `docs/native-capture-api.md`。

## 接手实施顺序（2026-10-12）

1. 核实并验证已写的 Phase 0a / 1，保留商业 overlay 与子模块 WIP，不清 overlay、不更新产物 pin。
2. 原生截图窗口：多屏冻结、整屏/窗口/区域选择、物理像素裁剪、标注、撤销重做、确认/取消。
3. 原生录屏：沿用来源选择；倒计时、暂停/继续、停止/取消、默认时限；独立录制窗口采集，主进程编码与清理。窗口 IPC 仅允许当前创建的窗口与主 frame。
4. 编码与资源：锁定 LGPL ffmpeg，拒绝 GPL/nonfree；WebM/MP4/GIF、压缩档和 maxBytes 下探；准备与打包脚本及声明同步。现有 Homebrew ffmpeg 为 GPL 构建，不能入包。
5. 客户端提供可点击的截图/录屏与结果预览、保存入口，便于直接验收；业务页桥保留兼容，IM 接入仍由 IM 团队负责。
6. 补齐会话结束、锁屏、显示器移除与退出清理；针对几何、标注、IPC、控制状态、编码参数与文件清理进行单测，商业域测试和构建通过后重启客户端直连测试环境。
7. 用真实 Electron 检查截图与短录屏（含区域、暂停/停止、格式、结果尺寸），记录实测结果；Windows/HDR/签名安装包等本机不能覆盖的验收项单列。

验收不以 capabilities 字段或 mock 测试代替真实截图与视频产物。HDR 实际转换、控制条是否入镜均如实报告，不能以标签或 contentProtection 调用冒充实机验证。

## 接手后的追加要求（2026-10-12）

- [~] 提测前入口调整：移除页面顶部相机/自绘捕获项，客户端设置增加「截图与录屏」页签；控制器常驻，面板切换不影响原生菜单/快捷键/结果预览。发起前等待设置弹窗关闭，避免拍到自身。关于页「开源组件声明」增加20px底部留白。

- [x] 确认独立使用与 IM 菜单接入双路径：公开 record Promise 在停止/编码后返回；补充指定会话附件回填控制器示例、取消/切换会话/卸载/超限清理与实际业务 IPC 回归。接口无需新增 IM 会话参数，IM 负责人接线仍在独立项目完成。

- [~] 验收追加：常用标注/撤销重做/暂停停止等按钮图标化，保留本地化 tooltip 与无障碍名称；关键确认/开始动作保留文字。录制边框去圆角、阴影与 outline，使用均匀的直角矩形 border。

- [~] 用户验收反馈的 UI 与选区脱节：删除录制工具栏优先其他屏策略；截图模式、标注、确认操作合为选区旁浮层；统一下方→上方→侧边→所选屏底部的定位规则，避开菜单栏/Dock；录制过程保留同一工具栏位置并允许拖动；暂停边框与状态同步、处理阶段移除边框。验证负坐标、混合 DPI、靠边区域、整屏、多屏屏幕身份，以及原生 DOM 选区跟随。

- [x] 客户端原生菜单栏增加「截图与录屏」，与相机入口共用流程；macOS 原生菜单、Windows 既有自绘菜单同等入口，提供应用内菜单快捷键，关闭特性时隐藏。macOS 实际菜单点击已验证，Windows 界面与快捷键仍待实机。
- [~] 多屏专项：相关回归与隔离双屏 DOM/IPC 验证通过；修复 MP4 奇数区域扩边可能采到边框的问题。任意显示器来源、负坐标/上下布局、混合 DPI、任一屏取消与同屏关联控制条均有自动化证据；真实混合 DPI/HDR/拔插仍需联调。
- [x] nuwax-im 负责人交接文档与独立读取示例，6 项读取/超限/失效/清理测试及 ES2020+DOM 类型检查通过；未修改 IM 业务实现或发送消息。

## 实施清单

状态记号：`[ ]` 未开始　`[~]` 代码与自动化测试完成、待真机/实机验证　`[x]` 完成。

**Phase 0a 开源组件声明（先行）**
- [~] 0a-1 manifest 与声明生成器已实现；capture 两组件严格检查通过，完整安装包仍有 13 项既有声明/许可证缺口
- [x] 0a-2 `scripts/third-party-notices.test.mjs` 守卫（缺声明、GPL/未知许可证、缺源码地址、ffmpeg `configuration` 含 `--enable-gpl|--enable-nonfree` 均判红）
- [x] 0a-3 overlay `renderer/features/open-source-notices/`：`CommercialAboutPage` + 声明页（表格、页首声明、许可证全文、搜索）；数据读取通道
- [x] 0a-4 文案四语言；`overlay/README.md` 清单登记；pack 追加 `extraResources`
- [ ] 0a-5 起草用户协议「第三方软件或技术」条款（`docs/` 内文本，交产品/法务）

**Phase 1 骨架 + 契约 + 核心（无 UI）**
- [x] 1-1 最小 `features/_kit`、静态注册表与 `features.<id>.enabled` 开关；按实际需要注入翻译与托盘停止动作
- [x] 1-2 主进程、preload、契约快照、托盘和宿主 UI 接缝；`sessionEnded` 汇合点
- [x] 1-3 `scripts/check-feature-boundaries.test.mjs`
- [~] 1-4 capture 核心、状态机、错误码与文件结果已实现；HDR 仅检测，尚无真实色调映射
- [x] 1-5 `nuwax/` 源码子模块的桥契约与 `getCaptureBridge()`；已验证，无提交、推送或更新 pin
- [x] 1-6 `docs/feature-modules.md`、`docs/native-capture-api.md`（含假桥与当前限制）

**Phase 2 截图 UI**
- [x] 2-1 覆盖层窗口管理（每屏一个、显示前冻结帧、鼠标所在屏聚焦、Esc）
- [x] 2-2 渲染页：整屏/窗口/区域选择、放大镜、尺寸提示
- [x] 2-3 标注工具条（矩形、椭圆、箭头、画笔、文字、马赛克、撤销重做）+ 确认/取消；标注叠加合成
- [x] 2-4 特性文案四语言

**Phase 3 录屏**
- [x] 3-1 `recorder`（隐藏窗口 MediaRecorder）+ `transcode`（ffmpeg → webm/mp4/gif，含 crop、档位参数）；真实编码/解码矩阵通过
- [~] 3-2 控制条、区域边框、托盘停止、时长上限、取消与清理已实现；控制条排除和设备事件仍需安装包实机矩阵
- [x] 3-3 LGPL ffmpeg 资源准备、锁定源码与校验和、声明与打包门禁；macOS arm64 实际构建/探针通过，Windows 构建方案待实机

**Phase 4 收尾**
- [~] 4-1 TTL 清扫、录屏分块落盘、原生保存与文档已完成；长录制性能、安装包矩阵和发布仍待后续。开发记录见 `docs/acceptance/20261012-native-capture-dev.md`

**需要真机/实机，开发会话内无法完成（标 `[~]` 并列入验收清单）**
- Phase 0 Spike：Win11（HDR 开/关、双屏混合 DPI）与 macOS（Retina、外接 HDR）：HDR 路径 A/B/C、内容保护是否排除、ffmpeg 构建、档位数值。
- 实机验收：真实安装包上的整屏/窗口/区域×截图/mp4/webm/gif×四档、授权拒绝、录制中登出/锁屏/拔屏、控制条未入镜；关于页列表与 `resources/` 实际一致。

## 验证命令

- `npm run host-bridge:check`、`overlay:check`、`test:commercial`、`test:scripts`、`check:pin`；社区 `base:test` 在隔离副本执行。
- 前端仓：`typecheck:contracts`、`lint:arch`、`utils/hostBridge` 单测。

## 风险与回退

- ffmpeg：必须 LGPL 构建、提供精确版本源码、保持独立可执行；声明只解决署名与源码入口，H.264 授权由法务确认。
- HDR 路径未验证；路径 C（原生引擎）成本高，倾向不走。
- 接缝改动触及 overlay 覆写的既有文件（`main.ts`、`webviewPerfBridge.ts`、`trayManager.ts`、`App.tsx`），须小且通过 `overlay:compat`；基座升级时 `AboutPage` 签名变化由 `overlay:compat` 与组合页单测兜底。
- 区域框选、多屏覆盖层、标注、控制条合计工作量大，Phase 2/3 可能再拆。
- 回退：特性开关关闭即零痕迹；移除 `features/capture`、`features/open-source-notices` 与接缝改动即可完全撤销，不影响登录与既有桥契约。
