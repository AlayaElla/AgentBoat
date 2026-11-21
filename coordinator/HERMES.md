# Hermes 连接

在“工作间 → 设置 → 外部连接”按名字管理 A2A 连接。Windows 使用 `workspace/install-hermes.ps1`，macOS 使用下面的脚本。两者共用配置程序，按名字 Hermes 新建或更新 A2A 连接。本机安装了 Hermes 时，连接详情显示其审批方式。

自动配置使用 Hermes 9900、插件 9901。两个方向各用一个至少 32 字符的独立令牌。AgentBoat 将令牌保存在 Orca secrets，Hermes 将入站令牌保存在本机 `.env`、出站令牌保存在 `config.yaml`。空令牌表示不更换。插件监听始终为 127.0.0.1，出站只允许无路径、无凭据的回环 HTTP 地址；远端经已有隧道接入。

Hermes 仅处理日程提醒、资料整理、写作和日常电脑操作，使用自己的 daily、记忆和 skill。审批 smart，cron/single-query/unattended 为 deny，拒绝后不能放宽审批。配置脚本在本机备份配置，不打印凭据。

## macOS 安装

Mac 主 agent 使用主人的普通登录账户，打开一次已启用正式版 AgentBoat 的工作间面板。在正式版的固定入口目录运行下列命令（macOS 上是 `~/Library/Application Support/orca/agentboat-current`，安装脚本随正式版发布，不需要源码仓库）。自定义 Orca 用户环境时，使用该环境的终端或先设置对应的 `ORCA_USER_DATA_PATH`。

```sh
bash workspace/install-hermes.sh
```

脚本调用官方非交互安装器，默认将 Hermes 安装在 `~/.hermes/hermes-agent`，命令入口为 `~/.local/bin/hermes`。它在 Hermes 的 Python 环境中配置 A2A、审批、日常目录和专用 skill，并通过正式版 AgentBoat 的本机桥接登记连接。已有官方脚本安装的 Hermes 时，运行 `bash workspace/install-hermes.sh --configure-only` 可跳过下载。使用自定义数据目录或源码目录时沿用安装时的 `HERMES_HOME` 和 `HERMES_INSTALL_DIR`。[Hermes 官方安装说明](https://hermes-agent.nousresearch.com/docs/getting-started/installation)

**主人在 Mac 上完成模型登录。** 在自己的终端运行 `~/.local/bin/hermes model`，选择自己的订阅或提供商，按提示完成浏览器授权或输入密钥。密钥只在本机交互输入。日后使用电脑操作时，由主人按实际需要批准 macOS 权限。

**登录完成后，Mac 主 agent 启动并查看服务。**

```sh
~/.local/bin/hermes gateway start
~/.local/bin/hermes gateway status
```

安装脚本通过 `gateway install --no-start-now` 写入当前用户的 LaunchAgent。首次安装后可手动启动，也可等下次登录自动启动。已有正在运行的 LaunchAgent 时，官方命令可能重新加载服务。[Hermes 官方网关说明](https://hermes-agent.nousresearch.com/docs/user-guide/messaging#macos-launchd)

## A2A 接口和命令

依据 [A2A v1.0](https://a2a-protocol.org/latest/specification/) 与 [Hermes A2A 文档](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/a2a)。

| 入口 | 行为 |
|---|---|
| `GET /.well-known/agent-card.json` | 提供主 agent 的卡片，仅声明文字、JSONRPC 1.0；无项目内容 |
| `POST /`，`SendMessage` | 接收 `ROLE_USER`、`messageId`、文字 parts、可选 contextId，返回 `{task}` |
| `POST /`，`GetTask` | 按任务 id 查询状态和回复，可用 historyLength 限定历史 |
| 其他路径/方法 | 404 / JSON-RPC method not found；无项目读取接口 |

卡片、消息和任务查询都要求 `Authorization: Bearer …`。拒绝浏览器 Origin、错误令牌、非文字附件、过大请求。无 CORS、流式接口或推送回调；不宣称支持这些能力。

入站任务先持久化在连接独立的 `workspace.a2a:<connectionId>`，带来源消息编号和 contextId，作为“来自外部连接「Hermes」”通知已绑定主 Run。未绑定时保留 pending，绑定后递交。主 agent 不会立即回复：`returnImmediately:true` 返回 submitted task，调用方用 GetTask 查询；默认阻塞直到主 agent 回应。客户端断开不会删除任务。主 agent 的 connection-reply 将回复以唯一消息编号写入 history/artifact，并完成原任务；之后 Hermes 可读回。相同 messageId、相同内容返回同一任务，不重复记录/通知；同编号不同内容被拒绝。

```text
node coordinator/scripts/client.mjs connections
node coordinator/scripts/client.mjs connection-read "Hermes"
node coordinator/scripts/client.mjs connection-check "Hermes"
node coordinator/scripts/client.mjs connection-send < request.json
node coordinator/scripts/client.mjs connection-reply < reply.json
```

send/reply 的 JSON **从标准输入读取**，每次指定连接名字。

send/reply 输入：

```json
{"name":"Hermes","runId":"已绑定主Run","requestId":"唯一消息编号","contextId":"同一事项稳定编号","text":"明确授权的日常请求"}
```

```json
{"name":"Hermes","runId":"已绑定主Run","id":"Hermes 来源的 task.id","requestId":"唯一回复编号","text":"已向用户转达后的答复"}
```

出站发送以 requestId 作为 messageId，同一事项传回同一个 contextId。命令先返回持久化记录，后台发送，返回任务未完成时查询原 remoteId；结果生成稳定的 `requestId:result` artifact，作为来源送回主 Run。Hermes 稳定版会阻塞 SendMessage，插件允许它的 300 秒回复窗口，并仍能独立递交入站提醒和确认，避免相互等待。

任务、回复和通知有独立状态。网络中断、发送后崩溃、通知结果未知时保留 uncertain/可见错误，禁止自动重发未知写入。已取得远端任务编号的只继续 GetTask。不要换 requestId 绕过保护。失败记录在“设置 → 外部连接 → Hermes → 最近往来”和 connection-read 中查看；错误保留 HTTP 状态、JSON-RPC 错误码和消息，或网络错误类型（如 TypeError / ECONNREFUSED、TimeoutError），不记录令牌、请求正文或错误响应的 data 字段，并对错误消息中原样回显的凭据和正文脱敏。重新打开设置可刷新状态。历史接近 190 KB 前裁剪已结束且已通知记录的正文与附件，保留消息编号、任务编号、状态、内容摘要和回复编号用于去重；活动与待核对记录保留。活动内容仍超限则拒绝写入。

## 资料边界、提醒和 skill

A2A 没有项目读取或写入路由。主 agent 只发明确选择的日常文字，Hermes 不读项目、仓库、其他 agent 的凭据或目录。来源不自动写入项目 events。此约束不构成同一系统用户下的目录隔离。

Hermes skill 源为 `workspace/skill/agentboat-hermes`，安装在 Hermes home 的 `skills/agentboat-hermes`，内容同时作为系统提示。定时任务明确指定 agentboat-hermes、固定事项编号、时区与 a2a_call 联系 orca-main，结果交主 agent 转告用户；创建回执不等于送达，gateway 运行才执行。

## 排查

先查 `hermes gateway status` 和本机 logs/gateway.log、a2a_audit.jsonl，不转发凭据或正文。服务不可达时核对 gateway、端口和地址；401 核对插件对方令牌与 A2A_BEARER_TOKEN；403 核对 A2A_TRUSTED_PEERS 包含 ip:127.0.0.1，改动后重启 gateway。连接检查通过只证明 A2A 鉴权查询，不证明订阅与模型可用。额度问题由用户在 hermes model 核对。

开发和发布流程见 [README](README.md)。
