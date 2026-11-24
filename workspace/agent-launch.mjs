import code from './templates/code.json' with { type: 'json' };

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const sorted = value => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]))
  : value;
// Exact shipped templates, including installations made before backupAgents existed.
const legacyCode = new Set([
  '8daac2a78a9a2ef461a6f9fbb486bbf1160bf97818053cfb7b0e20a4b7971bb7', // v0.1.0–v0.1.6
  '56f70a0f23bdf928129bc1595e7774ac26c70245beca3218f24b52a0f6bc7d83',
  'eec41a8178853129932232b33af900a66dace7e22c9c1f04d42a61f433ea5408',
  'cccc5131c10a09c55a1f0d581504402b32f2bc636c9e7f5d4eb8c6b657abc20d', // v0.1.36
  'c0d7285a2f691d1ba8cd44af2d78f0bf36c544bb51306fce8337398e393db555', // v0.1.37
]);

export function projectTemplate(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('模板编号只允许字母、数字、下划线和连字符');
  const directory = process.env.AGENTBOAT_HOME || path.join(os.homedir(), '.agentboat');
  let value;
  try { value = JSON.parse(readFileSync(path.join(directory, 'templates', id + '.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (id === 'code' && error.code === 'ENOENT') return structuredClone(code); throw error; }
  if (id === 'code' && legacyCode.has(createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex'))) return structuredClone(code);
  return value;
}

export const validAgentId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value);

export function projectAgentLaunch(value) {
  if (!validAgentId(value?.agent)) throw new Error('需要有效的 Orca 代理编号');
  const { agent, model, effort, surface } = value;
  if (model !== undefined && (typeof model !== 'string' || !model.trim())) throw new Error('model 应为非空文本');
  if (effort !== undefined && (typeof effort !== 'string' || !effort.trim() || !model)) throw new Error('effort 需要 model');
  if (surface !== undefined && !['chat', 'terminal'].includes(surface)) throw new Error('surface 应为 chat 或 terminal');
  return { agent, ...(model && { model }), ...(effort && { effort }), ...(surface && { surface }) };
}

const defaultProjectBackup = primary => projectAgentLaunch(primary === code.backupAgent.agent ? code.mainAgent : code.backupAgent);

export function templateLeadAgents(value) {
  const primary = projectAgentLaunch(value.mainAgent);
  return {
    primary,
    backup: value.backupAgent === undefined ? defaultProjectBackup(primary.agent) :
      value.backupAgent === null ? null : projectAgentLaunch(value.backupAgent),
  };
}

export function templateLeadPreferences(value) {
  return isDeepStrictEqual(value, code) ? undefined : templateLeadAgents(value);
}

export function projectLeadAgents(settings, activeAgent) {
  if (settings?.primary && settings.backup !== undefined) return settings;
  const defaults = templateLeadAgents(projectTemplate('code'));
  const primary = settings?.primary ?? defaults.primary;
  let backup = settings?.backup;
  if (backup === undefined) {
    const agent = activeAgent || primary.agent;
    backup = defaults.backup?.agent === agent ? defaultProjectBackup(agent) : defaults.backup;
  }
  return { primary, backup };
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
