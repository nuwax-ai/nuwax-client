# 第三方主题实施与验证记录

前半部分保留 2026-10-30 的历史现场；最新代码基线和开发客户端状态见文末 2026-11-02 记录。

## 工作区和交付

- 独立托管工作区：`/Users/apple/.codex/worktrees/theme-plugins/nuwax-client`。
- 壳与前端分支：`codex/theme-plugins`；起点分别为 `09bb9191` 和 `68c88c70`。
- `nuwax-dist` 保留 `45c9b37c`，本地生产构建直接消费本次前端源码，未发布产物仓。
- 消息 `submodules/nuwax-im` 保持 `0fafa86d`；资料库 `submodules/nuwax-repo-web` 保持 `db9f23a6`。两处源码工作区均无修改。适配只在主站 `micro-frontends/**` overlay。
- 当前保留可审阅的未提交改动；未推送、创建 Release 或改更新指针。

公开格式、制作步骤、限制、恢复入口与 AI 提示词见 `nuwax/docs/theme-packages.md`。纯核心与 Web 持久层位于 `nuwax/src/features/themes`；壳主题特性位于 `nuwa-electron-shell/crates/agent-electron-client/src/{main,preload,renderer,shared}/features/themes`。壳的共用核心为生成快照，修改前端规范后运行 `npm run theme-core:sync`；CI 检查漂移。

实现覆盖 ZIP 安装／导出、官方明暗与 DeepSeek Inspired、单变体／系统模式、Web IndexedDB 与跨标签页同步、桌面目录关联与监听、错误保留最近有效包、受信 themes 桥、主站与微应用样式更新、Monaco／Markdown／Mermaid／图表／终端、历史偏好迁移和默认恢复。Web `?theme=default`、桌面 `--safe-theme` 可绕过自定义 CSS。模板导出使用可安装 ID `my-theme`。

## 已验证

| 检查 | 结果 |
| --- | --- |
| Web 核心、ZIP、DOM、仓库、运行时、独立渲染器和旧偏好服务 | 9 文件、122 测试通过 |
| 壳 main/preload/renderer 主题与浏览器工具栏专项 | 9 文件、28 测试通过 |
| `npm run test:commercial` | 317 文件通过、1 文件跳过；3845 测试通过、18 跳过 |
| `npm run test:scripts` | 408 测试通过 |
| 微应用构建与升级脚本、共享 overlay | 75 + 2 测试通过 |
| 架构边界、桥契约、主题核心快照与 whitespace | 通过；生成与 feature 边界专项另有 14 测试通过 |
| 前端受管类型域 | nodes/conversation/workspace/contracts 全部 0 诊断；域外 279 诊断不计入门禁 |
| 前端生产构建 | 主站及消息／资料库独立产物构建通过 |
| 壳 bundle 构建 | main、preload、renderer 和 browser 通过；不等价于安装包运行验收 |

全量 TypeScript 检查尚不全绿：前端有现存 Markdown 自定义节点类型及 DiffEditor `tabSize` 等诊断，壳整仓也有范围外诊断；日志保留，不将其记为“整仓类型通过”。

真实浏览器使用 ego-browser，挂载生产 ThemeManagerPanel、运行时、DOM、ZIP 和 IndexedDB，仅替换业务导航及 i18n 入口。验证暗黑切换、导入带一层目录的 ZIP、包内 blob 图片解码、重名覆盖确认、无效包保留当前主题、切换／替换保留输入、刷新恢复、跨标签页同步、模板下载和 query 恢复模式。此项是主题组件验收，未声称完整登录业务页面验收。

macOS 实际 `fs.watch` 验证通过：连续写入取最后有效值、无效半写保留旧值、修复后恢复、资源热更新、目录离线时重启读取缓存、父目录监听重连、取消关联保留源文件。脚本使用真实 ThemeService 的 bundle 与隔离临时目录。

## Devkit 执行与对账

已按 doctor → prepare → run → reconcile 分四批执行，不递归派工。当前安装的适配器注入两项 Codex 0.165 不接受的 provider 参数；仅在仓外任务级兼容入口过滤这两项，未改全局 Codex 配置或 devkit 安装。

| 批次 | 执行／预算结论 |
| --- | --- |
| core-compatible-run-1 | 产出已审查；预算门停止，process/budget 为失败，实耗未知，不按零记录 |
| web-foundation-run-1 | 执行和预算门通过，对账 447071 tokens |
| desktop-run-1 | 产出已审查；预算门停止，process/budget 为失败，实耗未知 |
| renderer-run-1 | 产出已审查；预算门停止，process/budget 为失败，实耗未知 |

后续由主控修正集成并独立运行上述检查；不把 Devkit 预算失败说成执行成功，不据此宣称成本节省。

## 验收包与剩余范围

本地使用现有 `3.1.0-beta.12` 基线，命令 `npm run pack -- --frontend source --version 3.1.0-beta.12 --dir`。不占新版本，不创建 tag/Release，不发布。同一问题计数上限 4 次：

1. GitHub 固定 CUA helper 源码获取中断，未产出包。
2. 未改动的 CUA helper Rust 编译 `zeroize_derive` 加载失败，未产出包。
3. 固定 1.97.1 工具链、并发 2 后定位为宏动态库 `mis-aligned LINKEDIT string pool`，未产出包。
4. 固定相同工具链／并发，使用 `CARGO_PROFILE_RELEASE_STRIP=none` 后 CUA helper 编译与 ad-hoc bundle 成功；随后第三方资源严格预检因 `UNDECLARED_RESOURCE:nuwax-harness-acp-ts` 拒绝入包。未生成客户端验收包。

完整真实客户端安装、登录／退出和租户回包、多窗口、持续消息流与编辑状态、Windows/Linux 外观尚需安装包和真实账户验收；源码门禁与主题组件检查不能替代。已达到 4/4 次上限并停止打包，保留全部日志；须用户明确重新启动验收才能再出包。没有通过改版本、分支或命令绕过计数。

详细执行资料和浏览器截图：`/Users/apple/Documents/Codex/2026-10-30/theme-plugins-devkit/`。完整测试／打包日志已复制到上述 `acceptance/logs/`，包含四次出包尝试；`watch-smoke-result.log`、截图和导出的模板同样保留。


## 2026-10-30 主题包复核与演示交付

再次确认：功能主链已实现，不能将“代码已实现”写成“全部验收完成”。完整客户端、真实账户登录／退出、多窗口、Windows/Linux 外观及整仓 TypeScript 诊断仍按上文保留。客户端出包维持 4/4 停止，本轮没有重新启动出包。

新增可安装示例 `nuwax/examples/themes/blue-hour/`：澄蓝 · Blue Hour 1.0.0，10 个文件，明暗两种变体，common/web/shell/message/repo 分区 CSS 和实际组件预览 PNG。ZIP 与源目录分别通过生产 ZIP 读取器和 CLI 校验，四个界面快照均可解析。

可下载产物：`/Users/apple/Documents/Codex/2026-10-30/theme-plugins-demo/blue-hour-1.0.0.zip`；sha256 `a6391e27cd4f5655fdfcca563f04545d46e1f3531da80a2ca8cbc1207ef30758`。浅色／暗黑截图及 validation.json 同目录。当前开发预览在 `http://127.0.0.1:8766`，通过实际 ThemeManagerPanel、ZIP、主题核心、DOM 适配器、IndexedDB 和共享微应用主题 store 加载；页面框架为演示组件，不代表完整客户端截图。

视觉复核发现反色文字 Token 未映射到 Ant Design 实色按钮，补齐 `text.inverse → colorTextLightSolid`，共用核心同步到壳。新增明暗模式回归后 Web 9 文件／122 测试通过；重新运行 `npm run test:commercial`，317 文件、3845 测试通过。架构边界、桥契约、核心快照和 whitespace 检查通过。IM 与资料库上游子模块仍无修改。

最终 ZIP 已通过实际主题管理界面的导入、重名覆盖确认和导出。生产 ZIP 读取器回读后，全部文件的 base64 字节与原包逐一一致。明暗切换时草稿保留，消息／资料库共享 store 模式同步，暗黑主按钮文字使用反色 Token。核心独立类型检查通过。预览页面保留给用户查看，未启动客户端验收打包。

## 2026-11-02 最新基线集成与真实开发客户端

- 壳提交 `dc5f1266` 合入 `release/v3.1.0` 的 `cc89a325`；前端提交 `3856ec8eec` 合入 `feat-2026.11` 的 `5e8e0508ef`。两边继续使用 `codex/theme-plugins`，保留主题实现，均为本地提交，未推送。
- 产物 pin 更新为 `0fce1cd0`。IM pin 为 `9735677b`、资料库 pin 为 `85b4a562`；两处上游源码工作区干净，主题适配仍只修改主站 overlay。保留最新版发布排除项，未重新引入终端持久化与多终端管理。
- 集成后 Web 主题与历史服务 9 文件、122 测试通过；`npm run test:commercial` 311 文件、3742 测试通过、1 测试跳过；架构边界与主题快照专项 14 测试通过；版本序号脚本专项 5 测试通过。更新 pin 后的 IM、资料库生产构建通过。桥契约、核心快照及 whitespace 检查通过。

合入前按质量自查三问检查：主题逻辑由前端 `src/features/themes` 和壳 `main/features/themes/service.ts` 聚合；浏览器仅通过 feature 注册处注入主题快照读取／订阅，不直接依赖主题内部实现；共用核心由 `scripts/sync-theme-core.mjs` 单向生成，边界和漂移检查通过。上述结论限定于此次代码集成，不替代完整客户端与跨平台验收。

实际启动根入口 `npm run dev -- --frontend source`，使用独立 `Nuwax Dev.app`、`~/.nuwax-dev` 档案。PC Web 源码热更新地址为 `http://localhost:3000`，壳开发地址为 `http://127.0.0.1:61173`。在真实客户端设置中经本地文件选择器导入 Blue Hour ZIP，已选中“澄蓝 · Blue Hour”并切为“深色”；原生窗口和 AX 状态均已确认，进程保留给用户操作。当前为登录页，登录后的业务页面及多窗口仍需实际账户验收。

本轮只启动开发客户端，没有重新启动打包验收；既有 4/4 次上限继续有效。集成测试与构建日志保存在 `/Users/apple/Documents/Codex/2026-11-02/theme-plugins-dev/logs/`，开发运行日志为同目录上级 `dev-run.log`。

## 2026-11-04 客户端源码调试兼容

`npm run dev -- --frontend source` 已改为调用 PC Web 现有 `build:prod`，产物移入客户端私有临时目录后恢复原 `nuwax/dist`（包含未提交文件）。客户端从同源 Cookie 网关加载本地资源；不启动 UMI 开发服务，也不占用其端口。PC Web 源码、配置、独立 Token 调试逻辑和 IM／资料库上游源码无修改；`agent-platform` 仅作只读契约核对。源码改动后重启重建，主题包目录仍支持热更新。

脚本专项 28 测试、原 PC Web 鉴权 89 测试、网关／会话 165 测试通过；商业门禁 311 文件、3746 测试通过、1 测试跳过。真实 Electron Cookie 验收通过，覆盖 direct、网关 HTTP／WS、HttpOnly 镜像、旋转／注销、真实 Axios POST 与后续鉴权／注册。

真实 Nuwax Dev 已加载本次私有构建，业务页为 `127.0.0.1:24601`，前端工作区恢复干净。真实账户登录仍未验收：对照客户端 `remote` 模式直接加载测试域，也收到 HTTP 200、`0001`、`校验参数异常`，请求已携带验证码参数且未返回 Token。只读后端源码显示该文案对应阿里云验证码验证未通过，校验先于账号密码检查；具体测试环境原因仍需后端日志确认。未修改验证码、鉴权策略或后端代码。证据保存在 `/Users/apple/Documents/Codex/2026-11-04/theme-plugins-dev/`，本轮没有重新启动安装包验收。

## 2026-11-04 登录后的主题同步修复

用户随后确认登录成功。真实页面诊断发现：壳选择 `blue-hour/dark`，主站仍为 `nuwax-default/light`。主题在 Umi render 阶段先于会话恢复探测能力，而能力门要求宿主已登记当前文档；首次拒绝导致页面一次性回退到浏览器主题，之后没有桌面订阅。

仅在客户端 preload 的 `canUse` 主题分支补齐受信文档登记，再执行原能力授权和快照后二次授权；不触发登录、设备注册或业务服务。PC Web、消息／资料库上游源码均无改动。三个新增回归在修复前失败，修复后通过；相关 6 文件、109 测试通过，商业门禁 311 文件、3749 测试通过、1 跳过。

已构建客户端 preload 并在真实客户端验证：刷新后保持登录，主站、资料库和消息 surface 均读取 `blue-hour/dark` 与 `#171b24`；切为浅色后三个 surface 均为 `light/#ffffff`，恢复深色后均为 `dark/#171b24`，两次切换文档均未重载。全新独立业务窗口首次加载也直接使用 Blue Hour 深色。验证没有发送消息，最终恢复原窗口主页和深色选择，关闭调试面板与测试窗口。日志及无凭据诊断见 `/Users/apple/Documents/Codex/2026-11-04/theme-plugins-dev/`。
