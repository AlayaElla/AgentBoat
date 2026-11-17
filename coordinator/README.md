# 工作间

Orca 右侧的工作间是 HTML 面板，首页只有「等你处理」和「组织」。自己的工作间默认展开，主 agent、外部连接和项目都在树里；只显示直接连接的工作间。关系由实线与虚线表示，自己的名字条使用 Orca 主色。界面跟随 Orca 明暗主题，Geist 字体与 OFL 许可随插件打包。

等你处理在宽屏两栏时全部列出，左栏独立滚动；单栏时先列三件，再按需展开。同一个任务的同一类事项合并计数，在等你的 agent 也算一件。实时状态仅取 Orca worktree ps，执行记录只用来对上任务；读不到时明确显示，已完成只留 24 小时，Agent 页最多列 20 条完成记录。

项目页提供待处理、任务、Agent、消息；右上角「打开主会话」优先打开已记录会话所在的工作区，找不到时打开项目自身的工作区，多个对话时提示手动点主会话标签。项目工作区被移除或不可用时按钮禁用并显示原因；点击时重新核对，宿主报错原样显示。项目设置里分工、导出、隐藏和删除，主 agent 类型从记录的会话前缀显示，未记录或类型无法识别时显示「未知」。反馈先逐条选择，按项目一次提交；全部通过只是选择，点「提交 N 条」即提交。请求发出后，按钮立即显示「提交中…」或「处理中…」与转圈效果，完成后恢复并显示结果；系统减少动态效果时只显示文字。草稿按项目保存到本机插件存储，成果或决定过期时整批暂停，清掉过期项并提示重新提交。

设置提供主 agent、外部连接、工作间连接、机器、隐藏的项目。外部连接沿用飞书和多个 A2A 的独立凭据与往来记录。隐藏保留项目记录；删除先导出，再核对没有打开的会话，移除 Orca 登记后才删工作间记录，磁盘文件保留。

其他工作间展开后只有连接状态、项目、请求；项目只读，离线显示未知和最后同步时间。下级仅在开放任务详情且有受阻任务时显示红点。派活直接发给对方主 agent，同时通知本侧主 agent；离线先排队，没有绑定主 agent 时不可派活。关系只在本机保存；首次建议的开放范围须经用户保存，以后改关系保持原开放设置。

状态栏与全局快捷键 Ctrl+Alt+Shift+J（macOS 为 Cmd+Option+Shift+J）打开首页。主 agent 的 client.mjs 现有命令和输入格式不变，新增 links-relate 从标准输入读取关系。详细输入见[桥接说明](skill/orca-project-coordinator/references/bridge.md)。

主 agent 页直接列出在线会话，点「设为主 agent」或「换成它」即发出接管；也可直接新开主 agent，默认 Claude，可改 Codex。等待时可取消或改选其他会话，旧凭据随即失效；10 分钟内未绑定会显示原因。目标会话仍须核对身份、创建自己的 Run、先 `main-bind --check` 再正式绑定，一次性凭据不会写入 skill。

## macOS 安装和更新

需要 Node.js 22+、Git、正在运行的 Orca >=1.4.261，并确认终端能运行 `orca status --json`。先将下面的仓库地址换成自己的 AgentBoat Git 地址：

```sh
git clone <AgentBoat仓库地址> AgentBoat
cd AgentBoat/coordinator
npm install
npm run build
orca plugin dev load plugin --json
node ../workspace/install.mjs
orca plugin open local.project-coordinator --panel project-coordinator --json
```

首次加载按 Orca 回执核对权限并批准；需要指纹时使用回执给出的命令和 fingerprint。`plugin/` 不进 Git，拉代码后必须在本机构建，再加载此目录。安装器会同时安装工作间主 agent 和项目协作两份 skill 到 `~/.agents/skills/`，并在 `~/.claude/skills/` 建立链接；命令中的仓库路径会替换为本机绝对路径。移动仓库后重新运行安装器，开启新会话加载更新后的 skill。

更新时在 `AgentBoat/coordinator` 执行以下步骤。证据目录须在仓库外，且其父目录已经存在；下面用系统临时目录创建父目录并保留备份，终端内设定的变量不进入仓库：

```sh
git pull --ff-only
npm install
orca plugin types . --json
npm run typecheck
node scripts/test-local.mjs
# 首次检查时将浏览器工具装到仓库外；已安装时直接复用 PLAYWRIGHT_MODULE
browser_tools="$(mktemp -d -t agentboat-browser)"
npm install --prefix "$browser_tools" playwright-core
export PLAYWRIGHT_MODULE="$browser_tools/node_modules/playwright-core/index.mjs"
# 使用 Mac 上的 Chrome；其他 Chromium 浏览器改为其真实可执行文件路径
export BROWSER_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
node scripts/panel-browser.mjs
evidence_parent="$(mktemp -d -t agentboat-update)"
evidence="$evidence_parent/backup"
node scripts/release-evidence.mjs backup "$evidence"
npm run build
orca plugin dev reload plugin --json
node scripts/release-evidence.mjs snapshot "$evidence" after
node scripts/release-evidence.mjs compare "$evidence" after
node ../workspace/install.mjs
```

检查失败时停止，先修复再构建。重新加载若需审批，先与备份内 `plugin/orca-plugin.json` 核对清单和权限，再按回执批准；批准后再拍快照比较。保留终端打印的备份位置；如有可解释的正常项目更新，核实后另存基线重比；解释不了的差异或数据丢失应立即恢复旧构建并回报，保留当前数据，不自行修记录。没有修改清单和权限的更新不应增加授权。

macOS 默认插件数据目录为 `~/Library/Application Support/orca/plugins-data/local.project-coordinator`；Windows 默认位于用户的 `AppData/Roaming/orca/plugins-data/local.project-coordinator`（使用系统 APPDATA）。两者均优先使用 `ORCA_USER_DATA_PATH` 指定的 Orca 用户数据目录。备份脚本与项目导出共用这条规则；开发版或自定义 profile 应在当前 Orca 终端内执行，或显式设置该环境变量。

## 本地开发

实时 agent 状态要求 Orca >=1.4.261，授权时新增「读取 agent 状态」和「读取工作区」；`workspace:write` 不包含读取权限。`workspace.agents` 按工作区调用宿主 `agents.list`，waiting/blocked 显示「需要你」、working 显示「工作中」、done 显示「已完成」。worker 监听 `agent.status.changed`，即使面板关闭也更新状态栏，60 秒兜底刷新；最多读取 256 个本机工作区、2000 条状态，截断会提示且状态栏数量带 `+`，已完成保留 24 小时。宿主每工作区最多返回 50 条且没有截断字段，达到 50 条时也显示数量不完整提示。

宿主只给任务标题，插件仅对有执行记录的项目补读 `orchestration worker-list`，用精确 terminalId 找到唯一 dispatchId 再关联任务；不能匹配时只归属项目。宿主 sessionId 是提供方会话编号，当前 worker-list 不提供对应字段，不能把它拼成 Orca 会话句柄；结构化会话仅归属项目，不按标题关联任务。项目 CLI 写入自动附带当前 caller 与可读取的 Run，仅在 Run 与项目绑定一致时记录 `mainAgentHandle`；这是会话自报的显示和导航信息，不作为权限判断。`project.openMain` 优先使用该句柄在 `runtime.targets` 中对应的精确工作区，再用项目 `ref.workspace` 兜底，并通过宿主 `workspace.list` 核对本机工作区后调用已有 `workspace:write` 下的 `workspace.open`。`agents.list` 只用于判断是否显示多个对话的标签提示，读取失败不影响打开工作区。主 agent 接管仍保留 `worktree ps` 与 `terminal list`：`agents.list` 的状态不证明存活，也不给父会话信息或 Orca 会话句柄，不能替代既有 `subagentObservation`、可写终端及 Run/会话/一次性凭据核对。项目目录也改用宿主 project.list/workspace.list；删除前的全终端保护仍沿用 CLI。

```powershell
npm ci
npm run typecheck
node scripts/test-local.mjs
node scripts/panel-browser.mjs
node --test ../workspace/workspace.test.mjs ../workspace/project-skills.test.mjs
npm run build
orca plugin validate plugin --json
orca plugin dev load plugin --json
orca plugin open local.project-coordinator --panel project-coordinator --json
```

`plugin/` 是自包含运行目录，包含打包后的官方飞书 SDK；不要直接加载有 node_modules 的源码根目录，以免超出 Orca 文件大小限制。修改后重新 build 与 dev reload。清单变更必须逐项核对用户授权后才按回执指纹批准。开发加载会保留，插件的 CLI 桥接使用 Orca 目前仅向开发插件开放的 dev request。

用户正在使用的插件构建会自动重新加载。构建前先将插件数据整个备份到仓库外，并用 client 读取全部项目快照；测试与类型检查、无头检查全部通过后才能构建。每次重新加载后比对全部项目；差异若来自快照后的正常写入，核实后取新快照再比；解释不了的差异或丢失立即回退旧构建并回报，不自行修数据。使用 mockHost 隔离数据测试通知，不向真实项目写测试记录或发送消息。`node scripts/release-evidence.mjs backup <仓库外目录>` 备份数据、旧构建并取全项目快照；用 snapshot 与 compare 保存并比对重载结果。修改 skill 后执行 `node ../workspace/install.mjs`，一次同步两份 skill 和 Claude 链接。Hermes 的 `workspace/install-hermes.ps1` 仅用于 Windows，其 skill 和系统提示由该安装流程管理。

Orca 1.4.256 在本机 Windows 的 plugin test/check 会错误拒绝其测试运行时的相对导入。可以用以下脚本将同一官方测试运行时与测试临时打包，不修改 Orca 安装文件：

```powershell
node scripts/test-local.mjs
node scripts/panel-browser.mjs
```

无头面板检查使用 Playwright Core；通过 PLAYWRIGHT_MODULE 指向已安装的 index.mjs，BROWSER_EXECUTABLE 可指定 Chromium 或 Edge。检查只使用内存中的示例数据，不接触插件数据、真实项目或消息。

## 连接与反馈

飞书只在“设置 → 外部连接”配置，普通消息经工作间主 agent 转给项目；插件直接推送项目提醒，回复准确提醒可登记决定或验收。配置与权限见 [飞书接入](FEISHU.md)。其他工作间的配对、开放范围与派活见 [工作间连接](LINKS.md)。

`project.feedback` 接收 `{projectId,revision,items:[{taskId,kind,itemId,itemRevision?,result?,answer?,note?}]}`。先校验整批，同一版本写入，给项目主 agent 一条结论消息；一项无效整批拒绝。验收只接受 ready 任务的 pending 条目和当前版本，决定必须尚未回答。面板一次提交整个项目选好的 items；可省 revision 并带 requestId，按条目版本校验并去重。飞书走相同校验。项目一次提交的新待决定、待验收、受阻、完成事项合成一条主 agent 通知，仍按条目去重。

## 验收记录

只有需要用户验收的成果进入待验收；普通问答无需建任务。成果有独立版本编号，验收项有稳定编号、版本与反馈历史；受影响项重开，其他通过项保留。执行完成和用户通过分别记录。源码、模拟事件测试、本地界面与真实飞书收信分别核验，未配置凭据时不声称通过真实飞书验证。

退回修改后，由执行者继续处理，任务记录显示“修改中”。新版本成果提交后，相关验收项重新进入待验收，并附上次修改意见；历史反馈继续保留。
