# macOS 公证与票据重试

beta.5 Intel 首轮因 notarytool 查询网络无路由失败；第二轮已通过签名和公证，stapler 调用 CloudKit 时连接中断（NSURLError -1005、Error 68）。四个其他平台已构建成功。旧流程在 electron-builder 内公证后，再由 afterSign 重签并再次公证，任一网络异常都丢失整包构建结果。

1. 签名构建只生成 `.app`，禁用 builder 自动公证，并仅在该子进程中清空旧 afterSign 的公证凭据；保留原有原生二进制/JIT 签名和 seal 恢复。
2. 单独执行 notarytool submit/info 与 stapler staple/validate，网络故障有界重试。记录 submission ID 和签名 CDHash，使同一个未改动 app 能从已有公证状态续跑；Invalid、身份错误和签名错误立即失败。
3. 公证与票据校验成功后，使用 electron-builder --prepackaged 生成安装包，避免重新签名或改动已嵌票据 app。稳定和 beta 共用一份脚本。
4. CI 公证失败时保存签名 app 和状态为临时恢复 artifact，保留后续独立安装包签名/资源/来源门禁。恢复 artifact 不进入公开 Release。
5. 测试验证只提交一次、网络断开后复用 ID、坏签名/Invalid 不重试、票据失败阻止分发、源码变动拒绝复用，以及 workflow 先公证再分发的顺序。源改动采用新 beta tag，beta.5 不重写。
6. macOS 15 Intel 的独立测试在多轮真实 CloudKit 请求中持续断连；macOS 26 Intel 对照完整通过。Intel 发布 runner 改为官方已支持的 `macos-26-intel`，编译目标固定为当前 Electron 40.8.2 的 `LSMinimumSystemVersion=12.0`，保护旧系统兼容性。已验证票据的 app 续跑只验证现有票据，不重新下载。

这属于发布工具 BUG 修复，不改变截图与录屏 API，也不绕过签名、公证或安装包验收。

## 实证与质量门

- [macOS 26 Intel 原生验证](https://github.com/nuwax-ai/nuwax-client/actions/runs/38427438162) 完整通过：真实签名、单次 Apple 提交、模拟网络断开后的重试、既有票据复用、DMG/ZIP、Gatekeeper。
- [macOS 12.0 最低目标复核](https://github.com/nuwax-ai/nuwax-client/actions/runs/38428904821) 也完整通过：macOS 26 Intel 原生 Mach-O 的 `minos` 为 12.0，随后真实签名、公证、票据、安装包和 Gatekeeper 均通过。生产工作流在所有原生依赖编译前设置该目标。
- [Apple Silicon 原生验证](https://github.com/nuwax-ai/nuwax-client/actions/runs/38423736819/job/115387533147) 同样通过；该 run 的 macOS 15 Intel 未整体通过，不能合并宣称整条 run 成功。
- macOS 15 Intel 的第一轮首次公证/票据校验通过，重复 staple 时断连；移除重复下载后，另一轮在首次 staple 持续断连并按重试上限失败。错误始终为 CloudKit NSURLError -1005/Error 68；没有降低校验条件。
- 脚本全量 331 项通过；后续签名变化和既有票据复用回归补充为该域 9 项，捕获发布顺序仍受工作流测试约束。
- 维护性：公证状态、重试与签名/票据防护集中于一份 macOS 发布脚本；工作流只编排阶段。基座 hook 继续负责原生二进制签名，不复制或修改基座实现。恢复状态无凭据，并放在 app 旁而非公共资产上传根目录。
- 旧 tag 恢复仍按五个 OS/架构组合判断，不把当前 runner 标签硬套到历史 tag；额外的通过任务也不能补偿任一必需平台失败。相关域最终 58 项通过。
- 合并前最终脚本全量 334 项通过，overlay/pin/diff 守卫通过。客户端业务、截图/录屏公共 API 与三处子模块工作区改动均不纳入本批提交。
