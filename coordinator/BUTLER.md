# Hermes 连接

工作间只有一个主 agent。Hermes 是独立的日常服务，接日程提醒、资料整理、写作和日常电脑操作；所有给用户的结果、问题和确认都经主 agent 转达。飞书仍只接主 agent。

## 安装、登录和启动

在已通过测试并重新加载插件后，在本机 Orca PowerShell 运行：

```powershell
./workspace/install-hermes.ps1
```

脚本使用 [Hermes 官方安装器](https://hermes-agent.nousresearch.com/docs/getting-started/installation)的非交互安装模式。已完成官方安装时可加 `-ConfigureOnly`。Windows 数据和 CLI 位于 `%LOCALAPPDATA%\hermes` 与其 `bin` 子目录；自定义 home 使用 `HERMES_HOME`。不安装桌面应用，不操作真实桌面。

配置脚本备份原配置、生成两个不同的随机令牌、保存插件密钥、配置回环 A2A、安装 Hermes skill，并注册登录自启。运行前确认 9900/9901 没被其他服务占用。安装会拒绝接管已有其他 Hermes 对端或已启用的用户通道；配置失败先核对回执和备份，不盲目重装或删除数据。

Hermes 当前 Windows 服务安装器可能主动提出 UAC。脚本设置非交互模式并使用默认的拒绝答案，走官方 Startup 登录项替代路径，不触发管理员授权弹窗；它仍会在用户登录时启动。安装阶段不立即启动 gateway，以便停在用户订阅登录步骤。

**订阅登录必须由用户自己完成：**

1. 打开一个新的本机 PowerShell，运行 `hermes model`。若 PATH 尚未更新，运行 `& "$env:LOCALAPPDATA\hermes\bin\hermes.exe" model`。
2. 选择 **ChatGPT or Codex Subscription**。按终端显示的验证网址和设备码，在自己的浏览器登录 ChatGPT 并确认授权。不要把设备码、登录文件或凭据交给 agent。
3. 返回终端，等待登录成功，按提示选可用的 Codex 模型。订阅额度和开发用 Codex 共用。
4. 运行 `hermes gateway start` 和 `hermes gateway status`，然后在 Orca“工作间 → 设置 → 外部连接 → Hermes”点“检查连接”。检查会读取 Agent Card，再用已保存的 Hermes 出站令牌查询随机的不存在任务；只有 HTTP 200、JSON-RPC `-32001`（任务不存在）才显示“已连接”，证明 A2A 可达、鉴权和对端信任检查通过，不证明模型调用成功。检查不会创建任务、通知主 agent 或写入消息记录。
5. 告知主会话“登录完成”，再安排真实模型、定时提醒和双向通信验收。登录前不得把模拟结果当成真实端到端结果。

登录流程见 [Hermes 模型文档](https://hermes-agent.nousresearch.com/docs/integrations/providers)。

## 设置

可添加多个 A2A 连接，名字必须唯一，各自独立保存配置、密钥和往来。`workspace.connections` 只登记名字、类型与稳定编号；原 Hermes 仍用 `workspace.butler` 和 `butler:inbound/outbound`，新 A2A 使用独立命名空间。原工作间飞书配置和密钥保持原位置。改名字不会改变连接编号或令牌；删除连接需确认，清除该连接的设置、凭据和往来记录，项目不受影响。企业微信预留为不可选项。

Hermes 连接详情通过本机 Hermes CLI 读取当前审批模式；smart 显示“危险命令：smart，拿不准的拒绝”。连接保存不修改审批配置。定时、单次查询、无人值守均为 deny，不用危险命令验证。

“设置 → 外部连接 → Hermes”提供名字、启用开关与对方的地址；“连接参数”折叠里提供对方的令牌、主 agent 监听端口及主 agent 的令牌；空令牌保留原密钥。两个方向都需要至少 32 字符的令牌。监听始终绑定 `127.0.0.1`，界面不提供扩大监听范围的选项；出站只允许回环 HTTP 根地址，拒绝路径、重定向和 URL 凭据。

自动配置默认：Hermes `http://127.0.0.1:9900`，插件 `http://127.0.0.1:9901`，避开 API 8642 和 webhook 8644。改端口或令牌时须同时更新 Hermes `.env` 中的 A2A 配置和 `config.yaml` 的 `a2a_agents.orca-main`，再重启 gateway。

插件令牌只在 Orca secrets 存储，不写普通插件记录。Hermes 的对端令牌与入站令牌留在它自己的 `config.yaml` / `.env`；这些文件及备份必须留在本机，不进入 Git。Hermes 使用独立的 daily 目录、Hermes 记忆、Hermes skill 和系统提示词，外部 skill 目录为空。审批为 smart，定时/单次/无人值守危险操作为 deny。需要确认时交给主 agent，不能自行放宽审批。

组织画布“工作间内部”显示每个外部连接的名字和类型，连接主 agent。点击节点可看状态，设置在主面板的“外部连接”中修改。

## A2A 接口和命令

依据 [A2A v1.0](https://a2a-protocol.org/latest/specification/) 与 [Hermes A2A 文档](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/a2a)。

| 入口 | 行为 |
|---|---|
| `GET /.well-known/agent-card.json` | 提供主 agent 的卡片，仅声明文字、JSONRPC 1.0；无项目内容 |
| `POST /`，`SendMessage` | 接收 `ROLE_USER`、`messageId`、文字 parts、可选 contextId，返回 `{task}` |
| `POST /`，`GetTask` | 按任务 id 查询状态和回复，可用 historyLength 限定历史 |
| 其他路径/方法 | 404 / JSON-RPC method not found；无项目读取接口 |

卡片、消息和任务查询都要求 `Authorization: Bearer …`。拒绝浏览器 Origin、错误令牌、非文字附件、过大请求。无 CORS、流式接口或推送回调；不宣称支持这些能力。

入站任务先持久化在独立的 `workspace.butler`，带来源消息编号和 contextId，作为“来自外部连接「Hermes」”通知已绑定主 Run。未绑定时保留 pending，绑定后递交。主 agent 不会立即回复：`returnImmediately:true` 返回 submitted task，调用方用 GetTask 查询；默认阻塞直到主 agent 回应。客户端断开不会删除任务。主 agent 的 connection-reply 将回复以唯一消息编号写入 history/artifact，并完成原任务；之后 Hermes 可读回。相同 messageId、相同内容返回同一任务，不重复记录/通知；同编号不同内容被拒绝。

```text
node coordinator/scripts/client.mjs connections
node coordinator/scripts/client.mjs connection-read "Hermes"
node coordinator/scripts/client.mjs connection-check "Hermes"
node coordinator/scripts/client.mjs connection-send < request.json
node coordinator/scripts/client.mjs connection-reply < reply.json
```

send/reply 的 JSON **从标准输入读取**，每次指定连接名字。已加载的旧命令 `butler-read/check/send/reply` 及其原输入格式继续指向这个 Hermes 连接。

send/reply 输入：

```json
{"name":"Hermes","runId":"已绑定主Run","requestId":"唯一消息编号","contextId":"同一事项稳定编号","text":"明确授权的日常请求"}
```

```json
{"name":"Hermes","runId":"已绑定主Run","id":"Hermes 来源的 task.id","requestId":"唯一回复编号","text":"已向用户转达后的答复"}
```

出站发送以 requestId 作为 messageId，同一事项传回同一个 contextId。命令先返回持久化记录，后台发送，返回任务未完成时查询原 remoteId；结果生成稳定的 `requestId:result` artifact，作为来源送回主 Run。Hermes 稳定版会阻塞 SendMessage，插件允许它的 300 秒回复窗口，并仍能独立递交入站提醒和确认，避免相互等待。

任务、回复和通知有独立状态。网络中断、发送后崩溃、通知结果未知时保留 uncertain/可见错误，禁止自动重发未知写入。已取得远端任务编号的只继续 GetTask。不要换 requestId 绕过保护。失败记录在“设置 → 外部连接 → Hermes → 最近往来”和 connection-read 中查看；错误保留 HTTP 状态、JSON-RPC 错误码和消息，或网络错误类型（如 TypeError / ECONNREFUSED、TimeoutError），不记录令牌、请求正文或错误响应的 data 字段，并对错误消息中原样回显的凭据和正文脱敏。重新打开设置可刷新状态。历史接近 190 KB 时拒绝新增、保留原记录，需要后续分页后再扩大容量。

## 资料边界、提醒与 skill

Hermes接口没有任何到 projects、read 或项目写入的路由。Hermes 只能查询它通过本接口创建的任务；主 agent → Hermes 也只发送主 agent 明确选择的日常文字，不自动带项目或工作间报告。来源不会写入项目 events。此边界是插件 API 与Hermes行为约束；同一 Windows 用户下的终端/电脑操作不是操作系统级目录隔离。

主 agent skill 源在 `workspace/skill/agentboat-workspace`，执行 `node workspace/install.mjs` 同步安装副本。Hermes skill 在 `workspace/skill/agentboat-butler`，配置脚本复制到 Hermes skills 并写入它的系统提示词。主 agent 通过原飞书事件回复或当前用户会话转达结果；不得替用户批准Hermes确认。

定时任务依赖运行中的 gateway，每次是新会话，必须指定Hermes skill、A2A 工具与稳定事项编号，主动用 a2a_call 联系 orca-main，避免投递到其他通道。参见 [Hermes 定时任务](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)、[记忆](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)、[skill](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)、[电脑操作](https://hermes-agent.nousresearch.com/docs/user-guide/features/computer-use)、[安全与审批](https://hermes-agent.nousresearch.com/docs/user-guide/security)。

## 验证和排查

构建前备份 plugins-data、旧 plugin，并用现有 release-evidence.mjs 取全部项目快照；原始输出放仓库外。运行 `npm run typecheck`、`node scripts/test-local.mjs`、`node scripts/check-local.mjs` 与工作间现有测试。Orca 自带 plugin test 的 Windows 加载器会误拒自己的运行时导入，仓库现有 test-local 入口使用同一套 Orca 测试库绕过此问题。

测试通过后才 `npm run build`，重新加载同一个开发插件目录，再用 release-evidence.mjs snapshot/compare 比对所有项目、目录和主绑定。项目正常并发写入时先核对变更来源、再取新快照比对；无法解释的丢失或差异立即回退旧插件并回报。清单只改面板标题与状态栏文字；不向真实项目写测试数据。

连接失败先 `hermes gateway status`，检查 Hermes home 下 logs/gateway.log 与 a2a_audit.jsonl、端口、令牌和 `.env` 的回环地址；不要把日志中的凭据转发到会话或 Git。

- “服务不可达”：检查 gateway 是否运行，以及外部连接的「对方的地址」。
- “令牌错误”（HTTP 401）：外部连接的「连接参数 → 对方的令牌」须与 Hermes 的 `A2A_BEARER_TOKEN` 一致，修改后保存。
- “对方不信任”（HTTP 403）：检查 Hermes `.env` 的 `A2A_TRUSTED_PEERS`。共享令牌的回环调用方身份是 **`ip:127.0.0.1`**，不能只写 `127.0.0.1`；修改后重启 gateway。这次故障就是身份不匹配，Hermes 返回 `JSON-RPC -32052: peer 'ip:127.0.0.1' not trusted`。公开的 Agent Card 可达仍不代表能通过此检查。
- 其他“连接失败”：按返回的 HTTP / JSON-RPC 详情检查 A2A 版本、接口及 gateway 日志。

订阅/额度问题需用户在 hermes model 核对。审批被拒应报告具体待确认动作，不能开启 skip/off 模式。
