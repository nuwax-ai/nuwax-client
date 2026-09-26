# 实施计划：#2537 加载恢复

- 对应规格：specs/bug2537-recovery.md
- 状态：已接受（2026-09-26 用户授权实现验证），已完成（现场/包级层待验证）

## 改动
- overlay main/services/loopbackGateway/index.ts 与 index.test.ts：串行生命周期、清迟到 start
- overlay renderer/components/pages/NuwaxHostWebview.tsx：故障事件与本地重试面板
- overlay renderer/services/webviewLoadFailure.ts 与测试：主文档错误过滤、URL脱敏
- scripts/acceptance：独立用户目录真实 Electron 故障/重试 fixture

## 顺序与验证
先添加 race 测试并在基线证明红，再修队列。补恢复 helper/组件；targeted tests、商业轨、base:test 仅隔离基座、overlay check、pin check、构建与 fixture。

## 风险与回退
商业 host webview 已为 overlay 托管文件，需审查 pin 演进差异。所有变更仅此独立分支，按提交回退。既有完整 suite 失败先比基线，不扩散修。

## 偏离
历史基座 recovery 对象已不可得，按当前 pin 新实现；不重复合旧 pin。

验证结果见 docs/acceptance/20260926-bug2537-recovery.md。
