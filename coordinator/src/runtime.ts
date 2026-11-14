import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import type { AgentSession, Delivery, ProjectRef } from './model'
import { fail, projectKey } from './store'

const execute = promisify(execFile)
export interface CoordinatorRuntime {
  projects(): Promise<ProjectRef[]>
  verifyRun(id: string): Promise<void>
  mainAgent?(id: string): Promise<'claude' | 'codex' | undefined>
  targets?(): Promise<{ sessions: AgentSession[]; workspaces: { workspace: string; name: string; path: string }[] }>
  identify?(handle: string, runId: string): Promise<AgentSession>
  requestTakeover?(handle: string, prompt: string): Promise<void>
  launchMain?(workspace: string, agent: string, prompt: string): Promise<string>
  openOverview?(): Promise<void>
  send(runId: string, delivery: Delivery): Promise<{ requestId?: string }>
}
export class OrcaRuntime implements CoordinatorRuntime {
  constructor(private executable: () => Promise<string>) {}
  private async call(args: string[]): Promise<any> {
    let stdout: string
    try {
      ({ stdout } = await execute(await this.executable(), [...args, '--environment', 'local', '--json', ...(args[0] === 'orchestration' ? ['--full'] : [])], {
        timeout: 25000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, ORCA_ENVIRONMENT: 'local', ...(process.platform === 'win32' ? {
          APPDATA: process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
          LOCALAPPDATA: process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
        } : {}) }
      }))
    } catch (e) {
      const output = (e as {stdout?: string}).stdout
      if (!output) throw e
      try { const reply = JSON.parse(output); throw new Error(reply.error?.message ?? 'Orca 请求未成功') }
      catch (parseError) { if (parseError instanceof SyntaxError) throw e; throw parseError }
    }
    const reply = JSON.parse(stdout)
    if (!reply.ok) throw new Error(reply.error?.message ?? 'Orca 请求未成功')
    return reply.result
  }
  async projects(): Promise<ProjectRef[]> {
    const result = await this.call(['worktree', 'ps'])
    if (result.truncated) fail('Orca 项目列表未完整返回，请先缩小工作区范围')
    const projects = new Map<string, ProjectRef>()
    for (const w of result.worktrees ?? []) {
      if (!w.repoId || !w.path || !w.address?.worktree || w.address.environment !== 'local') continue
      const hostId = w.hostId ?? 'local'
      if (hostId !== 'local') continue
      const id = projectKey(hostId, w.repoId)
      if (!projects.has(id) || w.isMainWorktree) projects.set(id, {
        id, repoId: w.repoId, hostId, name: w.repo || w.displayName || path.basename(w.path),
        path: w.path, workspace: w.address.worktree
      })
    }
    return [...projects.values()]
  }
  async verifyRun(id: string): Promise<void> {
    if (!/^run_[\w-]+$/.test(id)) fail('Run 编号格式不正确')
    const result = await this.call(['orchestration', 'run-show', '--id', id])
    if (result.run?.id !== id) fail('Orca 未返回对应 Run')
  }
  async targets() {
    const [ps, list] = await Promise.all([this.call(['worktree', 'ps', '--limit', '10000', '--agent-wait']), this.call(['terminal', 'list', '--limit', '10000'])])
    if (ps.truncated || list.truncated || ps.hostScope?.omittedHostIds?.includes('local')) fail('会话列表不完整，请恢复 Orca 后重试')
    return mainTargets(ps.worktrees ?? [], list.terminals ?? [])
  }
  async identify(handle: string, runId: string) {
    const current = await this.call(['orchestration', 'run-current', '--from', handle])
    if (current.run?.id !== runId) fail('Run 不是调用会话自己创建或绑定的协调 Run')
    const session = (await this.targets()).sessions.find(s => s.handle === handle)
    if (!session || session.online !== 'online') fail('无法核实调用会话在线或身份，请从当前主 agent 会话调用')
    return session
  }
  async requestTakeover(handle: string, prompt: string) {
    await this.call(['orchestration', 'send', '--from', 'plugin:local.project-coordinator', '--to', handle, '--type', 'status', '--subject', '请接管工作间主 agent', '--body', prompt])
  }
  async launchMain(workspace: string, agent: string, prompt: string) {
    const result = await this.call(['agent', 'launch', '--agent', agent, '--worktree', workspace, '--prompt', prompt])
    const launch = result.launch
    const handle = launch?.outcome?.handle ?? result.agentTerminalHandle
    if (!handle || !['journaled', 'handed-to-terminal'].includes(launch?.prompt?.outcome)) fail('启动或提示词回执待核对，不会自动重启')
    return handle as string
  }
  async openOverview() { await this.call(['plugin', 'open', 'local.project-coordinator', '--panel', 'project-coordinator']) }
  async mainAgent(id: string): Promise<'claude' | 'codex' | undefined> {
    const result = await this.call(['orchestration', 'run-show', '--id', id])
    const handle = result.run?.coordinator_handle
    if (typeof handle !== 'string' || !handle) return
    // Legacy Runs have no coordinator handle; never substitute the project template's default.
    const session = /^orca_session_id:(claude|codex)_/.exec(handle)
    if (session) return session[1] as 'claude' | 'codex'
    const terminal = await this.call(['terminal', 'show', '--terminal', handle])
    const agent = terminal.terminal?.agent ?? terminal.terminal?.agentType
    return agent === 'claude' || agent === 'codex' ? agent : undefined
  }
  async send(runId: string, delivery: Delivery): Promise<{ requestId?: string }> {
    const result = await this.call(['orchestration', 'send', '--from', 'plugin:local.project-coordinator', '--to', `run:${runId}`, '--type', 'status',
      '--subject', delivery.subject, '--body', delivery.body])
    return { requestId: result.mutation?.requestId }
  }
}
// Only runtime-issued handles and explicit liveness are used; saved activity alone is not online evidence.
export function mainTargets(rows: any[], terminals: any[]) {
  const sessions: AgentSession[] = [], workspaces: { workspace: string; name: string; path: string }[] = []
  for (const w of rows) {
    if (w.address?.environment !== 'local' || (w.hostId ?? 'local') !== 'local' || !w.address?.worktree || !w.path || w.isArchived) continue
    const workspace = w.address.worktree, name = w.displayName || w.repo || ''
    workspaces.push({ workspace, name, path: w.path })
    for (const a of w.agents ?? []) {
      if (a.parentPaneKey) continue
      const match = /^structured-agent-session-(.+):[^:]+$/.exec(a.paneKey ?? '')
      const t = terminals.find(t => `${t.tabId}:${t.leafId}` === a.paneKey)
      const handle = match ? `orca_session_id:${match[1]}` : t?.handle
      if (!handle) continue
      const live = match ? a.subagentObservation : t?.connected === true && t?.writable === true && !t?.orphaned ? 'live' : t?.connected === false ? 'exited' : undefined
      sessions.push({ handle, title: a.conversationName || a.displayName || t?.paneTitle || t?.title || '', workspace, workspaceName: name, path: w.path,
        agent: a.agentType || t?.agentType || '', online: live === 'live' ? 'online' : live === 'exited' ? 'offline' : 'unknown' })
    }
  }
  return { sessions, workspaces }
}
export function defaultExecutable(): string {
  return process.env.ORCA_CLI_COMMAND || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'orca', 'resources', 'bin', 'orca.exe') : 'orca')
}
