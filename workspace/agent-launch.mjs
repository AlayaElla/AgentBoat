import code from './templates/code.json' with { type: 'json' };

export const projectLeadDefaults = code.mainAgent;

export function agentFlags(role) {
  return ['--agent', role.agent, ...(role.model ? ['--model', role.model] : []), ...(role.effort ? ['--effort', role.effort] : []), ...(role.surface ? ['--surface', role.surface] : [])];
}

export function launchReceipt(launch) {
  const handle = launch?.outcome?.kind === 'structured' ? (launch.outcome.sessionId && `orca_session_id:${launch.outcome.sessionId}`) : launch?.outcome?.handle;
  if (!handle || !['journaled', 'handed-to-terminal'].includes(launch.prompt?.outcome)) {
    throw new Error('未确认 agent 收到提示词，启动回执待核对，不要重复启动');
  }
  return handle;
}
