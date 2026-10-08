# 规格：release-channels

- 对应 intent：plans/20261008-release-channels-intent.md
- 状态：用户已确认实施方案

## 版本与契约

新 tag 仅 vX.Y.Z / vX.Y.Z-beta.N，数字无前导零，N 从 1 开始，每次取已占用最大序号加一。所有 tag（含 Draft）占用版本；已有正式 tag 关闭同号 beta。允许直接和连续 stable，禁止版本回退。历史前缀只用于解析记录和显式 --tag 续跑，不能创建。

CLI --version 为完整版本、推导通道；--channel 为可选断言。--tag 仅续跑已存在 tag，可从最新工具提交处理历史目标 SHA；构建来源和自动化来源分别记录。发布说明 release-notes/<tag>.md。

## 发布与更新

两套 tag workflow 互斥路由，先校验版本再运行源码门禁和五平台构建。beta 自动发布，stable 在签名、安装验收后显式同步。签名接收 SIGN_RELEASE_TAG，默认保留基座历史格式。

stable 发布推进 latest 指针，在更高时推进 beta 指针；beta 发布只推进 beta。同步共用锁，读取两镜像原指针，检查 SemVer 和一致性，写入后回读，失败恢复原指针。新元数据保留现有结构，必须提供 yml 文件 URL；客户端保留历史路径兜底。

更新器接受纯数字与 beta.N，复用现有版本比较。stable 不接收预发布，beta 接收两类，禁止降级。首次安装根据包通道选择，已保存设置优先。

## 验证与上线

覆盖编号、转正、历史占用、tag/SHA 不可变、互斥触发、通道冲突、构建失败、镜像事务与回滚、beta 包升级和订阅切换。隔离运行社区/商业测试与 check:pin。首次实际发布 v3.0.10 迁移两类旧客户端，再启用 beta.N；真实安装和签名验收不能由单测代替。
