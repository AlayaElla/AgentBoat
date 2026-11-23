import code from './templates/code.json' with { type: 'json' };

export const backupDefaults = primary => code.backupAgents[primary === 'codex' ? 'claude' : 'codex'];

export function availableBackup(primary, installed) {
  const preferred = backupDefaults(primary);
  if (installed.some(a => a.id === preferred.agent)) return preferred;
  const others = installed.filter(a => a.id !== primary);
  const choice = others.find(a => a.default) ?? others[0];
  if (choice) return Object.hasOwn(code.backupAgents, choice.id) ? code.backupAgents[choice.id] : { agent: choice.id };
}

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
