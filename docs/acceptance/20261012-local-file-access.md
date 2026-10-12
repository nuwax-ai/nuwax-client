# 本机文件直访验收记录

日期：2026-10-12。开发已完成，真实业务账户、安装包与 Windows 验收尚未完成。

## 交付与隔离

- 托管 worktree：`/Users/apple/.codex/worktrees/local-file-access/nuwax-client`。
- 壳和前端分支均为 `codex/local-file-access`，前端独立提交 `0390740763be2d1b4cbedc93bae9b81a996df788`。
- 固定基线：壳 `c9294fbafb9c75a9399f2bd09339a30b7006815a`，基座 `484ff6b36e73c21c0a5dc1b01aeae9fb6d07c106`，前端 `649da70bf9becc71e0e3c5bfbdb2adf0156b634e`。
- 子模块在新 worktree 内独立检出；基座 pin、产物仓 pin `73a6040080efe413fab3398cc39ee013b6781cd8` 保持不变。新前端产物仅从新源码构建，使用 `npm run dev -- --frontend source` 或 `npm run pack -- --frontend source`。
- 原目录的截图、菜单与子模块工作未纳入此分支。未推送、合并或发布版本。

## 实现覆盖

列表/搜索使用主进程与配置端口的本机 file-server；文件字节由文件系统和受限 `nuwax-local` 协议提供。覆盖共享树、自动预览、提及/Git 定位、外部文件、OpenUI 与工具路径；支持系统打开/定位、保存与完整 ZIP。写操作沿用原接口。

协议授权绑定窗口、顶层文档和登录代次；HTML 独立沙盒，自动资源不沿路径或链接逃出根。关闭、完整导航、登出、换域和退出撤销授权并关闭流。已确认本机的上下文失效后直接报错。

## 质量门结果

| 检查 | 结果 |
| --- | --- |
| 商业 `npm run test:commercial` | 193 文件通过、1 文件跳过；2,505 测试通过、18 跳过 |
| 社区 `npm run base:test` | 独立 `.cache/verification/community` 副本；133 文件通过、1 跳过；1,611 测试通过、18 跳过 |
| 根脚本 `node --test scripts/*.test.mjs` | 273 测试通过 |
| 桥契约与特性边界脚本测试 | 23 测试通过；契约快照与事实源一致 |
| 独立 verifier 壳端相关回归 | 11 文件、166 测试通过 |
| 独立 verifier 前端相关回归 | 15 文件、182 测试通过 |
| 会话合同网 `npm run test:conversation` | 117 文件、1,206 测试通过 |
| 类型域 contracts / conversation / workspace | 各域 0 diagnostics；全仓其他域既有 288 diagnostics 未纳入此次门禁 |
| `npm run lint:arch` | 无新增违规；97 项既有违规由仓库基线忽略 |
| `npm run check:pin` | 基座脏文件全部为 overlay 同步产物，基座 SHA 未修改 |
| 商业壳 `npm run build` | 主进程、preload 和 renderer 生产构建通过；macOS arm64+x64 通知插件通过 |
| 前端 `npm run frontend:build` | 主应用与独立微应用源码生产构建通过；dist 标记 `039074076`，时间 `2026-10-12T12:15:35.121Z` |

全仓 TypeScript 检查存在基线错误；本次修改路径未检出新增诊断。前端正常提交经过 Husky 的 ESLint、Stylelint 与 Prettier 门禁，无跳过钩子。最终前端提交后独立复跑 182 项相关回归与 1,206 项会话测试通过，前端工作树干净。构建输出包含既有体积提示，构建正常退出。

## macOS 实际 Electron

Electron 40.8.2 / darwin arm64，隔离 profile，真实 feature 注册、preload、IPC、请求门和 protocol handler。metadata 使用本机 fixture，保存对话框返回 fixture 目标。

运行 `node scripts/acceptance/local-files-electron.mjs`，14 项通过，原始报告见 [20261012-local-file-access-electron.json](./20261012-local-file-access-electron.json)。验证内容包括：

- 列表/搜索不携带云端 cookie 或 Authorization；成功本机操作没有 `/api/computer/static/*` 请求。
- GET / HEAD / 单段 Range / 416 字节正确，110MiB 文件可仅读取十字节。
- 有效四秒 H.264 视频实际解码、播放、seek 至 2.5 秒并继续播放；canvas 像素证明实际画面已解码。
- 真实导出 IPC 处理 110MiB 源文件工作区，ZIP 包含隐藏项、空目录、硬链内容及保留为链接条目的软链；不包含输出或临时文件。
- HTML 相对 CSS/JS 和本地 fetch 可用，无宿主桥；业务/loopback 请求被拒绝。
- 跨窗口访问、完整文档重载和登录代次失效拒绝；同文档 query/hash/history 保留有效授权；显式释放撤销协议地址。

保存取消、复制/ZIP 中途取消保留旧目标并清理临时文件，由真实文件系统单测验证；没有把 stub 保存对话框宣称为真人安装包操作。

## 尚需实际环境验收

- Windows：配置的 `win-pc`（192.168.32.53）两次 SSH 超时，未执行。机器恢复后安装依赖与 ffmpeg，再重跑同一脚本；无创建软链权限时报告会明确跳过该 fixture 检查，应在有权限环境补验。
- 真实账户/实际已加载本机会话的离线行为、各业务入口人工回归，以及 macOS/Windows 安装包内的媒体拖动、保存对话框和完整 ZIP 尚需补验。
- 当前证据为源码、单测、构建与隔离实际 runtime；不构成签名安装包、线上业务或发布验收。

## 独立审查处置

OpenUI 失效后重新使用原代理 URL、能力恢复时降级到云端、旧节点正文/PDF 丢失本机引用三处已修复并新增回归；独立 verifier 当前无未解决 confirmed bug。验收 runner 还证明 handler 必须在首个 renderer 导航前安装，并已据此修正生命周期。
