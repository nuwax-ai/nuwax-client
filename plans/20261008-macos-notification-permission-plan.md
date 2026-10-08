# 实施计划：macOS 消息通知检测

- 对应规格：specs/macos-notification-permission.md
- 执行依据：本次用户添加检测的请求，沿用现有授权页。
- 状态：实现及本地验证完成，签名安装包实机切换验收待进行。

## 实施顺序

1. 商业根增加 Node-API headers；overlay 加入原生读取、编译脚本和 main build 入口。
2. overlay 的 appHandlers/macPermissions 接入检测与系统设置；保持现有 preload/权限列表契约。
3. 授权页增加通知状态文案、返回刷新与设置失败提示；同步四种语言和 I18N_KEYS。
4. 本地与 CI 打包配置显式解包原生模块；验证状态行为、打包配置、两架构编译和实际 Electron API。
5. 商业回归及隔离社区回归，检查 overlay/pin/diff。保存结果；按用户后续「commit」请求本地提交，不推送或发布。

## 风险与回退

读取失败显示未知，不影响其他权限或消息接收。原生 API 不变更授权和 delegate。回退限本次商业 overlay、构建配置、依赖和文档，不改基座 pin 或无关 WIP。

## 验证结果（2026-10-08）

| 检查 | 结果 |
| --- | --- |
| 新增行为测试 | 33 项通过：授权映射、并发合并/撤权、读取失败、IPC 列表、设置兜底、页面标签/失败提示/返回刷新/迟到结果 |
| 商业完整回归 | 177 文件通过、1 文件跳过；2,330 项通过、18 项跳过 |
| 社区隔离回归 | 129 文件通过、1 文件跳过；1,552 项通过、18 项跳过。使用 HEAD 导出副本及副本内 MCP 资源，原工作区 overlay 未清理 |
| 相关脚本回归 | 29 项通过，含商业依赖、打包、overlay 兼容与发布流程 |
| 构建 | production main/preload 与 renderer 通过；原生 `.node` 包含 arm64/x86_64 两架构 |
| 实际 Electron 读取 | Electron 40.8.2/arm64 返回 authorizationStatus=0（尚未申请）；未弹授权框、未发送通知 |
| ASAR 运行态 | 将真实读取服务 bundle 进独立 ASAR，`.node` 解包后由 Electron 成功装载，返回 denied；验证路径包含 `.asar/` |
| overlay / pin / diff | overlay 同步一致，check:pin 通过，diff --check 通过 |
| 类型检查 | 改动前后均为 233 项既有诊断，诊断集合一致，本次改动文件无诊断；全库类型检查未通过 |

首次原生编译发现本机默认 CLT SDK 与当前 Xcode 编译器版本不匹配；构建脚本明确使用 `xcrun --sdk macosx` 配套 SDK 后，两架构编译通过。社区副本首次缺少 MCP 资源导致测试失败，复制资源到隔离副本后完整回归通过。

验收边界：实际查询使用独立 Electron 开发进程的身份，ASAR 检查验证装载路径；没有切换用户当前 Nuwax 的通知开关，没有验证签名 Nuwax 安装包的通知列表/开关切换、Intel 机器运行或系统专注模式。现有通知偏好和消息接收逻辑未改。按用户后续请求本地提交，未推送或发布；无关 iframe 与 Windows 安装任务的工作区改动保留。

日志：`/tmp/nuwax-macos-notification-{commercial,community,scripts,main,renderer,native,asar,tsc,baseline-tsc}-20261008.log`。
