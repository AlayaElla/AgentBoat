# AgentBoat

AgentBoat 在 Orca 里汇总各项目的进展、待决定事项和成果验收。每人使用自己的 Claude Code 或 Codex 账号与订阅。

## 安装

需要 Orca 1.4.261 或更新版本、Git 和 Node.js 22 或更新版本。先启动 Orca，再在终端运行：

```sh
orca plugin install AlayaElla/AgentBoat@v0.1.0
```

Orca 会显示来源、权限和审批指纹。核对插件为 `alayaella.agentboat`、来源为 `AlayaElla/AgentBoat`，然后按回执里的命令批准。点击 Orca 底部状态栏的「工作间」打开面板。

## 首次设置

在同一个 Orca 用户环境下运行下面的命令。它从 Orca 当前安装的版本运行首次设置。

**Windows PowerShell**

```powershell
$orcaData = if ($env:ORCA_USER_DATA_PATH) { $env:ORCA_USER_DATA_PATH } else { Join-Path $env:APPDATA orca }
$plugin = Join-Path $orcaData 'plugins/alayaella.agentboat'
$version = (Get-Content (Join-Path $plugin current) -Raw).Trim()
if ($version -match '^[0-9a-f]{64}$') { node (Join-Path $plugin "$version/setup.mjs") } else { throw '找不到 AgentBoat 当前安装版本' }
```

**macOS 或 Linux**

```sh
case "$(uname -s)" in
  Darwin) orca_data="$HOME/Library/Application Support/orca" ;;
  *) orca_data="${XDG_CONFIG_HOME:-$HOME/.config}/orca" ;;
esac
plugin="${ORCA_USER_DATA_PATH:-$orca_data}/plugins/alayaella.agentboat"
version=$(cat "$plugin/current")
if printf '%s\n' "$version" | grep -Eq '^[0-9a-f]{64}$'; then
  node "$plugin/$version/setup.mjs"
else
  printf '%s\n' '找不到 AgentBoat 当前安装版本' >&2
fi
```

命令会列出将写入的两个 skill 目录及 Claude 链接（`~/.agents/skills`、`~/.claude/skills`），还有 `~/.claude/settings.json` 和 `~/.codex/hooks.json`（设置了 `CODEX_HOME` 时使用该目录）。输入 `yes` 后先把已有内容备份到 `~/.agentboat/backups/setup-*`，再同步 skill 并合并 hooks。打开新的 agent 会话加载 skill。在 Codex CLI 输入 `/hooks`，核对并信任 AgentBoat 的 hooks。

## 开始使用

1. 打开「工作间 → 设置 → 主 agent」，选择一个在线的 Claude Code 或 Codex 会话，点击「设为主 agent」。按接管提示让该会话完成绑定，回到面板查看绑定状态。
2. 在 Orca 添加要协作的项目，然后在该项目的主会话说「开启项目协作」，按提示绑定并给出第一个任务。也可以在工作间主会话要求它新建或接入一个项目。
3. 要连接另一个工作间，在「工作间 → 设置 → 工作间连接 → 邀请或加入」生成连接码，对方用同一页面加入，再分别设置开放范围。两台电脑需要可互通的网络。参见[工作间连接](coordinator/LINKS.md)。

飞书和 Hermes 可在「工作间 → 设置 → 外部连接」按需添加，使用各自的应用或服务配置。

## 升级

```sh
orca plugin update alayaella.agentboat
```

有新权限时按 Orca 回执审核。升级后重新运行上面的首次设置命令，将 skill 和 hooks 指向当前安装版本。随后开启新会话并在 Codex 内重新核对 hook 信任。

## 维护

在已合入 Claude 和 Codex hooks 安装器的源码版本上运行：

```sh
npm --prefix coordinator ci
node coordinator/scripts/release.mjs v0.1.0 <仓库外尚不存在的目录>
```

脚本先跑类型检查和测试，再构建独立的发布目录，验证两种 hooks 的首次设置和 Orca 清单，并生成包含插件产物的 Git 提交和版本 tag。审核后可推送脚本打印的单个 tag。每个版本只发布一次，新版本使用新的 tag。
