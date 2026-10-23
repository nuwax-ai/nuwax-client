# 实施计划：截图启动与入口偏好

对应规格：specs/capture-entry-preferences.md

1. 共享偏好定义、按键解析；设置 UI 和持久化校验，默认隐藏关闭。
2. 截图 A / 录屏 R 两组快捷键、应用菜单可见性及动态提示联动，保留现有平台作用域。
3. 解耦静态截图与视频编码器准备，合并多屏采集请求。
4. 宿主原生浮层初始模式、切换及复用选区；业务 API 保持独立模式。
5. IM 输入焦点认领、原生桥回填、会话失效时复制回退；保持浏览器入口兼容。
6. 同步 overlay，执行截图域/设置/菜单回归、main/renderer 构建、边界和 pin 检查。base:test 仅在隔离副本执行，不清理当前商业工作树。

## 文件范围

overlay 下 capture 主进程、共享契约、原生窗口运行时、设置控件、应用菜单/顶栏、App 组合及四语言 locale；只扩展覆盖本次行为风险的现有测试。

## 风险和回退

快捷键冲突用受限输入与主进程校验；视频初始化保持资源验证；宿主模式切换不扩大业务桥。按本批 overlay diff 回退。当前工作树已有商业覆写，保留所有原有改动。

状态：实现与本地源码验证完成；实机及发包未执行，见 docs/acceptance/20261023-capture-entry-preferences.md。

追加文件范围：nuwax 的宿主桥契约；nuwax/submodules/nuwax-im 的 nativeCapture、ChatWindow、RichEditor、相关行为测试及测试注册。按用户后续授权提交并直接合并：IM 合入 origin/main，PC Web 合入 origin/feat-2026.9.30；更新 IM pin、重制适配补丁，再更新客户端前端 gitlink。

IM 构建链核对：因父仓按 pin 的 archive 构建，不读取子模块 WIP，原生桥和回填实现已进入 IM main，适配补丁只保留 qiankun 差异；新 pin 的隔离副本完成应用校验、qiankun overlay 构建及相关回归。用户追加图标反馈后改为相机/摄像机/GIF 胶片和短标签，并通过实际浮层回归。
