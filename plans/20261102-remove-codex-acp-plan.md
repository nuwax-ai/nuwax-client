# 移除旧 Codex ACP 接入

## 目标与范围

Codex 已切换到 Nuwax Harness；删除旧 Codex ACP 的启动回退、环境开关、命令别名、安装与检测路径。保留 Nuwax Harness 当前依赖的 `@nuwax-ai/nuwax-harness-acp-ts`、ACP 通信、Codex 会话标识及引擎要求的 `CODEX_*` 配置。

## 实施

1. 统一 harness 适配器解析、依赖检查与引擎管理，缺失时报错，不再运行旧原生程序。
2. 清理构建脚本、包元数据和界面中的旧名称，四种语言同步显示 Nuwax Harness。
3. 替换过时的当前接入文档与资源声明，保留第三方许可证、上游来源和带日期的历史事实。
4. 补充适配器解析与缺失回归，运行 agent-kit 构建、相关脚本测试、商业版全量门禁和主进程/renderer 构建。

## 验收

- 当前源码、配置和脚本不再提供旧 Codex ACP 的原生启动/安装入口。
- Codex 经 harness adapter 启动，既有会话 ID、模型协议和权限行为不变。
- 依赖页与设置页均显示 harness，构建准备命令与资源声明相符。
- 按用户要求提交并推送本次清理；本次不发包、不发布，源码验证不替代真实安装包验收。

## 验证结果

- 商业版全量门禁：315 个测试文件通过、1 个跳过；3910 项通过、18 项跳过。
- agent-kit ESM/CJS 解析回归：2 项通过；准备脚本与第三方声明回归：33 项通过。
- 主进程与 renderer 构建通过，harness 资源准备成功；实际 adapter ACP initialize 握手通过。
- 最后调整后，相关 5 个文件、113 项回归通过；导入分层检查通过。
- 初次 `check:appdir` 被既有 `windowsAutoLaunch.ts:7` 的固定 AppUserModelID 字面量拦截；提交前同步远端安装器修复 `dbd1d4ab` 后，该检查通过。
- 当前实现、配置、脚本已无旧入口；第三方上游来源 URL 和带日期的历史记录保留。
