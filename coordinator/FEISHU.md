# 工作间飞书接入

在插件“设置 → 外部连接 → 飞书”配置。使用企业自建应用的机器人，主机需开着 Orca 和插件并能访问飞书；不需要公网回调地址。飞书仅有一个工作间连接，允许用户与会话名单统一设置。普通消息交工作间主 agent，项目资料由它用 message 转达。

## 飞书开放平台设置

1. 登录[开发者后台](https://open.feishu.cn/app)，创建“企业自建应用”，在“添加应用能力”启用机器人。不要选群自定义 Webhook 机器人，它不能接收用户消息。
2. 在“权限管理”申请应用身份权限：`im:message.p2p_msg:readonly`（单聊收信）、`im:message:send_as_bot`（发送与回复）、`im:resource`（上传提醒中的图片）。如果在群里使用，再申请 `im:message.group_at_msg:readonly`，在群内回复时同时 @ 机器人；不必申请所有群消息的敏感权限。按控制台要求由管理员审批。
3. 在“事件与回调 → 事件配置”添加“接收消息” `im.message.receive_v1`，订阅方式选择“使用长连接接收事件”。本版用回复提醒，不需要订阅卡片回调。
4. 到“版本管理与发布”创建版本并发布，将自己的账号包含在应用可用范围内。群聊使用时将机器人加入可信群，确保机器人可发言。权限和订阅有变动后重新发布。
5. 在后台的 API 调试台，用“发送消息”或“接收消息”事件的调试记录取得当前应用下自己的 `open_id` 和会话 `chat_id`。群 ID 也可通过官方[获取群信息](https://open.feishu.cn/document/server-docs/group/chat/get)调试取得。单聊可先发布，再用开发平台“事件与回调”的调试记录查看自己发给机器人的那条事件：`sender.sender_id.open_id`、`message.chat_id`。这些 ID 是应用作用域的，不从其他应用复制。
6. 在 Orca“工作间 → 设置 → 外部连接 → 飞书”填写 App ID、App Secret、允许用户 Open ID、允许会话 Chat ID 并启用。每行一个。提醒会发送到**全部允许会话**，群成员也能看见项目内容；个人使用优先填与机器人的单聊。App Secret 只输入密码框，进入 Orca 密钥存储；不要写 JSON 配置、聊天、截图或命令行。
7. 如果控制台保存长连接订阅时要求应用在线，先在插件保存并启用配置，待长连接建立再到控制台保存订阅、发布。插件显示“连接中”仅说明正在建连，“已连接”才是 SDK 建连回报；收发仍需自己配置应用后验证。
8. 绑定工作间主 agent（见工作间 skill），在飞书发一句普通消息，主 agent 收到后通过 `feishu-reply` 回复。工作间提醒直接由插件推送，主 agent 未绑定或不在线也不影响新提醒发送。

依据：[消息常见问题](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/guide/faq)、[接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)、[回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply)、[上传图片](https://open.feishu.cn/document/server-docs/im-v1/image/create)。这些步骤依据官方文档整理，未用真实应用实测。

## 在飞书中使用

- 普通消息发送到工作间主 Run。主 agent 用 `node D:/Projects/AgentBoat/coordinator/scripts/client.mjs feishu-read` 核对来源，用 `feishu-reply <input.json>` 发回同一会话，输入 `{runId,eventId,requestId,text}`。input.json 只有回复与来源信息，不包含凭据；相同 requestId 只能重放完全相同回复。该接口要求绑定的主 Run，不会自动抓取或转发 agent 的整段会话。
- 新待决定提醒列出问题及选项；直接“回复”那条提醒，输入 `1`、完整选项或 `决定：你的决定`。自由决定也用 `决定：`。
- 新待验收提醒包含验收版本、核对内容和成果；直接回复 `通过`、`验收通过` 或 `修改：具体意见`。群里同时 @ 机器人；@ 占位符仅在解析反馈时去掉，原话照存。
- 必须回复准确提醒。普通会话里的“通过”、不明消息、已处理或已更新的提醒会追问，不推断为全部通过。项目、任务、事项、版本由发出的提醒记录确定，不能通过回复内容改成其他项目。只允许用户名单内的人记录反馈，且会话也必须被允许；未授权消息忽略，不发送项目内容给它。
- 图片成果支持 PNG/JPEG/GIF/WebP/BMP 文件或带这些扩展名的 HTTP(S) 图片链接，上传飞书后以富文本图片展示。本机文件仅从成果所属项目真实目录内读取，拒绝越界符号链接；网络图片拒绝本地/私有地址和私有 DNS 解析，逐次校验重定向，上限 10 MB。文件路径不会发送到飞书，只显示“在 App 里查看”；图片上传失败也明确标明。无图片扩展名的下载页保留为链接。
- 新受阻和完成也直接提醒；读记录、启用飞书或重启不会补发历史事项。每个验收新版本独立提醒。原话、发送者、消息编号和接收时间保留在项目反馈历史中；同一消息重复事件不重复登记。
- 发送超时或重启前正在发送的消息保留 `uncertain`，不自动重发。`sent` 表示飞书 API 或 Orca 已接受，不证明用户阅读，也不证明主 agent 已响应。工作间收发记录接近 200 KB 前裁剪已结束消息的正文，保留来源编号、投递回执摘要和去重编号；待处理与结果待核对的正文保留。若活动内容仍超过容量，拒绝本次写入并保留原记录。

## 卡片回调结论

官方[接收回调](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/receive-and-handle-callbacks)明确支持长连接接收新版 `card.action.trigger`，要求 3 秒内响应；这属于文档核实，未做真实连接实测。本版采用直接回复提醒，未生成交互按钮或注册卡片回调，用户无需配置回调订阅。

## 新请求与数据

`workspace.feishu` 只接受 `{operation:'read'}`，读取配置、状态、来源与发送记录。配置保存走 `workspace.connections`：`{operation:'save',connectionId,name,revision,feishu:{enabled,appId,senderIds,chatIds},appSecret?}`；新建时用 type=feishu。Secret 进入 Orca 加密存储，读取仅返回 secretSaved；存储写入成功后才更新密钥。

`workspace.reply` 输入 `{runId,eventId,requestId,text}`，对应 CLI `feishu-reply`。来源决定回复目标，绑定 Run 和允许范围均会检查。相同 requestId 必须有相同正文与来源；裁剪后仍可校验去重摘要。

回复决定和验收提醒会调用批量 project.feedback（items 只有当前一项），校验事项尚待用户处理，写入反馈原话与来源。删除飞书连接只清除其配置、密钥、收发记录，其他工作间请求通知的去重回执保留。

开发和发布流程见 [README](README.md)。
