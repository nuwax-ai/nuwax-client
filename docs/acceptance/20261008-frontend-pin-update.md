# 前端双 pin 独立更新记录

日期：2026-10-08。用户要求更新 nuwax 相关子模块，并并行推进打包；后续明确优先重跑已冻结的 `v3.0.11-beta.5`，允许该包继续使用既有前端。本记录是后续独立更新，不改变 beta.5 tag、源码、构建或订阅指针。真机、安装包和 GUI 验收由用户进行。

## 固定输入与交付

在隔离工作区执行现有 `sub:update`，未使用主工作区或 `~/workspace/nuwax` 的未提交源码。只更新前端双 pin，基座保持不变。

| 项目 | 固定值 |
| --- | --- |
| 更新前源码 | `f8dbcb4a89c7e55a2fc61474baf5a77322017fd8` |
| 更新前产物 | `5739f983c1db45373866d8b37508a1468d6a5212` |
| 本轮最初采样的远端源码 | `ab5e2d49897cf553610b9d51c569554017509d33`，`feat-2026.9.30` |
| 完成必要修复后的源码 | `4dfea90cd29330e504bf8c858531d38ecc570b12`，同一声明分支 |
| 新产物 | `4a497a0553a235ad2f919ab7c1e3779e5e63c45e`，已正常推送 `nuwax-dist/main` |
| 基座 | `d078bb3cd87eb111a38299bb23d9dff819f53c13` |
| 产物 stamp | `4dfea90cd2` |
| 产物 buildAt | `2026-10-08T12:13:46.567Z` |
| 外层双 pin 提交 | `4549ef6251efa50e55896e4726926b4d7111aaf5` |
| 实际消费的前端文件 | 998 个，114,136,999 字节；排除产物仓 `.git`、README |
| 实际消费树 SHA256 | `b93c18aeafd76741c2879788aa3e4f93c8800fe1dc0d3cc50b1813d4dd3c7653`，沿用 release-provenance 的排序、相对路径及逐文件 SHA256 算法 |

命令：

```bash
npm run sub:update -- --nuwax 4dfea90cd29330e504bf8c858531d38ecc570b12 --shell d078bb3cd87eb111a38299bb23d9dff819f53c13
```

主应用生产构建和两个固定输入微应用生产构建全部成功。更新器校验完整源码 SHA 与 stamp，再推送产物并提交双 gitlink；随后实际调用 `usePinnedFrontendDist` 成功消费已提交产物，核对文件数量与树散列。源码和产物工作树纯净，旧产物 `5739f983` 保留在新产物历史中，没有强推或改写历史。

## 构建前发现并修复的已提交错配

远端 `ab5e2d49` 的源码树包含 repo gitlink `18ae973c`、IM gitlink `140784225`，对应 `adapter.json` 却分别声明 `5c676b854`、`c99e0a486`。干净隔离工作区实际运行 `sync:micro-apps`，在构建前失败：`repo gitlink ... 与 adapter.pin ... 不一致`。

仅将两个 gitlink 对齐既有 adapter 输入；两目标都核对为各自远端 `main` 的可获取 commit。没有改适配补丁、业务源码或接口。修复提交 `1e3cdb07bdc0ca481d6c380475814e6bea41675e` 经 [前端 PR #188](https://github.com/nuwax-ai/nuwax/pull/188) 正常合入声明消费线，合并提交为 `4dfea90cd2`；合并树与已测试修复提交完全一致。PR 仅改 gitlink，没有触发路径过滤的业务 CI，验证证据来自本次本地完整门禁和实际构建。

新固定输入：repo `5c676b85487f865cf7c5f72d9428b628b37f50f0`；IM `c99e0a486801e2fa1b4894556c4f44fb7988fc9c`。来源校验、补丁复放、类型检查和生产构建均通过。repo 原版与适配类型诊断均 72，新增 0；IM 执行 `tsc -b && vite build` 通过。

## 批次质量三问

本轮消费的已合入前端批次包含桌面 IdP 登录/绑定、验证码和设置页、License 界面、会话 V2 轨迹、项目电脑/目录默认值及微应用更新。按 `pre-commit-quality-review` 检查组合源码，已发现的 pin 错配在交付前修复。

- **内聚通过**：桌面授权/回跳及迟到响应防护集中在 `nuwax/src/utils/idpNavigation.ts:52`、`:101`，页面消费既有宿主桥。License 状态、请求代次和撤销由 `nuwax/src/services/licenseController.ts:13` 负责。问答两侧回答的保守归属判断集中在 `nuwax/src/features/conversation/presentation-v2/finalAnswerSelection.ts:84`，不删除无法证明属于过程的正文。
- **分层通过**：页面依赖认证工具、services、hooks 与既有 bridge 契约，没有新增 IPC 或 renderer 自动设备注册/服务启动链；架构门无新增违规。源码、adapter 与产物来源分别由 `nuwax/scripts/sync-micro-apps.mjs:159`、`scripts/client/update.mjs:319` 校验，业务代码仍在前端仓，外层仅持有双 pin。
- **维护通过**：生产 License provider 在 `nuwax/src/services/license.ts:58` 明确不可用，开发 fixture 仅能由编译配置启用。生成产物按 `scripts/client/update.mjs:321` 验证 stamp、推送后才提交外层 pin；变更没有增加并行版本事实源。非法回跳、迟到响应、失败重试、微应用输入错配和升级回滚均由既有边界用例覆盖，新增来源已实际构建验证。

## 本次质量门

| 检查 | 实测结果 |
| --- | --- |
| 前端全量 Vitest（4 workers） | 379 文件 / 3681 项通过，6 项跳过 |
| 会话专项 `test:conversation` | 112 文件 / 1145 项通过 |
| 架构门 `lint:arch` | 3019 modules / 13141 dependencies；无新增违规，97 项存量豁免 |
| 类型域门 | nodes 137、conversation 118、workspace 62、contracts 3 文件，各域 0 诊断；域外 287 项存量诊断不代表全库 TypeScript 通过 |
| 类型门自测 | 19 项通过 |
| 微应用构建/升级合同 | 60 项通过 |
| 固定输入主应用与微应用生产构建 | 全部成功；stamp 与完整来源一致 |
| 外层更新/产物消费守卫自测 | 42 项通过 |
| `check:pin --remote origin/main` | 通过，135 个 overlay 托管路径保持基座中立版本 |
| 干净工作树与 diff 检查 | 通过；原工作区 WIP 未纳入 |

本地日志：`/tmp/nuwax-beta6-frontend-*`（名称来自最初候选，未创建 beta.6 发布）、`/tmp/nuwax-frontend-pin-update.log`、`/tmp/nuwax-frontend-pin-update-evidence.json`。这些文件是本次运行证据，不是发布来源记录或跨机器可用工件。

## 验证边界

当前 beta.5 仍冻结旧双 pin `f8dbcb4a89` / `5739f983`，本轮新 pin 尚未纳入该 tag。后续进入客户端发布分支并创建新 tag 时，由 Actions 再验证组合源码、五平台产物及来源。

桌面 IdP 前端复用现有 `auth:getContext`、`beginLogin`、`syncSession` 契约，当前商业宿主兼容；实际提供方授权、Cookie 回调、设备注册和安装包内登录仍需用户验证。验证码使用既有 `/api` 通路；浏览器 fixture 和本地测试不证明真实后端开启配置已验收。

License 界面和 HTML File 能力可进入前端载荷，但生产 provider 仍为 `unavailable`，没有真实 License 导入、签发或受控功能闭环。IM/资料库的固定输入构建成功与真实业务后端任务、成员权限和产物联调分别记账。没有启动、替换或安装任何真实客户端。
