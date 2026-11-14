# 工作间主 agent

Node.js + Git + 运行中的 Orca 桌面端，以及已加载的项目协作插件、已安装的 `orca-project-coordinator` skill。无需重建插件。脚本使用 `ORCA_CLI_COMMAND`（Windows 默认当前用户 Orca 安装路径），命令固定作用于本机 Orca；不接管工作间主 Run。

```powershell
node workspace/install.mjs
$env:AGENTBOAT_HOME = 'D:\my-agentboat'
node workspace/workspace.mjs init
node workspace/workspace.mjs templates
```

安装只复制到 `~/.agents/skills/agentboat-workspace`，让 `~/.claude/skills/agentboat-workspace` 指向它；Windows 用 junction，不弹管理员授权。已有其他链接/目录会拒绝覆盖。skill 全文在 [skill/agentboat-workspace/SKILL.md](skill/agentboat-workspace/SKILL.md)，加载后说“开启工作间管理”。安装不启动 agent，不改变主 Run。仓库搬迁后更新 skill 中两个脚本路径再安装。

`AGENTBOAT_HOME` 默认 `~/.agentboat`；init 保留已有模板和记忆，不覆盖定制。目录有 templates、memory、projects（立项日志）、assignments（派活日志）、requests（插件请求原文）。记忆有独立 Git 仓库，脚本只暂存不提交；主人的明确内容和推断分开，外部工作间单独目录。所有来源与日志可能含用户原话，按本机私有资料保管，不放凭据。

## 模板与立项

工作间互联在插件总览的“其他工作间”中管理；现读命令是 `node coordinator/scripts/client.mjs links-refresh` 与 `links-read`。跨工作间派活用 `requests-read/send/decide/attach/update`，写命令均从标准输入接收 JSON；受理后由主 agent 通过 attach 登记独立外部来源，不能转给第三个工作间。外部记忆按 workspaceId 独立保存。输入格式和验证边界见 [工作间连接](../coordinator/LINKS.md)。

默认 [templates/code.json](templates/code.json)：项目主 agent Claude，设计 Claude，编码和审查 Codex，来源 empty。模板可直接编辑 JSON；agent 支持 claude/codex，可附 model 和 effort，effort 需要 model。没有指定模型时跟随 Orca 设置。每项工作只起需要的 agent。

保存 UTF-8 JSON 后调用（支持 BOM）：

```json
{
  "requestId": "create-my-app-001",
  "template": "code",
  "name": "my-app",
  "path": "D:/projects/my-app",
  "source": { "kind": "empty" },
  "goal": "先开启项目协作，等待具体需求"
}
```

```powershell
node workspace/workspace.mjs create create.json
```

source 可省略以沿用模板；kind=empty 建不存在的空目录并登记 folder；existing 使用原目录（.git 存在则登记 git）；clone 另附 url，用 Git 克隆到不存在的目标，再通过 Orca 登记。目录准备可用文件系统/Git，登记、项目设置、agent 启动、工作树均经 Orca。已有内容不清理、不初始化 Git、不自动提交，clone 支持 HTTPS/SSH/本机 Git 地址，凭据由 Git 管理。

新 Git 项目的独立工作树目录设在相邻的 `<项目目录名>-worktrees`，只设置新登记项目的 host setup。create 不覆盖已绑定项目。脚本回执为 awaiting-project-binding；项目主 agent 自己开启项目协作、创建 Run 和绑定；读取插件和 run-show 确认后才算立项完成。模板角色会同步到项目设置和首句话。

## 项目 skill

项目的唯一编辑源是 `.agents/skills/<name>/SKILL.md`；Claude 副本由审核发布脚本写到 `.claude/skills/<name>`，两者随 Git 合并。副本保存完整内容与辅助文件，无需符号链接或管理员权限。`create` 在登记前幂等准备源目录、字节保留的 `.gitattributes` 和草稿目录，不覆盖已有文件；已有项目也可手动 `init`。

官方读取位置（2026-11-14 核对）：

| Agent | 项目位置与依据 |
| --- | --- |
| Codex | [官方 Skills 文档](https://learn.chatgpt.com/docs/build-skills)：从 cwd 向仓库根查找 `.agents/skills`。 |
| Claude Code | [官方 Skills 文档](https://code.claude.com/docs/en/skills)：项目 `.claude/skills/<name>/SKILL.md`，跟 Git 共享；新工作树从自己的目录加载。 |
| OpenCode | [官方 Skills 文档](https://opencode.ai/docs/skills/)：`.opencode/skills`，兼容 `.agents/skills`、`.claude/skills`；本项目沿用共享目录，不另复制第三份。 |

```sh
node workspace/project-skills.mjs init --root <项目>
node workspace/project-skills.mjs new --root <工作树> --name demo-check --description "检查 demo 时使用"
node workspace/project-skills.mjs validate --path <工作树>/.agentboat/skill-proposals/demo-check
node workspace/project-skills.mjs list --root <工作树>
node workspace/project-skills.mjs publish --root <工作树> --name demo-check --reviewer <项目主会话编号> --source <审核消息编号>
```

`new` 只创建不被自动发现的草稿，已有同名文件拒绝覆盖。可移植格式限定为两个单行 YAML 字符串字段 `name`、`description` 加 Markdown 正文；复杂标点用 JSON 双引号值。名称用小写字母、数字、连字符，不超过 64 字符，与目录一致；description 不超过 1024 字符。校验会拒绝占位、缺字段、重复字段、链接、无正文；它不证明步骤正确，也不是通用 YAML 校验器。按需在草稿内添加 scripts、references 或 assets，不支持各家私有 frontmatter 扩展。

执行者提出已验证的可复用做法，主 agent 审核内容、必要性、权限与证据后执行 publish，记录真实 reviewer/source 与全目录 SHA-256。源和副本都只覆盖摘要匹配的旧版本，保留外来文件和被人编辑的副本；先处理冲突再重新发布。命令的 reviewer 是审计依据，不是身份认证，不能自动代表主 agent 同意。list 区分 proposal、approved、unreviewed；后者需重新审核，不直接共享。

**发布不等于合并。** 按项目提交约定把 `.agents/skills`、`.claude/skills`、`.agentboat/skill-reviews.json` 一起提交和合并，再从该基线启动新工作树。目录内 `.gitattributes` 避免 Windows 换行转换改变审核摘要。已有工作树更新后重启 agent；同名个人 skill 可能影响各家选择，名称宜加项目前缀。项目主 agent 的具体审核流程见 [项目协作 skill](../coordinator/skill/orca-project-coordinator/SKILL.md)。未经提交授权停在待合并状态。

附属机器模式由 hands 生成器经 SSH 读取指定工作树 **HEAD** 的审核记录和源文件，在主机独立配置目录保存快照、提交号，并给三家加载 SKILL 正文。辅助文件和脚本用 hands 的远端路径，不执行主机副本。未审核的提交或取回失败直接报错，未提交改动不带上；每次合并、切分支或撤销后重新生成配置。详见 agentboat-hands README 的“项目 skill 快照”。不改订阅登录、全局 skill、插件或主机权限。

验证辅助脚本：`node --test workspace/workspace.test.mjs workspace/project-skills.test.mjs`。它们只在沙盒的 agentboat-demo 临时目录读写并清理，不启动模型。

## 直接派活

从 `node coordinator/scripts/client.mjs projects` 取得完整项目编号，核对路径、repoId、hostId。项目必须已绑定主 agent，必须为有提交的 Git 仓库。

```json
{
  "requestId": "direct-my-app-001",
  "projectId": "精确项目编号",
  "template": "code",
  "role": "code",
  "name": "fix-title",
  "title": "调整标题",
  "text": "把页面标题改成工作间",
  "source": "主人 / Orca 会话编号 / 消息编号 / 2026-11-14"
}
```

```powershell
node workspace/workspace.mjs dispatch dispatch.json
```

脚本必须在 Orca 会话内运行，从 Orca 环境取实际调用会话，不接受伪造 sender 或主 Run。先登记插件任务和项目内 `.agentboat/assignments/` 来源原文，再用 `orca worktree create --no-parent --agent ... --setup skip`，登记启动回执并通知项目主 Run。直接派活的来源在任务 goal、progress 与来源成果中，可在项目任务中打开；插件 events 的 workspace-agent 来源专用于真正主 Run 的 `message`。独立 agent 完成后向项目主 Run 回报，不由启动脚本代验收。没有 Orca Task/Dispatch 的直接启动不伪造执行编号。

同 requestId 拒绝二次启动。失败查看 projects/assignments 日志和其中完整回执；结果不明不换编号重试。脚本不会自动清理未知 agent，按 Orca 版本指南恢复，避免重复执行和丢失数据。当前脚本是一次性 CLI，不做常驻轮询，状态与回报由主 agent 会话接收并读取。

## 代记主人结论

仅记录主人已经明确说出的结论。先 read 当前项目，确认任务和验收版本。决定输入：

```json
{
  "projectId": "精确项目编号",
  "revision": 3,
  "taskId": "task-id",
  "kind": "decision",
  "itemId": "decision-id",
  "answer": "采用方案 A",
  "note": "用户原话：采用方案 A。来源：会话/消息编号；日期：2026-11-14"
}
```

验收输入同样带 projectId/revision/taskId/itemId，kind=acceptance，附 itemRevision（当前验收版本）、result=passed 或 changes_requested，note 保留用户原话和来源。changes_requested 必须填写修改意见。

```powershell
node coordinator/scripts/client.mjs feedback feedback.json
node coordinator/scripts/client.mjs read <projectId>
```

feedback 调用已有 project.feedback，不发起新任务、不带虚构 requestId。超时读 history 确认，不能盲重发；冲突重新读取。项目完成状态仍由项目主 agent 跟进。主 agent 用 overview 现读状态，用 message 转达用户原话，输入详见现有项目协作 skill 的 references/bridge.md。

## 长期记忆

```json
{
  "id": "owner-preference-001",
  "kind": "user",
  "date": "2026-11-14T12:00:00Z",
  "source": "主人 / Orca 会话 / 消息编号",
  "text": "用户明确说出的长期偏好原话"
}
```

```powershell
node workspace/workspace.mjs remember memory.json
git -C "$env:AGENTBOAT_HOME/memory" diff --cached
```

kind=inference 存 inferences.md；kind=external 要加 workspaceId，存 external/<workspaceId>.md。来源可包含检索链接、证据和外部开放范围，重复 id 拒绝追加。脚本不自行判断一段话是否为主人授权，由主 agent 按 skill 核实；项目状态留在插件，对话原文用 Orca search。

## 验证

```powershell
$env:AGENTBOAT_SANDBOX = 'D:\agentboat-sandbox'   # 不设时用系统临时目录下的 agentboat-sandbox
$env:AGENTBOAT_HOME = 'D:\agentboat-sandbox\agentboat-demo-home'
$env:AGENTBOAT_TEST_ONLY = '1'
node --test workspace/workspace.test.mjs
```

测试模式将立项/派活限制在 sandbox 下名称含 agentboat-demo 的目录，并核对目录链接。测试主 agent 用明确设置的便宜模型和短目标；不得向真实项目写入，不改工作间主绑定。实时立项、派活与清理证据见本目录 T6-delivery.md；单元检查不代替真实 Orca 启动结果。
