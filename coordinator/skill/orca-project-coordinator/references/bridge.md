# client.mjs 命令

`node "{{AGENTBOAT_REPO}}/coordinator/scripts/client.mjs" <命令>`（安装器按本机仓库位置填写；仓库移动后重新安装）。写命令的 JSON 放进文件（UTF-8，可带 BOM），文件路径作参数；标 stdin 的从标准输入读，这类输入不落文件。回执在 `result.result`。

## 读

- `projects`：项目列表。
- `overview`：`{workspace,attention,projects,hidden,links,connections,machines}`。attention 是待决定、待验收、受阻、返修；执行记录不代表 agent 在线。
- `read <projectId>`：`{project}`，含 revision、runId、roles、tasks、events、deliveries。
- `project-lead <projectId>` 读取项目的主会话、待接管状态和在线目标会话。
- `main-read`：主 agent 绑定；`main-targets`：可接管的在线会话。
- `connections`、`connection-read <名字>`、`connection-check <名字>`（只做无害查询）、`feishu-read`。

## 项目主 agent

`bind`：`{projectId,revision,requestId,runId}`。

项目写命令自动从当前 Orca 环境附带 caller；未给 runId 时尝试读取当前会话的 Run。Run 与项目绑定一致时，插件记住此调用会话，用于显示 agent 类型和打开主会话所在工作区；已有项目在下一次写入时自动补齐。普通项目写入的 caller 用于显示和导航，没有记录时显示「未知」。

- 主人要求切换、新开或取消时，已绑定的工作间主 agent 先读 `project-lead <projectId>`，再用 `project-lead-switch`（stdin）传 `{projectId,revision,mode,handle?,agent?}`。revision 取 `binding.revision`。已有会话用 `mode:"existing"` 和该项目在线列表里的 handle。新开用 `mode:"new"`，省略 agent 时用代码项目模板默认设置，也可选 codex 或 opencode。取消用 `mode:"cancel"`。
- 接到项目接管请求的目标会话先创建自己的协调 Run，再用 `read <projectId>` 取当前 revision，由本会话用 `project-lead-bind`（stdin）传 `{projectId,revision,requestId,runId,token}`。凭据只用于本次接管，10 分钟后失效。绑定后读取项目任务、执行记录和待处理项。
- 收到项目主会话已切换的通知后，停止承担该项目主会话，把进行中的情况交给新主会话。

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
- `message`：`{projectId,revision?,requestId,runId,text}`，成为项目的 workspace-agent 来源，runId 必须是已绑定的工作间主 agent Run。尚未绑定项目主会话时，回执显示「项目还没有主会话，已排队」，绑定后由插件投递。脚本在已绑定的工作间主 agent 会话内尝试自动开会话，`autoLaunch` 显示状态、会话 handle 和启动参数或具体原因。回执已排队时保留原 requestId。
- `hide`、`restore`：`{projectId,revision}`。
- `delete`：`{projectId,revision,confirm:projectId}`。插件先导出记录（回执里有 exportPath）；有打开的终端或会话就拒绝。只从 Orca 移除登记，磁盘文件和 Git 保留。
- `connection-send`（stdin）：`{name,runId,requestId,contextId?,text}`。同一事项沿用 contextId。
- `connection-reply`（stdin）：`{name,runId,id,requestId,text}`，id 是对方发来的 task.id。
- `feishu-reply`：`{runId,eventId,requestId,text}`，回到原消息所在的会话。
- 工作间互联 `links-*` 的输入见 `{{AGENTBOAT_REPO}}/coordinator/LINKS.md`。
- `links-send`（stdin）接受 `{id,runId,requestId,text?,files?}`。id 用 `links-read` 里的本机连接编号，runId 必须等于本工作间已绑定的主 agent Run。files 是本机绝对路径数组，带附件时可省略文字。重试沿用同一编号、正文和附件。
- `links-share`（stdin）：`{revision,id,scope,allProjects?,projectIds?}`。`allProjects: true` 开放当前及以后新增的未隐藏项目。省略 `allProjects` 按 false 处理，省略 `projectIds` 保留逐项选择。
- `links-rename`（stdin）：`{revision,name}`。名称在下一次工作间同步时传给对方，监听继续运行。
- `links-relate`（stdin）：`{revision,id,relation}`，relation 为 `above`、`below`、`peer` 或 `null`。只在主人明确要求时修改本机关系；不发送给对方，也不改变开放范围。

## 通用

- 写入要带读到的 revision 和唯一 requestId。
- 回执不明（uncertain、超时、「未取得回执」）时先读回核对；重放只用同一个 requestId 和完全相同的输入。版本冲突先重读。
- 一次 submit 带出多条新事项时，插件只给工作间主 agent 发一条汇总通知。未绑定时不发，之后绑定也不补发。
