# 更新就绪文案与日志入口整合

- 依据：用户要求吸收 `codex/update-ready-copy` 的文案和日志入口，接入当前一键升级方案，验证后提交当前 `release/v3.0.x`。
- 范围：前端版本徽标点击/悬停展示日志，日志内明确触发升级；保留 `installing`、进度遮罩和主进程任务去重。Windows 一键策略只调用一次宿主入口，不在 renderer 再串联下载和安装；旧宿主继续按能力分步操作。
- 壳：同步四语言就绪提示和重启文案，顶栏仍导航至关于页。关于页保留现有日志及进度展示，不引入旧分支的整页 AboutPage 覆写。
- 提交：仅提交相关前端源码（含一键状态适配）、外层 UI 文案和源码 pin。已有基座服务/安装器/真包验收改动保留原状，不提交无关子模块 WIP，不推进基座或产物 pin，不推送或发布。

## 顺序

1. 增补徽标日志入口、能力分支、失败和防重回归，先确认新断言失败。
2. 整合徽标交互与四/五语言文案；保留网页更新按钮的独立语义。
3. 跑 client-shell、桥契约、壳语言/更新域、renderer 构建及分层检查；按 pre-commit-quality-review 检查内聚、分层和维护性。
4. 提交前端源码及外层变更，记录实际验证与保留的原有 WIP。

## 完成记录

- 日志徽标支持点击、悬停和键盘打开；查看日志不下载。Windows 一键动作只调用宿主 download 一次，已下载时调用 install；不在 renderer 拼接第二次安装。
- 下载/安装进度由主进程状态驱动；成功交接后防止重复提交，后续宿主报告错误时释放入口并显示详情。旧宿主保留分步下载，MSI 保留下载页路径。
- 同步五种前端语言的 ready/install 文案、四种壳语言的就绪/重启提示；WebUpdate 继续使用原有「更新」键。
- 原有基座 4 个中立文件的工作区 diff 与整合前逐字节一致；没有新增 AboutPage 覆写，也没有改动基座、产物或无关微应用 pin。

## 质量检查

| 检查 | 证据与结论 |
| --- | --- |
| 功能内聚 | `nuwax/src/features/client-shell/ClientVersionBadge.tsx:99`、`:131` 仅提交单次宿主动作与维护本入口反馈；clientUpdateService 的 schedule 统一维护 timer，refresh 只拉取状态。通过。 |
| 分层 | 徽标只消费 clientUpdateService/hostBridge；可选 installAfterDownload 能力位来自规范契约，快照经同步工具生成，renderer 不直接控制安装器。通过。 |
| 维护性 | 8 项新增交互回归覆盖日志授权、防重、进度、缓存、错误、旧宿主和 MSI；独立 ready 键避免影响网页刷新文案。通过。 |

## 本轮验证

- 新增交互断言在改码前 7 项失败；完成后补充宿主迟到失败场景，8 项通过。
- 前端 client-shell + i18nLangPolicy：11 文件、144 项通过。
- 商业轨：246 文件通过、1 文件跳过；3,064 项通过、18 项跳过。
- 特性边界/桥契约：23 项通过；生成契约与 canonical source 一致；overlay:check 336 文件一致。
- 壳 renderer 构建通过；前端分层门零新增，保留 97 项既有豁免。
- 两仓 git diff --check 通过。
- 提交钩子发现既有轮询服务存在函数声明先后 lint 错误；收敛 refresh/schedule 职责后重新跑 144 项回归并通过 ESLint、Prettier、提交格式检查。
- 默认 check:pin 仍报告整合前已有的 4 个基座中立 WIP（autoUpdater.ts、autoUpdater.test.ts、AboutPage.tsx、updateTypes.ts）；本轮不将其混入提交，不推进基座 pin。该结果不记为质量门全绿或正式包验收。
- 本轮只做源码整合与验证，不推送、不构建发布包、不改变远端更新指针。
- 前端源码提交：`3aa6484eb`（本地 `codex/update-ready-integration`）；只提交 13 个相关源码/测试/语言文件，两个微应用 gitlink 的原有 WIP 未提交。
