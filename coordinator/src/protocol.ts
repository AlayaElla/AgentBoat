import type { Snapshot, Project, ProjectRef } from './model'
export {}
declare module 'orca' {
  interface PluginRequests {
    'projects.list': { output: { projects: ProjectRef[]; error?: string } }
    'project.read': { input: { projectId: string }; output: Snapshot }
    'project.settings': { input: { projectId: string; revision: number; roles: Project['roles']; feishu: Project['feishu']; appSecret?: string }; output: Snapshot }
    'project.feedback': { input: { projectId: string; revision: number; taskId: string; kind: 'acceptance' | 'decision'; itemId: string; itemRevision?: number; result?: string; answer?: string; note?: string }; output: Snapshot }
    'project.deliver': { input: { projectId: string; deliveryId: string }; output: Snapshot }
    'project.openArtifact': { input: { projectId: string; taskId: string; artifactId: string }; output: { opened: boolean } }
    'project.agent': { input: { operation: 'read' | 'bind' | 'submit'; projectId: string; revision?: number; requestId?: string; runId?: string; task?: unknown }; output: Snapshot }
  }
  interface PluginPanelEvents { 'project.changed': { projectId: string } }
}
