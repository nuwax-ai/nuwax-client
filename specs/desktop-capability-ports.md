# 规格：desktop-capability-ports

- 对应 intent：plans/20261015-desktop-capability-ports-intent.md
- 状态：技术评审通过（用户授权直接实施，拷问由实施者依据源码自答，结论见文末）

## 需求基线

继承 intent：三项扩展能力统一以 `DesktopFeature` 接入；`_kit` 去专属字段；Computer Use 迁入 `features/computer-use`；对外契约与用户可观察行为不变。不做：统一权限端口、打包资源注册表、本地文件缓存实现、acpEngine 去整份覆写。

## 方案设计

### 架构落点

```
宿主（nuwaxBridgeHandlers / commercialAuth / main.ts / trayManager / acpEngine）
  └─ 只经 main/features/index 公开入口 + 宿主端口实现（main/services/featureHost.ts）
特性套件 main/features/_kit：通用端口类型与实现，不含特性 id/专属字段（R5）
特性：capture / open-source-notices / local-files / computer-use
```

### 特性清单（DesktopFeature）新增字段

| 字段 | 用途 | 替换 |
|---|---|---|
| `lockedOff?: string` | 发版强关原因；为真时忽略设置覆盖，零注册 | `features/index` 对 local-files 的硬编码 |
| `bridge?: { namespaces; canUse?(name) }` | 声明本特性拥有的 `NuwaClawBridge` 命名空间与主进程侧额外判定 | canUse 处理器里的 capture/localFiles 分支 |
| `requests?: { authorize(details); isSource(details) }` | 请求门与凭据过滤共用的来源判定；按产品过滤，**与注册与否无关**（关闭时仍拒绝本特性 scheme） | `authorizeDesktopFeatureRequest` 只转 local-files |
| `beforeReady?(commandLine)` | app ready 前的命令行开关 | `configureCaptureBackend` 专属导出 |
| `agentServers?: readonly string[]` | 本特性保留的本地 MCP 条目 id | — |

### FeatureContext 端口（全部通用）

| 端口 | 形状 | 宿主实现 |
|---|---|---|
| `lifecycle` | 既有 `onSessionEnd`/`onQuit`，新增 `onSessionInvalidated(fn)`（同步撤销）、`onServicesStarting(fn(signal))`（引擎启动前等待）、`onServicesStopping(fn)`（随服务停止等待，失败上报） | commercialAuth 的 invalidated/start/stop/stopExtras |
| `settings` | `read(key)` / `write(key, value): boolean` | db readSetting/writeSetting；取代只读 `getSetting` |
| `dataDir` | 特性持久目录 `~/.nuwax/<id>`（与 scratch 同根，scratch 只管带 TTL 的子目录） | registry 计算 |
| `session` | `isAuthenticated()` | `!!currentTicket()` |
| `windows` | `getMain()` | `ctx.getMainWindow()` |
| `activities` | `set(activity \| null)`，activity = 若干 `{ id, labelKey, run }` | 托盘按注册表顺序渲染，`runDesktopActivity(featureId, actionId)` 供 Linux 快捷键 |
| `agent` | `setLocalMcpServer(id, entry \| null)`、`hasLocalMcpServer(id)`、`resolveNodeBinary()`、`registerSessionParticipant(factory)` | `mcp_local_config` upsert/remove + MCP Proxy 同步（原 CUA 逻辑原样搬到宿主）；binaryLocator |
| `workspace` | 不变 | 不变 |

### 宿主侧公开入口（main/features/index）

- `startDesktopFeatures(options)`：新增注入 `settings`、`session`、`windows`、`agent`、`activities` 宿主实现；注册 `features:registered`（宿主壳受信）返回已注册 id。
- `emitFeatureSessionInvalidated()`、`runFeatureServicesStarting(signal)`、`runFeatureServicesStopping()`：后者返回 `{ success, failed: id[] }`。
- `runFeatureServicesStarting` 先清理**未注册**特性在 `mcp_local_config` 中保留的条目（零残留），再按注册顺序等待各特性。
- `disposeDesktopFeatures()` 幂等并记住收尾 Promise；`settleDesktopFeaturesForQuit()` 等待同一 Promise（commercial `stopExtras` 用，8 s 步进上限不变）。
- `createAgentSessions()`：每个引擎一份组合对象 `{ setup, start, finish, cancel, remove, destroy }`；参与者在**每次调用时**按当前注册表惰性解析（引擎可能先于特性构造）；未注册特性保留的 MCP 条目在 setup 时从会话 `mcpServers` 剥离。`start` 返回 `{ active, turns }`，引擎用 `active` 替代原 `cuaTurn` 判定。
- `isFeatureCapabilityAvailable(namespace, name)`：无归属返回 `undefined`；有归属则要求已注册且运行期开关仍为开，再叠加清单 `canUse`。
- `runDesktopActivity(featureId, actionId)`、`desktopFeatureActivities()`（托盘读取）、`onDesktopFeatureActivitiesChanged(fn)`。
- `prepareDesktopFeaturesBeforeReady(product, commandLine)` 返回 schemes 并执行 `beforeReady`。

### preload / renderer / shared

- `preload/features/index`：`hostFeatureNamespaces` 增加 `computerUse`（方法与通道名不变）与 `features.registered()`；新增 `probeFeatureCapability(capability, bridge, authorize)`，capture/localFiles 的格式与可用性探测移入各自 preload 文件，`preload/canUse.ts` 只保留通用流程。
- 控制浮窗 preload 移到 `preload/features/computer-use/controlPreload.ts`，esbuild 输出名 `preload/cuaControls` 不变。
- `renderer/features/computer-use`：`CuaControls`、`CuaSettingsRows`、`ComputerUseSettings`（自 SettingsPage 原样搬出，翻译函数/行组件/样式/提示文案由调用方注入）。SettingsPage、App.tsx 只经公开入口使用，且以 `features.registered()` 包含 `computer-use` 为显示条件。
- `shared/features/computer-use/{contract,presentation}`：原 `shared/types/cuaRuntime`、`shared/cuaPresentation`；`electron.d.ts` 经 contract 引用类型。
- `shared/hostCapabilities.ts` 的白名单与 capture 变体不变（属公开契约，与前端生成快照对齐）；只移除运行判定中的特性分支。

### 数据与契约

不变：IPC 通道 `cua:*`、`cua:runtime`、`cua:control:*`；`electronAPI.computerUse` 方法；`NuwaClawBridge` 与 canUse 白名单；`step1_config.computerUse*` 字段；`mcp_local_config.mcpServers.cua` 条目形状；`~/.nuwax/computer-use` 与 `userData/computer-use` 目录；托盘文案键。新增仅宿主壳内部通道 `features:registered`。

## 异常与失败场景

- 特性关闭/产品不匹配：不注册、无托盘项、设置区块隐藏、canUse false；服务启动时移除残留 `cua` 条目，引擎会话剥离 `cua`。
- 服务停止时某特性清理失败：服务停止结果为失败（与原「Computer Use cleanup failed」等价，错误文案改为通用并保留特性 id 日志）。
- 引擎在特性注册前构造：参与者惰性解析，不会永久缺失。
- 退出：特性收尾从「Desktop features stop」开始（早于引擎停止），commercial extras 步骤以 8 s 上限等待同一 Promise；will-quit 双触发保留且幂等。
- 单个特性端口回调抛错：记录日志，不影响其他特性（沿用 lifecycle 隔离）。

## 测试计划

- 迁移原有 CUA 测试（computerUse/mcpGateway/sessionAuthority/taskController/vlmDiagnostics/windowScope/runtime handlers/CuaControls）到新目录，mock 由 `vi.mock(db)` 改为注入宿主端口；断言不删减。
- 新增：_kit 生命周期 v2、activities、registry（lockedOff、bridge 归属、requests 与注册无关、agentServers 残留清理、惰性参与者、settle 幂等）、宿主 MCP 端口实现、托盘渲染顺序、canUse 主进程/preload 探测下沉的回归。
- 改：commercialAuth、acpEngine.cua、businessRequestRouting、sessionAuthInjection、nuwaxBridgeHandlers 相关测试按新入口调整。
- 门禁：`npm run test:commercial`、`npm run test:scripts`（含边界 R5）、`npm run host-bridge:check`、客户端 main/preload 构建。真实安装包与真机 Computer Use 验收另列，不以单测替代。

## 已否决的备选方案

- 统一系统权限端口：Computer Use 授权归 helper 自有 TCC 身份，与客户端录屏权限不同源。
- 把 MCP 注入改为引擎启动时由宿主合并、不再写 `mcp_local_config`：会改变存储与 MCP Proxy 行为，需要迁移，留待后续。
- 动态插件加载：维持静态注册表。

## 拷问记录（实施者依据源码自答）

1. 关闭特性后旧 `cua` 条目会不会被引擎直连？会——因此加 `agentServers` 残留清理 + 会话剥离。
2. 引擎早于特性注册构造会怎样？原 `new CuaEngineSessions()` 字段初始化；改为惰性解析。
3. 退出等待会不会变短？不会；stopExtras 仍以 8 s 等待同一收尾 Promise，且开始得更早。
4. 托盘顺序？注册表把 computer-use 排在 capture 前，渲染结果与原菜单一致。
5. 设置页如何得知关闭？新增宿主壳通道 `features:registered`；preload 无法得知开关。


## 附：Computer Use 旧→新路径映射（移植 CUA 分支后续提交时对照）

| 旧 | 新 |
| --- | --- |
| `main/services/cua/*`（computerUse/taskController/mcpGateway/sessionAuthority/controlWindow/windowScope/cuaOutcome/cuaGuidance/vlmDiagnostics） | `main/features/computer-use/*` 同名文件 |
| `main/ipc/cuaRuntimeHandlers.ts` | `main/features/computer-use/index.ts` 的 `register()` |
| `main/services/cua/ports`（新增） | `main/features/computer-use/ports.ts`（宿主接缝） |
| `shared/types/cuaRuntime.ts` | `shared/features/computer-use/contract.ts` |
| `shared/cuaPresentation.ts` | `shared/features/computer-use/presentation.ts` |
| `preload/cuaControls.ts` | `preload/features/computer-use/controlPreload.ts`（esbuild 输出名不变） |
| `preload/index.ts` 的 `computerUse` 命名空间 | `preload/features/computer-use.ts` |
| `renderer/components/CuaControls.tsx` | `renderer/features/computer-use/CuaControls.tsx`（经 `index.ts` 公开） |
| SettingsPage 内联 Computer Use 区块 | `renderer/features/computer-use/ComputerUseSettings.tsx` |
| `computerUse.ts` 的 db/binaryLocator/packages-mcp 依赖 | `ports.ts` 宿主接缝（实现见 `main/services/featureHost.ts`） |
| `commercialAuth` 直连 `suspendCua` | `../features` 生命周期 v2 汇合点 |
| `acpEngine` 的 `CuaEngineSessions` 字段 | `createDesktopAgentSessions()` 组合对象（`agentSessions`） |
