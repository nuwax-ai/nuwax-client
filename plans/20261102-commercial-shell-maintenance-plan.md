# 商业客户端遗留清理与维护性重构

## 范围与约束

- 以当前 release/v3.1.0 工作树为基线，退役旧沙箱、旧 GUI MCP 和独立项目入口。
- 保留商业登录、设备服务、ACP/agent-kit、工具审批、MCP、CUA、截图录屏、Browser、本地文件及终端兼容能力。
- 保留 Electron sandbox/contextIsolation、来源授权、会话权限和用户自定义 MCP。历史配置只做最小、幂等的退役清理。
- 保留内部包边界、包名、产品兼容标识及许可证；不改前端双 pin，不纳入终端持久化等发布排除项，不发布新版本。
- 初始无关 WIP：renderer/browser.html、renderer/features/browser/toolbar.ts、release-notes/v3.1.0-beta.21.md；不覆盖这些文件。

## 执行顺序

1. 将 ACP 引擎识别与 OpenCode 配置从 sandbox 目录迁到引擎配置域，移除进程包装和替代 MCP；保留审批、模型配置、Git Bash、ripgrep、会话和普通 Terminal API。
2. 断开旧沙箱/GUI 的主进程、preload、renderer、服务生命周期和资源路径；删除独占实现及测试，保留并补测必要的历史配置迁移。
3. 删除废弃 crate、资源与准备/验证脚本，收敛打包及 CI 配置；移除重复的旧资源排除逻辑。
4. 删除失效 Makefile、旧信令配置、嵌套 hook 等独立项目残留；保留实际使用的 workspace/lock/构建配置和许可证，更新模块文档及单一指令入口。
5. 检查残留引用，执行定向测试、test:commercial、test:scripts、host-bridge:check、源码边界检查和主进程/renderer 构建。
6. 按 pre-commit-quality-review 三问审查整个工作区改动，记录验证结果及限制。

## 验收

- 正常开发、测试、构建链不再依赖旧 sandbox/GUI crate、资源或停用占位接口。
- 保留的引擎配置不再位于 sandbox 目录；工具审批、MCP 下发、Windows shell 和 ripgrep 行为通过现有测试。
- 旧设置不再注入 gui-agent；迁移不丢失用户自定义 MCP，不恢复旧产品数据。
- 商业与工具链门禁通过，构建成功；不把源码构建结果宣称为真实安装包或实机验收。

## 结果

已完成，改动保留在当前工作树；未创建提交、tag、Release 或安装包。其他任务的浏览器改动已在执行期间提交为 ae5ea5eb，本次未覆盖这些文件，也未改前端双 pin。

- 旧沙箱/GUI：删除独占 crate、运行时、preload/IPC、界面、准备/签名/验证脚本与专项测试；历史资料迁入 `nuwa-electron-shell/docs/_archive/retired-sandbox/`，删除生成矩阵。
- 维护边界：引擎识别与 OpenCode 配置归 `acp/config/`；原生/JavaScript 进程启动归 `acpProcess.ts`；平台适配不再依赖沙箱类型；服务展示清单由 `shared/serviceNames.ts` 提供，CUA 托管 MCP 标识归 `shared/managedMcp.ts`。
- 工程管理：移除旧 Makefile、信令配置、嵌套 hook/本地 IDE 配置及 npm lock；保留实际使用的 pnpm workspace/lock。运行时 i18n 依赖归 Electron crate；agent-kit 与 Electron 包明确标为 private，去掉重复 postinstall 构建和独立发布配置。
- 升级兼容：迁移幂等移除旧 gui-agent，保留 CUA、用户 MCP 与其余配置；设备注册的 sandboxId、guiMcpPort 等后端兼容字段保持原契约。

### 最终验证

- `npm run test:commercial`：302 个测试文件通过；3713 项通过、1 项跳过、0 失败。
- `npm run test:scripts`：408 项通过、0 失败。
- `npm run shell:exec -- -- npm --prefix crates/agent-electron-client run build`：商业身份主进程与 renderer 构建均成功，仍有既有的大 chunk 提示。
- `npm run host-bridge:check`、`check:boundaries`、`check:appdir`、`git diff --check`：通过。
- 内部 workspace `pnpm install --frozen-lockfile --lockfile-only --ignore-scripts`：通过，锁文件与 manifest 一致。
- 额外 `tsc --noEmit -p tsconfig.main.json`（清理阶段结果，现已在下方追加任务中修复）：当时有 13 项已有错误。以相同依赖对 HEAD 源码的一次性副本运行对照，基线 14 项、本次 13 项、无新增；消除的是旧 windowsMcpRunner 对 agent-gui-server 的缺失引用。剩余错误位于捕获/CUA 返回类型、Electron 事件类型、IM 契约与 DOM lib，未扩展修改这些功能。
- 回归覆盖：原生/JavaScript ACP 启动选择、Windows Git Bash、Terminal 输出/退出/会话归属、审批规则、用户 MCP 与 CUA 配置保留、迁移幂等、退役 HTTP 路由标准 404。
- 未制作安装包，未进行真实账号或跨平台安装验收，不将源码测试与构建结果当作实机结论。

### 三问自查

- 功能内聚：通过。引擎配置归 `acp/config/engineProfile.ts:7`、进程启动归 `acpProcess.ts:14`；退役配置仅由 `bootstrap/migrate.ts:255` 清理，不再依赖旧服务注册的副作用。
- 代码分层：通过。main 负责进程与配置迁移，preload 去掉退役 API；renderer 只消费桥与共享服务标识；Electron sandbox/contextIsolation、来源授权、工具审批和 SDK ripgrep 注入继续保留。
- 可维护性：通过。prepare/package manifest/CI 对齐当前资源，去掉各入口重复排除旧资源的补丁；内部 workspace 只登记现有 Electron crate，保留 agent-kit 的本地 file: 接入及许可证，CLAUDE.md 继续使用原有指向 AGENTS.md 的符号链接。

## TypeScript 存量错误收尾（追加授权）

- 先同步远程：当前分支快进至 `bcec1c36`，保留 Chrome DevTools MCP fork 更新和所有本地清理改动。
- 保持 strict/noEmit 检查，不加忽略指令或放宽检查。主进程配置补足实际使用的 renderer 路径与 DOM Iterable 声明。
- 内部 TrustedIpc 分别描述业务结果与拒绝结果，拒绝调用仍不执行 handler；IM 内部快照补齐已有勿扰计数，生成的宿主桥契约保持原样。
- 明确通知后端的统一接口与 Electron 字面量事件注册；DevTools 保留开发模式和不激活窗口约束。
- 完成后重新执行 TypeScript、商业测试、脚本测试、宿主桥/边界检查和商业身份主进程及 renderer 构建。

结果：已完成。

- `npm run typecheck`：严格检查通过，13 项错误清零；未添加 any、忽略指令或放宽 strict 检查。新增根命令及 crate `typecheck:main`，CI 同步执行。
- `npm run test:commercial`：302 个测试文件通过；3714 项通过、1 项跳过、0 失败。
- `npm run test:scripts`：408 项通过、0 失败；其中公共 IM 类型与生成宿主桥契约严格相等的检查通过。
- 商业身份 `npm run shell:exec -- -- npm --prefix crates/agent-electron-client run build`：main 与 renderer 构建成功。
- `host-bridge:check`、`check:boundaries`、`check:appdir` 与 `git diff --check`：通过。
- 为验证远程新代码，重新构建 agent-kit 并使用冻结 lock 刷新内部 workspace 的 file: 依赖；确认消费的是新的 Chrome DevTools MCP fork。
- IM 勿扰计数仅存在于 `main/services/imReceiver.ts:4` 的私有状态类型；公共 `IMUnreadSnapshot` 继续直接引用事实源。通知后端统一使用既有接口。TrustedIpc（`_kit/trustedIpc.ts:19`）分别描述业务与拒绝结果，运行期 sender 校验保持原实现，回归确认不受信请求不读取 handler 状态。
- DevTools 仅在开发开关下显式右侧停靠且不激活窗口；主窗口 show/hide/minimize/restore 使用字面量注册，保留各自 Dock 行为。
- 前端源码和产物 pin 未改变。用户已授权将全部清理及本次类型修复创建本地提交；本次不推送或出包，真实安装包验收仍属后续工作。
