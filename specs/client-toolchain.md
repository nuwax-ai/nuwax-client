# 规格：client-toolchain

- 对应 intent：plans/20260926-client-toolchain-intent.md
- 状态：技术评审通过（本任务 Plan Mode 收敛后用户请求实施）

## 需求基线

统一外层命令与无敏感值配置，复用一个准备引擎，源码和产物以双 gitlink 锁定。

## 方案设计

### 架构落点

client.config.mjs 定义商业参数；scripts/client 按 core/frontend/prepare/dev/pack/update/release 分层。CLI 负责解析、锁与输出，模块负责所属副作用。

### 数据与契约

- frontend:build 留下 nuwax/dist 本地输出，不提交推送；构建期生成版本文件恢复原状。
- dev 默认 dist，--frontend source 启动 Umi；pack 默认 dist，source 显式构建。
- 缓存置于忽略的 .cache/client-toolchain；输入变化或输出损坏才重新准备。
- 更新产物保留 .git/README，先推产物再提交外层 gitlink；noCommit 不产生任何 commit/push。
- release 的 tag、版本、目标 SHA 一致；同号 tag 不可改写；按真实远端状态续跑。
- doctor --json 只读报告准备条件、pin、前端戳和缺失步骤。

### 平台/引擎矩阵

Node 编排支持 macOS、Windows、Linux。包默认当前宿主架构；正式五平台构建继续使用 CI。系统构建工具与证书认证不由准备脚本静默安装。

## 异常与失败场景

脏工作区不被覆盖；来源分叉拒绝；产物推送竞争只重试一次且仅丢弃本轮提交；未发布 gitlink 禁止外层 push；失败缓存不标记完成；端口占用不杀陌生进程；签名认证失败停留可续阶段。

## 测试计划

临时 Git/bare remote 与发布适配器测试；缓存命中/失效、资源输出、进程退出、品牌配置测试；test:scripts、隔离商业轨；真实前端构建、开发与平台包验收；release dry-run。

## 已否决的备选方案

启动时拉分支尖或推送；每次全量 prepare；重写仍被 pin 引用的产物历史；本地改 tracked 基座 package.json 注入品牌。
