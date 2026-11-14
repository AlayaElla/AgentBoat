# 插件桥接

本机源码目录 `D:/Projects/test2/project-coordinator`，已加载开发插件目录 `plugin/`，插件标识 `local.project-coordinator`。`scripts/client.mjs` 将 JSON 文件作为单个参数传给 Orca，避免 PowerShell 丢失引号；输入可含 UTF-8 BOM。凭据仅在插件面板设置填写，不进入这个接口。

`projects` 返回项目列表；`read <projectId>` 返回 `{project,projects,connection,secretSaved}`，外层是 Orca 回执 `result.result`。project 含当前 revision、runId、roles、tasks、events、deliveries。读取不会标记通过，也不会发送消息。

## 绑定主会话

先从当前主会话创建或恢复 Run，再保存输入文件：

```json
{"projectId":"列表中的精确编号","revision":0,"requestId":"唯一请求编号","runId":"run_实际编号"}
```

```powershell
node "D:/Projects/test2/project-coordinator/scripts/client.mjs" bind <input.json>
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
node "D:/Projects/test2/project-coordinator/scripts/client.mjs" submit <input.json>
```

phase 是 working、blocked、paused、ready 或 completed。数组按稳定编号合并，省略项保留；已有成果编号不可改写。待决定项格式 `{id,question,options:[]}`；问题变化使用新编号。执行记录格式 `{runId,taskId,dispatchId,agent:"codex"}`，代理也可为 claude。sourceIds 取当前项目 events 的实际 id，同一来源不能重新关联别的任务。

验收项只写 id、title、details、artifactIds；revision、status、history 由插件维护。通过/修改反馈附当前验收版本，历史保留。外部消息通知与面板反馈送入绑定 Run 的主会话；主会话负责判断、拆分和转交，不由插件自动派工。

只有 pending 通知可以发送；sending 中断会变成 uncertain，先检查主会话原通知和 requestId。不要自动重发 uncertain。飞书文字和富文本进入来源记录，附件先保留飞书资源引用，未下载的附件不声称已读取。
