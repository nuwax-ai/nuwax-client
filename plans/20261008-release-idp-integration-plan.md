# 发布与桌面 IdP 分支整合

用户要求 beta 打包前合齐 codex/release-channel-rules、codex/desktop-idp-20261008，目标为现有 release/v3.0.x。

- release-channel-rules 已经 PR #14 合入远端发布线 65ef6502；隔离分支 codex/release-idp-beta-20261008 从该提交整合 desktop-idp-20261008@debca8ba，保留原 worktree 与壳 WIP。
- 合入内容：受信业务域顶层授权/绑定导航保持业务 origin；iframe/XHR 与凭据门禁不放开；公开 beta 原生数字版本与完整 DMG 文件名修复；本地 IdP fixture。
- 当前前端 pin 307a3d6b2 不包含新的桌面 IdP 页面。本次先按用户点名的两条客户端分支整合，沿用当前前端 pin；配套前端源码/dist 属于额外范围。若用户在创建 tag 前选择纳入，则补齐双 pin 后重新验证。不把网关策略或 fixture 通过描述为已交付完整三方登录。
- 原 v3.0.11-beta.1@177e9fca 的 Actions run 37745492545 已按用户调整顺序取消，三轨门禁成功、构建/公开同步未执行。原 tag 与 Draft 保留并占用序号；合并源码后候选为 v3.0.11-beta.2，发布前重查远端占用。
- 整合后运行脚本、社区、商业质量门与 check:pin，执行三问质量自查。提交/推送并通过 PR CI 后合入发布线，再推新 tag 由 GitHub Actions 五平台打包和自动 beta 同步。
- S3 服务端 SHA256 路径及计时在新 beta 的实际同步阶段验证；stable/latest.json 必须仍为 3.0.10，beta 两镜像字节一致并升级到新版本。
