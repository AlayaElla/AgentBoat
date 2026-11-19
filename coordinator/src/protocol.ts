import type { Snapshot, Project, ProjectRef, Overview, WorkspaceBinding, MessagingSnapshot, LeadSwitch, ProjectLead } from './model'
import type { DelegatedFeedback, FeedbackReply, LinksSnapshot, Sharing } from './links'
export interface ArchivePage {
  end: number; previousEnd?: number; tasks: Project['tasks']
  deliveries: number; events: number; requests: number; history: number
}
declare module 'orca' {
  interface PluginRequests {
    'panel.feedbackState': { input: { change?: import('./feedback-drafts').Delta }; output: import('./feedback-drafts').Sheets }
    'workspace.connections': { input: import('./connections').ConnectionsInput; output: import('./connections').Connection[] | import('./connections').ConnectionDetail }
    'workspace.agents': { input: { refresh?: boolean }; output: import('./model').AgentsSnapshot }
    'workspace.agent.open': { input: { id: string }; output: { opened: boolean; focusedTerminal: boolean } }
    'project.visibility': { input: { projectId: string; revision: number; hidden: boolean; runId?: string; caller?: string }; output: Snapshot }
    'project.delete': { input: { projectId: string; revision: number; confirm: string }; output: { deleted: string; exportPath: string } }
    'workspace.links': { input: { operation: 'read' | 'configure' | 'rename' | 'invite' | 'cancel-invite' | 'join' | 'share' | 'revoke' | 'refresh' | 'relate' | 'send'; runId?: string; requestId?: string; text?: string; files?: string[]; relation?: 'above' | 'below' | 'peer' | null; revision?: number; id?: string; code?: string; name?: string; enabled?: boolean; host?: string; port?: number; publicUrl?: string; tls?: boolean; certificate?: string; privateKey?: string; scope?: Sharing['scope']; allProjects?: boolean; projectIds?: string[]; delegateFeedback?: boolean }; output: LinksSnapshot }
    'workspace.linkFeedback': { input: DelegatedFeedback & { id: string }; output: FeedbackReply }
    'workspace.reply': { input: { runId: string; eventId: string; requestId: string; text: string }; output: MessagingSnapshot }
    'workspace.overview': { output: Overview }
    'workspace.agent': { input: { operation: 'read' | 'bind'; revision?: number; requestId?: string; runId?: string; caller?: string; currentRunId?: string; token?: string; checkOnly?: boolean }; output: WorkspaceBinding }
    'lead.retry': { input: { projectId?: string; revision: number; confirm: boolean }; output: { accepted: boolean } }
    'lead.control': { input: { runId: string; action: import('./model').LeadAction; caller: string; token: string; confirm?: boolean; currentRunId?: string; generation?: number; standbyRunId?: string; note?: string }; output: { useRun?: string; checkRun?: string; park?: string; done?: boolean } }
    'workspace.agent.targets': { output: { sessions: import('./model').AgentSession[]; workspaces: { workspace: string; name: string; path: string }[] } }
    'workspace.agent.switch': { input: LeadSwitch; output: WorkspaceBinding }
    'workspace.projectLead': { input: LeadSwitch & { projectId: string; runId: string }; output: ProjectLead }
    'workspace.entry': { output: { opened: boolean } }
    'workspace.message': { input: { projectId: string; revision?: number; requestId: string; runId: string; text: string }; output: Snapshot & { queued?: string } }
    'projects.list': { output: { projects: ProjectRef[]; error?: string } }
    'project.read': { input: { projectId: string }; output: Snapshot }
    'project.task': { input: { projectId: string; taskId: string }; output: Project['tasks'][number] | null }
    'project.archive': { input: { projectId: string; end?: number }; output: ArchivePage }
    'project.lead': { input: { projectId: string } | (LeadSwitch & { projectId: string }); output: ProjectLead }
    'project.openMain': { input: { projectId: string }; output: { opened: boolean; multipleConversations?: boolean } }
    'project.settings': { input: { projectId: string; revision: number; roles: Project['roles']; runId?: string; caller?: string }; output: Snapshot }
    'project.feedback': { input: { projectId: string; revision?: number; requestId?: string; runId?: string; caller?: string; items: import('./store').FeedbackItem[] }; output: Snapshot }
    'project.deliver': { input: { projectId: string; deliveryId: string }; output: Snapshot }
    'project.openArtifact': { input: { projectId: string; taskId: string; artifactId: string; archiveEnd?: number }; output: { opened: boolean } }
    'project.agent': { input: { operation: 'read' | 'bind' | 'submit'; projectId: string; revision?: number; requestId?: string; runId?: string; caller?: string; currentRunId?: string; token?: string; task?: unknown; taskId?: string }; output: Snapshot & { task?: import('./model').Task; archiveStatus?: '已归档' } }
  }
  interface PluginPanelEvents { 'project.changed': { projectId: string }; 'panel.draftsChanged': {}; 'workspace.open': { switching: boolean } }
}
