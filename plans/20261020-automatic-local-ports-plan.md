# 商业客户端全部本地端口自动管理

## 决策与实现

- 商业自管 TCP 服务统一自动分配，首选 24600–24999，耗尽后扩展到 20000–29999；复用上次成功端口，旧设置统一迁移，用户端口输入移除。
- 主进程运行时表管理 Computer/Admin 共用监听、文件服务、终端网关、内部 ttyd、页面网关；真实绑定、子进程存活与服务健康共同决定就绪。
- 注册前预留，服务接管时冲突自动改选；最终端口注册提交后才启用隧道。会话及端口代次共同阻止迟到写回，单服务 IPC 的异步步骤继承原会话取消信号。
- 社区不启用自动策略，保留既有配置行为；远程端口、开发服务器、用户项目服务及 MCP/CUA 的 stdio/socket/命名管道不纳入端口池。
- 商业 `settings:get(step1_config)` 向旧 renderer 投影实际端口；写回剥离本地端口字段。自动记录键为 `nuwax.localPorts.v1`。
- 文件服务修复保存在 `resources/source-patches/nuwax-file-server-http-listener.patch`，开发与 CI 资源准备都只修改一次性构建副本。资源侧 `.source-patch-sha256` 记录补丁摘要，缓存键包含补丁内容。

## 工作区与来源

- 产品工作树：`/Users/apple/.codex/worktrees/automatic-local-ports/nuwax-client`，分支 `feat/automatic-local-ports`，起点 `75ba4b9b2a7044cb1bb71373fb6c469848269487`。
- 基座工作树在其 `nuwa-electron-shell/`，分支同名，起点 `c08080d127544b7e191e11fe722fa50a1b977679`。通用机制为基座改动；商业策略、生命周期接线、设置与资源覆盖为外层 overlay。
- 文件服务源码候选：`/Users/apple/.codex/worktrees/automatic-local-ports/nuwax-file-server`，分支 `fix/loopback-listen-errors`，起点 `69c9d199`；补丁同时验证可应用于已有 1.5.4 源码，并可幂等识别已修复源码。
- 资源准备已实际构建 1.6.0，源 SHA 记录于资源 `.commit-hash`；补丁 SHA-256 为 `a923391f404455c8908498bbfbee80bcea8952f36b751356499ef4fa2f41ae29`。
- 本任务没有修改原始 `/Users/apple/workspace/nuwax-client` 的已有 WIP、三个子模块检出或支持脚本；其他会话可能继续推进原工作区。

## 验证

执行结果与日志保存在本工作树 `.cache/validation/`，最终测试数量以该目录最新日志为准。

- 分配器与服务集成覆盖：候选池耗尽、EADDRINUSE/EACCES、接管竞争、原生错误码丢失、并发去重、稳定端口、清理失败、子进程迟到退出、健康响应期间退出、会话取消与旧会话后续步骤。
- 生命周期覆盖：端口代次变化的迟到注册、隧道启动前提交、单服务改口后重连、子进程退出后的重新启动。
- 最终商业全量：3253 通过、18 跳过；隔离社区全量：1673 通过、18 跳过。外层脚本全量：377 通过、0 失败；精确前端 pin 的宿主契约检查通过。
- 本机真实端口共存检查：保持社区/CLI 默认端口上的监听（含原有不可用端口 60016）不动，两份分配器的十个真实监听全部落在 24600–24609 且互不重复。这是默认端口监听模拟，不替代两款已安装客户端的完整验收。
- 文件服务 Jest 真实绑定测试、源码构建与资源准备通过；真实子进程验证冲突退出码 1、EADDRINUSE、无成功误报、占用者继续运行及健康实例/PID 匹配。
- 商业主进程、renderer 构建及导入边界、特性边界、应用目录与 overlay 一致性检查通过。
- 主进程完整类型检查有 11 个既有错误；与 `75ba4b9b` 的原始 overlay + `c08080d1` 基座独立副本对照，诊断完全一致（忽略行号）。

## 剩余验收与集成

- 真实安装包的 Windows 10 1809、macOS、Linux 验收，以及真实账号下的平台注册、隧道文件上传下载和终端全链路尚未完成，不用单元测试替代。
- 已按用户授权进入提交与 PR 集成：基座中立改动提交为 `d3792bae`，合入最新 main 后通过基座 PR [#38](https://github.com/nuwax-ai/nuwa-electron-shell/pull/38) 回流；待其合入 main 后更新商业 pin，再经商业 PR 回流 `release/v3.1`。基座提交前 staged 纯净检查通过，16 个文件且无商业 overlay；旧 pin 至候选基座的 overlay 兼容审查为 0 个重叠变化。
- 没有创建发布 tag、签名或推进更新指针。
