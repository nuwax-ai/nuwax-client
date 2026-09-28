# 实施计划：registration-v2-device-id

- 对应 spec：`specs/registration-v2-device-id.md`
- 状态：代码实现、本地验证与 macOS 开发客户端测试域真实登录/注册完成；生产域和 Windows 实机验收待补。

## 改动文件清单

| 文件 | 动作 | 说明 |
|---|---|---|
| overlay/.../ipc/commercialAuth.ts、.test.ts | 改 | 注册 v2 路径与设备身份请求回归 |
| overlay/.../system/commercialDeviceId.ts、.test.ts | 增 | 硬件读取与持久身份 |
| overlay/.../system/deviceId.ts、.test.ts | 增 | 覆写基座，商业分支接入，社区行为不变 |
| overlay/README.md | 改 | 同步商业注册与身份事实 |
| scripts/acceptance/loopback-login-sync.cjs | 改 | native registration 夹具使用 v2 |

## 实施顺序

1. 保留现有 WIP，先落需求、规格、计划。
2. 实现商业身份解析与测试，接入现有统一 getDeviceId。
3. 切换注册 v2，保留 ticket/savedKey/会话隔离，同步文档和验收夹具。
4. 同步 overlay，运行商业测试与主进程构建、check:pin；社区测试只在临时隔离副本中运行。

## 证明成立的测试

- 身份读取与持久化边界测试，注册请求 v2/deviceId 回归。
- `npm run test:commercial`、主进程 esbuild、`npm run check:pin`、`git diff --check`。

## 风险与回退

- v2 请求/返回契约暂按现有协议；真实后端行为与历史合并单独确认。
- Windows/Linux 身份可能迁移一次。回退源码后不得删除用户身份文件或重写 pin。
- 无有效硬件身份且身份文件丢失时，无法跨重装保证原 ID。

## 偏离记录

无实现范围偏离。社区验证用基座 HEAD 的临时源码副本与当前依赖/资源，避免清理共享 checkout 的 overlay。

## 验证结果（2026-09-27）

- 专项 3 文件 / 47 用例通过。
- 商业全量：146 文件通过 / 1 跳过；1814 用例通过 / 18 跳过。
- 隔离社区基线：121 文件通过 / 1 跳过；1478 用例通过 / 18 跳过。初次副本缺少忽略的 mcp-proxy-ts 运行资源，补齐当前资源后通过。
- 商业生产主进程 esbuild 通过；overlay 同步检查 0 差异；应用目录守卫、新身份模块 ESLint、diff 空白检查通过。
- macOS 真实 IOPlatformUUID 探针：新旧哈希相同，持久化回读及删除测试身份文件后的重建均相同（只使用临时目录）。
- macOS 开发客户端真实登录：进入 `/home`；测试后端 `https://testagent.xspaceagi.com` 的 v2 注册返回 HTTP 200 / `code=0000`，出现 `reg-committed`，配置已写入。未记录账号、密码、cookie 或注册凭据；历史重复设备合并仍未验证。
- 真实 Electron 本地登录/网关/原生注册 ticket 夹具通过（43 请求），注册探针使用 v2；这是本地夹具，不代表线上 v2 契约验收。
- `check:pin` 未通过：开始实施前已有的 5 个 Computer Use app 产物非 overlay 托管，保留原状。
- 全仓 `tsc --noEmit` 未通过（219 条错误，均不在本次改动文件）；`deviceId.ts` 全文件 lint 仍有从基座保留的 `logSystemInfo` 动态 require 报错。
- 未提交、未推送、未打包发版；未修改基座 pin。
