# 需求说明：#2537 加载模式切换与失败恢复

## 背景和目标
现场 1.0.25 从本地加速切直连白屏，缺 guest Console/Network。当前基线 951aa597 / 基座 52bd898f 不含历史 173f722a 生命周期串行化，也无 webview 错误恢复面板。修复已可控复现的竞态并提供失败反馈，现场原因保持待取证。

## 用户角色与范围
客户端用户切换 direct/gateway、重试失败页面。仅生命周期队列、失败/崩溃恢复；不改鉴权、语言、菜单、终端，不关闭禅道。

## 核心流程与状态
ensure/stop/refresh 串行执行；启动期间切 direct 时关闭迟到句柄并清理请求上下文和 ticket origin。guest 主文档失败或 renderer 崩溃显示本地恢复面板，重试创建新 guest。子 frame 失败与 ERR_ABORTED 不覆盖主页面。

## 权限与异常
恢复仅重解析受信配置，不向外发日志；诊断 URL 剥用户信息、查询、fragment。失败日志含 errorCode/description，避免 token。

## 待确认
现场客户端/Windows 包复验仍待取得用户场景，本轮本地 fixture 与单测不证明现场根因。
