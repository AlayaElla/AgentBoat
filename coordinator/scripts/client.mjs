import { executable } from './orca-cli.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeMainRoleCards } from './main-role-card.mjs';

const [operation, argument] = process.argv.slice(2);
const leadBind = operation === 'project-lead-bind', leadSwitch = operation === 'project-lead-switch';
const allowed = ['projects', 'overview', 'main-read', 'main-bind', 'project-lead', 'project-lead-switch', 'project-lead-bind', 'message', 'read', 'bind', 'submit', 'feedback', 'feishu-reply', 'links-read', 'links-refresh', 'links-invite', 'links-cancel-invite', 'links-join', 'links-configure', 'links-rename', 'links-share', 'links-relate', 'links-revoke', 'links-send', 'hide', 'restore', 'delete', 'main-targets', 'connections', 'connection-read', 'connection-check', 'connection-send', 'connection-reply'];
if (!allowed.includes(operation)) throw new Error('用法：node client.mjs projects|overview|main-read|main-targets|connections | connection-read|connection-check <名字> | main-bind|project-lead-switch|project-lead-bind|connection-send|connection-reply|links-send < stdin | read|project-lead <projectId> | bind|submit|message|feedback|feishu-reply|hide|restore|delete <input.json>');
const target = fileURLToPath(new URL('../plugin/', import.meta.url));
const caller = process.env.ORCA_AGENT_SESSION_ID ? `orca_session_id:${process.env.ORCA_AGENT_SESSION_ID}` : process.env.ORCA_TERMINAL_HANDLE;
const currentRun = () => JSON.parse(execFileSync(executable, ['orchestration', 'run-current', '--json', '--full'], { encoding: 'utf8', windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024 }));

const input = operation === 'connections' ? { operation: 'read' } : operation.startsWith('connection-') ? { ...(['connection-read','connection-check'].includes(operation) ? { name: argument } : JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, ''))), operation: operation.slice(11) } : operation.startsWith('links-') ? { ...(['links-join', 'links-configure', 'links-rename', 'links-share', 'links-relate', 'links-revoke', 'links-send'].includes(operation) ? JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, '')) : {}), operation: operation.slice(6) } : ['projects', 'overview'].includes(operation) ? null : operation === 'main-read' ? { operation: 'read' } : operation === 'read'
  ? { operation, projectId: argument }
  : operation === 'project-lead' ? { projectId: argument }
  : operation === 'main-targets' ? null
  : { ...JSON.parse(readFileSync(operation === 'main-bind' || leadBind || leadSwitch ? 0 : argument, 'utf8').replace(/^\uFEFF/, '')), ...(['message', 'feedback', 'feishu-reply', 'project-lead-switch'].includes(operation) ? {} : { operation: operation === 'main-bind' || leadBind ? 'bind' : operation }) };
if (operation === 'main-bind' || leadBind || leadSwitch) {
  if (argument && (operation !== 'main-bind' || argument !== '--check')) throw new Error('请从标准输入传入绑定或切换请求');
  if (!caller) throw new Error('请在对应的 Orca 会话中调用该命令');
  // Chat identity is only declarable in the session's own process; never pass --from here.
  let current;
  try {
    current = currentRun();
  } catch { throw new Error('无法读取当前会话的 Run；请在目标 Orca 会话重试 run-current，勿填写其他会话身份'); }
  if (!current.ok || !current.result?.run?.id) throw new Error('当前会话没有协调 Run；请先在本会话运行 orca orchestration run-create');
  if (leadSwitch) input.runId = current.result.run.id;
  else { input.currentRunId = current.result.run.id; input.caller = caller; }
  if (leadBind && !input.token) throw new Error('接管项目主会话需要本次接管凭据');
  if (argument === '--check') input.checkOnly = true;
}
if (['bind', 'submit', 'feedback', 'hide', 'restore', 'delete'].includes(operation)) {
  delete input.caller;
  if (caller) {
    input.caller = caller;
    if (!input.runId) try { const current = currentRun(); if (current.ok && current.result?.run?.id) input.runId = current.result.run.id; } catch { /* Optional display identity must not prevent a project write. */ }
  }
}
const name = operation === 'connections' || operation.startsWith('connection-') ? 'workspace.connections' : operation.startsWith('links-') ? 'workspace.links' : operation === 'projects' ? 'projects.list' : operation === 'overview' ? 'workspace.overview'
  : operation === 'feishu-reply' ? 'workspace.reply' : operation.startsWith('main-') ? 'workspace.agent' : operation === 'message' ? 'workspace.message' : operation === 'feedback' ? 'project.feedback' : operation === 'project-lead' ? 'project.lead' : leadSwitch ? 'workspace.projectLead' : 'project.agent';
const maintenance = ['hide', 'restore', 'delete'].includes(operation);
const args = ['plugin', 'dev', 'request', target, operation === 'main-targets' ? 'workspace.agent.targets' : maintenance ? operation === 'delete' ? 'project.delete' : 'project.visibility' : name, '--json'];
if (maintenance) { delete input.operation; if (operation !== 'delete') input.hidden = operation === 'hide'; }
if (operation === 'message') args.push('--environment', 'local');
if (input) args.push('--data', JSON.stringify(input));
try {
  const stdout = execFileSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 40000, maxBuffer: 1024 * 1024 });
  if (operation === 'main-bind' && !input.checkOnly) {
    const reply = JSON.parse(stdout), binding = reply.result?.result;
    if (reply.ok && binding?.runId === input.runId && binding.session?.handle === caller) {
      try { writeMainRoleCards(binding.session.path); }
      catch (error) { binding.roleCardWarning = `绑定已成功，角色卡未完整写入：${error.message}。修正后用原请求重试。`; }
    }
    process.stdout.write(JSON.stringify(reply, null, 2) + '\n');
  } else if (operation !== 'message') process.stdout.write(stdout);
  else {
    const reply = JSON.parse(stdout), result = reply.result?.result;
    if (reply.ok && result?.project) {
      if (result.queued) {
        try {
          const { autoProjectLead } = await import('../../workspace/workspace.mjs');
          result.autoLaunch = autoProjectLead(input.projectId, input.runId);
        } catch (error) {
          result.autoLaunch = { status: 'not-confirmed', projectName: result.project.ref.name, reason: error.message };
        }
      } else result.autoLaunch = { status: 'already-bound', projectName: result.project.ref.name, reason: '项目已绑定主 agent' };
    }
    process.stdout.write(JSON.stringify(reply, null, 2) + '\n');
  }
} catch (e) {
  if (e.stdout) process.stderr.write(e.stdout);
  else process.stderr.write('Orca 请求未取得回执，请先读项目记录核对，勿直接重复写入。\n');
  process.exitCode = 1;
}
