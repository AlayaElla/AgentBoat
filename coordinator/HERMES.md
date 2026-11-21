# Hermes 连接

在“工作间 → 设置 → 外部连接”按名字管理 A2A 连接。Windows 使用 `workspace/install-hermes.ps1`，macOS 使用下面的脚本。两者共用配置程序，按名字 Hermes 新建或更新 A2A 连接。本机安装了 Hermes 时，连接详情显示其审批方式。

自动配置使用 Hermes 9900、插件 9901。两个方向各用一个至少 32 字符的独立令牌。AgentBoat 将令牌保存在 Orca secrets，Hermes 将入站令牌保存在本机 `.env`、出站令牌保存在 `config.yaml`。空令牌表示不更换。插件监听始终为 127.0.0.1，出站只允许无路径、无凭据的回环 HTTP 地址；远端经已有隧道接入。

专用安装使用独立的 daily、记忆和 skill 处理日程提醒、资料整理、写作和日常电脑操作，审批 smart，cron/single-query/unattended 为 deny。接入已有 profile 时沿用其工作目录、身份、审批和渠道，仅增加 A2A 和一项 skill。两种模式都在本机备份配置，令牌只写入本机配置和 Orca secrets。

## macOS 全新安装（AgentBoat 专用）

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

## macOS 只接入已有的星月

默认 profile 位于 `~/.hermes`，具名 profile 位于 `~/.hermes/profiles/<目录名>/`，各自拥有 `config.yaml`、`.env` 和 `skills/`。在这台 Mac 上，已有网关承载四份配置。共享的 8642 提供 `/p/<profile>/` 等入口，A2A 适配器从所属 profile 取端口和认证信息，星月单独监听 `127.0.0.1:9900`。AgentBoat 在 9901 接收星月对 `orca-main` 的调用。[官方 profile 说明](https://hermes-agent.nousresearch.com/docs/user-guide/profiles) · [多 profile 网关](https://hermes-agent.nousresearch.com/docs/user-guide/multi-profile-gateways) · [A2A 配置](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/a2a) · [官方适配器实现](https://github.com/NousResearch/hermes-agent/blob/main/plugins/platforms/a2a/adapter.py)

**接入。** 当安装的 AgentBoat 版本已包含 `--attach` 时，Mac 主 agent 用原登录账户打开已启用插件的工作间面板，在终端运行：

```sh
cd "$HOME/Library/Application Support/orca/agentboat-current"
bash workspace/install-hermes.sh --attach --profile '星月'
```

参数使用磁盘上的目录名。自定义安装时，`HERMES_HOME` 指向包含 `profiles/` 的根目录，`HERMES_INSTALL_DIR` 指向现有 Hermes 源码目录。脚本直接使用其中的 `.venv/bin/python` 或 `venv/bin/python`，其他布局可用 `HERMES_PYTHON` 指定已安装的 Hermes 解释器。它跳过安装、升级、LaunchAgent 登记和网关启停。

**写入内容。** 假设星月原有 QQ 渠道、系统提示和审批，原先没有 A2A。脚本在星月目录内备份原有的 `config.yaml` 和 `.env` 为同时间戳的 `*.before-hermes-<时间戳>`，备份权限为 0600。下面是写入后的新增项，两个令牌各自独立：

```yaml
gateway:
  platforms:
    a2a: {enabled: true, extra: {port: 9900}}
a2a_agents:
  orca-main:
    url: http://127.0.0.1:9901
    auth: {type: bearer, token: "<已打码，AgentBoat 入站>"}
    timeout: 600
    capabilities: [daily]
platform_toolsets:
  a2a: [web, browser, terminal, file, skills, cronjob, memory, computer_use, a2a]
```

已有 `platform_toolsets.a2a` 列表时仅补上 `a2a`。`.env` 末尾追加如下内容：

```dotenv
A2A_HOST=127.0.0.1
A2A_PORT=9900
A2A_AGENT_NAME=Hermes
A2A_BEARER_TOKEN=<已打码，Hermes 入站>
A2A_TRUSTED_PEERS=ip:127.0.0.1
A2A_ALLOW_ALL_USERS=false
```

脚本新增 `skills/agentboat-hermes/SKILL.md`，在面板登记名为 Hermes 的 A2A 连接，对端为 `http://127.0.0.1:9900`。若 profile 缺失、已有 A2A 配置、同名 skill 或连接，或任一本机端口不可用，脚本会在备份和写入前退出。再次执行会提示已有 A2A 平台。

**重启和测试。** 由维护现有网关的人择时按原方式重启同一个网关。恢复后 Mac 主 agent 在“工作间 → 设置 → 外部连接 → Hermes”检查连接，再从已绑定的主 Run 发送一句“星月，请回复：收到测试”。使用下节的 `connection-send` 输入格式和新的请求编号，在该连接的最近往来中核对同一请求的回复。

**回退。** 在星月目录中选取本次接入前同一时间戳的两份备份，还原前先核对备份之后是否另有手动改动。可在该目录执行以下命令（替换时间戳）：

```sh
stamp='本次备份时间戳'
cp -p "config.yaml.before-hermes-$stamp" config.yaml
cp -p ".env.before-hermes-$stamp" .env
rm skills/agentboat-hermes/SKILL.md
rmdir skills/agentboat-hermes
```

若接入前没有 `.env`，回退时移除本次新建的 `.env`。在面板删除本次新建的 Hermes 连接（会同时删除其凭据和往来记录），再由维护者重启同一网关。若脚本在登记连接时失败，先核对面板中的登记结果，再按上述步骤回退。

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

Hermes skill 源为 `workspace/skill/agentboat-hermes`，安装在对应 profile 的 `skills/agentboat-hermes`。专用安装同时将其内容设为系统提示。定时任务明确指定 agentboat-hermes、固定事项编号、时区与 a2a_call 联系 orca-main，结果交主 agent 转告用户；创建回执不等于送达，gateway 运行才执行。

## 排查

先查 `hermes gateway status` 和本机 logs/gateway.log、a2a_audit.jsonl，不转发凭据或正文。服务不可达时核对 gateway、端口和地址；401 核对插件对方令牌与 A2A_BEARER_TOKEN；403 核对 A2A_TRUSTED_PEERS 包含 ip:127.0.0.1，改动后重启 gateway。连接检查通过只证明 A2A 鉴权查询，不证明订阅与模型可用。额度问题由用户在 hermes model 核对。

开发和发布流程见 [README](README.md)。
