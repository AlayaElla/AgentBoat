# 日常管家（Hermes）

工作间只有一个主 agent。Hermes 是独立的日常服务，接日程提醒、资料整理、写作和日常电脑操作；所有给用户的结果、问题和确认都经主 agent 转达。飞书仍只接主 agent。

## 安装、登录和启动

在已通过测试并重新加载插件后，在本机 Orca PowerShell 运行：

```powershell
./workspace/install-hermes.ps1
```

脚本使用 [Hermes 官方安装器](https://hermes-agent.nousresearch.com/docs/getting-started/installation)的非交互安装模式。已完成官方安装时可加 `-ConfigureOnly`。Windows 数据和 CLI 位于 `%LOCALAPPDATA%\hermes` 与其 `bin` 子目录；自定义 home 使用 `HERMES_HOME`。不安装桌面应用，不操作真实桌面。

配置脚本备份原配置、生成两个不同的随机令牌、保存插件密钥、配置回环 A2A、安装管家 skill，并注册登录自启。运行前确认 9900/9901 没被其他服务占用。安装会拒绝接管已有其他 Hermes 对端或已启用的用户通道；配置失败先核对回执和备份，不盲目重装或删除数据。

Hermes 当前 Windows 服务安装器可能主动提出 UAC。脚本设置非交互模式并使用默认的拒绝答案，走官方 Startup 登录项替代路径，不触发管理员授权弹窗；它仍会在用户登录时启动。安装阶段不立即启动 gateway，以便停在用户订阅登录步骤。

**订阅登录必须由用户自己完成：**

1. 打开一个新的本机 PowerShell，运行 `hermes model`。若 PATH 尚未更新，运行 `& "$env:LOCALAPPDATA\hermes\bin\hermes.exe" model`。
2. 选择 **ChatGPT or Codex Subscription**。按终端显示的验证网址和设备码，在自己的浏览器登录 ChatGPT 并确认授权。不要把设备码、登录文件或凭据交给 agent。
3. 返回终端，等待登录成功，按提示选可用的 Codex 模型。订阅额度和开发用 Codex 共用。
4. 运行 `hermes gateway start` 和 `hermes gateway status`，然后在 Orca 总览打开“管家设置 → 检查连接”。连接检查只证明 A2A Agent Card 可达，不证明模型调用成功。
5. 告知主会话“登录完成”，再安排真实模型、定时提醒和双向通信验收。登录前不得把模拟结果当成真实端到端结果。

登录流程见 [Hermes 模型文档](https://hermes-agent.nousresearch.com/docs/integrations/providers)。

## 设置

总览“管家 → 管家设置”提供启用开关、Hermes A2A 地址、Hermes 令牌、主 agent 端口及主 agent 令牌；空令牌保留原密钥。两个方向都需要至少 32 字符的令牌。监听始终绑定 `127.0.0.1`，界面不提供扩大监听范围的选项；出站只允许回环 HTTP 根地址，拒绝路径、重定向和 URL 凭据。

自动配置默认：Hermes `http://127.0.0.1:9900`，插件 `http://127.0.0.1:9901`，避开 API 8642 和 webhook 8644。改端口或令牌时须同时更新 Hermes `.env` 中的 A2A 配置和 `config.yaml` 的 `a2a_agents.orca-main`，再重启 gateway。

插件令牌只在 Orca secrets 存储，不写普通插件记录。Hermes 的对端令牌与入站令牌留在它自己的 `config.yaml` / `.env`；这些文件及备份必须留在本机，不进入 Git。管家使用独立的 daily 目录、Hermes 记忆、管家 skill 和系统提示词，外部 skill 目录为空。审批为 manual，定时/单次/无人值守危险操作为 deny。需要确认时交给主 agent，不能自行放宽审批。

组织画布“工作间内部”有“管家 · Hermes”节点，连接主 agent。点击后显示状态并可打开总览。

## A2A 接口和命令

依据 [A2A v1.0](https://a2a-protocol.org/latest/specification/) 与 [Hermes A2A 文档](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/a2a)。

| 入口 | 行为 |
|---|---|
| `GET /.well-known/agent-card.json` | 提供主 agent 的卡片，仅声明文字、JSONRPC 1.0；无项目内容 |
| `POST /`，`SendMessage` | 接收 `ROLE_USER`、`messageId`、文字 parts、可选 contextId，返回 `{task}` |
| `POST /`，`GetTask` | 按任务 id 查询状态和回复，可用 historyLength 限定历史 |
| 其他路径/方法 | 404 / JSON-RPC method not found；无项目读取接口 |

卡片、消息和任务查询都要求 `Authorization: Bearer …`。拒绝浏览器 Origin、错误令牌、非文字附件、过大请求。无 CORS、流式接口或推送回调；不宣称支持这些能力。

入站任务先持久化在独立的 `workspace.butler`，带来源消息编号和 contextId，作为“来自管家”通知已绑定主 Run。未绑定时保留 pending，绑定后递交。主 agent 不会立即回复：`returnImmediately:true` 返回 submitted task，调用方用 GetTask 查询；默认阻塞直到主 agent 回应。客户端断开不会删除任务。主 agent 的 butler-reply 将回复以唯一消息编号写入 history/artifact，并完成原任务；之后 Hermes 可读回。相同 messageId、相同内容返回同一任务，不重复记录/通知；同编号不同内容被拒绝。

```text
node coordinator/scripts/client.mjs butler-read
node coordinator/scripts/client.mjs butler-check
node coordinator/scripts/client.mjs butler-send < request.json
node coordinator/scripts/client.mjs butler-reply < reply.json
```

send/reply 的 JSON **从标准输入读取**：

```json
{"runId":"已绑定主Run","requestId":"唯一消息编号","contextId":"同一事项稳定编号","text":"明确授权的日常请求"}
```

```json
{"runId":"已绑定主Run","id":"管家来源的task.id","requestId":"唯一回复编号","text":"已向用户转达后的答复"}
```

出站发送以 requestId 作为 messageId，同一事项传回同一个 contextId。命令先返回持久化记录，后台发送，返回任务未完成时查询原 remoteId；结果生成稳定的 `requestId:result` artifact，作为来源送回主 Run。Hermes 稳定版会阻塞 SendMessage，插件允许它的 300 秒回复窗口，并仍能独立递交入站提醒和确认，避免相互等待。

任务、回复和通知有独立状态。网络中断、发送后崩溃、通知结果未知时保留 uncertain/可见错误，禁止自动重发未知写入。已取得远端任务编号的只继续 GetTask。不要换 requestId 绕过保护。失败记录在“管家设置 → 消息记录”和 butler-read 中查看；重新打开设置可刷新状态。历史接近 190 KB 时拒绝新增、保留原记录，需要后续分页后再扩大容量。

## 资料边界、提醒与 skill

管家接口没有任何到 projects、read 或项目写入的路由。Hermes 只能查询它通过本接口创建的任务；主 agent → Hermes 也只发送主 agent 明确选择的日常文字，不自动带项目或工作间报告。来源不会写入项目 events。此边界是插件 API 与管家行为约束；同一 Windows 用户下的终端/电脑操作不是操作系统级目录隔离。

主 agent skill 源在 `workspace/skill/agentboat-workspace`，执行 `node workspace/install.mjs` 同步安装副本。管家 skill 在 `workspace/skill/agentboat-butler`，配置脚本复制到 Hermes skills 并写入它的系统提示词。主 agent 通过原飞书事件回复或当前用户会话转达结果；不得替用户批准管家确认。

定时任务依赖运行中的 gateway，每次是新会话，必须指定管家 skill、A2A 工具与稳定事项编号，主动用 a2a_call 联系 orca-main，避免投递到其他通道。参见 [Hermes 定时任务](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)、[记忆](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)、[skill](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)、[电脑操作](https://hermes-agent.nousresearch.com/docs/user-guide/features/computer-use)、[安全与审批](https://hermes-agent.nousresearch.com/docs/user-guide/security)。

## 验证和排查

构建前备份 plugins-data、旧 plugin，并用现有 release-evidence.mjs 取全部项目快照；原始输出放仓库外。运行 `npm run typecheck`、`node scripts/test-local.mjs`、`node scripts/check-local.mjs` 与工作间现有测试。Orca 自带 plugin test 的 Windows 加载器会误拒自己的运行时导入，仓库现有 test-local 入口使用同一套 Orca 测试库绕过此问题。

测试通过后才 `npm run build`，重新加载同一个开发插件目录，再用 release-evidence.mjs snapshot/compare 比对所有项目、目录和主绑定。项目正常并发写入时先核对变更来源、再取新快照比对；无法解释的丢失或差异立即回退旧插件并回报。不要修改插件清单或向真实项目写测试数据。

连接失败先 `hermes gateway status`，检查 Hermes home 下 logs/gateway.log 与 a2a_audit.jsonl、端口、令牌和 `.env` 的回环地址；不要把日志中的凭据转发到会话或 Git。`A2A_TRUSTED_PEERS` 要与实际认证身份一致。订阅/额度问题需用户在 hermes model 核对。审批被拒应报告具体待确认动作，不能开启 skip/off 模式。
