# 两版加载 nuwax（PC Web）链路差异：社区版 NuwaClaw vs 商业版 Nuwax

- 记录日期：2026-09-13
- 口径：**社区版** = nuwaclaw `feature/electron-client-0.14` 消费基座 `community/main`@01189cf0（0.13 形态血统，version 0.14.0）；**商业版** = 本仓消费基座 main 链（本文源码证据取自 origin/main 顶端 26570532，含 overlay 覆写后的运行形态）。
- 核实方式：两侧源码实读（组件/桥/preload）+ 社区版 2026-09-13 dev 运行日志实测（webview 加载 `https://testagent.xspaceagi.com/`）。
- 关联：`20260912-edition-matrix.md`（三版横向总表）§十 增补；本文为其「加载 nuwax」维度的深潜。

## 〇、共同底

两版都是 **Electron webview 承载 nuwax、登录在 webview 内完成、壳不自绘登录页**；guest preload 均以 `window.NuwaClawBridge` 为唯一注入面（web 侧收口 `src/utils/nuwaClawBridge/index.ts`，类型契约 `src/types/global.d.ts`）。差异集中在 URL 解析、登录态保持、桥面能力三层。

## 一、Webview URL 解析：单向直连 vs 四级决策

**社区版**（`crates/agent-electron-client/src/renderer/components/pages/BrowserHomePage.tsx` + `src/renderer/services/utils/sessionUrl.ts`）：

- 域名唯一来源 = 配置的业务域（`currentDomain` / step1 `serverHost`），拼出 home / redirect / chat URL 直连加载。
- 无 dev 自动指向、无前端域覆盖、无网关形态。**dev 会话同样加载配置域**（实测：dev 模式加载 testagent，而非 localhost:3000）。

**商业版**（`src/renderer/components/pages/NuwaxHostWebview.tsx`@26570532）四级优先决策：

```
① NUWAX_WEBVIEW_ORIGIN 调试覆盖（settings 键 nuwax.webviewOverride，显式调试意图，最高优先）
② dev（import.meta.env.DEV）→ loopback 网关 origin 或 NUWAX_DEV_HOST（localhost:3000）
③ 生产 + loopback 网关启用（nuwax.loopback）→ 网关 origin（同源加载）
④ 直连 → step1_config.serverHost / DEFAULT_SERVER_HOST
```

且监听 `nuwax:loopback-changed` / `nuwax:serverHostChanged` 事件**动态重解析**——企业登录切域（桥 `auth:configureServerHost`）后 webview 自动加载新域 `/Login`。社区版切域依赖重启后读配置，无动态链路。

## 二、Loopback 网关形态（商业独有）

商业 overlay 带真实 `loopbackGateway` 实现（基座 main 上为桩，`f68964eb` 商业实现迁出基座）：nuwax 经回环网关**同源**加载，登录态/Cookie 与回环 origin 绑定，跨域类问题从根上消失；同时为 web 同域调用本地服务（`localFiles` 文件树：nuwax → 网关 → lanproxy → nuwax-file-server 61xxx）铺路。社区版无此概念，webview 永远直连业务域。

## 三、登录态模型：ticket cookie vs 域级 token 桥

| | 社区版 | 商业版 |
|---|---|---|
| 事实源 | webview 内登录 + ticket cookie | **webview 唯一事实源**（基座 `a27aecee` 重构） |
| 凭证载体 | `ticket` cookie（Electron 回读、`persistTicketCookie` 落盘、reg 令牌一次性灌入后即清） | 域级 token（`tokenScopes`），桥 `auth.getToken/persistToken/clear` 双向同步 |
| 重启免登 | 取决于 cookie 存活，实测存在重登场景 | 免登（token 持久化） |
| 换域 | 重启后按新配置加载 | `auth:configureServerHost` 事务化换域，webview 自动重载新域登录页 |
| 登出联动 | 无服务联动 | 登出清凭证 + 停本地服务 |

## 四、guest 桥面对照（preload 暴露给 web 的能力）

| 命名空间 | 社区线 | 商业版 | web 侧用途 |
|---|---|---|---|
| `perf` | ✅ | ✅ | 性能打点 |
| `host.getProduct` | ✅（01189cf0 补，返回 `nuwaclaw`） | ✅（`nuwax`；存量宿主 `nuwawork`） | 按宿主开关桌面能力/降级 |
| `auth` | ❌ | ✅ | 免登/切域/登出联动 |
| `native`（saveImage / openWindow） | ❌ | ✅ | 右键另存图片、独立窗口（`_shell=1` 全屏页承载） |
| `localFiles` | ❌ | ✅ | 本地目录文件树 |
| `events.onHostCommand` | ❌ | ✅ | 壳下发 `toggle-second-menu` / `new-task`（Ctrl/Cmd+N 壳层拦截转发） |
| `theme` | ❌ | ✅ | 女娲主题同步（壳原生 UI 跟随 web 调色板） |
| `layout` | ❌ | ✅ | 二级菜单折叠协调（`setSecondMenuAvailable/Collapsed`） |
| `i18n` | ❌ | ✅ | web→壳语言同步 |

web 侧对全部命名空间 `?.` 降级守卫，宿主缺能力即 no-op——社区桥面缺口不致炸、只是无该能力。

## 五、身份与请求语义

- **请求头**：商业版注入 `x-client-type`（随 `APP_NAME_IDENTIFIER` 派生，localhost dev 域跳过）；社区版无。
- **UA**：社区版 = 系统 UA + `女娲 Nuwax/<版本>` 后缀（`BrowserHomePage.tsx`）；商业版 = 产品名替换默认 `@nuwax-ai/nuwaclaw/<ver>` 标识（`71bc01ee`）。
- **注入配置**：社区 `NUWAX_PORT_OFFSET=0`（60xxx）、`~/.nuwaclaw`、更新通道 `nuwaclaw-electron`；商业 +1000（61xxx）、`~/.nuwax`、`nuwa-work-electron`。详见总表 §二。

## 六、结论：社区净缺口与已收口项

**已收口**：`host.getProduct()` 已按商业同款契约补入社区线（构建期注入派生、不走 IPC、无硬编码身份分支）——web 新版可凭它识别 NuwaClaw 宿主。

**待落地（web 侧，建议随 nuwax 下轮）**：`isImmersiveShell()` / `NavigationStylePanel.isNavStyleLocked` 的判定从「桥存在」收窄为「桥存在且 `getProduct() ∈ {nuwax, nuwawork}`」——否则社区宿主（桥已注入）会被 web 套上沉浸式单栏锁定与商业 chrome 几何避让（TOP 36 / CONTENT_TOP 28 / RIGHT 130 / TOOLBAR 44，按商业顶行写死）。旧商业宿主（无 host 命名空间）的兼容取向由商业侧定：保旧宿主可用 `getProduct() !== 'nuwaclaw'` 反转默认。

**社区侧净缺口（产品决策项，非缺陷）**：
1. **免重登**（auth 桥缺失，每次重启可能重登 webview）——属商业「登录架构重做」行为面，按「社区只保 0.13 历史兼容」边界默认不接，是否移植待拍板。
2. **dev 联调不便**——社区线无 dev 自动连本地 nuwax dev server 机制（商业 `NUWAX_DEV_HOST` 逻辑约十行可平移，语义一致）。
