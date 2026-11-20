import { isRecentAgent, type Project, type LiveAgent, type AgentsSnapshot, type AgentSession, type MainStatus } from './model'
import type { HostApi, HostResult } from 'orca/host'
import { projectKey } from './store'

export type { LiveAgent, AgentsSnapshot } from './model'
type Read = (args: string[]) => Promise<any>
export const maxAgentWorkspaces = 256, maxAgents = 2000

// Host status is authoritative; worker history only identifies a saved execution.
export async function readAgents(host: HostApi<'worker'>, read: Read, projects: Project[], main?: AgentSession): Promise<AgentsSnapshot> {
  const at = Date.now()
  try {
    const signal = AbortSignal.timeout(12_000)
    const list = await host.call('workspace.list', {}, { signal })
    const visible = new Map(projects.filter(p => !p.hidden).map(p => [p.ref.id, p]))
    const workspaceId = main?.workspace.replace(/^id:/, '')
    const mainWorkspace = list.workspaces.find(w => (w.hostId ?? 'local') === 'local' && w.id === workspaceId)
    let status: MainStatus = { state: 'unknown' }
    const sample = (state: string, since: number): MainStatus => {
      if (!Number.isFinite(since) || since <= 0 || !['working', 'blocked', 'waiting', 'done'].includes(state)) return { state: 'unknown' }
      const mapped = agentState(state as HostResult<'agents.list'>['agents'][number]['state'])
      return mapped === 'done' ? { state: 'idle' } : { state: mapped, since }
    }
    if (main && main.handle.startsWith('orca_session_id:')) {
      try {
        const inventory = await read(['worktree', 'ps', '--limit', '10000', '--agent-wait'])
        const matches = inventory.worktrees.filter((w: any) => w.address?.environment === 'local' && (w.hostId ?? 'local') === 'local' && w.address.worktree === main.workspace)
          .flatMap((w: any) => w.agents ?? []).filter((a: any) => !a.parentPaneKey && main.handle === 'orca_session_id:' + /^structured-agent-session-(.+):[^:]+$/.exec(a.paneKey ?? '')?.[1])
        if (!inventory.truncated && !inventory.hostScope?.omittedHostIds?.includes('local')) {
          if (!matches.length || matches.length === 1 && matches[0].subagentObservation === 'exited') status = { state: 'offline' }
          else if (matches.length === 1) status = sample(matches[0].state, matches[0].stateStartedAt)
        }
      } catch { status = { state: 'unknown' } }
    }
    const local = list.workspaces.filter(w => (w.hostId ?? 'local') === 'local' && w.projectId && visible.has(projectKey('local', w.projectId)))
    if (mainWorkspace) { const index = local.indexOf(mainWorkspace); if (index >= 0) local.splice(index, 1); local.unshift(mainWorkspace) }
    let truncated = list.truncated || local.length > maxAgentWorkspaces
    const workers = new Map<string, any[]>(), agents: LiveAgent[] = []
    workspaces: for (const w of local.slice(0, maxAgentWorkspaces)) {
      const projectId = projectKey('local', w.projectId!), project = visible.get(projectId)
      signal.throwIfAborted()
      const result = await host.call('agents.list', { workspaceId: w.id }, { signal }).catch(error => {
        if (w === mainWorkspace && !project) return { agents: [] }
        throw error
      })
      if (main && w === mainWorkspace && !main.handle.startsWith('orca_session_id:')) {
        const matches = result.agents.filter(a => a.terminalId === main.handle)
        if (matches.length === 1 && result.agents.length < 50) status = sample(matches[0].state, matches[0].stateStartedAt)
      }
      if (!project) continue
      // Host caps each workspace at 50 without a truncation flag; do not present that boundary as a full count.
      if (result.agents.length >= 50) truncated = true
      if (!workers.has(projectId) && result.agents.some(a => a.terminalId)) {
        let rows: any[] = []
        if (project?.runId && project.tasks.some(t => t.executions.length)) {
          try {
            const list = await read(['orchestration', 'worker-list', '--run', project.runId])
            if (!list.nextCursor && !list.truncated && Array.isArray(list.workers)) rows = list.workers
          } catch { /* Status remains readable when execution history is unavailable. */ }
        }
        workers.set(projectId, rows)
      }
      for (const a of result.agents) {
        const since = a.stateStartedAt
        if (!Number.isFinite(since) || !['working', 'waiting', 'blocked', 'done'].includes(a.state)) throw Error('实时状态无效')
        const state = agentState(a.state)
        if (!isRecentAgent({ state, since }, at)) continue
        if (agents.length >= maxAgents) { truncated = true; break workspaces }
        const identity = a.terminalId || a.sessionId
        const matches = (workers.get(projectId) ?? []).filter(d =>
          a.terminalId && [d.agentTerminalHandle, d.terminal, d.resource?.terminalHandle].includes(a.terminalId))
        const dispatch = matches.length === 1 ? matches[0] : undefined
        const tasks = dispatch ? project?.tasks.filter(t => t.executions.some(e => e.dispatchId === (dispatch.dispatchId ?? dispatch.dispatch?.id))) ?? [] : []
        const task = tasks.length === 1 ? tasks[0] : undefined
        const taskTitle = task?.title || a.task?.title
        agents.push({ id: `${w.id}:${identity ?? agents.length}`, projectId, agent: a.agent || '', role: dispatch ? 'worker' : 'session',
          state, rawState: a.state, workspaceId: w.id, ...(a.terminalId ? { terminalId: a.terminalId } : {}),
          title: taskTitle || a.title || '会话', ...(task ? { taskId: task.id } : {}), ...(taskTitle ? { taskTitle } : {}), since })
      }
    }
    if (main && !main.handle.startsWith('orca_session_id:') && status.state === 'unknown') {
      try {
        const inventory = await read(['terminal', 'list', '--limit', '10000'])
        const matches = inventory.terminals.filter((terminal: any) => terminal.handle === main.handle)
        if (!inventory.truncated && !inventory.hostScope?.omittedHostIds?.includes('local') && (!matches.length || matches.length === 1 && matches[0].connected === false)) status = { state: 'offline' }
      } catch { status = { state: 'unknown' } }
    }
    return { ok: true, at, agents, ...(main ? { main: { handle: main.handle, status } } : {}), ...(truncated ? { truncated: true } : {}) }
  } catch { return { ok: false, at, agents: [], error: 'agent 状态读不到' } }
}
export function agentState(state: HostResult<'agents.list'>['agents'][number]['state']): LiveAgent['state'] {
  return state === 'waiting' || state === 'blocked' ? 'need' : state === 'working' ? 'work' : 'done'
}
