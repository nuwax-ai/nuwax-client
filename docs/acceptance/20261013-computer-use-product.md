# Computer Use 发布验收交付记录

日期：2026-10-13。分支：`codex/computer-use-product`。起始基线：`1e1df379de76dc084ae311c55e9ccbc83662791c`。基座保持 `484ff6b36e73c21c0a5dc1b01aeae9fb6d07c106`。

## 交付状态

对齐的实现项已落地：可信会话隔离、任务运行控制、窗口范围约束、跨应用浮窗、密钥与诊断、资源回收。自动化检查及 macOS 本地打包通过。用户已完成钥匙串授权，Developer ID 签名成功；主程序及 helper 同属 Team `89GQ2RJVW7`，整包 `codesign --verify --deep --strict` 通过。未创建公开发布 tag、未改更新源、未合并发布分支。

- 独立 worktree：`/Users/apple/.codex/worktrees/computer-use-product/nuwax-client`。
- 本地版本：`3.0.13-dev`，Electron `40.8.2`，macOS arm64。
- 已生成未签名目录：`release/computer-use-acceptance/mac-arm64/Nuwax.app`。它用于构建复查；其临时签名 helper 无法通过打包态 Team 校验，不能冒充可用的正式 CUA 验收包。
- 已签名验收目录：`release/computer-use-signed-acceptance/mac-arm64/Nuwax.app`。主程序标识 `com.nuwax-ai.nuwax`，helper 标识 `com.nuwax-ai.nuwax-computer-use`，均使用公司 Developer ID Application 并开启 hardened runtime；尚未公证，供本地发布验收。
- 验收压缩包：`release/computer-use-signed-acceptance/Nuwax-3.0.13-dev-cua-arm64.zip`，718,466,330 字节（约 685 MiB）；`unzip -tq` 完整性校验通过。SHA256：`74874735cc9359bf2ef1bf06d6413608c293f4ee6910eba9e7e8ccd253d4c3fe`。同目录保留 `SHA256SUMS`、`provenance.json`、签名详情和运行验证日志。
- 包内 `dist/main/main.js` 和 `dist/preload/cuaControls.js` 与本批次构建文件逐字节一致；ASAR SHA256：`d63563735079fc04a370803a6158427a41d072820c225d4c588e807d3855f09a`。
- 前端源码 pin 保持 `9cb90aa2f0d2698924ca3217463c698f3857ee4b`，产物 pin 改为 `f341771e5f2bb7e5e3146573827766e751fdb918`，已推送产物仓 `codex/computer-use-product-dist`，CI 可取到该提交。

## 已完成的实现

| 对齐项 | 最终行为与证据 |
|---|---|
| 同项目多会话 | ACP new/load/resume 签发独立凭据；仅 prompt 活跃期可调用。取消/删除/销毁同步撤权，迟到完成不能撤销新代次。真实 ACP 引擎测试覆盖 new/load/resume、取消、销毁和不确定请求不重试；真实本地 socket 测试覆盖会话争用与撤权拒绝 |
| 限定窗口 | 主进程验证所选窗口；宿主参数门禁和 helper 托管策略同时限制 pid/window_id。仅观察、元素点击、设值、滚动；拒绝像素、键盘、剪贴板、浏览器/进程工具。重启保留窗口模式，清空过期 native ID，必须重新选择；保存失败保持原范围 |
| 可见及可控 | 常驻跨应用浮窗、宿主控制条、设置页、托盘与 `CommandOrControl+Shift+F12`；暂停会停止驱动，恢复重新握手并要求新观察，停止后旧凭据重连不能绕过。浮窗不抢焦点、导航封闭、最小 preload、精确 sender/frame/url 校验 |
| 任务约束 | 单一桌面所有者，动作单飞；100 次工具调用、15 分钟总预算、5 分钟空闲暂停、连续重复写动作限制。首次/恢复/每次写入后必须观察；不透明轨迹回放禁用，带 CUA 权限的整段 prompt 不自动重试 |
| 生命周期和资源 | 登出/换域/退出/系统锁屏处理取消。凭据最多 256 份、网关最多 32 个连接、消息与超时有界；引擎销毁清凭据，启动仅清理已退出进程的已知 capability 文件；正常任务结束回收 helper 传输租约，停止会话录制/光标等资源 |
| 模型与隐私 | 任务使用会话模型。独立视觉诊断用合成红色图片验证识图，不上传用户截图。历史明文密钥迁移 safeStorage，UI 不读回密钥，换地址清旧 key，拒绝 Linux basic_text。helper 遥测关闭 |
| 记录与清理 | 内存最多 100 步，可清除/导出脱敏 JSON；不存参数、截图、输入、URL、剪贴板、窗口标题、密钥。显式录制输出属于调用者指定文件，不作为日志自动删除 |

“限定窗口”限制直接工具目标，不是 OS 沙箱；目标应用自身响应操作而打开其他窗口属于该应用行为。“任务结束”不代表业务结果成功，需要模型和用户核对结果。

## 自动化与构建证据

| 检查 | 结果 |
|---|---|
| 最终 `npm run test:commercial` | 219 文件通过、1 跳过；**2773 测试通过、18 跳过** |
| 隔离副本 `npm run base:test` | 133 文件通过、1 跳过；**1611 测试通过、18 跳过**。基座 pin 未改变；在 `/private/tmp/nuwax-cua-community.xKwk9I` 运行，没有清本 worktree overlay |
| `npm run test:scripts` | **294/294 通过** |
| `npm run check:pin` / `npm run overlay:check` | 252 个基座脏文件全属 overlay；0 待同步 |
| 会话资源循环 | 1000 次签发/执行/结束/删除后凭据数和文件数为 0；256 份上限拒绝新增；30 次真实 socket 重连/完成/销毁通过 |
| 原生 helper 托管策略 | 错 pid、错 window_id、缺 element_index 均由真实 helper 在输入前拒绝 |
| 原生 MCP 协议 | 初始化、只读工具、暂停拒绝、daemon 重启、透明重连、恢复、停止拒绝通过 |
| 真实 Electron 浮窗 | 按钮、登录门禁、外来 sender 拒绝、文本安全渲染、关闭急停、窗口与订阅清理通过 |
| 主进程 esbuild / renderer Vite / 固定前端构建 | 通过，保留既有大 chunk 提示 |
| 默认 `npm run pack -- --dir` | 通过；前端戳与源码 pin 已一致，379 个组件的 macOS 实际随包声明严格检查 0 问题 |
| 签名候选包 | electron-builder 退出码 0；app/helper Developer ID 同 Team 且 hardened runtime；整包严格深度签名核验通过；签名后内嵌 helper 的真实策略与协议冒烟通过 |
| `git diff --check` | 通过 |
| 主进程/全库 TypeScript | 分别 6 / 238 处既有诊断，与同 pin/同依赖基线一致；没有新增诊断文件/代码组合。全库 tsc 不是全绿，不能写成“通过” |

两项可重跑实机夹具：

```sh
node scripts/acceptance/cua-runtime.cjs '<Nuwax Computer Use binary>'
node scripts/acceptance/cua-controls.cjs /tmp/nuwax-cua-control-validation
```

helper 冒烟使用独立临时目录、端点、token，只清自己的 PID；为避免触碰用户桌面，测试以 `--no-permissions-gate` 启动，窗口约束用不存在的目标 ID。没有验证 AX/SR 授权或真实输入，不将它与模拟 Agent 的引擎测试合称“真实模型端到端验收”。Electron 浮窗使用真实 preload/IPC 和模拟任务，不连接生产账户。

日志：`/tmp/nuwax-cua-commercial-final.log`、`/tmp/nuwax-cua-community-tests.log`、`/tmp/nuwax-cua-script-tests-final.log`、`/tmp/nuwax-cua-native-policy.log`、`/tmp/nuwax-cua-controls.log`、`/tmp/nuwax-cua-package.log`、`/tmp/nuwax-cua-signed-package.log`、`/tmp/nuwax-cua-signed-helper.log`。浮窗截图：`/tmp/nuwax-cua-control-validation/floating-controls.png`。

## 打包阻断的处理

1. 原双 pin 的产物戳 `6f3985583f` 与源码 `9cb90aa2f` 不符，已按固定源码重建并新增产物提交；没有改写历史提交或更新源码 pin。
2. 已登记的随包二进制/预编译资源缺声明，按固定源码、实际安装包 metadata 和许可证正文补齐。新增 npm 精确版本证据入口；换行 MIT 文本现可正常识别，未知许可证仍拒绝。
3. Windows 既有 PortableGit 单独登记 GPL-2.0-only 及源码版本；明确保留其上游声明，不更改 Git 的许可。声明扫描通过只代表工程清单校验，不代替法务判断。
4. 本地默认 `pack` 为未签名包，产品 helper 要求 Team `89GQ2RJVW7`；因此另生成同 Team 签名候选，用户授权后已完成并严格核验。正式分发仍需公证；本地签名候选不等于正式分发验收。

来源记录：许可证正文保留于 `third-party/licenses/`，版本和源码地址在 `third-party/manifest.json`。uv、ttyd、Git 使用固定版本上游许可证；其他组件取固定源码或对应安装包内的实际许可证。没有因工具门禁失败而跳过严格声明检查。

## 发布验收清单

签名候选已就绪。验收前退出正在运行的 Nuwax，再从本候选包启动，避免复用旧版本进程。验收者执行以下动作并记录通过/失败及诊断文件：

1. **首用和权限**：新用户安装、开启电脑操作；拒绝 AX/SR 后有明确提示且不能执行；授权后自检就绪；系统撤权后停止并提示恢复。重启保留开关偏好。
2. **真实任务闭环**：在测试文档中让实际会话模型读取、修改并重新观察；核对内容及结果判断。选择不支持识图的模型时不得伪报成功。
3. **两会话与取消**：同项目两会话同时请求操作，仅一方执行；取消当前任务后迟到动作不执行；新任务只能使用自己的凭据。删除会话、登出、换域及退出均能停止。
4. **窗口范围**：选择测试窗口，只在该窗口观察和操作界面元素；像素/热键/跨窗请求被拒绝；关闭目标窗口后不落入其他窗口。重启要求重新选择，切换到桌面必须由设置页主动执行。
5. **接管**：切到其他应用仍看得到控制窗；暂停、手工改变页面、恢复后必须重新观察；分别测试浮窗停止、快捷键和托盘停止。锁屏/休眠后不自动恢复，快捷键冲突时仍有可见急停入口。
6. **异常/资源/数据**：断模型网络、结束 helper、快速取消恢复；不得自动重放不确定动作。8–24 小时真实任务中观察 CPU、内存、句柄、子进程和显式录制文件；导出的诊断不含页面内容、窗口标题或密钥。
7. **平台包矩阵**：macOS 新装/升级、多显示器/缩放及正式公证包；Windows 管道、DPI、多屏、UAC/安全桌面、新装/升级/卸载；Linux X11/Wayland、快捷键和系统密钥环。当前本机只生成 macOS arm64，其他平台使用既有发布流水线产物验收，不能据此标成已通过。

## Writer 质量自查

- 内聚：状态机仅负责任务不变量（`overlay/crates/agent-electron-client/src/main/services/cua/taskController.ts:18`）；会话授权在 `sessionAuthority.ts:10`，窗口规则在 `windowScope.ts:13`，资源编排在 `computerUse.ts:1008`。结束、取消、销毁均走同一授权撤销入口。
- 分层：ACP 引擎依赖无 Electron 的会话门禁；renderer 只用受控 IPC（`overlay/crates/agent-electron-client/src/main/ipc/cuaRuntimeHandlers.ts:12`）；浮窗独立最小 preload（`overlay/crates/agent-electron-client/src/preload/cuaControls.ts:3`）；全部商业改动经 overlay 注入，基座 pin 不变。
- 维护：错误/动作文案共用 `overlay/crates/agent-electron-client/src/shared/cuaPresentation.ts:1`；策略白名单与范围生成同源；新增接口/生命周期有行为测试，真实协议夹具可重跑。修复了停止后重连、旧 prompt 完成、保存失败、整段 prompt 自动重试、租约泄漏边界。
- Writer 侧实现与自动化检查通过；不构成 PR 自批或正式发布验收通过。

Nuwa Browser 整合继续按今晚独立调研任务处理，本批次没有提前耦合其 Space/浏览器协议。
