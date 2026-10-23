# 打包重复构建优化

- 目标：减少 macOS Intel 与 Windows 每次发布重复编译的前端和原生资源；保持 MSI、NSIS ZIP、签名、公证及发布门禁。
- 范围：当前分支 `fix/stable-3.0.22` 的构建脚本与 workflow，不带入 Beta.4 的运行时代码或源码 pin。
- Beta 前端：与源码门禁并行构建一次，五平台消费同一 workflow artifact；核对客户端 SHA、前端 gitlink、版本戳、文件 SHA256 和 producer run。stable 继续消费 nuwax-dist pin。
- 原生资源：按源码/补丁/锁文件、构建配方、实际工具链、架构和 SDK 输入缓存未签名 helper；每次仍从锁定源码检查补丁并重新组装/签名。capture 仅缓存已有准入规则覆盖的未签名资源和源码/许可证。
- 跨 tag（Beta.5 / Beta.6 复核后修正）：默认分支没有预热 workflow，标签作用域的 actions/cache 无法跨标签消费。改用同仓可信发布 / 维护线预热 job 产出的不可变 Actions artifact，不伪造缓存作用域，也不依赖 main 先部署流程。
- 来源契约：精确配方 / 源码 / 实际工具链 key；producer run、attempt、job、仓库、workflow、事件与 ref 白名单、版本 tag 的当前 SHA、producer 是当前源码祖先；对应平台 job 必须成功（其他平台失败不作废成功平台的资源）。PR、任意分支、失败平台、来源/哈希不符均拒绝。
- 存储边界：helper 仅编译器未签名输出缓存；capture 仅未签名资源、锁定源码与许可证；Node/Git/uv/nuwaxcode/ripgrep 仅下载归档，不共享已组装应用或签名目录。恢复先在临时目录校验 artifact 摘要、严格归档条目、manifest 路径、逐文件 SHA 和模式，再原子替换所拥有的缓存根；拒绝外链、绝对路径与路径穿越。
- 接入：正式/Beta 发布已有资源准备后上传，不增加串行预热。warm workflow 增加 fix/stable-3.0.22 的 push 路径触发（仅允许 main / 该维护线），避免仅放宽 job if 仍无法触发。命中后仍源码/补丁检查、重新准入、组装、签名、公证与产物门禁；失败可降级冷构建。
- 可观测性：每类资源输出命中/缺失/拒绝原因、producer run/job、恢复与准备耗时，禁止用 runner 排队或其他阶段波动宣称缓存收益。Intel 的最终归档两版原已 compression=1，本次不重复计作新增优化，不改 DMG 格式或省略产物。
- 发布前检查点：先独立审查脚本与 YAML；下次实际发布检查跨 tag 精确 key 命中与准入日志、冷构建降级、恶意/损坏归档拒绝、缓存根替换回滚、各平台完整签名和产物。现有 Beta.6 冻结 tag 不变；正式版是否提速必须据实际流水线确认。
- 静态归档实际消费（已读锁定基座 prepare 源码，不代表已运行验证）：客户端根 `nuwa-electron-shell/crates/agent-electron-client` 下，Node/Git/uv/ripgrep 分别使用 `resources/<name>/.cache`，nuwaxcode 使用 `scripts/resources/nuwaxcode-cache`。仅保存这些目录顶层 `.zip` / `.tar.gz` / `.tar.xz` / `.7z.exe` 等归档；不保存 extract 子树。Node `download()` 优先本地归档、仍重新取官方 SHASUMS 校验；Git `resolveArchive()` 优先 `.cache/PortableGit-<version>-64-bit.7z.exe`；uv/ripgrep 的 `download()` 优先达到原有大小门限的本地归档；nuwaxcode `download()` 优先本地归档且后续仍校验锁定官方 SHA、内部版本，失败会删除归档重下。这些脚本不会在成功准备后删除原始归档；每次仍提取、组装和签名。
- 验证边界：打包子 Agent 按用户要求只修改代码，未运行测试、构建、打包、CI 或真机操作，未提交或发布。主 Agent 负责源码审查及交付；Beta.6 冻结不变，后续进入正式版，实际命中与耗时以预热和正式流水线日志为准，当前不宣称实际提速。
