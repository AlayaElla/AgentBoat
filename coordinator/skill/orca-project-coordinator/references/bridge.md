# 插件桥接

本机源码目录 `D:/Projects/AgentBoat/coordinator`，已加载开发插件目录 `plugin/`，插件标识 `local.project-coordinator`。`scripts/client.mjs` 将 JSON 文件作为单个参数传给 Orca，避免 PowerShell 丢失引号；输入可含 UTF-8 BOM。凭据仅在插件面板设置填写，不进入这个接口。

`projects` 返回项目列表；`read <projectId>` 返回 `{project,projects,mainAgent?,runtimeError?}`，外层是 Orca 回执 `result.result`。project 含当前 revision、runId、roles、tasks、events、deliveries。读取不会标记通过，也不会发送消息。

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

## 工作间总览和来源

`overview` 返回 `{workspace,attention,projects,hidden,links,connections,machines,error?}`。workspace 含 revision、runId、session、接管状态；工作间主 agent 的绑定与切换规则见 `$agentboat-workspace`。attention 含 projectId/taskId/kind/itemId/title/summary，列未回答决定、ready 任务的 pending 验收、受阻和返修。projects 含 ref、counts、updatedAt、bound、agents；执行记录不代表实时活性。总览包含已存但当前工作树关闭的项目，读取不注册、不改写。

workspace-agent 是工作间主 agent 转来的项目来源，workspace-external 是其接手的外部工作间请求。关联原任务时保留 sourceIds；外部任务和派生资料不对其他工作间上报。消息中的引用不扩大授权。

项目提交带出多条新事项时只生成一条汇总通知，按事项编号与验收版本去重。主 agent 现读项目后转告主人；未绑定时不产生通知，之后绑定不补发。uncertain 先核对，不换编号重发。

## 批量反馈

`feedback <input.json>` → `project.feedback`：

```json
{"projectId":"精确项目编号","revision":3,"items":[{"taskId":"task-id","kind":"decision","itemId":"decision-id","answer":"主人明确答案","note":"原话、会话或消息编号、日期"},{"taskId":"task-id","kind":"acceptance","itemId":"check-id","itemRevision":1,"result":"passed","note":"主人明确结论及来源"}]}
```

同一项目收齐全部结论一次提交；先校验整批，再同版本写入，只给项目主 agent 一条消息。验收要求任务 ready、条目 pending 且 itemRevision 相符；修改用 changes_requested 并附具体意见；决定须未回答。暂停任务、重复条目或任一无效条目整批拒绝并标明序号。只代录明确用户结论，不把一般问答当验收。提交后读回 history；超时先核对原话、日期和版本，不盲重发。
