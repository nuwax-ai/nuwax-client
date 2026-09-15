# 实施计划：client-shell-feedback

- 对应 spec：`specs/client-shell-feedback.md`
- 状态：已接受（2026-09-16）

## 实施步骤

1. 扩展更新状态，关于页展示目标版本/发布日期/发布说明；顶栏更新项统一改为打开 about tab，并覆盖失败态。
2. 抽出可测试的服务故障判定：登录态 + 生命周期终态 + ready 后连续两轮健康异常；替换现有“任一服务未运行”圆点。
3. 扩展 webview layout 桥的拖拽矩形协议和商业 overlay 校验转发；renderer 清理旧热区并让工具栏按矩形渲染。
4. nuwax 在沉浸式页面中标记明确空白 spacer，集中采集 DOMRect，在路由/resize/布局变化时上报。
5. 运行三层定向测试、商业双轨门禁和真实安装包验收；外层只更新本次相关子模块 pin。

## 交付约束

- 不回退当前基座子模块内商业认证、网关、设置页和图标的未提交修改。
- overlay 托管文件从 `overlay/` 修改后同步到基座，不直接制造双事实源。
- `base:test` 会清 overlay，必须在隔离副本执行。
