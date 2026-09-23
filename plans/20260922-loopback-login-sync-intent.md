# 需求说明：客户端 loopback 登录态与资源路由

- 日期：2026-09-22；来源：20260921 调研/计划、代码复核及用户授权独立 worktree 实施。
- 规格：`specs/loopback-login-sync-header-channel.md`。

## 背景和目标

gateway/direct 切换后继续使用当前登录。普通页面业务请求走 Bearer，旧 ticket 不覆盖新 token；已支持的消息/资料库页面及内部资源正确加载；登出、换域和换账号后迟到结果不回填凭据。

## 用户角色

Nuwax 桌面用户与配置企业域的用户。普通浏览器和小程序保留宿主兼容行为。

## 功能范围

本期做：网关与 direct 出口剥 ticket、受信页面 Bearer 注入、微应用资源路由、独立窗口保持 pathname、四处鉴权导航统一、结算轮询同源化、cookie 捕获与注册代次保护。

本期不做：后端改造、自动续期、qiankun 改造、未知微应用文档根自动发现、多业务域共享 token、发布上线。

## 核心流程与状态

登录产生 token → 撤销旧会话操作 → 保存 token 并捕获同会话 ticket → 注册/启动服务。普通请求不发送 ticket；主进程首次注册保留配对的显式 ticket。切形态沿用候选 token 键迁移；登出/换域立即撤销旧代次。

保留 accessToken/ticket/step1_config/loopback 键空间；新增只读 auth.getContext 返回业务 origin、gateway origin、加载形态，不暴露凭据。

## 权限与异常

注入按完整 origin（scheme/host/port）及可信 frame 判断，defaultSession 不等于可信。处理旧 cookie、新 token、异步期间登出/换域、资源 302、登录过期、旧宿主缺桥等场景。不能给 renderer 的 reg URL 路径 cookie 特权。

## 待确认

后端各端点的 Bearer-only 支持、ticket/token 恒等及轮换语义、真实支付和资源 URL 契约须在上线前取证。前端没有 refresh 接口不能证明后端没有续期，自动化不替代安装包/真实后端验收。
