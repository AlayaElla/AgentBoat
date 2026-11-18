import { build } from 'esbuild';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright-core');
await fs.mkdir('.orca/local-test', { recursive: true });
await build({ entryPoints: ['src/panel-page.ts'], outfile: '.orca/local-test/panel.js', bundle: true, platform: 'browser', format: 'esm' });
const mockup = await fs.readFile('../docs/design/workspace-mockup-v8.html', 'utf8');
const tokens = mockup.slice(mockup.indexOf(':root{--orca-background'), mockup.indexOf('/* ②'));
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const files = { '/panel': 'src/panel.html', '/panel.css': 'src/panel.css', '/assets/Geist.woff2': 'src/assets/Geist.woff2', '/panel-page.ts': '.orca/local-test/panel.js' };
    if (!files[url.pathname]) { res.writeHead(404).end(); return; }
    let data = await fs.readFile(files[url.pathname]);
    if (url.pathname === '/panel') data = data.toString().replace('</head>', `<style>${tokens}</style></head>`);
    res.setHeader('Content-Type', url.pathname.endsWith('.ts') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.woff2') ? 'font/woff2' : 'text/html');
    res.end(data);
  } catch (e) { res.writeHead(500).end(e.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
const errors = [], results = [];
const test = async (name, work) => { await work(); results.push(name); console.log('PASS', name); };
let page;
async function setup(options = {}) {
  await page?.close(); page = await browser.newPage({ viewport: { width: options.width ?? 400, height: 900 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({ options }) => {
    const clone = x => structuredClone(x), now = Date.now(), events = {}, stored = {};
    const isJson = (value, seen = new Set()) => {
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
      if (typeof value === 'number') return Number.isFinite(value);
      if (typeof value !== 'object' || seen.has(value) || ![Object.prototype, Array.prototype].includes(Object.getPrototypeOf(value))) return false;
      const next = new Set(seen).add(value);
      return (Array.isArray(value) ? Array.from(value) : Object.values(value)).every(v => isJson(v, next));
    };
    const acceptance = id => ({ id, title: '成果 ' + id, details: '核对布局和内容', artifactIds: [], revision: 1, status: 'pending', history: [], fingerprint: 'version-1-' + id });
    const task = { id: 't1', title: '页面交付', goal: '完成页面', progress: '已交付', phase: 'ready', executions: [], artifacts: [], acceptance: [acceptance('a1'), acceptance('a2')], decisions: [], updatedAt: new Date().toISOString(), sourceIds: [] };
    const project = { version: 1, ref: { id: 'p1', name: '示例项目', hostId: 'local', repoId: 'repo', workspace: 'id:repo', path: '/example' }, revision: 2, runId: 'run_project', roles: { design: 'claude', code: 'codex', review: 'codex' }, tasks: [task], events: [], deliveries: [], requests: [] };
    const p = (id, relation, status = 'connected', scope = 'details') => ({ id, name: '工作间 ' + id, workspaceId: 'ws-' + id, state: status === 'pending' ? 'pending' : status === 'revoked' ? 'revoked' : 'active', relation, sharingSet: false, status, scope: 'none', projectIds: [], acceptTasks: 'deny', lastSyncAt: new Date(now - 100000).toISOString(), receivedAt: new Date(now).toISOString(), ...(status === 'connected' ? { report: { scope, acceptTasks: 'confirm', projects: scope === 'none' ? [] : [{ id: 'remote-p', name: '开放的项目', updatedAt: new Date().toISOString(), pending: 0, counts: { blocked: 1 }, ...(scope === 'details' ? { tasks: [{ title: '受阻任务', phase: 'blocked', decisions: [], acceptance: [] }] } : {}) }] } } : {}) });
    const links = { version: 1, revision: 1, workspaceId: 'self', name: '我的工作间', enabled: false, host: '127.0.0.1', port: 0, publicUrl: '', tls: false, listening: '', error: '', peers: [p('up', 'above'), p('down', 'below'), p('off', 'below', 'offline'), p('side', 'peer'), p('free', undefined), p('pending', undefined, 'pending'), p('revoked', 'below', 'revoked')], requests: [{ id: 'r1', peerId: 'up', workspaceId: 'ws-up', direction: 'incoming', title: '请帮忙整理', context: '背景', expected: '一份说明', links: [], createdAt: new Date().toISOString(), updates: [{ id: 'u1', status: 'confirm', note: '', links: [], at: new Date().toISOString() }] }] };
    const live = { ok: true, at: now, agents: [{ id: 'agent-need', projectId: 'p1', agent: 'codex', role: 'worker', state: 'need', rawState: 'waiting', verified: true, title: '等批准', last: '等待用户批准', since: now - 60000 }, { id: 'agent-work', projectId: 'p1', agent: 'claude', role: 'session', state: 'work', rawState: 'working', verified: false, title: '正在工作', last: '正在处理', since: now - 20000 }] };
    const workspace = { revision: 1, runId: options.unbound ? '' : 'run_main', ...(!options.unbound ? { session: { handle: 'main', agent: 'claude', title: '统筹会话', online: 'online' } } : {}) };
    const sessions = ['甲', '乙'].map((name, i) => ({ handle: 'session-' + i, title: name + '会话', workspace: 'identity:test', workspaceName: '示例工作区', path: '/test/工作区 with spaces', agent: i ? 'codex' : 'claude', online: 'online' }));
    const attention = () => task.acceptance.filter(a => a.status === 'pending').map(a => ({ projectId: 'p1', taskId: 't1', kind: 'review', itemId: a.id, title: task.title, summary: a.title }));
    const calls = [];
    window.fixture = { project, links, live, workspace, calls, stored, workspaceTarget: { workspaceId: 'identity:project-workspace', multipleConversations: true }, emit: () => events['project.changed']?.({}), race: false, prune: () => { task.acceptance[0].revision++; task.acceptance[0].fingerprint = 'new-version'; project.revision++; } };
    window.orca = { storage: { get: async k => clone(stored[k] ?? null), set: async (k, v) => { stored[k] = clone(v); }, delete: async k => { delete stored[k]; } }, plugin: { on: (name, callback) => { events[name] = callback; return { dispose() {} }; }, request: async (name, input) => {
      if (input !== undefined && !isJson(input)) throw Error('input: Invalid input');
      calls.push({ name, input: clone(input) });
      if (name === 'workspace.overview') return clone({ workspace, projects: [{ ref: project.ref, counts: { review: task.acceptance.filter(a => a.status === 'pending').length ? 1 : 0 }, agents: [], bound: true, updatedAt: '' }, ...(options.manyProjects ? Array.from({ length: 13 }, (_, i) => ({ ref: { ...project.ref, id: 'p' + (i + 2), name: '项目 ' + (i + 2) }, counts: { working: options.idleProjects ? 0 : 1 }, agents: [], bound: true, updatedAt: '' })) : [])], hidden: [], attention: attention(), links, connections: [], machines: [{ id: 'local', name: '主机', role: 'host' }] });
      if (name === 'workspace.agents') return clone(live);
      if (name === 'project.read') return clone({ project, projects: [project.ref], workspaceTarget: window.fixture.workspaceTarget, mainAgent: window.fixture.mainAgent });
      if (name === 'project.openMain') {
        if (window.fixture.delayOpen) await new Promise(r => { window.fixture.finishOpen = r; });
        if (window.fixture.openError) throw Error(window.fixture.openError);
        return { opened: true, multipleConversations: window.fixture.workspaceTarget.multipleConversations };
      }
      if (name === 'project.feedback') {
        if (window.fixture.delayFeedback) { window.fixture.delayFeedback = false; await new Promise(r => { window.fixture.finishFeedback = r; }); }
        if (window.fixture.race) { window.fixture.race = false; window.fixture.prune(); throw Error('成果已更新'); }
        for (const i of input.items) { const a = i.kind === 'acceptance' ? task.acceptance.find(a => a.id === i.itemId) : task.decisions.find(d => d.id === i.itemId); if (!a || i.kind === 'acceptance' && a.revision !== i.itemRevision) throw Error('stale'); }
        for (const i of input.items) { if (i.kind === 'acceptance') task.acceptance.find(a => a.id === i.itemId).status = i.result; else task.decisions.find(d => d.id === i.itemId).answer = i.answer; }
        project.deliveries.push({ id: 'summary', subject: '用户反馈', body: '', state: 'pending' }); project.revision++;
        return clone({ project });
      }
      if (name === 'workspace.links') {
        if (input.operation === 'invite') {
          if (window.fixture.inviteError) throw Error(window.fixture.inviteError);
          Object.assign(links, { enabled: true, host: '100.64.0.42', port: 43123, publicUrl: 'http://100.64.0.42:43123', listening: 'http://100.64.0.42:43123' });
          return { ...clone(links), invitation: { code: 'AB1.fixture', expiresAt: new Date(Date.now() + 120000).toISOString() } };
        }
        if (input.operation === 'join') links.peers.push(p('joined', undefined));
        const peer = links.peers.find(p => p.id === input.id);
        if (input.operation === 'relate') peer.relation = input.relation ?? undefined;
        if (input.operation === 'share') Object.assign(peer, input, { sharingSet: true });
        links.revision++; return clone(links);
      }
      if (name === 'workspace.requests') { if (!workspace.runId) throw Error('no main agent'); return clone(links); }
      if (name === 'workspace.agent.targets') return { sessions: clone(sessions), workspaces: [{ workspace: 'identity:test', name: '示例工作区', path: '/test/工作区 with spaces' }] };
      if (name === 'workspace.agent.switch') {
        if (input.revision !== workspace.revision) throw Error('工作间已更新');
        workspace.revision++;
        if (input.mode === 'cancel') delete workspace.takeover;
        else workspace.takeover = { id: String(workspace.revision), target: input.mode === 'new' ? { title: '新的 ' + input.agent + ' 会话' } : sessions.find(s => s.handle === input.handle), state: 'waiting', expiresAt: new Date(Date.now() + 600000).toISOString() };
        if (window.fixture.delaySwitch) { window.fixture.delaySwitch = false; window.fixture.emit(); await new Promise(r => { window.fixture.finishSwitch = r; }); }
        return clone(workspace);
      }
      if (name === 'workspace.connections') return [];
      throw Error('Unexpected ' + name);
    } } };
  }, { options });
  await page.goto(`http://127.0.0.1:${server.address().port}/panel`);
  await page.getByRole('heading', { name: '组织', exact: true }).waitFor();
}
const home = async () => { await page.getByRole('button', { name: /^待处理 / }).click(); await page.getByRole('heading', { name: '组织', exact: true }).waitFor(); };
const project = async () => { await page.locator('[data-project=p1] .pcard-h').click(); await page.getByRole('button', { name: '这 2 项全部通过', exact: true }).waitFor(); };
try {
  for (const wide of [false, true]) {
    await setup({ width: wide ? 1040 : 400 });
    await test(`${wide ? 'wide inbox lists every item and scrolls independently' : 'narrow inbox keeps three items and expands on demand'}`, async () => {
      await page.evaluate(() => { fixture.live.agents.push(...Array.from({ length: 40 }, (_, i) => ({ ...fixture.live.agents[0], id: 'need-' + i, state: 'need' }))); fixture.emit(); });
      await page.waitForFunction(() => document.querySelector('.inbox .pill')?.textContent === '43');
      const inbox = page.locator('.inbox'), more = inbox.getByRole('button', { name: /^再看 / });
      assert.equal(await inbox.locator('.item:visible').count(), wide ? 43 : 3);
      if (wide) {
        assert.equal(await more.isVisible(), false);
        assert.equal(await inbox.evaluate(e => e.scrollHeight > e.clientHeight && getComputedStyle(e).overflowY === 'auto'), true);
        await inbox.hover();
        const organizationTop = (await page.locator('.home>section').nth(1).boundingBox()).y;
        const rootTop = await page.locator('#panel').evaluate(e => e.scrollTop);
        await page.mouse.wheel(0, 600);
        await page.waitForFunction(() => document.querySelector('.inbox').scrollTop > 0);
        assert.equal(await page.locator('#panel').evaluate(e => e.scrollTop), rootTop);
        assert.equal((await page.locator('.home>section').nth(1).boundingBox()).y, organizationTop);
      } else {
        assert.equal(await more.textContent(), '再看 40 条'); await more.click();
        assert.equal(await inbox.locator('.item:visible').count(), 43);
      }
    });
  }
  for (const multipleConversations of [true, false]) {
    await setup({ width: 300 });
    await test(`project opens main workspace once and ${multipleConversations ? 'shows' : 'omits'} tab hint`, async () => {
      await page.evaluate(multiple => { fixture.workspaceTarget.multipleConversations = multiple; fixture.delayOpen = true; }, multipleConversations);
      await project();
      const open = page.getByRole('button', { name: '打开主会话', exact: true });
      assert.equal(await open.isEnabled(), true);
      assert.equal(await page.locator('#panel').evaluate(e => e.scrollWidth <= e.clientWidth), true);
      await open.evaluate(button => { button.click(); button.click(); });
      await page.waitForFunction(() => !!fixture.finishOpen);
      assert.equal(await open.isDisabled(), true);
      await page.evaluate(() => fixture.finishOpen());
      await page.getByRole('status').filter({ hasText: '已打开项目所在的工作区' }).waitFor();
      assert.equal((await page.getByRole('status').allTextContents()).some(t => t.includes('如果有多个对话，点一下主会话的标签')), multipleConversations);
      assert.deepEqual(await page.evaluate(() => fixture.calls.filter(c => c.name === 'project.openMain')), [{ name: 'project.openMain', input: { projectId: 'p1' } }]);
    });
  }
  await setup();
  await test('project workspace opens with no bound Run and unreadable conversation count', async () => {
    await page.evaluate(() => { fixture.project.runId = ''; delete fixture.workspaceTarget.multipleConversations; });
    await project();
    assert.equal(await page.getByRole('button', { name: '打开主会话', exact: true }).isEnabled(), true);
    await page.getByRole('button', { name: '打开主会话', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已打开项目所在的工作区' }).waitFor();
    assert.equal((await page.getByRole('status').allTextContents()).some(t => t.includes('点一下主会话的标签')), false);
  });
  for (const reason of ['项目工作区已被移除或不可用', '工作区列表未完整返回，请刷新后重试', 'Orca: workspace inventory unavailable']) {
    await setup();
    await test(`project disables main workspace button with visible reason: ${reason}`, async () => {
      await page.evaluate(reason => { fixture.workspaceTarget = { error: reason }; }, reason);
      await project();
      const open = page.getByRole('button', { name: '打开主会话', exact: true });
      assert.equal(await open.isDisabled(), true); assert.equal(await open.getAttribute('title'), reason);
      assert.equal(await page.getByText(reason, { exact: true }).isVisible(), true);
      assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.name === 'project.openMain').length), 0);
      await page.evaluate(() => { fixture.workspaceTarget = { workspaceId: 'identity:project-workspace', multipleConversations: false }; fixture.emit(); });
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === '打开主会话' && !b.disabled));
    });
  }
  await setup();
  await test('project settings show recorded agent type and unknown without a record', async () => {
    await project(); await page.getByRole('button', { name: '项目设置', exact: true }).click();
    await page.getByText('项目主 agent：未知', { exact: true }).waitFor();
    for (const [value, label] of [['claude', 'Claude'], ['codex', 'Codex']]) {
      await page.evaluate(value => { fixture.mainAgent = value; fixture.emit(); }, value);
      await page.getByText('项目主 agent：' + label, { exact: true }).waitFor();
    }
  });
  await setup();
  await test('shared actions immediately show submission feedback and respect reduced motion', async () => {
    await project(); await page.getByRole('button', { name: '这 2 项全部通过' }).click();
    await page.getByRole('button', { name: '提交 2 条', exact: true }).evaluate(button => {
      fixture.delayFeedback = true; button.click();
      const waiting = document.querySelector('button[aria-busy=true]');
      if (waiting?.textContent !== '提交中…' || !waiting.disabled || !waiting.querySelector('.spinner')) throw Error('No immediate wait effect');
    });
    await page.waitForFunction(() => !!fixture.finishFeedback);
    const waiting = page.locator('button[aria-busy=true]');
    assert.equal(await waiting.textContent(), '提交中…');
    assert.equal(await page.getByRole('button', { name: '清空', exact: true }).isDisabled(), true);
    assert.equal(await waiting.locator('.spinner').evaluate(e => getComputedStyle(e).animationName), 'ab-spin');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await waiting.locator('.spinner').evaluate(e => getComputedStyle(e).display), 'none');
    assert.equal(await waiting.textContent(), '提交中…');
    await page.evaluate(() => fixture.finishFeedback());
    await page.getByRole('status').filter({ hasText: '已提交 2 条' }).waitFor();
    assert.equal(await page.locator('button[aria-busy=true]').count(), 0);
    assert.equal(await page.getByRole('button', { name: '打开主会话', exact: true }).isEnabled(), true);
  });
  await setup();
  await test('workspace open error stays visible while an available workspace remains clickable', async () => {
    await project(); await page.evaluate(() => { fixture.openError = 'Orca: workspace no longer exists'; });
    await page.getByRole('button', { name: '打开主会话', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Orca: workspace no longer exists' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '打开主会话', exact: true }).isEnabled(), true);
    assert.equal(await page.getByText('Orca: workspace no longer exists', { exact: true }).count(), 1);
    assert.equal(await page.getByRole('status').filter({ hasText: '已打开项目所在的工作区' }).count(), 0);
  });
  await setup();
  await test('workspace removed during open disables button after rechecking', async () => {
    await project(); await page.evaluate(() => { fixture.openError = 'Orca: workspace removed'; fixture.workspaceTarget = { error: '项目工作区已被移除或不可用' }; });
    await page.getByRole('button', { name: '打开主会话', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Orca: workspace removed' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '打开主会话', exact: true }).isDisabled(), true);
    assert.equal(await page.getByText('项目工作区已被移除或不可用', { exact: true }).isVisible(), true);
  });
  await test('v8 mockup pages open in a headless browser', async () => {
    page = await browser.newPage(); page.on('pageerror', e => errors.push(e.message));
    for (const kind of ['home', 'project', 'task', 'project-settings', 'settings', 'main', 'connections', 'connection', 'add-connection', 'links', 'machines', 'agents', 'request', 'peer', 'peer-project', 'dispatch', 'relation']) {
      const params = new URLSearchParams({ page: kind, id: ['request'].includes(kind) ? 'r1' : ['connection'].includes(kind) ? 'hermes' : ['task'].includes(kind) ? 't1' : ['relation'].includes(kind) ? 'out' : 'ops', project: 'web', pid: 'ox0' });
      await page.goto(pathToFileURL(path.resolve('../docs/design/workspace-mockup-v8.html')).href + '#' + params); await page.locator('#panel').waitFor();
    }
  });
  for (const unbound of [true, false]) {
    await setup({ unbound, width: 300 });
    await test(`main agent one-click ${unbound ? 'set' : 'replace'}, pending cancel/reselect, expiry/failure and new Claude/Codex`, async () => {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: '主 agent', exact: true }).click();
      const action = unbound ? '设为主 agent' : '换成它';
      assert.equal(await page.getByRole('checkbox').count(), 0);
      assert.equal(await page.getByLabel('切换方式', { exact: true }).count(), 0);
      await page.evaluate(() => { fixture.delaySwitch = true; });
      await page.getByRole('button', { name: action, exact: true }).nth(0).click();
      await page.getByText('正在等 甲会话 接管，还剩 10 分钟', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: action, exact: true }).nth(1).isEnabled(), true);
      assert.equal(await page.getByRole('button', { name: '取消', exact: true }).isEnabled(), true);
      await page.getByRole('button', { name: action, exact: true }).nth(1).click();
      await page.getByText('正在等 乙会话 接管，还剩 10 分钟', { exact: true }).waitFor();
      await page.evaluate(() => fixture.finishSwitch());
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await page.getByRole('button', { name: '取消', exact: true }).waitFor({ state: 'detached' });
      await page.getByRole('button', { name: '新开一个主 agent', exact: true }).click();
      await page.getByText('正在等 新的 claude 会话 接管，还剩 10 分钟', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Agent', { exact: true }).inputValue(), 'claude');
      await page.getByLabel('Agent', { exact: true }).selectOption('codex');
      await page.getByRole('button', { name: '新开一个主 agent', exact: true }).click();
      await page.getByText('正在等 新的 codex 会话 接管，还剩 10 分钟', { exact: true }).waitFor();
      await page.evaluate(() => { fixture.workspace.takeover.error = '接管请求未能确认送达，请核对目标会话后重试'; fixture.workspace.takeover.state = 'uncertain'; fixture.emit(); });
      await page.getByRole('alert').filter({ hasText: '未能确认送达' }).waitFor();
      await page.evaluate(() => { fixture.workspace.takeover.expiresAt = new Date(Date.now() - 1).toISOString(); fixture.emit(); });
      await page.getByRole('alert').filter({ hasText: '对方没在有效期内完成绑定' }).waitFor();
      assert.equal(await page.locator('#panel').evaluate(e => e.scrollWidth <= e.clientWidth), true);
      const calls = await page.evaluate(() => fixture.calls.filter(c => c.name === 'workspace.agent.switch'));
      assert.equal(calls.length, 5); assert.equal(calls[0].input.mode, 'existing'); assert.equal(calls[1].input.handle, 'session-1');
      assert.equal(calls[2].input.mode, 'cancel'); assert.equal(calls[3].input.agent, 'claude'); assert.equal(calls[4].input.agent, 'codex');
    });
  }
  await setup();
  await test('home sections, shared counts, self once, direct peers only, relation wires, details-only red dot', async () => {
    assert.equal(await page.locator('.home>section').count(), 2);
    assert.equal(await page.locator('[data-workspace=self]').count(), 1);
    assert.equal(await page.locator('.inbox .pill').innerText(), '3');
    assert.equal(await page.locator('[data-workspace=self] .wsr-top .pill').innerText(), '2');
    assert.equal(await page.locator('[data-workspace=pending],[data-workspace=revoked]').count(), 0);
    assert.equal(await page.locator('.org-up [data-workspace=up],.org-kids [data-workspace=down],.org-side [data-workspace=side]').count(), 3);
    assert.equal(await page.locator('[data-workspace=down] .flag').count(), 1);
    assert.equal(await page.locator('[data-workspace=off] .flag').count(), 0);
    assert.equal(await page.locator('.org-free [data-workspace=free]').count(), 1);
    assert.equal(await page.locator('.org-kids').evaluate(e => getComputedStyle(e.firstElementChild, '::before').borderLeftStyle), 'solid');
    assert.equal(await page.locator('.org-side').evaluate(e => getComputedStyle(e.firstElementChild, '::before').borderLeftStyle), 'dashed');
    await page.evaluate(() => { fixture.links.peers.find(p => p.id === 'down').report.scope = 'summary'; fixture.emit(); });
    await page.waitForFunction(() => !document.querySelector('[data-workspace=down] .flag'));
  });
  await test('remote workspace has connection/projects/requests, readonly summary hides task details', async () => {
    await page.locator('[data-workspace=down] .wsr-h').click();
    const body = page.locator('[data-workspace=down] .wsr-b');
    assert.equal(await body.getByRole('heading').allTextContents().then(x => x.join(',')), '项目,请求');
    assert.equal(await body.getByText('主 agent', { exact: true }).count(), 0);
    await body.getByRole('button', { name: '开放的项目' }).click();
    assert.equal(await page.locator('input,textarea').count(), 0); assert.equal(await page.getByText('受阻任务', { exact: true }).count(), 0);
    await home();
  });
  await test('bulk all-pass only selects; one submit click sends one project batch', async () => {
    await project(); await page.getByRole('button', { name: '这 2 项全部通过' }).click();
    assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.name === 'project.feedback').length), 0);
    await page.getByRole('button', { name: '提交 2 条', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已提交 2 条' }).waitFor();
    assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.name === 'project.feedback').length), 1);
    assert.equal(await page.evaluate(() => fixture.project.deliveries.length), 1);
  });
  await setup();
  await test('rapid double submit sends one batch and blocks selection changes while pending', async () => {
    await project(); await page.getByRole('button', { name: '这 2 项全部通过' }).click();
    await page.getByRole('button', { name: '提交 2 条', exact: true }).evaluate(button => {
      fixture.delayFeedback = true; button.click(); button.click();
    });
    await page.waitForFunction(() => !!fixture.finishFeedback);
    assert.equal(await page.locator('[data-sheet] .primary').isDisabled(), true);
    assert.equal(await page.locator('#panel').evaluate(e => e.inert), true);
    const request = await page.evaluate(() => fixture.calls.filter(c => c.name === 'project.feedback'));
    assert.equal(request.length, 1); assert.ok(request[0].input.requestId); assert.equal(request[0].input.items.length, 2);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-heading]').textContent(), '项目');
    assert.equal(await page.evaluate(() => Object.keys(fixture.stored['panel.drafts'].p1).length), 2);
    await page.evaluate(() => fixture.finishFeedback());
    await page.getByRole('status').filter({ hasText: '已提交 2 条' }).waitFor();
    assert.equal(await page.locator('#panel').evaluate(e => e.inert), false);
    assert.deepEqual(await page.evaluate(() => fixture.calls.filter(c => c.name === 'project.feedback')), request);
    assert.equal(await page.evaluate(() => fixture.project.deliveries.length), 1);
  });
  await setup();
  await test('unfinished modification notes and decisions disable submit', async () => {
    await page.evaluate(() => { fixture.project.tasks[0].decisions.push({ id: 'd1', question: '选择交付方式', options: ['按方案一'], history: [] }); fixture.emit(); });
    await project(); await page.getByRole('button', { name: '需要修改', exact: true }).first().click();
    assert.equal(await page.getByRole('button', { name: '提交 1 条', exact: true }).isDisabled(), true);
    await page.getByLabel('修改意见', { exact: true }).fill('调整间距');
    assert.equal(await page.getByRole('button', { name: '提交 1 条', exact: true }).isDisabled(), false);
    await page.getByRole('radio', { name: '其他', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '提交 2 条', exact: true }).isDisabled(), true);
    await page.getByLabel('你的决定', { exact: true }).fill('按方案二');
    assert.equal(await page.getByRole('button', { name: '提交 2 条', exact: true }).isDisabled(), false);
    assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.name === 'project.feedback').length), 0);
  });
  await setup();
  await test('strict JSON bridge rejects undefined and mixed decision/acceptance batch submits once', async () => {
    const rejected = await page.evaluate(async () => {
      let rejected = 0;
      for (const input of [{ item: undefined }, { items: [{ answer: undefined }] }, { items: [undefined] }, { number: NaN }, { fn() {} }]) {
        try { await orca.plugin.request('workspace.overview', input); } catch (e) { if (e.message === 'input: Invalid input') rejected++; }
      }
      fixture.project.tasks[0].decisions.push({ id: 'd1', question: '选择交付方式', options: ['按方案一'], history: [] }); fixture.emit();
      return rejected;
    });
    assert.equal(rejected, 5);
    await project();
    await page.getByRole('radio', { name: '按方案一', exact: true }).check();
    await page.getByRole('button', { name: '通过', exact: true }).first().click();
    await page.getByRole('button', { name: '提交 2 条', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已提交 2 条' }).waitFor();
    const result = await page.evaluate(() => ({ items: fixture.calls.find(c => c.name === 'project.feedback').input.items, task: fixture.project.tasks[0], deliveries: fixture.project.deliveries }));
    assert.equal(result.task.decisions[0].answer, '按方案一'); assert.equal(result.task.acceptance[0].status, 'passed');
    assert.equal(result.task.acceptance[1].status, 'pending'); assert.equal(result.deliveries.length, 1);
    const decision = result.items.find(i => i.kind === 'decision'), acceptance = result.items.find(i => i.kind === 'acceptance');
    assert.equal(Object.hasOwn(decision, 'itemRevision'), false); assert.equal(Object.hasOwn(decision, 'result'), false); assert.equal(Object.hasOwn(acceptance, 'answer'), false);
  });
  for (const stale of ['refresh', 'preflight', 'feedback']) {
    await setup(); await project(); await page.getByRole('button', { name: '这 2 项全部通过' }).click();
    await test(`${stale} prunes stale draft, rejects stale batch and preserves other draft for resubmission`, async () => {
      if (stale === 'feedback') await page.evaluate(() => { fixture.race = true; });
      else { await page.evaluate(stale => { fixture.prune(); if (stale === 'refresh') fixture.emit(); }, stale); if (stale === 'refresh') await page.getByRole('status').filter({ hasText: '原选择已作废' }).waitFor(); }
      if (stale !== 'refresh') {
        await page.getByRole('button', { name: '提交 2 条', exact: true }).click();
        await (stale === 'feedback' ? page.getByRole('alert') : page.getByRole('status').filter({ hasText: '这次一条都没有提交' })).waitFor();
        assert.equal(await page.evaluate(() => fixture.project.deliveries.length), 0);
        assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.name === 'project.feedback').length), stale === 'feedback' ? 1 : 0);
      }
      assert.equal(await page.evaluate(() => Object.keys(fixture.stored['panel.drafts'].p1).length), 1);
      await page.getByRole('button', { name: '提交 1 条', exact: true }).click(); await page.getByRole('status').filter({ hasText: '已提交 1 条' }).waitFor();
    });
  }
  await setup();
  await test('connection opens with two actions and collapsed advanced settings; invite copies and join needs only a code', async () => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '工作间连接', exact: true }).click();
    const invite = page.getByRole('button', { name: '邀请', exact: true }), join = page.getByRole('button', { name: '加入', exact: true });
    const advanced = page.locator('details', { hasText: '高级' });
    assert.equal(await advanced.evaluate(e => e.open), false);
    for (const label of ['工作间名称', '监听 IP', '端口', '访问地址', 'TLS', 'TLS 证书', 'TLS 私钥']) assert.equal(await advanced.getByLabel(label, { exact: true }).isVisible(), false);
    assert.equal(await join.isDisabled(), true);
    await page.evaluate(() => { fixture.inviteError = '无法监听，请检查地址、端口和 TLS 证书'; });
    await invite.click();
    await page.getByRole('alert').filter({ hasText: '无法监听' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '复制连接码' }).count(), 0);
    await page.evaluate(() => { fixture.inviteError = ''; fixture.calls.length = 0; });
    await invite.click();
    await page.getByRole('button', { name: '复制连接码', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已复制连接码' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'AB1.fixture');
    assert.equal(await advanced.evaluate(e => e.open), false);
    await advanced.locator('summary').click();
    assert.equal(await advanced.getByLabel('监听 IP', { exact: true }).inputValue(), '100.64.0.42');
    assert.equal(await advanced.getByLabel('端口', { exact: true }).inputValue(), '43123');
    await advanced.locator('summary').click();
    await page.getByLabel('对方的连接码').fill('  AB1.fixture  ');
    await join.click();
    await page.getByRole('status').filter({ hasText: '已加入工作间' }).waitFor();
    assert.deepEqual(await page.evaluate(() => fixture.calls.filter(c => c.name === 'workspace.links').map(c => c.input)), [
      { operation: 'invite' }, { operation: 'join', code: 'AB1.fixture' }
    ]);
    assert.equal(await advanced.evaluate(e => e.open), false);
    assert.equal(await page.locator('#panel').evaluate(e => e.scrollWidth <= e.clientWidth), true);
  });
  await setup();
  await test('relation suggestions are drafts, user edits survive relation switches, later relation preserves sharing', async () => {
    await page.locator('[data-workspace=free]').getByRole('button', { name: '标关系' }).click();
    await page.getByRole('radio', { name: '上级 · 画在你上面' }).check();
    assert.equal(await page.getByLabel('开放范围').inputValue(), 'summary');
    assert.equal(await page.evaluate(() => fixture.links.peers.find(p => p.id === 'free').relation), undefined);
    await page.getByLabel('开放范围').selectOption('details'); await page.getByRole('radio', { name: '下级 · 画在你下面' }).check();
    assert.equal(await page.getByLabel('开放范围').inputValue(), 'details');
    await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('heading', { name: '组织', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => fixture.links.peers.find(p => p.id === 'free').scope), 'details');
    await page.locator('[data-workspace=free] .wsr-h').click(); await page.locator('[data-workspace=free]').getByRole('button', { name: '连接设置' }).click(); await page.getByRole('button', { name: '改关系', exact: true }).click();
    await page.getByRole('radio', { name: '平级 · 虚线相连' }).check(); assert.equal(await page.getByLabel('开放范围').count(), 0);
    await page.getByRole('button', { name: '保存', exact: true }).click(); await page.waitForFunction(() => fixture.links.peers.find(p => p.id === 'free').relation === 'peer');
    assert.equal(await page.evaluate(() => fixture.links.peers.find(p => p.id === 'free').scope), 'details');
  });
  for (const id of ['down', 'off']) {
    await setup();
    await test('dispatch ' + (id === 'off' ? 'offline queues without Run' : 'online addresses peer main'), async () => {
      await page.locator(`[data-workspace=${id}] .wsr-h`).click(); await page.locator(`[data-workspace=${id}]`).getByRole('button', { name: '派活', exact: true }).click();
      await page.getByLabel('要做什么').fill('整理资料'); await page.getByLabel('期望结果').fill('一份说明');
      await page.getByRole('button', { name: '发出', exact: true }).click(); await page.waitForFunction(() => fixture.calls.some(c => c.name === 'workspace.requests'));
      const c = await page.evaluate(() => fixture.calls.find(c => c.name === 'workspace.requests').input); assert.equal(c.peerId, id); assert.equal(c.runId, undefined); assert.ok(c.requestId);
    });
  }
  await setup({ unbound: true });
  await test('unbound main disables dispatch and explains why', async () => { await page.locator('[data-workspace=down] .wsr-h').click(); assert.equal(await page.locator('[data-workspace=down]').getByRole('button', { name: '派活', exact: true }).isDisabled(), true); assert.ok(await page.locator('[data-workspace=down] span[title]').getAttribute('title').then(x => x.includes('主 agent'))); });
  await setup();
  await test('host agents distinguish need/work and show one unreadable notice', async () => { await page.getByRole('button', { name: '全部 agent', exact: true }).click(); assert.equal(await page.locator('[data-st=need]').count(), 1); assert.equal(await page.locator('[data-st=work]').count(), 1); assert.ok(!(await page.locator('[data-st=work]').innerText()).includes('未核实')); await page.evaluate(() => { fixture.live.ok = false; fixture.live.agents = []; fixture.emit(); }); await page.getByText('agent 状态读不到', { exact: true }).waitFor(); assert.equal(await page.getByText('agent 状态读不到', { exact: true }).count(), 1); });
  await setup({ manyProjects: true });
  await test('agent failure and truncation each render once across home, project and task pages', async () => {
    await page.evaluate(() => { fixture.live.ok = false; fixture.emit(); });
    await page.getByText('agent 状态读不到', { exact: true }).waitFor();
    await project();
    assert.equal(await page.getByText('agent 状态读不到', { exact: true }).count(), 1);
    await page.getByRole('tab', { name: 'Agent', exact: true }).click();
    assert.equal(await page.getByText('agent 状态读不到', { exact: true }).count(), 1);
    await page.getByRole('tab', { name: '任务', exact: true }).click();
    await page.getByRole('button', { name: '页面交付', exact: true }).click();
    assert.equal(await page.getByText('agent 状态读不到', { exact: true }).count(), 1);
    await page.evaluate(() => { fixture.live.ok = true; fixture.live.truncated = true; fixture.emit(); });
    await page.getByText('agent 状态未全部读取，数量仅含已读取的工作区', { exact: true }).waitFor();
    assert.equal(await page.getByText('agent 状态读不到', { exact: true }).count(), 0);
  });
  await setup({ manyProjects: true });
  await test('fourteen projects keep up to three agent rows and one completion count; empty cards have only a header', async () => {
    await page.evaluate(() => {
      const a = fixture.live.agents[0];
      fixture.live.agents.push(...Array.from({ length: 3 }, (_, i) => ({ ...a, id: 'extra' + i, state: 'work' })),
        ...['p1', 'p1', 'p2', 'p2'].map((projectId, i) => ({ ...a, id: 'done' + i, projectId, state: 'done' })),
        { ...a, id: 'work-p3', projectId: 'p3', state: 'work', title: '项目三工作' });
      fixture.emit();
    });
    await page.locator('[data-project=p2]').getByText('✓ 已完成 2 个', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-project]').count(), 14);
    assert.equal(await page.locator('[data-project=p1] .arow').count(), 3);
    assert.equal(await page.locator('[data-project=p1] .pcard-b').innerText().then(t => t.split('✓ 已完成 2 个').length - 1), 1);
    assert.equal(await page.locator('[data-project=p2] .arow').count(), 0);
    assert.equal(await page.locator('[data-project=p2] .pcard-b').innerText(), '✓ 已完成 2 个');
    assert.equal(await page.locator('[data-project=p3] .arow').count(), 1);
    assert.equal(await page.locator('[data-project=p1] .dot.need').count(), 1);
    assert.equal(await page.locator('[data-project=p1] .dot.work').count(), 2);
    assert.equal(await page.locator('[data-project]').evaluateAll(cards => cards.filter(c => !['p1', 'p2', 'p3'].includes(c.dataset.project)).every(c => c.children.length === 1 && c.firstElementChild.matches('.pcard-h'))), true);
    const search = page.getByRole('searchbox', { name: '找项目' });
    assert.equal(await search.getAttribute('placeholder'), '输入项目名');
    await search.fill('项目 3'); await page.waitForFunction(() => document.querySelectorAll('[data-project]').length === 1);
    assert.equal(await page.locator('[data-project=p3] .arow').count(), 1);
    await search.fill(''); await page.waitForFunction(() => document.querySelectorAll('[data-project]').length === 14);
    await page.evaluate(() => { fixture.live.ok = false; fixture.emit(); });
    await page.getByText('agent 状态读不到', { exact: true }).waitFor();
    assert.equal(await page.getByText('agent 状态读不到', { exact: true }).count(), 1);
    assert.equal(await page.locator('[data-project] .pcard-b').count(), 0);
  });
  await setup({ manyProjects: true, idleProjects: true });
  await test('projects without tasks stay visible while agents work or need input; done-only projects stay folded', async () => {
    await page.evaluate(() => {
      const a = fixture.live.agents[0];
      fixture.live.agents = [{ ...a, id: 'work-p2', projectId: 'p2', state: 'work' }, { ...a, id: 'need-p3', projectId: 'p3', state: 'need' }, { ...a, id: 'done-p4', projectId: 'p4', state: 'done' }];
      fixture.emit();
    });
    await page.locator('[data-project=p2] .arow').waitFor();
    for (const id of ['p1', 'p2', 'p3']) {
      assert.equal(await page.locator(`[data-project=${id}]`).isVisible(), true);
      assert.equal(await page.locator(`details [data-project=${id}]`).count(), 0);
    }
    for (const id of ['p4', 'p5']) {
      assert.equal(await page.locator(`details:not([open]) [data-project=${id}]`).count(), 1);
      assert.equal(await page.locator(`[data-project=${id}]`).isVisible(), false);
    }
    await page.evaluate(() => { fixture.live.agents.find(a => a.projectId === 'p2').state = 'done'; fixture.emit(); });
    await page.waitForFunction(() => document.querySelector('details:not([open]) [data-project=p2]'));
    assert.equal(await page.locator('[data-project=p2]').isVisible(), false);
    assert.equal(await page.locator('[data-project=p3]').isVisible(), true);
    await page.evaluate(() => { fixture.live.ok = false; fixture.emit(); });
    await page.getByText('agent 状态读不到', { exact: true }).waitFor();
    assert.equal(await page.locator('details:not([open]) [data-project=p3]').count(), 1);
    assert.equal(await page.locator('[data-project=p1]').isVisible(), true);
  });
  await setup();
  await test('keyboard tabs, escape navigation, focus, long input retention', async () => { await project(); const tasks = page.getByRole('tab', { name: '任务', exact: true }); await tasks.focus(); await page.keyboard.press('ArrowRight'); assert.equal(await page.getByRole('tab', { name: 'Agent', exact: true }).getAttribute('aria-selected'), 'true'); await page.keyboard.press('Escape'); await page.getByRole('heading', { name: '组织', exact: true }).waitFor(); await page.locator('[data-workspace=off] .wsr-h').focus(); await page.keyboard.press('Enter'); assert.equal(await page.locator('[data-workspace=off] .wsr-h').getAttribute('aria-expanded'), 'true'); });
  await test('editing retains focus, caret and long text during refresh', async () => {
    await page.locator('[data-workspace=off]').getByRole('button', { name: '派活', exact: true }).click();
    const input = page.getByLabel('背景', { exact: true }), text = '一段需要保留的输入。'.repeat(50);
    await input.fill(text); await page.evaluate(() => fixture.emit());
    await page.waitForFunction(text => document.querySelector('textarea[data-focus="背景"]')?.value === text && document.activeElement?.getAttribute('data-focus') === '背景', text);
    assert.equal(await input.inputValue(), text); assert.equal(await page.locator('#panel').evaluate(e => e.scrollWidth <= e.clientWidth), true);
  });
  await setup();
  await test('task/settings pages load, completion page caps twenty cards', async () => {
    await project(); await page.getByRole('tab', { name: '任务', exact: true }).click(); await page.getByRole('button', { name: '页面交付' }).click(); await page.getByRole('heading', { name: '目标', exact: true }).waitFor();
    await page.keyboard.press('Escape'); await page.getByRole('button', { name: '项目设置', exact: true }).click(); await page.getByRole('heading', { name: '分工', exact: true }).waitFor();
    await home(); await page.getByRole('button', { name: '设置', exact: true }).click();
    for (const name of ['主 agent', '外部连接', '工作间连接', '机器', '隐藏的项目']) {
      await page.getByRole('button', { name, exact: true }).click(); await page.getByRole('heading', { name, exact: true }).waitFor(); await page.keyboard.press('Escape');
    }
    await home();
    await page.evaluate(() => { for (let i = 0; i < 25; i++) fixture.live.agents.push({ ...fixture.live.agents[0], id: 'done' + i, state: 'done', rawState: 'done' }); fixture.emit(); });
    await page.getByRole('button', { name: '全部 agent', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('[data-st=done]').length === 20);
  });
  for (const width of [300, 400, 1040]) for (const theme of ['light', 'dark']) {
    await setup({ width });
    await test(`theme ${theme}, width ${width}, no horizontal overflow, primary strip, no card borders`, async () => {
      await page.evaluate(theme => { document.documentElement.className = theme; }, theme);
      assert.equal(await page.locator('#panel').evaluate(e => e.scrollWidth <= e.clientWidth), true);
      assert.equal(await page.locator('.wsr.me>.wsr-top').evaluate(e => getComputedStyle(e).backgroundColor), theme === 'dark' ? 'rgb(229, 229, 229)' : 'rgb(23, 23, 23)');
      assert.equal(await page.locator('.pcard').first().evaluate(e => getComputedStyle(e).borderTopWidth), '0px');
      if (process.env.PANEL_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.PANEL_EVIDENCE_DIR, `panel-${theme}-${width}.png`), fullPage: true });
    });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks: results.length, errors, results }));
} finally { await browser.close(); server.close(); }
