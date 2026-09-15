# 规格：client-shell-feedback

- 对应 intent：`plans/20260916-client-shell-feedback-intent.md`
- 状态：技术评审通过（2026-09-16）

## 需求基线

按 intent 实现更新入口与版本展示、故障圆点语义和沉浸式顶部交互；不在登录页或侧栏常驻版本号，不新增启动更新弹窗。

## 方案设计

### 架构落点

- Electron 更新服务维护权威 `UpdateState`；关于页负责动作，顶栏只负责状态提醒和导航。
- renderer 以 webview token 镜像、商业生命周期 phase 和健康轮询共同计算“需处理故障”，不再直接用“任一服务未运行”渲染圆点。
- nuwax 页面通过既有 `layout` 桥上报明确空白矩形；主进程校验转发，壳工具栏按矩形渲染 drag region。

### 数据与契约

- `UpdateState` 新增 `releaseDate?: string`、`releaseNotes?: string`。
- 新增 `TitlebarDragRegion = { x: number; y: number; width: number; height: number }`。
- `NuwaClawBridge.layout.setTitlebarDragRegions(regions)`：坐标为 webview 视口 CSS 像素；最多 16 个，只接受有限非负坐标和正尺寸，裁剪到顶部 48px 与窗口宽度。
- 页面导航、组件卸载时上报空数组；壳在 guest 导航开始时也主动清除，防止旧页面热区残留。

### 平台矩阵

| 行为点 | macOS | Windows/Linux | 备注 |
|---|---|---|---|
| 更新常驻入口 | 应用菜单；有任务时右上提示 | 顶栏“关于”；有任务时窗口键前提示 | 未登录可用 |
| 拖拽 | 避开红绿灯和壳按钮 | 避开菜单、更新入口和窗口三键 | guest 上报空白区 |
| 双击 | drag region 原生缩放行为 | drag region 最大化/还原 | 真机验收 |
| 协议缺失 | 顶部窄条降级 | 顶部窄条降级 | 兼容旧前端 |

## 异常与失败场景

- 启动检查断网：关于页可重试，不显示全局顶栏故障。
- 已发现版本后的下载/安装失败：顶栏保留失败入口，点击回关于页处理。
- MSI/只读卷：关于页展示原因并引导官网下载。
- 未登录或生命周期处于 registering/starting/stopping/stopped：圆点隐藏并清除健康失败计数。
- 生命周期失败立即显示红点；ready 后服务连续两轮（5 秒一轮）异常才显示，单轮抖动不显示；恢复后立即清除。
- 热区载荷非法或过期：忽略并使用安全窄条，不允许覆盖壳按钮。

## 测试计划

- 单元：更新状态映射、关于页导航、发布信息、故障状态表、连续轮询阈值、矩形校验裁剪和清空。
- 集成：guest layout bridge→主进程→renderer，路由/resize/收起状态重算，旧前端降级。
- 门禁：隔离副本 `npm run base:test`；同步 overlay 后 `npm run test:commercial`、overlay check、前端 typecheck/vitest、`npm run check:pin`。
- 真机：macOS 与 Windows 安装包分别验证未登录更新、登录故障恢复、顶部点击、拖动和双击最大化/还原。

## 已否决的备选方案

- 整条透明宿主拖拽层：会吞掉 webview 内容的指针事件。
- 仅在 guest 写 `app-region`：不能可靠拖动宿主 BrowserWindow。
- 状态点表示“未完全运行”：会再次把未登录、启动中和主动停止误报为故障。
- 顶栏更新按钮直接下载：用户未查看版本与发布说明就产生网络和磁盘行为。
