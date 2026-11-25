# 实施计划：Linux deb 客户端内升级改用 pkexec

- 状态：实施中（代码已完成，UOS 真机第一段已通过；待发版后做第二段，见「偏离记录」）
- 背景：UOS 20 Pro 1050 上点「安装更新」只得到「未找到图形化密码输入工具（zenity）」，无法升级。
- 决定（用户，2026-11-25）：没有远程桌面场景，采用 electron-updater 官方的 pkexec 方式；离线安装是硬要求，不新增包依赖。

## 一、问题与结论

**现状。** 更新包由 electron-updater 下载校验；安装环节 deb 不走 electron-updater，而是仓库自己的
`linuxDebInstaller`：在系统里找 `zenity` 画密码框，`sudo -A -v` 验证，停服务，`dpkg -i`，重启。
UOS 没有 zenity（也没有 kdialog、ssh-askpass），所以在第一步就返回 `no-askpass`。

**这段代码的来历。** `nuwax-ai/nuwa-electron-shell` 的 `208401c2`（dongdada29，2026-10-14）把
electron-updater 的 pkexec 换成了 zenity，原因是两条：electron-updater 同步调用 pkexec，
等待授权期间主进程冻结；Chromium 进程不在登录会话里，polkit 把授权框弹到物理屏幕，xrdp 下看不到。

**结论。** 授权和安装改为一次 `pkexec` 调用，由我们异步执行；移除 zenity 路径。

```
pkexec /bin/sh -c '<现有安装脚本>' nuwax-update <deb 路径>
```

安装脚本沿用现有的 `dpkg -i "$1" || apt-get install -f -y`（含 `DEBIAN_FRONTEND=noninteractive`）。

**依据（2026-11-25 在 UOS 真机上实测）。**

- UOS 有 pkexec 0.105，桌面会话里运行着 `dde-polkit-agent`；没有 PackageKit。
- Chromium 会把我们的进程放进不属于登录会话的作用域。从同样的位置执行 pkexec，
  **系统授权框正常弹出**（日志出现 `Window created, title: "Deepin Polkit Agent"`）。
  仓库注释担心的「弹到物理屏」只影响远程桌面，本机桌面上就是用户自己的屏幕。
- pkexec 的退出码（官方手册）：返回安装命令的退出码；用户在授权框点取消返回 **126**；
  没拿到授权或出错返回 **127**。桌面上没有授权代理时，pkexec 在 23 毫秒内以 127 失败（Ubuntu 实测）。

## 二、目标流程

1. 用户在「关于」页点安装，状态变为「安装中」，并提示会出现系统授权窗口。
2. 主进程异步启动 pkexec，输出写入 `~/.nuwax/logs/update-install.log`（写文件、不接管道，沿用现状）。
3. 按退出码判定：

   | 退出码 | 含义 | 给用户的反馈 |
   |---|---|---|
   | 0 | 安装成功 | 继续下一步 |
   | 126 | 用户在授权框点了取消，或密码错误 | 「未获得管理员授权，更新未安装」 |
   | 127 | 无法在客户端内授权：没有 pkexec，或桌面上没有授权代理 | 手动安装命令（带安装包路径） |
   | 其它 | dpkg 执行后失败 | 「更新安装失败，详细输出见日志」 |

4. 成功后才做安装前清理（置退出标志、停服务），然后重启客户端。
5. 以 root 身份运行时直接执行安装脚本，不经过 pkexec。

授权失败或安装失败时，服务一步都没停，客户端照常运行。

## 三、设计取舍

**安装在前、停服务在后，和现在的顺序相反。** 一次 pkexec 调用无法把「授权」和「安装」拆开。
现在的做法是先 `sudo -v` 授权、再停服务、再安装，为的是用户取消时不动服务；换成 pkexec 后，
把停服务挪到安装成功之后，同样能做到取消时不动服务，而且比现在更干净。
electron-updater 自己的顺序也是先装完再退出。

**经 `/bin/sh -c` 包一层，而不是 `pkexec dpkg -i`。** 这样一次授权内就完成了
`dpkg -i` 失败后补依赖的兜底。electron-updater 自己也是 `pkexec /bin/bash -c …` 的形式。
代价是系统授权框里显示的程序是 `/bin/sh`，所以在应用内加一句提示。
pkexec 给子进程的是最小环境，`DEBIAN_FRONTEND` 由脚本自己导出。

**移除 zenity 路径。** 用户确认没有远程桌面场景，它当初要解决的问题不再存在。
保留会有两条授权路径、两套文案和测试；而「有 zenity 却没有 pkexec」的桌面几乎不存在。
没有 pkexec 时统一给手动安装命令。

**不配免密，不加自定义 polkit 动作。** electron-builder 官方文档明确反对预先授权
（同用户的任何进程都能以 root 装包）。自定义动作能改善授权框文案，但要改打包和安装后脚本，
不在这次范围。

**不变的部分。** deb 安装的 `autoInstallOnAppQuit` 仍然关闭（避免普通退出触发
electron-updater 的同步 pkexec）；`isLinuxDebInstall()` 的判定口径不变；
安装包下载与校验不变。

## 四、改动文件清单

路径前缀：`nuwa-electron-shell/crates/agent-electron-client/`

| # | 文件 | 动作 | 说明 |
|---|---|---|---|
| 1 | `src/main/services/linuxDebInstaller.ts` | 改 | 改为一次 pkexec 调用；按 126 / 127 / 其它归类结果；删除 zenity、askpass 脚本和 `beforeInstall` 回调 |
| 2 | `src/main/services/linuxDebInstaller.test.ts` | 改 | 按新流程重写：调用形态、退出码归类、root 直装、脚本内容 |
| 3 | `src/main/services/autoUpdater.ts` | 改 | `installLinuxDebUpdate`：安装成功后执行 `prepareForInstall()` 再重启；去掉 `askpassTitle`；新增「无法授权」的反馈；头注更新 |
| 4 | `src/main/services/autoUpdater.test.ts` | 改 | 「Linux deb 安装形态」用例：清理发生在安装成功之后、重启之前；失败时不清理不重启；三种失败的反馈 |
| 5 | `src/shared/locales/{en-US,zh-CN,zh-HK,zh-TW}.json` | 改 | 删除 `linuxAuthTitle`；`linuxManualInstall` 去掉 zenity 的说法；新增安装中提示 `linuxAuthPrompt` |
| 6 | `src/shared/types/updateTypes.ts`、`src/shared/types/electron.d.ts` | 改 | `UpdateState` 增加可选的 `hint`，承载安装中提示 |
| 7 | `src/renderer/components/pages/AboutPage.tsx` | 改 | 「安装中」状态有提示时显示提示，否则维持现状 |

第 5–7 项是同一件事：因为授权框里写的是 `/bin/sh`，应用自己提示一句
「如出现系统授权窗口，请输入管理员密码」。不需要可以整组去掉，不影响其余部分。

## 五、实施顺序

1. 安装器（第 1、2 项）及其单测。
2. 接线（第 3、4 项）及其单测。
3. 文案与安装中提示（第 5–7 项）。
4. 本地验证。
5. UOS 真机验证，分两段，见下一节。
6. 合入并随下一个 beta 发布。

## 六、证明成立的测试

**单测与本地检查**

- `linuxDebInstaller.test.ts`：
  - 调用形态是 `pkexec /bin/sh -c <脚本> nuwax-update <路径>`，标准输出和错误输出写日志文件；
  - 退出码 126 → 授权未通过；127 → 无法授权；dpkg 非零 → 安装失败；0 → 成功；
  - 没有 pkexec 时不启动任何进程，直接返回无法授权；
  - pkexec 进程本身启动失败按无法授权处理；
  - root 直装；安装脚本内容。
- `autoUpdater.test.ts`：清理在安装成功之后、重启之前；取消、无法授权、安装失败三种情况都不清理、不重启；
  不调用 `quitAndInstall`；反馈文案的映射。
- `i18nLocales.test.ts`（已有）：四个语言文件键一致。
- 命令：`npx vitest run src/main/services/linuxDebInstaller.test.ts src/main/services/autoUpdater.test.ts src/shared/i18nLocales.test.ts`、
  `npm run typecheck`、`npx eslint` 改动文件。
- 不新增与授权无关的用例；现有 `autoUpdater.test.ts` 的其余用例不受影响。

**UOS 真机第一段（发版之前，不需要发布版本）**

开发副本走不到安装这一步（未打包的构建会被 `installUpdate` 拒绝），所以用 Electron 自带的 Node
直接运行编译后的安装器模块，对已发布的 beta.6 deb 执行一次真实的重装。需要你在系统授权框里操作：

- 输入密码：预期安装成功、日志完整、退出码 0；
- 点取消：预期返回 126、归为「授权未通过」；
- 同时看一眼授权框里实际显示的文案。

应用层的接线（状态、清理顺序、重启）由单测覆盖。

**UOS 真机第二段（beta.7 发布之后，端到端）**

装上 beta.7 后，用仓库已有的测试开关 `NUWAX_UPDATE_SERVER` 把已安装的客户端指向一个临时更新源
（伪造一个更高的版本号，安装包就用 beta.7 自己的 deb），在界面里走完
「检查更新 → 下载 → 安装 → 系统授权 → 重启」。这样不必等 beta.8 才知道升级链路是否真的通。

不走 QA 构建：QA 的 Linux 包还没有接入 glibc 2.28 镜像，装到 UOS 上数据库不可用，会干扰判断。

## 七、风险与回退

| 风险 | 缓解 | 回退方式 |
|---|---|---|
| beta.6 及之前的版本仍是 zenity 逻辑，拿不到这个修复 | 属于一次性的引导问题：手动安装一次新版本 | 无需回退 |
| 授权框出现在别的屏幕（远程桌面） | 用户确认没有此场景；127 时给手动命令 | 恢复 zenity 路径（本次不改写该提交的历史，回退即还原） |
| 极简桌面没有授权代理 | 23 毫秒内返回 127，给手动命令 | 同上 |
| dpkg 失败且离线补不了依赖 | 包停在「已解开、未配置」，与现状一致；日志有完整输出 | 手动安装 |
| 安装期间客户端还在运行，文件被替换 | 与 electron-updater 的官方顺序相同；窗口只有安装到退出之间的几秒；Linux 上运行中的进程保留旧文件 | 回退本次改动 |
| 授权框里写的是 `/bin/sh`，用户可能疑惑 | 应用内提示；取消后无任何副作用 | 换成直接 `pkexec dpkg -i` |
| 安装中界面没有取消入口 | 系统授权框本身可以取消 | 后续可加超时或取消按钮，不在本次范围 |

## 八、不在本次范围

- rpm 安装：仍走 electron-updater 的同步 pkexec，等待授权时界面会冻结。可以用同一个安装器扩展，另行处理。
- 自定义 polkit 动作（应用自己的文案和图标）。
- 客户端自绘密码框。
- 安装中状态的超时和取消按钮。
- 内网软件源、统信应用商店等部署方式。

## 偏离记录

实施中偏离原计划的逐条补记（原因 + 同步的 commit）。

### 本地验证（2026-11-25）

安装器、接线、文案与安装中提示按清单完成，没有偏离。`linuxDebInstaller.test.ts` 比计划多一条：
以 root 直装时，脚本自己的 126 / 127 不会被当成授权问题（这两个退出码只在经过 pkexec 时才有含义）。
客户端全量单测 324 个文件、4009 项通过；类型检查通过；`autoUpdater.ts` 里两条 `require()` 的 lint 报错是改动前就有的。

### UOS 真机第一段（2026-11-25）

按计划用 Electron 自带的 Node 运行编译后的安装器，对已发布的 beta.6 deb 重装。启动方式是从 ssh 里
`systemd-run --user` 起一个用户单元，让进程和客户端一样不在登录会话里。

| 操作 | 结果 |
|---|---|
| 在授权框输入密码 | 系统授权框弹出并完成授权；dpkg 完整重装（解压、设置、`Nuwax post-install: SUID sandbox enabled`、触发器处理完毕）；安装器返回 `{ok:true}` |
| 在授权框点取消 | 返回 `{ok:false,"reason":"auth-failed"}`，13.5 秒；日志是 pkexec 的 `Request dismissed`；包状态不变 |

安装日志里有一行只有 deb 路径的输出，来自 UOS 自己的 dpkg 钩子
（`/etc/dpkg/dpkg.cfg.d/deepin-selinux-security-hook`），不是安装器的问题。

**验证过程中的一次事故（我的操作失误）。** 第二次输入密码后 dpkg 还在重装，我为了重新触发而
`systemctl --user stop` 了那个单元 —— 单元的 cgroup 被整个结束，dpkg 在安装中途被杀，
包变成 `install reinstreq half-installed`。随即用 `sudo dpkg -i` 重装修复，状态恢复为 `install ok installed`。
正式流程里没有这个动作：客户端不会在安装中途结束 pkexec。
教训：停一个可能正在安装的单元之前，必须先确认授权还没有通过（日志文件还是空的）；已经通过的只能等它结束。

### 版本号顺延（2026-11-25 晚）

计划写的是「随下一个 beta 发布」。实施期间同事 dongdada29 推送了 tag `v3.3.0-beta.7`
（`e396eb2b`，含输入法修复，不含本次升级改造）并开始发布。已占用的 tag 保留编号，所以本次改造
从 **3.3.0-beta.8** 起发布；验证升级的两个版本相应变为 beta.8（手动安装）→ beta.9（升级目标）。
两个本地提交变基到 `e396eb2b` 之上，没有冲突。

### beta.8 首次发布在自己的测试上失败（2026-11-25 晚）

发布 run 的 commercial gate 失败在 `waylandRegistry.test.ts`（输入法回退用的 Wayland 查询）的
一条断言：`expected [] to deeply equal [...]`。是测试的竞态，不是产品代码的问题 ——
「假合成器收到了请求」这条记录经线程消息传回，与查询结果不是一条通道，负载高时到得更晚，
断言跑在了它前面。同一份代码在门禁 CI 和本地都通过过。

把消息人为延迟 80 毫秒做了对照：新写法（`vi.waitFor`）通过，旧断言稳定复现同一个错误。
修复是 `4f6873c7`。按规则，没有代码变更的失败可以在同一 tag / SHA 上重跑，所以 beta.8 原样重跑，
测试修复随 beta.9 发布。
