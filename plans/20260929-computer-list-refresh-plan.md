# 实施计划：首次进入后的电脑列表刷新

- 对应规格：`specs/computer-list-refresh.md`
- 状态：已完成（用户明确要求实施此前分析范围）

## 改动文件清单
| 范围 | 动作 | 说明 |
|---|---|---|
| overlay 主进程桥、guest preload、桥类型及测试 | 修改/新增 | 下发脱敏生命周期状态，文档加载补发，晚订阅重播 |
| nuwax hostBridgeEvents、HostCommand 类型及状态订阅模块 | 修改/新增 | 集中分发状态，保留快照供选择器订阅 |
| nuwax ComputerTypeSelector 及相关 hook/测试 | 修改/新增 | 打开刷新、有界重试、请求生命周期与选择保护 |

## 实施顺序
1. 壳和前端按上述职责并行，协议统一为 `computer-service-state`。
2. 同步任务相关 overlay 文件到基座输出，保留无关 WIP，不运行会清 overlay 的社区测试入口。
3. 运行专项测试、会话域回归、商业测试与必要构建；独立 verifier 复核。
4. 检查最终差异，更新验收证据和实际偏离，不提交/推送无关工作。

## 风险与回退
宿主信号早于后台列表更新由有限重试覆盖；慢请求/手动选择由代次与在途保护覆盖；过多轮询由宿主门控、后台暂停和预算限制缓解。回退仅撤销本任务源码与对应测试。

## 偏离记录
未扩大产品范围。独立验证补齐了 ready 前旧请求不能结束新等待窗口、跨智能体暂缺手选恢复、新手选取消旧等待三个组合边界；对应回归先重现失败，再修复通过。

2026-09-29 晚补充（用户反馈「手动停止全部服务后列表不变」）：原实现只消费 ready，停止场景断链。补 `useComputerList` 的 stopping/stopped/starting 处理（stopping 取消上线重试、stopped 立即补拉并开等下线窗口、代次对称隔离停止前在途响应）；三个先行失败测试转绿。

## 最终验证
- 前端专项：5 文件 / 57 测试通过。
- 会话域门禁：110 文件 / 1068 测试通过（最终源码复跑）。
- 商业门禁 `npm run test:commercial`：163 文件通过、1 文件平台跳过；2000 测试通过、18 跳过。
- 商业生产主进程 esbuild 构建成功；overlay check 为 0 个待同步文件；两仓 diff check 通过。
- `node scripts/acceptance/computer-list-refresh.cjs` 最终复跑通过：真实 Electron webview、实际 preload/宿主状态 helper、React 选择器与受控 HTTP API，覆盖云端首载、本机延迟出现、打开重拉、旧记忆不覆盖手选、文档重载/晚订阅快照。
- 独立 verifier：94 项正式专项和 3 条读取实际源码的内存复验均通过。
- 前端全库 TypeScript 有存量错误；本任务修改路径无诊断。
- 停止场景补齐轮（09-29 晚，ZCode 接手）：ComputerTypeSelector 3 文件 / 44 测试通过（含 3 个停止场景）；会话域门禁 110 文件 / 1068 测试复跑通过；tsc 改动路径零诊断；壳侧 lifecycle 源码核实确发 stopping/stopped 相位。

测试使用虚构候选及临时 profile，未验证线上真实账号首次登录、发布安装包或 Windows 实机。未提交/推送，既有开发服务和无关 WIP 保留。
