# 启动全部反馈与商业版旧沙箱资源清理

## 目标

- 点击服务卡片的「启动全部」后立即显示 loading，直到批量启动与状态刷新结束；执行期间拒绝重复点击和相冲突的服务操作。
- 商业版的本地准备、CI 准备和安装包不再构建或携带旧沙箱 helper、sandbox-runtime、sandboxed MCP 资源。基座社区版流程保持原样。

## 实施

1. 在商业版 `ClientPage` overlay 中给批量启动添加独立执行状态和同步防重入保护。
2. 从外层 `prepare` 的商业资源清单删除旧沙箱资源；商业版 CI 的 `prepare:all` 通过 overlay 跳过对应脚本。
3. 从本地打包配置与正式、预发布 CI 打包配置过滤旧沙箱资源，并移除 Windows helper 的断言。
4. 运行外层准备和打包测试、商业版渲染构建、overlay/pin 检查；Windows 安装包行为以 CI/实包为准。
