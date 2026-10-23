# 打包重复构建优化

- 目标：减少 macOS Intel 与 Windows 每次发布重复编译的前端和原生资源；保持 MSI、NSIS ZIP、签名、公证及发布门禁。
- 范围：当前分支 `fix/stable-3.0.22` 的构建脚本与 workflow，不带入 Beta.4 的运行时代码或源码 pin。
- Beta 前端：与源码门禁并行构建一次，五平台消费同一 workflow artifact；核对客户端 SHA、前端 gitlink、版本戳、文件 SHA256 和 producer run。stable 继续消费 nuwax-dist pin。
- 原生资源：按源码/补丁/锁文件、构建配方、实际工具链、架构和 SDK 输入缓存未签名 helper；每次仍从锁定源码检查补丁并重新组装/签名。capture 仅缓存已有准入规则覆盖的未签名资源和源码/许可证。
- 跨 tag：默认分支专用预热 workflow 写入与发布相同的资源缓存；移除 Node/Git 缓存键对发布 package.version 的依赖。不同 tag 的私有缓存不互相假定可见。
- 验证：按用户最新要求，本次不运行测试、构建、打包、CI 或真机操作，不提交、不发布；由用户在下一个 Beta 执行流水线。收益尚未测量。
