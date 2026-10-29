# 桌面特性模块（feature module）

客户端里一类相对独立的能力（截屏/录屏、开源组件声明……）按「特性模块」组织：自成一体、通过少数显式接缝接入、可开可关、关闭零痕迹，方便单独维护和后续扩展。本文说明怎么新增一个特性。

`browser` 是内置网页浏览能力，默认启用，开关为 `features.browser.enabled`，按启动注册周期生效；打开网页才创建窗口。`nuwax.linkOpenMode` 选择 `in-app`（默认）或 `system`，保存后下一次打开立即使用。能力未注册、关闭或初始化失败时，普通外链回退系统浏览器。支付、站内业务与受保护附件保持专用流程。浏览器仅通过注册表公开入口接收宿主适配，后续终端直连可独立遵循同一机制。

## 它是什么、不是什么

- **是**：静态注册的、按产品与开关过滤的功能单元；有自己的目录、清单、测试与边界守卫。
- **不是**：插件平台。不做动态加载，注册表是一个写死的数组（见 `specs/feature-extensibility.md` 的取舍）。

## 目录约定（均在 `nuwa-electron-shell/crates/agent-electron-client/src/` 下，全部为新增文件）

```
main/features/
  index.ts                注册表 desktopFeatures + 运行时（startDesktopFeatures / notifyFeatureSessionEnd / disposeDesktopFeatures）
  _kit/                   特性套件：types、register、trustedIpc、lifecycle、scratchDir
  <id>/index.ts           清单：export const xxxFeature: DesktopFeature
preload/features/
  index.ts                preload 侧汇总（featureNamespaces / hostFeatureNamespaces）
  <id>.ts                 preload 命名空间工厂
renderer/features/<id>/   渲染进程页面与逻辑（公开入口 index.ts）
shared/features/<id>/     契约 contract.ts（IPC 通道名 + 公开类型）等 main/preload/renderer 共用代码
```

## 新增一个特性

1. 在 `shared/features/<id>/contract.ts` 定义 IPC 通道名与公开类型。
2. 在 `main/features/<id>/index.ts` 写 `DesktopFeature`：
   ```ts
   export const myFeature: DesktopFeature = {
     id: 'my-feature',
     products: ['nuwax'],          // 不在列表内的产品里，整个特性不存在
     enabledByDefault: true,
     register(ctx) {               // 同步、轻量；重活必须懒初始化
       ctx.ipc.handle(CH.DO, (event, arg) => doIt(arg), UNTRUSTED_RESULT);   // 业务页（受信顶层文档）
       ctx.hostIpc.handle(CH.GET, () => load(), null);                      // 宿主壳渲染进程
       const off = ctx.lifecycle.onSessionEnd(() => cleanup());             // 登出 / 换域 / 过期
       return { dispose() { off(); ctx.ipc.dispose(); ctx.hostIpc.dispose(); } };
     },
   };
   ```
3. 在 `main/features/index.ts` 的 `desktopFeatures` 数组里加一行。
4. 需要让页面调用：在 `preload/features/<id>.ts` 写命名空间工厂，并在 `preload/features/index.ts` 的 `featureNamespaces`（业务页）或 `hostFeatureNamespaces`（宿主壳）里加一项。
5. 若有随包的第三方二进制：在 `third-party/manifest.json` 登记，并确保许可证与源码地址可读（见下「开源声明」）。
6. 跑 `node --test scripts/check-feature-boundaries.test.mjs`。

## 边界规则（`scripts/check-feature-boundaries.mjs` 强制）

| 规则 | 内容 |
| --- | --- |
| R1 | 特性文件只能 import：自身、`main/features/_kit`、`shared/types/hostBridge`、第三方包 / Node / Electron |
| R2 | 特性之外的代码只能经公开入口使用特性：`main/features/index`、`preload/features/index`、`renderer/features/<id>`（目录入口）、`shared/features/<id>/contract` |
| R3 | `_kit` 不得依赖任何特性或客户端其余代码 |
| R4 | 特性内不得出现 `APP_NAME_IDENTIFIER`，产品门控只看清单的 `products` |

渲染进程特性不能 import 客户端 i18n、状态等，需要的东西（翻译函数、桥对象）由调用方作为 props 传入。

## 开关与关闭

- 默认值是清单的 `enabledByDefault`；运行期用设置项 `features.<id>.enabled`（布尔）覆盖，无需发版。
- 关闭或产品不匹配时：`register` 与上下文构造都**不会被调用**——不注册 IPC、不建窗口、不占托盘、不创建临时目录。
- 页面侧：桥上命名空间可能仍在（preload 不知道开关），调用方按各特性文档探测可用性；capture 以 `getCapabilities().available` 为准。

## 接缝（既有代码里与特性机制相关的改动点）

`nuwaxBridgeHandlers.ts`（一次 `startDesktopFeatures`；`cancelTransfers` 在每个会话边界通知特性）、`main.ts`（退出清理 `disposeDesktopFeatures`）、`webviewPerfBridge.ts` 与 `preload/index.ts`（各一处命名空间展开）。新增特性**不需要**再改这些文件。

## 开源声明

随包的非 npm 组件（`resources/*`）必须在 `third-party/manifest.json` 登记；`scripts/generate-third-party-notices.mjs` 从文件与包元数据读取许可证并生成声明，严格模式（`--strict`，pack / 发版必开）下，未登记、读不出许可证、缺源码地址、强 copyleft 许可证、GPL 构建的 ffmpeg 都会让构建失败。

编译进应用 JavaScript 的第三方源码登记在 `third-party/source-components.json`，由打包阶段合并声明并携带许可证全文；不进入原生 helper/capture 的清单与缓存配方。`--capture-only` 的产物保持原有字节和准入规则。
