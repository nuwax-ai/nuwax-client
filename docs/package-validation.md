# 独立打包验证

正式发布只有 Beta 与 Stable。Beta 使用 `release-electron-dev.yml` 的 Beta tag 触发路径，Stable 使用既有正式版流程。验证不占用版本序列，不创建 tag/Release，不上传 OSS，不改更新指针。

`package-validation.yml` 是独立的手动流程，只允许 `codex/` 或 `validation/` 分支。输入一个已存在的 Beta/Stable tag，应用版本原样沿用该基线；产物另以源码 SHA、run id、attempt 标识。源码 SHA 与基线 tag 的 SHA 在 `validation-context.json` 分开记录，验证产物不声称自己是该 tag 的官方发布包。

- 只读仓库/Actions 权限；不传入 GH_PAT、Apple 签名、公证、SimplySign 或 OSS 发布凭据；并发组与发布隔离。
- 调用现有本地 `pack` 入口，明确 `publish never`；只生成无签名构建验证包。Mac ARM64 为 ZIP/DMG，Windows x64 仅 NSIS EXE。
- 输出仅为 7 天 Actions artifacts：完整安装包、上下文与 SHA256；不上传 MSI、更新 yml、blockmap 或 release provenance。下载后须先核对源码与哈希。
- 无签名构建验证不能替代官方 Beta/Stable 包的升级、系统权限与 Computer Use 真机验收；Mac 验收包须按官方要求签名公证。验证包不得上传到正式分发路径或更新源，不自动安装到用户日用设备。
- 同一 `validation_series` 固定对应同一个问题，如 `pr-66-cua-3023`。跨 commit、新 run 和 rerun 合计最多 4 次启动；成功应结束验收，取消和失败也占一次。历史不可读时停止。仅重跑 matrix job 也要先查上限。
- 达到上限后保留日志、产物、已查明原因与未完成项，停止构建和自动重试；不得通过换版本、源码 SHA、series 或 workflow 绕过。需要用户明确重新启动验收后才能建立新的验证系列。

2026-10-25 本轮已按用户要求停止 QA.5，新的验证流程仅提交源码与本地测试，**未触发构建**。原 QA 构建记录保留为历史失败证据，不能据此宣称最终产品 Agent 验收已通过；PR #66 保持 Draft。
