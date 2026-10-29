# v3.1.0 浏览器扩展能力与链接打开设置

状态：实现及源码/本机 Electron 验证完成，安装包验收待执行。需求：20261029-browser-capability-intent.md；规格：../specs/browser-capability.md。

1. 复用 electron-browser-shell 固定提交的 WebContentsView 承载代码，先做 Electron 40 实测；保留 MIT 许可证和来源。裁剪标签与扩展商店。
2. 接入 browser DesktopFeature、独立工具栏 preload/renderer 与公开宿主适配入口。能力关闭/失败回退系统浏览器，启动不创建网页窗口。
3. 统一普通外链路由和本机打开偏好；区分支付用途并同步桥契约。保留 POST/opener/referrer、登录、附件和离开确认。
4. 实现已确认菜单、查找、缩放、打印、错误重试、四语文案和主题；置顶只采用原生 API。
5. 特性边界、桥一致性、相关测试和 test:commercial；真实 Electron 与安装包验收分别记录，不以源码门禁替代。

## 实际证据与偏离

- 实施开始时工作区干净，分支 release/v3.1.0，已安装 Electron 40.8.2。
- 平台安装包验收尚未执行；不自动发布或创建版本。
- 浏览器核心裁剪接入在 Electron 40.8.2 验证通过，无需升级 Electron。采用单网页 WebContentsView，工具栏使用本地页面和窄 IPC；未引入扩展商店。
- 为兼容旧前端，未标注用途的外域 native.openWindow 仍作为专用窗口；新前端普通外链标注 page，支付显式标注 payment。业务专用窗口内的普通外链继续受打开偏好控制。
- 商业测试 3765 通过、18 跳过，前端定向 93 通过，脚本测试 43 通过；本机真实 Electron、业务会话与 14 次下载验收通过。全库 tsc 与 HEAD 均为 249 项现存错误，无新增。
- 详见 `docs/acceptance/20261029-browser-capability.md`。前端源码修改尚在子模块工作区，正式打包前需冻结源码及对应产物 pin。
