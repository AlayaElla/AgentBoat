import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, appendFileSync, existsSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const sandboxPath = path.resolve(process.env.AGENTBOAT_SANDBOX || path.join(os.tmpdir(), 'agentboat-sandbox'));
mkdirSync(sandboxPath, { recursive: true });
const sandbox = realpathSync(sandboxPath);
const testHome = mkdtempSync(path.join(sandbox, 'agentboat-demo-unit-'));
process.env.AGENTBOAT_HOME = testHome;
process.env.AGENTBOAT_SANDBOX = sandbox;
process.env.AGENTBOAT_TEST_ONLY = '1';
const api = await import('./workspace.mjs');

test('初始化不覆盖模板；记忆按来源隔离、带日期、重复记录拒绝追加', () => {
  try {
    api.init();
    assert.equal(api.template('code').roles.code.agent, 'codex');
    const custom = path.join(testHome, 'templates/code.json');
    const value = JSON.parse(readFileSync(custom));
    assert.equal(value.mainAgent.agent, 'codex');
    assert.equal(value.backupAgent.agent, 'antigravity');
    const old = { ...value, mainAgent: { agent: 'claude', surface: 'chat' } };
    delete old.backupAgent;
    writeFileSync(custom, '\uFEFF' + JSON.stringify(old));
    assert.equal(api.template('code').mainAgent.agent, 'codex');
    assert.equal(JSON.parse(readFileSync(custom, 'utf8').slice(1)).mainAgent.agent, 'claude');
    old.mainAgent = old.backupAgents.claude;
    delete old.backupAgents;
    writeFileSync(custom, JSON.stringify(old));
    assert.equal(api.template('code').mainAgent.agent, 'codex');
    value.name = '自定义';
    value.mainAgent = { agent: 'antigravity' };
    writeFileSync(custom, JSON.stringify(value));
    api.init();
    assert.equal(api.template('code').name, '自定义');
    assert.deepEqual(api.template('code').mainAgent, value.mainAgent);
    assert.throws(() => api.template('../escape'));
    const entry = { id: 'fact-1', kind: 'user', date: '2026-11-14T00:00:00Z', source: '测试主人 / msg-1', text: '偏好短回答' };
    api.remember(entry);
    const user = readFileSync(path.join(testHome, 'memory/user.md'), 'utf8');
    assert.match(user, /2026-11-14T00:00:00.000Z/);
    assert.match(user, /测试主人 \/ msg-1/);
    assert.throws(() => api.remember(entry), /已存在/);
    assert.equal(readFileSync(path.join(testHome, 'memory/user.md'), 'utf8'), user);
    api.remember({ ...entry, id: 'infer-1', kind: 'inference', text: '未经确认的推断' });
    api.remember({ ...entry, id: 'external-1', kind: 'external', workspaceId: 'other', text: '外部内容' });
    assert.doesNotMatch(readFileSync(path.join(testHome, 'memory/user.md'), 'utf8'), /推断|外部内容/);
    assert.match(readFileSync(path.join(testHome, 'memory/external/other.md'), 'utf8'), /外部内容/);
    assert.match(execFileSync('git', ['ls-files'], { cwd: path.join(testHome, 'memory'), encoding: 'utf8' }), /user.md/);
    assert.throws(() => api.remember({ ...entry, kind: 'external', workspaceId: '../escape' }));
    assert.throws(() => api.remember({ ...entry, id: 'bad-date', date: 'bad' }));
    api.testPath(path.join(sandbox, 'agentboat-demo-project'));
    assert.throws(() => api.testPath(path.join(path.dirname(sandbox), 'AgentBoat')));
    assert.throws(() => api.testPath(`${sandbox}-other/agentboat-demo-project`));
    assert.throws(() => api.testPath(path.join(sandbox, 'real-project')));
    assert.equal(existsSync(path.join(testHome, 'memory/.git')), true);
    const launch = { outcome: { handle: 'agent-1' }, prompt: { outcome: 'journaled' } };
    assert.equal(api.launchReceipt(launch), 'agent-1');
    assert.throws(() => api.launchReceipt({ launch }));
    assert.equal(api.launchReceipt({ outcome: { kind: 'structured', handle: 'tab', sessionId: 'test-chat' }, prompt: { outcome: 'journaled' } }), 'orca_session_id:test-chat');
    assert.throws(() => api.launchReceipt({ outcome: { handle: 'agent-1' }, prompt: { outcome: 'unknown' } }));
  } finally {
    const resolved = path.resolve(testHome);
    assert.equal(path.dirname(resolved), sandbox);
    assert.match(path.basename(resolved), /^agentboat-demo-unit-/);
    rmSync(resolved, { recursive: true, force: true });
  }
});

function handlePlugin(name, input, s, save) {
  switch (name) {
    case 'projects.list': return { projects: [s.ref] };
    case 'workspace.agent': return s.main;
    case 'project.settings':
      if (s.failSettings) throw Error('settings unavailable');
      s.project.roles = input.roles;
      if (input.template && !s.project.leadAgents) s.project.leadAgents = { primary: { agent: 'codex' }, backup: { agent: 'antigravity' } };
      s.project.revision++; save(); return { project: s.project };
    case 'project.agent':
      if (input.operation === 'submit') {
        if (s.bindOnReceipt && input.requestId.endsWith('-receipt')) {
          s.bindOnReceipt = false; s.project.runId = 'run_project'; s.project.revision++; save();
        }
        if (input.revision !== s.project.revision) {
          throw Object.assign(Error('项目已更新，请刷新后再提交'), { code: 'invalid_request' });
        }
        s.project.requests.push({ id: input.requestId, fingerprint: createHash('sha256').update(JSON.stringify(input)).digest('hex') });
        s.project.tasks.push(input.task); s.project.revision++; save();
      }
      return { project: s.project, lead: s.lead };
    case 'workspace.message':
      if (input.runId !== s.main.runId) throw Error('主 Run 不匹配');
      if (!s.project.messages.some(m => m.requestId === input.requestId)) { s.project.messages.push(input); s.project.revision++; save(); }
      return { project: s.project, ...(!s.project.runId ? { queued: '项目还没有主会话，已排队' } : {}) };
  }
  throw Error('Unexpected plugin request ' + name);
}

async function fakeWorkspace(t) {
  const directory = mkdtempSync(path.join(sandbox, 'agentboat-demo-t39-'));
  t.after(() => {
    assert.equal(path.dirname(directory), sandbox);
    assert.match(path.basename(directory), /^agentboat-demo-t39-/);
    rmSync(directory, { recursive: true, force: true });
  });
  const projectDir = path.join(directory, 'agentboat-demo-project'), mainDir = path.join(directory, 'agentboat-demo-main');
  mkdirSync(projectDir); mkdirSync(mainDir);
  const home = path.join(directory, 'home'), log = path.join(directory, 'calls.jsonl'), data = path.join(directory, 'state.json');
  const input = path.join(directory, 'input.json'), fixture = path.join(directory, 'fake-cli.mjs');
  const ref = { id: 'p1', repoId: 'repo1', name: '现有项目', path: projectDir, workspace: 'identity:demo-project', hostId: 'local' };
  const state = { ref, repos: [{ id: ref.repoId, path: projectDir, kind: 'git', worktreeBasePath: directory }],
    main: { runId: 'run_main', session: { handle: 'orca_session_id:demo-main', path: mainDir } },
    project: { ref, revision: 0, runId: '', roles: { design: 'codex', code: 'claude', review: 'codex' }, messages: [], tasks: [], requests: [] } };
  const set = (value = state) => writeFileSync(data, JSON.stringify(value));
  const read = () => JSON.parse(readFileSync(data));
  set();
  writeFileSync(fixture, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const real = cp.execFileSync;
cp.execFileSync = (executable, args, options) => {
  if (executable === process.execPath || executable === 'git') return real(executable, args, options);
  if (executable !== 't39-fake-orca') throw Error('Unexpected command ' + executable);
  appendFileSync(process.env.T39_LOG, JSON.stringify(args) + '\\n');
  const s = JSON.parse(readFileSync(process.env.T39_STATE));
  const done = result => JSON.stringify({ ok: true, result });
  const save = () => writeFileSync(process.env.T39_STATE, JSON.stringify(s));
  const arg = key => args[args.indexOf(key) + 1];
  switch (args.slice(0, 2).join(' ')) {
    case 'repo list': return done({ repos: s.repos });
    case 'repo add': return done({ repo: s.repos[0] });
    case 'repo show': return done({ repo: s.repos[0] });
    case 'project setup-update':
      s.ref.name = arg('--display-name');
      if (args.includes('--worktree-base-path')) s.repos[0].worktreeBasePath = arg('--worktree-base-path');
      save(); return done({});
    case 'orchestration run-current': return done({ run: { id: s.main.runId } });
    case 'agent installed': return done({ agents: ['antigravity', 'claude', 'codex'].map(id => ({ id })) });
    case 'agent launch': return done({ outcome: { kind: 'structured', sessionId: 'fake-project-lead' }, prompt: { outcome: s.failLaunch ? 'unknown' : 'journaled' } });
    case 'worktree create': return done({ launch: { outcome: { kind: 'terminal', handle: 'fake-worker' }, prompt: { outcome: 'handed-to-terminal' } } });
  }
  throw Error('Unexpected Orca command: ' + args.slice(0,2));
};
syncBuiltinESMExports();`);
  const env = { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(fixture).href}`, ORCA_CLI_COMMAND: 't39-fake-orca', ORCA_AGENT_SESSION_ID: 'demo-main', ORCA_TERMINAL_HANDLE: '',
    T39_LOG: log, T39_STATE: data, AGENTBOAT_HOME: home, AGENTBOAT_TEST_ONLY: '1', AGENTBOAT_SANDBOX: sandbox };
  const profile = path.join(directory, 'profile');
  const release = path.join(profile, 'plugins', 'alayaella.agentboat', 'a'.repeat(64));
  for (const file of ['workspace', ...['client', 'cli-bridge', 'orca-cli', 'main-role-card'].map(name => `coordinator/scripts/${name}.mjs`)]) {
    cpSync(path.join(api.root, file), path.join(release, file), { recursive: true });
  }
  for (const file of ['setup.mjs', 'orca-plugin.json']) writeFileSync(path.join(release, file), '{}');
  writeFileSync(path.join(release, '../current'), path.basename(release));
  const { cliBridge } = await import(pathToFileURL(path.join(release, 'coordinator/scripts/cli-bridge.mjs')));
  const host = cliBridge({ panels: { handle() {} } });
  for (const name of ['workspace.agent', 'projects.list', 'project.agent', 'project.settings', 'project.lead', 'workspace.message']) {
    host.api.panels.handle(name, input => {
      appendFileSync(log, JSON.stringify(['installed', name]) + '\n');
      const s = read();
      if (name === 'project.lead') {
        assert.equal(input.startOnly, true);
        assert.equal(input.workspace, s.ref.workspace);
        assert.equal(s.project.runId, '');
        const leadAgents = s.project.leadAgents ?? { primary: { agent: 'codex' }, backup: { agent: 'antigravity' } };
        appendFileSync(log, JSON.stringify(['agent', 'launch', '--agent', leadAgents.primary.agent, '--prompt', path.join(profile, 'agentboat-current', input.introduction)]) + '\n');
        const takeover = s.failLaunch ? { state: 'uncertain', target: { handle: '' }, error: '未确认 agent 收到提示词' }
          : { state: 'waiting', target: { handle: 'orca_session_id:fake-project-lead' } };
        s.lead = { takeover }; s.project.revision++; set(s);
        return { binding: s.lead, leadAgents };
      }
      return handlePlugin(name, input, s, () => set(s));
    });
  }
  await host.start();
  t.after(() => host.stop());
  async function command(script, subcommand, payload) {
    writeFileSync(input, JSON.stringify(payload));
    const { stdout } = await promisify(execFile)(process.execPath, [script, subcommand, input],
      { env: { ...env, ORCA_USER_DATA_PATH: profile }, cwd: api.root, windowsHide: true });
    return JSON.parse(stdout);
  }
  return { home, directory, projectDir, state, set, read,
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    message: async requestId => (await command('coordinator/scripts/client.mjs', 'message', { projectId: ref.id, requestId, runId: state.main.runId, text: '模拟主人原话' })).result.result,
    workspace: (subcommand, payload) => command('workspace/workspace.mjs', subcommand, payload),
    installedWorkspace: (op, payload) => command(path.join(release, 'workspace/workspace.mjs'), op, payload) };
}

test('first message initializes only its own home, opens Codex and reuses the pending launch until expiry', async t => {
  const f = await fakeWorkspace(t);
  const options = ['--agent', 'codex'];
  const first = await f.message('message-1');
  assert.equal(first.queued, '项目还没有主会话，已排队');
  assert.deepEqual(first.autoLaunch, { status: 'awaiting-project-binding', projectName: '现有项目', handle: 'orca_session_id:fake-project-lead',
    agent: 'codex', reused: false });
  assert.equal(existsSync(path.join(f.home, 'templates/code.json')), true);
  assert.equal(existsSync(path.join(f.projectDir, '.git')), false);
  assert.equal((await f.message('message-2')).autoLaunch.reused, true);
  assert.equal(f.calls().filter(args => args[0] === 'agent').length, 1);
  const profile = path.join(f.home, 'projects/auto/p1/1.json');
  const pending = JSON.parse(readFileSync(profile)); pending.at = new Date(Date.now() - 11 * 60_000).toISOString(); writeFileSync(profile, JSON.stringify(pending));
  const expired = f.read(); expired.lead.takeover.state = 'expired'; f.set(expired);
  assert.equal((await f.message('message-3')).autoLaunch.reused, false);
  assert.deepEqual(f.calls().filter(args => args[0] === 'agent').map(args => args.slice(args.indexOf('--agent'), args.indexOf('--prompt'))), [options, options]);
  assert.deepEqual(f.read().project.messages.map(m => m.requestId), ['message-1', 'message-2', 'message-3']);
  assert.deepEqual(f.read().project.roles, f.state.project.roles);
  assert.equal(f.calls().some(args => ['repo add', 'project setup-update'].includes(args.slice(0,2).join(' ')) || args[1] === 'project.settings'), false);
});

test('an in-flight panel takeover keeps a relayed message queued without opening a second project lead', async t => {
  const f = await fakeWorkspace(t);
  f.state.lead = { takeover: { state: 'waiting', target: { handle: 'orca_session_id:fixture-takeover' } } };
  f.set();
  const result = await f.message('during-takeover');
  assert.equal(result.autoLaunch.status, 'awaiting-project-binding');
  assert.equal(result.autoLaunch.handle, 'orca_session_id:fixture-takeover');
  assert.equal(f.calls().filter(args => args[0] === 'agent').length, 0);
  assert.equal(f.read().project.messages.length, 1);
});

test('auto launch refuses the main directory, duplicate paths, remote or already bound projects and missing workspaces', async t => {
  const f = await fakeWorkspace(t);
  const withState = async (requestId, change, reason) => {
    const s = structuredClone(f.state); change(s); f.set(s);
    const result = await f.message(requestId);
    assert.match(result.autoLaunch.reason, reason);
    if (!s.project.runId) assert.equal(result.queued, '项目还没有主会话，已排队');
  };
  await withState('own', s => { s.main.session.path = f.projectDir; }, /自己的目录/);
  await withState('duplicate', s => { s.repos.push({ id: 'same', path: path.join(f.projectDir, '..', path.basename(f.projectDir)) }); }, /重复登记/);
  await withState('remote', s => { s.ref.hostId = 'ssh:remote'; }, /本机登记/);
  await withState('bound', s => { s.project.runId = 'run_project'; }, /已绑定/);
  await withState('missing-workspace', s => { s.ref.workspace = ''; }, /当前没有工作区/);
  assert.equal(f.calls().some(args => args[0] === 'agent'), false);
});

test('an uncertain launch preserves the queued message and waits for inspection', async t => {
  const f = await fakeWorkspace(t); f.state.failLaunch = true; f.set();
  assert.match((await f.message('uncertain')).autoLaunch.reason, /未确认 agent 收到提示词/);
  assert.equal((await f.message('next')).autoLaunch.status, 'needs-inspection');
  assert.equal(f.calls().filter(args => args[0] === 'agent').length, 1);
  assert.equal(f.read().project.messages.length, 2);
});

test('manual create shares launch defaults and the same pending-project guard', async t => {
  const f = await fakeWorkspace(t);
  const lead = await f.workspace('create', { requestId: 'manual-create', path: f.projectDir, name: 'agentboat-demo-existing', source: { kind: 'existing' } });
  assert.equal(lead.agent, 'codex'); assert.equal(lead.model, undefined); assert.equal(lead.effort, undefined);
  assert.equal(lead.handle, 'orca_session_id:fake-project-lead');
  assert.equal(f.read().project.leadAgents.backup.agent, 'antigravity');
  assert.equal((await f.message('after-manual')).autoLaunch.reused, true);
  assert.equal(f.calls().filter(args => args[0] === 'agent').length, 1);
});

for (const bindOnReceipt of [false, true]) test(`dispatch records its notice when binding ${bindOnReceipt ? 'races the receipt' : 'is still pending'}`, async t => {
  const f = await fakeWorkspace(t);
  f.state.bindOnReceipt = bindOnReceipt; f.state.project.roles.code = 'antigravity'; f.set();
  execFileSync('git', ['init', '--quiet'], { cwd: f.projectDir });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: f.projectDir });
  const result = await f.workspace('dispatch', { projectId: 'p1', requestId: 'dispatch-1', role: 'code', ...(bindOnReceipt ? { template: 'code' } : {}), name: 'agentboat-demo-worker', text: '只在隔离测试中处理', source: 'fake source' });
  assert.equal(result.autoLaunch.handle, 'orca_session_id:fake-project-lead');
  assert.equal(result.handle, 'fake-worker');
  assert.equal(result.notification.status, bindOnReceipt ? 'recorded' : 'queued');
  const calls = f.calls(), kinds = calls.map(args => args.slice(0, 2).join(' '));
  assert.ok(kinds.indexOf('agent launch') < kinds.indexOf('worktree create'));
  assert.equal(kinds.includes('orchestration send'), false);
  const launch = calls.find(args => args[0] === 'worktree');
  assert.equal(launch[launch.indexOf('--agent') + 1], 'antigravity');
  assert.match(launch[launch.indexOf('--prompt') + 1], /绑定后送达/);
  assert.deepEqual(f.read().project.tasks.map(task => task.id), ['direct-dispatch-1', 'direct-dispatch-1']);
  assert.deepEqual(f.read().project.messages.map(m => [m.runId, m.requestId]), [['run_main', 'dispatch-1-notice']]);
});

test('installed create resumes settings and dispatch records its notice through the local bridge', async t => {
  const f = await fakeWorkspace(t), workspace = f.installedWorkspace;
  const input = { requestId: 'installed-create', path: f.projectDir, name: 'agentboat-demo-bridge', source: { kind: 'existing' } };
  execFileSync('git', ['init', '--quiet'], { cwd: f.projectDir });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: f.projectDir });
  f.state.failSettings = true; f.set();
  await assert.rejects(workspace('create', input), /settings unavailable/);
  await assert.rejects(workspace('create', { ...input, name: input.name + '-other' }), /不同的立项输入/);
  const file = path.join(f.home, 'projects', input.requestId + '.json');
  const failed = JSON.parse(readFileSync(file));
  assert.equal(failed.stage, 'needs-inspection');
  delete failed.projectId; // v0.1.20 recorded only the registration receipt.
  writeFileSync(file, JSON.stringify(failed));
  const state = f.read(); state.failSettings = false; state.bindOnReceipt = true; f.set(state);
  const created = await workspace('create', input);
  assert.equal(created.stage, 'awaiting-project-binding');
  assert.deepEqual(await workspace('create', input), created);
  const task = await workspace('dispatch', { projectId: 'p1', requestId: 'installed-dispatch', name: 'agentboat-demo-worker', text: '模拟派活', source: 'fake source' });
  assert.equal(task.notification.status, 'recorded');
  const prompts = f.calls().filter(args => args.includes('--prompt')).map(args => args[args.indexOf('--prompt') + 1]);
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    assert.match(prompt, /agentboat-current/);
    assert.ok(!prompt.includes('a'.repeat(64)));
  }
  const calls = f.calls().map(args => args.slice(0, 2).join(' '));
  for (const once of ['repo add', 'project setup-update', 'agent launch', 'installed workspace.message'])
    assert.equal(calls.filter(call => call === once).length, 1, once);
  assert.equal(calls.filter(call => call === 'installed project.settings').length, 2);
});

test('legacy create journal closes against a manually bound folder project', async t => {
  const f = await fakeWorkspace(t);
  const input = { requestId: 'legacy-create', path: f.projectDir, name: 'agentboat-demo-folder', source: { kind: 'existing' } };
  f.state.ref.name = input.name;
  f.state.repos[0].kind = 'folder';
  f.state.project.runId = 'run_manually_bound';
  f.state.project.roles = { design: 'claude', code: 'codex', review: 'codex' };
  f.set();
  const file = path.join(f.home, 'projects', input.requestId + '.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ input, requestId: input.requestId, stage: 'needs-inspection',
    registered: { repo: f.state.repos[0] }, error: 'plugin_not_found' }));
  const result = await f.workspace('create', input);
  assert.equal(result.stage, 'already-bound');
  assert.equal(result.runId, f.state.project.runId);
  assert.equal(result.rolesMatchTemplate, true);
  assert.deepEqual(JSON.parse(readFileSync(file)), result);
  assert.deepEqual(await f.workspace('create', input), result);
  assert.deepEqual(f.calls().map(args => args[0] === 'installed' ? args[1] : args.slice(0, 2).join(' ')),
    ['repo show', 'projects.list', 'project.agent']);
});

test('retry after an uncertain create launch never opens another session, even after expiry', async t => {
  const f = await fakeWorkspace(t);
  f.state.failLaunch = true; f.set();
  const input = { requestId: 'uncertain-create', path: f.projectDir, name: 'agentboat-demo-uncertain', source: { kind: 'existing' } };
  await assert.rejects(f.workspace('create', input), /未确认 agent 收到提示词/);
  const file = path.join(f.home, 'projects/auto/p1/1.json');
  const attempt = JSON.parse(readFileSync(file));
  attempt.at = '2000-01-01T00:00:00Z';
  writeFileSync(file, JSON.stringify(attempt));
  await assert.rejects(f.workspace('create', input), /已有启动记录/);
  for (const once of ['repo add', 'project setup-update', 'agent launch']) {
    assert.equal(f.calls().filter(args => args.slice(0, 2).join(' ') === once).length, 1, once);
  }
});
