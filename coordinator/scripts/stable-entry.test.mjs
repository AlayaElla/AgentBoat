import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { pluginVersionLabel, pluginKey } from './orca-cli.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const client = 'coordinator/scripts/client.mjs';
function fixture(t) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'agentboat-stable-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const profile = path.join(temp, 'Orca profile'), home = path.join(temp, 'home');
  mkdirSync(home);
  const key = path.join(profile, 'plugins', pluginKey), stable = path.join(profile, 'agentboat-current');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    ORCA_USER_DATA_PATH: profile, AGENTBOAT_HOME: path.join(home, '.agentboat'), ORCA_AGENT_SESSION_ID: '' };
  function version(letter) {
    const hash = letter.repeat(64), directory = path.join(key, hash);
    for (const file of ['workspace', 'coordinator/skill', 'coordinator/LINKS.md', client, ...['orca-cli', 'cli-bridge', 'main-role-card', 'worker-reports'].map(s => 'coordinator/scripts/' + s + '.mjs')])
      cpSync(path.join(repo, file), path.join(directory, file), { recursive: true });
    cpSync(path.join(repo, 'coordinator/scripts/setup.mjs'), path.join(directory, 'setup.mjs'));
    writeFileSync(path.join(directory, 'orca-plugin.json'), '{"id":"agentboat"}');
    writeFileSync(path.join(key, 'current'), hash);
    return directory;
  }
  function run(args, input, overrides) {
    const result = promisify(execFile)(process.execPath, args, { env: { ...env, ...overrides }, windowsHide: true });
    result.child.stdin.end(input);
    return result;
  }
  return { temp, profile, home, key, stable, run, version };
}

test('version label reads the running manifest and tolerates missing metadata', async t => {
  assert.equal(pluginVersionLabel(), '版本未知');
  const { version } = fixture(t);
  const running = version('a');
  version('b');
  const worker = path.join(running, 'worker.mjs');
  cpSync(path.join(repo, 'coordinator/scripts/orca-cli.mjs'), worker);
  const manifest = path.join(running, 'orca-plugin.json');
  writeFileSync(manifest, JSON.stringify({ version: '1.2.34' }));
  const entry = await import(pathToFileURL(worker));
  assert.equal(entry.pluginVersionLabel(), '版本 v1.2.34');
  writeFileSync(manifest, '{}');
  assert.equal(entry.pluginVersionLabel(), '版本未知');
});

test('one setup survives two worker upgrades, old version pruning and separate Orca profiles', async t => {
  const { temp, profile, home, key, stable, run, version } = fixture(t);
  const activateEntry = async directory => {
    // Use the worker bundle layout and the same startup call as activate().
    const worker = path.join(directory, 'worker.mjs');
    cpSync(path.join(directory, 'coordinator/scripts/orca-cli.mjs'), worker);
    await run(['--input-type=module', '-e', `import {refreshReleaseSetup} from ${JSON.stringify(pathToFileURL(worker).href)}; await refreshReleaseSetup()`],
      undefined, { ORCA_USER_DATA_PATH: path.join(temp, 'other-profile') });
  };
  const first = version('a');
  await activateEntry(first);
  await run([path.join(stable, 'setup.mjs')], 'yes\n');
  const skill = path.join(home, '.agents/skills/agentboat-workspace/SKILL.md');
  const projectSkill = path.join(home, '.agents/skills/orca-project-coordinator/SKILL.md');
  const agySkill = path.join(home, '.gemini/config/skills/agentboat-workspace/SKILL.md');
  const agyProjectSkill = path.join(home, '.gemini/config/skills/orca-project-coordinator/SKILL.md');
  const hook = JSON.parse(readFileSync(path.join(home, '.claude/settings.json'))).hooks.Stop[0].hooks[0].args[0];
  assert.equal(hook, path.join(stable, 'workspace/harness/hook.mjs'));
  for (const file of [skill, projectSkill, agySkill, agyProjectSkill, path.join(home, '.codex/hooks.json')])
    assert.ok(readFileSync(file, 'utf8').includes(stable.replaceAll('\\', '/')));
  const second = version('b');
  const guide = path.join(second, 'workspace/skill/agentboat-workspace/SKILL.md');
  writeFileSync(guide, readFileSync(guide, 'utf8') + '\nfixture upgrade');
  await activateEntry(second);
  assert.match(readFileSync(skill, 'utf8'), /fixture upgrade$/);
  assert.deepEqual(readFileSync(agySkill), readFileSync(skill));
  const oldSkill = readFileSync(projectSkill, 'utf8').replaceAll(stable.replaceAll('\\', '/'), first.replaceAll('\\', '/'));
  writeFileSync(projectSkill, oldSkill);
  writeFileSync(agyProjectSkill, oldSkill);
  const latest = version('c');
  rmSync(first, { recursive: true });
  await activateEntry(latest);
  assert.doesNotMatch(readFileSync(skill, 'utf8'), /fixture upgrade$/);
  assert.deepEqual(readFileSync(agySkill), readFileSync(skill));
  assert.equal(readFileSync(projectSkill, 'utf8'), oldSkill);
  assert.equal(readFileSync(agyProjectSkill, 'utf8'), oldSkill);
  assert.equal(realpathSync(stable), latest);
  assert.ok(!existsSync(path.join(temp, 'other-profile/agentboat-current')));
  const docs = ['workspace/README.md', 'coordinator/LINKS.md', 'coordinator/skill/orca-project-coordinator/references/bridge.md'];
  for (const file of [hook, ...docs.map(file => path.join(stable, file))]) assert.ok(realpathSync(file).startsWith(latest + path.sep));
  assert.ok(JSON.parse((await run([path.join(stable, 'workspace/workspace.mjs'), 'init'])).stdout).home);
  const registry = path.join(profile, 'plugins-data', pluginKey, 'roles.json');
  mkdirSync(path.dirname(registry), { recursive: true });
  writeFileSync(registry, JSON.stringify({ version: 1, sessions: {
    'orca_session_id:claude_fixture': { role: 'workspace-main', directory: home }
  } }));
  const preTool = command => run([hook], JSON.stringify({ cwd: home, tool_name: 'Bash',
    hook_event_name: 'PreToolUse', tool_input: { command } }), { ORCA_AGENT_SESSION_ID: 'claude_fixture' });
  for (const [script, op] of [[client, 'projects'], ['workspace/workspace.mjs', 'templates']]) {
    const reply = await preTool(`node "${path.join(stable, script).replaceAll('\\', '/')}" ${op}`);
    assert.equal(reply.stdout + reply.stderr, '');
  }
  assert.equal(JSON.parse((await preTool('node ./foreign.mjs')).stdout).hookSpecificOutput.permissionDecision, 'deny');
  unlinkSync(stable);
  await activateEntry(latest);
  assert.equal(realpathSync(stable), latest);
  writeFileSync(path.join(key, 'current'), '../foreign');
  await assert.rejects(activateEntry(latest), /当前版本无效/);
  assert.equal(realpathSync(stable), latest);
});

test('entry refuses occupied files, directories and foreign directory links', async t => {
  const { temp, stable, run, version } = fixture(t);
  const install = path.join(version('a'), 'setup.mjs');
  writeFileSync(stable, 'keep');
  await assert.rejects(run([install]), /固定入口已有其他内容/);
  assert.equal(readFileSync(stable, 'utf8'), 'keep');
  unlinkSync(stable);
  mkdirSync(stable);
  await assert.rejects(run([install]), /固定入口已有其他内容/);
  const other = path.join(temp, 'other');
  mkdirSync(other);
  rmSync(stable, { recursive: true });
  symlinkSync(other, stable, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(run([install]), /固定入口已有其他内容/);
  const cli = path.join(path.dirname(install), 'coordinator/scripts/orca-cli.mjs');
  const { promptClientPath } = await import(pathToFileURL(cli));
  assert.equal(promptClientPath(), path.resolve(path.dirname(install), client));
  assert.equal(realpathSync(stable), other);
});

test('repository client sends stdin once to the release bridge in its profile', async t => {
  const { run, version } = fixture(t);
  const args = [path.join(repo, client), 'links-rename'];
  const input = JSON.stringify({ name: '新的名字' });
  await assert.rejects(run(args, input), /确认 AgentBoat 已启用/);
  const dir = version('a');
  const { cliBridge } = await import(pathToFileURL(path.join(dir, 'coordinator/scripts/cli-bridge.mjs')));
  const bridge = cliBridge({ panels: { handle() {} } });
  let calls = 0;
  bridge.api.panels.handle('workspace.links', data => { calls++; return data; });
  await bridge.start();
  try {
    const reply = JSON.parse((await run(args, input)).stdout);
    assert.equal(reply.result.pluginKey, pluginKey);
    assert.deepEqual(reply.result.result, { name: '新的名字', operation: 'rename' });
  } finally { bridge.stop(); }
  await assert.rejects(run(args, input), /未取得回执/);
  assert.equal(calls, 1);
});

test('release evidence copies the installed version and compares snapshots in its profile', async t => {
  const { temp, profile, stable, run, version } = fixture(t);
  const dir = version('a');
  symlinkSync(dir, stable, process.platform === 'win32' ? 'junction' : 'dir');
  const bridge = (await import(pathToFileURL(path.join(dir, 'coordinator/scripts/cli-bridge.mjs')))).cliBridge({ panels: { handle() {} } });
  bridge.api.panels.handle('workspace.agent', () => ({}));
  bridge.api.panels.handle('projects.list', () => ({ projects: [{ id: 'p1' }] }));
  await bridge.start();
  try {
    const storage = path.join(profile, 'plugins-data', pluginKey, 'storage.json');
    writeFileSync(storage, JSON.stringify({ 'project:p1': { revision: 2 } }));
    const backup = path.join(temp, 'backup');
    const evidence = (op, ...args) => run([path.join(repo, 'coordinator/scripts/release-evidence.mjs'), op, backup, ...args]);
    await evidence('backup');
    assert.equal(readFileSync(path.join(backup, 'plugin/orca-plugin.json'), 'utf8'), readFileSync(path.join(dir, 'orca-plugin.json'), 'utf8'));
    await evidence('snapshot', 'after');
    assert.equal(JSON.parse((await evidence('compare', 'after')).stdout).projects, 1);
  } finally { bridge.stop(); }
});
