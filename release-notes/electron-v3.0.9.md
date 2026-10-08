# Nuwax 3.0.9

- 本地加速默认关闭；新安装和缺少模式配置的客户端直接加载业务站点，设置页仍可手动开启本地加速。
- 修复 Linux DEB/RPM 安装脚本遗漏 Nuwax 沙箱路径的问题，安装时设置 `chrome-sandbox` 的属主和执行权限。
- 改进 Windows 旧安装目录恢复遇到文件冲突时的状态记录与保护。

保留全部既定集成资源。提供 Windows x64、macOS arm64/x64、Linux arm64/x64 安装包。
