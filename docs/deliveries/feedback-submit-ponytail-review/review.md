# AgentBoat 验收提交与兼容入口审查

AgentBoat 的面板和本机 CLI 通过同一个 Orca worker 读取项目与工作间，登记成果和反馈，再向对应会话送达通知。审查以 `master` 的 `5ad219b` 为源码基线，以 Orca 1.4.280 本机开发加载的 v0.1.55 和实际固定入口为运行证据，按一位用户、31 个项目和多个并行会话判断影响。正文行号以基线为准。

## 需修复

1. **固定入口仍运行 v0.1.52 的命令脚本，已启用的 v0.1.55 无法通过它提供新命令。** `coordinator/scripts/orca-cli.mjs:20–36,75–128`，`coordinator/src/worker.ts:1460–1493`，`coordinator/scripts/client.mjs:14–17,29–33,83–86`。
   - 触发与影响。本机开发加载 v0.1.55 后，`orca plugin list --environment local --json` 确认为 `running`。`agentboat-current` 的 Windows junction 仍跟随 Orca 的正式安装 `current`，指向 v0.1.52。旧客户端能连接当前 worker，`projects` 和原任务 `read` 均成功，因此普通读回会掩盖版本错位。v0.1.55 新的 `feedback-file` 被旧脚本在命令解析时拒绝，项目主会话从验收通知复制命令也无法取回附件位置。
   - 证据。在实际路径上用缺少参数的 `feedback-file` 做纯解析检查。固定入口返回通用用法，v0.1.55 候选脚本返回专用用法。未发起附件读取。两份包各 225 个文件，同为 `trusted-worker`，入口 `worker.mjs`，六项权限一致。候选身份由本机 `orca plugin inspect` 和加载回执核对，固定入口身份由 `current` 和实际清单核对。
   - 最小处理。凡会安装到用户级 hooks 或写入项目通知的固定入口，验证其命令版本与当前加载 worker 一致。使用开发包时先明确提示版本错位，等经过校验的正式安装入口与 worker 对齐后再验证新命令。保留安装所有权判断，不让开发包直接接管正式 junction 或用户 hooks。这一证据说明附件后续读取会失败，尚不能解释用户原先遇到的面板批量提交失败。

2. **单个可选连接目录读失败会阻断整个工作间启动和概览。** `coordinator/src/links.ts:359–364,424–431`，`coordinator/src/connections.ts:19–25,109–114`，`coordinator/src/worker.ts:774–778,1436–1453,1492–1493`。
   - 触发与影响。把 `workspace.links` 或 `workspace.connections` 保持为同一个键，但内容来自插件不识别的版本。两个目录各自在 `coordinator.start()` 抛错，随后主绑定恢复、在途通知恢复和固定 CLI 监听都无法到达。即使独立请求处理器已挂载，概览也会重读问题目录并整体失败。此前对单条 A2A 连接的保护仍有效，目录级失败可绕过这层隔离。
   - 证据。用模拟 Orca 宿主分别注入两份 `version: 2` 目录。两例均复现 `start()` 与 `workspace.overview` 拒绝，独立 `projects.list` 仍可读，两个问题值保持原样。
   - 最小处理。分别捕获可选目录的启动及概览错误，在对应连接区显示恢复提示，让本机项目、原绑定和通知恢复继续。保持目录读写的格式校验和原文件。用现有启动测试模式分别补一例。该条件会阻断用户打开验收列表，也会在启动中止时使 CLI 验收登记不可用。本机当前概览和任务读取能返回，未观察到本机目录故障。

3. **正常结束的执行者回报会被待登记验收的提醒过滤掉。** `coordinator/scripts/orca-questions.mjs:23–29,44–57`，`coordinator/src/runtime.ts:247–275`，`coordinator/src/worker.ts:175–239`。
   - 触发与影响。执行者用 Orca `worker_done` 完成带成果的派工，项目主会话还没有用 `submit` 登记。超过 30 分钟才进入提醒候选，但邮件随后与需要仍在进行的提问共用筛选规则。Orca 中已结束的派工、任务和执行者均会被筛掉，工作间的「执行者回报待提交」及两小时升级提醒都不会出现。
   - 证据。真实 AgentBoat 项目 Run 的只读样本中，32 条能够配对的成功回报均为执行者 `succeeded`、Dispatch `completed`、Task `completed`。本机样本用于确认回执状态，是否存在漏登记由隔离测试验证。该测试用同一封超过 30 分钟的回报，只改变派工和任务状态即可复现从一条到零条。现有正向回归在 `coordinator/src/coordinator.test.ts:203–232` 把成功回报的发送者建成仍处于 `ready/dispatched` 的夹具，未覆盖上述回执。
   - 最小处理。提问继续要求活跃的任务与派工。成功回报使用宿主确认的真实 Run、Task、Dispatch 和发送者归属，允许已完成的记录通过，保留时间窗口、发件人核对、已登记凭证和去重规则。把成功回报回归的夹具替换成实际完成状态，并覆盖冒用和已登记的拒绝路径。这能补上项目主会话漏登记的提醒。本机面板提交按钮的故障由本任务的另一条修复链路分别验证。

## 兼容入口核对

| 入口或数据 | 核对结果 |
| --- | --- |
| `workspace.entry` | `0459a05` 的前一版在旧 Canvas 的「设置/切换主 agent」按钮调用它。该次改版移除了按钮调用。基线和本机 v0.1.52、v0.1.55 包内均查不到调用。已删除旧请求、`workspace.navigation` 的读取和写入、`workspace.open` 的 `switching` 字段及旧事件夹具。现行状态栏和快捷键通过清单里的 `workspace.overview` 工作。当前项目入口 `project.openMain` 继续按精确项目身份打开工作区。 |
| `workspace.mjs` 对 `launchReceipt` 的二次导出 | 只有 `workspace.test.mjs` 经它访问。已删除二次导出，测试直接引用 `agent-launch.mjs`，立项、派工和 `runtime.ts` 仍共用同一个启动回执校验。 |
| 项目主备、旧主会话句柄、旧工作间 Run | `workspace/agent-launch.mjs:22–29,45–69`、`worker.ts:416–460,1345–1405`、`main-agent.ts:31–146,177–245`、`backup-lead.ts:151–365,388–512`。本机主会话只读统计显示当前 21 个主会话句柄中仍有 2 个匹配旧代理前缀加下划线的 UUID 形状。已发出的接管回执和普通工作间旧 Run 还有 `backup-lead.test.ts:868–889` 的升级行为覆盖。当前项目工作区的 `orca agent installed` 返回五个可选代理，含默认主用 Antigravity 和备用 Codex。各项目按其工作区的实际清单选择。旧 `code` 模板按已发指纹升级，用户定制值沿原逻辑。 |
| `--workspace-request` 和联络 Run | `workspace/workspace.mjs:31–46,124–137,267–284,338–357` 调用该脚本登记项目设置、开主会话及送达通知；`workspace/configure-hermes.py:111` 用它更新 A2A 接入。`runtime.ts:201–204`、`lead-contact.mjs:15–85,102–150` 实际给接管后的原主会话建立独立联络 Run，避免把联络任务塞进业务 Run。原生 Orca CLI 和 worker 之间的这个中转仍有调用。 |
| 正式安装、候选目录和 hooks | `release.mjs:22–50`、`orca-plugin.json:1–32`、`orca-cli.mjs:19–40,64–128`、`workspace/install.mjs:337–358,564–650`、`workspace/harness/hook.mjs:188–195,340–377`。安装清单发布工作间与项目两套 skill、启动读回、联络、回报及原问题脚本。Windows junction 保护、候选只读检查、已登记 hooks 与当前 Orca 客户端都在调用。测试名称提到 Orca 1.4.258 的平铺回执，但本机 1.4.280 的 `orca agent launch --help` 仍描述 `result.outcome` 契约，保留 `launchReceipt` 核对。`worktree create` 的 `result.launch` 是另一个入口。 |
| 跨工作间、飞书、Hermes 和文件分段 | `links.ts:491–579,632–695,831–856,937–1012`、`link-messages.ts:80–189`、`link-files.ts:174–257`、`connections.ts:28–109`、`butler.ts:77–139`、`worker.ts:548–623`。本机持久化目录包含 2 个已配对的工作间和 1 条 A2A 连接，只统计类型和状态。双向同步需要回退轮询、授权快照与待确认回执。文件传输根据当前地址及连接能力从直传回退到校验分段。飞书旧提醒有版本与成果快照校验。跨工作间旧对端没有反馈附件能力时拒绝附件请求，避免只写入正文。保留这些分支、权限和凭据。 |
| 归档、请求编号和未确认通知 | `store.ts:105–139,202–249`、`project-archive.ts:56–107,189–247,250–330`、`worker.ts:632–726,1428–1453`。本机只读统计 31 份项目中有 11 份带归档，现行 `read --task`、`submit` 重放和角色联络需要已提交归档指针。通知使用 `pending → sending → sent/uncertain`，结果不明保留待核对，不自动重发。 |

上轮审查的飞书旧决定提醒和单条 A2A 启动隔离已在 `40e0b81` 修复。当前目录级复现使用独立的触发数据。反馈本身的待提交筛选、项目 revision、附件暂存、批量结果与重放凭证已沿面板到 worker/store 跟读。反馈提交链路的修复和集成结论由对应执行者交付。

合并触点为 `worker.ts` 的 `createCoordinator()` 内总览命令登记、`panel-page.ts` 的 `start()` 内导航初始化及 `workspace.open` 订阅、`protocol.ts` 的导航声明、`panel-browser.mjs` 的 `setup()` 导航夹具和详情恢复测试。保留反馈执行者对同一文件内反馈处理、草稿和其他测试夹具的修改。

## 验证与结论

- `npm run typecheck` 通过。`node --test workspace/workspace.test.mjs` 通过 14 项，覆盖直接回执校验、项目默认主备、立项恢复和真实形状的模拟本机 CLI。
- `main-agent.test.ts` 和 `agents.test.ts` 的 20 项定向测试通过，覆盖状态栏命令和项目工作区打开，含绑定、未绑定和失效项目。
- `panel-browser.mjs` 的详情恢复用例在隔离 Chromium 通过。覆盖从状态栏重新打开时保留宽栏详情、设置返回首页、窄栏详情重挂载、任务详情返回和草稿逐字段一致。页面错误和外部请求均为零。
- 三项隔离复现通过。入口命令对比、本机版本状态、只读项目回执及 32 条 Orca 完成状态来自本机 CLI。模拟代码与产物位于 child 的忽略目录 `coordinator/.orca/`。
- 本次兼容清理可合并。第 1–3 项分别影响附件取回、目录错误时验收入口可用性、漏登记验收的提醒。真实 Orca 面板提交、真实飞书与 Hermes、对端工作间和长时间压力未在本轮验证。审查使用最小相关验证，未执行全套回归或发布流程。
