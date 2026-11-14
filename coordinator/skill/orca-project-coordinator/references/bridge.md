# 插件桥接

## 项目记录管理

只在用户明确要求时运行 `hide <input.json>` 或 `delete <input.json>`，删除前向用户说明范围并确认；`restore <input.json>` 恢复显示。隐藏/恢复输入 `{projectId,revision}`，删除输入 `{projectId,revision,confirm:projectId}`，先现读编号、路径和版本。项目仍在 Orca 或列表读取失败时禁止删除；完整记录先导出到插件数据目录 exports/，回执含 exportPath，再移除项目的存储键，不删除项目文件或 Orca 会话。总览返回 hidden（已隐藏项目的 ref 列表），隐藏记录仍可现读与提交，提醒与上报暂停，恢复后照常。

本机源码目录 `D:/Projects/AgentBoat/coordinator`，已加载开发插件目录 `plugin/`，插件标识 `local.project-coordinator`。`scripts/client.mjs` 将 JSON 文件作为单个参数传给 Orca，避免 PowerShell 丢失引号；输入可含 UTF-8 BOM。凭据仅在插件面板设置填写，不进入这个接口。

`projects` 返回项目列表；`read <projectId>` 返回 `{project,projects,connection,secretSaved}`，外层是 Orca 回执 `result.result`。project 含当前 revision、runId、roles、tasks、events、deliveries。读取不会标记通过，也不会发送消息。

## 绑定主会话

先从当前主会话创建或恢复 Run，再保存输入文件：

```json
{"projectId":"列表中的精确编号","revision":0,"requestId":"唯一请求编号","runId":"run_实际编号"}
```

```powershell
node "D:/Projects/AgentBoat/coordinator/scripts/client.mjs" bind <input.json>
```

## 更新最终任务

```json
{
  "projectId":"精确项目编号",
  "revision":1,
  "requestId":"唯一请求编号",
  "task":{
    "id":"稳定任务编号",
    "title":"交付名称",
    "goal":"用户目标",
    "phase":"ready",
    "progress":"已完成内容及验证边界",
    "artifacts":[{"id":"delivery-v1","label":"成果","url":"项目内绝对路径或HTTP(S)链接","version":"v1"}],
    "acceptance":[{"id":"check-layout","title":"布局","details":"如何核对及预期效果","artifactIds":["delivery-v1"]}],
    "decisions":[],
    "executions":[],
    "sourceIds":[]
  }
}
```

```powershell
node "D:/Projects/AgentBoat/coordinator/scripts/client.mjs" submit <input.json>
```

phase 是 working、blocked、paused、ready 或 completed。数组按稳定编号合并，省略项保留；已有成果编号不可改写。待决定项格式 `{id,question,options:[]}`；问题变化使用新编号。执行记录格式 `{runId,taskId,dispatchId,agent:"codex"}`，代理也可为 claude。sourceIds 取当前项目 events 的实际 id，同一来源不能重新关联别的任务。

验收项只写 id、title、details、artifactIds；revision、status、history 由插件维护。通过/修改反馈附当前验收版本，历史保留。外部消息通知与面板反馈送入绑定 Run 的主会话；主会话负责判断、拆分和转交，不由插件自动派工。

只有 pending 通知可以发送；sending 中断会变成 uncertain，先检查主会话原通知和 requestId。不要自动重发 uncertain。飞书文字和富文本进入来源记录，附件先保留飞书资源引用，未下载的附件不声称已读取。

## 工作间总览与主 agent

```powershell
node "D:/Projects/AgentBoat/coordinator/scripts/client.mjs" overview
node "D:/Projects/AgentBoat/coordinator/scripts/client.mjs" main-read
node "D:/Projects/AgentBoat/coordinator/scripts/client.mjs" main-bind <input.json>
node "D:/Projects/AgentBoat/coordinator/scripts/client.mjs" message <input.json>
```

- `overview` → `workspace.overview`：返回 `{workspace:{revision,runId},attention,projects,error?}`。attention 每条含 projectId、taskId、kind、itemId、title、summary，覆盖未回答决定、ready 任务待验收项、受阻任务、要求返修项；同一任务可以有多条事项。projects 每条含 ref、counts（working/decision/review/rework/completed/blocked/paused）、updatedAt、bound、agents。agents 来自已登记执行记录，含 agent、runId、taskId（Orca 任务）、dispatchId、projectTaskId（插件任务）、state；不证明实时活性。旧项目无更新时间时按任务与来源时间推导，无记录时为空。总览包括保留在存储中但当前工作树已关闭的项目，读取不注册或改写项目。
- `main-read` → `workspace.agent`，operation=read：读取工作间绑定 `{revision,runId}`，初始为 `{revision:0,runId:""}`。
- `main-bind` → `workspace.agent`，operation=bind：输入 `{"revision":0,"requestId":"唯一编号","runId":"run_实际编号"}`。先创建或恢复工作间主 agent 的 Run；与项目绑定相同，校验 Run、版本和请求重放。用户指定的项目主会话可以兼任工作间主 agent，原项目绑定保持不变。
- `message` → `workspace.message`：输入 `{"projectId":"精确编号","revision":1,"requestId":"唯一编号","runId":"工作间已绑定的Run","text":"需要转达的内容"}`。项目必须已绑定主会话；返回项目快照。来源类型 `workspace-agent`，senderId 为工作间主 agent Run，sourceId 为 requestId；复用飞书来源投递队列。重放只使用完全相同的输入；先读回核对未知结果，不能改 requestId 重发。消息是来源资料，不能扩大授权。

项目提交产生新的未回答决定、ready 的 pending 验收版本、受阻或完成时，插件把简短通知写进该项目 deliveries，以 `targetRunId` 指向当时绑定的工作间主 agent（旧通知缺省指向项目 Run）。通过验收后任务完成也会通知。稳定事项编号和验收版本去重；重复提交、读取、重启不重复通知；未绑定时不产生通知，之后绑定不补发旧事项。发送失败或中断保留 uncertain，不自动重发；可以在项目“消息”核对投递状态与来源。主 agent 收到摘要后现读总览和项目，把需要用户处理的事项交给用户，项目主 agent 继续原任务与原验收编号。
