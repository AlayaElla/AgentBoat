import { isRecentAgent, type Project, type LiveAgent, type AgentsSnapshot } from './model'
import type { HostApi, HostResult } from 'orca/host'
import { projectKey } from './store'

export type { LiveAgent, AgentsSnapshot } from './model'
type Read = (args: string[]) => Promise<any>
export const maxAgentWorkspaces = 256, maxAgents = 2000

// Host status is authoritative; worker history only identifies a saved execution.
export async function readAgents(host: HostApi<'worker'>, read: Read, projects: Project[]): Promise<AgentsSnapshot> {
  const at = Date.now()
  try {
    const list = await host.call('workspace.list', {})
    const local = list.workspaces.filter(w => (w.hostId ?? 'local') === 'local' && w.projectId && !projects.find(p => p.ref.id === projectKey('local', w.projectId!))?.hidden)
    let truncated = list.truncated || local.length > maxAgentWorkspaces
    const workers = new Map<string, any[]>(), agents: LiveAgent[] = []
    workspaces: for (const w of local.slice(0, maxAgentWorkspaces)) {
      const projectId = projectKey('local', w.projectId!), project = projects.find(p => p.ref.id === projectId)
      const result = await host.call('agents.list', { workspaceId: w.id })
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
        const identity = a.sessionId || a.terminalId
        const matches = (workers.get(projectId) ?? []).filter(d =>
          a.terminalId && [d.agentTerminalHandle, d.terminal, d.resource?.terminalHandle].includes(a.terminalId))
        const dispatch = matches.length === 1 ? matches[0] : undefined
        const tasks = dispatch ? project?.tasks.filter(t => t.executions.some(e => e.dispatchId === (dispatch.dispatchId ?? dispatch.dispatch?.id))) ?? [] : []
        const task = tasks.length === 1 ? tasks[0] : undefined
        agents.push({ id: `${w.id}:${identity ?? agents.length}`, projectId, agent: a.agent || '', role: dispatch ? 'worker' : 'session',
          state, rawState: a.state,
          title: task?.title || a.task?.title || a.title || '会话', ...(task ? { taskId: task.id } : {}), since })
      }
    }
    return { ok: true, at, agents, ...(truncated ? { truncated: true } : {}) }
  } catch { return { ok: false, at, agents: [], error: 'agent 状态读不到' } }
}
export function agentState(state: HostResult<'agents.list'>['agents'][number]['state']): LiveAgent['state'] {
  return state === 'waiting' || state === 'blocked' ? 'need' : state === 'working' ? 'work' : 'done'
}
