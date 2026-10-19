# 10 月客户端需求核对与续办

核对时间：2026-10-19，Asia/Shanghai。范围是 Nuwax 桌面客户端及其消费的固定前端版本；移动 App、IM、云沙箱和 harness 独立项目的需求不直接记为壳功能已完成。

依据：

- [10 月版本规划](https://agent.nuwax.com/repo/doc/Fy9KinwyNzHU6XsH?hide_menu=true)，正文最近修改 2026-10-19 11:44。
- [团队问题跟踪表](https://agent.nuwax.com/repo/doc/xcCBum7Kqz4TVJYU)，最近修改 13:04，读取全部 122 条记录；其中模块明确包含桌面客户端的 21 条，表内状态为 7 条已关闭、1 条已处理、13 条待处理。状态是问题表记录，不等于本轮代码或安装包验证结论。
- [女娲产品问题跟踪](https://agent.nuwax.com/repo/doc/UikwEDyq6NhUP2JM)，最近修改 13:05，读取全部 191 条记录，交叉核对客户端反馈。
- [beta.7 功能与验证清单](../docs/acceptance/20261018-beta7-validation.md)、[beta.6 集成清单](../docs/acceptance/20261018-beta6-validation.md)，以及当前远端 Git 对象图。

## 分支事实

已 fetch origin，并用 ls-remote 复核远端引用：

| 引用 | 当前提交 | 含义 |
| --- | --- | --- |
| origin/main | f4cab8e1 | 9 月 15 日的主干；是 release 的祖先，落后 release 523 个提交 |
| origin/release/v3.0.x | 7503d15c | 当前版本线，仍为 beta.5；主工作区也停在这里 |
| origin/codex/windows-permissions-update-feedback | d5101e91 | beta.7 发布后的完整代码及验证文档；领先 release 24 个提交、领先 main 547 个提交，无反向独有提交 |
| v3.0.17-beta.7 | cb436f9d | 不可变产品源码 tag；GitHub 页面已实时确认是公开 prerelease |

“已发布”和“已合主干”目前不同步。不能因为 beta.7 已公开，就认为 release 或 main 已包含这些实现。GitHub connector 查询当前 open PR 返回空结果；本机 gh 的凭据失效，不依赖其失败结果判断合并状态。

本轮建立独立 worktree `/Users/apple/.codex/worktrees/october-client-followup/nuwax-client`，分支 `codex/october-client-followup`。先从 7503d15c 创建，再只在此新分支快进到 beta.7 分支，形成可审阅的续办候选。主工作区、已有工作区和远端分支均未移动。

## 需求逐项对应

以下“版本线已具备”指 release/beta.7，不代表已进入 main。

| 规划条目 | 已有实现 | 未完成或未合并部分 | 下一步 |
| --- | --- | --- | --- |
| 3 本地文件操作本地化 | 读取、预览、搜索、ZIP 等实现已进版本线，见 local-file-access-api；原实现合入 4f022688 | 发布入口在 features/index.ts 强制排除 local-files（672ca584）；重开分支 daaf1253 的 2 个提交未合 release。完整读写边界、敏感路径与逐次确认仍未闭环 | 保留关闭；先确认完整本地化范围和重开验收，再集成原分支 |
| 4 本地电脑操作 Android App | 本仓未找到 ADB/Appium 或 Android 操作交付 | 云手机/本地模拟器路径和主责需由对应项目确认，不能凭客户端 CUA 可用认定 Android 已支持 | 保留跨项目方案项，不在壳仓添加另一套运行时 |
| 5 Computer Use 第一梯队 | c2f7df5f 已将基础控制带入 release；helper 图标进一步随 beta.6/7 集成 | computer-use-product@69bcd5c6 相对 release 领先 23、落后 27；后续控制层、基准与增强未合入。desktop-capability-ports@a8fe7927 相对 release 领先 26、落后 27。控制层自动化不能证明第一梯队的真实任务成功率、成本或跨平台验收 | 主力模型、数据快照、基准子集、目标档位与分支顺序待确认；不推进已后置的设备验收 |
| 7 持续稳定性优化 | NW-041 并发隔离已在版本线；NW-050 失败终态和 SDK 包装 400 不重试已进 beta.6/7 | 新问题见下表。7.1 语音纠错、7.2 点击上报、7.3 昵称头像引导归共用前端/服务链，本轮没有足够证据判断其最新交付状态 | 优先登录阻断、gateway 加载和升级保全失败；不按问题表“已关闭”直接宣布已验证 |
| 8 截图与录屏 | 20c0cd2f 原生采集、418f57ae Linux 适配、bf51f20e 复制/能力探测、1494ec12 窗口识别已进 release；支持选区、标注、复制/保存、MP4/GIF 等 | 按规划完整对标仍缺全局截图快捷键、滚动长截图、贴图、序号、OCR、翻译；IM 页面接线/部署是独立交付，不能由壳采集验收代替 | 客户端基础与“完整对标”分开验收；IM 续办按现行接入契约，NW-009 叫停保持 |
| 9 系统名称 女娲Nuwax | ec951c48/9520f655 已进 release；macOS 本地化名称、Windows NSIS/MSI 快捷方式、Linux launcher 已配置 | NSIS 控制面板卸载名遗漏，builder 默认生成 Nuwax + 版本；本轮已修。MSI 显示名及 Windows 系统各露出点仍需真实包核对 | 将本轮名称修复纳入下一候选后，复验当前用户/全用户安装的卸载列表与版本 |
| 10 新版本就绪 + 日志 + 更新并重启升级 | a65c537a、edd25e2a 已进 release；beta.6/7 增加悬浮延时和行内状态，移除额外进度弹窗 | 这些 beta.6/7 的后续调整随 24 个提交仍未进 release/main。macOS/Linux 保持下载后再次点击安装；旧版发起首次升级仍使用旧界面 | 先收敛已发布代码到版本线，再按 beta.7 清单做真实升级；不移动已有 tag |
| 11 APP 双向分享 | 主要是移动端工作；桌面对应“用女娲打开”、拖入及系统关联 | 本轮未找到桌面系统分享接收/文件关联交付证据；分享对象、权限及桌面优先级尚需产品范围 | 保留跨端方案项，不将现有打开网页/文件预览当作系统分享完成 |
| 12 Codex 二开 nuwax-harness | 客户端已有多 ACP 引擎适配入口 | beta.7 的 acpEngine 仍使用 CODEX_* 和现有 adapter；不足以证明运行时白牌化、统一 .nuwax、三协议及上下文压缩治理已交付。本轮没有接管独立 harness 项目 | 需要 harness 所属仓版本/契约与客户端接入计划，不能靠壳层改错误文案或环境变量名称代替内核改造 |

移动推送（1）、电话/硬件（6、13、14）不纳入桌面壳完成统计。

## 未合并项的处置

| 成果 | release/main | beta.7 | 处置 |
| --- | --- | --- | --- |
| U1 卸载默认保留数据、未知文件保护、升级嵌套恢复、宿主导航、外链校验、旧 runner 封闭 | 未合入 | 已集成 | 以 beta.7 为整体候选，不再重复合入旧独立分支 |
| NW-050 的 746aea87 / d108317b / 38f986d6 | 未合入 | 已集成；git cherry 三笔均为等价补丁 | 原分支保留；真实模型验收此前按用户要求跳过，不能标问题已完整关闭 |
| helper 图标 c57e43b5 | 未合入 | 已集成；git cherry 为等价补丁 | 不重复合并，不等同 CUA 后续增强全部合并 |
| 权限引导 62fa3c71 | 未合入 | 已集成并修四语言 key；beta.7 隐藏 Windows 无效授权入口 | 原受保护工作区不接管；以 beta.7 实际实现为准 |
| 本地文件重开、CUA 后续增强、desktop-capability-ports | 未合入 | 未纳入 | 保留产品/验收与合并顺序条件，不一次性合并所有 codex 分支 |
| 终端多开、pi-agent、NW-009、独立 UTF-8 pin 修复 | 暂缓/叫停/冻结 | 未纳入 | 延续原决定，不自动恢复 |

后续合入顺序：先确认已发布 beta.7 整体回流 release；本轮名称修复单独可选纳入；之后用明确基线的 PR 将版本线同步 main。release/main 没有分叉独有提交，但 523 个历史提交的主干同步仍需按完整范围运行 CI，不能用本轮 16 项脚本测试代替。push、PR、合并、tag 和发布沿用原明确确认边界，本轮未执行。

## 问题续办优先级

| 优先级 / 事项 | 当前证据与状态 | 后续可执行入口 |
| --- | --- | --- |
| P0 NW-122 登录阻断 | 10 月 19 日新报，微信与密码均失败；缺版本、业务域、失败请求/错误码，站点 HTTP 200 不证明鉴权正常 | 获取同一次失败的域名、版本与脱敏响应，沿现有 ticket/commercialAuth 生命周期定位；不盲清账号/Cookie、不代用真实账号复现 |
| P1 NW-087 / 产品表 179 加速模式加载失败 | 10 月 18 日新增“关闭本地化加速恢复”证据。当前源码默认 direct；显式 nuwaxLoadMode 优先，否则仅 NUWAX_LOOPBACK=1 启用 gateway，不能据此认定升级默认强开 | 同版本、同页面对照 direct/gateway 的失败 URL、资源与接口响应。未经复现不自动切模式或重置设置 |
| P1 NW-117 升级保全错误 1 | 当前问题表仍待处理；现有文件保护 QA 不能证明这台用户机器的失败原因已修 | 保留原 recovery 和文件，获取安装版本/路径、脚本日志与占用/权限信息；不照问题表中的推测去删备份或关闭杀软 |
| P1 NW-108 AcpEngine not initialized | beta.7 prompt 等入口仍有未初始化 guard；只发现字符串不能断定启动竞态，也不能把 NW-050 的终态修复当作此项关闭 | 获取 engine 类型、冷启动/进程退出日志与复现时序，再验证是否要等待初始化或重建；不在引擎错误后自动重放不确定请求 |
| P1 NW-104 / 产品表 88 安装慢/安全中心拦截 | 驱动拦截是表内推断，尚无 .sys 名称、签名或 Code Integrity 记录；UTM 包验收不等于用户机器已解决 | 先取具体被阻文件和日志，再定签名/兼容修复；不据截图宣称产品依赖内核驱动 |
| P2 NW-044 / 产品表 175 任务状态 | 最新原文明确是主站左侧项目/任务列表（“刚刚/1小时”），不是壳 SessionsPage 的“活跃/空闲”列表；旧 3 秒轮询追踪不能当本项根因 | 已补齐真实入口归属，后续应沿共用前端 task 状态订阅与人工确认状态追踪；不改壳轮询来代替修复 |
| P2 NW-065、080、098、106 | 分别为 IM 编辑器退格、订阅页右侧控件、资料库菜单裁切、编排入口；模块填桌面不代表都由壳实现 | 保留对应 IM/主站/资料库归属，取得当前包和对应前端 pin 的复现，再决定修改位置 |
| P2 产品表 157/158/160/172/178/184 | 文档链接重登、验证码两次、截图取消仍发送、连接器图标残留、图片放大、支付返回刷新 | 逐项保留触发条件；涉及 IM 草稿/发送或服务状态，不用壳截图 API 可用作已修证据 |
| 归属确认 NW-094 | 通知备注名已由冯飞认领 | 不重新挂为客户端壳编码任务 |
| 产品表 187 锁屏 CUA | 原记录是检测锁屏后跳过；不证明程序错误；电源保活不等于锁屏后仍能对桌面输入 | 保留安全边界；若希望后台浏览器任务，应另定执行架构，不绕过系统锁屏 |

团队表已关闭的 NW-008/041/042/059/071/074/075 仅记录原状态；NW-083 是“已处理”，仍区分旧包升级引导与新包更新配置。本轮没有改远端表的状态。

## 本轮实际执行与验证

1. 已完成上述需求、远端分支、不可变 tag、两个问题表和 beta.6/7 集成记录核对。
2. 已在独立分支收敛 beta.7 候选，未改主工作区两个原有未跟踪项及三个 pin。
3. 已修并本地提交 `98f71bce`，修改 `scripts/client/system-app-name.mjs`：NSIS 的 uninstallDisplayName 使用“女娲Nuwax + 完整版本”；技术 productName、可执行文件、appId、缓存与更新路径保持原值。
4. 回归直接调用锁定 electron-builder 25.1.8 的 NsisTarget.configureDefines 和真实宏展开器，覆盖 stable 与 beta 版本；同组原有 macOS Foundation、Linux desktop 与 NSIS/MSI 快捷方式检查通过。
5. 相关测试命令：

```sh
NUWAX_TEST_BUILDER_CLIENT_DIR=/Users/apple/workspace/nuwax-client/nuwa-electron-shell/crates/agent-electron-client \
  node --test scripts/system-app-name.test.mjs scripts/client-pack.test.mjs scripts/app-update-packaging.test.mjs
```

结果：16 项通过，0 失败，0 跳过。仅只读复用主工作区安装的锁定 builder，所有生成夹具在临时目录；未同步或清理共享 overlay。本轮没有修改 overlay、依赖或子模块 pin，不重跑已有 beta.7 完整两轨。

按 REVIEW.md 核对一次：名称由本地 pack 与发布共用配置生成器提供；保留身份与路径；NSIS 宏包含完整版本；原包与已发布资产不改。`git diff --check` 通过。没有构建新的 Windows 安装器，真实卸载列表及 MSI 显示名仍待下一候选验收。

待确认后执行：将已发布 beta.7 的 24 个提交收回 release，并按完整同步范围向 main 发 PR；本轮品牌漏项可以作为独立修复提交加入该候选。未经确认不推送、不移动受保护分支、不发布新包。
