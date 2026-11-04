# DS-Bot / DSH 接入验收记录

日期：2026-11-04。分支：`codex/dsh-dsbot-runtime`。基线：DS-Bot 0.2.7 / DSH 0.2.1-rc.5。

当前结论：源码实现已具备评审条件；尚未完成「DS-Bot 完整桌面功能可用」验收。真实平台 Anthropic 调用、团队协作、检查点及账单用量记录成功，OpenAI、付费扣费、安装包及实体麦克风仍有待验项。不得将本记录解读为发布批准。

## macOS arm64 专项复核

按用户最新要求，当前人工验收先集中于 macOS arm64。

- 第 4 轮 [macOS arm64 安装包任务](https://github.com/nuwax-ai/nuwax-client/actions/runs/41821640915/job/126546077317)成功，源码为 `9335bed957c2aa23dad52ae4d2e76918e510a8c7`，沿用 `v3.1.0-beta.24`。下载后 ZIP / DMG 的 SHA-256 均与 `validation-context.json` 一致；本机 `codesign --verify --deep --strict` 及 `spctl --assess` 通过，后者确认为 `Notarized Developer ID`。
- 使用该包的 Controller、DSH、DS-Bot 及 Node 24.14.0，真实平台 Anthropic 两次 HTTP 200，工具执行、结果续轮、最终回复与持久化历史均通过。验收脚本需使用资源的真实路径；初次使用 `/tmp` 别名导致入口未执行的超时已排除，不能将该次脚本错误算作平台调用失败。
- **该包的 Office 验收未通过**：原生转换程序在 hardened runtime 下发生 SIGTRAP / abort。对同一引擎做独立对照：不授予可执行内存权限可复现崩溃；仅增加 `com.apple.security.cs.allow-unsigned-executable-memory` 后，DOCX / PPTX / XLSX 创建、编辑、转换、渲染及公式重算 42 均通过。
- 源码已给 `libreoffice-kit` 单独配置上述最小权限，未给它增加 JIT 或关闭动态库校验。macOS Office 回归现使用生产权限配置签名真实引擎后执行文档操作；本机 arm64 全部通过，结束后恢复测试依赖原始字节。签名相关定向单测 6 / 6 通过。
- Office 修复尚未进入新的签名、公证安装包；第 4 轮产物不能据此追认为修复后的包。固定系列已用满 4 次启动，不自动再出包。完整 UI、实体麦克风与系统播报仍待验收；其他平台已有构建结果不替代这些专项结论。
- 收费 Anthropic 模型 `198` 的最小调用也返回 HTTP 403，正文为“您的积分已用完，请先增购积分”。这不影响已测通路可用的结论，但正额扣费仍未通过。所有临时测试 Key 均在 finally 删除。

本机安全证据：`/tmp/nuwax-dsh-packaged-platform-20261104-realpath.log`、`/tmp/nuwax-dsh-packaged-office-20261104.log`、`/tmp/nuwax-dsh-office-hardened-control-20261104.log`、`/tmp/nuwax-dsh-office-hardened-fixed-20261104.log`、`/tmp/nuwax-dsh-office-hardened-regression-20261104.log`。原始 CI 包在隔离临时目录中；模型调用和 Office 操作后原包资源签名仍有效，诊断副本不作为安装包验收证据。

## 已获得的证据

| 范围 | 实测结果 | 证据层级 |
| --- | --- | --- |
| 商业版回归 | 302 文件通过，3752 用例通过，1 跳过 | 源码全量测试 |
| 根脚本 | 最后一次全量 420 用例通过；宿主桥契约快照匹配；主进程 TypeScript 通过 | 源码工具链 |
| 运行时授权和生命周期 | 7 用例通过：主进程持有平台 Key、运行令牌撤销、重复启动、启动中取消、自有子进程退出、私有端口释放 | 独立运行包单测 |
| DSH + 原 DS-Bot | 真实会话、remember / message_bot 工具续轮、工作 Bot 收信、群组创建、定时任务执行、重启恢复与已完成任务不重复提交 | 真实运行时，确定性测试模型；不代表真实平台群聊验收 |
| 平台团队协作 | 主 Bot 派工并收回结果、两个 Bot 群聊、remember 写入、定时任务、重启恢复、已完成任务不重复提交均通过 | 真实 DSH / 原 DS-Bot / 平台 Anthropic 模型 |
| 平台检查点和检索 | 测试窗口缩小到 45,056 Token 后生成 1 个原生检查点；read_own_chat 查回旧事实，原始工具调用与结果落盘 | 真实平台模型；不声称测满模型的最大窗口 |
| 原生 Plugin Manager | 额外 Host + Client 插件安装、发现、启用、禁用、移除及核心 Bundle 保护通过 | 真实运行时 |
| Electron 窗口和浏览器 | 原 DS-Bot Client 加载及对话；两个 Bot Cookie 隔离；读页、Playwright CDP 自动化；旧文档 IPC 拒绝；停止时断开 CDP | 本机 macOS arm64，源码 Electron |
| Office | 随包 Python 创建并编辑 DOCX / PPTX / XLSX；三种文档转 PDF；文档渲染图片；公式重算得到 42 | 本机 macOS arm64，真实原生运行资源 |
| 应用资源不可变 | 复现 Python 导入写缓存破坏 macOS 资源签名；设置子进程禁写字节码后，导入成功且签名仍有效 | 本机真实 codesign / 随包 Python；CI 两种 Mac 架构复用此检查 |
| 语音 | 固定权重下载、哈希验证、取消和重试；本地 SenseVoice 转写系统生成 WAV，得到 “This is a voice integration test.” | 本机原生推理；不包含实体麦克风 |
| 资源与许可证 | macOS arm64 / x64、Windows x64、Linux x64 / arm64 的运行时、语音原生库和 Office 准入及真实文档处理均通过；许可证与来源记录保留 | 五平台真实 CI runner；不替代安装包 |
| 开发工具链配方 | `verify:tooling` 通过，证据目录 `/tmp/nuwax-dsh-tooling-20261104` | source-tooling，不替代安装包 |

## 测试平台真实模型联调

使用已授权的测试账号与 `testagent.xspaceagi.com` 的租户代理，临时创建限定模型的专用 Key。联调脚本在 finally 删除临时 Key；凭据未写入仓库、报告或子进程环境。

2026-11-04 最新复测：

- Anthropic 模型 `100000121`：真实 DSH / DS-Bot 经主进程 Broker 调用平台，两轮均返回 HTTP 200。原生 `list_bots` 工具执行、工具结果回传及最终 `DSH_PLATFORM_OK` 回复通过。停止后读取持久化 JSONL，验证到 1 个会话中的工具调用 → 工具结果 → 助手回复顺序。
- Anthropic 原始协议：SSE、`tool_use` 与工具结果续轮均通过。
- 新建 Key 未授权模型：返回 HTTP 403，权限拒绝通过。
- OpenAI 模型 `100000056`：返回 HTTP 403，正文明确为“您的积分已用完，请先增购积分”。其他候选通路也出现过上游配置、租户权限或额度拒绝；这些结果不能推导为整个测试账号不可用，Anthropic 成功已证明账号存在可用通路。
- 已使用 Key 移除 Anthropic 模型权限后立即重试：仍返回 HTTP 200，平台侧即时撤权未通过。客户端自行变更授权会停止原运行实例；运行令牌在登出、换域、停止时同步撤销。平台侧权限传播行为仍需后端负责人核查。
- 用正确的 `YYYYMMDD` 日期复测后，用量已进入平台账单：再运行一次真实 DSH 工具闭环，模型调用数从 29 增至 31，输入 Token 从 46,519 增至 63,544，输出从 774 增至 805，缓存输入从 162,816 增至 179,712。费用和积分记账均为 0；这证明用量入账，不能代替付费扣费验收。早期错误日期查询的空结果已从故障结论中排除。客户端不自行重复扣费。

安全诊断日志：`/tmp/nuwax-dsh-live-evidence-20261104.log`。该日志仅含 HTTP 状态、模型 ID 和断言结果。可通过 `test/platform-runtime.mjs` 与 `test/platform-contract.mjs` 在已登录的测试通道复现。

真实团队、检查点与用量证据分别位于 `/tmp/nuwax-dsh-team-evidence-20261104.log`、`/tmp/nuwax-dsh-context-evidence-20261104.log`、`/tmp/nuwax-dsh-billing-evidence-20261104.log`，均不包含凭据或个人对话。

## 尚待完成

1. 可用 OpenAI 平台通路的 SSE、工具续轮、推理、图片、取消与用量，以及付费模型扣费；平台权限变更的即时生效。
2. 真实平台团队、检查点与检索已通过上表列出的场景，长期稳定性及安装包中的完整 UI 交互仍需验收。
3. 基于既有版本的 package-validation 安装包。提交 `ef9bdc47` 的[完整 CI 门禁及五平台资源检查已通过](https://github.com/nuwax-ai/nuwax-client/actions/runs/41812942705)。[第 1 轮安装包验证](https://github.com/nuwax-ai/nuwax-client/actions/runs/41812217969)发现子目录 `prepare:dsh` 相对路径多退一级，已修正并通过实际子目录入口验证；CI 也改为覆盖该入口。[第 2 轮](https://github.com/nuwax-ai/nuwax-client/actions/runs/41813161971)的 Windows 构建已完成 DSH 准备，随后在原采集器下载 `ffmpeg.org` 时连续连接失败。传输层增加 MacPorts 镜像回退，实下载 SHA-256 与原锁定值 `7138d28c…3178a3` 一致；未改源码版本、采集配方或缓存键，坏哈希仍拒绝。验证系列固定为 `dsh-dsbot-runtime-20261104`，最多 4 次启动，不创建新版本、Tag、Release 或更新指针。
4. macOS / Windows / Linux 安装包中的浏览器登录保持、下载、Office 和语音；真实麦克风、系统播报、拒绝授权及恢复。

第 3 轮验证（run `41815551392`，源码 `7389b9b8`）的 Linux x64 / arm64 安装包已成功。macOS arm64 在原有 osx-sign 1.3.1 的无界并发文件探测中触发 EMFILE；DSH 原生文件已先完成签名。修复为限制探测并发、使用已解析的同一签名身份，并沿用原签名器及其重试和严格校验；真实 osx-sign 在文件句柄上限 64、2000 文件下已通过回归。此修复与 Python 资源不可变修复合入最后第 4 轮；达到四次上限后不再自动出包。

本任务未修改或提交 `agent-platform`。平台侧缺口单独记录，不用本地模拟成功替代。

## 实现质量走查

- 功能内聚：运行状态、代次、子进程、模型 Broker 与私有端口由 `crates/dsh-runtime/controller.mjs:62,144` 统一失效和清理；Electron 窗口及浏览器适配由 `desktop.mjs` 管理。
- 分层：静态 DesktopFeature 仅注入宿主能力并接入生命周期；平台 ticket 由 `src/main/services/featurePlatformHost.ts:12,25` 持有。第三方动态插件加载留在真实 DSH 中，设置页只消费管理契约。
- 可维护性：核心版本和依赖全锁定（`scripts/client/dsh-resources.mjs:7,29`），来源和修改记录保留；资源准备独立缓存，不改变辅助程序或采集器配方。Mac 签名限流集中在 `scripts/build/dsh-mac-sign.cjs:8,32`，沿用默认签名器；Python 签名保护在 `controller.mjs:99`，均有真实行为回归。
- Office 权限限定在 `dsh-sign-resources.cjs` 的原生程序角色选择中，由独立 `entitlements.office.plist` 声明；真实 hardened runtime 文档回归消费同一生产配置，避免只验证未签名资源。此变更不修改辅助程序、采集器或未签名资源缓存配方。

结论：可提交独立特性分支评审；须保留以上未验收项，当前不合入发布线。
