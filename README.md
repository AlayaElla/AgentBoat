# AgentBoat

AgentBoat 在 Orca 里汇总各项目的进展、待决定事项和成果验收，主会话和项目分工可选择当前工作区在 Orca 中启用的代理。

## 1. 安装插件

Windows 和 macOS 使用相同的安装命令。准备好 Orca（Bot 接入建议 1.4.268 或更新版本）、已加入 PATH 的 Git 和独立 Node.js 22 或更新版本，并安装和登录要用的代理。启动 Orca 后，在终端运行：

```sh
orca plugin install AlayaElla/AgentBoat
```

不写版本号时安装最新版本。要装指定版本，在后面加 `@vX.Y.Z`，例如 `AlayaElla/AgentBoat@v0.1.15`。

核对插件 ID `alayaella.agentboat`、来源 `AlayaElla/AgentBoat` 和 Orca 回执中的权限，按回执批准。点底部状态栏的「工作间」。

## 2. 添加 Bot 并绑定主 agent

在 Orca 左侧 **Bots** 点 **＋ → New bot → Start from scratch**，确认运行在本机并选好代理。也可以使用已有的本机 Bot。若左侧没有 Bots，在 Orca 的 **Settings → Bots** 启用。

打开 **工作间 → 设置 → 主 agent → bot**，选 Bot 和代理。首次设置有缺项时，核对页面列出的路径，点 **完成首次设置并设为主 bot**。设置已就绪时，点 **设为主 bot**。刚创建的 Bot 可以点「刷新」加载。

设置会备份将修改的配置，安装两份角色 skill，并合并 Claude Code 与 Codex 的 hooks。用 Codex 时，确认 Codex 会话所在的 PATH 可运行 Node.js 22 或更新版本，再在 Codex CLI 输入 `/hooks`，信任 `SessionStart`、`PreToolUse` 和 `Stop`。回到工作间，等接管完成后在「绑定详情」核对新会话和 **Run**。

## 3. 开始协作

打开 Orca 中本次绑定的 Bot 接管对话，告诉它项目完整路径和第一件事。已有项目也可以在该项目的主会话说「开启项目协作」，等它绑定后交代任务。

跨机协作在「工作间 → 设置 → 工作间连接」配对，并按需设置开放范围。飞书和 Hermes 在「工作间 → 设置 → 外部连接」添加。 [工作间连接](coordinator/LINKS.md) · [飞书](coordinator/FEISHU.md) · [Hermes](coordinator/HERMES.md)

## 命令行设置与排查

也可打开一次「工作间」后，在对应 Orca 用户环境的终端运行 `setup.mjs`。核对路径后输入 `yes`。使用自定义 Orca 配置时，将 `ORCA_USER_DATA_PATH` 指向该配置的数据目录。

**Windows PowerShell**

```powershell
$orcaData = if ($env:ORCA_USER_DATA_PATH) { $env:ORCA_USER_DATA_PATH } else { Join-Path $env:APPDATA orca }
$entry = Join-Path $orcaData 'agentboat-current'
node (Join-Path $entry 'setup.mjs')
```

**macOS**

```sh
orca_data="$HOME/Library/Application Support/orca"
entry="${ORCA_USER_DATA_PATH:-$orca_data}/agentboat-current"
node "$entry/setup.mjs"
```

Codex 用户目录缺省为 `~/.codex`。使用自定义 `CODEX_HOME` 时，在「工作间 → 设置 → 主 agent → 高级选项」填入完整绝对路径，保存后核对预览。命令行入口读取终端的 `CODEX_HOME`。备份和写入记录位于 `~/.agentboat/backups/setup-*`。如果提示同名内容归属未知或属于另一 Orca 配置，先核对报出的路径，再重新预览。

## 升级

```sh
orca plugin update alayaella.agentboat
```

有新权限时按 Orca 回执审核。插件启动时会按该 Orca 配置的 `current` 更新 `agentboat-current`（Windows 目录联接，macOS 或 Linux 目录符号链接）。已在运行的会话可继续使用同一个 `agentboat-current/coordinator/scripts/client.mjs`，相关说明和 hooks 也随入口更新。入口被删除时，重启插件即可重建；若该位置已有其他内容，先将其移开。

升级会自动刷新归属当前 Orca 配置的 skill，开启新会话即可加载。收到 hooks 变化提醒时，打开「工作间 → 设置 → 主 agent」，核对路径后点「确认修复」。用 Codex 时，再按页面提示核对 `/hooks`。

## 维护

```sh
npm --prefix coordinator ci
node coordinator/scripts/release.mjs vX.Y.Z <仓库外尚不存在的目录>
```

脚本先跑类型检查和测试，再构建独立的发布目录，验证两种 hooks 的首次设置和 Orca 清单，并生成包含插件产物的 Git 提交和版本 tag。审核后可推送脚本打印的单个 tag。每个版本只发布一次，新版本使用新的 tag。
