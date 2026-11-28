import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { executable, pluginVersionLabel, pluginKey } from './orca-cli.mjs';

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
    for (const file of ['workspace', 'coordinator/skill', 'coordinator/LINKS.md', client, ...['orca-cli', 'cli-bridge', 'main-role-card', 'worker-reports', 'orca-questions'].map(s => 'coordinator/scripts/' + s + '.mjs')])
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

test('packaged candidate settings read the verified release without getting setup write access', async t => {
  const { temp, profile, home, key, stable, run, version } = fixture(t);
  const official = version('a'), candidate = path.join(temp, 'local-candidate');
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(official, stable, kind);
  cpSync(official, candidate, { recursive: true });
  const source = path.join(candidate, 'workspace/skill/agentboat-workspace/SKILL.md');
  writeFileSync(source, readFileSync(source, 'utf8') + '\ncandidate-only change');
  const installer = pathToFileURL(path.join(candidate, 'workspace/install.mjs')).href;
  const evaluate = (expression, overrides) => run(['--input-type=module', '-e',
    `import { previewSetup, applySetup } from ${JSON.stringify(installer)}; console.log(JSON.stringify(${expression}));`], undefined, overrides);
  const preview = async overrides => JSON.parse((await evaluate('previewSetup({ fromSettings: true })', overrides)).stdout);

  await run([path.join(stable, 'setup.mjs')], 'yes\n');
  const skill = path.join(home, '.agents/skills/agentboat-workspace/SKILL.md');
  const original = readFileSync(skill, 'utf8');
  assert.equal(original, readFileSync(path.join(official, path.relative(candidate, source)), 'utf8')
    .replaceAll('{{AGENTBOAT_REPO}}', stable.replaceAll('\\', '/')));
  const extra = path.join(path.dirname(skill), 'personal.md');
  writeFileSync(extra, 'keep');
  const hooks = path.join(home, '.codex/hooks.json'), originalHooks = readFileSync(hooks);
  const ready = await preview();
  assert.equal(ready.error, undefined);
  assert.equal(ready.confirmation, undefined);
  assert.deepEqual(ready.paths, []);
  await assert.rejects(evaluate('applySetup("a".repeat(64), { fromSettings: true })'), /请通过正式版 AgentBoat/);

  const other = path.join(temp, 'other-profile/agentboat-current').replaceAll('\\', '/');
  for (const [content, error] of [
    [original.replaceAll(stable.replaceAll('\\', '/'), other), /归属未知/],
    ['---\nname: agentboat-workspace\n---\nPersonal skill', /归属未知/],
    [original + '\nPersonal text', /请通过正式版 AgentBoat/]
  ]) {
    writeFileSync(skill, content);
    const result = await preview();
    assert.match(result.error, error);
    assert.equal(result.confirmation, undefined);
    assert.equal(readFileSync(skill, 'utf8'), content);
  }
  writeFileSync(skill, original);
  assert.match((await preview({ ORCA_USER_DATA_PATH: path.dirname(other) })).error, /归属未知/);
  assert.equal(readFileSync(extra, 'utf8'), 'keep');
  assert.deepEqual(readFileSync(hooks), originalHooks);

  const alias = path.join(temp, 'aliased-profile');
  mkdirSync(alias);
  symlinkSync(path.join(profile, 'plugins'), path.join(alias, 'plugins'), kind);
  assert.match((await preview({ ORCA_USER_DATA_PATH: alias })).error, /当前版本入口无效/);
  unlinkSync(stable);
  symlinkSync(candidate, stable, kind);
  assert.match((await preview()).error, /固定入口已有其他内容/);
  assert.equal(realpathSync(stable), candidate);
  writeFileSync(path.join(key, 'current'), 'b'.repeat(64));
  assert.match((await preview()).error, /当前版本文件尚未就绪/);
  unlinkSync(path.join(key, 'current'));
  assert.match((await preview()).error, /找不到 AgentBoat 当前安装版本/);
  assert.equal(realpathSync(stable), candidate);
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

test('feedback attachment notices run the active candidate client or the aligned installed entry', async t => {
  const { temp, profile, stable, run, version } = fixture(t);
  const oldProfile = process.env.ORCA_USER_DATA_PATH;
  process.env.ORCA_USER_DATA_PATH = profile;
  t.after(() => { if (oldProfile === undefined) delete process.env.ORCA_USER_DATA_PATH; else process.env.ORCA_USER_DATA_PATH = oldProfile; });
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  const previous = version('a'), oldClient = path.join(previous, client);
  const candidate = path.join(temp, "Candidate's approved folder");
  cpSync(previous, candidate, { recursive: true });
  symlinkSync(previous, stable, kind);
  // Restore the two parser differences from before feedback-file was introduced.
  writeFileSync(oldClient, readFileSync(oldClient, 'utf8').replace("const feedbackFile = operation === 'feedback-file';", 'const feedbackFile = false;').replace(", 'feedback-file',", ','));
  await assert.rejects(run([path.join(stable, client), 'feedback-file']), /用法：node client\.mjs projects/);

  const { build } = await import('esbuild');
  const orca = realpathSync(path.isAbsolute(executable) ? executable : execFileSync('which', [executable], { encoding: 'utf8' }).trim());
  const sdk = path.resolve(path.dirname(orca), '../app.asar.unpacked/resources/plugins/declarative');
  const workerFile = path.join(candidate, 'worker.mjs');
  await build({ bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: workerFile,
    alias: { 'orca/testing': path.join(sdk, 'orca-testing.mjs'), orca: path.join(sdk, 'orca-runtime.mjs') },
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; import { fileURLToPath as __testFile } from 'node:url'; import __testPath from 'node:path'; const require = __testRequire(import.meta.url); const __filename = __testFile(import.meta.url); const __dirname = __testPath.dirname(__filename);" },
    stdin: { resolveDir: path.join(repo, 'coordinator'), contents: `
import { createHash } from 'node:crypto';
import { mockHost, mountWorker } from 'orca/testing';
import { fresh, submitTask } from './src/store';
import { LinkFiles } from './src/link-files';
import { testCoordinator } from './src/test-runtime';
import { refs, deliverable } from './src/fixtures';
import { cliBridge } from './scripts/cli-bridge.mjs';
export async function withFeedback(dir, check) {
  const project = { ...fresh(refs[0]), runId: 'run_project', mainAgentHandle: 'orca_session_id:fixture-main' };
  submitTask(project, deliverable);
  const { id: itemId, revision: itemRevision, fingerprint } = project.tasks[0].acceptance[0];
  const bytes = Buffer.from('feedback attachment');
  const file = { id: '24778cb9-0028-4bbd-b12a-90dce6316d51', name: 'feedback.txt', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  const target = { projectId: project.ref.id, taskId: deliverable.id, itemId, itemRevision, fingerprint };
  let c, bridge, notice;
  const worker = await mountWorker({ default: api => {
    bridge = cliBridge(api);
    c = testCoordinator(bridge.api, { projects: async () => refs, runBinding: async () => ({ owner: project.mainAgentHandle }),
      send: async (_run, delivery) => { notice = delivery.body; return {}; } }, undefined, undefined, new LinkFiles(dir));
  } }, { host: mockHost({ storage: { ['project:' + project.ref.id]: project } }) });
  try {
    await bridge.start();
    await worker.request('panel.feedbackFile', { ...target, file, offset: 0, data: bytes.toString('base64') });
    await worker.request('project.feedback', { projectId: target.projectId, revision: project.revision, requestId: 'fixture',
      items: [{ ...target, kind: 'acceptance', result: 'passed', attachments: [file] }] });
    await c.flush(project.ref.id);
    await check(notice, bytes);
  } finally { bridge.stop(); c.stop(); await worker.deactivate(); }
}
` } });

  const preload = path.join(temp, 'fixture-orca.mjs');
  writeFileSync(preload, `import cp from 'node:child_process';
import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
cp.execFileSync = (_exe, args, options) => {
  assert.deepEqual(args, ['orchestration', 'run-current', '--environment', 'local', '--json', '--full']);
  assert.equal(options.env.ORCA_USER_DATA_PATH, ${JSON.stringify(profile)});
  return JSON.stringify({ ok: true, result: { run: { id: 'run_project' } } });
};
syncBuiltinESMExports();`);
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'sh';
  const call = (command, caller) => promisify(execFile)(shell,
    process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', `${command}; exit $LASTEXITCODE`] : ['-c', command],
    { env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, ORCA_AGENT_SESSION_ID: caller }, windowsHide: true, timeout: 8000 });
  const followNotice = (entry, rejectOther = false) => async (body, bytes) => {
    assert.doesNotMatch(body, /稳定入口调用/);
    const command = body.split('\n').find(line => line.startsWith('node '));
    assert.ok(command.includes(entry.replaceAll('\\', '/').replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")));
    const { result } = JSON.parse((await call(command, 'fixture-main')).stdout);
    assert.deepEqual(readFileSync(result.result.path), bytes);
    if (rejectOther) await assert.rejects(call(command, 'unrelated'), /当前绑定的项目主会话/);
  };
  await (await import(pathToFileURL(workerFile))).withFeedback(path.join(temp, 'candidate-files'), async (body, bytes) => {
    const { result } = JSON.parse((await run([path.join(stable, client), 'projects'])).stdout);
    assert.ok(result.result.projects.some(p => p.id === 'p1'));
    await followNotice(path.join(candidate, client), true)(body, bytes);
  });
  assert.equal(realpathSync(stable), previous);

  const official = version('b');
  cpSync(workerFile, path.join(official, 'worker.mjs'));
  const cliUrl = pathToFileURL(path.join(official, 'coordinator/scripts/orca-cli.mjs')).href;
  await run(['--input-type=module', '-e', `import { refreshReleaseSetup } from ${JSON.stringify(cliUrl)}; await refreshReleaseSetup()`]);
  assert.equal(realpathSync(stable), official);
  await (await import(pathToFileURL(path.join(official, 'worker.mjs')))).withFeedback(path.join(temp, 'official-files'), followNotice(path.join(stable, client)));

  const foreign = path.join(temp, 'foreign');
  mkdirSync(path.join(foreign, path.dirname(client)), { recursive: true });
  const sentinel = path.join(foreign, 'executed');
  writeFileSync(path.join(foreign, client), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'unexpected');`);
  unlinkSync(stable);
  symlinkSync(foreign, stable, kind);
  const entry = await import(cliUrl);
  assert.equal(entry.feedbackClientPath(), path.join(official, client));
  assert.equal(realpathSync(stable), foreign);
  assert.equal(existsSync(sentinel), false);
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
