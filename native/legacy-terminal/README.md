# 早期 Windows 10 内嵌终端

本程序只为 Windows 10 1511 x64 等无系统 ConPTY 的机器提供兼容后端。商业 binaryLocator 在 build <17763 时选择它；较新 Windows、macOS、Linux 沿用原 ttyd。

保留 ttyd 的 `tty` WebSocket 子协议、初始化/输入/缩放/暂停/继续帧及现有 gateway 目录参数。`server.go` 管连接与参数，`session.go` 管协议和输出背压，`winpty_windows.go` 管 DLL/pipe/Job Object；不依赖 Electron 原生模块 ABI。

```sh
# 仓库根；支持从 macOS/Linux 交叉编译，运行回归需 Windows
npm run prepare:terminal-compat -- --platform win32 --arch x64
cd native/legacy-terminal
go test -race ./...
```

Windows 回归：`node scripts/acceptance/terminal-compat.mjs <资源目录>`。它强制使用 WinPTY，覆盖中文、独立工作目录、尺寸、Ctrl+C 和进程树清理；在 Win11 上通过只算回归，Win10 1511 的兼容验收由原反馈人安装 Beta 复测。

上游 DLL/agent 锁在 `third-party/terminal-compat-sources.json`，Go 依赖锁在 `go.mod/go.sum`，许可证在 `third-party/licenses/`。升级 Go 时同步源锁、go.mod、声明清单与 CI 的 setup-go；一致性测试会拒绝版本漂移。兼容 EXE/DLL/agent 均位于 asar 外，包体上传前按准备产物逐字节核验。
