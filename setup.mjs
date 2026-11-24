import { cpSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { install, skillTargets } from './workspace/install.mjs';

const home = os.homedir();
const codexHome = path.resolve(process.env.CODEX_HOME || path.join(home, '.codex'));
const backupRoot = path.join(home, '.agentboat', 'backups');
const targets = [
  ...skillTargets(home).flatMap(({ installed, claudeLink, antigravity }) =>
    [installed, claudeLink, antigravity].map(target => [path.relative(home, target), target])),
  ['.claude/settings.json', path.join(home, '.claude', 'settings.json')],
  ['.codex/hooks.json', path.join(codexHome, 'hooks.json')],
];

console.log('AgentBoat 将安装两份 skill，并合并 Claude Code 与 Codex 的 hooks。已有设置和其他 hooks 会保留。');
for (const [, target] of targets) console.log('  ' + target);
console.log('修改前会在这里备份已有文件和链接：' + backupRoot);
const prompt = createInterface({ input: process.stdin, output: process.stdout });
const consent = await prompt.question('输入 yes 继续，直接回车取消：').finally(() => prompt.close());
if (consent.trim() === 'yes') {
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const backup = mkdtempSync(path.join(backupRoot, 'setup-'));
  console.log('备份目录：' + backup);
  for (const [name, target] of targets) {
    let info;
    try { info = lstatSync(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const destination = path.join(backup, name);
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (info.isSymbolicLink()) writeFileSync(destination + '.link', readlinkSync(target), { flag: 'wx', mode: 0o600 });
    else cpSync(target, destination, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  }
  console.log(JSON.stringify(install(home, codexHome), null, 2));
} else {
  console.log('已取消。');
}
