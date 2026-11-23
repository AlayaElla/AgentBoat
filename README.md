# AgentBoat

AgentBoat 在 Orca 里汇总各项目的进展、待决定事项和成果验收，主会话和项目分工可选择当前工作区在 Orca 中启用的代理。

## 安装

需要 Orca 1.4.261 或更新版本、Git 和 Node.js 22 或更新版本。先启动 Orca，再在终端运行：

```sh
orca plugin install AlayaElla/AgentBoat
```

不写版本号时安装最新版本。要装指定版本，在后面加 `@vX.Y.Z`，例如 `AlayaElla/AgentBoat@v0.1.15`。

Orca 会显示来源、权限和审批指纹。核对插件为 `alayaella.agentboat`、来源为 `AlayaElla/AgentBoat`，然后按回执里的命令批准。点击 Orca 底部状态栏的「工作间」打开面板。

## 首次设置

打开一次「工作间」后，在同一个 Orca 用户环境下通过固定入口运行首次设置。

**Windows PowerShell**

```powershell
$orcaData = if ($env:ORCA_USER_DATA_PATH) { $env:ORCA_USER_DATA_PATH } else { Join-Path $env:APPDATA orca }
$entry = Join-Path $orcaData 'agentboat-current'
node (Join-Path $entry 'setup.mjs')
```

**macOS 或 Linux**

```sh
case "$(uname -s)" in
  Darwin) orca_data="$HOME/Library/Application Support/orca" ;;
  *) orca_data="${XDG_CONFIG_HOME:-$HOME/.config}/orca" ;;
esac
entry="${ORCA_USER_DATA_PATH:-$orca_data}/agentboat-current"
node "$entry/setup.mjs"
```

命令会列出两份角色 skill 的安装路径，包括 `~/.agents/skills`、`~/.claude/skills` 下的链接和 `~/.gemini/config/skills` 下的 Antigravity 副本。输入 `yes` 后先把已有内容备份到 `~/.agentboat/backups/setup-*`，再同步 skill 并合并 `~/.claude/settings.json` 和 `~/.codex/hooks.json` 中的 hooks（设置了 `CODEX_HOME` 时使用该目录）。

已有安装首次启用 Antigravity 时，运行一次上述首次设置，再在目标工作区打开新的 Orca Antigravity 会话。也可在 agy 终端用 `/skills` 核对 `agentboat-workspace` 和 `orca-project-coordinator`。使用 Codex CLI 时，在新会话中输入 `/hooks`，核对并信任 AgentBoat 的 hooks。[Antigravity 官方技能文档](https://antigravity.google/docs/skills#cli-skill-locations)

## 开始使用

1. 打开「工作间 → 设置 → 主 agent」，选择一个在线会话，点击「设为主 agent」，或选择工作区和代理新开主会话。按接管提示让该会话完成绑定，回到面板查看绑定状态。
2. 在 Orca 添加要协作的项目，然后在该项目的主会话说「开启项目协作」，按提示绑定并给出第一个任务。也可以在工作间主会话要求它新建或接入一个项目。
3. 要连接另一个工作间，在「工作间 → 设置 → 工作间连接 → 邀请或加入」生成连接码，对方用同一页面加入，再分别设置开放范围。两台电脑需要可互通的网络。参见[工作间连接](coordinator/LINKS.md)。

飞书和 Hermes 可在「工作间 → 设置 → 外部连接」按需添加，使用各自的应用或服务配置。

## 升级

```sh
orca plugin update alayaella.agentboat
```

有新权限时按 Orca 回执审核。插件启动时会按该 Orca 配置的 `current` 更新 `agentboat-current`（Windows 目录联接，macOS 或 Linux 目录符号链接）。已在运行的会话可继续使用同一个 `agentboat-current/coordinator/scripts/client.mjs`，相关说明和 hooks 也随入口更新。入口被删除时，重启插件即可重建；若该位置已有其他内容，先将其移开。

升级会自动刷新已安装的两份 skill，开启新会话即可加载。收到 hooks 变化提醒时，重跑首次设置，并在 Codex 的 `/hooks` 中核对登记。

## 维护

```sh
npm --prefix coordinator ci
node coordinator/scripts/release.mjs vX.Y.Z <仓库外尚不存在的目录>
```

脚本先跑类型检查和测试，再构建独立的发布目录，验证两种 hooks 的首次设置和 Orca 清单，并生成包含插件产物的 Git 提交和版本 tag。审核后可推送脚本打印的单个 tag。每个版本只发布一次，新版本使用新的 tag。
