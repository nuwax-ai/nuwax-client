# release/v3.0 Windows 安装性能与签名核对

## 范围与分工

- 用户要求 3.0 小步增强，保留现有 WIP，暂不发布。起点为 `470a5373`，任务分支 `fix/windows-install-performance-3.0`。
- 本任务回移商业 #31 的首装 ZIP 直接解压、normal 压缩和独立 EXE blockmap；保留 3.0 的前端、产物、基座 pin 及现有签名/发布保护。
- 安装恢复、卸载与恢复快照清理由“梳理 Windows 安装异常处理方案”（任务 `01a159ae-4688-7e53-9ca8-de0357634687`）负责；本任务不修改其恢复脚本和 NSIS 宏。
- 自动端口回移独立 PR #44 先进入 release/v3.0，本分支随后合入最新目标线，保留其基座 pin。

## 实现

- Windows 默认由 7z 的临时解压再复制，切为 ZIP 直接解压到目标目录；压缩从 maximum 改为 normal。macOS/Linux 策略不变。
- ZIP 关闭 builder 的 differential-aware 7z 容器后，额外生成覆盖最终安装包全部字节的独立 blockmap；验证大小、SHA512 与块覆盖，维持更新器差分重建能力。
- 明确 7z-qa/zip-qa 对照入口，QA 必须 --publish never；保持现有 3.0 QA 分支规则，不移入 3.1 的其他工作流变化。

## 验证与边界

- 相关策略/打包/工作流测试 47 项通过、0 跳过，覆盖实际固定 SDK 配置、blockmap 及真实 HTTP Range 差分重建。完整外层脚本 358 项通过、0 失败；精确 3.0 前端 pin 的宿主契约检查通过。
- 历史全载荷 7z 基线为 638.132 秒；此前 ZIP 包约增加 30.46% 字节，但未完成同机候选安装计时。该历史值不能作为本轮 3.0 提速结论。
- 本轮真实 3.0 全载荷首装、界面响应、升级/卸载及端到端等待仍需隔离安装包验证；与恢复任务协调 Windows 机器使用，不覆盖已安装程序。
- 2026-10-21 对 win-pc 只读检查：已安装 3.0.19 的 Nuwax.exe 为 NotSigned；安装目录无 .sys，近十天 CodeIntegrity 选定阻止事件中未检出 Nuwax。现有发布签名只覆盖安装器，该发现不能证明用户照片中被阻止的具体组件或根因。原始结果留在本地 .cache/validation/windows-security-inventory.json，不提交机器信息。
- 未创建版本号、tag 或发布物，未修改实际安装或系统安全设置。
