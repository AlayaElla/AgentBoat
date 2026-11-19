export interface AgentLaunch {
  agent: string;
  model?: string;
  effort?: string;
  surface?: 'chat' | 'terminal';
}
export const projectLeadDefaults: AgentLaunch;
export function agentFlags(role: AgentLaunch): string[];
export function launchReceipt(result: unknown): string;
