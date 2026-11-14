import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const [operation, argument] = process.argv.slice(2);
const allowed = ['projects', 'read', 'bind', 'submit'];
if (!allowed.includes(operation)) throw new Error('用法：node client.mjs projects | read <projectId> | bind|submit <input.json>');
const target = fileURLToPath(new URL('../plugin/', import.meta.url));
const executable = process.env.ORCA_CLI_COMMAND || (process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData/Local/Programs/orca/resources/bin/orca.exe') : 'orca');
const input = operation === 'projects' ? null : operation === 'read'
  ? { operation, projectId: argument }
  : { ...JSON.parse(readFileSync(argument, 'utf8').replace(/^\uFEFF/, '')), operation };
const args = ['plugin', 'dev', 'request', target, operation === 'projects' ? 'projects.list' : 'project.agent', '--json'];
if (input) args.push('--data', JSON.stringify(input));
try {
  process.stdout.write(execFileSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 40000, maxBuffer: 1024 * 1024 }));
} catch (e) {
  if (e.stdout) process.stderr.write(e.stdout);
  else process.stderr.write('Orca 请求未取得回执，请先读项目记录核对，勿直接重复写入。\n');
  process.exitCode = 1;
}
