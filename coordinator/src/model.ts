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
  targetRunId?: string
  state: 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain'
  error?: string; requestId?: string
  external?: { channel: 'feishu'; appId: string; chatId: string; replyTo?: string; messageId?: string; target?: FeedbackTarget; artifacts?: Artifact[]; root?: string }
}
export interface Messaging {
  version: 1; revision: number; feishu: Project['feishu']
  inbox: { appId: string; event: SourceEvent; state: 'pending' | 'done' }[]
  deliveries: Delivery[]
}
export interface MessagingSnapshot extends Messaging { secretSaved: boolean; connection: ConnectionState }
export interface Project {
  version: 1; ref: ProjectRef; revision: number; runId: string
  updatedAt?: string
  roles: { design: 'codex' | 'claude'; code: 'codex' | 'claude'; review: 'codex' | 'claude' }
  feishu: { appId: string; chatIds: string[]; senderIds: string[]; enabled: boolean }
  tasks: Task[]; events: SourceEvent[]; deliveries: Delivery[]; requests: { id: string; fingerprint: string }[]
}
export interface ConnectionState { state: 'off' | 'connecting' | 'connected' | 'error'; message: string }
export interface Snapshot {
  projects: ProjectRef[]; project: Project | null; connection: ConnectionState
  secretSaved: boolean; runtimeError?: string
}
export interface WorkspaceBinding { revision: number; runId: string }
export interface Workspace extends WorkspaceBinding { version: 1; requests: { id: string; fingerprint: string }[] }
export type TaskState = ReturnType<typeof taskState>
export interface Attention {
  projectId: string; taskId: string; kind: 'decision' | 'review' | 'blocked' | 'rework'
  itemId: string; title: string; summary: string
}
export interface Overview {
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
