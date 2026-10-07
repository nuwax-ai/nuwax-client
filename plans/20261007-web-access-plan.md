# 实施计划：web-access

- 对应规格：`specs/web-access.md`
- 状态：网页访问修复、前端完整 CI 门、冻结双 pin 与最终 macOS 候选包已验证。首轮 beta CI 因私库凭据为空失败，没有生成 Release 或安装资产。用户已明确授权凭据更新及重建失败 tag；两份私库真实 Basic 鉴权校验通过，CI 配置已补齐，继续全平台构建及发布验证。详见 `docs/acceptance/20261007-zcode-web-access.md`。

## 改动文件清单

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| overlay/.../main.ts | 修改 | 初始第三方 guest 不切临时会话，轻量桥按实际文档校验 |
| overlay/.../system/webviewPolicy.ts + test | 修改 | 普通网页导航、共享会话弹窗、同业务集合判定 |
| overlay/.../ipc/nuwaxBridgeHandlers.ts + tests | 修改 | native.openWindow 会话一致 |
| overlay/.../sessionAuthInjection.ts + test | 修改 | 业务 GET 文档与 API/frame 凭据边界 |
| overlay/.../preload/webviewPerfBridge.ts + trust test | 修改 | 按实际 URL 验证桥暴露，拒绝凭据 URL 与非网页文档 |
| overlay/.../hostActivity.ts + test | 修改 | 关闭时使用已捕获 WebContents，避免 destroyed getter 异常 |
| scripts/acceptance/popup-login-session.cjs | 修改 | 真实窗口、导航和票据回归 |
| README.md / 验收记录 | 修改/新增 | 新行为与实测证据 |
| 独立前端微应用适配与 package.json | 修改 | 冻结 pin、补丁重制、移除生产构建自动升级、恢复误删的类型和 CI 门 |
| .github/workflows/ci.yml / release-electron-dev.yml | 修改 | 私库 Basic 鉴权支持配套用户名，保留 oauth2 默认与原有门禁 |

## 实施顺序

1. 读取今日 ZCode 需求并盘点 WIP、确定默认凭据边界。
2. 前端独立检出修复补丁和确定性构建；商业 overlay 修改导航契约，可并行。
3. 同步 overlay，运行专项与真实 Electron 夹具，修复实际失败。
4. 商业完整门、社区隔离副本质量门、独立 verifier 复核。
5. 集成冻结前端与产物 pin，检查版本序列，形成可发版状态与交接证据。

## 风险与回退

共享会话使第三方 Cookie 可持久化，这是浏览器式访问行为。ticket 仍需逐请求过滤，实际 Electron 夹具必须覆盖跨域和回跳。旧源 preload 白名单随换域失效；保留现有生命周期编排。修改独立提交，必要时撤回本批商业 overlay 与前端 pin，不能改写已发布历史。

## 偏离记录

共享会话仍受浏览器 Cookie 的主机作用域约束：网关同主机的其他端口无法证明 ticket 归属，或 Cookie 来源读取失败时，会保守移除 ticket，其他 Cookie 保留。此例外已同步规格和 README；独立第三方自有 ticket 在真实 Electron 夹具中验证。
