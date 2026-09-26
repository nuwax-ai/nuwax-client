# 客户端 release/v1.0.x 修复合流计划

- 用户授权将已验证客户端修复合入 `release/v1.0.x`；从目标 `50ab2083` 创建隔离分支，合流来源 `88c9db1e`。
- 保留目标最新 ticket 有效性、cookie 统一策略、有界镜像等待和 Webview 语言事实源；叠加原 Bug 修复、下载、loopback 串行生命周期与双 pin 工具链。
- 三处冲突分别采用并集测试和语言 revision 防迟到回调：tokenScopes 测试、loopback index 测试、renderer i18n；同时审查两处自动合成实现。
- 三个子仓独立检出，COW 复制依赖资源；不触碰共享 GUI、旧子仓 WIP、Java 或移动端。
- 跑脚本、商业、社区测试，生产主进程/renderer 构建，复核 overlay、base purity、源码/产物 pin。
- 只生成隔离合流提交；根 agent 独立评审后负责更新目标分支。不推送或发布。
