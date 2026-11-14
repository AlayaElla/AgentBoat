import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./skill/agentboat-workspace/', import.meta.url));
const target = path.join(os.homedir(), '.agents/skills/agentboat-workspace');
const link = path.join(os.homedir(), '.claude/skills/agentboat-workspace');
// Refuse a foreign directory before changing the installed skill; never request admin rights.
if (existsSync(link) || (() => { try { lstatSync(link); return true; } catch { return false; } })()) {
  if (!lstatSync(link).isSymbolicLink() || realpathSync(link) !== path.resolve(target)) throw new Error(`Claude 位置已有其他内容，未覆盖：${link}`);
}
if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error(`安装目标必须是普通目录：${target}`);
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
mkdirSync(path.dirname(link), { recursive: true });
if (!existsSync(link)) symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
console.log(JSON.stringify({ installed: target, claudeLink: link, repository: fileURLToPath(new URL('../', import.meta.url)) }, null, 2));
