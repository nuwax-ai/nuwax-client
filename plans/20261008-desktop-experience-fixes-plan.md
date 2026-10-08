# 桌面体验修复计划

- 日期：2026-10-08
- 状态：已实施并提交，本地测试与构建通过；未发版，真实安装包验收待完成。
- 来源：用户本次明确提出的 BUG-98、BUG-113、BUG-80；[问题记录表](https://agent.nuwax.com/repo/doc/66hV2y4XzetV6H6E)，以及后续积分余额截图反馈。
- 范围：既有能力的小调整和缺陷修复，无新增后端接口契约；合并记录一份计划。

## 改动与验收

1. 开机自启动：复用设置页和托盘现有开关。安装包首次运行默认注册自启动；保存用户明确关闭的选择，后续启动不覆盖；开发运行不默认注册开发用 Electron。操作后回读系统状态，失败不报告成功。
2. Windows 任务栏图标：缩小 ICO 内透明边距，让有效图形相对原资源放大约 `42 / 39`，各分辨率一致；保留既有品牌图案及 macOS Dock 资源。
3. 任务列表执行中标记：旋转动画随组件静态样式加载，不依赖图标库首次挂载时注入的动画样式；首次渲染、状态切换及重新进入均持续旋转，失败态静止。
4. 用户菜单积分余额：每次展开重新请求 `/api/credit/summary`，收起时停止轮询；常驻余额栏继续原有刷新方式，订阅关闭时不请求；接口失败保留上次成功余额。

## 主要落点

- `overlay/.../main/window/autoLaunchManager.ts` 与专项测试：默认初始化、选择保存、系统回读。
- `overlay/.../main/main.ts`：数据库初始化后、设置 IPC 及窗口可用前初始化自启动。
- `overlay/.../public/icon.ico`：Windows 安装包及窗口任务栏共用资源。
- `scripts/generate-windows-icon.mjs`：从既有品牌源图可重复生成 Windows ICO，保持 11 档 DIB 层。
- `nuwax/src/layouts/DynamicMenusLayout/NewHomeSection/components/ConversationStatusMark/index.less`：组件自身静态动画。
- `nuwax/src/components/business-component/CreditsBalance/index.tsx` 与 `nuwax/src/layouts/DynamicMenusLayout/User/index.tsx`：弹层开闭驱动刷新。

## 验证与限制

- 自启动专项回归、托盘回归及商业测试门禁；构建主进程验证打包输入。
- 图标逐帧检查尺寸、透明边距、ICO 格式并查看预览。
- 前端组件回归及 Chromium 中检查初次渲染动画的实际 transform 变化，屏蔽图标库动态样式验证兜底。
- 不在当前有 overlay 的工作树执行会清理 overlay 的社区测试。保留既有无关 WIP。
- 真 Windows 安装包重启登录、自启动关闭后重启、系统 DPI 下任务栏观感，以及完整客户端首次主页实测另列验收边界。

## 完成记录

2026-10-08：

- 自启动及托盘专项：2 文件、31 用例通过，其中新增 16 项覆盖首次默认开启、关闭后重启、系统禁用、设置失败、开发模式、macOS、Linux/AppImage。
- 商业客户端全量：`npm run test:commercial`，173 文件通过、1 跳过；2,297 用例通过、18 跳过。
- 前端积分余额、支付窗口、执行状态标记专项：3 文件、16 用例通过，其中新增 6 项余额刷新回归。
- 浏览器实际动画：使用真实 React 状态组件与 LESS 编译结果，屏蔽图标库 `loadingCircle` 动态样式。旧版 `animation=none / transform=none`；修复版为 `conversation-status-mark-spin`、1 秒无限旋转，240ms 间隔采样得到不同变换矩阵。失败态无动画，重新执行恢复；恢复图标库样式后仍只运行一条动画。此项验证动画独立加载机制，未等同完整客户端首次主页真机验收。
- Windows ICO：11 层 16/20/24/32/40/48/64/72/96/128/256px 全部有效；48px 层有效宽高从 44px 到 47px，256px 层从 230px 到 248px，透明圆角保留。重复生成 SHA-256 一致。Windows 窗口 `getIconPath()` 与安装包都消费此 ICO，macOS Dock 资源未改。
- 商业主进程生产 bundle 通过；前端 `UMI_ENV=production pnpm exec max build` 通过，产物 CSS 已包含同名映射后的独立 keyframes 和 `.mark-spin.anticon` 动画选择器。
- `overlay:check` 零差异、`check:pin` 通过，两个仓的 `git diff --check` 通过。
- 类型检查限制：主进程全量仍有 `autoUpdater.ts:224` 的既有 TS18047；用修改前的 main/autoLaunch 源码替换编译器输入后仍是相同的一条诊断，本次无新增。前端全量存在 287 条诊断，本次改动路径零诊断；未宣称全库类型门通过。
- 用户后续授权 commit and push 后，前端已提交为 `f8dbcb4a89c7e55a2fc61474baf5a77322017fd8`，推送至 `nuwax` 的 `codex/desktop-experience-fixes-20261008`。保持原固定基线，没有纳入版本分支上另外 42 个提交。
- 通过壳根 `npm run frontend:build` 重新构建完整产物（包括固定版本微应用），产物 `version.json.gitHash=f8dbcb4a89` 与源码提交匹配；构建后生成的 `src/constants/version.ts` 已自动恢复，源码工作树干净。
- 产物提交 `5739f983c1db45373866d8b37508a1468d6a5212`，目标为 `nuwax-dist/main`；客户端 `release/v3.0.x` 同步源码/产物双 pin，并提交商业 overlay 修复。构建产物保留编译器输出字节，不改写生成内容。线上与已安装版本尚未更新。
