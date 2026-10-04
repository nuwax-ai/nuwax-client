# 客户端工程边界

## 三层来源

- 本仓 `nuwax-client` 决定产品身份、商业差异、发布版本与安装包。
- `nuwa-electron-shell` gitlink 决定产品中立的 Electron 基座。商业源码保存在外层 `overlay/`，构建前整文件覆写进隔离的基座工作树；不得把覆写结果提交回基座。
- `nuwax` gitlink 决定 web UI 源码。正式版与 beta 均在发布 tag 的隔离构建环境从该 SHA 重新生成 `dist`，不得在构建时追随远端分支。

## 运行边界

- 主进程负责设备注册、登录生命周期、服务启停、域名切换与本地网关。renderer/webview 的宿主调用必须按来源授权；外部网页不得获得宿主桥能力，也不得保存另一套商业登录事实源。
- 后端签发的 `ticket` cookie 是登录事实源；`savedKey/configKey` 是设备注册结果。域名切换走 `configureServerHost`，不得复用旧域 cookie、代理或业务服务。
- 未登录仅运行页面需要的 loopback gateway；商业版不按端口结束未知进程。产品数据目录、工作目录、端口和更新通道与社区版隔离。

## 变更落点与门禁

- 产品中立机制改在基座并经其 PR 合入；商业行为改在外层 overlay。前端 UI/业务逻辑改在 `nuwax`，外层只更新 gitlink。
- 基座纯净守卫验证 overlay 不泄回；`overlay:compat -- --from OLD_BASE --to NEW_BASE` 验证基座演进与当前商业覆写的交集；overlay 一致性检查验证构建输入；双轨测试验证社区与商业行为；发布清单记录三层 SHA 和实际资产摘要。
- 基座兼容检查只读本地 Git 对象，覆盖新增同名文件、删除、重命名两端以及内容/模式变化。人工对照后在 `overlay-base-reviews.json` 绑定路径、目标对象/模式、overlay 内容摘要及审查理由；过期记录拒绝放行。更新器在移动任一源码检出及还原同步产物前执行检查，未通过时保留原源码检出与 WIP；具体字段见 `overlay/README.md`。
- 宿主桥的自包含类型事实源保存在前端仓，商业 overlay 使用生成快照；`host-bridge:check` 防止双端类型漂移。浏览器和旧宿主按可选能力消费，preload 提供完整契约；类型门禁不改变来源授权、ticket 或 IPC 生命周期。
- 自动化通过、安装包签名通过、真实设备与账号验收分别记录。发布指针只有在资产、签名和来源校验成功后才更新。
