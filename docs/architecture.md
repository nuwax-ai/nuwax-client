# 客户端工程边界

## 源码与构建输入

- `nuwax-client` 是客户端源码、产品配置、测试和发布的维护仓库。`nuwa-electron-shell/` 是本仓普通源码目录，包含 Electron 客户端与 agent-kit；壳代码和根工具链随同一提交固定。
- `nuwax/` 是前端源码子模块，`nuwax-dist/` 是前端产物子模块。stable 消费锁定的产物 pin；beta 从锁定源码 pin 构建一次共享前端，再供五平台使用。构建期间不追远端分支。
- 开发、打包、发布由根目录 `scripts/client/cli.mjs` 编排；配置集中于 `client.config.mjs`。壳目录无独立的上游同步、pin 更新、覆写层或发布线。
- 来源清单的 `source.client` 是本仓提交，`source.shell` 是该提交中壳目录的 Git tree 内容标识，`source.frontend` 是前端源码提交。目录 tree 不是另一仓库的 commit。

## 运行边界

- 主进程负责设备注册、登录生命周期、服务启停、域名切换与本地网关。renderer/webview 的宿主调用按来源授权；外部网页不得获得额外宿主权限，也不得维护另一套商业登录事实源。
- 后端签发的 `ticket` cookie 是登录事实源；`savedKey/configKey` 是设备注册结果。域名切换走 `configureServerHost`，不得复用旧域 cookie、代理或业务服务。
- 未登录仅运行页面需要的 loopback gateway；客户端不按端口结束未知进程。数据目录、工作目录、运行端口和更新通道按当前产品身份隔离。

商业版自管 TCP 监听由主进程分配：先复用上次成功端口，再从 24600–24999、20000–29999 顺序寻找可绑定的回环端口。运行时表覆盖 Computer/Admin、文件服务、终端网关、内部 ttyd 和页面网关；远程服务端口、开发服务器及无 TCP 的 MCP/CUA 传输保持各自边界。

注册前预留候选端口，服务实际监听并通过健康检查后，以最终端口代次核对注册结果，再启用隧道。会话或端口代次变化时，迟到注册不得提交。`step1_config` 的旧端口字段不再持久化；读取时为旧 renderer 投影运行时值，写回时剥离端口控制。自动分配记录仅保存在当前产品数据目录的 `nuwax.localPorts.v1`。

文件服务的回环绑定、真实监听错误与健康实例标识由产品源码补丁固化；开发和 CI 在一次性源码副本中应用补丁并记录摘要。开发者 `sources/` 与工具链源码缓存不接受补丁写入。

## 变更落点与门禁

- 客户端能力直接修改 `nuwa-electron-shell/`；构建和发布编排修改根 `scripts/`、`.github/`；前端业务界面修改 `nuwax/`，完成后更新前端源码/产物双 pin。
- `npm run test:commercial` 检查客户端，`npm run test:scripts` 检查工具链；源码导入、应用目录与特性边界按改动域验证，发布同时运行前端门禁。
- 宿主桥自包含类型事实源保存在前端仓，本仓使用生成快照；`host-bridge:check` 防止双端类型漂移。浏览器和旧宿主按可选能力消费，preload 满足完整契约；类型检查不改变来源授权、ticket 或 IPC 生命周期。
- 自动化通过、安装包签名通过和真实设备/账号验收分别记录。stable 只有在来源、资产、签名和安装验收通过后才显式同步；beta 按发布规范自动同步。

## 文档适用范围

当前开发入口以根 `AGENTS.md`、README、[npm 脚本](./npm-scripts.md)、[发布规范](./release-channels.md)和本文为准。带日期的设计、计划、验收及旧发布记录保留当时事实；其中旧基座和同步命令不适用于当前工作树。
