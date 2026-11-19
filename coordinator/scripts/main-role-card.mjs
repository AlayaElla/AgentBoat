import { randomUUID } from 'node:crypto';
import { accessSync, chmodSync, closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const start = '<!-- AgentBoat:workspace-role:start -->';
const end = '<!-- AgentBoat:workspace-role:end -->';
const heading = '## 角色卡\n\n';

export function readRoleCard(role) {
  const skill = role === 'workspace-main' ? '../../workspace/skill/agentboat-workspace/SKILL.md' : '../skill/orca-project-coordinator/SKILL.md';
  const card = readFileSync(new URL(skill, import.meta.url), 'utf8').replaceAll('\r\n', '\n').split(heading)[1]?.split('\n\n')[0];
  if (!card?.trim()) throw Error('找不到主会话角色卡');
  return card;
}

export function writeMainRoleCards(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw Error('绑定回执缺少工作间主会话的绝对目录');
  const root = realpathSync(directory);
  const card = readRoleCard('workspace-main');

  const updates = ['CLAUDE.md', 'AGENTS.md'].flatMap(name => {
    const file = path.join(root, name);
    let info;
    try { info = lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info && !info.isFile()) throw Error(`${name} 不是普通文件，请检查后再试`);
    const original = info ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(file)) : '';
    const bom = original.startsWith('\uFEFF') ? '\uFEFF' : '';
    const content = original.slice(bom.length);
    const eol = content.match(/\r?\n/)?.[0] ?? '\n';
    const block = [start, '先读 `$agentboat-workspace`，用 `main-read` 核对当前绑定。', '', card, end].join(eol);
    const markers = [...content.matchAll(/^<!-- AgentBoat:workspace-role:(start|end) -->(?=\r?$)/gm)];
    if (markers.length && (markers.length !== 2 || markers[0][1] !== 'start' || markers[1][1] !== 'end')) throw Error(`${name} 的角色卡标记不成对，请核对后再试`);
    const next = markers.length
      ? bom + content.slice(0, markers[0].index) + block + content.slice(markers[1].index + end.length)
      : original + (content ? (content.endsWith('\n') ? eol : eol + eol) : '') + block + eol;
    if (next === original) return [];
    if (info) accessSync(file, constants.W_OK);
    return [{ file, next, mode: info?.mode }];
  });

  const staged = [];
  try {
    for (const { file, next, mode } of updates) {
      const temporary = path.join(root, `.agentboat-role-${randomUUID()}.tmp`);
      const fd = openSync(temporary, 'wx', mode === undefined ? 0o666 : 0o600);
      staged.push({ file, temporary });
      try { writeFileSync(fd, next); fsyncSync(fd); } finally { closeSync(fd); }
      if (mode !== undefined) chmodSync(temporary, mode & 0o777);
    }
    for (const { file, temporary } of staged) renameSync(temporary, file);
  } finally { for (const { temporary } of staged) rmSync(temporary, { force: true }); }
}
