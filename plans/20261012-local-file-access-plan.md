# 实施计划：local-file-access

- 状态：开发完成；macOS 与 Windows 实际 Electron 验收完成（2026-10-15）；真实账户/安装包人工验收待提测
- 对应 spec：specs/local-file-access.md

## 基线与隔离
壳 c9294fbafb9c75a9399f2bd09339a30b7006815a；基座 484ff6b36e73c21c0a5dc1b01aeae9fb6d07c106；前端 649da70bf9becc71e0e3c5bfbdb2adf0156b634e；dist 73a6040080efe413fab3398cc39ee013b6781cd8。托管 worktree local-file-access，壳与前端均 codex/local-file-access。子模块独立 clone，无原 .git 指针/共享工作树。仅复用 _kit 与边界检查，注册入口按本需求新建。前端 build/pack 使用 --frontend source。

## 实施顺序
1. 保存 intent/spec/plan、冻结桥契约，安装隔离依赖。
2. 并行实现 main local-files（文件服务、授权、流、ZIP）与前端 localFileService/业务入口。
3. 接组合根、唯一请求门、preload、协议声明和契约快照。
4. 单测、边界/契约、商业门禁、社区隔离门禁、前端构建。
5. 实际 Electron 验收，记录真实可验范围，分别提交前端与壳。

## 证明成立的测试
路由/目录/owner/代次；GET/HEAD/Range/链接；所有预览和点击；隐藏项/空目录/硬链/软链/超过100MiB ZIP；下载取消清理；原远端路线回归；成功本机读取无云端 static 文件请求。

## 风险与回退
关闭 features.local-files.enabled 可回到旧路线；既有写接口不改。协议权限只能启动前声明，关闭后会留惰性 scheme 声明但无 handler/IPC/授权。验收不足必须标待验证，不能宣称真机通过。

## 偏离记录
ZIP 按用户已确认的完整工作区实现，流式预览代替原 ZCode 草案 Blob 方案。

- Electron 40 实测要求 handler 在首个业务 renderer 导航前安装；已在启用特性的初始化阶段安装，不延迟到第一次文件读取。
- 同文档 history/query/hash 切换保留授权；完整 document navigation、登录代次和域变更撤销授权。
- 独立审查发现 OpenUI、能力恢复与旧节点正文/PDF 三处可能切回云端的失效路线，已补回归并修复。已成功确定本机的上下文在失效后直接报错。
- Windows 验收主机 win-pc（192.168.32.53）两次 SSH 连接超时，未执行 Windows 真机测试；交付可在该机重跑的真实 Electron 脚本。
- 质量门和可验边界见 docs/acceptance/20261012-local-file-access.md。产物仓 pin 不改，当前分支使用源码构建；不发布版本。

## 2026-10-13 验收问题修复

在同一独立 worktree 和分支完成后续 5 项审查问题，失败测试先于修复分别提交：壳 `968ef62`，前端 `6b29e2ced5`。

1. HTML 预览按稳定 frame 身份保留来源，接入导航拦截、唯一请求门和凭据过滤；覆盖文档/进程变化、跨窗口、grant 释放和顶层文档清理。
2. ZIP 统一真实工作区及目标父目录，目录别名下仍排除输出及临时文件。
3. 本机搜索错误可见且可重试；上下文变化清空结果并作废旧请求。
4. 工具路径拆分保留 Windows 根目录分隔符；外部预览兼容裸盘符。
5. 本机明确选中的符号链接允许 Markdown、HTML、OpenUI 与只读代码预览；远端链接和自动资源越界边界保留。

本轮质量门、提交与实际环境范围见 `docs/acceptance/20261013-local-file-access-fixes.md`。

## 2026-10-15 恢复开启与 Windows 验收

原分支已全部合入 release，但 release 为 3.0.14/3.0.15 在 `672ca584` 强制关闭了该特性。本轮在同一 worktree 将壳与前端的 `codex/local-file-access` 分别 fast-forward 至 `release/v3.0.x`（`25aea924`）与 `feat-2026.9.30`（`b30f4ae17`）后继续：

1. 移除硬门控，恢复 `features.local-files.enabled` 覆盖 ?? 默认开启；先写三态失败测试再改。
2. Windows 实机（win-pc 现址 192.168.32.235）真实 Electron 验收 17/17 通过；补宿主路径语义检查、`--bundle-only` 与 Windows 运行器。
3. macOS 经真实 nuwax-file-server 1.5.8 的列表/搜索纳入 runtime 验收（18/18）。
4. 前端无需改动，壳不改前端/产物 pin。

仅商业版（`products: ["nuwax"]`、overlay 托管，前端按 `getProduct()==='nuwax'` 探测），社区版不受影响。仍在开发分支、未提测；提测前须完成真实账户与安装包人工验收，合入 release 后商业版默认开启。详见 `docs/acceptance/20261015-local-file-access-reenable.md`。
