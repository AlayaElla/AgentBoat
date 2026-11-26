import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const setup = path.join(process.argv[2], 'setup.mjs');
const home = mkdtempSync(path.join(os.tmpdir(), 'agentboat-setup-test-'));
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
const codex = path.join(home, 'custom-codex');
const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codex, ORCA_USER_DATA_PATH: path.join(home, 'orca') };
const run = input => execFileSync(process.execPath, [setup], { input, env, encoding: 'utf8', cwd: home });
const agentboat = path.join(home, '.agentboat');
const claude = path.join(home, '.claude', 'settings.json');
const hooks = path.join(codex, 'hooks.json');
const skill = path.join(home, '.agents', 'skills', 'agentboat-workspace', 'SKILL.md');
const projectSkill = path.join(home, '.agents', 'skills', 'orca-project-coordinator', 'SKILL.md');
const agySkill = path.join(home, '.gemini/config/skills/agentboat-workspace/SKILL.md');
const personal = path.join(home, '.gemini/config/skills/personal/SKILL.md');
const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-test-hook' }] }] } };
const original = JSON.stringify(settings);
for (const file of [claude, hooks, personal]) mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(claude, original);
writeFileSync(hooks, original);
writeFileSync(personal, 'personal skill');

const preview = run('\n');
assert.match(preview, /已取消/);
assert.ok(preview.includes(path.dirname(agySkill)));
assert.equal(existsSync(agentboat), false);
assert.equal(existsSync(agySkill), false);
assert.equal(readFileSync(claude, 'utf8'), original);
assert.equal(readFileSync(hooks, 'utf8'), original);
assert.equal(existsSync(skill), false);
mkdirSync(path.dirname(skill), { recursive: true });
writeFileSync(skill, 'unknown skill');
assert.throws(() => run('yes\n'), /归属未知/);
assert.equal(readFileSync(skill, 'utf8'), 'unknown skill');
assert.equal(existsSync(agentboat), false);
rmSync(skill);
rmdirSync(path.dirname(skill));
const lock = path.join(home, '.agentboat-setup.lock');
mkdirSync(lock);
const owner = path.join(lock, 'pid-' + process.pid + '-11111111-1111-1111-1111-111111111111');
writeFileSync(owner, '');
assert.throws(() => run('yes\n'), /另一次 AgentBoat 设置/);
rmSync(owner);
rmdirSync(lock);
run('yes\n');
const backups = path.join(agentboat, 'backups');
const [backup] = readdirSync(backups);
assert.equal(readFileSync(path.join(backups, backup, '.claude/settings.json'), 'utf8'), original);
assert.equal(readFileSync(path.join(backups, backup, '.codex/hooks.json'), 'utf8'), original);
assert.ok(readFileSync(skill, 'utf8').includes(path.dirname(setup).replaceAll('\\', '/')));
assert.deepEqual(readFileSync(agySkill), readFileSync(skill));
assert.equal(readFileSync(personal, 'utf8'), 'personal skill');
for (const file of [claude, hooks]) {
  const result = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(result.hooks.Stop.slice(0, 1), settings.hooks.Stop);
  assert.match(JSON.stringify(result.hooks.Stop[1]), /agentboat-role-harness/);
}
const after = [claude, hooks].map(file => readFileSync(file, 'utf8'));
const previous = readFileSync(agySkill, 'utf8') + '\nold';
writeFileSync(agySkill, previous);
run('yes\n');
const nextBackup = readdirSync(backups).find(name => name !== backup);
assert.equal(readFileSync(path.join(backups, nextBackup, path.relative(home, agySkill)), 'utf8'), previous);
assert.deepEqual(readFileSync(agySkill), readFileSync(skill));
assert.deepEqual([claude, hooks].map(file => readFileSync(file, 'utf8')), after);
assert.equal(existsSync(path.join(codex, 'config.toml')), false);
const release = path.dirname(setup);
const registry = path.join(env.ORCA_USER_DATA_PATH, 'plugins-data/alayaella.agentboat/roles.json');
mkdirSync(path.dirname(registry), { recursive: true });
writeFileSync(registry, JSON.stringify({ version: 1, sessions: {
  'orca_session_id:claude_workspace': { role: 'workspace-main', directory: home },
  'orca_session_id:claude_project': { role: 'project-lead', projectId: 'boardingtime-fixture', runId: 'run_project_fixture' }
} }));
const installedHook = JSON.parse(readFileSync(claude, 'utf8')).hooks.SessionStart[0].hooks[0];
assert.equal(realpathSync(installedHook.args[0]), realpathSync(path.join(release, 'workspace/harness/hook.mjs')));
for (const [file, bundled, id, pattern] of [
  [skill, 'workspace/skill/agentboat-workspace/SKILL.md', 'claude_workspace', /client\.mjs message.*转给该项目主会话.*小拾检索.*项目主会话组织/],
  [projectSkill, 'coordinator/skill/orca-project-coordinator/SKILL.md', 'claude_project', /无需触发词.*派给实际执行者.*小拾检索.*主人明确提出的需求有可核对成果后.*原任务提交验收/]
]) {
  const published = readFileSync(path.join(release, bundled), 'utf8');
  const actual = readFileSync(file, 'utf8');
  assert.equal(actual, published.replaceAll('{{AGENTBOAT_REPO}}', release.replaceAll('\\', '/')));
  const suffix = path.join(path.basename(path.dirname(file)), 'SKILL.md');
  for (const provider of ['.claude/skills', '.gemini/config/skills']) {
    assert.equal(readFileSync(path.join(home, provider, suffix), 'utf8'), actual);
  }
  const roleCard = actual.replaceAll('\r\n', '\n').split('## 角色卡\n\n')[1].split('\n\n')[0];
  assert.match(roleCard, pattern);
  assert.match(roleCard, /按实际差异归并/);
  assert.match(roleCard, /项目主会话和执行者禁用 Computer Use.*「等你处理」/);
  for (const source of ['startup', 'resume']) {
    const context = JSON.parse(execFileSync(process.execPath, installedHook.args, {
      input: JSON.stringify({ hook_event_name: 'SessionStart', source, cwd: home }),
      env: { ...env, ORCA_AGENT_SESSION_ID: id }, encoding: 'utf8', cwd: home, windowsHide: true
    })).hookSpecificOutput.additionalContext;
    assert.ok(context.startsWith(roleCard + '\n'));
  }
}
console.log('PASS setup consent, shared lock, conflict, backups, both hooks, Antigravity, and repeat setup');
console.log('PASS both published role skills, installed hook provenance, startup and resume role cards');
