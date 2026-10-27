# 构建优化与同步安全：P1 和后续封装提速

状态：P1 已提交并推送，Draft PR #76 正在运行源码 CI。用户在查看剩余事项后要求继续；本轮补同步防覆盖与 Windows 封装提速，完成代码、提交并更新同一 PR。不启动新包、tag、Release、部署或修改更新指针。

依据：beta.8 run `40358051690` 全链69分15秒；Mac Intel helper 22分28秒、Windows helper10分15秒，均出现外层 artifact HIT 后内层 `record_missing` 重编。Windows 打包目录出现 `resources/git/.cache/PortableGit-*.7z.exe`。

## 实施与归属

| 责任人 | 范围 | 完成标准 |
| --- | --- | --- |
| helper_cache worker | `native-build-cache.mjs`、`build-resource-artifacts.mjs`、`build-helper.sh`、native cache action及对应测试 | 用真实缓存产物或可复现夹具解释外层命中/内层 miss；修复实际断点；同输入生产/消费可复用，源码/补丁/工具链/目标变化与损坏产物拒绝复用 |
| package_payload worker | 发布包资源过滤 helper、本地 builder配置、对应测试 | 排除明确构建专用 `.cache` 等缓存路径，保留运行二进制及合法业务资源；实际文件选择夹具证明缓存不进入包，缓存源目录不被删除 |
| root | Beta/Stable/validation workflow接入、集成、自查与提交 | 本地与三种CI入口采用同一过滤规则；保留签名、公证、运行资源和原有质量门；红测试先提交，修复后提交 |

隔离目录：`/Users/apple/.codex/worktrees/build-p1-optimization/nuwax-client`。原工作区及基座保持不动；测试只在隔离目录或其临时夹具执行，禁止在原基座同步/清理 overlay。各 worker 不改彼此文件、不提交、不推送，不触发云端构建。

## 边界与验证

- P1 不改封装调度；本轮后续允许实现有隔离保障的 MSI/EXE 封装提速，不改公证要求，不扩 runner、不新增预热任务。
- helper 仅复用经来源/输入/哈希验证的未签名编译产物；安装包、签名与旧授权状态不作缓存。
- 包体只移除构建缓存，不根据扩展名删除运行需要的压缩资源、第三方许可或业务文件；不改开发者缓存与源码。
- 先跑新增回归旧代码失败，再跑脚本全量；必要的社区/商业检查在隔离基座中运行。实际节省分钟数和新包体积留待以后同输入 Actions 验证，本轮不能宣称已达45–50分钟。
- 提交前按内聚、分层、维护三问自查，并记录证据与残留风险。按“继续”的范围推进远端 Draft PR 和源码 CI，不自行批准或合并。

## 后续实施（2026-10-27 继续）

| 责任人 | 范围 | 完成标准 |
| --- | --- | --- |
| helper_cache worker | overlay 同步、清单 reader、回归及安全说明 | 修改前全量预检；未知工作区/暂存改动、损坏或越界清单、符号链接均保护；同步/裁剪/清理前保留原字节和清单，失败可恢复；兼容旧清单与正常增量同步 |
| package_payload worker | Windows build wrapper、安装包编排 helper及测试 | 核对固定 builder 版本；只构建一次应用，安全隔离两种安装包封装；保留签名、低空间检查、更新元数据和 EXE-only 验证入口；任何目标失败都不发布半成品 |
| root | 集成、五遍与三问自查、独立质量门、PR/CI | 有可见红绿证据与提交；原工作区不写；不触发真实打包或设备验收 |

Windows 若固定 SDK 的共享目录或签名行为不能安全并行，保留可靠路径并记录具体阻碍，不以牺牲发布完整性换速度。真实耗时收益仍待后续打包测量。

同步护栏防止重演覆盖问题；此前已丢失的原始 WIP 没有可恢复字节，本轮不能宣称找回。首次重启、WebView/Dock 及系统通知中心真实行为继续留待用户实机验收。

## 结果与验证

- helper：真实beta.7/beta.8保存键一致，首次读取却miss；可复现夹具确认成功版本探测的stderr瞬态提示使身份漂移。旧实现3项失败，修复后同输入生产→传输→消费可复用；真实输入变化和篡改仍拒绝。共享action提前安装rustfmt。
- 包体：真实electron-builder/app-builder-lib 25.1.8 copyFiles夹具在旧代码复现缓存泄漏；新策略排除4种工具根.cache，保留可执行文件、许可、业务ZIP和嵌套运行索引，源缓存不变。Stable/Beta在构建前过滤、上传前验证；本地pack与最终签名Mac独立验证也检查实际目录。
- 独立全量脚本：407通过 / 0失败 / 0跳过；隔离base:test：1682通过 / 0失败 / 18既有跳过（138文件通过，1文件跳过）。新增回归均执行。JSON/YAML和diff检查通过。
- 最初两轮隔离环境分别缺基座/TypeScript、前端契约源码，补齐固定pin后全绿；未放宽断言或排除失败项。原工作区和原基座未写入；依赖逐包只读链接，.vite/.vite-temp/.cache留在隔离目录。
- 红绿日志：`/tmp/nuwax-helper-cache-p1-20261027/{red,green}.log`、`/tmp/nuwax-payload-{red,green}-20261027.log`、`/tmp/nuwax-p1-{workflow,mac-validation}-{red,green}-20261027.log`。独立verifier报告含完整407/1682结果。

## 三问自查

1. 内聚：身份探测与失败诊断集中在 `scripts/client/native-build-cache.mjs:32`；包体过滤与只读验证集中在 `scripts/client/package-payload.mjs`，本地和CI不复制规则。
2. 分层：发布配置消费纯过滤函数，workflow调用其CLI；验证只读检查最终目录，不操作源缓存或签名内容。证据：`scripts/client/pack.mjs`、`scripts/package-validation-mac.mjs` 与两发布workflow的package-payload调用。
3. 维护：过滤幂等并保留现有hook；验证只查8个固定根，开销有界。成功版本探测仍要求非空且返回成功，MSVC特例保留；源码/工具链/目标/锁/flags和损坏保护均有回归。证据：`scripts/native-build-cache.test.mjs`、`scripts/client-pack.test.mjs`、`scripts/package-payload.test.mjs`。

三问与质量门通过，可提交本批；此为writer自查，未自行批准或合并PR。新配方会使旧缓存正常失效，第一次后续构建仍可能冷编译；实际包体、分钟收益及真实跨run命中率未测，不宣称已达到45–50分钟。
