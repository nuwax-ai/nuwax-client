# 实施计划：resident-lifecycle

- 对应 spec：specs/resident-lifecycle.md
- 状态：已接受；范围与业务约束已在本会话确认。

## 改动责任与顺序

| 范围 | 文件/模块 | 责任 |
| --- | --- | --- |
| R02/R11/壳侧 R09 | overlay gateway、hostActivity、preload、renderer 状态查询 | 客户端生命周期工作单元 |
| R01/R04/AppDev R09/R10 | 独立 nuwax 通用 SSE、useAppDevChat、AppDev hooks、通知轮询 | Web 生命周期工作单元 |
| R03/R07 | 基座 ComputerServer SSE 与独立 nuwax EmbeddedConsoleTerminal | 输出流控工作单元 |
| R05/R06/R08/R12 | 独立 nuwax 投影/预览与项目日志管理 | 主任务及后续空闲工作单元 |

先建立有意义的失败回归，执行相互独立的改动，保留共享工作区的其他改动。核对 overlay 差异后再同步。基座中立源码单独提交并更新 pin；前端修改在独立 checkout，子模块 pin 以完成的提交为准，产物不冒充更新。

## 测试与回退

每个生命周期修复做正常/取消/错误/迟到响应/并发回归；前端跑 test:conversation 与分层检查，商业轨测试及 main/preload/renderer 构建；base:test 如需运行必须隔离。每一组可通过独立提交回退，不混入无关 UI/登录逻辑。真实客户端验收与长期发布包观测分开报告。

## 偏离记录

若 R03 无现成可靠重放，先实现可证明等价的流控与观测，不强制断开有未送达业务事件的客户端。具体结论及后续边界回填审计报告。
