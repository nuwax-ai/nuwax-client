# 3.0.23 Beta.4 多平台代码检查与发布状态

## 结论与授权

用户最新要求发布正式 Beta，Windows 剩余实机验收由用户补齐，先保证多平台代码正确性；客户端 PR #66/#67 继续不合并。此前独立验证系列已经4/4并停止，本轮不增加验证包或换系列绕过上限。

代码走查未发现新增的阻塞性实现问题；新增 macOS、Windows、Linux 分域回归均通过。当前 CI 为7/8通过，前端在私有子模块拉取阶段失败，未执行其测试。**发布门禁尚未全部通过，未创建 v3.0.23-beta.4 tag/Release。** 用户确认 GitLab 仓库地址未变，正在检查现有 CI 凭据的只读访问权限，尚未确认恢复。

自查按 `.agents/skills/pre-commit-quality-review/SKILL.md` 执行；这是 writer 侧走查，不构成独立 PR 批准。全仓类型检查仍有既有债务，不能报告为全绿。

## 固定源码与证据边界

| 对象 | 冻结值 |
| --- | --- |
| 当前代码与测试提交 | `78e25cbada1f27544a34173af2fac17294b5d665`，分支 `codex/cua-3023-repairs` |
| 产品实现对应的私有验证基线 | `5ae7e6e6105ef674006c4f24c74d59d58f87630f` |
| 基座 pin | `d12d001a0d51e28513cba2b60e76413275cad161` |
| 前端源码 pin | `da71cb92e950ad32a53826682d8cb008aed2d97f` |
| 配对前端 dist pin | `7e6b0fe9cc4fb192ae45fcf168ec712146e52301` |

`5ae7e6e6..78e25cba` 仅变更 CI、平台测试断言和计划，没有改动产品实现。后续报告/发布说明提交仍需记录最终 tag SHA。前端 #201 已合入其目标开发分支；客户端 #66/#67 未合并。前端和产物工作树与 pin 一致，基座的423个脏文件为 overlay 同步结果，不能将其当作额外基座源码提交。

私有验证第4次消费配对 dist；正式 Beta 按原流程从前端源码 pin 构建一次共享产物，五平台消费相同前端产物。正式产物须单独核验来源与哈希，不能沿用私有包的字节级验收结论。

## PC Web 配套与提交就绪

2026-10-26重新读取远端确认：

| 仓库 | 提交与交付状态 |
| --- | --- |
| `nuwax` PC Web/内嵌前端 | [#201](https://github.com/nuwax-ai/nuwax/pull/201) 已合入 `feat-2026.9.30`；远端该分支 HEAD 为 `da71cb92e950ad32a53826682d8cb008aed2d97f`，与客户端源码 pin 一致 |
| `nuwax-dist` 前端产物 | 远端 `main` HEAD 为 `7e6b0fe9cc4fb192ae45fcf168ec712146e52301`，与客户端产物 pin 一致 |
| `nuwax-client` 客户端实现与测试 | [#66](https://github.com/nuwax-ai/nuwax-client/pull/66) 远端 HEAD 为 `78e25cbada1f27544a34173af2fac17294b5d665`；包含文件域提交 `066812df`、`8d9c05ed`、`99dfc362` 及本轮三平台测试。#66/#67 仍为 Draft、未合并 |

功能源码没有只留在本地的未提交改动；本地最新检查/发布说明文档已另行提交，待私有源码访问恢复后统一推送，避免立即重跑已知失败的 PR 门禁。`check:pin` 和 `host-bridge:check` 本次复核通过。

需要 PC Web 配套：它提供同一份页面 UI、会话上下文识别和本机/远程路由，客户端提供受信桥及真实文件系统操作。`nuwax/src/services/vncDesktop.ts:164` 先调用 `localFileService.ts:464` 的本机写入，已识别为本机的失败保留编辑内容，不回退成云端写入。普通浏览器和远程电脑继续沿用原远程路径。

本次覆盖文件列表/搜索、流式预览、系统打开/定位、保存/导出，以及新增、编辑、重命名、回收站删除。列表/搜索由宿主调用本机 loopback 服务；文件内容与写操作由宿主访问系统。上传、ZIP 导入、Git 操作仍沿用现有接口，不能将本次范围写成所有文件相关请求均已本地化。

本地化模式加载包内固定前端版本，须安装包含上述 pin 的新客户端；直连模式加载线上 PC Web，须部署含 #201 的前端。前端已合入不等于线上已部署，本次没有执行部署或完成线上版本核验。现有验收机直连页面的历史版本也不能用包内 pin 代替。

## 三问走查

以下实现路径相对仓库根目录，`overlay/crates/agent-electron-client/src/` 缩写为 `src/`。

| 问题 | 结论与实现证据 |
| --- | --- |
| 功能是否内聚 | CU 独立偏好及兼容投影集中于 `src/main/features/computer-use/preferences.ts:10`、`:22`，运行失败不覆盖用户偏好。窗口身份归一化在 `windowScope.ts:12`，token 协议适配在 `mcpGateway.ts:40`、`:551`；先保留宿主校验，再适配原生 wire 参数。本机写入、冲突检测及回收站分发集中于 `src/main/features/local-files/mutations.ts:127`、`:173`，runtime 写队列在 `local-files/index.ts:786`。 |
| 分层是否正确 | 前端 `nuwax/src/features/client-shell/localFileService.ts` 依据客户端桥和会话上下文分流；主进程校验授权范围后调用文件模块，注销/上下文释放撤销迟到操作。更新策略在 `src/main/services/commercialAutoUpdater.ts:10` 统一设置完整下载；CU 授权不借用文件授权。 |
| 是否便于维护 | 保留本机文件 API v1 只读/v2 可写兼容；缺失本机写能力不回退为云端写入。路径经平台原生 path/realpath 边界检查，同目录临时写后替换、创建时不覆盖已有文件；系统回收站由 Electron 适配器处理。CU 只合并完全一致的目标身份，冲突即拒绝；`src/renderer/features/computer-use/CuaControls.tsx:131` 起采用图标与 hover/focus 提示，保持暂停/停止/关闭开关的独立语义。 |

平台重点：Windows 使用命名管道，不把 Unix socket 的 inode/文件所有权断言搬到 Windows；路径断言使用平台 path；Windows 的 chmod 不被当成 POSIX 访问控制。Windows 密码控件识别覆盖 UIA 属性；Linux 不支持的多窗口能力继续保持原有限制，不扩大保存的授权范围。上述边界由分域回归覆盖，原生驱动、系统弹窗和真实 Agent 行为仍属实机验收。

## 本轮测试与修正

首轮 [CI 40201487159](https://github.com/nuwax-ai/nuwax-client/actions/runs/40201487159) 在 Windows 暴露7项失败，另外有3条 Unix socket listen 异常。原因是测试假设了 Unix 文件套接字、正斜杠路径、POSIX mode 和 chmod 读权限，并非已重现的产品实现失败。

提交 `78e25cba` 仅修正测试：3个 Unix socket 文件系统专属用例只在 Unix 宿主运行；通用路径用 path 拆分；正则转义覆盖 Windows 路径；POSIX mode 与 chmod 拒读断言限定到支持的宿主。没有跳过整个功能域，Windows 的实际命名管道、文件操作、撤销和协议回归继续执行。

复跑 [CI 40202132531](https://github.com/nuwax-ai/nuwax-client/actions/runs/40202132531)：

| 门禁 | 结果 |
| --- | --- |
| desktop CUA/local-files，macos-latest | 26文件，306项通过 |
| desktop CUA/local-files，ubuntu-latest | 26文件，306项通过 |
| desktop CUA/local-files，windows-latest | 26文件，303项通过，3项 Unix 专属跳过 |
| commercial gate | 通过 |
| community gate | 通过（隔离 CI checkout，不在本地商业工作树清 overlay） |
| terminal，Windows/Ubuntu | 两个 job 均通过 |
| frontend source gate | **阻塞**：Init pinned frontend 失败；后续测试未运行 |

本地 Mac 分域复跑306项通过；`check:pin`、host-bridge 契约检查、diff 检查通过，发布保护脚本34项通过。两次 release dry-run 在读取 GitHub 远端时遇到 TLS 连接错误，未完成，不能写成发布预检通过。

原始日志保存在本机私有目录 `/Users/apple/Documents/Codex/2026-10-25/beta4-release/logs/`，包含 Windows 首轮失败、三平台复跑摘要、前端阻塞和 release dry-run；不上传私人截图或凭据。

## 当前阻塞与继续条件

前端 `.gitmodules` 中两个地址保持原样：

- `https://git.yichamao.com/agent-platform/nuwax-im.git`，pin `50134c2517950b1d44fabeb69d2a8d51c38600cf`。
- `https://git.yichamao.com/agent-platform/nuwax-repo-web.git`，pin `c7035259b155d487071de9e2f346f70c74ba7a7b`。

CI 已传入现有访问凭据，但两个仓库均返回 repository not found。不能仅凭404认定令牌过期或仓库不存在；用户正在核查机器人权限。等待恢复确认期间不重跑相同失败，也不更换地址、降低门禁或提前创建 tag。

补充成功/失败对照（2026-10-26核查，时间为北京时间）：

- 正式 Beta.3 的 [共享前端 job](https://github.com/nuwax-ai/nuwax-client/actions/runs/40084568220/job/120844757092) 于10月24日18:07实际拉取两个 GitLab 子模块成功，不是仅复用打包缓存。
- [上一轮前端门禁](https://github.com/nuwax-ai/nuwax-client/actions/runs/40193125472/job/121168193142) 于10月25日20:27成功，前端已经是本次相同的 `da71cb92`，两个子模块 SHA 也与本次相同。
- [本次失败 job](https://github.com/nuwax-ai/nuwax-client/actions/runs/40202132531/job/121195337080) 于10月25日22:26在相同地址拉取时返回 repository not found，尚未进入编译。

相对 Beta.3，`ci.yml` 仅增加独立三平台 job；现有前端 job 的认证与拉取脚本没有变化。正式 Beta 共享前端的认证和递归拉取步骤也没有变化。可确认先前访问正常、本次异常，不能确认实际 secret 值是否曾被更换，也不能仅靠日志区分令牌、账号/项目权限或 GitLab 访问策略问题。此前将阻塞直接称为“拉取权限”过于确定，应称“GitLab 私有源码访问失败，根因待确认”。后来第4次独立验证消费现有 dist，不递归拉取这两个仓库，其出包成功不能作为当时 GitLab 访问仍正常的证据。

恢复后推送最终说明提交，补齐前端门禁与完整发布预检；确认 Beta.4 仍未被占用，再创建唯一正式 tag。随后分别核对五平台构建、Mac 签名/公证、来源清单、下载资产哈希和 Beta 镜像指针。Windows 按现有正式流程产物策略构建，交接与实机验收只使用 EXE。客户端 PR 不合并，Stable 指针不改动。

## 实包证据与 Windows 交接

第4次私有 Mac 包的完整更新与 ON→ON 已完成，当前源码实现与之相同；正常重开、原 Beta 通道及双 CU 偏好已核对，临时 feed/观察器已结束。最终断言在私有目录 `beta4-validation/m4/evidence/277-run4-mac-full-upgrade-assertions.json`。第3次的真实 Claude B 窗写入/回读/保存恰好一次通过，不能代替第4次或正式 Beta 的完整 Agent 回归。

第4次 Windows EXE 下载未完成，没有安装验收。原客户端已恢复正常运行；本机 UTM 的恢复证据在 `beta4-validation/win-local/evidence/048-original-client-restored-final-state.json`。它与 M4 上的 Windows 虚拟机是两个目标，不能混用截图与状态。

正式 EXE 交付后由用户补验并保留版本/来源 SHA、截图和日志：

1. 在目标机记录原安装版本与 Computer Use ON 状态，以 EXE 完成升级；正常重开后确认 UI、独立偏好与兼容记录仍为 ON，另验 OFF→OFF。
2. 使用可用 Agent（包括 Claude Code）执行真实窗口观察、写入、独立回读和保存；记录目标窗口身份，确认旁窗无变化、保存恰好一次。
3. 验证问询/拒绝、暂停/恢复/停止、关闭开关、图标 hover/focus 提示，以及敏感观察、黑名单、光标恢复和稳定性；遇到 userStopped/modeChanged 或未知会话立即停止输入留证。
4. 在本地化界面执行真实账户的文件预览/系统打开/新建/编辑/重命名/回收站删除与恢复；当前直连页面由线上部署决定，不能用桌面内置 pin 代替线上已交付结论。

已知未修：Windows ARM 环境的第三方 Nuwaxcode 1.3.13 初始化崩溃。此前已记录，本批次未改该引擎，可用 Claude Code 路径补验；Windows x64 EXE 在 UTM ARM 的结果也不等于原生 Windows ARM 全覆盖。
