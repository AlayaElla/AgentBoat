export interface ProjectRef {
  id: string
  name: string
  path: string
  repoId: string
  hostId: string
  workspace: string
}
export interface Artifact { id: string; label: string; url: string; version: string }
export interface UserFeedback { at: string; revision: number; result: string; note: string }
export interface Acceptance {
  id: string; title: string; details: string; artifactIds: string[]; revision: number
  status: 'pending' | 'passed' | 'changes_requested'; history: UserFeedback[]
  fingerprint: string
}
export interface Decision {
  id: string; question: string; options: string[]; answer?: string; history: UserFeedback[]
}
export interface Task {
  id: string; title: string; goal: string; progress: string
  phase: 'working' | 'ready' | 'completed' | 'blocked' | 'paused'
  executions: { runId: string; taskId: string; dispatchId: string; agent: 'codex' | 'claude' }[]
  artifacts: Artifact[]; acceptance: Acceptance[]; decisions: Decision[]; sourceIds: string[]
  updatedAt: string
}
export interface SourceEvent {
  id: string; source: string; sourceId: string; threadId: string; chatId: string
  senderId: string; text: string; receivedAt: string; taskId?: string
  replyToIds?: string[]
}
export interface FeedbackTarget {
  projectId: string; taskId: string; kind: 'decision' | 'acceptance'; itemId: string; itemRevision: number; fingerprint: string
}
export interface Delivery {
  id: string; subject: string; body: string
  noticeKeys?: string[]
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
  hidden?: boolean
  updatedAt?: string
  roles: { design: 'codex' | 'claude'; code: 'codex' | 'claude'; review: 'codex' | 'claude' }
  tasks: Task[]; events: SourceEvent[]; deliveries: Delivery[]; requests: { id: string; fingerprint: string }[]
}
export interface ConnectionState { state: 'off' | 'connecting' | 'connected' | 'error'; message: string }
export interface Snapshot {
  mainAgent?: 'claude' | 'codex'
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
export interface WorkspaceBinding {
  revision: number; runId: string; session?: AgentSession; boundAt?: string
  projectNames?: string[]; takeover?: MainTakeover
  previousNotice?: Delivery['state']
  securityBoundary?: string
  check?: { canTakeOver: true; message: string; runId: string; session: AgentSession }
}
export interface Workspace extends WorkspaceBinding {
  version: 1; requests: { id: string; fingerprint: string }[]
  takeover?: MainTakeover & { tokenHash: string }
  retired?: Delivery[]
}
export type TaskState = ReturnType<typeof taskState>
export type Attention = {
  projectId: string; taskId: string
  itemId: string; title: string; summary: string
} & ({ kind: 'review'; itemRevision: number; fingerprint: string } | { kind: 'decision' | 'blocked' | 'rework' })
export interface Overview {
  connections?: import('./connections').Connection[]
  machines?: { id: string; name: string; role: 'host' | 'client'; online?: boolean }[]
  hidden?: ProjectRef[]
  links?: import('./links').LinksSnapshot
  workspace: WorkspaceBinding
  attention: Attention[]
  projects: {
    ref: ProjectRef; counts: Record<TaskState, number>; updatedAt: string; bound: boolean
    agents: (Task['executions'][number] & { projectTaskId: string; state: TaskState })[]
  }[]
  error?: string
}

export function taskState(task: Task): 'working' | 'decision' | 'review' | 'rework' | 'completed' | 'blocked' | 'paused' {
  if (task.phase === 'paused') return 'paused'
  if (task.decisions.some(x => x.answer === undefined)) return 'decision'
  if (task.acceptance.some(x => x.status === 'changes_requested')) return 'rework'
  if (task.phase === 'ready' && task.acceptance.some(x => x.status === 'pending')) return 'review'
  if (task.phase === 'ready') return 'completed'
  return task.phase
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
export const phases: Record<string, string> = { working: labels.working, ready: labels.review, completed: labels.completed, blocked: labels.blocked, paused: labels.paused }
export const roles = { design: '设计', code: '代码', review: '审查' }
export const agents = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' }
export const agentName = (v = '') => agents[v as keyof typeof agents] || v || '未知'
export const scopes = { none: '不开放', summary: '项目摘要', details: '含任务详情' }
export function isProjectShared(project: Pick<Project, 'ref' | 'hidden'>, sharing: Pick<import('./links').Sharing, 'scope' | 'allProjects' | 'projectIds'>): boolean {
  return !project.hidden && sharing.scope !== 'none' && (sharing.allProjects === true || sharing.projectIds.includes(project.ref.id))
}
export const statuses = { connected: '已连接', offline: '离线', pending: '待核对' }
export const connectionStates = { off: '未启用', connecting: '连接中', connected: '已连接', error: '连接异常', unchecked: '未检查' }
export const results: Record<string, string> = { passed: '已通过', changes_requested: '已退回修改', pending: '待验收' }
export const deliveryStates = { pending: '待通知', sending: '正在通知', sent: '已通知', uncertain: '待核对' }
export const sourceName = (s: string) => ({ 'workspace-agent': '主 agent', feishu: '飞书' }[s] || s)

export const mainAgentStates = {
  online: { label: '在线', tone: 'success' },
  unknown: { label: '待命', tone: 'neutral' },
  offline: { label: '离线', tone: 'warning' }
} as const
export interface LiveAgent {
  id: string; projectId: string; agent: string; role: 'worker' | 'session'
  state: 'need' | 'work' | 'done'; rawState: string
  title: string; taskId?: string; since: number
}
export type MainAgentActivity = Pick<AgentSession, 'agent' | 'title' | 'online'>
export type AgentActivity = Pick<LiveAgent, 'agent' | 'role' | 'state' | 'title' | 'since'> & { taskTitle?: string }
export const isRecentAgent = (a: Pick<AgentActivity, 'state' | 'since'>, now = Date.now()) => a.state !== 'done' || now - a.since <= 86_400_000
const agentPriority = { need: 0, work: 1, done: 2 }
export const compareAgentActivity = (a: AgentActivity, b: AgentActivity) => agentPriority[a.state] - agentPriority[b.state] || b.since - a.since
export interface AgentsSnapshot { ok: boolean; at: number; agents: LiveAgent[]; error?: string; truncated?: boolean }
