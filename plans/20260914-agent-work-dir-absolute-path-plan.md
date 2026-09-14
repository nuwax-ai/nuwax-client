# agent_work_dir 绝对路径双轨制（web 端工作空间选择打通）· 实施记录

日期：2026-09-14 ｜ 分支：基座 feat/agent-work-dir-absolute（PR #13）→ 外层 release/v1.0.x bump pin ｜ 关联需求：nuwax web 目录选择弹窗（file-server fs/roots + fs/children）回传绝对路径

## 决策记录（产品拍板）

| 决策点 | 结论 |
|---|---|
| 安全边界 | **默认全放**，仅存在性+可写校验；边界=lanproxy 登录隧道。后续收紧白名单收口在 `agentWorkDir.ts` 单点 |
| userId 隔离 | 接受绝对路径绕过 `{userId}` 段（商业每设备单账号；社区标识符轨道隔离不变） |
| 范围 | 仅打通 agent 工作目录；文件树跟随（ConversationInfo.workspacePath 消费）留待后端契约 ready 后前端仓排期 |
| 沙箱 | 本方案无原沙箱方案——社区沙箱代码不触碰、不补断言（商业形态不执行） |

## 根因与方案

- 前端 `WorkspaceDirPickerModal` 三入口确认回调 = **绝对路径**（workspacePath 原样进 conversation/create 等），客户端正则 `^[a-zA-Z0-9_-]+$` 必拒。
- 双轨制：标识符轨道（原正则+workspace 拼接）零改动；绝对路径轨道 fail-fast 校验（存在/是目录/可写）+ `realpathSync` 归一化**回写 body.agent_work_dir**——下游 17 个 key 消费点（引擎复用、projectSessionRegistry、派发串行化、SSE 清理、firstTokenTrace）拿唯一形态字符串，key 函数免改。

## 基座改动（PR #13，10 文件）

1. 新增 `services/computer/agentWorkDir.ts`：双轨校验单点（错误码 INVALID / NOT_FOUND / NOT_A_DIRECTORY / NOT_WRITABLE）
2. `router.ts`：project_id 兜底**前移到校验之前**（修存量缺口：兜底值绕过正则直入 path.join）；ensureProjectWorkspace 绝对路径轨道跳过
3. `ipc/computerHandlers.ts`：computer:chat 补同口径兜底+校验（修 IPC 零校验缺口）；agentStatus/Stop/Cancel 引擎 key 统一（agent_work_dir 优先，复用 chatEngineKey 口径）
4. `acpSessionSetup.ts`：绝对路径直通 projectDir、title 用 basename（projectId 索引保持全路径）
5. `requestConfigResolver.ts`：codex workspaceDir 直通、不 mkdir
6. `isolatedHomePaths.ts`：绝对路径 workDirId → `wd-{sha256[:16]}` 作用域段（防超长目录段与 /a/b vs /a_b sanitize 碰撞）
7. `computerTypes.ts` 注释更新；测试 +16 用例（含 win 盘符 skipIf）

## 验证

- 基座定向+全量：社区轨 1281 过/18 skip、商业轨 1337 过/18 skip（基线各 +16）、check:boundaries / check:appdir 过
- win-pc 复跑商业轨：见当日晚间记录（除已定界沙箱存量债外全绿）
- curl 冒烟（商业偏移端口 61001）：绝对路径成功（会话 cwd=所选目录）/ 不存在→400 NOT_FOUND / 文件→400 NOT_A_DIRECTORY / 只读→400 NOT_WRITABLE

## 对外契约提醒

- **后端（Java）须同一项目稳定下发同一路径字符串**：入口 normalize 只能解决尾斜杠/./ 等形态，调用方乱传会导致 key 漂移 → 引擎重复冷启动、会话匹配失效
- agent_work_dir 透传链（workspacePath → agent_work_dir）后端 2026-09-10 确认未 ready，端到端联调以后端就绪为准
