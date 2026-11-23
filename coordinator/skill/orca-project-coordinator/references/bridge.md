# client.mjs 命令

从 skill 标出的 AgentBoat 入口调用 `coordinator/scripts/client.mjs`。写命令的 JSON 放进文件（UTF-8，可带 BOM），文件路径作参数。标 stdin 的从标准输入读。回执在 `result.result`。提交任务、本机反馈、项目消息、绑定和显隐操作返回最新 revision 和精简的 project（ref、revision、runId）。`submit` 核对成功还会在开头返回 submission，直接保留原始输出供 Stop hook 识别。

## 备用接管

项目主会话额度不足时，由已配置的备用按主人授权接管，沿用原有权限。只有一家可用 agent 时，告诉主人。工作间通过同一 bot 的代理切换接回原 Run，升级前已经发出接管凭据的工作间 Run 可完成下面的旧交接流程。
备用平时待命。收到接管通知，先读插件记录，再在自己的会话执行通知中的 `lead-take`，接续原 Run 的收件箱和执行者。
主用能继续工作时，执行通知中的 `lead-ready`。接管前的探测在 10 分钟内确认。备用已接管时，主用确认恢复后，备用用 `lead-handoff` 写明已做和剩余事项，主用用 `lead-resume` 接回。

## 通用

- 写入要带读到的 revision 和唯一 requestId。
- 回执不明（uncertain、超时、「未取得回执」）时先读回核对；重放只用同一个 requestId 和完全相同的输入。版本冲突先重读。

## 读

- `projects`：项目列表，不含工作间主 agent 自己所在的目录。
- `overview`：读取绑定、待处理、项目和连接全量。attention 是待决定、待验收、受阻、返修；questions 是仍在执行的 Orca 执行者在最近 24 小时发出、超过 10 分钟未回复的问题。执行记录不代表 agent 在线。
- `overview --brief`：日常核对待办，返回 `{attention,questions,reports,projects:[{id,name,counts,revision,bound}]}`。questions 和 reports 是供管理员核对的项目 Run 邮件，插件先提醒项目主会话，再按超时情况提醒工作间主 agent。全量总览另有项目目录、执行记录数（agents）和连接设置。
- `read <projectId>` 返回项目摘要。project 含 ref（编号、名称、路径）、revision、runId、roles、每项任务的状态和待验收／待决定编号，以及未关联消息的前 120 个字符。lead 给出主备绑定，history 取最近 3 条，historyTotal 是保留的总条数。加 `--full` 读取完整项目，接管历史仍取最近 3 条，省略归档游标。
- `read <projectId> --task <taskId>` 返回 `{projectId,revision,task}`，保留完整反馈历史、未丢弃验收项引用的成果，以及最近更新的 3 个不同名称成果的最新版本和最近 3 条执行记录。omittedArtifacts 和 omittedExecutions 分别是省略条数。加 `--full` 返回完整任务。归档任务另带 `archiveStatus: "已归档"`，再次 submit 同一编号会恢复并合并原任务。任务不存在时返回错误。
- `lead-history [projectId] [--end <previousEnd>]`：按角色查接管记录，省略项目编号查工作间；用返回的 previousEnd 翻到更早一批。
- `project-lead <projectId>`：项目的主会话（`binding`）、主备启动偏好（`leadAgents`）、待接管状态和在线目标会话。
- `main-read`：工作间主 agent 的绑定；`main-targets`：可接管的在线会话。
- `connections`、`connection-read <名字>`、`connection-check <名字>`（只做无害查询）。

## 项目主 agent

- `bind`：`{projectId,revision,requestId,runId}`，用于首次绑定或确认同一个 Run。更换已绑定 Run 使用 `project-lead-bind`。
- `project-lead-bind`（stdin）：`{projectId,revision,requestId,runId,token}`，接到接管请求的会话用。先创建自己的协调 Run，用 `read <projectId>` 取当前 revision，再绑定。凭据 10 分钟后失效。绑定后读取项目任务、执行记录和待处理项。
- `bind`、`submit`、`feedback`、`hide`、`restore`、`delete` 会自动带上当前 Orca 会话；没给 runId 时取当前会话的 Run。Run 与项目绑定一致时，插件记下这个会话，用来显示 agent 类型和打开主会话所在的工作区，没有记录时显示「未知」。它只用于显示和导航，不是授权依据。

`submit`：

```json
{"projectId":"…","revision":1,"requestId":"唯一编号","task":{"id":"稳定编号","title":"…","goal":"…","phase":"ready","progress":"已完成内容和验证边界",
 "artifacts":[{"id":"delivery-v1","label":"成果","url":"项目内绝对路径或 HTTP(S) 链接","version":"v1"}],
 "acceptance":[{"id":"check-layout","title":"…","details":"怎么核对、预期效果","artifactIds":["delivery-v1"]}],
 "decisions":[{"id":"…","question":"…","options":["…"]}],
 "executions":[{"runId":"…","taskId":"…","dispatchId":"…","agent":"codex"}],"sourceIds":[]}}
```

- 新建任务必填 id、title、goal、phase。更新同一 id 时，省略 title 或 goal 会保留原值。phase 取 working、blocked、paused、ready、completed。
- 数组按 id 合并，省略的保留。任务、验收和来源的编号保持不变。成果名称写清这是什么，新版本沿用名称、使用新 id，版本号写在 version。用原 id、url 和 version 可更正名称。问题变了用新的决定 id。登记执行者成果时，在对应任务的 executions 保留 Orca Run、任务和派工编号。
- 验收的 revision、status、history 由插件维护；核对内容或关联成果变了，自动出新版本。
- 在 acceptance 或 decisions 中用 `{"id":"旧项编号","discarded":true,"reason":"已由新版取代"}` 撤下待验收、需要修改的验收项或待决定项。沿用同一验收编号提交有变化的核对内容或成果，会开启新一版并保留旧版历史。
- 在 artifacts 中用 `{"id":"成果编号","expired":true,"reason":"已失效"}` 标为过期，原因选填。先撤下或处理引用它的待验收项，可在同一次提交里撤下。过期成果仅在任务详情和完整读取中保留。
- sourceIds 用本项目 events 的 id，一个来源只关联一个任务。
- 一次 submit 带出多条新事项时，插件只给工作间主 agent 发一条汇总通知。未绑定时不发，之后绑定也不补发。

## 代录用户结论

先用 `read <projectId> --task <taskId>` 确认任务和验收的当前版本，再用 `feedback` 代录。

```json
{"projectId":"…","revision":3,"requestId":"唯一编号","items":[
 {"taskId":"…","kind":"decision","itemId":"…","answer":"明确答案","note":"用户原话、会话或消息编号、日期"},
 {"taskId":"…","kind":"acceptance","itemId":"…","itemRevision":1,"result":"passed","note":"…"}]}
```

- 整批先校验。任务不在等验收、版本不符、已处理或重复的条目，只要有一条，整批拒绝并标出序号。
- 验收用 `passed` 或 `changes_requested`，需要修改时必须写意见。丢弃验收或决定用 `"result":"discarded"`，原因选填在 `note`，决定省略 `answer`。
- 答复受阻项用 `{"taskId":"任务编号","kind":"blocked","itemId":"任务编号","itemRevision":1,"note":"主人原话"}`。itemRevision 取任务的 blockedRevision，旧记录省略该字段时取 0。可以继续补充；丢弃时加 `"result":"discarded"`，原因选填在 `note`。项目主会话重新提交任务后，按新状态和版本处理。
- requestId 可省略。带上时，原样重放不会重复写入。
- 代处理已开放的对方项目，在顶层加连接编号 `id`，并提供对方的 projectId、revision 和唯一 requestId。成功回执含逐项状态，对方的最新 revision 从同步后的项目报告读取。离线或回执未确认时保留原请求编号核对。
- 只给项目主 agent 发一条消息，后续由它跟进。

## 工作间主 agent

- `main-bind [--check]`（stdin）：`{revision,requestId,runId,token}`，首次绑定可省 token。`--check` 只核实、不生效；通过后重读 `main-read`，用最新 revision 和新的 requestId 正式绑定。绑定成功后，脚本在当前会话目录更新 `CLAUDE.md` 和 `AGENTS.md` 的角色卡。回执有 `roleCardWarning` 时绑定已生效，解决文件问题后用原请求重试。
- `message`：`{projectId,revision?,requestId,runId,text}`，runId 必须是已绑定的工作间主 agent Run。消息成为项目的 workspace-agent 来源。项目还没有主会话时，回执显示「项目还没有主会话，已排队」，脚本尝试自动开主会话，绑定后由插件投递；`autoLaunch` 给出状态、会话 handle 和启动参数，或没开成的原因。已排队的消息重试时保留原 requestId。
- `project-lead-switch`（stdin）：`{projectId,revision,mode,handle?,agent?}`，revision 取 `project-lead` 回执的 `binding.revision`。已有会话用 `mode:"existing"` 和该项目在线列表里的 handle。新开用 `mode:"new"`，省略 agent 时使用 `leadAgents.primary`，也可从 `availableAgents` 选择本次启动的代理。取消用 `mode:"cancel"`。
- `hide`、`restore`：`{projectId,revision}`。
- `delete`：`{projectId,revision,confirm:projectId}`。插件先导出记录（回执里有 exportPath）；有打开的终端或会话就拒绝。只从 Orca 移除登记，磁盘文件和 Git 保留。
- `connection-send`（stdin）：`{name,runId,requestId,contextId?,text}`。同一事项沿用 contextId。
- `connection-reply`（stdin）：`{name,runId,id,requestId,text}`，id 是对方发来的 task.id。
- `feishu-reply`：`{runId,eventId,requestId,text}`，回到原消息所在的会话。
- `links-*`（工作间连接和主 agent 互发消息）：见入口目录下的 `coordinator/LINKS.md`。
