import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const setup = path.join(process.argv[2], 'setup.mjs');
const home = mkdtempSync(path.join(os.tmpdir(), 'agentboat-setup-test-'));
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
const codex = path.join(home, 'custom-codex');
const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codex };
const run = input => execFileSync(process.execPath, [setup], { input, env, encoding: 'utf8', cwd: home });
const agentboat = path.join(home, '.agentboat');
const claude = path.join(home, '.claude', 'settings.json');
const hooks = path.join(codex, 'hooks.json');
const skill = path.join(home, '.agents', 'skills', 'agentboat-workspace', 'SKILL.md');
const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-test-hook' }] }] } };
const original = JSON.stringify(settings);
for (const file of [claude, hooks, skill]) mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(claude, original);
writeFileSync(hooks, original);
writeFileSync(skill, 'previous skill');

assert.match(run('\n'), /已取消/);
assert.equal(existsSync(agentboat), false);
assert.equal(readFileSync(claude, 'utf8'), original);
assert.equal(readFileSync(hooks, 'utf8'), original);
assert.equal(readFileSync(skill, 'utf8'), 'previous skill');
run('yes\n');
const backups = path.join(agentboat, 'backups');
const [backup] = readdirSync(backups);
assert.equal(readFileSync(path.join(backups, backup, '.claude/settings.json'), 'utf8'), original);
assert.equal(readFileSync(path.join(backups, backup, '.codex/hooks.json'), 'utf8'), original);
assert.equal(readFileSync(path.join(backups, backup, '.agents/skills/agentboat-workspace/SKILL.md'), 'utf8'), 'previous skill');
assert.ok(readFileSync(skill, 'utf8').includes(path.dirname(setup).replaceAll('\\', '/')));
for (const file of [claude, hooks]) {
  const result = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(result.hooks.Stop.slice(0, 1), settings.hooks.Stop);
  assert.match(JSON.stringify(result.hooks.Stop[1]), /agentboat-role-harness/);
}
const after = [claude, hooks].map(file => readFileSync(file, 'utf8'));
run('yes\n');
assert.deepEqual([claude, hooks].map(file => readFileSync(file, 'utf8')), after);
assert.equal(existsSync(path.join(codex, 'config.toml')), false);
console.log('PASS setup consent, backups, both hooks, and repeat setup');
