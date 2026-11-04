# DS-Bot / DSH 接入验收记录

日期：2026-11-04。分支：`codex/dsh-dsbot-runtime`。基线：DS-Bot 0.2.7 / DSH 0.2.1-rc.5。

当前结论：源码实现已具备评审条件；尚未完成「DS-Bot 完整桌面功能可用」验收。真实平台 Anthropic 调用成功，OpenAI、账单、安装包及实体麦克风仍有待验项。不得将本记录解读为发布批准。

## 已获得的证据

| 范围 | 实测结果 | 证据层级 |
| --- | --- | --- |
| 商业版回归 | 302 文件通过，3752 用例通过，1 跳过 | 源码全量测试 |
| 根脚本 | 414 用例通过；宿主桥契约快照匹配；主进程 TypeScript 通过 | 源码工具链 |
| 运行时授权和生命周期 | 7 用例通过：主进程持有平台 Key、运行令牌撤销、重复启动、启动中取消、自有子进程退出、私有端口释放 | 独立运行包单测 |
| DSH + 原 DS-Bot | 真实会话、remember / message_bot 工具续轮、工作 Bot 收信、群组创建、定时任务执行、重启恢复与已完成任务不重复提交 | 真实运行时，确定性测试模型；不代表真实平台群聊验收 |
| 原生 Plugin Manager | 额外 Host + Client 插件安装、发现、启用、禁用、移除及核心 Bundle 保护通过 | 真实运行时 |
| Electron 窗口和浏览器 | 原 DS-Bot Client 加载及对话；两个 Bot Cookie 隔离；读页、Playwright CDP 自动化；旧文档 IPC 拒绝；停止时断开 CDP | 本机 macOS arm64，源码 Electron |
| Office | 随包 Python 创建并编辑 DOCX / PPTX / XLSX；三种文档转 PDF；文档渲染图片；公式重算得到 42 | 本机 macOS arm64，真实原生运行资源 |
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
- 当日个人账单汇总返回 `consumption: null`，明细总数为 0，尚不能将这些调用与平台扣费记录对账。平台账单验收未通过；客户端不自行重复扣费。

安全诊断日志：`/tmp/nuwax-dsh-live-evidence-20261104.log`。该日志仅含 HTTP 状态、模型 ID 和断言结果。可通过 `test/platform-runtime.mjs` 与 `test/platform-contract.mjs` 在已登录的测试通道复现。

## 尚待完成

1. 可用 OpenAI 平台通路的 SSE、工具续轮、推理、图片、取消与用量，以及平台账单对账；平台权限变更的即时生效。
2. 真实平台上的完整群聊、双向 Bot 协作、长上下文检查点与历史检索专项验收。现有确定性运行时测试只覆盖表中列出的行为。
3. 基于既有版本的 package-validation 安装包。提交 `69b9593e` 的[完整 CI 门禁及五平台资源检查已通过](https://github.com/nuwax-ai/nuwax-client/actions/runs/41812089460)。[第 1 轮安装包验证](https://github.com/nuwax-ai/nuwax-client/actions/runs/41812217969)发现子目录 `prepare:dsh` 相对路径多退一级，已修正并通过实际子目录入口验证；CI 也改为覆盖该入口。验证系列固定为 `dsh-dsbot-runtime-20261104`，最多 4 次启动，不创建新版本、Tag、Release 或更新指针。
4. macOS / Windows / Linux 安装包中的浏览器登录保持、下载、Office 和语音；真实麦克风、系统播报、拒绝授权及恢复。

本任务未修改或提交 `agent-platform`。平台侧缺口单独记录，不用本地模拟成功替代。

## 实现质量走查

- 功能内聚：运行状态、代次、子进程、模型 Broker 与私有端口由 `crates/dsh-runtime/controller.mjs` 统一清理；Electron 窗口及浏览器适配由 `desktop.mjs` 管理。
- 分层：静态 DesktopFeature 仅注入宿主能力并接入生命周期；平台 ticket 由 `src/main/services/featurePlatformHost.ts` 持有。第三方动态插件加载留在真实 DSH 中，设置页只消费管理契约。
- 可维护性：核心版本及依赖全锁定；上游适配文件附来源、哈希和修改记录；资源准备独立缓存，不改变辅助程序或采集器配方。回归覆盖权限、账号隔离、异步失效、启动失败清理和原生能力。

结论：可提交独立特性分支评审；须保留以上未验收项，当前不合入发布线。
