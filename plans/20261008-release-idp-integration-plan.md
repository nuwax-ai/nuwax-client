# 发布与桌面 IdP 分支整合

用户要求 beta 打包前合齐 codex/release-channel-rules、codex/desktop-idp-20261008，目标为现有 release/v3.0.x。

- release-channel-rules 已经 PR #14 合入远端发布线 65ef6502；隔离分支 codex/release-idp-beta-20261008 从该提交整合 desktop-idp-20261008@debca8ba，保留原 worktree 与壳 WIP。
- 合入内容：受信业务域顶层授权/绑定导航保持业务 origin；iframe/XHR 与凭据门禁不放开；公开 beta 原生数字版本与完整 DMG 文件名修复；本地 IdP fixture。
- 当前前端 pin 307a3d6b2 不包含新的桌面 IdP 页面。本次先按用户点名的两条客户端分支整合，沿用当前前端 pin；配套前端源码/dist 属于额外范围。若用户在创建 tag 前选择纳入，则补齐双 pin 后重新验证。不把网关策略或 fixture 通过描述为已交付完整三方登录。
- 原 v3.0.11-beta.1@177e9fca 的 Actions run 37745492545 已按用户调整顺序取消，三轨门禁成功、构建/公开同步未执行。原 tag 与 Draft 保留并占用序号；合并源码后候选为 v3.0.11-beta.2，发布前重查远端占用。
- 整合后运行脚本、社区、商业质量门与 check:pin，执行三问质量自查。提交/推送并通过 PR CI 后合入发布线，再推新 tag 由 GitHub Actions 五平台打包和自动 beta 同步。
- S3 服务端 SHA256 路径及计时在新 beta 的实际同步阶段验证；stable/latest.json 必须仍为 3.0.10，beta 两镜像字节一致并升级到新版本。

## 补齐 client-followups-20261007

用户再次指定 codex/client-followups-20261007。前两分支已通过 PR #15 合入 release/v3.0.x@ae625ba5；在隔离分支 codex/release-followups-beta-20261008 合入 followups@fdb61759（含 Windows 独立卸载修正和假文件夹具），不提交其 worktree 内未提交的基座改动。

v3.0.11-beta.2@fdefc2ba 的 run 37749699954 已取消，三轨门禁通过、五平台构建取消，Draft 无资产，公开和镜像同步未执行。该 tag 保留并占用序号。补齐分支后候选改为 v3.0.11-beta.3，重新通过质量门和 PR CI、合入发布线后重查远端占用并推 tag。

复跑 win-pc 上只使用 Temp UUID 假 payload 和独立 HKCU fixture key 的卸载夹具，核对锁文件失败、解除锁后重试、正常删除、缺失卸载器提前停止；不运行真实 Nuwax 卸载器。复跑脚本、社区、商业和 pin 门禁，审查 customRemoveFiles 对 vendor 升级分支及错误返回路径的兼容。
