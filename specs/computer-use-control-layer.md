# 规格：computer-use-control-layer

- 对应 intent：`plans/20261014-computer-use-control-layer-intent.md`
- 状态：技术评审通过（2026-10-14，负责人确认 R1、R4）
- 实证来源：本仓打包的 Nuwax Computer Use（cua-driver **0.28.2**）。用私有守护进程只读拉取 `tools/list`，并对不存在的目标发起调用、采样真实的报错回复，没有执行任何真实输入。脚本见附录 A。

## 需求基线

继承 intent 的问题和预期结果。拷问后做以下增量修正：

| # | 修正 | 理由 |
|---|---|---|
| R1 | **推迟"按资源加锁、多会话并发"**（intent 预期结果第 3 条）。本期保持"同一时刻只有一个会话持有 Computer Use"。 | 运行状态 `CuaRuntime`、控制条、暂停语义都是单任务模型；暂停时会停掉整个守护进程（`computerUse.ts:1032`）。改成多任务并发，要重做状态、界面和暂停语义，代价远大于收益。同一会话内，浏览器工具和桌面工具本来就不会互相阻塞，只有多会话并发时才受影响，这是少见场景。 |
| R2 | **新增 P0 修复：浏览器类工具的"拒绝"被当成成功。** | 实测：`get_browser_state`、`browser_click`、`browser_navigate` 被拒绝时，**不设置 `isError`**，只在 `structuredContent` 里写 `status:"refused"`、`effect:"refused"` 或 `refusal`。网关只看 `isError`（`mcpGateway.ts:174`），所以把拒绝记成成功；一次被拒的观察还会把"需要观察"清零，放行后续写操作（`taskController.ts:112`）。 |
| R3 | **越权调用不再一次就停。** 网关拒绝的越权调用（不在白名单、超出窗口范围）不会产生任何副作用，按"拒绝"交还模型并计数；同一任务累计 3 次才停止。 | intent 写的是"越权直接停止"。但模型误用一次工具就终止整个任务太重，而且这类调用在执行前就被拦下，没有安全后果。 |
| R4 | **接管用户自己的浏览器只能经由"限定窗口"。** 整个桌面模式下，网关拒绝 `browser_prepare` 的 `strategy.kind=existing_profile`；限定窗口模式下，只允许接管用户选中的那个浏览器窗口。（默认采用，待确认） | 工具说明写明 unrestricted 模式下的接管只需"启动时的风险接受"。我们的启动参数是 `--permission-mode unrestricted --dangerously-bypass-approvals`（`computerUse.ts:424`），**很可能**意味着 Agent 不经任何审批就能接管用户已登录的浏览器（需实测，见测试计划 T7）。而用户在界面上选中某个浏览器窗口，本身就是对这个窗口的明确授权。这样也回答了 intent 的开放问题 1。 |
| R5 | 记录一项事实，供后续设计并发时参考：cua 默认在**后台投递**输入（AX 动作，或向指定 pid 投递 CGEvent），不移动用户的鼠标、不抢焦点。真正会占用桌面的，只有 `delivery_mode:"foreground"`、`scope:"desktop"` 或显示器坐标、`move_cursor`、`drag`、剪贴板等。 | 本期不实现，只写进文档。 |
| R6 | **R4 的前提已实测成立**（验收文档第二节）：`existing_profile` 接管不经宿主审批即成功。另一项实测：在常见的 Mac 上（Chrome 拖拽安装、属主是当前用户），cua **拒绝另开隔离浏览器**。因此按 R4 执行后，整个桌面模式下的浏览器通道在多数 Mac 上实际不可用，**浏览器通道的主路径是限定窗口模式**。这一点要写进给模型的指引（第六节）和设置页文案。 | 2026-10-14 实测 |

intent 开放问题的处理：

- 问题 1（用哪个浏览器）：按 R4 处理。
- 问题 2（基准任务集）：本规格先定义初版任务集（见"基准任务集"），本期不设硬性及格线，以改造前后对比作为验收依据。
- 问题 3（"无进展"后的恢复）：不限次数，每次都由用户决定。

## 方案设计

### 架构落点

全部改动都在商业 overlay 里，不改社区基座，也不改 Nuwax Computer Use 程序本身：

| 文件（`nuwa-electron-shell/crates/agent-electron-client/src/…`） | 改动 |
|---|---|
| `main/services/cua/cuaOutcome.ts`（新增） | 纯函数：把一次工具回复分成 `ok`、`refused`、`uncertain` 三类，并提取观察目标和写操作目标 |
| `main/services/cua/taskController.ts` | 状态机：结果分级、按目标的观察额度、"无进展"判定、越权计数；`finish` 改为接收结果分类，不再只收一个布尔值 |
| `main/services/cua/mcpGateway.ts` | 用 `cuaOutcome` 给回复分类；只对 `uncertain` 和停止类原因调用 `onFailure`；在 `initialize` 回复里注入 `instructions`；在 `tools/list` 里给关键工具的说明加上选用指引；记录窗口模式下的浏览器绑定 |
| `main/services/cua/windowScope.ts` | 窗口模式下开放浏览器工具，并约束到该窗口；生成 helper 策略文件时同步 |
| `main/services/cua/cuaGuidance.ts`（新增） | 给模型的说明文字（英文），集中维护 |
| `main/services/cua/computerUse.ts` | 恢复规则改为 `noProgress` 可恢复；`browser_prepare` 的接管检查；清理白名单里 0.28.2 已不存在的 `debug_window_info` |
| `shared/types/cuaRuntime.ts` | `CuaStep.outcome` 新增 `"refused"`；`CuaRuntime` 新增 `stats` |
| `shared/cuaPresentation.ts`、四个语言文件 | 新增 `noProgress`、`violationLimit`、`uncertainResult` 三个原因的文案；`repeatedAction` 保留，用于兼容旧状态 |
| `renderer/components/CuaControls.tsx`、`main/services/cua/controlWindow.ts` | 操作记录里用不同样式显示"被拒绝"的步骤；不新增控件 |

没有新增依赖，也不改变网关、会话凭据、helper 三者之间的单向调用关系。

### 一、结果分级（`cuaOutcome.classify`）

输入：工具名、该工具是否只读（沿用 `READS` 集合）、MCP 回复（或超时、断线事件）。

| 分类 | 判定规则（按顺序） | 处理 |
|---|---|---|
| `refused`（确定没有副作用） | ① `structuredContent.status === "refused"`，或 `effect === "refused"`，或存在 `refusal` 对象；② 只读工具出现 `isError`；③ `isError` 且 `code === "tool_invocation_failed"`（参数校验失败，实测样例："Missing required integer field: pid"）；④ 网关自己拦下的调用（`observationRequired`、`scopeViolation`、`toolNotAllowed`、`desktopBusy`） | 原样交还模型，并附一句提示："重新观察后再决定，不要盲目重试"。不暂停；计入步数预算和"无进展"统计；**不算观察成功**。④里的越权类计入越权计数 |
| `ok` | 没有 `isError`，也没有任何拒绝标记 | 同现状。只有 `ok` 的观察才刷新观察额度 |
| `uncertain`（结果不确定） | 写操作出现 `isError`，但不符合上面任何一条拒绝规则；工具超时；连接断开；helper 退出 | 同现状：暂停任务、停止守护进程、不自动重试；恢复后必须先观察 |

判定只读取 `status`、`effect`、`refusal.code`、`code` 这几个字段，不保存回复内容，与现有"不记录参数和内容"的约束一致。

### 二、按目标的观察额度

目标标识（只存在于内存，不进记录）：

- 窗口：`w:<window_id>`（macOS 上 window_id 全局唯一）
- 应用：`p:<pid>`（只带 pid、不带 window_id 的写操作）
- 浏览器标签页：`b:<target_id>/<tab_id>`
- 整个桌面：`desktop`

| 观察工具（结果为 `ok`） | 刷新的目标 |
|---|---|
| `get_window_state`、`verify_state`、`zoom` | `w:<window_id>`，同时刷新 `p:<pid>`（如果有 pid） |
| `get_browser_state`，传 target_id 和 tab_id | `b:<target_id>/<tab_id>` |
| `get_browser_state`，传 pid 和 window_id（绑定） | `w:<window_id>`，以及回复中返回的各个 `b:` 目标 |
| `get_desktop_state` | `desktop`，并视同覆盖所有 `w:` 和 `p:` 目标；**不覆盖** `b:`，因为浏览器的元素引用必须来自浏览器快照 |
| `get_accessibility_tree`、`list_windows`、`list_apps` | **不再算观察**（只有窗口清单，没有界面内容）。这是对现状的收紧 |

写操作的目标解析：

1. 有 `target_id`：用 `b:`。
2. 否则有 `window_id`：用 `w:`。
3. 否则有 `pid`：用 `p:`。
4. 否则 `scope:"desktop"`、`target.display_id`、`move_cursor`、`drag`（不带 pid）：用 `desktop`。
5. 只给了 `element_token`：无法解析目标，退回到"自上次写操作以来有过任意一次 `ok` 观察"，即现状规则。

`launch_app` 免检（打开应用通常就是任务的第一步）。其余写操作沿用第 5 条规则。

额度规则：

- 观察到目标 K 时，`quota[K] = 3`。
- 对 K 的写操作要求 `quota[K] > 0`（窗口目标也可以用 `quota[desktop]`），成功放行后额度减 1。
- 额度用完，返回 `observationRequired`（`refused`）。
- 暂停或恢复时清空全部额度。

这样表单类连续操作（填两个字段再提交）不必每一步都重新观察。即使用了过期的元素编号或引用，驱动也会拒绝（实测 `invalid_snapshot_id`、`browser_binding_stale`），并按 `refused` 交还模型，不会误点。

### 三、"无进展"判定（取代"重复动作"）

- 写操作的指纹 = sha256(工具名 + 参数)，现状如此。
- 观察摘要 = sha256(观察回复的 `structuredContent`，先去掉快照编号、元素令牌、引用编号这类每次都会变的字段)。只在内存里保留每个目标最近一次的摘要。实测：窗口元素树里的元素坐标会随滚动变化；浏览器 `semantic_v2` 快照里的 `visibility` 会随滚动变化，两者都能反映进展。默认的 `dom_refs_v1` 快照不带视口信息，滚动前后摘要相同，这时只能靠兜底规则。
- **同一指纹连续出现，而且每两次之间目标的观察摘要都没变**，累计 3 次，判定为 `noProgress`。
- 同一指纹不论观察结果如何，连续超过 12 次也判定为 `noProgress`。这是兜底，只在观察摘要不稳定时起作用；"不观察就连续操作"已经由观察额度（每次观察最多 3 次写操作）限制。
- 判定后暂停，原因 `noProgress`。**用户可以恢复，不限次数**；恢复后计数清零。
- `stepLimit` 和 `timeLimit` 维持不可恢复。旧原因 `repeatedAction` 不再产生，但保留文案，以兼容尚未清除的历史状态。

如果实现时发现观察摘要无法稳定（字段未知），就只用兜底规则，并在计划里记录。

### 四、越权计数

越权调用（`scopeViolation`、`toolNotAllowed`，以及 R4 规定的接管拒绝）按 `refused` 处理。同一任务累计 3 次，停止任务，原因 `violationLimit`，不可恢复。

### 五、窗口模式支持浏览器

前提：用户在窗口模式里选中的窗口属于浏览器（判定方式：`get_browser_state` 绑定没有返回 `browser_route_unavailable`）。

- 额外可见的工具：`get_browser_state`、`browser_prepare`（受限）、`browser_navigate`、`browser_click`、`browser_type`、`browser_pointer`、`browser_dialog`。
- 仍然排除：`browser_download`、`browser_set_input_files`（涉及文件系统）、`page`（旧接口）。
- `get_browser_state` 绑定调用：网关强制使用选中窗口的 pid 和 window_id。成功后，把回复里的 target_id 和 tab_id 记入"本窗口允许集合"。
- `browser_prepare`：只允许 `pid` 和 `window_id` 等于选中窗口、并且 `strategy.kind=existing_profile`，即接管用户选中的浏览器（R4）。不允许 `allow_launch`。
- 其他浏览器工具：`target_id` 必须在允许集合里，否则判为 `scopeViolation`。
- 第二道闸门：helper 的策略文件是静态的，表达不了运行中才产生的 target_id，所以窗口模式下浏览器工具的目标约束**只由网关执行**；策略文件只约束 pid 和 window_id（`browser_prepare`、绑定调用）。这是一个已知的、比现有桌面工具弱的点，写入决策记录。
- 允许集合在切换窗口范围、暂停恢复、会话结束时清空。

**需实测**（测试计划 T6）：绑定回复里 target_id 和 tab_id 的字段名；Chrome 和 Edge 是否都能经接管拿到调试端点。

### 六、给模型的选用指引

两处同时注入，内容来自 `cuaGuidance.ts`：

1. **`initialize` 回复的 `instructions` 字段。** 遵守 MCP 协议，支持的引擎会放进系统提示。
2. **`tools/list` 里关键工具的说明前缀**：`get_window_state`、`get_desktop_state`、`get_browser_state`、`click`、`type_text`、`browser_click`、`browser_type`、`browser_prepare`。引擎不读 `instructions` 时，这一处仍然有效。

要点（给模型的原文用英文写）：

- 网页内容优先：先用 `get_browser_state` 读页面，再用 `browser_*` 操作，元素引用必须来自最新的快照。
- 原生应用：先用 `get_window_state` 读界面，再用 element_index 或 element_token 操作；只有画布类界面才用像素坐标。
- 浏览器自身的界面（权限弹窗、系统文件选择框、扩展）走桌面工具。
- 收到 `refused`，说明这次调用没有执行：重新观察，再决定下一步，不要原样重试。
- 结果不确定时，不要换一种工具把同一个动作再做一遍；先观察，确认上一个动作有没有生效。
- 整个桌面模式下不能接管用户自己的浏览器；需要登录态时，请用户在 Computer Use 里选中那个浏览器窗口。

注入时，同一位置如果已经存在指引文字，就不再重复添加。窗口模式和整个桌面模式使用不同的文案。

### 七、数据与契约

- `CuaStep.outcome`：新增 `"refused"`。
- `CuaRuntime.stats`：`{ steps, refused, uncertain, pauses, resumes, violations }`，只有计数，不含内容。基准任务集从这里读数据。
- 原因：新增 `noProgress`（可恢复）、`violationLimit`（不可恢复）、`uncertainResult`（写操作报错但没有拒绝标记的情况；以前混在 `toolFailed` 里，现在拆出来）。
- 需要双向同步的位置：`shared/types/cuaRuntime.ts`、`shared/cuaPresentation.ts` 的 `CUA_REASON_KEYS`、四个语言文件、`CuaControls.tsx`、`controlWindow.ts`。
- 对外契约：Agent 能看到的工具集合有变化——窗口模式新增浏览器工具，说明加了前缀。**helper 契约不变**。

### 平台矩阵

| 行为点 | macOS | Windows | Linux | 备注 |
|---|---|---|---|---|
| 结果分级、观察额度、"无进展"、越权计数 | ✓ | ✓ | ✓ | 只是网关逻辑，平台无关 |
| 浏览器工具 | ✓（需实测） | 需实测 | 需实测 | 取决于 cua 在各平台的浏览器支持 |
| 窗口模式支持浏览器 | 本期实测 | 本期只做代码路径，真机验收另列 | 同 Windows | 窗口模式本身目前只在 macOS 有真机验证 |

## 异常与失败场景

| 场景 | 处理 |
|---|---|
| 浏览器工具返回 `browser_binding_stale` 或 `browser_requires_setup` | `refused`。在桌面模式下提示先调用 `browser_prepare` 并选隔离浏览器；在窗口模式下提示接管选中的窗口 |
| 观察工具被拒绝（`window_id_not_found`、`browser_route_unavailable`） | `refused`，不刷新观察额度 |
| 写操作出现 `isError`，但没有拒绝标记 | `uncertain`：暂停并停止守护进程，原因 `uncertainResult` |
| 观察摘要每次都不一样（字段不稳定） | 只有兜底规则（连续超过 12 次）生效，不会误判 |
| 窗口模式下，选中的浏览器窗口被关闭 | 绑定被拒绝，作为 `refused` 交还；连续失败时按"无进展"暂停，用户重新选择窗口 |
| 被拒绝的调用太多，耗尽步数预算 | 原因 `stepLimit`，不可恢复（同现状） |
| 恢复后模型沿用旧的元素引用 | 观察额度在恢复时已经清空，返回 `observationRequired` |
| 引擎不读 `instructions` | 工具说明的前缀仍然生效 |

## 测试计划

单元测试和协议测试由实现者在 worktree 里跑，结果写进计划或验收文档：

- **T1 `cuaOutcome.test.ts`（新增）**：以附录 B 的真实回复作为样本，断言分类结果；覆盖拒绝标记的三种写法、只读工具报错、写操作报错没有标记、超时。
- **T2 `taskController.test.ts`（修改）**：
  - 原用例"失败的写操作会暂停"拆成两条：`refused` 不暂停；`uncertain` 暂停。
  - 原用例"重复动作会终止且不能恢复"改为 `noProgress`：可以恢复，恢复后计数清零；兜底的连续 12 次规则。
  - 新增：观察额度（3 次写操作）；目标不一致时拒绝；`get_accessibility_tree` 不再算观察；被拒绝的观察不刷新额度；越权 3 次停止；`stats` 计数正确，且不含参数。
- **T3 `mcpGateway.test.ts`（修改）**：
  - 浏览器"拒绝"回复（没有 `isError`）不会解锁写操作。
  - `refused` 不调用 `onFailure`；`uncertain` 会调用。
  - `initialize` 回复带上 `instructions`。
  - `tools/list` 里的说明前缀只加一次。
- **T4 `windowScope.test.ts`（修改）**：
  - 浏览器工具强制使用选中窗口的 pid 和 window_id；绑定之后允许集合生效。
  - 不在允许集合里的 target_id 被拒绝。
  - `browser_prepare` 只允许接管选中的窗口。
  - 排除的工具不可见。
  - 生成的策略文件。
- **T5 商业全量**：`npm run test:commercial`，使用本仓客户端源码；工具链变更另跑 `npm run test:scripts`。
- **T6 真实 helper 协议测试**（只读，可自动跑）：把附录 A 的报错采样纳入 `scripts/computer-use/`，用作 cua 升级时的回归测试。只要拒绝回复的结构变了，测试就会失败。
- **T7 真机验证**（需要辅助功能授权，在 macOS 上由实现者跑；跑不了就列给负责人）：
  - 在整个桌面模式下，确认 `browser_prepare existing_profile` 在旧逻辑下能否不经审批就接管用户的浏览器（核实 R4 的前提）；新逻辑下必须被拒绝。
  - 在窗口模式下选中 Chrome 窗口：绑定、读取页面、点击、输入都能成功，其他标签页被拒绝。
- **T8 基准任务集**：**改造前**用现有代码跑一轮作为基线，**改造后**再跑一轮。
  - 每个任务记录：是否完成，以及 `stats` 里的步数、拒绝次数、结果不确定次数、暂停次数、恢复次数。
  - 结果写入 `docs/acceptance/20261014-computer-use-control-layer.md`。
  - 需要真实模型和辅助功能授权，由实现者在本机跑，环境不具备时列给负责人。

### 基准任务集（已实现，见 `scripts/computer-use/bench/`）

| # | 类型 | 任务 | 主要考察 |
|---|---|---|---|
| N1 | 原生 | 点击计算器按钮算 6×7，读显示值验证 | 连续写操作（观察额度） |
| N2 | 原生 | 在 Chrome 窗口里用桌面滚动工具翻长页面，再点按钮 | 参数相同、但每次都有进展的连续滚动 |
| W1 | 网页 | 填 3 个字段并提交 | 浏览器通道；可信输入被拒后改用 dom_event |
| W2 | 网页 | 浏览器通道滚动到可视区，再点按钮 | 浏览器滚动 |
| W3 | 网页 | 跳转后先误用旧引用，再纠正 | 引用过期后能自己恢复 |

和初版相比的调整：

- 去掉"文本编辑"和"访达改名"：会碰到用户自己的文档和窗口；而且 `launch_app` 打开指定文件夹时访达不会新开窗口。
- 去掉"网页复制到文本编辑"：会覆盖用户的剪贴板。
- "连续滚动"由 N2 用桌面工具覆盖。

测试页面由 `tasks.ts` 内置的本地 HTTP 服务提供，不依赖外网。网页任务使用另起的独立 Chrome 实例，不碰用户的浏览器。

## 已否决的备选方案

- **本期就实现按资源并发**：见 R1，代价大、收益小。
- **只靠 `instructions` 注入指引**：不是所有引擎都会读，必须同时改工具说明。
- **在窗口模式下，每次绑定后重写 helper 策略文件**：策略要重启守护进程才能生效，会打断任务，而且有竞态。
- **只按工具名区分有没有副作用**：识别不了浏览器类工具"不报错的拒绝"，R2 那个 bug 就是这么来的。
- **保持"报错就停机"**：可以自己恢复的错误占绝大多数，这样做让任务几乎都要人工介入，与 intent 的目标冲突。
- **桌面模式下用审批卡片放行接管用户浏览器**：需要新的审批界面；选中窗口这个动作本身就是更直接的授权，本期不做卡片。

## 附录 A：实证方法

用 `/tmp` 下的临时脚本启动私有守护进程（`serve --socket <临时目录> --permission-mode unrestricted --dangerously-bypass-approvals --no-permissions-gate`，令牌临时生成），通过 `mcp --socket` 执行 `tools/list`，并对不存在的 pid、window_id 和浏览器 target 发起调用。没有执行任何真实输入。T6 会把这套流程整理进仓库。

## 附录 B：真实回复样本（cua-driver 0.28.2）

| 调用 | isError | 结构化结果（节选） |
|---|---|---|
| `get_window_state`，窗口不存在 | true | `{code:"window_id_not_found"}` |
| `click`，snapshot_id 格式错误 | true | `{status:"refused", refusal:{code:"invalid_snapshot_id"}}` |
| `click`，缺少 pid | true | `{code:"tool_invocation_failed"}` |
| `set_value`、`scroll`，pid 不存在 | true | `{code:"window_target_not_found", effect:"refused"}` |
| `get_browser_state`，target 已过期 | **未设置** | `{status:"refused", refusal:{code:"browser_binding_stale"}}` |
| `browser_click`，target 已过期 | **未设置** | `{effect:"refused", escalation:{reason:"route_unavailable"}}` |
| `browser_navigate`，target 已过期 | **未设置** | `{status:"refused", refusal:{code:"browser_binding_stale"}}` |
| `get_browser_state`，pid 不是浏览器 | **未设置** | `{status:"refused", refusal:{code:"browser_route_unavailable"}}` |
