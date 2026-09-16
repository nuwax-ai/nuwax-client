# 客户端设置弹窗样式对齐参考图（WorkBuddy 设置弹窗）· 实施计划

日期：2026-09-16 · 分支：外层 release/v1.0.x · 基座按分支规范 feat 线

## 背景与目标

用户提供 WorkBuddy 设置弹窗两张截图作为样式参考，要求客户端设置弹窗（壳渲染层 antd Modal，800×600）对齐其设计：

- 无顶栏标题条；左栏顶部小 caption + 图标导航，「关于」经分隔线钉在底部
- 右栏页标题与关闭钮同行
- 内容全宽白卡片行式布局（左标签/右控件），分组小标题（常规/权限/存储）

用户拍板：**基座统一改**（App.tsx/AboutPage.tsx 是基座文件，社区+商业同时生效，不扩 overlay 清单）；**关于页只重排现有内容**（不加意见反馈/帮助文档/二维码）。

## 改动清单

### 1. 弹窗骨架（基座 App.tsx + index.css）

- Modal 移除 header（「客户端配置」硬编码中文标题行）；closable=false 保留；遮罩玻璃模糊、圆角保留
- 右 pane 顶部行 = 当前 tab 标题（复用 `Claw.Menu.*`）+ 右上关闭 X；8 个 tab 统一套用，页面组件不动（MCPSettings `display:contents` 保留）
- 左 sider 弃用 antd Menu → 轻量自定义列表：caption=`APP_DISPLAY_NAME` + 图标按钮 active pill；7 项在上，「关于」flex-spacer 钉底+上方分隔线；menuItems 数据结构保留
- 尺寸 800×600 → 880×640；侧栏 140→200px（en 220）

### 2. AboutPage 重排（基座，差距最大）

- 840 行全 inline → 新建 `AboutPage.module.css`（只用主题 CSS 变量，暗色自动适配）
- 居中窄卡片（400px）→ 全宽行式卡片：
  - 卡片「关于」：当前版本行（icon 20px 行首 + 检查更新按钮右侧，6 态状态机保留，进度条行下展开）/ 品牌行 + 前往官网按钮 / beta 通道 Switch 行
  - 系统信息四行独立卡片（客户端/界面/操作系统/本地化 dist）
  - 发布元数据：发现更新时独立卡片；调试面板保留（折叠）
- webMeta props、update:status 订阅、桥调用零改动

### 3. SettingsPage token 微调（overlay 源，sync 覆盖工作树）

- 行高/圆角/分组标题与 AboutPage 统一；交互零改动

### 4. locales

- 基座 4 文件 + overlay 超集副本；新增键按需（`Claw.Common.close` 等）；页标题复用 `Claw.Menu.*`；本仓前缀 `Claw.*`

## 门禁与验证

1. `node scripts/sync-overlay.js`
2. `npm run test:commercial`
3. `npm run base:test` 在 git worktree 隔离副本跑（会清 overlay），跑完重新 sync
4. dev 目检：外层 `npm run base:dev` + `NUWAX_APP_IDENTIFIER=nuwax`，走查 8 tab + 关于页更新态 + 亮/暗主题
5. 提交：基座 feat 分支（`npm run check:pin` 绿、显式 add 排除 overlay 托管产物）；外层 submodule bump + 本计划工件

## 明确不做

不新增反馈/文档/二维码内容；不动前端仓（nuwax/）；不动更新逻辑与桥协议；overlay 清单不扩。
