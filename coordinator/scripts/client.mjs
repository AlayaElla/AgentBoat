import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const [operation, argument] = process.argv.slice(2);
const allowed = ['projects', 'overview', 'main-read', 'main-bind', 'message', 'read', 'bind', 'submit', 'feedback', 'feishu-read', 'feishu-reply', 'links-read', 'links-refresh', 'links-invite', 'links-cancel-invite', 'links-join', 'links-configure', 'links-share', 'links-revoke'];
if (!allowed.includes(operation)) throw new Error('用法：node client.mjs projects|overview|main-read|feishu-read | read <projectId> | bind|submit|main-bind|message|feedback|feishu-reply <input.json>');
const target = fileURLToPath(new URL('../plugin/', import.meta.url));
const executable = process.env.ORCA_CLI_COMMAND || (process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData/Local/Programs/orca/resources/bin/orca.exe') : 'orca');
const input = operation.startsWith('links-') ? { ...(['links-join', 'links-configure', 'links-share', 'links-revoke'].includes(operation) ? JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, '')) : {}), operation: operation.slice(6) } : ['projects', 'overview'].includes(operation) ? null : ['main-read', 'feishu-read'].includes(operation) ? { operation: 'read' } : operation === 'read'
  ? { operation, projectId: argument }
  : { ...JSON.parse(readFileSync(argument, 'utf8').replace(/^\uFEFF/, '')), ...(['message', 'feedback', 'feishu-reply'].includes(operation) ? {} : { operation: operation === 'main-bind' ? 'bind' : operation }) };
const name = operation.startsWith('links-') ? 'workspace.links' : operation === 'projects' ? 'projects.list' : operation === 'overview' ? 'workspace.overview'
  : operation === 'feishu-read' ? 'workspace.feishu' : operation === 'feishu-reply' ? 'workspace.reply' : operation.startsWith('main-') ? 'workspace.agent' : operation === 'message' ? 'workspace.message' : operation === 'feedback' ? 'project.feedback' : 'project.agent';
const args = ['plugin', 'dev', 'request', target, name, '--json'];
if (input) args.push('--data', JSON.stringify(input));
try {
  process.stdout.write(execFileSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 40000, maxBuffer: 1024 * 1024 }));
} catch (e) {
  if (e.stdout) process.stderr.write(e.stdout);
  else process.stderr.write('Orca 请求未取得回执，请先读项目记录核对，勿直接重复写入。\n');
  process.exitCode = 1;
}
