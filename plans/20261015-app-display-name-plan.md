# 第 9 条：客户端显示名称统一

目标：商业版面向用户的应用名称统一为「女娲Nuwax」，仅处理用户指定的第 9 条。文档链接当前需要登录，以用户明确给出的名称为准。

实施：
1. 本地入口、stable/beta CI 均注入 `client.config.mjs` 中既有的显示名。
2. 修正 HTML 标题、异常对话框、关于页应用名称与登录提示中的旧名称。
3. UA 使用既有 ASCII 产品标识；Linux 自启动保留原有注册项名称，避免重复项。安装包名、更新卸载程序名和数据目录继续使用既有技术标识。
4. 更新相关说明，运行脚本测试、商业测试和商业构建核对显示名。

验收：窗口/菜单/托盘/关于/设置/登录提示显示「女娲Nuwax」；stable/beta 与本地构建一致；不处理文档其他条目。

验证结果：相关脚本测试 50 项通过；`npm run test:commercial` 为 3054 项通过、18 项跳过；商业 renderer 构建通过，产物 HTML 标题与 JS 显示名已核对，esbuild 注入后的主进程显示名为「女娲Nuwax」。overlay 同步与 `git diff --check` 通过。

限制：完整构建被基座工作区已有的 Pi 引擎 WIP 阻塞（`acpClient.ts` 导入 `getPiAcpEntryPath` / `getPiAgentCliPath`，现有 `dependencies.ts` 未导出）。保留该无关改动；本次未生成、验收或发布新安装包。
