# 本机文件直访：验收问题修复记录

日期：2026-10-13。本轮审查确认的 5 个问题已修复，源码门禁与 macOS 隔离 Electron 验证通过。Windows 真机、真实账户及签名安装包验收仍未完成。

## 分支、提交与隔离

- 壳及前端均在 `/Users/apple/.codex/worktrees/local-file-access/nuwax-client` 的 `codex/local-file-access` 分支。
- 失败测试提交先于修复：壳 `968ef62`，前端 `6b29e2ced5`；最初主进程 3 个行为测试失败，前端搜索错误、Windows 裸盘符和符号链接预览均复现失败。
- 前端修复提交：`d1992b353290af378f1b4e253fd26337dacfe3a2`。壳修复与本记录同一提交，包含该前端 gitlink。
- 基座保持 `484ff6b36e73c21c0a5dc1b01aeae9fb6d07c106`，产物仓保持 `73a6040080efe413fab3398cc39ee013b6781cd8`；原工作目录未纳入本轮操作。
- 全部本地提交，未推送、合并或发布版本。运行此分支继续使用源码前端：`npm run dev -- --frontend source`。

## 问题及处置证据

| 问题 | 修复 | 验证 |
| --- | --- | --- |
| HTML 文档变化后丢失预览来源 | 按 WebContents + frameTreeNodeId 保留来源；唯一请求门和凭据过滤共用来源，导航前拒绝跨授权文档；释放后保留限制至顶层文档替换/窗口销毁 | 单测覆盖文档及进程变化、data/blob 导航、重定向、跨窗口、撤销与清理；实际 Electron 使用生产 sandbox 配置，拒绝跳到无害 data 文档，正常相对 CSS/JS/fetch 仍通过 |
| ZIP 保存目录经过链接后未排除输出和临时文件 | 解析工作区和目标父目录的真实路径；保留目标 basename，不沿最终目标链接覆盖其指向文件 | 真实文件系统回归；实际 Electron 从目录别名导出 110MiB 工作区，输出及临时文件均未进入 ZIP |
| 本机搜索失败显示缓存或无结果 | LocalFileAccessError 显示错误及重试；上下文变化清空结果并作废在途请求；旧服务通用错误保留既有缓存回退 | 拒连、权限、过期三类错误、重试、同会话换电脑后的迟到响应与旧服务回退均通过 |
| Windows 根目录工具路径变成 `C:` | 工具路径拆分保留根分隔符；外部预览兼容裸盘符，统一实际文件引用和兼容 URL 的目录 | `C:\`、`C:/`、裸 `C:`、普通 Windows 目录、UNC、POSIX、工作区相对路径通过 |
| 本机链接文件被通用预览禁用 | 明确本机引用允许 Markdown、HTML、OpenUI、刷新及代码查看；代码视图只读，远端链接保留原策略 | 组件回归通过；实际 Electron 显式读取链接成功，而同一链接作为自动相对资源越出授权根时返回 403 |

## 本轮质量门

| 检查 | 结果 |
| --- | --- |
| `npm run test:commercial` | 193 文件通过、1 跳过；2,509 测试通过、18 跳过 |
| `npm run base:test`，仅在 `.cache/verification/community` 隔离副本运行 | 133 文件通过、1 跳过；1,611 测试通过、18 跳过 |
| 前端文件访问、搜索与预览相关回归（最终提交） | 18 文件、173 测试通过 |
| `npm run test:conversation` | 117 文件、1,206 测试通过 |
| 主进程 local-files 与凭据过滤最终回归 | 4 文件、32 测试通过 |
| `npm run test:scripts` | 273 测试通过 |
| 桥契约及特性边界脚本测试 | 23 测试通过 |
| contracts / conversation / workspace 类型域 | 各域 0 diagnostics；域外保持既有 288 diagnostics |
| 架构检查 | 无新增违规；97 项既有违规由基线忽略 |
| 桥契约、特性边界、overlay、check:pin、diff --check | 全部通过；176 个基座脏文件均为 overlay 托管同步产物 |
| 壳 `npm run build` | main、preload、renderer 构建通过 |
| `npm run frontend:build` | 前端及微应用源码生产构建通过；dist 标记 `d1992b353`，构建时间 `2026-10-13T02:48:21.226Z` |

全仓 TypeScript 本身仍有既有诊断，不宣称全仓零错误；本轮修复消除了新增测试的类型问题。前端提交正常经过 Husky / ESLint / Prettier，没有跳过钩子。构建保留既有依赖数据和包体积提示，退出码为 0。

## 实际 Electron 范围

`node scripts/acceptance/local-files-electron.mjs`：Electron 40.8.2、macOS arm64、隔离 profile，16 项通过。原始报告：[20261013-local-file-access-fixes-electron.json](./20261013-local-file-access-fixes-electron.json)。

采用生产 `allow-scripts allow-same-origin` 沙盒、真实注册/IPC/协议/请求门，metadata 与保存目标由 fixture 提供。覆盖相对 CSS/JS、无宿主桥、导航限制、GET/HEAD/Range/416、实际 H.264 解码及 seek、110MiB ZIP、隐藏项/空目录/硬链/链接、输出排除、跨窗口及授权撤销。成功操作没有 `/api/computer/static/*` 请求。

Windows 主机此前连接超时，本轮没有取得新的 Windows 实机证据；不能用平台无关路径测试代替 Windows Electron 验收。真实账户已加载本机会话的离线操作、真实保存对话框、签名安装包和完整业务入口人工验收仍待实际环境补齐。
