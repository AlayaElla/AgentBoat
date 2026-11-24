# 工作间主 agent

需要独立 Node.js 22 或更新版本、Git，以及已安装 AgentBoat 插件的 Orca 桌面端。按主指南添加本机 Bot，在「工作间 → 设置 → 主 agent → bot」选 Bot 和代理，核对首次设置路径后点「完成首次设置并设为主 bot」。设置就绪后，打开接管对话开始协作。 [AgentBoat 接入指南](../README.md)

下列管理命令从当前 Orca 配置的 `agentboat-current` 入口运行。脚本通过 `ORCA_CLI_COMMAND` 或 Orca 的默认 CLI 路径操作本机工作间。

```powershell
node workspace/workspace.mjs init
node workspace/workspace.mjs templates
```

首次设置将两份角色 skill 安装到 `~/.agents/skills/`，创建 `~/.claude/skills/` 下的目录链接（Windows 使用 junction），并写入 `~/.gemini/config/skills/` 下的 Antigravity 副本。升级会自动刷新归属当前 Orca 配置的 skill，开启新会话即可加载。首次启用 Antigravity 缺副本或收到 hooks 变化提醒时，到「主 agent」页核对路径并确认修复。入口下的 `setup.mjs` 也可用于命令行设置。 [工作间 skill 全文](skill/agentboat-workspace/SKILL.md)

设置向 `~/.claude/settings.json` 和 `${CODEX_HOME}/hooks.json`（缺省 `~/.codex/hooks.json`）各合并三条 AgentBoat hook。用自定义 Codex 用户目录时，在「工作间 → 设置 → 主 agent → 高级选项」填入完整绝对路径，保存后核对预览。命令行入口读取终端的 `CODEX_HOME`。写入前核对同名 skill、链接和 AgentBoat hooks 的归属，保留其他设置及 hook。已有内容备份到 `~/.agentboat/backups/setup-*`，同目录记录已完成项和被替换的 hook 文件位置。

使用 Codex 时，确认 Codex 会话所在的 PATH 可运行 Node.js 22 或更新版本，再在该环境的 CLI 输入 `/hooks`，核对用户级 `hooks.json` 中指向 `agentboat-current/workspace/harness/hook.mjs` 的 `SessionStart`、`PreToolUse` 和 `Stop`，信任后生效。hooks 按工作间已登记的会话匹配角色。 [Codex hooks 文档](https://learn.chatgpt.com/docs/hooks)

工作间管理员应逐条运行获准的管理和只读命令。需要 stdin 时可用 Bash 的输入重定向或 PowerShell 的 `Get-Content -Raw … | node …`。项目主会话用 `client.mjs submit` 登记成果，并在对应任务的 `executions` 里保留 Orca Run、任务和派工编号。

插件只处理仍在执行、最近 24 小时内的回报和问题。回报超过 30 分钟仍未提交，或问题超过 10 分钟仍未回复，先提醒项目主会话一次。首次投递后过 2 小时仍待处理，再提醒工作间主 agent，由它判断是否告知主人。项目主会话实际登记的待决定、受阻和待验收事项进入「等你处理」。

`AGENTBOAT_HOME` 默认 `~/.agentboat`；init 保留已有模板和记忆，不覆盖定制。目录有 templates、memory、projects（立项日志）、assignments（派活日志）、requests（插件请求原文）。记忆有独立 Git 仓库，脚本只暂存不提交；主人的明确内容和推断分开，外部工作间单独目录。所有来源与日志可能含用户原话，按本机私有资料保管，不放凭据。

`client.mjs` 的命令和输入见 [桥接说明](../coordinator/skill/orca-project-coordinator/references/bridge.md)，其中代录主人结论用 `feedback`。工作间连接在插件「设置 → 工作间连接」中管理，`links-*` 命令见 [工作间连接](../coordinator/LINKS.md)。

## 模板与立项

默认 [templates/code.json](templates/code.json) 使用 Antigravity 启动项目主会话，备用使用 Codex。设计由 Antigravity 负责，代码和审查由 Codex 负责，来源为 `empty`。项目设置可以从对应工作区启用的 Orca 代理中修改主备。立项、自动启动和面板新开会话均按项目设置启动，未设置时使用本机默认模板。模板字段 `mainAgent` 和 `backupAgent` 支持 `agent`、`model`、`effort` 和 `surface`，其中 `effort` 需要 `model`，`backupAgent: null` 停用备用。省略 `backupAgent` 时，模板会选择与主用不同的代理。已绑定项目未保存备用偏好时，默认备用会避开当前主会话的代理。模型、强度和会话类型未填时跟随 Orca。原样保留的旧内置模板在读取时自动采用新默认值，定制模板原样读取。

保存 UTF-8 JSON 后调用（支持 BOM）：

```json
{
  "requestId": "create-my-app-001",
  "template": "code",
  "name": "my-app",
  "path": "<新项目的绝对路径>",
  "source": { "kind": "empty" },
  "goal": "先开启项目协作，等待具体需求"
}
```

```powershell
node workspace/workspace.mjs create create.json
```

source 可省略以沿用模板；kind=empty 建不存在的空目录并登记 folder；existing 使用原目录（.git 存在则登记 git）；clone 另附 url，用 Git 克隆到不存在的目标，再通过 Orca 登记。目录准备可用文件系统/Git，登记、项目设置、agent 启动、工作树均经 Orca。已有内容不清理、不初始化 Git、不自动提交，clone 支持 HTTPS/SSH/本机 Git 地址，凭据由 Git 管理。

新 Git 项目的独立工作树目录设在相邻的 `<项目目录名>-worktrees`，只设置新登记项目的 host setup。create 不覆盖已绑定项目。脚本回执为 awaiting-project-binding；项目主 agent 自己开启项目协作、创建 Run 和绑定；读取插件和 run-show 确认后才算立项完成。模板角色会同步到项目设置和首句话。

### 续做中断的立项

从同一个 AgentBoat 入口再运行 `node workspace/workspace.mjs create create.json`，沿用原文件的全部字段和 requestId。原文件遗失时，用 `$AGENTBOAT_HOME/projects/<requestId>.json` 的 `input` 对象还原。脚本按登记回执核对本机 repoId、目录和唯一项目。已经有人绑定主会话时，日志以 `already-bound` 收尾，记录当前 runId 和分工是否匹配模板，保留现有分工。

尚未绑定且已完成显示名设置时，原请求只补缺少的分工并启动一次。若提示核对项目设置，在 Orca 确认原显示名；Git 项目也需核对工作树目录。若已有启动记录，先核对并绑定那次启动的会话，再用原请求收尾。缺少登记回执时先在 Orca 核对原目录；已经登记的项目可用下文的主会话入口接手。同一请求并发运行时只有一份能执行。若进程意外退出且留下 `projects/<requestId>.lock`，核对锁内 PID 已退出后仅移除该锁，保留 JSON 日志。

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

从 `node coordinator/scripts/client.mjs projects` 取得完整项目编号，核对路径、repoId、hostId。项目必须是本机登记且已有提交的 Git 仓库。未绑定项目主 agent 时，工作间主 agent 先自动开主会话。

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

脚本在已绑定的工作间主 agent 会话内运行，从 Orca 环境取实际调用会话。先登记插件任务和项目内 `.agentboat/assignments/` 来源原文，再用 `orca worktree create --no-parent --agent ... --setup skip` 启动执行者并登记回执。启动通知由插件队列投递给项目主 Run，未绑定时等绑定后再投递。独立 agent 完成后读项目当前绑定的 Run 并回报成果。插件任务中保留来源和回执，启动不等于做完或验收。

## 项目主会话自动启动

工作间主 agent 用 `client.mjs message` 转话时，插件先保存原话和待投递记录。项目尚未绑定时，回执显示「项目还没有主会话，已排队」，脚本用默认 `code` 模板开主会话。直接派活使用已保存的项目分工；角色代理与模板一致时，沿用模板的模型、推理强度和启动方式。自动启动保留项目名、文件、Git 和项目已有分工。缺少工作间脚本目录时会先 `init`，保留已有模板和记忆。

回执 `autoLaunch` 包含项目名、状态和已确认的会话 handle、模型、强度及启动方式。最近 10 分钟内已经有一次启动时复用同一份记录。启动回执不明时先核对日志，不换编号重复转话。工作间主 agent 自己的目录不算项目，不在 `projects` 里，也不会自动开。重复登记、远端项目和已绑定项目同样不会自动开。缺少工作区时，先在 Orca 准备工作区，排队的消息仍保留。

派活请求按 requestId 防止二次启动。立项续做规则见上文。失败时查看 projects/assignments 日志和其中完整回执。脚本不会自动清理未知 agent，按 Orca 版本指南恢复，避免重复执行和丢失数据。当前脚本是一次性 CLI，不做常驻轮询，状态与回报由主 agent 会话接收并读取。

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

kind=inference 存 inferences.md；kind=external 要加 workspaceId，存 external/<workspaceId>.md。来源可包含检索链接、证据和外部开放范围，重复 id 拒绝追加。脚本不自行判断一段话是否为主人授权，由主 agent 按 skill 核实。

## 开发和验证

开发、测试、备份、构建与重载流程统一见 [coordinator/README.md](../coordinator/README.md)。辅助脚本测试只操作沙盒下 agentboat-demo 临时目录；不向真实项目写入、不改主绑定，模拟检查不代替真实 Orca 启动结果。
