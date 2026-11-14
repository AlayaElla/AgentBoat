import type { Snapshot, Project, ProjectRef, Overview, WorkspaceBinding, MessagingSnapshot } from './model'
import type { LinksSnapshot, Sharing } from './links'
export {}
declare module 'orca' {
  interface PluginRequests {
    'workspace.butler': { input: import('./butler').ButlerInput; output: import('./butler').ButlerSnapshot }
    'project.visibility': { input: { projectId: string; revision: number; hidden: boolean }; output: Snapshot }
    'project.delete': { input: { projectId: string; revision: number; confirm: string }; output: { deleted: string; exportPath: string } }
    'workspace.requests': { input: { operation: 'read' | 'send' | 'decide' | 'update' | 'attach'; runId?: string; requestId?: string; peerId?: string; id?: string; title?: string; context?: string; expected?: string; links?: string[]; status?: import('./model').RequestState; note?: string; projectId?: string }; output: LinksSnapshot }
    'workspace.links': { input: { operation: 'read' | 'configure' | 'invite' | 'cancel-invite' | 'join' | 'share' | 'revoke' | 'refresh'; revision?: number; id?: string; code?: string; name?: string; enabled?: boolean; host?: string; port?: number; publicUrl?: string; tls?: boolean; certificate?: string; privateKey?: string; scope?: Sharing['scope']; projectIds?: string[]; acceptTasks?: Sharing['acceptTasks'] }; output: LinksSnapshot }
    'workspace.feishu': { input: { operation: 'read' | 'save'; revision?: number; feishu?: Project['feishu']; appSecret?: string }; output: MessagingSnapshot }
    'workspace.reply': { input: { runId: string; eventId: string; requestId: string; text: string }; output: MessagingSnapshot }
    'workspace.overview': { output: Overview }
    'workspace.agent': { input: { operation: 'read' | 'bind'; revision?: number; requestId?: string; runId?: string; caller?: string; currentRunId?: string; token?: string; checkOnly?: boolean }; output: WorkspaceBinding }
    'workspace.agent.targets': { output: { sessions: import('./model').AgentSession[]; workspaces: { workspace: string; name: string; path: string }[] } }
    'workspace.agent.switch': { input: { revision: number; mode: 'existing' | 'new'; handle?: string; workspace?: string; agent?: string }; output: WorkspaceBinding }
    'workspace.entry': { output: { opened: boolean } }
    'workspace.message': { input: { projectId: string; revision: number; requestId: string; runId: string; text: string }; output: Snapshot }
    'projects.list': { output: { projects: ProjectRef[]; error?: string } }
    'project.read': { input: { projectId: string }; output: Snapshot }
    'project.settings': { input: { projectId: string; revision: number; roles: Project['roles']; feishu: Project['feishu']; appSecret?: string }; output: Snapshot }
    'project.feedback': { input: { projectId: string; revision: number; taskId: string; kind: 'acceptance' | 'decision'; itemId: string; itemRevision?: number; result?: string; answer?: string; note?: string }; output: Snapshot }
    'project.deliver': { input: { projectId: string; deliveryId: string }; output: Snapshot }
    'project.openArtifact': { input: { projectId: string; taskId: string; artifactId: string }; output: { opened: boolean } }
    'project.agent': { input: { operation: 'read' | 'bind' | 'submit'; projectId: string; revision?: number; requestId?: string; runId?: string; task?: unknown }; output: Snapshot }
  }
  interface PluginPanelEvents { 'project.changed': { projectId: string }; 'workspace.open': { switching: boolean } }
}
