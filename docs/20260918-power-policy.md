# 允许锁屏运行（电源保活）实施与双平台验证记录

> 2026-09-18 · 对标 WorkBuddy「权限 → 允许锁屏运行」三档下拉 · 全 overlay 落地（基座/前端零改动）

## 一、功能与实现

设置页「系统」组、休眠控制行后新增「允许锁屏运行」下拉（关闭 / 熄屏后保持唤醒 / 保持屏幕常亮），
非关闭档持有 Electron `powerSaveBlocker` 断言，保障 Computer Use 远程控制与后台 Agent 任务在人离开后持续执行。

| 档位 | Electron 断言 | macOS 底层 | Windows 底层 |
|---|---|---|---|
| 熄屏后保持唤醒 `keepAwake` | `prevent-app-suspension` | IOKit NoIdleSleep（≈`caffeinate -i`） | `SetThreadExecutionState(ES_SYSTEM_REQUIRED)` |
| 保持屏幕常亮 `keepDisplayOn` | `prevent-display-sleep` | IOKit NoDisplaySleep（≈`caffeinate -d`） | `SetThreadExecutionState(ES_DISPLAY_REQUIRED)` |

- 设置键 `nuwax.powerPolicy` = `{ mode }`（settings 表 JSON 编码）；缺省/形态异常一律回退 `off`（保活是耗电行为，安全侧）。
- 触发策略：**常驻持有**（档位非关即全程持有，WorkBuddy 同款）；服务内单 blocker id，v2 任务门控（cua 会话/下载活跃才持有）替换为引用计数即可，档位语义不变。
- 断言生命周期 = 进程生命周期，退出由 OS 自动回收，无 quit 清理。
- 文件：`overlay/.../src/main/services/powerPolicy.ts`（服务）+ `powerPolicy.test.ts`（15 用例）；
  IPC `powerPolicy:get/setMode` 注册于 overlay `nuwaxBridgeHandlers.ts`（cua 段后，`initPowerPolicy()` 同处作 boot 恢复钩子，同 `ensureCuaOnBoot` 先例）；preload 新增 `powerPolicy` 命名空间；`electron.d.ts` 补 `PowerPolicyMode/PowerPolicyAPI`。

## 二、门禁

- 商业轨 vitest：**1437 passed**（含新增 15 例）。
- tsc --noEmit：powerPolicy 相关 **0 错误**（分支存量 208 错误均在未触碰文件，含 IMSettings/sandbox 等，非本批引入）。
- check:boundaries 通过；基座仓零提交（locales 是 overlay 托管路径，check:pin 口径无涉）。

## 三、macOS 真机验证（本机 dev 实例，Electron 40.8.2）

观测手段：`pmset -g assertions`（按进程 pid 对拍，注意系统里 ChatGPT/ZCode 也持有名为 "Electron" 的断言，**必须按 pid 区分**）。

| 档位 | boot 日志 | pmset 断言（dev 实例 pid） |
|---|---|---|
| off（键缺失/默认） | 无（applyMode 同档早退，不打日志） | 无 ✓ |
| keepAwake | `[PowerPolicy] applied mode=keepAwake (blocker=0)` | `NoIdleSleepAssertion named: "Electron"` ✓ |
| keepDisplayOn | `applied mode=keepDisplayOn (blocker=0)` | `NoDisplaySleepAssertion named: "Electron"` ✓ |
| `{mode:"garbage-xx"}` | 无（安全侧静默回退 off） | 无 ✓ |
| 退出进程 | — | 断言随即消失 ✓ |

验证方法：杀实例 → `sqlite3 ~/.nuwax/nuwax.db` 种档 → 重启 dev（`NUWAX_APP_IDENTIFIER=nuwax nohup npm run base:dev`）→ 按 pid 查 pmset。运行中改档走 IPC 即时生效（unit 覆盖 setPowerPolicyMode 三档切换/幂等/非法拒绝；boot 链实证 `registerNuwaxBridgeHandlers` 注册无冲突）。

**未做**（有意，记录偏差理由）：强制熄屏/等自然睡眠的 5 分钟观察窗——断言本身即 macOS 的睡眠抑制机制，`pmset -g assertions` 是系统权威视图，OS 语义冗余验证价值低且熄屏会干扰本机使用。

## 四、Windows 验证（win-pc 192.168.32.53，Electron 40.8.2 探针）

win-pc 上已无 nuwax-client 检出（原 `C:\soddy-git-workspace` 已清空，SSH 默认 shell 从 cmd 变成了 **Git Bash/MINGW64**——`dir /b` 这类 cmd 语法与 `/flag` 参数都会被 MSYS 路径转换吃掉，跨平台调用 native exe 前缀 `MSYS_NO_PATHCONV=1`）。故采用**最小探针**验证平台差异面：powerPolicy 服务零平台分支，win 专属未知面只剩「Electron 断言在 Windows 上的 `powercfg /requests` 可见性」。

探针：`~/pp-probe/`（留存可复用）——npmmirror 下载的 electron 40.8.2 win-x64 + `keepAwake/keepDisplayOn/off` 三个子目录（各含 package.json + main.js：起断言 → 5s 后自跑 `powercfg /requests` 落盘 → 自退）。经 `schtasks /create /tn <名> /tr "<electron.exe> <子目录>" /sc once /st 23:59 /it /rl highest` 派交互会话运行（`/rl highest` 使 powercfg 有权输出；SSH 会话本身已 elevated）。

| 档位 | DISPLAY 段 | SYSTEM 段 | EXECUTION（执行）段 |
|---|---|---|---|
| keepAwake | 无 | 无 | **electron.exe** ✓（ES_SYSTEM_REQUIRED 足迹） |
| keepDisplayOn | **electron.exe** ✓（ES_DISPLAY_REQUIRED） | 无 | 无 |
| off | 无 | 无 | 无 ✓ |

三档足迹互斥且与档位精确对应，Windows 侧覆盖完成。探针任务已删，无残留进程；`~/pp-probe/` 保留（约 300MB，可整目录删除）。

**未做**：win 全应用级 e2e（需重建 qa 检出：fresh clone + pnpm 双装 + node-gyp Python 3.11 配方，见 win-pc-qa 记忆）——服务代码无平台分支 + 探针已覆盖平台面，评估无必要，待下个 prerelease 包真机抽查顺手覆盖。

## 五、边界与文案诚实性（写给后续接手的人）

powerSaveBlocker 只管「睡眠/熄屏」，**管不了「锁屏」**：
- 手动锁屏不产生睡眠，断言既不阻止也不解除。macOS 锁屏会话阻塞一切 AX 注入（hostActivity 实测）；Windows 锁屏/RDP 断连后截图拿缓存旧帧（win-pc 实测）——锁屏下远程控制均受限。
- 「保持屏幕常亮」的真实作用链 = 防熄屏 → 防超时自动锁屏 → 会话保持可用（desc 文案不承诺锁屏后仍可远程控制）。
- macOS 合盖 clamshell 维持唤醒需外接电源+外显；电池续航影响随档位自担（v2 可做电池自动降档）。
- 与「休眠控制」（dormancy）正交互补：一个管「不可见时少轮询」，一个管「有任务别睡着」；常亮档防止自动锁屏 → hostVisible 保持 true → 轮询不停，两者天然自洽。

## 六、遗留

- [ ] 设置弹窗 UI 目检（dev 实例已在本仓常驻、默认关闭档：设置弹窗 → 系统 → 允许锁屏运行）。
- [ ] 下个 prerelease 打包版顺手抽查（含 win 安装包）。
- [ ] v2 backlog：任务门控引用计数 / 锁屏中远程控制受限提醒 / 电池自动降档 / 社区版设置行。
