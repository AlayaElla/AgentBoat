import type { Project } from './model'
import { projectKey } from './store'

export interface LiveAgent {
  id: string; projectId: string; agent: string; role: 'lead' | 'worker' | 'session'
  state: 'need' | 'work' | 'done'; rawState: string; verified: boolean
  title: string; taskId?: string; last: string; tool?: string; since: number; parentId?: string
}
export interface AgentsSnapshot { ok: boolean; at: number; agents: LiveAgent[]; error?: string }
type Read = (args: string[]) => Promise<any>

// Activity comes exclusively from ps; dispatch history only identifies the task.
export async function readAgents(read: Read, projects: Project[]): Promise<AgentsSnapshot> {
  const at = Date.now()
  try {
    const ps = await read(['worktree', 'ps', '--limit', '10000', '--agent-wait'])
    if (!Array.isArray(ps.worktrees) || ps.truncated || ps.hostScope?.omittedHostIds?.includes('local')) throw Error('实时列表不完整')
    const workers = new Map<string, any[]>(), leads = new Map<string, string>()
    await Promise.all(projects.filter(p => p.runId).map(async p => {
      const [list, run] = await Promise.all([read(['orchestration', 'worker-list', '--run', p.runId]), read(['orchestration', 'run-show', '--id', p.runId])])
      if (list.nextCursor || list.truncated) throw Error('执行会话列表不完整')
      workers.set(p.ref.id, list.workers ?? []); leads.set(p.ref.id, run.run?.coordinator_handle)
    }))
    const agents: LiveAgent[] = []
    for (const w of ps.worktrees) {
      if (w.address?.environment !== 'local' || (w.hostId ?? 'local') !== 'local' || w.isArchived || !w.repoId) continue
      const projectId = projectKey('local', w.repoId), project = projects.find(p => p.ref.id === projectId)
      if (project?.hidden) continue
      for (const a of w.agents ?? []) {
        if (!a.paneKey) continue
        const since = typeof a.stateStartedAt === 'number' ? a.stateStartedAt : Date.parse(a.stateStartedAt)
        if (!Number.isFinite(since)) throw Error('实时状态缺少时间')
        if (a.state === 'done' && at - since > 86400000) continue
        const session = /^structured-agent-session-(.+):[^:]+$/.exec(a.paneKey)
        const handle = session ? `orca_session_id:${session[1]}` : a.terminalHandle
        const dispatch = (workers.get(projectId) ?? []).find(d => d.agentTerminalHandle === handle || d.terminal === handle || d.projection?.session?.paneKey === a.paneKey || session && d.resource?.endpointIncarnation === `structured:${session[1]}`)
        const task = dispatch && project?.tasks.find(t => t.executions.some(e => e.dispatchId === (dispatch.dispatchId ?? dispatch.dispatch?.id)))
        agents.push({ id: a.paneKey, projectId, agent: a.agentType || '', role: handle && leads.get(projectId) === handle ? 'lead' : dispatch || a.parentPaneKey ? 'worker' : 'session',
          state: ['blocked', 'waiting'].includes(a.state) ? 'need' : a.state === 'done' ? 'done' : 'work', rawState: a.state,
          verified: a.subagentObservation === 'live', title: task?.title || a.conversationName || a.taskTitle || '会话', ...(task ? { taskId: task.id } : {}),
          last: String(a.lastAssistantMessage || '').slice(0, 200), tool: a.toolName, since, parentId: a.parentPaneKey })
      }
    }
    return { ok: true, at, agents }
  } catch (e) { return { ok: false, at, agents: [], error: e instanceof Error ? e.message : '实时状态读不到' } }
}
