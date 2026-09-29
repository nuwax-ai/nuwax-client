# 模型切换检查与本轮修复

- 日期：2026-09-29。
- 检查范围：claude-code、codex-cli、nuwaxcode、自定义 ACP Agent；同引擎／跨引擎，空闲／运行中／压缩中。
- 本轮实施范围：修复附件中已复现的「同 claude-code 引擎、不同模型、旧任务仍运行」问题。其余发现先报告，不改队列、压缩展示、前端或各 SDK。
- 原共享工作树有其他 WIP；使用附加工作树 `/Users/apple/.codex/worktrees/claude-model-switch/nuwax-client`，基座起点 `c0717fc487f9ebcf53b421262e53aa65d7cf37de`。

## 1. 已有日志证据

03:34:25—03:37:21，五次 Qwen → DeepSeek 请求保持 `claude-code-acp-ts` 引擎、Anthropic 协议。外层检测到模型变化，却因活动任务复用旧 Qwen 引擎；内层继续向旧会话提交 model config RPC，全部得到 `Invalid value for config option model: deepseek-flash`。HTTP 入口在 chat 前已关闭旧 SSE。期间原压缩最终完成。

原截图中的 `Compacting failed: aborted` 另有四次记录，均在新 chat 发送 `session/cancel` 后 8—11 毫秒出现。本轮不实施普通消息队列或压缩取消展示。

## 2. 本轮行为

| 条件 | 处理 |
| --- | --- |
| 同内置 claude-code 引擎，明确要求另一模型，仍有活动任务 | 统一引擎入口返回现有 `5000` 业务失败，提示先等待当前任务结束或主动停止，再切模型重发 |
| 上述请求被拒绝 | 不进入 AcpEngine.chat，不下发 model RPC、cancel 或新 prompt，不关闭旧 SSE，不改引擎与会话配置 |
| 引擎已空闲 | 保留既有完整配置重建／恢复路径，再执行目标模型请求 |
| 同模型继续、其他引擎、自定义 Agent、无明确新模型 | 保持既有行为 |
| 用户主动停止 | 保持既有停止入口 |

入口覆盖 HTTP 和 IPC；活动计数覆盖该引擎全部会话，因为引擎按项目／工作区共用。排除自定义 Agent，避免 fallback 为 claude-code 时被误判。

这是主进程保护：调用端真正发新消息前可能已经主动断开旧进度流。本轮不实现调用端重连、恢复旧任务展示或发送队列，所以尚不能称为完整界面体验修复。

## 3. 最小改动位置

- 基座 `src/main/services/engines/unifiedAgent.ts`：同 Claude 引擎的不同模型忙状态门禁，放在返回旧引擎之前。
- 基座相关生命周期与 HTTP 派发测试：验证拒绝时旧任务／配置／SSE保留；空闲重建仍正确。
- 基座与商业 overlay 翻译资源：只增加一个明确的业务提示，四种语言及常量保持对齐。

## 4. 其他场景检查发现（本轮不改）

| 场景 | 源码检查结论 |
| --- | --- |
| 内置引擎，空闲，完整目标配置 | 外层检测变化后重建；恢复旧 session 失败时可能新建会话 |
| Codex／nuwaxcode，同引擎不同模型，运行中 | 同样复用旧引擎，继续模型 setter；不支持目标时可能吞掉 Invalid params，继续旧模型并取消旧轮 |
| 跨内置引擎，运行中 | 返回旧引擎；内层不应用新 command，可能在旧引擎执行新消息 |
| 自定义 Agent A → B／参数变化，空闲 | command／args／agent_id 未进入外层配置变化比较，可能继续旧 Agent |
| 新模型但仅提供 model_provider，仍有旧模型 env | 会话模型解析可能取旧 env；需区分实际启动配置和选中目标 |
| 模型 env 使用模板 | 外层展开，内层会话同步读取原始模板，可能把模板字面量当 modelId |
| Codex 仅提供 CODEX_MODEL | 外层识别，内层会话目标解析遗漏该 env |
| 已被较新请求覆盖 | 最新请求检查晚于模型同步，过期请求仍可能改模型 |
| 只切协议／地址／认证 | 与本轮模型门禁分开处理；协议未独立比较，地址／认证忙时仍复用旧连接 |
| PC 调用端 | 选择模型只更新本地状态；默认队列会保留目标模型并等待旧轮终态，属于调用端保护，不能保证所有入口 |
| 移动端忙时用键盘确认／语音发送 | 统一发送路径没有运行／停止状态门禁，会断旧流并发新 chat；选新模型时同样可能进入主进程问题路径 |
| PC 网络错误后的队列 | 本地错误会置 FAILED 并释放 active，队列随后可继续；后端旧轮是否仍运行需要联调，不能用本地失败判定后端空闲 |
| PC Agent 绑定模型保存 | 保存与下一 chat 可并发，快速切换回包也缺少统一排序；实际是否使用旧绑定模型取决于平台服务端执行顺序 |
| devcomputer 默认 auto_reload | ensureEngine 前会先 stop 旧引擎；这是既有开发调试语义，本轮门禁不保护这条主动 reload 路径 |
| 跨引擎恢复／自定义 session_id | 只按 ses_ 等格式猜测旧ID归属；UUID跨引擎可能错误尝试load，自定义Agent可能按fallback引擎规则被跳过恢复 |

### 4.1 主要证据位置

- [运行中复用旧引擎](/Users/apple/workspace/nuwax-client/nuwa-electron-shell/crates/agent-electron-client/src/main/services/engines/unifiedAgent.ts:849)；[模型同步在取消之前](/Users/apple/workspace/nuwax-client/nuwa-electron-shell/crates/agent-electron-client/src/main/services/engines/acp/acpEngine.ts:2038)。
- [配置比较遗漏自定义命令与参数](/Users/apple/workspace/nuwax-client/nuwa-electron-shell/crates/agent-electron-client/src/main/services/engines/configChangeDetector.ts:21)；[会话模型解析](/Users/apple/workspace/nuwax-client/nuwa-electron-shell/crates/agent-electron-client/src/main/services/engines/acp/acpSessionModelSync.ts:64)。
- [模型 RPC 的 Invalid params 被忽略](/Users/apple/workspace/nuwax-client/nuwa-electron-shell/crates/agent-electron-client/src/main/services/engines/acp/acpEngine.ts:317)；[旧 SSE 关闭顺序](/Users/apple/workspace/nuwax-client/nuwa-electron-shell/crates/agent-electron-client/src/main/services/computer/router.ts:618)。
- [PC 队列冻结目标模型](/Users/apple/workspace/nuwax/src/components/business-component/MessageQueue/useChatMessageQueue.ts:253)；[PC 本地错误放行队列](/Users/apple/workspace/nuwax/src/models/conversationInfo.ts:1951)。
- [移动端键盘发送入口](/Users/apple/workspace/nuwax-mobile/subpackages/components/chat-input-phone/chat-input-phone.uvue:121)；[缺少忙状态门禁的发送函数](/Users/apple/workspace/nuwax-mobile/subpackages/components/chat-input-phone/chat-input-phone.uvue:2034)；[语音入口](/Users/apple/workspace/nuwax-mobile/subpackages/components/chat-input-phone/chat-input-phone.uvue:2132)。

附件只证实 Claude 的实际失败；其余需分别说明静态代码证据、纯函数复现、SDK能力和真实运行验证的区别。

## 5. 验证与交付

1. 回归附件场景：Qwen 运行／压缩中要求 DeepSeek，同 engine、不同 key；明确拒绝且无任何旧任务副作用。
2. 活动会话在共享引擎中也保护；同模型、其他内置引擎、自定义 Agent 不受本轮门禁影响。
3. 空闲后重试目标模型，沿用现有完整配置重建路径；初始化失败不假报成功。
4. HTTP busy失败不关旧 SSE、不调用 chat、不更新 session registry／首 token 上下文；IPC 使用现有 catch 返回失败。
5. 定向测试；在隔离副本跑社区／商业测试；构建、纯净守卫、overlay差异分别报告。
6. 基座变更未合入 main 前不更新商业 gitlink；源码验证不等同于个人电脑、移动端或真实安装包验收。

## 6. 本次实际验证

- 新增 13 个回归，相关两文件 61／61 通过：跨会话忙状态、env 模型、等价模型、无明确模型、MCP、其他引擎／自定义排除、空闲重建、HTTP 旧 SSE 保留。
- 独立 verifier 判定 PASS：重新运行两文件 61／61 通过，两层 diff 检查通过；验证前后源码与测试 SHA256 未变。
- ACP 与配置解析等其他定向测试 93／93 通过。
- 社区全套：126 个文件、1519 个用例通过，18 个跳过。
- 商业全套：158 个文件、1928 个用例通过，18 个跳过。
- 上述两次全套收集的是原有测试版本；新增 13 个回归另行执行通过。
- 中立基座、商业 overlay 注入后的 `build:main` 生产构建均成功；商业模式 `overlay:check` 确认 104 个文件一致。
- 源码 ESLint 为 0 错误，保留本文件已有的 `currentEngineType` 未使用警告；两层 `git diff --check` 通过。
- 最终隔离副本已还原中立基座，保留本轮源码、测试和新翻译；商业翻译源在外层 overlay。原共享源码工作树未修改。
- 本次是本地未提交修复，尚未创建 PR、更新基座 pin 或发版；提交／更新 pin 的纯净守卫需按基座 PR 流程执行。未做真实个人电脑、平台转发／移动端或安装包验收。
