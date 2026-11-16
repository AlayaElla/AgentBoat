import { executable } from './orca-cli.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const [operation, argument] = process.argv.slice(2);
const allowed = ['projects', 'overview', 'main-read', 'main-bind', 'message', 'read', 'bind', 'submit', 'feedback', 'feishu-read', 'feishu-reply', 'links-read', 'links-refresh', 'links-invite', 'links-cancel-invite', 'links-join', 'links-configure', 'links-share', 'links-relate', 'links-revoke', 'requests-read', 'requests-send', 'requests-decide', 'requests-update', 'requests-attach', 'hide', 'restore', 'delete', 'main-targets', 'connections', 'connection-read', 'connection-check', 'connection-send', 'connection-reply'];
if (!allowed.includes(operation)) throw new Error('用法：node client.mjs projects|overview|main-read|main-targets|feishu-read|connections | connection-read|connection-check <名字> | main-bind|connection-send|connection-reply < stdin | read <projectId> | bind|submit|message|feedback|feishu-reply|hide|restore|delete <input.json>');
const target = fileURLToPath(new URL('../plugin/', import.meta.url));

const input = operation === 'connections' ? { operation: 'read' } : operation.startsWith('connection-') ? { ...(['connection-read','connection-check'].includes(operation) ? { name: argument } : JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, ''))), operation: operation.slice(11) } : operation.startsWith('requests-') ? { ...(operation === 'requests-read' ? {} : JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, ''))), operation: operation.slice(9) } : operation.startsWith('links-') ? { ...(['links-join', 'links-configure', 'links-share', 'links-relate', 'links-revoke'].includes(operation) ? JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, '')) : {}), operation: operation.slice(6) } : ['projects', 'overview'].includes(operation) ? null : ['main-read', 'feishu-read'].includes(operation) ? { operation: 'read' } : operation === 'read'
  ? { operation, projectId: argument }
  : operation === 'main-targets' ? null
  : { ...JSON.parse(readFileSync(operation === 'main-bind' ? 0 : argument, 'utf8').replace(/^\uFEFF/, '')), ...(['message', 'feedback', 'feishu-reply'].includes(operation) ? {} : { operation: operation === 'main-bind' ? 'bind' : operation }) };
if (operation === 'main-bind') {
  if (argument && argument !== '--check') throw new Error('用法：main-bind [--check] < stdin；--check 只核实，不生效');
  const caller = process.env.ORCA_AGENT_SESSION_ID ? `orca_session_id:${process.env.ORCA_AGENT_SESSION_ID}` : process.env.ORCA_TERMINAL_HANDLE;
  if (!caller) throw new Error('请在承担主 agent 的 Orca 会话中调用 main-bind');
  input.caller = caller;
  // Chat identity is only declarable in the session's own process; never pass --from here.
  let current;
  try {
    current = JSON.parse(execFileSync(executable, ['orchestration', 'run-current', '--json', '--full'], { encoding: 'utf8', windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024 }));
  } catch { throw new Error('无法读取当前会话的 Run；请在目标 Orca 会话重试 run-current，勿填写其他会话身份'); }
  if (!current.ok || !current.result?.run?.id) throw new Error('当前会话没有协调 Run；请先在本会话运行 orca orchestration run-create --objective "工作间主 agent"');
  input.currentRunId = current.result.run.id;
  if (argument === '--check') input.checkOnly = true;
}
const name = operation === 'connections' || operation.startsWith('connection-') ? 'workspace.connections' : operation.startsWith('requests-') ? 'workspace.requests' : operation.startsWith('links-') ? 'workspace.links' : operation === 'projects' ? 'projects.list' : operation === 'overview' ? 'workspace.overview'
  : operation === 'feishu-read' ? 'workspace.feishu' : operation === 'feishu-reply' ? 'workspace.reply' : operation.startsWith('main-') ? 'workspace.agent' : operation === 'message' ? 'workspace.message' : operation === 'feedback' ? 'project.feedback' : 'project.agent';
const maintenance = ['hide', 'restore', 'delete'].includes(operation);
const args = ['plugin', 'dev', 'request', target, operation === 'main-targets' ? 'workspace.agent.targets' : maintenance ? operation === 'delete' ? 'project.delete' : 'project.visibility' : name, '--json'];
if (maintenance) { delete input.operation; if (operation !== 'delete') input.hidden = operation === 'hide'; }
if (input) args.push('--data', JSON.stringify(input));
try {
  process.stdout.write(execFileSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 40000, maxBuffer: 1024 * 1024 }));
} catch (e) {
  if (e.stdout) process.stderr.write(e.stdout);
  else process.stderr.write('Orca 请求未取得回执，请先读项目记录核对，勿直接重复写入。\n');
  process.exitCode = 1;
}
