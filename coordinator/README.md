# 工作间

Orca 右侧“工作间”首页展示“等你处理”和各项目进展。待决定、受阻、外部请求、待验收按顺序排列，同一任务的验收合并成一行，默认五条，可展开与按项目筛选。退回修改的成果在任务列表显示“修改中”。项目按机器名分组，没有任务的项目默认折叠。

所有页面共用“项目下拉、刷新、设置”顶栏。下拉首项回工作间首页；选择项目进入其“待处理 / 任务 / 消息”。点待办或任务行看全文、成果、决定和验收历史；首页只提供入口，验收在详情里完成。任务页显示最后执行 agent，编号仍可通过命令读取。

顶栏“设置”集中提供主 agent、外部连接、其他工作间、机器、组织画布与隐藏项目恢复。主 agent 页显示会话、类型、目录、兼任项目；Run 和会话编号在“技术信息”。“换一个主 agent”可接管在线会话或新开 Claude、Codex、OpenCode；确认只发出接管请求，原绑定保留到目标会话自行创建 Run 并用一次性凭据接管。已发通知不补发，接管者先读总览。未知发送结果不自动重试。

主 agent 正在处理时显示“在线”，会话仍在但空闲时显示“待命”，只有会话关闭或找不到时显示“离线”并提示查看主 agent。接管仍要求目标会话在线并自行调用绑定命令。

“外部连接”统一配置飞书和多个 A2A agent。每个连接有唯一名字、启用状态和独立配置；A2A 有独立的双向令牌、端口和往来记录。令牌留在 Orca secrets。A2A 目前使用回环 HTTP v1 JSONRPC；远端可通过已有本机隧道接入。详见 [Hermes 连接](HERMES.md)与[飞书接入](FEISHU.md)。

项目右上齿轮打开项目设置：角色分工、导出、隐藏、删除。隐藏保留全部记录与 agent 读写，暂停首页显示、飞书提醒和对外上报；在设置底部恢复。删除要勾选确认，先导出完整记录到插件数据目录 exports/，再检查整个项目所有工作树的终端与会话；有打开的终端或会话、清单不完整、项目不唯一时拒绝。确认空闲后调用 setup-delete --force 移除 Orca 登记，核对已移除再删插件记录。磁盘文件、Git 仓库与 Git 工作树保留，导出不含密钥；当前无自动导入入口。

命令 `hide|restore <input.json>` 输入 `{projectId,revision}`；`delete <input.json>` 输入 `{projectId,revision,confirm:projectId}`，仅在用户明确确认后调用。删除回执含 `{deleted,exportPath}`；未知结果现读记录、导出与 Orca 登记核对，不盲目重试。同名项目须核对精确编号和完整路径。

“其他工作间”的“动态”展示对端开放内容和往来请求，“连接设置”管理监听、配对和开放范围。请求详情里接受或拒绝，向对方派活仍由主 agent 执行。报告排除关联 workspace-external 来源的整条任务及其派生资料，不能转给第三个工作间。详见[工作间连接](LINKS.md)。

组织画布仍是独立面板。“工作间连接”展示双方规则，点击节点或连线编辑；“工作间内部”展示主 agent、外部连接、项目和分工。隐藏项目不出现。拖动或聚焦后按方向键调整位置，Tab 选节点、Enter 编辑，位置独立保存。项目主 agent 种类从实际绑定 Run 读取，缺失时显示未知。

状态栏“工作间 · 待处理 N”与全局快捷键 **Ctrl+Alt+Shift+J**（macOS 为 **Cmd+Option+Shift+J**）打开首页，不切换项目或会话。中文触发词“开启项目协作”“项目协作：”与 `$orca-project-coordinator` 保留，工作间主 agent 使用 `$agentboat-workspace`。

`node scripts/client.mjs overview` 读取完整总览，`read <projectId>` 读项目，`main-read` 读主绑定，`main-targets` 读在线会话和工作区。`main-bind [--check]` 从标准输入读取 `{revision,requestId,runId,token}`，调用会话自行声明 Run；插件独立核对在线资料、凭据、Run 存在及占用。检查模式不消费凭据、不写绑定或发送通知。`message <input.json>` 保留工作间来源并转达项目主会话；输入与去重规则见[桥接说明](skill/orca-project-coordinator/references/bridge.md)。

## 本地开发

```powershell
npm ci
npm run typecheck
node scripts/test-local.mjs
node scripts/check-local.mjs
node --test ../workspace/workspace.test.mjs ../workspace/project-skills.test.mjs
npm run build
orca plugin validate plugin --json
orca plugin dev load plugin --json
orca plugin open local.project-coordinator --panel project-coordinator --json
```

`plugin/` 是自包含运行目录，包含打包后的官方飞书 SDK；不要直接加载有 node_modules 的源码根目录，以免超出 Orca 文件大小限制。修改后重新 build 与 dev reload。不得修改 orca-plugin.json；审批回执的清单与权限未变化时才按指纹批准。开发加载会保留，插件的 CLI 桥接使用 Orca 目前仅向开发插件开放的 dev request。

用户正在使用的插件构建会自动重新加载。构建前先将 `%APPDATA%/orca/plugins-data/local.project-coordinator` 整个备份到仓库外，并用 client 读取全部项目快照；测试与类型检查全部通过后才能构建。每次重新加载后比对全部项目；差异若来自快照后的正常写入，核实后取新快照再比；解释不了的差异或丢失立即回退旧构建并回报，不自行修数据。使用 mockHost 隔离数据测试通知，不向真实项目写测试记录或发送消息。`node scripts/release-evidence.mjs backup <仓库外目录>` 备份数据、旧构建并取全项目快照；用 snapshot 与 compare 保存并比对重载结果。修改 skill 后执行 `node ../workspace/install.mjs`，并把 `skill/orca-project-coordinator` 复制到 `~/.agents/skills/orca-project-coordinator`；Hermes skill 安装到 Hermes home 的同名目录并同步系统提示。

Orca 1.4.256 在本机 Windows 的 plugin test/check 会错误拒绝其测试运行时的相对导入。可以用以下脚本将同一官方测试运行时与测试临时打包，不修改 Orca 安装文件：

```powershell
node scripts/test-local.mjs
node scripts/check-local.mjs
```

## 连接与反馈

飞书只在“设置 → 外部连接”配置，普通消息经工作间主 agent 转给项目；插件直接推送项目提醒，回复准确提醒可登记决定或验收。配置与权限见 [飞书接入](FEISHU.md)。其他工作间的配对、开放范围与派活见 [工作间连接](LINKS.md)。

`project.feedback` 接收 `{projectId,revision,items:[{taskId,kind,itemId,itemRevision?,result?,answer?,note?}]}`。先校验整批，同一版本写入，给项目主 agent 一条结论消息；一项无效整批拒绝。验收只接受 ready 任务的 pending 条目和当前版本，决定必须尚未回答。面板每次提交一项数组；飞书走相同校验。项目一次提交的新待决定、待验收、受阻、完成事项合成一条主 agent 通知，仍按条目去重。

## 验收记录

只有需要用户验收的成果进入待验收；普通问答无需建任务。成果有独立版本编号，验收项有稳定编号、版本与反馈历史；受影响项重开，其他通过项保留。执行完成和用户通过分别记录。源码、模拟事件测试、本地界面与真实飞书收信分别核验，未配置凭据时不声称通过真实飞书验证。

退回修改后，由执行者继续处理，任务记录显示“修改中”。新版本成果提交后，相关验收项重新进入待验收，并附上次修改意见；历史反馈继续保留。
