# 开发客户端登录 Cookie 同步修复

- 日期：2026-09-27。
- 状态：升级后的前端 pin 回归已复现并修复；71 项认证测试及 43 请求 Electron 验收通过，修复已提交并更新源码/产物引用，完整 macOS DMG/ZIP 已构建。正式安装版尚未更新。
- 用户反馈：开发客户端登录提示「客户端登录会话同步失败，请升级客户端后重试」。

## 已核实的路径

当前 source 开发页为 http://localhost:3000，业务后端为 https://testagent.xspaceagi.com；商业宿主按 Cookie 认证。11:24:35 主进程日志为 sync-session-no-cookie，尚未进入后端账号验证或设备注册。Umi 请求实现使用 Axios，common.ts 只配置 Fetch credentials，没有配置 Axios withCredentials。

当前客户端已经启动 dist 网关，但后台 URL 归一只支持网关页，未覆盖显式授权的本地开发页。即便补齐 withCredentials，本地页跨站接收 SameSite=Lax/Strict Cookie 仍会受 Chromium 限制。

## 实施范围

1. common.ts 依据既有 getBusinessRequestAuth 为 Axios 补 withCredentials，保留本地浏览器 Token 与商业客户端 Cookie 的环境边界。
2. 现有网关 URL 归一支持明确配置的开发前端 origin；只改写该页同源 frame 到当前业务后端的请求。未授权的本地端口、外部 iframe、其它域、开发静态资源与 HMR 不受影响。
3. 复用既有后台命名空间、主进程能力标记、Cookie 镜像与受信 opaque CORS 流程；不放宽外部来源权限、不改变生产页面路线。
4. 同步到当前基座仅应用本次最小变更，保留原有未提交改动；重建主进程并重启当前开发客户端。

## 验证

- 先用请求配置/URL 策略回归测试复现，再验证修复。
- 隔离 Electron profile、本地虚构业务后端与真实 HttpOnly Cookie，验证明确授权的开发页登录、Cookie 镜像和后续认证请求；不使用真实用户凭据。
- 独立 verifier 跑相关前端与商业认证测试及格式检查。
- 日志与客户端界面验证分开；正式 Windows 安装包仍需独立验收。

## 实施与证据

- Axios 首拦截器新增 withCredentials，33 项请求层测试通过；Cookie/Token 环境策略不变。
- 网关支持未打包客户端显式配置的 devFrontendOrigin；精确顶层页与 frame 同源、精确后台 origin 的 xhr 才进入已有命名空间。保留 HMR 页面及资源。
- 四个网关文件只搬本次最小 hunk 到当前基座，没有全量覆盖 overlay 或其它未提交改动。
- scripts/acceptance/loopback-login-sync.cjs 使用真实前端请求策略与 Axios 0.27.2，Electron 40.8.2 隔离 profile。先复现成功 JSON 响应却无法存跨站 Lax Cookie，再验证 POST/请求体保持、Cookie 镜像、后续认证及注册；41 次请求全部通过。
- 验收脚本 fromId(undefined) 的空值错误已修；已关闭当次测试 Electron，未使用真实客户端账户。
- 开发主进程已重建，客户端新窗口使用修复后的 localhost:3000 前端；前端首编译成功。真实后端需用户重新登录验证。
- 独立 verifier：前端 64 项、基座认证与网关 87 项，共 151 项通过、0 失败；前端格式、三个仓库任务范围 diff 检查及验收脚本语法检查均通过。

## 真实后端追加反馈

- 用户仍见成功后返回登录页及 Permission denied。主进程日志已确认 sync-session-valid、reg-committed、服务 ready，且之后没有清除会话；不能以隔离测试通过宣布业务登录完成。
- 当前页真实 getLoginInfo：绝对后台 URL 经 307 进入网关命名空间，HTTP 200 / code 4030 / Permission denied。请求含主进程 capability；宿主 auth.syncSession 仍返回 true。继续查代理上游请求与 native 请求差异，不记录 Cookie、Token 或设备 key。
- 验证码步骤由 Login push 新历史，redirect=-1 成功后 go(-1) 回到 Login。调整认证步骤历史与回退行为，并补真实历史栈回归用例。

## 追加修复与真实验收

- 密码与验证码步骤共用登录历史条目；进入/返回验证码使用 replace，成功导航共用纯函数。真实 window.history 的 -1/-2、步骤往返及路径优先级用例通过；独立前端复核 69/69。
- 同一有效会话对真实后端做只读 GET 对比：原头返回 HTTP 200 / 4030；仅去 Origin 仍 4030；仅去 Sec-Fetch-* 返回 0000；两者去掉也返回 0000。探针只输出状态码/业务码/成功布尔，无 Cookie、Token、账户响应或设备 key。
- 网关只在主进程私有 capability 校验通过时移除浏览器到 loopback 这一跳的 Sec-Fetch-*；无 capability/伪造 capability 请求仍保留元数据并剥离 ticket。临时诊断代码与启动开关全部移除，基座仅定点同步正式 hunk。
- 真实 Electron 隔离验收扩展至 43 次请求，加入 Permission denied 模拟 guard，覆盖真实 Axios 的用户信息成功及会话票据。HTTP fixture 为模拟真实 HTTPS 的 Fetch Metadata 在测试钩子显式补头，仍使用真实 applySessionAuthHeaders。
- 当前开发客户端 12:30:04 重启，实际页面为 localhost:3000/home，用户菜单、20 项项目页列表及个人首页正常加载。真实 getLoginInfo 返回 HTTP 200 / code 0000 / success true。开发者工具已关闭，客户端留在已登录首页。
- 此轮未重复发送短信或重新输入验证码；验证码成功导航使用真实 History 回归验证。Windows 安装包尚未验证；代码未提交或推送。
- 最终独立验证：前端 69 项、网关/商业认证 88 项，共 157 项通过；任务范围格式/差异检查及脚本语法通过。outer/base 网关正式修复两文件内容一致，未残留临时诊断代码。

## 升级后的回归（2026-09-27）

- 外层 b5745e43 将前端 pin 从 e792413c79 切到 d1a702871，提交说明称修复已覆盖，但实际当前分支不包含 e792413c79，且登录相关六文件的修复/测试均缺失。
- 当前 common.ts 仅保护 /login，未保护 /verify-code；withCredentials 丢失；验证码步骤恢复 push/go(-1) 旧逻辑。商业壳 gateway 的 devFrontendOrigin 与 Sec-Fetch 修复仍在。
- 只恢复上述六文件的已验收差异到当前前端分支，保留此后其它功能变更；先复现失败，再跑认证回归与隔离 Electron 验收。安装版修复仍需进入新的源码提交及发布产物，不能以开发工作区修复代替升级包验证。
- 已核对实际安装包：/Applications/Nuwax.app 为 1.0.39，内嵌前端 gitHash=d1a702871，匹配本次回归输入。恢复测试先复现 9 项失败，补回六文件后 71/71 通过；Electron 隔离验收 43 请求通过。
- 本地无签名 macOS arm64 候选：artifacts/login-fix-1.0.39/mac-arm64/Nuwax.app，CFBundleShortVersionString=1.0.39-loginfix.1。包内 umi 与登录页相关编译产物已核对包含修复并逐字匹配新构建。
- 同目录 source.patch 与 login-fix-provenance.json 保存完整登录补丁、六文件 SHA256、关键产物 SHA256。现有 /Applications 安装版未被覆盖，未发布、提交或推送；未宣称此次已完成新安装包短信登录的人工验收。

## 用户要求补齐修复并重新打包

- 前端修复提交 `8ef2336b1f3121319becc3ce9e35d50253a089ca`，只包含六个认证相关文件；保留当前分支其它功能及基座未提交工作。
- 独立 verifier 认证测试 71/71、六文件 Prettier 与差异检查通过，提交前后的已验证文件摘要一致。
- 完整 source pack 已生成 `release/login-fix-1.0.40/Nuwax-1.0.40-loginfix.1-arm64.dmg` 与同版本 macOS ZIP；内嵌前端为该干净源码提交，戳 `8ef2336b1`。
- 将同一输出提交至产物仓 `1005a6637136b1879bdd70280d06560dcd7834d5` 并更新外层双 pin，避免默认 pack 再次使用遗漏修复的旧产物。
- 本地无签名构建，未推送、发布或覆盖现有安装版；真实短信登录的安装包人工验收仍独立记录。
