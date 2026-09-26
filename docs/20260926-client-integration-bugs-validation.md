# #2428 / #2427 / #2526 开发与验证

## 代码边界

- parent 基线 `951aa597`，隔离分支 `codex/bugs-client-integration-20260926`。
- 基座 `52bd898f` → `f7e3f931`（终端，12 个中立文件；未推送）。
- 语言迁移用户已接受的共享 WIP 意图：webview 为语言来源，默认简体中文，隐藏壳独立语言项。未吸收票据或 loopback WIP。
- PR #18（2026-09-26 实查仍 OPEN，head `114cf30a9`）的 session cwd 方案按当前三轨 pin 手工适配；未合 PR。

## 独立工单结果

| 工单 | 代码与验证 | 剩余交付边界 |
| --- | --- | --- |
| #2428 | 可信 guest 同步直接更新主进程/托盘并持久化原语言；壳 renderer 跟随 i18next，不反向 reload guest；启动恢复 webview 镜像，未知语种仅壳回退中文；快速切换迟到回调受 revision 守卫。Win/Linux 自绘菜单补 i18n 文案。 | 未重打用户包；未知 09-24 激活包版本与原复现细节未取得。 |
| #2427 | 菜单状态统一受控且使用稳定 menuId；guest IPC/失焦关闭保持；菜单展开时原生 spacer / dragRegions 临时 no-drag，pointerdown/click 关闭后恢复 drag。 | 未验 Windows/Linux 安装包；需包级拖拽、失焦与再次打开复验。 |
| #2526 cwd | ACP new/load/memory 保留原请求 project_id 与 session.cwd 关联；默认轨道精确匹配实际 cwd，支持空目录/中文目录；normalProject 保持独立镜像轨道；miss 只回退配置/HOME，不借最近其他会话 cwd。 | 未登入真实用户项目/三个引擎做 GUI 项目级验收。 |
| #2526 中文 | 修正 LC_ALL=C / LC_CTYPE=C 比 LANG 优先导致 UTF-8 仍不生效；实际生成 wrapper 在 macOS 子进程验证四种 locale、中文空格目录和中文回显。 | 子进程回显不等同 macOS 输入法 IME 真包键入；该项仍须安装包验证。 |

## 自动验证

- 定向 vitest：10 文件 **159 / 159** 通过；日志 `/Users/apple/workspace/bug-batch-20260926/evidence/client-integration/targeted-vitest.log`。
- 实际 React + AntD Dropdown DOM 验证：菜单打开→spacer no-drag→pointerdown收起→恢复drag；再开→guest信号收起；菜单项收起；菜单打开中切英保持状态且文案变化；1 个完整交互用例通过。
- DOM 验证借本机 nuwax 的 jsdom 27.3.0，无新增源码依赖；临时脚本保存于上述 evidence 目录 `TrafficLightToolbar.dom-probe.test.tsx`，未入基座提交。
- main / renderer 构建通过；定向 ESLint 0 errors（3 条既有 unused warnings）。
- 基座 staged pin 守卫：12 中立文件、0 overlay 路径；提交后 worktree check:pin 均为 overlay 产物；overlay --check 零差异；diff --check 通过。

## 真实 Electron fixture（2026-09-26）

本机 macOS Electron 40.8.2，独立 home / userData、本地 guest（127.0.0.1:47926），使用生产 `registerNuwaxBridgeHandlers`、生产 `webviewPerfBridge` 与真实 Toolbar。fixture 将 navigator.platform 设为 Win32 展示自绘菜单；不改共享正在运行的 dev 进程，不连接业务账号。

- CUA 点击 guest English：壳五菜单、窗口按钮与语言状态变 en-us；guest 页面保持 `loaded once`。
- CUA 反切简体中文成功；guest 日语选择仅壳回退简体中文，SQLite 保存 ja-jp 镜像。
- CUA 宿主重载：恢复之前的 en-us，实际 SQLite 镜像持久化生效。
- 编辑菜单打开→点击原生拖拽 spacer（仅 fixture 加 AX 标注以精确定位）：退出动画后菜单消失，实际鼠标事件记录 `x=781,y=14,target=DIV,region=drag`（关闭后已恢复拖拽样式）。
- 菜单再次打开→点击真实 guest content：生产 guest 捕获与 IPC 收起；截图和最终 AX 确认消失。
- 动画离场期间 AX 会短暂仍列菜单；应等最终状态核对，不能把即时 AX 当失败。
- fixture 源与启动文件位于 `/Users/apple/workspace/bug-batch-20260926/evidence/client-integration/electron-fixture/`；受控 fixture 不是原报错包，也不是 Windows 真机。

本批未推送、发包、部署或修改禅道状态。
