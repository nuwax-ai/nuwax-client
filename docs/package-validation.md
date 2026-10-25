# 独立打包验证

正式发布只有 Beta 与 Stable。Beta 使用 `release-electron-dev.yml` 的 Beta tag 触发路径，Stable 使用既有正式版流程。验证不占用版本序列，不创建 tag/Release，不上传 OSS，不改更新指针。

`package-validation.yml` 是独立流程，只允许 `codex/` 或 `validation/` 分支。支持手动触发；在流程尚未注册到默认分支时，可用仅修改 `.github/package-validation-request.json` 的显式请求提交启动，提交标题必须等于固定系列名，请求内容必须与启动身份一致。分支请求默认沿用 `v3.0.23-beta.3`、双平台。输入一个已存在的 Beta/Stable tag，应用版本原样沿用该基线；产物另以源码 SHA、run id、attempt 标识。源码 SHA 与基线 tag 的 SHA 在 `validation-context.json` 分开记录，验证产物不声称自己是该 tag 的官方发布包。

- 只读仓库/Actions 权限；不传入 GH_PAT、SimplySign 或 OSS 发布凭据；并发组与发布隔离。Mac 私有验收需要现有 Apple Developer ID 与公证凭据，只在临时 keychain/文件使用，结束清理。
- 复用现有本地 `pack` 准备、品牌及资源核验，明确 `publish never`。Mac ARM64 在私有路径预签 helper/capture，再签应用、公证并打 ZIP/DMG；签名、公证或系统核验失败即停止。Windows x64 仅 NSIS EXE，沿用 Beta 的无签名策略。
- 前端统一消费已提交的 `nuwax` / `nuwax-dist` 配对 gitlink，走 `dist` 准备与打包；不逐平台重建。标准准备入口检查源码 checkout、产物 checkout/clean 状态和源码戳，冻结上下文另记录两个 SHA、模式及 stamp。安装后还须核对包内前端文件清单。正式 Beta 的源码构建策略不变。
- 输出仅为 7 天 Actions artifacts：完整安装包、上下文与 SHA256；不上传 MSI、更新 yml、blockmap 或 release provenance。下载后须先核对源码与哈希。
- 无签名构建不能替代 Mac 系统权限与 Computer Use 验收。私有签名包只可安装到用户明确授权的验收设备，不上传正式分发路径或公开更新源；官方 Beta 发布后的包身份和更新指针仍须单独回读。
- 同一 `validation_series` 固定对应同一个问题，如 `pr-66-cua-3023`。跨 commit、新 run 和 rerun 合计最多 4 次启动；成功应结束验收，取消和失败也占一次。历史不可读时停止。仅重跑 matrix job 也要先查上限。
- 达到上限后保留日志、产物、已查明原因与未完成项，停止构建和自动重试；不得通过换版本、源码 SHA、series 或 workflow 绕过。需要用户明确重新启动验收后才能建立新的验证系列。

2026-10-25 首轮按用户要求停止 QA.5。随后用户明确重新授权独立验收，最多四次，通过后发布 Beta.4，PR 不合并。新系列固定为 `pr-66-cua-3023-restart-20261025`；原 QA 历史保留，不伪装为本轮成功证据。所有 push/dispatch/rerun、失败及取消统一计入本系列四次上限。

2026-10-25 后续最新授权：版本号不动，暂时不要发布。继续联合候选的独立验证、Windows EXE 实包验收并保留截图日志；此前“通过后发 Beta.4”已被覆盖，客户端 PR 仍不合并。当前系列已用3/4次，最后一次仍受原上限约束。
