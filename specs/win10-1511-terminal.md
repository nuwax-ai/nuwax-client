# 规格：win10-1511-terminal

- 对应 intent：`plans/20261015-win10-1511-terminal-intent.md`
- 状态：实现规格；用户已确认兼容目标，技术与安装包验收按下述标准执行。

## 需求基线

Windows 10 1511 x64 必须保留内嵌交互终端。现有终端前端和业务 URL 不变。

## 方案设计

### 架构落点

- 在壳仓 `native/legacy-terminal/` 维护独立 Go 兼容服务，使用固定版本 Gorilla WebSocket 和 WinPTY 0.4.3 原生 DLL/agent。Go 通过 Windows DLL API 调用 WinPTY，不引入 Node 原生插件。
- 兼容服务接受当前 ttyd 使用的 `-p/-i/-W/-w/-a` 启动参数，提供 `/ws` + `tty` 子协议。返回 `--version` 供现有可用性检查使用。
- 商业 overlay 的 binaryLocator 仅在 `win32` 且系统 build <17763 时选择兼容程序；新系统继续使用原 ttyd。旧系统资源缺失时返回兼容程序的预期路径，让现有缺失资源错误显式暴露，禁止回退到必定失败的 ConPTY。
- 资源位于 `resources/ttyd/legacy/win32-x64/`，沿用现有 ttyd extraResources。本地 prepare、pack 和 Windows 发布工作流均准备并核验资源。

### 数据与契约

- 首包 JSON `{columns,rows}` 创建独立 PTY；输入 `0+UTF8`，缩放 `1+JSON`，暂停/继续 `2/3`；输出为二进制 `0+完整UTF8片段`。
- 每条连接启动独立 shell，初始目录由现有 gateway 注入的 `arg=--cwd&arg=<path>` 和 PowerShell wrapper 处理。参数以 Windows 参数转义传入，不拼接 shell 指令。
- 每个会话使用 kill-on-close Job Object 管理 WinPTY agent 和它的 shell/子进程。断连、进程退出、服务关闭均释放资源。
- 服务只绑定 127.0.0.1，限制入站帧与尺寸，执行下行背压；无新持久化字段或后端接口。
- 上游归档与二进制 SHA256 固定，Go 依赖 go.sum 固定；许可证加入现有 third-party 清单。

### 平台矩阵

| 平台 | 后端 |
|---|---|
| Windows 10 1511 x64 / build <17763 | WinPTY 兼容服务 |
| Windows build >=17763 | 现有 ttyd / ConPTY |
| macOS / Linux | 现有 ttyd |

## 异常与失败场景

DLL/agent 缺失、DLL 装载或 PTY 创建失败不得报告健康；错误带英文原因。WebSocket 握手健康检查保留现有语义，实际 shell 创建另有端到端验证。重复初始化、非法尺寸和过大帧拒绝；断连必须唤醒暂停的输出并终止对应进程树，不终止其他连接。

## 测试计划

- Go：真实 WebSocket 协议 + 注入 PTY，覆盖输入、缩放、流控、UTF8分片、断连与失败。
- TypeScript：旧/新系统版本边界、不同平台及兼容资源缺失路径。
- 脚本：锁文件、资源散列、缓存损坏、pack/CI 必选资源及许可证链。
- Windows 11：强制运行兼容服务，回归真实 WinPTY DLL、中文、空格目录、双会话、Ctrl+C、缩放和进程清理；结果仅为回归，不代表旧系统兼容通过。
- 原始 Build 10586 真机/安装包：用户确认由原反馈人安装 Beta 复测；不以 Windows 11 回归替代。

## 已否决的备选方案

- 只禁用终端或打开外部 CMD：不满足保留内嵌终端。
- 把 PowerShell 改成 CMD：ttyd 在执行 shell 之前即要求 ConPTY。
- 引入旧版 node-pty：增加旧 Node/Electron ABI 适配负担；独立 WinPTY 服务可隔离这一依赖。
