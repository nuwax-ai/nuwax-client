# 子模块与配对产物更新

状态：已完成。五个子模块的已提交 pin、实际检出与声明分支远端 tip 均已核对一致。Dock 关闭窗口后常驻的既有策略保持，并核对关闭、重新激活和托盘路径。本轮未创建版本/tag，未打包安装包、未部署。

## 固定输入

- 基座 `main`：`d12d001a0d51e28513cba2b60e76413275cad161`，已是远端最新，不改基座 pin 或覆盖既有商业同步状态。
- PC Web `feat-2026.9.30`：先快进到 `bef28665ce2c14ca3981124c2d9e13db53d0f8d6`，再升级两个内层 main。
- IM `main`：`92ace8fabcbf1463732e6db6ade1817b0a4a5113`；repo-web `main`：`db9f23a61e7f218873400cd9bf2ac3c1b258daeb`。
- 原客户端配对输入为源码 `da71cb92e950ad32a53826682d8cb008aed2d97f`、产物 `7e6b0fe9cc4fb192ae45fcf168ec712146e52301`。

## 实施与质量门

1. 使用微应用升级入口更新 gitlink/adapter.pin，若补丁冲突按语义重制；保留上游头像修复和已有宿主 API、通知及导航边界。
2. 按 pre-commit-quality-review 对整个增量核对内聚、分层和可维护性；运行微应用适配/构建守卫、前端测试与架构检查，验证对应微应用构建及类型基线。
3. 提交并推送前端固定源码使 CI 可检出，使用客户端 sub:update 入口构建、验证并推送匹配产物，提交外层源码/产物双 pin；产物历史不重写。
4. 验证宿主桥快照、产物来源戳与文件清单、实际检出和外层 pin 一致；运行客户端脚本和受影响商业域测试。对照 Dock 的 close/activate/常驻策略及托盘回归，不机械新增重复测试。
5. 保留当前工作区其他修改，不操作已安装客户端、不触发部署或安装包发布。外层提交保留本地，除非用户另有推送要求。

## 失败与回退

适配或构建失败先保留证据并修复，未通过门禁不发布新产物或提交虚假的双 pin。需要回退时通过新提交恢复旧配对 pin，不改写产物仓中仍被引用的历史。

## 审查与已完成验证

- 内聚：上游 IM 头像修复留在 `MessageBubble.tsx` 和 `store/chat.ts`，宿主适配留在 `micro-frontends/message/adapter.patch`；三方重制前后的 2,059 行增删内容完全一致，仅更新上下文、行号及 blob 标识，保留现有弹窗、通知、焦点和导航行为。
- 分层：`scripts/sync-micro-apps.mjs` 从 index gitlink 归档源码、校验 adapter.pin，再应用 patch/overlay；子仓源码未作业务修改。repo 类型基线 68 条、适配 68 条，新增 0。宿主桥快照与前端事实源一致。
- 可维护性：两个 gitlink、adapter.pin 和实际检出一致；使用已有升级/重制/构建入口。补齐预览全屏测试夹具的必需预览属性，不修改生产代码或放宽断言。
- PC Web 全量首次 400 文件、4,048 项通过、6 项失败、6 项既有跳过。2 项为上述夹具缺失，4 项为 5 秒超时；修复夹具后原样复跑全部 4 个失败套件，43/43 通过，最终无未处理失败，不将首次运行描述为全绿。
- IM 前端 2,400/2,400 通过；微应用冷构建通过，来源分别为上述固定 IM/repo main。架构检查无新增违规，保留 97 条既有基线；微应用构建/升级守卫 75/75、客户端 pin/准备/构建守卫 67/67 通过。
- Dock 关闭路径 `main.ts:454` 只隐藏主窗口并执行 ensureDockVisible，`activate` 恢复窗口；不改现有业务策略。托盘/自启/IM 原生展示分域 56/56 通过，仅作为代码回归，不替代安装包实机结果。

## 最终固定与交付

| 项目 | 固定提交 | 远端目标 |
| --- | --- | --- |
| nuwa-electron-shell | `d12d001a0d51e28513cba2b60e76413275cad161` | GitHub main |
| nuwax | `446d5a02cfafb2b1e9e175dbc244e80a81db531a` | GitHub feat-2026.9.30 |
| nuwax-dist | `b0e9d829a2d5ba82561a539362073ba6db6b1126` | GitHub main |
| nuwax-im | `92ace8fabcbf1463732e6db6ade1817b0a4a5113` | GitLab main |
| nuwax-repo-web | `db9f23a61e7f218873400cd9bf2ac3c1b258daeb` | GitLab main |

- 前端 `446d5a02cf` 与产物 `b0e9d829a` 已推送；客户端双 pin 提交为 `73b0dd067b58be7fbb736726c73de5c032737adc`，外层提交保留本地，未推送。
- 统一 `sub:update` 完成生产构建、版本戳校验及双 pin 提交；新产物从旧 main `7e6b0fe9` 追加，不重写旧产物历史。末次直接查询五个远端目标分支，均与上表一致。
- 对 1,201 个产物文件、141,138,426 字节逐个校验 Git blob 与磁盘字节；产物戳 `446d5a02cf` 与源码 pin 对应，内嵌微应用 manifest 的两个 source.commit 与内层 pin 对应。
- 产物目录 SHA256：`22aaf836fab603b6df1079d689a799114bb0d9af90213cc020eb0deb2589eb7c`。逐文件清单保存在本机 `/tmp/nuwax-submodules-inventory-20261026.json`，测试及构建日志为 `/tmp/nuwax-submodules-*-20261026.log`。
- 宿主桥、特性边界、基座 pin 纯净和 diff 检查通过。工作区只保留原有基座商业 overlay 同步状态，源码与产物子模块均无未提交修改。
