# 规格：IM 原生通知与未读角标

已通过会话中的 requirement-analysis / grill-with-docs 访谈确认，不再要求用户重复确认。

产品范围仅 Nuwax 商业客户端，社区 NuwaClaw 不需要本功能。实现保留在商业 overlay，
依赖由商业仓根清单和锁文件管理；社区基座不新增依赖、接收器、角标或原生通知。
运行时也检查产品身份，仅 nuwax 可初始化接收器。

维护边界：IM 项目由其他团队负责，仅只读核对现有接口与协议。此次接入只修改商业壳及 PC 宿主适配，不修改、提交或推送 IM 原仓或其子模块，不重放用户已撤销的 IM 提交。

主进程单例独立设备 `<commercial-device-id>#im-native`，POST `/api/instant-message/devices`，WS `/instant-message/ws` 使用 im-v1、ticket Cookie、JSON CONNECT/PING。所有ID按字符串安全解析。HTTP走当前商业ticket能力，不跨域重定向，不记录凭据。

监听 MSG_RECV/MSG_REVOKE/CONV_UPDATE/CONV_UNREAD；CONNECT_ACK、恢复前台、解锁/唤醒补拉 GET `/api/instant-message/unread-total`。变化合并，最多一个在途请求，保留最后成功数。authoritative=false仍为可用结果，后续请求限为每分钟一次。

最多一连接、一心跳、一重连计时器、一未读调度计时器和一离线探针。CONNECT10秒超时，PONG按协商心跳的3个周期判断失联。重连1/2/4/8/16/30秒封顶加抖动，握手成功重置。认证/配额/明确非重试错误终止自动重连。正常前台120秒、后台300秒兜底；锁屏/睡眠无网络请求；离线仅15秒本地net.isOnline探测。恢复门禁统一幂等协调，不能创建重复连接。

角标显示在macOS Dock、Windows任务栏应用图标、系统托盘及女娲智联菜单。0隐藏，1至99显示原数，超过99显示99+；tooltip/无障碍文案保留真实数量。Mac托盘保留template图标，右侧显示数量；Windows托盘使用红色数字图标，0恢复原图。

菜单补齐（2026-09-30）：商业壳向当前账号代次的受信顶层业务文档提供 im.getUnreadSnapshot / im.onUnreadChanged，只传 sessionGeneration、revision、total、dndTotal；沿用 im.setNotificationEnabled。页面先订阅再读取快照，忽略旧代次/旧修订及登出后的迟到回调；账号或业务域变化清零。原生快照优先于 IM 页面未读事件，微应用卸载不清除壳层展示值。菜单不另开 WS 或轮询，普通 Web 继续消费已有 window.__im。

loopback 的绝对菜单地址只可用 auth.getContext 返回的当前业务域归一化；要求 loadMode=gateway 且 gatewayOrigin 与页面 origin 一致，仍校验应用 code、路径和当前标签打开方式。第三方地址不接管。菜单查询时完成归一，渲染不依赖异步 origin 缓存。页面内消息状态不增加同步逻辑。

native通知按账号与msgId去重，前台、锁屏、睡眠不弹；按需查询会话详情复核DND并生成标题，失败不阻断角标。元数据并发2、等待会话50、去重2048、近期通知回调20有上限；容量淘汰仅释放JS引用，系统通知历史交给OS管理。商业IM关闭浏览器通知，原开关同步给主进程；不开IM页也从既有localStorage恢复开关。点击恢复show/focus客户端，未读数不因点击清零。账号边界使旧通知回调失效。系统消息列表指操作系统通知中心，不新建客户端列表。

直接消费现有 GET `/api/instant-message/unread-total` 契约：角标只使用 `total`（服务端口径，不含免打扰会话，与后端确认于 2026-10-09），不累加 `dndTotal`；`dndTotal` 为可选的免打扰数量，不参与角标。客户端不遍历会话补算统计，不改变服务端500会话扫描上限或失败策略。数量完整性以现有接口能力为准，相关服务端问题交由IM维护团队处理。

## WS事件对照

根据用户提供的对照表与当前IM协议整理。壳是只收通知的独立设备，不发送READ_REPORT或MSG_RECV_ACK，不加载历史。数量全部以unread-total返回值为准，避免重复投递和多端已读造成偏差。

| 帧 | op | 原生接收器处理 |
| --- | --- | --- |
| MSG_RECV 新消息 | 3002 | 合并拉未读；后台有资格时发系统通知 |
| CONV_UNREAD 自己未读更新 | 6001 | 合并拉未读，包含其他设备读完后的清零 |
| READ_NOTIFY 单人已读 | 4001 | 不改变自身未读，不增加原生处理 |
| READ_NOTIFY_AGG 聚合已读 | 4002 | 不改变自身未读，不增加原生处理 |
| CONV_UPDATE 会话资料变更 | 6000 | 合并拉未读；通知展示前另查最新DND |
| CONTACT_UPDATE 通讯录变更 | 8000 | 不增加原生处理 |
| MSG_REVOKE 撤回 | 3004 | 合并拉未读 |
| MSG_EDIT 编辑 | 3005 | 不增加原生处理 |
| MSG_REACTION 表情回应 | 3008 | 不增加原生处理 |
| MSG_AGENT_STATUS 智能体状态 | 3006 | 不增加原生处理 |
| KICK 被踢 | 9000 | 认证/配额原因阻断；server_restart允许重连 |
| ERROR 上行失败 | 9001 | 按明确错误码区分可重试与终止 |
| CONNECT_ACK / CONNECT_REJECT | 1001 / 1002 | 完成握手并补拉 / 按错误码重试或终止 |
| PING / PONG | 2000 / 2001 | 协商心跳与失联检测 |
| SYNC_RESP | 5001 | 兼容已有协议事件，可触发补拉；不主动同步历史 |
