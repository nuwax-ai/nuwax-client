# 门禁与测试减负

目标：去掉没有独立保护价值的流程和重复执行，保留行为回归、权限隔离、契约与发布验证。

## 本次范围

- 取消 Claude/Codex/ZCode 首次源码编辑必失败的 plan hook 及其专属自测，同步计划模板；保留凭据、部署保护。
- 本仓规则覆盖安装器默认流程：按变更风险选验证，不强制失败测试先提交，不要求每个 PR 本地重跑全量。
- CI 去掉 commercial 已覆盖的 Linux 桌面子集与 Linux 普通 Go 测试重复执行；保留 macOS/Windows 子集和 Linux race 检查。
- SDLC 自测仅随 hook、评估脚本或 workflow 改动触发，使用项目 Node 24。
- 删除只限制脚本源码写法的测试，以及已无生产调用的旧启动 helper 和其孤立测试。i18n key 格式参与 renderer 运行判断，属于实际契约，其测试保留。

## 验证

- 执行剩余 SDLC hook 自测，检查配置和 workflow 语法。
- 执行改动涉及的脚本路径、语言资源测试和现有登录生命周期测试；检查删除符号无引用。
- 不触发打包、发布或远端变更；不改现有 IM、样式 WIP。

## 后续重构顺序

1. 统一主进程服务启动、重启、登出、退出的编排属主：目前 `main/window/serviceManager.ts:662`、`main/ipc/processHandlers.ts:84`、`main/main.ts:656` 分别维护服务清单/顺序。先抽服务适配器并统一执行入口，保留 AuthLifecycle 的串行和代次控制。
2. 拆分 renderer/App.tsx 的启动、服务状态、语言主题与导航职责：`App.tsx:1242` 与 `ClientPage.tsx:213` 重复按服务拼启动配置；服务配置归主进程，UI 只发送意图。共享服务阶段/错误码及事件契约，减少 `phase: string`、手写 payload 和按错误文案判断状态。
3. 收敛依赖管理：`DependenciesPage.tsx:149` 的逐项检测以及单装/批装状态维护重复。使用描述表和各依赖适配器，单装/批装共用一次安装任务；保留实际来源和修复方式的差异。
4. 拆分 `main/services/autoUpdater.ts:475` 的流程状态、平台安装和通知展示，再处理 `agentInstaller.ts:816` 的准备/验证/提交/回滚事务边界。源码测试不能代替各平台真实更新与安装验收。

本次仅清理门禁和无效测试，不实施上述业务重构。

## 完成与验证结果

- 已完成三个宿主的 plan hook 清理、规则/模板同步、CI 去重及无生产调用 helper 的删除。
- 定向验证覆盖 project-paths、i18nLocales、auth/lifecycle、serviceReadiness、uiStatusPoller 共 5 个文件，最终 30 个不同用例通过；i18n 恢复后单独重跑 3 例通过，其余未变结果复用。
- SDLC 凭据/部署自测 8/8；JSON 配置、两份 workflow 的 YAML 解析及 `git diff --check` 通过。无 actionlint，未运行远端 CI 或安装包验收。
- 当前无旧启动 helper 的引用，也无执行配置指向已删除的 plan hook；AGENTS 安装器托管段保留，由段外本仓规则明确覆盖。
- 本次未提交、未推送，原有 IM、样式及其他 WIP 保留。
