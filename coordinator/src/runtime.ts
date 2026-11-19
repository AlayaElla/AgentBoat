import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import type { AgentSession, Delivery, ProjectRef } from './model'
import { fail, projectKey } from './store'
import { readAgents, type AgentsSnapshot } from './agents'
import type { Project } from './model'
import type { HostApi } from 'orca/host'
import { agentFlags, launchReceipt, type AgentLaunch } from '../../workspace/agent-launch.mjs'
import { inboxLimit, openRunMail, type OrcaQuestion, type OrcaWorkerRecord } from '../scripts/orca-questions.mjs'
import type { WorkerReport } from '../scripts/worker-reports.mjs'
import { activeUserDataPath, pluginKey, release } from '../scripts/orca-cli.mjs'

const execute = promisify(execFile)
export interface CoordinatorRuntime {
  projects(host: HostApi<'worker'>): Promise<ProjectRef[]>
  verifyRun(id: string, caller?: string): Promise<void>
  targets(): Promise<{ sessions: AgentSession[]; workspaces: { workspace: string; name: string; path: string }[] }>
  identify(handle: string, runId: string, currentRunId?: string): Promise<AgentSession>
  requestTakeover(handle: string, prompt: string, subject?: string): Promise<void>
  launchMain(workspace: string, agent: string, prompt: string, options?: Omit<AgentLaunch, 'agent'>): Promise<string>
  openOverview(): Promise<void>
  removeProject(ref: ProjectRef, host: HostApi<'worker'>): Promise<void>
  agents(projects: Project[], host: HostApi<'worker'>, main?: AgentSession): Promise<AgentsSnapshot>
  mail(runId: string): Promise<{ questions: OrcaQuestion[]; reports: WorkerReport[] }>
  hermesApprovalMode(): Promise<string>
  send(runId: string, delivery: Delivery): Promise<{ requestId?: string }>
}
export class OrcaRuntime implements CoordinatorRuntime {
  constructor(private executable: () => Promise<string>) {}
  private async call(args: string[]): Promise<any> {
    let stdout: string
    try {
      ({ stdout } = await execute(await this.executable(), [...args, '--environment', 'local', '--json', ...(args[0] === 'orchestration' ? ['--full'] : [])], {
        timeout: 25000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, ...(release ? { ORCA_USER_DATA_PATH: activeUserDataPath() } : {}), ...(process.platform === 'win32' ? {
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
  async projects(host: HostApi<'worker'>): Promise<ProjectRef[]> {
    const [list, spaces] = await Promise.all([host.call('project.list', {}), host.call('workspace.list', {}).catch(() => undefined)])
    if (list.truncated) fail('Orca 项目列表未完整返回，请先缩小工作区范围')
    return list.projects.filter(p => (p.hostId ?? 'local') === 'local').map(p => {
      const candidates = spaces?.workspaces.filter(w => w.projectId === p.id && (w.hostId ?? 'local') === 'local') ?? []
      const w = candidates.find(w => path.resolve(w.path) === path.resolve(p.path)) ?? candidates[0]
      return { id: projectKey('local', p.id), repoId: p.id, hostId: 'local', name: p.name,
        path: w?.path ?? p.path, workspace: w ? w.id.startsWith('identity:') ? w.id : `id:${w.id}` : '' }
    })
  }
  async verifyRun(id: string, caller?: string): Promise<void> {
    if (!/^run_[\w-]+$/.test(id)) fail('Run 编号格式不正确')
    const result = await this.call(['orchestration', 'run-show', '--id', id])
    if (result.run?.id !== id) fail('Orca 未返回对应 Run')
    if (caller && result.run.coordinator_handle && result.run.coordinator_handle !== caller) fail('Orca 返回的 Run 协调者与当前会话不符；请在目标会话创建自己的新 Run')
  }
  async targets() {
    // agents.list has no liveness/parent evidence; takeover still requires these exact CLI identities.
    const [ps, list] = await Promise.all([this.call(['worktree', 'ps', '--limit', '10000', '--agent-wait']), this.call(['terminal', 'list', '--limit', '10000'])])
    if (ps.truncated || list.truncated || ps.hostScope?.omittedHostIds?.includes('local')) fail('会话列表不完整，请恢复 Orca 后重试')
    return mainTargets(ps.worktrees ?? [], list.terminals ?? [])
  }
  async identify(handle: string, runId: string, currentRunId?: string) {
    if (currentRunId !== runId) fail('当前会话自报的 Run 与申请不一致；请在目标会话创建自己的 Run，再用 client.mjs main-bind 调用')
    const session = (await this.targets()).sessions.find(s => s.handle === handle)
    if (!session || session.online !== 'online') fail('无法核实目标会话在线或身份；请从目标会话调用 main-bind，已关闭时请主人在面板重新选择')
    return session
  }
  async requestTakeover(handle: string, prompt: string, subject = '【项目协作】请接管工作间主 agent') {
    await this.call(['orchestration', 'send', '--from', `plugin:${pluginKey}`, '--to', handle, '--type', 'status', '--subject', subject, '--body', prompt])
  }
  async launchMain(workspace: string, agent: string, prompt: string, options?: Omit<AgentLaunch, 'agent'>) {
    const launch = await this.call(['agent', 'launch', ...agentFlags({ agent, ...options }), '--worktree', workspace, '--prompt', prompt])
    if (options?.surface === 'chat' && launch.outcome?.kind !== 'structured') fail('聊天会话启动回执待核对，不会自动重启')
    return launchReceipt(launch)
  }
  async openOverview() { await this.call(['plugin', 'open', pluginKey, '--panel', 'project-coordinator']) }
  async agents(projects: Project[], host: HostApi<'worker'>, main?: AgentSession) { return readAgents(host, args => this.call(args), projects, main) }
  async mail(runId: string) {
    // shortcut: Orca inbox has no pagination; scan the newest bounded window.
    const result = await this.call(['orchestration', 'inbox', '--run', runId, '--limit', String(inboxLimit)])
    if (!Array.isArray(result.messages) || result.messages.some((m: any) => !m || m.run_id !== runId)) fail('Orca 运行邮件无法核对')
    return openRunMail(result.messages, runId, async ids => {
      const [taskList, workers] = await Promise.all([
        this.call(['orchestration', 'task-list', '--run', runId]),
        this.questionWorkers(runId, ids)
      ])
      if (!Array.isArray(taskList.tasks) || taskList.runId !== runId) fail('Orca 项目任务状态无法核对')
      return { tasks: taskList.tasks, workers }
    })
  }
  private async questionWorkers(runId: string, ids: Set<string>) {
    const workers: OrcaWorkerRecord[] = [], visited = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await this.call(['orchestration', 'worker-list', '--run', runId, ...(cursor ? ['--cursor', cursor] : [])])
      if (!Array.isArray(page.workers) || !page.page) fail('Orca 执行者状态无法核对')
      for (const worker of page.workers) if (worker?.runId === runId && ids.delete(worker.dispatchId)) workers.push(worker)
      if (!page.page.hasMore || !ids.size) break
      cursor = page.page.nextCursor
      if (!cursor || visited.has(cursor)) fail('Orca 执行者分页无法核对')
      visited.add(cursor)
    } while (true)
    return workers
  }
  async hermesApprovalMode() {
    const home = process.env.HERMES_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes')
    const { stdout } = await execute(process.platform === 'win32' ? path.join(home, 'bin', 'hermes.exe') : 'hermes', ['config', 'get', 'approvals.mode', '--json'], { timeout: 15000, windowsHide: true, maxBuffer: 65536 })
    const mode = JSON.parse(stdout)
    return ['manual', 'smart', 'off'].includes(mode) ? mode : ''
  }
  async removeProject(ref: ProjectRef, host: HostApi<'worker'>) {
    if (ref.hostId !== 'local') fail('只能移除本机项目')
    const setups = await this.call(['project', 'setups'])
    if (!Array.isArray(setups.setups) || setups.truncated) fail('无法确认项目登记，未移除')
    const found = setups.setups.filter((s: any) => s.repoId === ref.repoId && s.hostId === ref.hostId && path.resolve(s.path) === path.resolve(ref.path))
    if (found.length > 1) fail('项目登记不唯一，未移除')
    if (!found.length) {
      if ((await this.projects(host)).some(p => p.id === ref.id)) fail('无法定位项目登记，未移除')
      return
    }
    // --force also bypasses open-session guards; inspect every worktree and terminal immediately before removal.
    const [ps, terminals] = await Promise.all([this.call(['worktree', 'ps', '--limit', '10000', '--agent-wait']), this.call(['terminal', 'list', '--limit', '10000'])])
    assertProjectIdle(ref, ps, terminals)
    await this.call(['project', 'setup-delete', '--setup', found[0].id, '--force'])
    if ((await this.projects(host)).some(p => p.id === ref.id)) fail('Orca 尚未确认移除，工作间记录保留')
  }
  async send(runId: string, delivery: Delivery): Promise<{ requestId?: string }> {
    const result = await this.call(['orchestration', 'send', '--from', `plugin:${pluginKey}`, '--to', `run:${runId}`, '--type', 'status',
      '--subject', delivery.subject.startsWith('【项目协作】') ? delivery.subject : `【项目协作】${delivery.subject}`, '--body', delivery.body])
    return { requestId: result.mutation?.requestId }
  }
}
export function assertProjectIdle(ref: ProjectRef, ps: any, list: any) {
  if (!Array.isArray(ps.worktrees) || !Array.isArray(list.terminals) || ps.truncated || list.truncated || [ps, list].some(s => s.hostScope?.omittedHostIds?.includes('local'))) fail('终端或会话列表不完整，未移除项目')
  const rows = ps.worktrees.filter((w: any) => w.repoId === ref.repoId && (w.hostId ?? 'local') === ref.hostId)
  if (rows.some((w: any) => (w.agents?.length ?? 0) > 0 || w.liveTerminalCount > 0 || w.unverifiableTerminalCount > 0 || w.hasAttachedPty) || list.terminals.some((t: any) => t.repoId === ref.repoId || rows.some((w: any) => t.worktreeId === w.worktreeId || t.workspaceId === w.worktreeId || t.tabId === w.worktreeId))) fail('这个项目还有打开的终端或会话，先关掉再删')
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
export { executable as defaultExecutable } from '../scripts/orca-cli.mjs'
