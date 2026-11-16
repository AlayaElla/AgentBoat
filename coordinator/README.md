# 工作间

Orca 右侧的工作间是 HTML 面板，首页只有「等你处理」和「组织」。自己的工作间默认展开，主 agent、外部连接和项目都在树里；只显示直接连接的工作间。关系由实线与虚线表示，自己的名字条使用 Orca 主色。界面跟随 Orca 明暗主题，Geist 字体与 OFL 许可随插件打包。

等你处理默认列三件，同一个任务的同一类事项合并计数，在等你的 agent 也算一件。实时状态仅取 Orca worktree ps，执行记录只用来对上任务；读不到时明确显示，已完成只留 24 小时，Agent 页最多列 20 条完成记录。

项目页提供待处理、任务、Agent、消息；项目设置里分工、导出、隐藏和删除。反馈先逐条选择，按项目一次提交；全部通过只是选择，仍须提交确认。草稿按项目保存到本机插件存储，成果或决定过期时整批暂停，清掉过期项并提示重新提交。

设置提供主 agent、外部连接、工作间连接、机器、隐藏的项目。外部连接沿用飞书和多个 A2A 的独立凭据与往来记录。隐藏保留项目记录；删除先导出，再核对没有打开的会话，移除 Orca 登记后才删工作间记录，磁盘文件保留。

其他工作间展开后只有连接状态、项目、请求；项目只读，离线显示未知和最后同步时间。下级仅在开放任务详情且有受阻任务时显示红点。派活直接发给对方主 agent，同时通知本侧主 agent；离线先排队，没有绑定主 agent 时不可派活。关系只在本机保存；首次建议的开放范围须经用户保存，以后改关系保持原开放设置。

状态栏与全局快捷键 Ctrl+Alt+Shift+J（macOS 为 Cmd+Option+Shift+J）打开首页。主 agent 的 client.mjs 现有命令和输入格式不变，新增 links-relate 从标准输入读取关系。详细输入见[桥接说明](skill/orca-project-coordinator/references/bridge.md)。

## 本地开发

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

用户正在使用的插件构建会自动重新加载。构建前先将 `%APPDATA%/orca/plugins-data/local.project-coordinator` 整个备份到仓库外，并用 client 读取全部项目快照；测试与类型检查全部通过后才能构建。每次重新加载后比对全部项目；差异若来自快照后的正常写入，核实后取新快照再比；解释不了的差异或丢失立即回退旧构建并回报，不自行修数据。使用 mockHost 隔离数据测试通知，不向真实项目写测试记录或发送消息。`node scripts/release-evidence.mjs backup <仓库外目录>` 备份数据、旧构建并取全项目快照；用 snapshot 与 compare 保存并比对重载结果。修改 skill 后执行 `node ../workspace/install.mjs`，并把 `skill/orca-project-coordinator` 复制到 `~/.agents/skills/orca-project-coordinator`；Hermes skill 安装到 Hermes home 的同名目录并同步系统提示。

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
