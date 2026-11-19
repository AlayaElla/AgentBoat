export interface ProjectRef {
  id: string
  name: string
  path: string
  repoId: string
  hostId: string
  workspace: string
}
export interface Artifact { id: string; label: string; url: string; version: string }
interface UserFeedback { at: string; revision: number; result: string; note: string; source?: string }
export interface Acceptance {
  id: string; title: string; details: string; artifactIds: string[]; revision: number
  status: 'pending' | 'passed' | 'changes_requested'; history: UserFeedback[]
  fingerprint: string
}
interface Decision {
  id: string; question: string; options: string[]; answer?: string; history: UserFeedback[]
}
export interface Task {
  id: string; title: string; goal: string; progress: string
  phase: 'working' | 'ready' | 'completed' | 'blocked' | 'paused'
  executions: { runId: string; taskId: string; dispatchId: string; agent: 'codex' | 'claude' }[]
  artifacts: Artifact[]; acceptance: Acceptance[]; decisions: Decision[]; sourceIds: string[]
  updatedAt: string
  submittedAt?: string
}
export interface SourceEvent {
  id: string; source: string; sourceId: string; threadId: string; chatId: string
  senderId: string; text: string; receivedAt: string; taskId?: string
  replyToIds?: string[]
}
interface FeedbackTarget {
  projectId: string; taskId: string; kind: 'decision' | 'acceptance'; itemId: string; itemRevision: number; fingerprint: string
}
export interface Delivery {
  id: string; subject: string; body: string
  noticeKeys?: string[]
  runNotice?: { stage: 'project' | 'workspace'; projectId: string; runId: string; attemptedAt?: number }
  receiptHash?: string
  linkMessageHash?: string
  targetRunId?: string
  state: 'pending' | 'sending' | 'sent' | 'uncertain'
  error?: string; requestId?: string
  external?: { channel: 'feishu'; appId: string; chatId: string; replyTo?: string; messageId?: string; target?: FeedbackTarget; artifacts?: Artifact[]; root?: string }
}
export interface FeishuConfig { appId: string; chatIds: string[]; senderIds: string[]; enabled: boolean }
export interface Messaging {
  version: 1; revision: number; feishu: FeishuConfig
  inbox: { appId: string; event: SourceEvent; state: 'pending' | 'done' }[]
  deliveries: Delivery[]
}
export interface MessagingSnapshot extends Messaging { secretSaved: boolean; connection: ConnectionState }
export interface Project {
  version: 1; ref: ProjectRef; revision: number; runId: string
  mainAgentHandle?: string
  mainSession?: AgentSession
  takeover?: StoredTakeover
  hidden?: boolean
  updatedAt?: string
  archive?: { id: string; start: number; end: number }
  roles: { design: 'codex' | 'claude'; code: 'codex' | 'claude'; review: 'codex' | 'claude' }
  tasks: Task[]; events: SourceEvent[]; deliveries: Delivery[]; requests: { id: string; fingerprint: string }[]
}
export interface ConnectionState { state: 'off' | 'connecting' | 'connected' | 'error'; message: string }
export interface Snapshot {
  mainAgent?: keyof typeof agents
  lead?: WorkspaceBinding
  workspaceTarget?: ProjectWorkspace
  projects: ProjectRef[]; project: Project | null; runtimeError?: string
}
export type ProjectWorkspace = { workspaceId: string; multipleConversations?: boolean } | { error: string }
export interface AgentSession {
  handle: string; title: string; workspace: string; workspaceName: string; path: string; agent: string
  online: 'online' | 'offline' | 'unknown'
}
export interface MainTakeover {
  id: string; target: AgentSession; expiresAt: string; state: 'sending' | 'waiting' | 'uncertain' | 'expired'
  error?: string
}
export type StoredTakeover = MainTakeover & { tokenHash: string; mode?: 'existing' | 'new' }
export type LeadSwitch = { revision: number; mode: 'existing' | 'new' | 'cancel'; handle?: string; workspace?: string; agent?: string }
export interface ProjectLead {
  binding: WorkspaceBinding
  sessions: AgentSession[]
  defaultAgent: string
  workspaceError?: string
}
export interface WorkspaceBinding {
  revision: number; runId: string; session?: AgentSession; boundAt?: string
  projectNames?: string[]; takeover?: MainTakeover
  previousNotice?: Delivery['state']
  securityBoundary?: string
  check?: { canTakeOver: true; message: string; runId: string; session: AgentSession }
}
export interface Workspace extends WorkspaceBinding {
  version: 1; requests: { id: string; fingerprint: string }[]
  takeover?: StoredTakeover
  retired?: Delivery[]
}
type TaskState = ReturnType<typeof taskState>
export type Attention = {
  projectId: string; taskId: string
  itemId: string; title: string; summary: string
} & ({ kind: 'review'; itemRevision: number; fingerprint: string } | { kind: 'decision' | 'blocked' | 'rework' })
export interface OwnerQuestion { id: string; projectId: string; runId: string; from: string; title: string; body: string; at: number; report?: import('../scripts/worker-reports.mjs').WorkerReport }
export const isRunNotice = (id: string) => /^(?:orca-question|orca-report|orca-mail):/.test(id)
export interface Overview {
  connections?: import('./connections').Connection[]
  machines?: { id: string; name: string; role: 'host' | 'client'; online?: boolean }[]
  hidden?: ProjectRef[]
  links?: import('./links').LinksSnapshot
  workspace: WorkspaceBinding
  attention: Attention[]
  questions?: OwnerQuestion[]
  reports?: OwnerQuestion[]
  projects: {
    ref: ProjectRef; revision: number; counts: Record<TaskState, number>; updatedAt: string; bound: boolean
    agents: (Task['executions'][number] & { projectTaskId: string; state: TaskState })[]
  }[]
  error?: string
}

export function taskState(task: { phase: Task['phase']; decisions: Pick<Decision, 'answer'>[]; acceptance: Pick<Acceptance, 'status'>[] }): keyof typeof labels {
  if (task.phase === 'paused') return 'paused'
  if (task.decisions.some(x => x.answer === undefined)) return 'decision'
  if (task.acceptance.some(x => x.status === 'changes_requested')) return 'rework'
  if (task.phase === 'ready' && task.acceptance.some(x => x.status === 'pending')) return 'review'
  if (task.phase === 'ready') return 'completed'
  return task.phase
}

export function attention(project: Project): Attention[] {
  if (project.hidden) return []
  return project.tasks.flatMap(task => {
    const base = { projectId: project.ref.id, taskId: task.id, title: task.title }
    const items: Attention[] = task.decisions.filter(d => d.answer === undefined).map(d => ({ ...base, kind: 'decision', itemId: d.id, summary: d.question }))
    items.push(...task.acceptance.filter(a => a.status === 'pending' && task.phase === 'ready').map(a => ({ ...base, kind: 'review' as const, itemId: a.id, summary: a.title, itemRevision: a.revision, fingerprint: a.fingerprint })))
    items.push(...task.acceptance.filter(a => a.status === 'changes_requested').map(a => ({ ...base, kind: 'rework' as const, itemId: a.id, summary: a.history.at(-1)?.note || a.title })))
    if (task.phase === 'blocked') items.push({ ...base, kind: 'blocked', itemId: task.id, summary: task.progress || task.goal })
    return items.map(item => ({ ...item, summary: item.summary.replace(/\s+/g, ' ').slice(0, 300) }))
  })
}
export function projectCounts(p: Project) {
  const counts: Overview['projects'][number]['counts'] = { working: 0, decision: 0, review: 0, rework: 0, completed: 0, blocked: 0, paused: 0 }
  for (const task of p.tasks) counts[taskState(task)]++
  return counts
}

export function projectSummary(p: Project): Overview['projects'][number] {
  return { ref: p.ref, revision: p.revision, counts: projectCounts(p), bound: !!p.runId, updatedAt: p.updatedAt || '',
    agents: p.tasks.flatMap(t => t.executions.map(e => ({ ...e, projectTaskId: t.id, state: taskState(t) }))) }
}

export function groupedAttention(items: Attention[]) {
  const groups = new Map<string, Attention & { count: number }>()
  for (const item of items.filter(i => i.kind !== 'rework')) {
    const key = JSON.stringify([item.projectId, item.taskId, item.kind]), prior = groups.get(key)
    if (prior) prior.count++
    else groups.set(key, { ...item, count: 1 })
  }
  const order = { decision: 0, blocked: 1, review: 3, rework: 4 }
  return [...groups.values()].sort((a, b) => order[a.kind] - order[b.kind])
}

export const labels = { working: '进行中', decision: '待决定', review: '待验收', rework: '修改中', completed: '已完成', blocked: '受阻', paused: '已暂停' }
export const roles = { design: '设计', code: '代码', review: '审查' }
export const agents = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' }
export const agentName = (v = '') => agents[v as keyof typeof agents] || v || '未知'
export const scopes = { none: '不开放', summary: '项目摘要', details: '含任务详情' }
export function isProjectShared(project: Pick<Project, 'ref' | 'hidden'>, sharing: Pick<import('./links').Sharing, 'scope' | 'allProjects' | 'projectIds'>): boolean {
  return !project.hidden && sharing.scope !== 'none' && (sharing.allProjects === true || sharing.projectIds.includes(project.ref.id))
}
export const statuses = { connected: '已连接', offline: '离线', pending: '待核对' }
export const connectionStates = { off: '未启用', connecting: '连接中', connected: '已连接', error: '连接异常', unchecked: '未检查' }

export const mainAgentStates = { online: '在线', unknown: '状态未知', offline: '离线' } as const
export interface LiveAgent {
  id: string; projectId: string; agent: string; role: 'worker' | 'session'
  state: 'need' | 'work' | 'done'; rawState: string
  title: string; taskId?: string; taskTitle?: string; since: number
  workspaceId?: string; terminalId?: string
}
export type MainStatus = { state: 'work' | 'need'; since: number } | { state: 'idle' | 'offline' | 'unknown' }
export type MainAgentActivity = Pick<AgentSession, 'agent' | 'title' | 'online'> & { activity?: MainStatus }
export function mainStatus(session: AgentSession | undefined, live?: AgentsSnapshot): MainStatus {
  if (!session) return { state: 'unknown' }
  if (live?.ok && live.main?.handle === session.handle) return live.main.status
  return { state: session.online === 'offline' ? 'offline' : 'unknown' }
}
export type AgentActivity = Pick<LiveAgent, 'agent' | 'role' | 'state' | 'title' | 'since' | 'taskTitle'>
export const isRecentAgent = (a: Pick<AgentActivity, 'state' | 'since'>, now = Date.now()) => a.state !== 'done' || now - a.since <= 86_400_000
const agentPriority = { need: 0, work: 1, done: 2 }
export const compareAgentActivity = (a: AgentActivity, b: AgentActivity) => agentPriority[a.state] - agentPriority[b.state] || b.since - a.since
export interface AgentsSnapshot { ok: boolean; at: number; agents: LiveAgent[]; main?: { handle: string; status: MainStatus }; error?: string; truncated?: boolean }
