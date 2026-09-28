# 规格：商业注册 v2 与稳定设备身份

- 对应 intent：`plans/20260927-registration-v2-device-id-intent.md`
- 状态：按用户授权实施；后端迁移与实机证据待补。

## 需求基线

仅修改商业版注册路径与 deviceId 来源。`deviceId` 维持 64 位小写十六进制 SHA-256，盐维持 `nuwax:device:v1`，macOS 正常读取值兼容原算法。

## 方案设计

- 主进程 `system/commercialDeviceId.ts` 优先读取 `~/.nuwax/device-id`，只持久化哈希；未生成过时按平台读取硬件身份并推导。设备身份与登录凭据分离，退出/换域不清除。
- macOS：IOPlatformUUID；Windows：PowerShell `Get-CimInstance Win32_ComputerSystemProduct` 的 SMBIOS UUID；Linux：`/sys/class/dmi/id/product_uuid`。
- UUID 统一小写，拒绝空值、全零、全 F 与格式错误；硬件读取失败退回严格校验的系统安装 ID，仍不可用时生成并持久化随机备用 ID。已选身份不因后续读取恢复而变化。
- 命令设置超时且 Windows 不显示控制台。使用独占文件创建，竞争时读取已写入身份；持久化失败/损坏时显式失败，不悄悄生成另一个 ID。
- `deviceId.ts` 只在商业产品分支调用上述模块，保留社区版算法与系统日志。
- `commercialAuth.ts` 改为 v2；认证、请求体、返回值与迟到响应隔离保持现有协议。

## 异常与失败场景

- Linux DMI 通常需要 root 权限，不提权，退回安装 ID并固定保存。
- 无有效硬件/系统身份的设备只能在保留身份文件时保持备用 ID；清空数据、重装系统并丢失备用文件无法保证原 ID。
- Windows/Linux 从安装身份切到硬件身份可能产生一次 ID 迁移，沿用现有清派生凭据、保留 savedKey 的链路；历史合并需后端支持。
- 主板更换、虚拟机克隆和复制完整用户数据目录的身份归属不在本次解决范围。

## 测试计划

平台取值、占位 UUID、改名、重启、应用数据清除后硬件重建、读取失败恢复、备用 ID 持久化、竞争/写入失败；注册测试断言 v2 与 deviceId。商业门禁、主进程构建与 pin 纯度检查。社区门禁须在隔离副本运行。

## 依据

- Windows SMBIOS UUID：[Microsoft Win32_ComputerSystemProduct](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-computersystemproduct)。
- Linux DMI UUID 和读取权限：[Linux dmi-id.c](https://github.com/torvalds/linux/blob/master/drivers/firmware/dmi-id.c)。
