export interface AgentLaunch {
  agent: string;
  model?: string;
  effort?: string;
  surface?: 'chat' | 'terminal';
}
export function backupDefaults(primary: string): AgentLaunch;
export function agentFlags(role: AgentLaunch): string[];
export function launchReceipt(result: unknown): string;
export interface ProjectLeadAgents {
  primary: AgentLaunch;
  backup: AgentLaunch | null;
}
export function projectTemplate(id: string): unknown;
export function projectAgentLaunch(value: unknown): AgentLaunch;
export function templateLeadAgents(value: unknown): ProjectLeadAgents;
export function projectLeadAgents(settings?: Partial<ProjectLeadAgents>, activeAgent?: string): ProjectLeadAgents;
