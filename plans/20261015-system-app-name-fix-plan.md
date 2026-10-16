# 三平台系统应用名称修复

用户反馈：macOS 图标和菜单栏仍为 Nuwax；要求同时检查 Windows、Linux，并现在修改代码。当前 3.0.16 继续同步已验收产物，本次不改变其 tag 或安装包。

根因：macOS 将中文值直接写入基础 CFBundleDisplayName，与 Nuwax.app 文件系统名不匹配，且缺少 InfoPlist.strings；主进程 app.setName 仍写死 Nuwax。Linux 使用了锁定 electron-builder 25.1.8 不读取的 desktop.entry.Name。Windows NSIS 快捷方式已覆盖，MSI 尚需一并覆盖。

实施：
1. 将系统名称配置收在一个共享模块，供本地 pack、stable/beta CI 使用。macOS 保留 Nuwax.app 和基础 plist 技术名称以兼容既有更新路径，使用 InfoPlist.strings 提供系统实际显示名称，主进程原生名称使用女娲Nuwax。Windows NSIS/MSI 快捷方式与 Linux desktop Name 统一。
2. 保留 macOS 公证、捕获资源、更新配置及 ZIP/DMG 检查入口，签名前复制名称本地化资源；通过 Foundation 的实际系统名称解析验证 Finder 显示值，而不是仅检查原始 CFBundleDisplayName。
3. 使用锁定 builder 实现验证最终名称字段、Linux desktop 文本及 Windows 快捷方式配置；使用 macOS Foundation 验证系统名称解析，验证运行期身份配置并编译商业主进程。运行相关脚本和商业质量门，完成三问自查后提交代码。

兼容性：保留 appId、nuwax 包标识、Windows 可执行/卸载程序标识、Linux StartupWMClass、既有数据目录与分发 URL 命名。当前版本的 S3/OSS 同步独立继续。

依据：[Apple CFBundleDisplayName 规则](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/CoreFoundationKeys.html#//apple_ref/doc/uid/TP40009249-SW9)。Finder 先比较基础显示名与文件系统名，再从 InfoPlist.strings 取本地化名称。已经用 NSFileManager.displayNameAtPath 和 NSBundle.objectForInfoDictionaryKey 实测解析结果为女娲Nuwax。

## 提交前检查（2026-10-16）

三问自查：
- 功能内聚：`scripts/client/system-app-name.mjs` 集中配置三平台名称，本地 pack 和 stable/beta 工作流共用；`InfoPlist.strings` 只承担 macOS 系统名称本地化。
- 分层：`bootstrap/appIdentity.ts` 管理 Electron 运行期身份；发布脚本负责 builder 配置及原生名称验收，保留现有签名、公证和更新配置门禁。
- 可维护性：测试调用锁定 builder 的真实 Linux desktop 生成器及 Windows NSIS/MSI 配置解析器；macOS 原生回归先复现旧包显示 Nuwax，再验证本地化后的实际名称。保持既有更新路径、缓存和用户数据身份。

验证结果：
- 全部脚本测试 351 项通过，无跳过。
- 社区测试 1640 项通过、18 项跳过；商业测试 3043 项通过、18 项跳过。两轨均在本次隔离工作区运行。
- 商业主进程生产构建通过，包含 arm64/x64 通知原生模块。
- overlay 同步检查、`npm run check:pin` 和 `git diff --check` 通过；子模块 pin 无改动，本次不提交测试环境依赖链接。

生效范围：本次是后续打包使用的代码修复。已经公开的 v3.0.16 仍使用冻结源码，不能将本次原生名称验证结果解释为该安装包已包含修复。

## 中文 Finder 名称回归修复（2026-10-16）

用户安装后反馈 Finder 仍显示 Nuwax。本机实际复现：系统语言 `zh-Hans-CN / en-CN / zh-Hant-HK` 优先选择 Electron 创建的空 `zh_CN.lproj`，繁体系统优先选择空 `zh_TW.lproj`。NSBundle 的单个名称字段会回退到 zh-Hans/zh-Hant 而返回女娲Nuwax，NSFileManager 的 Finder 文件名称却仍为 Nuwax；原先英文 CI 和没有空目录的 fixture 遗漏了这一组合。

修复：名称生成器为 `zh_CN`、`zh_TW` 及所有已声明 electronLanguages 输出同一名称文件；发布校验分别启动默认语言、英文、简体、台湾繁体和香港繁体的原生名称查询，避免英文 runner 掩盖中文缺失。不修改已安装签名应用；通过下一版 beta 安装包交付。

验证：先新增测试复现两项失败，再修代码；系统名称、pack、QA、更新配置和终端兼容相关 43 项测试通过，无跳过。旧安装包被新校验正确拒绝；包含空 Electron 语言目录的修复后 fixture 在中英文下均返回女娲Nuwax。三问复查：locale 生成集中在原属主、验证保持只读、实际 Finder 解析与全部声明语言目录均有回归覆盖。
