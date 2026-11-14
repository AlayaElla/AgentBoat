# client.mjs 命令

`node D:/Projects/AgentBoat/coordinator/scripts/client.mjs <命令>`。写命令的 JSON 放进文件（UTF-8，可带 BOM），文件路径作参数；标 stdin 的从标准输入读，这类输入不落文件。回执在 `result.result`。

## 读

- `projects`：项目列表。
- `overview`：`{workspace,attention,projects,hidden,links,connections,machines}`。attention 是待决定、待验收、受阻、返修；执行记录不代表 agent 在线。
- `read <projectId>`：`{project}`，含 revision、runId、roles、tasks、events、deliveries。
- `main-read`：主 agent 绑定；`main-targets`：可接管的在线会话。
- `connections`、`connection-read <名字>`、`connection-check <名字>`（只做无害查询）、`feishu-read`。

## 项目主 agent

`bind`：`{projectId,revision,requestId,runId}`。

`submit`：

```json
{"projectId":"…","revision":1,"requestId":"唯一编号","task":{"id":"稳定编号","title":"…","goal":"…","phase":"ready","progress":"已完成内容和验证边界",
 "artifacts":[{"id":"delivery-v1","label":"成果","url":"项目内绝对路径或 HTTP(S) 链接","version":"v1"}],
 "acceptance":[{"id":"check-layout","title":"…","details":"怎么核对、预期效果","artifactIds":["delivery-v1"]}],
 "decisions":[{"id":"…","question":"…","options":["…"]}],
 "executions":[{"runId":"…","taskId":"…","dispatchId":"…","agent":"codex"}],"sourceIds":[]}}
```

- phase：working、blocked、paused、ready、completed。
- 数组按 id 合并，省略的保留。成果 id 不能改写；问题变了用新的决定 id。
- 验收的 revision、status、history 由插件维护；核对内容或关联成果变了，自动出新版本。
- sourceIds 用本项目 events 的 id，一个来源只关联一个任务。

## 代录用户结论

`feedback`：

```json
{"projectId":"…","revision":3,"items":[
 {"taskId":"…","kind":"decision","itemId":"…","answer":"明确答案","note":"用户原话、会话或消息编号、日期"},
 {"taskId":"…","kind":"acceptance","itemId":"…","itemRevision":1,"result":"passed","note":"…"}]}
```

- 同一项目的结论收齐后一次提交。
- 整批先校验。任务不在等验收、版本不符、已处理或重复的条目，只要有一条，整批拒绝并标出序号。
- `changes_requested` 必须写修改意见。
- 只给项目主 agent 发一条消息。

## 工作间主 agent

- `main-bind [--check]`（stdin）：`{revision,requestId,runId,token}`，首次绑定可省 token。`--check` 只核实、不生效。
- `message`：`{projectId,revision,requestId,runId,text}`，成为项目的 workspace-agent 来源。
- `hide`、`restore`：`{projectId,revision}`。
- `delete`：`{projectId,revision,confirm:projectId}`。插件先导出记录（回执里有 exportPath）；有打开的终端或会话就拒绝。只从 Orca 移除登记，磁盘文件和 Git 保留。
- `connection-send`（stdin）：`{name,runId,requestId,contextId?,text}`。同一事项沿用 contextId。
- `connection-reply`（stdin）：`{name,runId,id,requestId,text}`，id 是对方发来的 task.id。
- `feishu-reply`：`{runId,eventId,requestId,text}`，回到原消息所在的会话。
- 工作间互联 `links-*` 和跨工作间请求 `requests-*` 的输入见 `D:/Projects/AgentBoat/coordinator/LINKS.md`。

## 通用

- 写入要带读到的 revision 和唯一 requestId。
- 回执不明（uncertain、超时、「未取得回执」）时先读回核对；重放只用同一个 requestId 和完全相同的输入。版本冲突先重读。
- 一次 submit 带出多条新事项时，插件只给工作间主 agent 发一条汇总通知。未绑定时不发，之后绑定也不补发。
