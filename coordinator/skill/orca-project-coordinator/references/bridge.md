# client.mjs 命令

`node "{{AGENTBOAT_REPO}}/coordinator/scripts/client.mjs" <命令>`（安装器按本机仓库位置填写；仓库移动后重新安装）。写命令的 JSON 放进文件（UTF-8，可带 BOM），文件路径作参数；标 stdin 的从标准输入读，这类输入不落文件。回执在 `result.result`。

## 通用

- 写入要带读到的 revision 和唯一 requestId。
- 回执不明（uncertain、超时、「未取得回执」）时先读回核对；重放只用同一个 requestId 和完全相同的输入。版本冲突先重读。

## 读

- `projects`：项目列表，不含工作间主 agent 自己所在的目录。
- `overview`：`{workspace,attention,projects,hidden,links,connections,machines}`。attention 是待决定、待验收、受阻、返修；执行记录不代表 agent 在线。
- `read <projectId>`：`{project,lead}`，project 含 revision、runId、roles、tasks、events、deliveries。
- `project-lead <projectId>`：项目的主会话（`binding`）、待接管状态和在线目标会话。
- `main-read`：工作间主 agent 的绑定；`main-targets`：可接管的在线会话。
- `connections`、`connection-read <名字>`、`connection-check <名字>`（只做无害查询）。

## 项目主 agent

- `bind`：`{projectId,revision,requestId,runId}`。
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

- phase：working、blocked、paused、ready、completed。
- 数组按 id 合并，省略的保留。任务、验收和来源的编号保持不变。成果 id 不能改写，每个新的成果版本用新 id；问题变了用新的决定 id。
- 验收的 revision、status、history 由插件维护；核对内容或关联成果变了，自动出新版本。
- sourceIds 用本项目 events 的 id，一个来源只关联一个任务。
- 一次 submit 带出多条新事项时，插件只给工作间主 agent 发一条汇总通知。未绑定时不发，之后绑定也不补发。

## 代录用户结论

先 `read`，确认任务和验收的当前版本。`feedback`：

```json
{"projectId":"…","revision":3,"requestId":"唯一编号","items":[
 {"taskId":"…","kind":"decision","itemId":"…","answer":"明确答案","note":"用户原话、会话或消息编号、日期"},
 {"taskId":"…","kind":"acceptance","itemId":"…","itemRevision":1,"result":"passed","note":"…"}]}
```

- 整批先校验。任务不在等验收、版本不符、已处理或重复的条目，只要有一条，整批拒绝并标出序号。
- result 是 `passed` 或 `changes_requested`；`changes_requested` 必须写修改意见。
- requestId 可省略。带上时，原样重放不会重复写入。
- 只给项目主 agent 发一条消息，后续由它跟进。

## 工作间主 agent

- `main-bind [--check]`（stdin）：`{revision,requestId,runId,token}`，首次绑定可省 token。`--check` 只核实、不生效；通过后重读 `main-read`，用最新 revision 和新的 requestId 正式绑定。绑定成功后，脚本在当前会话目录更新 `CLAUDE.md` 和 `AGENTS.md` 的角色卡。回执有 `roleCardWarning` 时绑定已生效，解决文件问题后用原请求重试。
- `message`：`{projectId,revision?,requestId,runId,text}`，runId 必须是已绑定的工作间主 agent Run。消息成为项目的 workspace-agent 来源。项目还没有主会话时，回执显示「项目还没有主会话，已排队」，脚本尝试自动开主会话，绑定后由插件投递；`autoLaunch` 给出状态、会话 handle 和启动参数，或没开成的原因。已排队的消息重试时保留原 requestId。
- `project-lead-switch`（stdin）：`{projectId,revision,mode,handle?,agent?}`，revision 取 `project-lead` 回执的 `binding.revision`。已有会话用 `mode:"existing"` 和该项目在线列表里的 handle。新开用 `mode:"new"`，省略 agent 时用代码项目模板的默认设置，也可选 codex 或 opencode。取消用 `mode:"cancel"`。
- `hide`、`restore`：`{projectId,revision}`。
- `delete`：`{projectId,revision,confirm:projectId}`。插件先导出记录（回执里有 exportPath）；有打开的终端或会话就拒绝。只从 Orca 移除登记，磁盘文件和 Git 保留。
- `connection-send`（stdin）：`{name,runId,requestId,contextId?,text}`。同一事项沿用 contextId。
- `connection-reply`（stdin）：`{name,runId,id,requestId,text}`，id 是对方发来的 task.id。
- `feishu-reply`：`{runId,eventId,requestId,text}`，回到原消息所在的会话。
- `links-*`（工作间连接和主 agent 互发消息）：见 `{{AGENTBOAT_REPO}}/coordinator/LINKS.md`。
