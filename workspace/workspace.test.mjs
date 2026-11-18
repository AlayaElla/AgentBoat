import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const sandbox = path.resolve(process.env.AGENTBOAT_SANDBOX || path.join(os.tmpdir(), 'agentboat-sandbox'));
mkdirSync(sandbox, { recursive: true });
const testHome = mkdtempSync(path.join(sandbox, 'agentboat-demo-unit-'));
process.env.AGENTBOAT_HOME = testHome;
process.env.AGENTBOAT_TEST_ONLY = '1';
const api = await import('./workspace.mjs');

test('初始化不覆盖模板；记忆按来源隔离、带日期、重复记录拒绝追加', () => {
  try {
    api.init();
    assert.equal(api.template('code').roles.code.agent, 'codex');
    const custom = path.join(testHome, 'templates/code.json');
    const value = JSON.parse(readFileSync(custom));
    value.name = '自定义';
    value.mainAgent = { agent: 'claude' };
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

function fakeWorkspace(t) {
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
    project: { ref, revision: 0, runId: '', roles: { design: 'codex', code: 'claude', review: 'codex' }, messages: [], tasks: [] } };
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
  const plugin = result => done({ result });
  const save = () => writeFileSync(process.env.T39_STATE, JSON.stringify(s));
  const arg = key => args[args.indexOf(key) + 1];
  switch (args.slice(0, 2).join(' ')) {
    case 'repo list': return done({ repos: s.repos });
    case 'repo add': return done({ repo: s.repos[0] });
    case 'repo show': return done({ repo: s.repos[0] });
    case 'project setup-update': s.ref.name = arg('--display-name'); save(); return done({});
    case 'orchestration run-current': return done({ run: { id: s.main.runId } });
    case 'agent launch': return done({ outcome: { kind: 'structured', sessionId: 'fake-project-lead' }, prompt: { outcome: s.failLaunch ? 'unknown' : 'journaled' } });
    case 'worktree create': return done({ launch: { outcome: { kind: 'terminal', handle: 'fake-worker' }, prompt: { outcome: 'handed-to-terminal' } } });
  }
  if (args.slice(0,3).join(' ') !== 'plugin dev request') throw Error('Unexpected fake request: ' + args.slice(0,3));
  const input = args.includes('--data') ? JSON.parse(arg('--data')) : {};
  switch (args[4]) {
    case 'projects.list': return plugin({ projects: [s.ref] });
    case 'workspace.agent': return plugin(s.main);
    case 'project.settings': s.project.roles = input.roles; s.project.revision++; save(); return plugin({ project: s.project });
    case 'project.agent':
      if (input.operation === 'submit') {
        if (s.bindOnReceipt && input.requestId.endsWith('-receipt')) {
          s.bindOnReceipt = false; s.project.runId = 'run_project'; s.project.revision++; save();
        }
        if (input.revision !== s.project.revision) {
          const error = Error('stale revision'); error.stdout = JSON.stringify({ ok: false, error: { code: 'plugin_request_failed', data: { requestCode: 'invalid_request' }, message: '项目已更新，请刷新后再提交' } }); throw error;
        }
        s.project.tasks.push(input.task); s.project.revision++; save();
      }
      return plugin({ project: s.project, lead: s.lead });
    case 'workspace.message':
      if (input.runId !== s.main.runId) throw Error('主 Run 不匹配');
      if (!s.project.messages.some(m => m.requestId === input.requestId)) { s.project.messages.push(input); s.project.revision++; save(); }
      return plugin({ project: s.project, ...(!s.project.runId ? { queued: '项目还没有主会话，已排队' } : {}) });
  }
  throw Error('Unexpected plugin request ' + args[4]);
};
syncBuiltinESMExports();`);
  const env = { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(fixture).href}`, ORCA_CLI_COMMAND: 't39-fake-orca', ORCA_AGENT_SESSION_ID: 'demo-main', ORCA_TERMINAL_HANDLE: '',
    T39_LOG: log, T39_STATE: data, AGENTBOAT_HOME: home, AGENTBOAT_TEST_ONLY: '1', AGENTBOAT_SANDBOX: sandbox };
  const command = (script, subcommand, payload) => {
    writeFileSync(input, JSON.stringify(payload));
    return JSON.parse(execFileSync(process.execPath, [script, subcommand, input], { env, cwd: api.root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  };
  return { home, directory, projectDir, state, set, read,
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    message: requestId => command('coordinator/scripts/client.mjs', 'message', { projectId: ref.id, requestId, runId: state.main.runId, text: '模拟主人原话' }).result.result,
    workspace: (subcommand, payload) => command('workspace/workspace.mjs', subcommand, payload) };
}

test('first message initializes only its own home, opens a chat and reuses the pending launch until expiry', t => {
  const f = fakeWorkspace(t);
  const options = ['--model', 'claude-opus-5-5', '--effort', 'xhigh', '--surface', 'chat'];
  const first = f.message('message-1');
  assert.equal(first.queued, '项目还没有主会话，已排队');
  assert.deepEqual(first.autoLaunch, { status: 'awaiting-project-binding', projectName: '现有项目', handle: 'orca_session_id:fake-project-lead',
    agent: 'claude', model: 'claude-opus-5-5', effort: 'xhigh', surface: 'chat', reused: false });
  assert.equal(existsSync(path.join(f.home, 'templates/code.json')), true);
  assert.equal(existsSync(path.join(f.projectDir, '.git')), false);
  assert.equal(f.message('message-2').autoLaunch.reused, true);
  assert.equal(f.calls().filter(args => args[0] === 'agent').length, 1);
  const profile = path.join(f.home, 'projects/auto/p1/1.json');
  const pending = JSON.parse(readFileSync(profile)); pending.at = new Date(Date.now() - 11 * 60_000).toISOString(); writeFileSync(profile, JSON.stringify(pending));
  assert.equal(f.message('message-3').autoLaunch.reused, false);
  assert.deepEqual(f.calls().filter(args => args[0] === 'agent').map(args => args.slice(args.indexOf('--model'), args.indexOf('--prompt'))), [options, options]);
  assert.deepEqual(f.read().project.messages.map(m => m.requestId), ['message-1', 'message-2', 'message-3']);
  assert.deepEqual(f.read().project.roles, f.state.project.roles);
  assert.equal(f.calls().some(args => ['repo add', 'project setup-update'].includes(args.slice(0,2).join(' ')) || args[4] === 'project.settings'), false);
});

test('an in-flight panel takeover keeps a relayed message queued without opening a second project lead', t => {
  const f = fakeWorkspace(t);
  f.state.lead = { takeover: { state: 'waiting', target: { handle: 'orca_session_id:fixture-takeover' } } };
  f.set();
  const result = f.message('during-takeover');
  assert.equal(result.autoLaunch.status, 'awaiting-project-binding');
  assert.equal(result.autoLaunch.handle, 'orca_session_id:fixture-takeover');
  assert.equal(f.calls().filter(args => args[0] === 'agent').length, 0);
  assert.equal(f.read().project.messages.length, 1);
});

test('auto launch refuses the main directory, duplicate paths, remote or already bound projects and missing workspaces', t => {
  const f = fakeWorkspace(t);
  const withState = (requestId, change, reason) => {
    const s = structuredClone(f.state); change(s); f.set(s);
    const result = f.message(requestId);
    assert.match(result.autoLaunch.reason, reason);
    if (!s.project.runId) assert.equal(result.queued, '项目还没有主会话，已排队');
  };
  withState('own', s => { s.main.session.path = f.projectDir; }, /自己的目录/);
  withState('duplicate', s => { s.repos.push({ id: 'same', path: path.join(f.projectDir, '..', path.basename(f.projectDir)) }); }, /重复登记/);
  withState('remote', s => { s.ref.hostId = 'ssh:remote'; }, /本机登记/);
  withState('bound', s => { s.project.runId = 'run_project'; }, /已绑定/);
  withState('missing-workspace', s => { s.ref.workspace = ''; }, /当前没有工作区/);
  assert.equal(f.calls().some(args => args[0] === 'agent'), false);
});

test('an uncertain launch preserves the queued message and waits for inspection', t => {
  const f = fakeWorkspace(t); f.state.failLaunch = true; f.set();
  assert.match(f.message('uncertain').autoLaunch.reason, /未确认 agent 收到提示词/);
  assert.equal(f.message('next').autoLaunch.status, 'needs-inspection');
  assert.equal(f.calls().filter(args => args[0] === 'agent').length, 1);
  assert.equal(f.read().project.messages.length, 2);
});

test('manual create shares launch defaults and the same pending-project guard', t => {
  const f = fakeWorkspace(t);
  const lead = f.workspace('create', { requestId: 'manual-create', path: f.projectDir, name: 'agentboat-demo-existing', source: { kind: 'existing' } });
  assert.equal(lead.surface, 'chat'); assert.equal(lead.model, 'claude-opus-5-5'); assert.equal(lead.effort, 'xhigh');
  assert.equal(lead.launched.outcome.sessionId, 'fake-project-lead');
  assert.equal(f.message('after-manual').autoLaunch.reused, true);
  assert.equal(f.calls().filter(args => args[0] === 'agent').length, 1);
});

for (const bindOnReceipt of [false, true]) test(`dispatch records its notice when binding ${bindOnReceipt ? 'races the receipt' : 'is still pending'}`, t => {
  const f = fakeWorkspace(t);
  f.state.bindOnReceipt = bindOnReceipt; f.set();
  execFileSync('git', ['init', '--quiet'], { cwd: f.projectDir });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: f.projectDir });
  const result = f.workspace('dispatch', { projectId: 'p1', requestId: 'dispatch-1', role: 'code', name: 'agentboat-demo-worker', text: '只在隔离测试中处理', source: 'fake source' });
  assert.equal(result.autoLaunch.handle, 'orca_session_id:fake-project-lead');
  assert.equal(result.handle, 'fake-worker');
  assert.equal(result.notification.status, bindOnReceipt ? 'recorded' : 'queued');
  const calls = f.calls(), kinds = calls.map(args => args.slice(0, 2).join(' '));
  assert.ok(kinds.indexOf('agent launch') < kinds.indexOf('worktree create'));
  assert.equal(kinds.includes('orchestration send'), false);
  const launch = calls.find(args => args[0] === 'worktree');
  assert.match(launch[launch.indexOf('--prompt') + 1], /绑定后送达/);
  assert.deepEqual(f.read().project.tasks.map(task => task.id), ['direct-dispatch-1', 'direct-dispatch-1']);
  assert.deepEqual(f.read().project.messages.map(m => [m.runId, m.requestId]), [['run_main', 'dispatch-1-notice']]);
});
