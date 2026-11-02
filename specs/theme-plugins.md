# 第三方主题规格

- 对应意图：plans/20261030-theme-plugins-intent.md
- 状态：方案已接受，实施中

## 包与运行契约

主题目录含 theme.json、tokens/*.json、styles/*.css、assets/*、可选预览。schemaVersion=1；manifest 声明 id/name/version/author 和 light/dark 变体，变体指向 tokens 文件及按 common/web/shell/message/repo 分区的 CSS 文件列表。至少有一个变体，双变体可跟随系统，单变体只能使用可用模式。包是配置与静态文件，不执行代码。

核心维护稳定语义 Token（颜色、字体、圆角、间距、聊天、代码、终端），缺省值继承官方对应明暗值；映射现有 xagi、v2、壳和微应用变量。扩展样式只在公开主题作用域内生效，提供 data-theme-part，使用 CSS AST 校验/作用域改写/包内 URL 重写；拒绝远程资源、@import、执行内容、包外路径/符号链接和超限解压。

桌面主进程管理安装、选择与目录监听；Web IndexedDB 管理安装及选择。发布带递增 revision 的完整有效快照，页面不得用旧快照覆盖新状态。文件变化合并后完整校验，错误保留最近有效主题；启动缓存可离线恢复。同 ID 替换需显式操作，官方主题不可覆盖；关联目录移除只取消关联。新 themes 桥按能力探测并在主进程检查调用来源，旧 theme.syncTheme 仅用于兼容。

## 用户流程与迁移

设置页：主题列表、导入、导出、选择、明暗/系统、移除、恢复默认；桌面增加关联本地目录、打开目录。默认浅色。内置包支持导出模板，另有 DeepSeek 风格示例和 AI 提示词。历史主色/背景一次性迁移；新主题选择优先，登录/租户回声不能覆盖。保留导航结构与语言偏好。

## 微应用边界

仅通过 nuwax/micro-frontends/message 和 repo-web 的 overlay/host.css 接入快照、ConfigProvider 与作用域覆盖；不得编辑两个上游子模块。主题切换更新 Provider 和样式，不卸载业务根。

## 验证

核心解析/样式隔离/恶意包边界；Web 安装事务/失败不丢当前主题；桌面关联目录/热更新/错误恢复/来源权限；微应用构建合同；启动、登录退出、持续消息流、编辑和多窗口。源码检查不能替代真实安装包验收。
