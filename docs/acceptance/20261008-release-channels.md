# 统一版本与更新通道验收

工作区：隔离 worktree `codex/release-channel-rules`，保留原检出 WIP。基线已纳入远端 `release/v3.0.x` 的 3.0.9 修复（a1e218bd）；前端源码 307a3d6b2，产物 67ac1ad。

## 质量三问

- 功能内聚：`scripts/release-version.mjs:7` 统一语法、身份、排序及占用规则，CLI、Actions 与来源清单共用；`scripts/publish-release-pointers.mjs:19` 集中处理备份、SemVer 检查、镜像写入、回读与回滚。安装包副作用与通道策略留在外层。
- 代码分层：基座只承载通用 SemVer、订阅初始化和签名目标参数；正式标签策略与镜像事务由商业层编排。`release-provenance.mjs:15` 明确区分执行工具与目标源码，历史续跑不依赖旧 tag 中的新工具。
- 可维护：拒绝不规范标签、通道冲突、同版本替换来源及降级；stable 默认停在签名阶段，验收后显式同步。旧标签与社区签名默认行为保留。真实子命令测试覆盖部分上传失败，GitHub Actions 使用统一锁避免两通道并发互相覆盖。

## 验证记录

社区门：1548 passed / 18 skipped。商业门（含最新 3.0.9 overlay）：2230 passed / 18 skipped。overlay:check、host-bridge:check 和本地 check:pin 通过。发布三套 workflow 经 actionlint 1.7.12 检查通过。

上述数量为本地 macOS 全量验证（签名重试修复前）；最终源提交 708a46cc 的 GitHub CI run 37732742041 在 Linux 上社区 1536 passed / 5 skipped，商业 2218 passed / 5 skipped，脚本 231 passed，前端门亦通过。平台用例与 skip 条件不同，数量不直接作为跨平台比较。

基座 PR：https://github.com/nuwax-ai/nuwa-electron-shell/pull/25，GitHub CI 与标题门均通过。已合入基座 main，pin 为 d078bb3cd87eb111a38299bb23d9dff819f53c13；overlay:compat 零重叠变化，远端 purity 通过。脚本全量 231 项通过，包含新增中断回滚用例。

## 实际 stable 验证

用户指定 GitHub Actions 五平台构建，首次使用 v3.0.10，按 Draft → Windows 签名 → 安装验收 → 镜像同步公开顺序执行。Actions run、安装包元数据、验签、真实升级结果及尚未具备的外部条件在后续记录中补齐；单测结果不等同于真实安装验收。

签名上传续跑修复通过基座 PR #26 合入 main，4 项实际 bash/gh 成功和失败测试通过。同步元数据使用固定 Release 创建时间，禁止网络失败时生成变化时间戳。


实际打包已成功：https://github.com/nuwax-ai/nuwax-client/actions/runs/37732833946 ，push 事件 tag v3.0.10，源码 708a46cc3e71783612f08454f9da94d0b9ad607d。确认仅 stable workflow 触发，规范身份校验、社区、商业及前端门均通过，五平台矩阵全部成功。Release 状态为 Draft、非 prerelease。历史 electron-v3.0.9 的同步 run 37731331418 已成功完成。

商业 PR #13 的 CI 三轨均通过，已合入 release/v3.0.x，合并提交 9de6fa245ae1f1ee05735074afbe0dff281b9238；发布 tag 保持原源码 708a46cc，不移动。基座 PR #25、#26 均已先合入 main。

同步前基线（2026-10-08）：S3 与 OSS 的 stable 指针均为 3.0.9、SHA256 c9415920c17973fb3885ee5fdfac0c26fd3a21118b02aa326ab15e8f31dda15f；beta 指针均为 3.0.8、SHA256 9bf784ae8f6e93858d79bcb5f0900e6f604cb45ce7ed762f8c73d5c0097fd7a4。原字节保存在执行机 /tmp/nuwax-v3.0.10-pointer-baseline.json。正式同步将重新读取和校验指针。

真实安装环境基线：Mac /Applications/Nuwax.app 为 3.0.8，已保存 update_channel=beta；win-pc 已安装 Nuwax.exe 为 3.0.7（数字 ProductVersion 3.0.7.0），已保存 update_channel=stable。两台机器分别检查旧纯数字版本升级和用户订阅保留，结果待本次真实安装包就位后记录。

2026-10-08 Windows 真机签名已完成：win-pc 的 Certum EV 签名和 RFC3161 时间戳通过 signtool sign/verify（零错误、零警告），Get-AuthenticodeSignature=Valid。上传资产 Nuwax.Setup.3.0.10.exe，大小 773558056，SHA256 b85b9299accb31fb1ac27a525e727f6490d75db8a4d1c64ac67705aaced05990；签名后才删除 unsigned 资产，Release 仍为 Draft。

签名编排按用户补充要求移除 Windows 源码检出、子模块、overlay 与 worktree 清理，改为通过 SSH stdin 传递当前自动化 pin 的两份中立签名工具。缓存和新下载均先验证 CI SHA256，再签名/验签/上传。38 项发布测试、233 项全量脚本测试通过；包含真实 bash 子命令验证缓存命中、下载哈希不符阻止签名、失败保留资产并清理本次临时工具。check:pin --remote origin/main 通过。真实 win-pc 的 SSH stdin 传输 53518 字节成功，远端 bash -n、node --check 通过，两份工具哈希与已提交对象一致。

Mac arm64 DMG 大小 808928725，SHA256 99e0322bdbaca5f3ea2d26a6d6174a26442a8988fa6667482513e20a40549947，与 CI 清单一致。包内版本与构建版本均为 3.0.10，codesign --deep --strict 通过、spctl accepted/Notarized Developer ID、stapler validate 通过。真实升级与重启验收结果见下文。


## 2026-10-08 真实安装与重启验收

Mac arm64 使用上述 CI DMG 在 Finder 中替换 /Applications/Nuwax.app，3.0.8 升级到 3.0.10。原 update_channel=beta 在升级及完整退出/重新启动后均保留；关于页显示 v3.0.10、Beta 开启。已有登录保留，伙伴消息与资料库正常加载。发布前 beta 指针仍是 3.0.8；没有执行降级安装。旧包保存在执行机 /tmp/nuwax-v3.0.10-acceptance/Nuwax-3.0.8-backup.app。

win-pc 使用已签名 Nuwax.Setup.3.0.10.exe，沿用已有当前用户安装目录。安装完成页未出现错误或回滚提示，安装后 FileVersion=3.0.10、ProductVersion=3.0.10.0，关于页与托盘均显示 v3.0.10。伙伴消息、资料库正常加载；从托盘完整退出（确认 Nuwax 进程已退出）再从开始菜单启动后，登录与原 stable 订阅仍保留，SQLite 只读查询确认 update_channel="stable"。基线读取为 3.0.7，但安装过程曾读到 3.0.9；没有受控的单一旧版本对照，不能将其作为精准的 3.0.7→3.0.10 性能比较。

Windows 安装慢已补入现有 Taskboard NUW-21 评论 ff65bb9d-bb3b-4191-a756-fd748435cf15，供 NUW-41 / NUW-43 跟进。14:44 点击安装到 14:58 观察成功页约 14 分钟，其中约 3 分钟是关闭旧客户端的确认等待，不是纯解压耗时。进程累计读 5897089294 字节、写 7064316819 字节、CPU 约 291.7 秒；安装 resources 共 33576 文件、2457540077 字节。electron-builder 25.1.8 的正式 7z 流程先在临时 7z-out 展开、再 CopyFiles 全树，另复制完整安装 EXE 到更新缓存；散文件与重复写盘是已支持的优化方向。各阶段耗时、杀毒影响、物理磁盘吞吐尚未定量确认，没有测试 ZIP 候选、干净首装或卸载，原问题继续开放。任务状态与原负责对话保持不变。

本轮证据目录：执行机 /tmp/nuwax-v3.0.10-acceptance/（五平台来源清单、公开签名证书信息、两个系统关于页/业务页/重启截图及 Windows 安装 I/O 采样）。截图含真实业务界面，仅留本机，不提交公共仓库。

Windows 签名流程增量三问：下载/缓存失效/签名/上传集中在 release.mjs 的 remoteScript 与基座 v2 签名工具；工具解析 committedSigningTools 只读取 automation SHA 的基座 gitlink，历史应用源码与新工具分别校验；stdin 传输、独占锁、临时工具 EXIT 清理及失败保留安装资产有实际 bash/gh 测试覆盖。d564e49b 的 GitHub CI run 37739720980 三轨通过（脚本 233 项通过），可合并。实际 v3.0.10 签名先于简化 wrapper 完成，使用相同基座 v2 工具；新 wrapper 的真实 SSH 传输/语法/hash 和模拟包流程已经验证，未重复签名或替换既有 v3.0.10 资产。

镜像同步已通过 CLI --tag v3.0.10 --stage sync 启动 GitHub Actions run 37741910045，工具 SHA d564e49b78b720c3fb99cd109f746d9a6123224c，目标源码仍为 708a46cc。最终镜像指针、资产 SHA 与公开状态待运行结束后补记。

验收边界：五平台 Actions、来源和更新/事务/签名脚本测试通过；本轮真实 GUI 安装/重启覆盖 Mac arm64 与 Windows x64。Mac x64、Linux arm64/x64 的真实设备安装、真实 beta.N 连续升级/同号转正以及跨通道切换等待正式版追上，尚未做真实包验证；保持下一轮 v3.0.11-beta.1 的验证项，不能用单测或五平台构建冒充完成。


## stable 同步完成与 S3 性能修复

v3.0.10 镜像同步 run 37741910045 于 2026-10-08 07:27 UTC 成功，Release 已公开且非 prerelease。来源验证、EV 签名复验、S3 全资产完整 SHA256、OSS 全元数据 SHA256 及指针事务均通过。事务输出 updated=[latest,beta]；随后独立读取四个入口，全部为 3.0.10，4606 字节，SHA256 1b29818787ef418300e4a347eec3fdcced89462016dcb576eebaef13e002647d。没有重复 dispatch 或改动 v3.0.10 tag。

用户补充要求加速 Verify S3 upload。实际耗时 5m22s，旧逻辑串行读回 28 个文件共 7,766,653,598 字节，CLI 还会再次完整读取。服务端匿名 HEAD 的 checksum-mode 已实测返回 CRC64NVME/FULL_OBJECT，证明支持 checksum 查询；SHA256 composite 上传与新校验路径将在 beta Actions 验证，不能以 CRC 响应替代 SHA256 实测。

性能增量三问：完整性策略集中在 release-storage-integrity.mjs，CI 和 CLI 共用，更新指针事务保持单独属主；固定分片参数明确绑定上传配置，来源清单可选字段兼容历史标签；SHA256、大小和类型不符直接失败，旧文件仍完整回读，四路并发失败先收敛再返回。测试覆盖实际 HTTP HEAD/流、multipart 边界、同尺寸损坏与实际 aws 子命令晚失败。

性能修复本地质量门：npm run test:scripts 243 passed / 0 failed；actionlint 1.7.12 校验四套 workflow 通过，check:pin --remote origin/main 和 git diff --check 通过。内聚证据：release-storage-integrity.mjs 的 mapLimit/fileChecksums/verifyS3Asset 管理校验与失败收敛，client/release.mjs 仅传入 GH 来源，workflow 仅配置上传和调用共享工具；无客户端或基座源码变动。下一轮 beta 的实际 Actions 耗时另记。
