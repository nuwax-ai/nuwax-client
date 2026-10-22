# Computer Use 基准测试

## 真实模型任务（desktop-v1.1）

`real-run.mjs` 通过随包 **nuwaxcode ACP Agent** 调用真实模型，复用产品的任务注册表、会话授权、MCP 网关和 Rust helper。模型自行规划，测试没有预设点击顺序。只允许原生窗口 CUA 工具；不提供 DOM、CDP、网络、文件系统、终端或其他 Agent 工具。

首批是可复跑的 **7 项试点**，不是最终 50 核心 + 20 异常任务全集：

| 任务 | 场景 | 独立判定 |
|---|---|---|
| F01 / F02 | 中文表单 / 替换文本 | 精确字段值及提交状态 |
| F03 / F04 | 单选复选 / 滚动找第 28 项 | 精确选择；F04 还要求实际滚动且点击时目标完整可见 |
| F05 / F06 | 延迟加载 / 列表重新排序 | 加载或刷新完成后的业务状态 |
| N01 | macOS TextEdit / Windows Notepad | 从绑定窗口重新读取目标正文，不接受模型自报完成 |

F 系列用独立 Chrome / Edge 用户目录承载本机合成页面，通过 AX/UIA 和窗口截图操作，**属于桌面 GUI 夹具**；N01 才是系统应用任务。两者与签名安装包、真实业务软件及八小时稳定性分开记账。原有固定规则控制层基准见下节。

`desktop-v1.1` 加严 F04 的滚动/可见性 oracle；v1 的该项只检查选中值，不能据此证明滚动定位。跨版本结果保留版本号，不混成一项成功率。

### 环境和命令

- macOS / Windows 交互桌面已解锁；helper 声明 `nuwax_window_tasks=1`。macOS 已有辅助功能/屏幕录制许可，安装 Swift 命令行工具用于测试状态窗口。
- 使用待测 helper 与明确版本的随包 Agent。macOS 支持 `.app` helper，Windows 使用 `.exe`。
- 将 `CUA_MODEL`、`CUA_MODEL_BASE_URL`、`CUA_MODEL_API_KEY` 注入运行进程环境；不把实际密钥写入命令、脚本、报告或 Git。图片探针验证通过后才运行 hybrid 任务。
- Windows 必须在已登录的交互会话启动（可用当前用户 `Interactive`、`Limited` 计划任务），不能用 SSH 的 session 0 代替桌面验收。运行器先验证 Agent `--version`，失败或超时在打开目标应用和请求模型前停止，报告记录 PE 架构和退出分类。ARM Windows 优先显式提供同版本、已核验发布哈希的 ARM64 Agent 路径；x64 的失败应计为环境阻断，不能改变任务分母或冒充模型失败。
- 本轮 Windows 仅使用本地虚拟机；禁止把同事电脑作为调试/验收设备。运行器不负责发现、选择或连接远程机器。

```bash
node scripts/computer-use/bench/real-run.mjs --list
node scripts/computer-use/bench/real-run.mjs \
  --helper '/Applications/Nuwax Computer Use.app' \
  --agent '/Applications/Nuwax.app/Contents/Resources/nuwaxcode/darwin-arm64/bin/nuwaxcode' \
  --preflight --output .cache/cua-real-bench/preflight.json
node scripts/computer-use/bench/real-run.mjs \
  --helper '/Applications/Nuwax Computer Use.app' \
  --agent '/Applications/Nuwax.app/Contents/Resources/nuwaxcode/darwin-arm64/bin/nuwaxcode' \
  --tasks F01,F02,F03,F04,F05,F06,N01 --repeat 5 \
  --timeout-ms 180000 --output .cache/cua-real-bench/baseline.json
```

无仓库的 Windows 测试机：先 `--build-only`，复制 `real-*.mjs`、`runtime.cjs` 及 `runtime.cjs.source.json`，通过 `--runtime ./runtime.cjs` 运行；源提交/WIP 指纹随运行时清单保留并核对哈希。helper / Agent 使用实际测试机文件，不改变安装和更新源。

默认 `--mode background --modality hybrid`。`--mode foreground` 是单独、显式的前台试验，结果必须分组；后台能力不足时测试暂停，不自动切换模式或恢复。`--modality ax` 仅用于诊断，不能宣称视觉能力通过。准备阶段的运行器状态窗用于建立后台条件，不能绕过原生前台保护；目标仍在前台就记录阻断。

### 记录及停止

- 每次任务使用随机命名窗口、独立浏览器配置和隔离 Agent 目录；只清理本轮创建的进程、文档和端点。现有记事本实例无法安全隔离时记录阻断。
- Ctrl+C / SIGTERM 会取消 Agent、撤销任务许可、等待原生排空，再清理本轮资源。每个完成或失败任务立即原子写报告。Agent 启动阻断或控制边界失败停止后续任务，不靠重复启动掩盖问题。
- 报告记录平台/OS、模型名、运行时/helper/Agent 哈希、任务版本、前后台/模态、工具结果码、步数、耗时、模型 usage、独立 oracle、介入次数和原生排空结果。任务完成、业务成功和环境阻断分别记录；失败及未执行任务保留在计划分母中。
- 计数代理只在内存转发模型请求，报告不保存图片、提示词、工具参数、窗口标题或密钥。Agent 使用隔离的临时数据目录并在回合后删除；清理失败必须处理，不能当作通过。预览采集不参与此链路。
- usage 缺失、取消中断或未指定价格时 token / 费用标记 `null`，不能记作零成本。可显式指定 `--input-usd-per-million` 和 `--output-usd-per-million`，记录混合输入单价口径；每成功任务成本包含失败尝试花费。
- 测试：`node --test scripts/computer-use/real-bench.test.mjs`。实跑结果参见 [现有验收记录](../../../docs/acceptance/20261019-computer-use-multiwindow.md)。

## 固定规则控制层基准（历史对照）

用真实的 Nuwax Computer Use 守护进程，加上进程内运行的产品网关（`mcpGateway.ts`）和状态机（`taskController.ts`），由一个**固定规则的程序化 Agent** 执行任务。改造前后跑的是同一套动作，所以结果差异只来自控制层。

这套测试不调用大模型。它衡量的是控制层带来的打断和额外开销，不衡量模型本身的能力。

## 前提

- macOS，已安装 `/Applications/Nuwax Computer Use.app`（正式签名，已获得辅助功能和屏幕录制授权）。
- 安装了 Google Chrome。测试会另起一个独立的 Chrome 实例（临时用户目录 `/tmp/cu-bench/chrome-profile`，打开调试端口），**不会碰你自己在用的浏览器**。
- 已执行过 `npm run overlay:sync`（基座依赖里需要有 esbuild）。

## 运行

先生成与产品一致的策略文件，再经 LaunchServices 拉起守护进程（授权归 Nuwax Computer Use），最后跑任务。Nuwax Computer Use 不在 `/Applications` 时，用环境变量 `CU_HELPER_APP` 指定它的路径。

```bash
node scripts/computer-use/bench/run.mjs --policy-out /tmp/cu-bench/policy.yaml
```

```bash
node scripts/computer-use/bench/daemon.cjs start /tmp/cu-bench/policy.yaml
```

```bash
node scripts/computer-use/bench/run.mjs --label after
```

只跑部分任务时加 `--tasks N1,W1`。结果写入 `/tmp/cu-bench/results-<label>-<时间>.json`。用完后停掉守护进程：

```bash
node scripts/computer-use/bench/daemon.cjs stop
```

其他参数：

- `--bench-allow-attach`：整个桌面模式会拒绝接管已有浏览器配置（规格 R4）。加上这个参数，测试脚本会放行对独立测试实例的接管，以便和改造前的结果同口径对比。只存在于测试脚本里。
- `--window <pid>:<window_id>`：按窗口模式运行 WS 任务。生成策略文件时也要带上同一个参数，让守护进程使用窗口模式的策略。
- 对比旧版本：用 `git archive <旧提交> overlay/crates/agent-electron-client/src` 导出旧控制层，把当前的 `scripts/computer-use/bench` 复制到导出目录的同一位置，再用环境变量 `CU_ESBUILD` 指向本仓的 esbuild 运行。

## 任务

| # | 内容 | 考察点 |
|---|---|---|
| N1 | 点击计算器按钮算 6×7，读显示值验证 | 连续写操作和"先观察"门禁 |
| N2 | 在 Chrome 窗口里用桌面滚轮（参数完全相同）翻长页面，再点按钮 | 每次都有进展的连续相同操作（"重复动作"判定） |
| W1 | 通过浏览器通道填 3 个字段并提交 | 浏览器通道；默认的可信输入路径被拒绝后改用 dom_event |
| W2 | 通过浏览器通道滚动到可视区，再点按钮 | 浏览器滚动 |
| W3 | 点链接跳到新页面，先误用旧页面的引用，再纠正 | 引用过期后能否自己恢复 |
| WS | 窗口模式：接管并绑定选中的浏览器窗口，填表提交，中途两次越界 | 窗口模式下的浏览器通道与越界拒绝 |

程序化 Agent 的习惯（每次运行都一样）写在 `tasks.ts` 的文件头。暂停后的"人工恢复"由脚本模拟用户点恢复：网关恢复传输通道，状态机执行 `resume()`；如果状态机拒绝恢复，任务记为失败。

## 已知差异

- 产品里的暂停会停掉守护进程，恢复时重新拉起；脚本只重建网关到守护进程的传输通道，不重启守护进程。浏览器绑定在两种情况下都会失效，所以对 Agent 来说行为一致。
- 不覆盖会话凭据、控制条界面和登录生命周期，这些已有各自的单元测试和真机验收。
