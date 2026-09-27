# 客户端截图问题验证（2026-09-27）

用户报告是四个独立问题，逐项验收；状态回放是第 4 项的内部边界，安装包验收属于交付验证。

| 用户问题 | 当前状态 |
| --- | --- |
| 1. 菜单语言不切换 | 前端→宿主设置真实同步通过；验收发现 macOS 原生菜单遗漏并补修，隔离真实 Electron 菜单切换通过，尚未 Windows 新包验收 |
| 2. 全栈开发会话滚动白区 | 源码修复、Chromium 对照及已登录真实 macOS 开发客户端滚动通过，尚未 Windows 安装包验收 |
| 3. 点击会话后置前、时间变“刚刚” | 当前测试账号的浏览器和真实客户端均未复现；仍需复发账号/会话运行证据，尚未修复 |
| 4. 蓝点读后又出现 | 四文件 80 用例通过；真实客户端完成出现蓝点、打开清除、切走观察未复现，尚未 Windows 安装包验收 |

## 顶部菜单语言

- 根因：当前基座工作树 TrafficLightToolbar 仍硬编码中文；overlay 的 7febca80 已抽取菜单、子项及提示词典。
- 同步范围：Toolbar、shared/constants、四份 locales、renderer core/i18n 与既有语言回归。App/SettingsPage/main 与 overlay 已一致，桥的语言段也一致；其他同步差异保留。
- 新增真实组件渲染回归：简中→英文→台湾繁中→香港繁中→简中，检查五个标题、19 个菜单项和窗口/导航提示。
- 独立验证：Electron 五文件 15 用例通过。壳 renderer 的 Vite production build 通过。
- 真实 macOS 客户端（源码 HMR、ld 账号）：个人中心简中→英文保存后，业务页面英文，宿主设置的 Settings/Client/Server Domain 同步英文。
- 该次真实验收同时发现 macOS 原生菜单仍中文。补修：抽出纯 applicationMenu 模板，新增四语言 33 个 NativeMenu key；main 在 ready 内单次订阅共享 setMainLang 的变化，字典加载后重建菜单。两条 IPC 入口共享这一更新链，不改 guest 页生命周期、编辑/前后退动作、roles 或快捷键。
- 补修独立回归五文件 51 用例通过；相关 overlay/base 十文件字节一致；两个入口 esbuild 成功。主进程 tsc 仅报未修改的 autoUpdater.ts:224 的 display possibly null，新增源码无新增诊断，不能宣称全库类型检查通过。
- 根代理另按仓库 build-main-esbuild.js 的原配置构建完整 main + 两个 preload 入口，仅将 outdir 改到 /tmp/nuwax-client-main-validation，dev bundle 通过；未覆盖现有开发进程使用的 dist。
- 隔离真实 Electron 40.8.2 验收窗口读取当前源码模板、main i18n 和真实 locale 文件；原生菜单中文→英文→中文，File 子菜单为 New Task/Search/Change Workspace Directory/Open Workspace Directory，均通过。重复英文构建次数保持 2，切回中文后为 3。结果在 /tmp/nuwax-native-menu-acceptance/harness/results.json；该窗口使用独立 userData 并已退出。
- 现有开发客户端未重启，因此完整产品主进程的新订阅接线尚未在重启后的完整客户端验收；隔离窗口证据仅覆盖共享菜单/语言模块与真实 Menu API。
- 未做 Windows 安装包验收或发布；运行旧安装包不会自动获得本地源码修复。

## 全栈会话滚动白区

- 原因：保活路由返回 null，但客户端 immersiveShellAvoid 仍留下高度 100% 的空盒。真实缓存页是同级 h-full，于是出现两屏的外层滚动。PC 网页不建该包装盒。
- 修复：仅隐藏 inner 为空的沉浸包装盒；组件继续挂载，非空内容自动恢复包装高度。
- 实测：ego-browser space 28，在 testagent 的真实 app-pro/195/1694723 保活 DOM 前重建与源码一致的空包装层，加载编译后的真实 Less。视口 828px，修复前 root.scrollHeight=1656、缓存页相对 top=828；修复后 scrollHeight=828、top=0。
- 空→非空→空切换：display=none→block→none。聊天内层滚动后外层仍 828px，原 iframe 节点身份不变。
- 本次用户要求继续验证：原生 CUA 复用已登录 Electron 开发窗口（localhost:61173 壳 + localhost:3000 前端源码），进入 /space/752/app-pro/195/1694723；聊天上/下各三屏、预览下/上各两屏及顶部区域滚动后，工作台标题/环境栏仍位于顶部，没有截图中的整屏空白。
- 验证属于 Chromium DOM 布局对照，未使用 Windows 原生安装包；未发布前端产物。
- 独立回归：SidebarShell、ClientConversationKeepAlive、hostBridge/index 三文件 56 用例通过。原拟指定 shellAvoidancePolicy.test.ts 不存在，因此不计入覆盖。

## 点击会话后置前/时间变“刚刚”

- 当前前端点击链只清未读并路由；侧栏采用列表回包顺序和 modified，置顶排序除外。目录事件补丁不写 modified、不挪行。
- 在线任务 1694831：查询详情前列表 index=3、modified=2026-09-26T02:32:02.000+00:00；详情 POST 后以及真实 UI 点击后均不变，侧栏仍显示“1天”。未复现，不判定为后端详情接口副作用。
- 已请求用户提供复发域名与会话链接；该项尚未修复，未冻结时间或排序以掩盖问题。
- 发布版本核对：prerelease-v1.0.37 的前端 pin 为 023d3eda1f（当前前端子模块 HEAD）；父仓当前 pin 与 nuwax-dist 元数据为 9de6e210cb，不能据此关闭 v1.0.37 的报告。
- 客户端 detail/message/list 正常业务请求仍走同一 BASE_URL，未发现读接口被本地改成更新。但客户端额外注入 x-client-type:nuwax 并使用 ticket；ld 账号的普通浏览器对照不等价于截图中的赵宁账号，仍需该账号/会话运行证据。
- 本次原生 CUA 真实客户端对照：询问AI年龄 /home/chat/1694746/1596 和 AI身份询问 /home/chat/1694745/1596 连续点击，原顺序保持、时间仍 2d（移开指针后检查，悬停行操作会临时隐藏时间）。相邻 Bug2528/2265 仍 1d，没有跳到前面或变成 Just now。仍只属于 ld 账号，不能关闭赵宁账号的复发报告。

## 蓝点读后复现

- 蓝点是执行结束后的未读结果标记；悬停时临时让位给行操作按钮属于既有样式，未读状态本身不变。
- 缺陷：缓存页旧终态轮询反复发任务状态补丁，事件接线将其重新当作结束。点击清点后切走，旧终态再次记点。
- 修复范围：未读 store 与事件接线统一去重；任务和项目列表观察到新的 EXECUTING 后允许下一轮完成记点。终态补丁仍更新列表，结束时在场也记录该轮已经处理。
- 回归要求：终态→读→切另一会话→重复终态无点；新执行→终态重新记点；重复通知/列表跃迁共用去重；不同会话独立。
- 最终独立验证四文件 80 用例通过（7.37 秒）：store 13、任务列表 22、项目面板 35、directorySyncEvents 10。无失败；三个已有 hook 用例产生 9 条 React act 警告，另有 Vite CJS 弃用警告。未把旧测试数量重复累计。
- 当前信号没有 runId：无法区分乱序旧执行态与新执行，完全未观察到执行态的新一轮也无法识别；本次没有改动后端合同。
- 补强任务与项目的 60 秒回放：请求开始前的最新状态被原始服务端回包确认后，仅消除对应状态字段，保留主题/图标/标记；不同的在途新状态不能被旧回包消费。
- 跨确认保留状态观察记录：同值旧终态 C1→在途 C2→确认→已读→C3 不重新插入状态、不续期；纯状态重复直接忽略，不追加空记录、不触发重拉/版本递增。实际接受新 EXECUTING 后允许下一轮完成重新记点。
- 未经服务端确认的终态仍保护落库滞后的旧执行回包；已接受的 EXECUTING 仍只能作为新一轮的判据，不能宣称识别全部乱序执行代次。
- 真实测试会话 /home/chat/1694933/1596，标题 Blue dot acceptance test：首次短回复在当前会话完成，不记蓝点；第二轮约500字文字请求后立即切到 AI身份询问，侧栏先观察到 Executing，随后出现 New result not viewed 及可见蓝点。打开后标记清除，切回 AI身份询问后未再出现。除隔离菜单窗口运行期间外，额外保持真实客户端可见超过 60 秒再检查，行仅为 Pin/Blue dot acceptance test，未出现 New result not viewed；截图无蓝点。没有通过伪造事件制造真实验收结论。

## 本次运行环境和交付边界

- 复用现有源码开发进程，不停止既有 Electron/Umi/Vite，也未重启、清除登录态或接管其它服务。语言验收结束恢复简体中文，测试会话保留用于复查。
- Windows App 显示 192.168.32.53 会话已断开，连接菜单入口不可用；win-pc 与 win-mechrevo 的 BatchMode SSH 均被远端关闭。没有 Windows 包/真机验证结论。
- 没有提交、推送或发布；已安装旧版本不会获得这些未发布源码修复。
