# 实施计划：统一版本与 stable/beta 通道

- 对应 spec：specs/release-channels.md
- 状态：代码、CI、stable 3.0.10 / beta.6@a5197d98 发布与镜像同步完成；beta.6 真实安装、升级及 GUI 验收待用户验证

## 实施顺序

1. 隔离外层与基座，保留原工作区 WIP；统一版本解析、历史序列和发布 CLI。
2. 修改 Actions 互斥路由、提前校验、独立检出工具与目标来源；实现两通道镜像事务。
3. 基座放开 beta.N 更新校验，设置预发布/降级行为；签名脚本支持显式目标 tag。中立改动合入基座 main 后更新外层 pin。
4. 更新发布文档和全部入口说明；先定向测试，再社区/商业质量门、check:pin、三问质量自查。
5. 验证安装包版本与升级；按 v3.0.10 兼容正式版 → v3.0.11-beta.1 顺序安排实际发布。

## 测试与回退

版本/CLI/Actions/来源/镜像事务测试，基座更新器和脚本测试，隔离的 base:test 与 test:commercial。事务备份并回滚原指针；代码回退不移动已存在 tag，源码修复使用新版本。

## 偏离与验收记录

实施结束补充实际测试数字、基座/外层提交与 PR、安装包验收结果和未完成的外部条件。


2026-10-08：基座中立修复通过 PR #25 合入 main（d078bb3cd87eb111a38299bb23d9dff819f53c13），商业 pin 跟随 main。集成远端 3.0.9 已提交修复和前端双 pin，未纳入原工作区 WIP。质量三问与本地验证见 docs/acceptance/20261008-release-channels.md。用户指定优先通过 GitHub Actions 执行完整 stable 流程，目标 v3.0.10。

签名上传续跑修复通过基座 PR #26 合入 main，4 项实际 bash/gh 成功和失败测试通过。同步元数据使用固定 Release 创建时间，禁止网络失败时生成变化时间戳。

Windows 签名机职责收敛为下载、缓存/下载哈希验证、签名、验签、上传；当前已提交签名工具由外层通过 SSH stdin 提供。应用来源校验留在外层，签名机无需源码、子模块、overlay 或 npm 安装，并保留 tag/SHA 缓存供失败续跑。

2026-10-08：v3.0.10 的 GitHub Actions 五平台构建与 win-pc EV 签名完成；Mac arm64 / Windows x64 的真实安装、业务页、完整退出重启及原订阅保留通过。Windows 安装慢的 I/O 与 7z 写盘证据已补入既有 NUW-21。镜像同步 run 37741910045 正在执行；其余真实设备与 beta.N 链路验证边界见验收文档。

追加性能修复：run 37741910045 已成功；Verify S3 upload 串行完整下载耗时 5 分 22 秒。新增共享 SHA256 服务端校验/历史完整读回模块；上传固定 classic/8 MiB 分片，来源清单绑定完整 hash 与服务端 composite hash。CI、CLI 去除新资产重复下载，历史回读限制四路并发。覆盖分片边界、同尺寸损坏、校验值缺失/错误、流失败、并发失败收敛；更新文档并在 beta Actions 实测收益。

2026-10-08 beta.6 追加记录：用户明确指定最新 release/v3.0.x 源码重新打 beta.6，对尚未公开的本轮候选作例外重定向。原 run 37781815290（b3d942a6）已取消，原零资产 Draft 删除；绑定旧 SHA 的 force-with-lease 将 tag 更新为正常提交、推送的 d1749fce。run 37783268381 三轨门禁成功，但两个 Mac 成品来源记录因 lipo 参数顺序错误失败，公开/同步跳过；15 个 Windows/Linux 资产完整保留在 archive-beta6-d1749fce 的未公开 Draft。修复 a5197d98 仅改 workflow/test、业务源码和三个 pin 不变，22 项定向测试及真实 lipo 架构检查通过；绑定 d1749fce 的 lease 继续本轮未公开候选重打。默认 tag 不可变、源码变化升号规则保持，例外仅限本次用户指定的未公开候选。新 tag push run 37792419346 最终全部成功；历史尝试、冻结来源、三个 pin 与验收边界详见 docs/acceptance/20261008-release-channels.md。证据分支正常 merge 最新 release 后独立提交，保留已推送历史，后续文档合入不改变已发布 beta.6 tag。

beta.6 新候选构建结果：run 37792419346 的三轨与五平台均成功，五份来源清单核对外层 a5197d98、基座 d078bb3c、前端 4dfea90cd 和 stamp 4dfea90cd；12 个安装包文件名均为完整 beta.6 版本。真实 Mac 解包模块存在、lipo 双架构、模块/整 app 签名、公证与 Gatekeeper 均通过；level 1 生效，arm64/x64 ZIP 观测间隔约 6 分 38 秒 / 5 分 57 秒。Windows NSIS/MSI 构建成功，EXE 仍为 unsigned beta；真实安装/升级/GUI 由用户验收。

beta.6 同步完成：job 113395450302 成功，Release 于 2026-10-08 15:41:02 UTC 公开为 prerelease、29 资产；CLI 退出 0。GitHub/S3 的 29 资产均校验，S3 Verify 7 秒（12 COMPOSITE、15 FULL_OBJECT、2 小 JSON 完整读回），全资产上传仍为 306 秒。OSS 校验平台 yml/latest.json 与通道指针，不存放安装包，下载仍从 S3。独立回读确认 stable 双镜像保持 3.0.10 发布前原字节，beta 双镜像推进至 3.0.11-beta.6 且字节一致；SHA256、时序与来源证据已补入验收文档。代码、CI、发布和同步完成，真实客户端验收待用户；归档 d1749fce 的 15 资产继续保留未公开 Draft。
