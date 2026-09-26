# #2537 恢复规格

依据 plans/20260926-bug2537-recovery-intent.md，用户已授权开发验证。

1. 生命周期队列共用一个 promise 链，refresh 在单次操作内调用内部 stop/ensure，禁止递归入队死锁。失败不毒化后续队列。
2. start await 期间配置已改 direct，释放刚起的网关；不能发布 enabled=true。上下文/镜像 origin 也要释放。
3. 主 frame did-fail-load（除 -3）和 render-process-gone 进入失败状态；成功导航清掉失败；did-stop-loading 不等于成功，不能清失败。解析失败结束 resolving 并显示重试。
4. 重试/工具栏刷新失败页面重建 guest（webviewEpoch），正常刷新仍 reload 保留路由；新模式/新域清失败重解析。
5. 面板按钮跟随壳当前 locale；错误诊断不输出 query/fragment/userinfo。
6. 以延迟 start race 红绿测试、恢复状态测试和真实 Electron webview fixture 验证。真实安装包/Windows 与现场证据单列。
