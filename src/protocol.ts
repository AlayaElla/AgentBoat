import type { Snapshot, Project, ProjectRef, Overview, WorkspaceBinding, MessagingSnapshot, LeadSwitch, ProjectLead } from './model'
import type { DelegatedFeedback, FeedbackReply, LinksSnapshot, Sharing } from './links'
export type ProjectLeadSwitch = Omit<LeadSwitch, 'mode'> & { mode: Exclude<LeadSwitch['mode'], 'bot'> | 'promote' }
export type ProjectLeadRequest = ProjectLeadSwitch & { startOnly?: boolean; template?: string; goal?: string; introduction?: string }
export type SetupPreview = { paths: string[]; backupRoot: string; codexHooks: string; codexHome?: string; confirmation?: string; error?: string }
export type WorkspaceSwitchChoice = Omit<LeadSwitch, 'revision'> & { setupConfirmation?: string }
export interface ArchivePage {
  end: number; previousEnd?: number; tasks: Project['tasks']
  deliveries: number; events: number; requests: number; history: number
}
export type ProjectArtifactRef = import('./link-artifacts').ArtifactRef & { archiveEnd?: number }
declare module 'orca' {
  interface PluginRequests {
    'panel.feedbackState': { input: { change?: import('./feedback-drafts').Delta }; output: import('./feedback-drafts').Sheets }
    'workspace.hermesApprovalMode': { output: string }
    'workspace.connections': { input: import('./connections').ConnectionsInput; output: import('./connections').Connection[] | import('./connections').ConnectionDetail }
    'workspace.agents': { input: { refresh?: boolean }; output: import('./model').AgentsSnapshot }
    'workspace.agent.open': { input: { id: string }; output: { opened: boolean; focusedTerminal: boolean } }
    'project.visibility': { input: { projectId: string; revision: number; hidden: boolean; runId?: string; caller?: string }; output: Snapshot }
    'project.delete': { input: { projectId: string; revision: number; confirm: string }; output: { deleted: string; exportPath: string } }
    'workspace.links': { input: { operation: 'read' | 'configure' | 'rename' | 'invite' | 'cancel-invite' | 'join' | 'share' | 'revoke' | 'refresh' | 'relate' | 'send'; runId?: string; requestId?: string; text?: string; files?: string[]; relation?: 'above' | 'below' | 'peer' | null; revision?: number; id?: string; code?: string; name?: string; enabled?: boolean; host?: string; port?: number; publicUrl?: string; tls?: boolean; certificate?: string; privateKey?: string; scope?: Sharing['scope']; allProjects?: boolean; projectIds?: string[]; delegateFeedback?: boolean }; output: LinksSnapshot }
    'workspace.linkArtifact': { input: import('./link-artifacts').ArtifactRef & { id: string }; output: { name: string; size: number; type: string; key: string; method: import('./link-artifacts').StreamMethod } }
    'workspace.readLinkArtifact': { input: { id: string; key: string; offset: number }; output: string }
    'workspace.linkFeedback': { input: DelegatedFeedback & { id: string }; output: FeedbackReply }
    'workspace.reply': { input: { runId: string; eventId: string; requestId: string; text: string }; output: MessagingSnapshot }
    'workspace.overview': { output: Overview }
    'workspace.agent': { input: { operation: 'read' | 'bind'; revision?: number; requestId?: string; runId?: string; caller?: string; currentRunId?: string; token?: string; checkOnly?: boolean }; output: WorkspaceBinding }
    'lead.history': { input: { projectId?: string; end?: number }; output: { history: import('./model').BackupLead['history']; previousEnd?: number } }
    'lead.retry': { input: { projectId?: string; revision: number; confirm: boolean }; output: { accepted: boolean } }
    'lead.control': { input: { runId: string; action: import('./model').LeadAction; caller: string; token: string; confirm?: boolean; currentRunId?: string; generation?: number; standbyRunId?: string; note?: string }; output: { useRun?: string; checkRun?: string; park?: string; done?: boolean } }
    'workspace.agent.targets': { input: { workspace?: string } | undefined; output: { agentWorkspace: string; availableAgents: import('./model').InstalledAgent[] | null; bots?: import('./model').BotTarget[]; sessions: import('./model').AgentSession[]; workspaces: { workspace: string; name: string; path: string }[]; setup?: SetupPreview; projectUsesCodex?: boolean } }
    'workspace.agent.switch': { input: WorkspaceSwitchChoice & { revision: number }; output: WorkspaceBinding }
    'workspace.setup': { input: { confirmation: string }; output: { completed: string[]; backup?: string } }
    'workspace.setup.codexHome': { input: { path: string }; output: { path: string } }
    'workspace.projectLead': { input: ProjectLeadSwitch & { projectId: string; runId: string }; output: ProjectLead }
    'workspace.entry': { output: { opened: boolean } }
    'workspace.message': { input: { projectId: string; revision?: number; requestId: string; runId: string; text: string; caller?: string; ownerDecision?: NonNullable<import('./model').SourceEvent['ownerDecision']> }; output: Snapshot & { queued?: string } }
    'projects.list': { output: { projects: ProjectRef[]; error?: string } }
    'project.read': { input: { projectId: string }; output: Snapshot }
    'project.task': { input: { projectId: string; taskId: string }; output: Project['tasks'][number] | null }
    'project.archive': { input: { projectId: string; end?: number }; output: ArchivePage }
    'project.lead': { input: { projectId: string } | (ProjectLeadRequest & { projectId: string }); output: ProjectLead }
    'project.openMain': { input: { projectId: string }; output: { opened: boolean; multipleConversations?: boolean } }
    'project.settings': { input: { projectId: string; revision: number; roles?: Project['roles']; leadAgents?: Project['leadAgents']; template?: string; runId?: string; caller?: string }; output: Snapshot }
    'project.feedback': { input: { projectId: string; revision?: number; requestId?: string; runId?: string; caller?: string; items: import('./store').FeedbackItem[]; ownerSource?: { eventId: string } | { messageId: string } }; output: Snapshot }
    'project.workerFeedback': { input: { projectId: string; projectTaskId: string; taskId: string; dispatchId: string; sourceId: string; caller: string }; output: { sourceId: string; requestId: string; state: import('./model').Delivery['state'] | 'recorded' } }
    'project.deliver': { input: { projectId: string; deliveryId: string }; output: Snapshot }
    'project.expireArtifact': { input: { projectId: string; revision: number; taskId: string; artifactId: string }; output: Snapshot }
    'project.openArtifact': { input: ProjectArtifactRef & { connectionId?: string }; output: { opened: boolean } }
    'project.openArtifactFolder': { input: ProjectArtifactRef; output: { opened: boolean } }
    'project.agent': { input: { operation: 'read' | 'bind' | 'submit'; projectId: string; revision?: number; requestId?: string; runId?: string; caller?: string; currentRunId?: string; token?: string; task?: unknown; taskId?: string }; output: Snapshot & { task?: import('./model').Task; submitted?: Pick<import('./model').Task, 'id' | 'phase' | 'submittedAt'> & { pendingAcceptance: boolean; pendingDecision: boolean; decisionQuestionIds?: string[] }; archiveStatus?: '已归档' } }
  }
  interface PluginPanelEvents { 'workspace.artifactProgress': import('./link-artifacts').ArtifactProgress; 'project.changed': { projectId: string }; 'panel.draftsChanged': {}; 'workspace.open': { switching: boolean } }
}
