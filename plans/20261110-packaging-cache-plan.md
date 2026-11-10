# 桌面发布打包提速
- 目标：分别向 alpha/v3.1.0、release/v3.1.0 提 PR；不修改已创建的 alpha.5 tag。
- 实测基线：Beta.19 run 42763979564；Windows Build Electron 1126 秒，MSI/NSIS 因 winCodeSign 的非 Windows 符号链接回退串行。CUA/FFmpeg 已命中，保留配方不变。
- 公共改动：仅从 Windows 私有工具缓存的计量与复制中排除 winCodeSign 的 darwin/linux 子树；复用两个辅助项目的锁版、目标平台产物，固定远端 SHA 后构建，复用既有可信 producer/祖先/逐文件哈希准入。
- Alpha/Release 按实际资源提供独立 Agent Desktop 缓存；Alpha 的 Office 只缓存 SHA256 寻址下载，不缓存签名应用或可变宿主文件。
- 缓存身份不含应用版本/普通业务源码；包含源码 SHA、依赖锁所在提交、补丁、准备脚本、Node/平台/架构；Windows 源码编译额外绑定 runner 工具镜像与编译环境。
- 缓存可选，损坏/不完整/网络问题回退原准备；辅助源码缺少 lockfile 时不发布可复用产物。不开新发布/验包来试压缩参数。
- 验证：安装器真实子进程回归（并发、隔离、串行兜底、失败不公开）；依赖键稳定/失效、固定 SHA、损坏/缺失产物及来源准入；脚本门禁与两条 PR CI。实际节省时间须合入后下一次正式包测量。

## 检查结果
- 内聚：资源身份在 fixed-dependency-cache / prepared-source-cache；来源、哈希和原子替换复用 build-resource-artifacts，不在 workflow 重写准入。
- 分层：发布组合 action 只安排 restore/save，准备脚本消费固定源码身份；安装器空间与缓存复制使用同一个过滤规则。
- 可维护：源码/平台/补丁/工具变更使对应键失效；Office 下载和 Agent Desktop 独立，不修改 helper/capture/core 配方。缓存无匹配不阻断准备。
- 本机真实 file-server 准备（pnpm store 已热）7.83 秒，随后命中 0.03 秒；产物 13,718 个普通文件、无链接，约 89.5 MB，清单约 3.82 MB。此数据不作为 CI 提速承诺。
- Alpha.5 首次 Windows 发布暴露第三方 patch 被 checkout 转 CRLF；本批强制其 LF，并通过 autocrlf=true 的 Git checkout-index 回归。失败 tag 保留。
