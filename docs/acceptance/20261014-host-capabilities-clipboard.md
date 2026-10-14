# 客户端能力探测与采集复制验收

日期：2026-10-14，Asia/Shanghai。实现分支：`codex/host-capabilities-clipboard`。收尾时已快进到 `release/v3.0.x@37686275`，以纳入刚合入的本地文件 API 和 Computer Use 基线；没有改写 release 历史或替换已安装客户端。

基座 pin：`e75c9d5cd334e203520aaee6fecb6c84ed4561e5`；前端基线 pin：`7cd54922b58ed68b80141db1932a5d153ac41548`。公共类型已提交到前端分支 codex/host-capabilities-clipboard（282a0def4f），本批次客户端提交同步生成快照并更新该源码 pin。新增 canUse/copy/预览复制尚未发布，已发布的 beta.6 不包含这些改动。

## 实现范围

- `NuwaClawBridge.canUse(name)`：完整公共能力白名单、实际方法存在性、当前受信顶层文档/代次、功能开关与注册状态；capture 细分 PNG/JPEG/MP4/GIF/WebM，localFiles 读取实时登录/本地服务身份。
- `capture.copy(resultId)`：公共/壳独立通道，结果所有权检查；截图写图片，GIF/MP4/WebM 写原文件。复制文件持有独立缓存，不被原结果 release 删除，按 24 小时清理。
- 三平台文件剪贴板适配分别封装；主进程通过特性公共入口取得平台支持信息，不越层引用内部实现。
- 预览增加复制图标与文字、loading、成功/失败提示；重复点击、保存/关闭竞争、卸载期间迟到结果得到覆盖。录制控制窗关闭原生阴影，保留选择预览窗的阴影。
- IM 文档：说明固定发起会话、读取为 File 与复用现有草稿桶；按用户要求面向 Agent 直接实施，不要求拷贝示例、类型或 SDK。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `npm run test:commercial`（最新 release 基线） | 2967 通过，18 跳过 |
| `npm run base:test`（隔离副本、同一 e75 基座） | 1625 通过，18 跳过；未在原工作区清 overlay |
| `npm run test:scripts` | 335 通过，包括公共契约编译与模块边界检查 |
| 独立 IM 示例 `node --test docs/examples/im-native-capture.test.mjs` | 15 通过（保留原有内部验证，不作为交接依赖） |
| 主进程/全部 preload bundle | 通过 |
| renderer Vite 构建 | 通过；已有大 chunk 提示 |
| 契约快照、overlay 一致性、`check:pin`、diff 空白检查 | 通过；基座改动均为 overlay 同步产物 |
| 独立公开类型 TypeScript 编译 | 通过 |
| 全仓 `tsc --noEmit` | 最新 release 原样基线与本批次均有 236 个既有错误；归一化错误文件/编号/内容后新增 0。不能宣称全仓 TypeScript 通过 |

首次全量测试发现隔离工作树缺少 MCP 资源产物，补齐相同依赖产物后通过；脚本门禁发现复制失败返回类型过宽和一次跨特性内部导入，已修正为 CaptureFailure 和特性公共入口。原工作区依赖缓存曾被复用链接上的安装脚本影响，已按其当前锁文件恢复并核对声明版本；实现工作树已使用独立商业依赖目录。

## 原生剪贴板验证

使用生产 `createCaptureClipboard`、ResultStore 和平台适配，生成测试 PNG/JPEG、1 秒 MP4 和动画 GIF。在 Electron 40.8.2 的隔离 profile 中，将结果复制后立即 release 原结果，再经 Chromium 原生 paste 事件读取 File；视频/GIF 比较完整字节哈希。缓存目录还包含中文、空格、`$()` 和 `#`，用于验证路径编码/参数传递。

| 环境 | PNG/JPEG | MP4 | GIF | release 后原生粘贴 |
| --- | --- | --- | --- | --- |
| macOS arm64，Electron 40.8.2 | 图片 | 文件、video/mp4 | 文件、image/gif | 全部通过，录屏字节一致 |
| win-pc 192.168.32.235，Windows 26200、登录桌面，Electron 40.8.2 | 图片 | 标准 FileDrop | 标准 FileDrop | 全部通过，录屏字节一致 |
| swufe Linux 真机，Ubuntu 24.04、独立 X11/xrdp 桌面，Electron 40.8.2 | 图片 | text/uri-list 文件 | text/uri-list 文件 | 全部通过，录屏字节一致 |

源码 fixture：`overlay/crates/agent-electron-client/tests/capture-clipboard.electron.ts`。证据位于工作树忽略目录 `artifacts/host-capabilities-clipboard/{macos,windows,linux}/report.json`；报告不包含原剪贴板内容。Windows 临时计划任务和 SSH 复用连接已清理，独立窗口/profile 已退出。

本次验证覆盖新增复制链路，不等于在三个安装包中重新验收完整屏幕采集；新复制入口的 Linux Wayland、第三方聊天应用、IM 实际上传发送及后续安装包还需验收。已有截图/录屏平台记录见 [基础记录](20261012-native-capture-dev.md) 与 [Linux 记录](20261013-linux-native-capture.md)。

## 三问自查

| 问题 | 结论与证据 |
| --- | --- |
| 功能内聚 | 复制副本、TTL、并发与原件保留在 `main/features/capture/clipboard.ts`；结果归属及会话取消在 capture/index.ts 的 COPY 通道。组件只持预览与交互状态 |
| 分层 | shared/hostCapabilities.ts 为统一白名单，preload/canUse.ts 为消费探测，nuwaxBridgeHandlers.ts 为主进程信任门禁；各端命令封装在 platforms/clipboard，通过 features 公共入口汇合。公共类型由前端事实源生成，IM 文档不要求导入宿主模块 |
| 维护性 | 未知能力、缺方法、旧宿主、查询失败均关闭能力；原生 copy 验证原件释放后的粘贴；输入通过固定参数/JSON stdin，生命周期和重入有真实测试。新增平台只改适配器，IM 的会话 ID 不进入客户端协议 |

三问自查通过，测试门禁通过，可供后续代码评审；这是 writer 自查，不是 PR 批准。交接见 [IM 指南](../nuwax-im-native-capture-integration.md) 与 [能力目录](../host-capabilities-api.md)。

## 提交与交接

代码提交到 codex/host-capabilities-clipboard，未合入 release/v3.0.x、未推送或发布新安装包。预览按钮是客户端菜单/设置发起采集后弹层里的复制入口；现有 beta.6 仍没有此按钮。交接仅提供能力/API/IM 指南，不要求同事 Agent 使用配套示例或类型文件。
