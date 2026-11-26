import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));

const { build } = await import('esbuild');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright-core');
await fs.mkdir('.orca/local-test', { recursive: true });
await build({ entryPoints: ['src/panel-page.ts'], outfile: '.orca/local-test/panel.js', bundle: true, platform: 'browser', format: 'esm' });
const draftModel = (await build({ entryPoints: ['src/feedback-drafts.ts'], bundle: true, format: 'iife', globalName: 'draftModel', write: false })).outputFiles[0].text;
const mockup = path.resolve('../docs/design/workspace-mockup-v8.html');
const hasMockup = await fs.access(mockup).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
const tokens = await fs.readFile(new URL('./panel-theme-fixture.css', import.meta.url), 'utf8');
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const files = { '/panel': 'src/panel.html', '/panel.css': 'src/panel.css', '/assets/Geist.woff2': 'src/assets/Geist.woff2', '/panel-page.ts': '.orca/local-test/panel.js' };
    if (url.pathname === '/assets/pdf/pdf.min.mjs' || url.pathname === '/assets/pdf/pdf.worker.min.mjs') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await fs.readFile('node_modules/pdfjs-dist/build/' + path.basename(url.pathname))); return;
    }
    if (url.pathname === '/assets/pdf/wasm/openjpeg_nowasm_fallback.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await fs.readFile('node_modules/pdfjs-dist/wasm/openjpeg_nowasm_fallback.js')); return;
    }
    if (!files[url.pathname]) { res.writeHead(404).end(); return; }
    let data = await fs.readFile(files[url.pathname]);
    if (url.pathname === '/panel') data = data.toString().replace('</head>', `<style>${tokens}</style></head>`);
    res.setHeader('Content-Type', url.pathname.endsWith('.ts') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.woff2') ? 'font/woff2' : 'text/html');
    res.end(data);
  } catch (e) { res.writeHead(500).end(e.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
const errors = [], external = [], results = [];
const test = async (name, work) => { try { await work(); } catch (e) { console.error(name, await page.locator('.dock .toast').allTextContents()); throw e; } results.push(name); console.log('PASS', name); };
let page;
async function setup(options = {}, hub) {
  await page?.close(); page = await browser.newPage({ viewport: { width: options.width ?? 400, height: 900 } });
  if (options.clock) await page.clock.install();
  page.on('pageerror', e => errors.push(e.message));
  page.setDefaultTimeout(4500);
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === `http://127.0.0.1:${server.address().port}`) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  if (hub) await page.exposeFunction('sharedSheets', input => hub.evaluate(input => {
    if (input.change) fixtureDraftModel.applyDelta(window.sheets,input.change);
    return structuredClone(window.sheets);
  },input));
  await page.addInitScript({content:draftModel + ';globalThis.fixtureDraftModel = draftModel;'});
  await page.addInitScript(({ options }) => {
    const clone = x => structuredClone(x), now = Date.now(), events = {}, stored = options.stored ?? {};
    const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), byte => byte.toString(16).padStart(2,'0')).join('');
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
    const projects = options.empty ? [] : [project];
    if (options.empty) project.tasks = [];
    const archivedTask = { ...task, title: '归档任务', progress: '旧版页面已验收', phase: 'completed',
      artifacts: [{ id: 'md', label: '验收文档', version: 'v1', url: '/example/review.md' }],
      acceptance: [{ ...acceptance('版式'), status: 'passed', history: [{ note: '历史原文' }] }],
      decisions: [{ id: 'd', question: '采用哪个版本？', answer: '第一版', history: [] }] };
    if (options.archive) project.archive = { taskCount: 1, end: 50 };
    if (options.projectUnbound) { project.runId = ''; project.tasks = []; }
    if (options.inboxBatch) {
      const other = clone(project);
      Object.assign(other.ref, { id: 'p2', name: '移动项目' });
      other.tasks = [{ ...clone(task), id: 't2', title: '移动端交付', acceptance: [acceptance('b1')] }];
      if (options.artifacts) {
        other.tasks[0].artifacts = [
          { id: 'md', label: '设计文档', version: 'v1', url: '/example/docs/design.md' },
          { id: 'html', label: '样稿 v9', version: 'v9', url: '/example/docs/preview.html' },
          { id: 'web', label: '网页预览', version: 'v1', url: 'https://example.com/preview' },
        ];
        other.tasks[0].acceptance[0].artifactIds = ['md', 'html', 'web'];
      }
      projects.push(other);
      project.tasks.push({ ...clone(task), id: 't3', title: '动效交付', acceptance: [acceptance('a3')] },
        { ...clone(task), id: 'd1', title: '设计决定', phase: 'working', acceptance: [], decisions: [{ id: 'd1', question: '选择方案', options: ['方案一'], history: [] }] });
    }
    if (options.blocked) project.tasks.push({ ...clone(task), id: 'blocked', title: '等待补建', phase: 'blocked', blockedRevision: 2, acceptance: [] });
    const p = (id, relation, status = 'connected') => ({ id, name: '工作间 ' + id, workspaceId: 'ws-' + id, state: status === 'pending' ? 'pending' : 'active', relation, sharingSet: false, status, scope: 'none', projectIds: [], lastSyncAt: new Date(now - 100000).toISOString(), receivedAt: new Date(now).toISOString(),
      ...(status === 'connected' ? { report: { scope: 'details', mainAgent: { agent: 'codex', title: '对方统筹会话', online: 'online', activity: {state:'work', since:now-300000} }, projects: [{ id: 'remote-p', name: '开放的项目', updatedAt: new Date().toISOString(), pending: 0, counts: { blocked: 1 },
        tasks: [{ title: '受阻任务', phase: 'blocked', state: 'blocked', blockedPending: true, decisions: [], acceptance: [] }], activity: { truncated: true, agents: [
          { agent: 'claude', role: 'session', state: 'need', title: '等待确认设计', since: now - 60_000 },
          { agent: 'codex', role: 'worker', state: 'work', title: '正在检查布局', taskTitle: '核对布局', since: now - 180_000 },
          { agent: 'codex', role: 'worker', state: 'done', title: '页面检查完成', since: now - 360_000 }
        ] } }] } } : {}) });
    const links = { version: 1, revision: 1, workspaceId: 'self', name: '我的工作间', enabled: false, host: '127.0.0.1', port: 0, publicUrl: '', tls: false, listening: '', error: '', peers: [p('up', 'above'), p('down', 'below'), p('off', 'below', 'offline'), p('side', 'peer'), p('free', undefined), p('pending', undefined, 'pending')] };
    if (options.delegatedFeedback) {
      const project = links.peers[0].report.projects[0];
      Object.assign(project, { id: 'p1', name: '对方示例项目', feedback: { revision: 4, tasks: [
        { id: 't1', title: '对方页面交付', phase: 'ready', decisions: [], acceptance: [{ ...acceptance('remote-a'), artifactIds: ['local', 'web'] }], artifacts: [
          { id: 'local', label: '设计原稿', version: 'v1', url: '' }, { id: 'web', label: '网页预览', version: 'v1', url: 'https://example.com/preview' }] },
        { id: 'remote-d', title: '对方设计决定', phase: 'working', decisions: [{ id: 'option', question: '采用哪个设计？', options: ['浅色'] }], acceptance: [], artifacts: [] },
      ] } });
      if (options.peerProjectPage) project.feedback.tasks.push({ ...clone(project.feedback.tasks[0]), id: 'second', title: '对方图标交付' });
      project.tasks = project.feedback.tasks.map(t => ({ title: t.title, phase: t.phase, state: t.phase === 'ready' ? 'review' : 'decision',
        decisions: t.decisions.map(d => d.question), acceptance: t.acceptance.map(a => a.title) }));
      project.pending = project.tasks.length;
      if (options.offlinePeer) {
        const peer = links.peers[0];
        peer.status = 'offline'; peer.offlineFeedback = peer.report.projects; delete peer.report;
      }
    }
    const live = { ok: true, at: now, agents: [{ id: 'agent-need', projectId: 'p1', agent: 'codex', role: 'worker', state: 'need', rawState: 'waiting', verified: true, title: '等批准', taskTitle: '页面交付', last: '等待用户批准', since: now - 60000, workspaceId: 'identity:project-workspace', terminalId: 'term-need' }, { id: 'agent-work', projectId: 'p1', agent: 'claude', role: 'session', state: 'work', rawState: 'working', verified: false, title: '正在工作', last: '正在处理', since: now - 20000 }] };
    if (options.empty || options.projectUnbound) live.agents = [];
    if (options.twoWaitingAgents) live.agents.push({ id: 'agent-chat', projectId: 'p1', agent: 'claude', role: 'session', state: 'need', title: '等待设计决定', since: now - 120000, workspaceId: 'identity:chat-workspace' });
    const workspace = { revision: 1, runId: options.unbound ? '' : 'run_main', ...(!options.unbound ? { session: { handle: 'main', agent: 'claude', title: '统筹会话', online: 'online' } } : {}) };
    const hermes = { id: 'hermes', type: 'a2a', name: 'Hermes', enabled: true, state: 'unchecked', message: '' };
    if (options.bot) workspace.bot = { id: 'current', name: '当前 bot', agent: 'codex', reason: 'Claude 额度已用完', recoveryAt: now + 3600000, soul: { home: '/fixture/bots/current', backup: '/fixture/plugin-data/bot-soul-backups/original.md' } };
    if (options.coldMain) workspace.session.online = 'unknown';
    const availableAgents = options.availableAgents ?? ['Claude', 'Codex', 'Antigravity'].map(name => ({ id: name.toLowerCase(), name, default: name === 'Claude' }));
    const sessions = ['甲', '乙'].map((name, i) => ({ handle: 'session-' + i, title: name + '会话', workspace: 'identity:test', workspaceName: '示例工作区', path: '/test/工作区 with spaces', agent: i ? 'codex' : 'claude', online: 'online' }));
    const projectSessions = [{ ...sessions[0], handle: 'project-session-0', title: '当前设计会话' },
      { ...sessions[1], handle: 'project-session-1', title: '编码会话' },
      { ...sessions[1], handle: 'project-session-2', title: '审查会话', agent: 'opencode' }];
    const binding = p => ({ ...(p.backup ? { backup: p.backup } : {}), revision: p.revision, runId: p.runId, ...(p.runId && p.activeSession ? { session: p.activeSession } : {}), ...(p.takeover ? { takeover: p.takeover } : {}) });
    if (options.projectLead || options.legacyCodexLead) project.activeSession = projectSessions[options.legacyCodexLead ? 1 : 0];
    if (options.projectBackupRecovery) {
      project.activeSession = { ...projectSessions[0], agent: 'codex' };
      projectSessions[1] = { ...projectSessions[1], agent: 'antigravity', title: '代管会话' };
      project.backup = { primary: project.activeSession.handle, handle: projectSessions[1].handle, agent: 'antigravity', phase: 'active', history: [] };
    }
    const leadDefaults = { primary: { agent: options.legacyCodexLead ? 'antigravity' : 'codex' }, backup: { agent: 'antigravity' } };
    const registered = () => projects.filter(p => !window.fixture.removedProjects?.includes(p.ref.id));
    const attention = () => registered().flatMap(p => p.tasks.flatMap(t => {
      const base = { projectId: p.ref.id, taskId: t.id, title: t.title };
      return [
        ...(t.phase === 'blocked' && t.blockedStatus !== 'discarded' ? [{ ...base, kind:'blocked', itemId:t.id, summary:t.progress, replied:t.blockedStatus === 'replied' }] : []),
        ...t.decisions.filter(d => d.answer === undefined).map(d => ({ ...base, kind: 'decision', itemId: d.id, summary: d.question })),
        ...t.acceptance.filter(a => t.phase === 'ready' && a.status === 'pending').map(a => ({ ...base, kind: 'review', itemId: a.id, summary: a.title, itemRevision: a.revision, fingerprint: a.fingerprint }))
      ];
    }));
    if (options.longInbox) {
      const a = live.agents[0];
      live.agents.push(...Array.from({ length: 30 }, (_, i) => ({ ...a, id: 'long-' + i, title: '待回复 ' + (i + 1) })));
      task.acceptance.push(...Array.from({ length: 10 }, (_, i) => acceptance('long-' + i)));
    }
    const calls = [];
    window.fixture = { project, projects, links, live, workspace, calls, hostCalls: [], stored, workspaceTarget: { workspaceId: 'identity:project-workspace', multipleConversations: true }, emit: () => events['project.changed']?.({}), race: false, prune: () => { task.acceptance[0].revision++; task.acceptance[0].fingerprint = 'new-version'; project.revision++; } };
    if (options.firstSetup) window.fixture.setup = {
      paths: ['/fixture/.agents/skills/agentboat-workspace', '/fixture/custom-codex/hooks.json'],
      backupRoot: '/fixture/.agentboat/backups', codexHooks: '/fixture/custom-codex/hooks.json', codexHome: '/fixture/custom-codex', confirmation: 'a'.repeat(64)
    };
    const applyFixtureSetup = confirmation => {
      const setup = window.fixture.setup;
      if (!setup?.confirmation || setup.confirmation !== confirmation) throw Error('请确认首次设置路径');
      if (window.fixture.failSetup) {
        window.fixture.failSetup = false;
        throw Error('写入失败：' + setup.codexHooks + '\n备份位置：' + setup.backupRoot + '/setup-retry');
      }
      const completed = setup.paths;
      delete setup.confirmation;
      setup.paths = [];
      return { completed };
    };
    if (options.ownerQuestion) window.fixture.questions = [{ id: 'msg_owner', projectId: 'p1', runId: project.runId, from: 'dispatch:worker-example',
      title: '请登录测试面板', body: '请登录测试面板\n在测试浏览器打开示例页面', at: now - 11 * 60_000 }];
    if (options.ownerReport) window.fixture.reports = [{ id: 'msg_report', projectId: 'p1', runId: project.runId, from: 'dispatch:fixture',
      title: '页面已交付', body: '页面已交付\n执行者核对了布局', at: now - 31 * 60_000, report: { id: 'msg_report', taskId: 'orca-task' } }];
    if (options.boundMainFolder) {
      project.ref.name = '主会话目录';
      workspace.session.title = '工作间主会话';
      window.fixture.removedProjects = [project.ref.id];
    }
    window.orca = { files: { saveAs: async ({ suggestedName, data }) => {
      calls.push({ name: 'files.saveAs', input: { suggestedName, data: new TextDecoder().decode(data) } }); return { status: 'saved' };
    } }, shell: { openExternal: async url => { calls.push({ name: 'shell.openExternal', input: url }); return { opened: true }; } }, storage: { get: async k => clone(stored[k] ?? null), set: async (k, v) => { stored[k] = clone(v); }, delete: async k => { delete stored[k]; } }, plugin: { on: (name, callback) => { events[name] = callback; return { dispose() {} }; }, request: async (name, input) => {
      if (input !== undefined && !isJson(input)) throw Error('input: Invalid input');
      calls.push({ name, input: clone(input) });
      if (name === 'panel.feedbackState') {
        if (window.sharedSheets) return window.sharedSheets(input);
        const sheets = clone(stored['panel.feedbackState'] || {});
        if (input.change) {
          if (window.fixture.failPrepare && input.change.attempt?.value?.input) { window.fixture.failPrepare = false; throw Error('请求记录未保存'); }
          globalThis.fixtureDraftModel.applyDelta(sheets, input.change); stored['panel.feedbackState'] = sheets;
        }
        return clone(sheets);
      }
      if (name === 'workspace.overview' && window.fixture.delayOverview) await new Promise(resolve => { window.fixture.finishOverview = resolve; });
      if (name === 'workspace.overview' && window.fixture.overviewFailures > 0) {
        window.fixture.overviewFailures--;
        throw Error('fixture overview unavailable');
      }
      if (name === 'workspace.overview') return clone({ workspace, versionLabel: options.versionLabel ?? '版本未知', projects: [...registered().map(p => ({ ref: p.ref, revision:p.revision, counts: { review: p.tasks.filter(t => t.phase === 'ready' && t.acceptance.some(a => a.status === 'pending')).length }, agents: [], bound: true, updatedAt: '' })), ...(options.manyProjects ? Array.from({ length: 13 }, (_, i) => ({ ref: { ...project.ref, id: 'p' + (i + 2), name: '项目 ' + (i + 2) }, counts: { working: options.idleProjects ? 0 : 1 }, agents: [], bound: true, updatedAt: '' })) : [])], hidden: [], attention: attention(), questions: window.fixture.questions ?? [], reports: window.fixture.reports ?? [], links, connections: options.hermes ? [hermes] : [], machines: [{ id: 'local', name: '主机', role: 'host' }] });
      if (name === 'workspace.agents' && options.holdAgents) await new Promise((resolve, reject) => {
        window.fixture.agentTimeout = () => reject(Error('workspace.agents timed out after 30000ms'));
      });
      if (name === 'workspace.agents') return clone({ ...live, agents: live.agents.filter(a => !window.fixture.removedProjects?.includes(a.projectId)) });
      if (name === 'workspace.agent.open') {
        const agent = live.agents.find(a => a.id === input.id && a.state === 'need');
        if (!agent) throw Error('已不需要你处理');
        window.fixture.hostCalls.push(agent.terminalId ? { method: 'terminal.focus', terminalId: agent.terminalId } : { method: 'workspace.open', workspaceId: agent.workspaceId });
        return { opened: true, focusedTerminal: !!agent.terminalId };
      }
      if (name === 'project.read' || name === 'project.task') {
        if (window.fixture.failRead === input.projectId) { delete window.fixture.failRead; throw Error('模拟读取错误'); }
        if (window.fixture.removedProjects?.includes(input.projectId)) throw Error('项目已从 Orca 移除');
        if (window.fixture.delayProject === input.projectId) {
          delete window.fixture.delayProject;
          await new Promise(r => { window.fixture.finishRead = r; });
        }
        const p = projects.find(p => p.ref.id === input.projectId);
        if (name === 'project.task') return clone(p?.tasks.find(t => t.id === input.taskId) ?? null);
        return clone({ project: p ?? null, lead: p ? binding(p) : undefined, projects: projects.map(p => p.ref), workspaceTarget: window.fixture.workspaceTarget });
      }
      if (name === 'project.archive' && input.projectId === 'p1') return input.end === 25 ?
        { end: 25, tasks: [], deliveries: 5, events: 0, requests: 4, history: 0 } :
        { end: 50, previousEnd: 25, tasks: [archivedTask], deliveries: 2, events: 1, requests: 3, history: 4 };
      if (name === 'lead.retry') {
        const target = input.projectId ? projects.find(p => p.ref.id === input.projectId) : workspace;
        if (!input.confirm || target.revision !== input.revision || target.backup?.phase !== 'failed') throw Error('无法重新开备用');
        target.backup = { ...target.backup, phase: 'standby', problem: undefined, handle: 'backup' };
        target.revision++;
        return { accepted: true };
      }
      if (name === 'project.settings') {
        const p = projects.find(p => p.ref.id === input.projectId);
        if (p.revision !== input.revision) throw Error('项目已更新');
        if (input.roles) p.roles = input.roles;
        if (input.leadAgents) p.leadAgents = { ...p.leadAgents, ...input.leadAgents };
        p.revision++;
        return clone({ project: p });
      }
      if (name === 'project.lead') {
        const p = projects.find(p => p.ref.id === input.projectId);
        const backupPrimaryUnavailable = () => p.backup?.phase === 'active' && p.activeSession?.online === 'offline';
        if (input.mode) {
          if (p.revision !== input.revision) throw Error('项目已更新');
          if (window.fixture.delayProjectSwitch) {
            window.fixture.delayProjectSwitch = false;
            await new Promise(r => { window.fixture.finishProjectSwitch = r; });
          }
          p.revision++;
          if (input.mode === 'cancel') delete p.takeover;
          else if (input.mode === 'promote') {
            if (!backupPrimaryUnavailable()) throw Error('原主会话仍可能接回 Run');
            p.activeSession = projectSessions.find(s => s.handle === p.backup.handle);
            delete p.backup;
            delete p.takeover;
          }
          else p.takeover = { id: String(p.revision), target: input.mode === 'new' ? { title: '新的 ' + input.agent + ' 会话' } : projectSessions.find(s => s.handle === input.handle),
            state: 'waiting', backupAgent: options.backupAgent, expiresAt: new Date(Date.now() + 600000).toISOString() };
        }
        const workspaceError = window.fixture.workspaceTarget.error;
        return clone({ binding: binding(p), leadAgents: { ...leadDefaults, ...p.leadAgents },
          availableAgents: workspaceError ? [] : availableAgents, roleAgents: availableAgents,
          sessions: workspaceError ? [] : projectSessions.filter(s => s.handle !== p.activeSession?.handle || p.activeSession.online === 'online'),
          ...(backupPrimaryUnavailable() ? { backupPrimaryUnavailable: true } : {}), ...(workspaceError ? { workspaceError } : {}) });
      }
      if (name === 'project.expireArtifact') {
        const p = projects.find(p => p.ref.id === input.projectId);
        if (!p || input.revision !== p.revision) throw Error('项目已更新');
        p.tasks.find(t => t.id === input.taskId).artifacts.find(a => a.id === input.artifactId).expired = true;
        p.revision++;
        return clone({ project: p });
      }
      if (name === 'workspace.linkArtifact') {
        if (window.fixture.artifactError) throw Error(window.fixture.artifactError);
        if (window.fixture.delayArtifact) {
          events['workspace.artifactProgress']({ ...input, method: 'chunks', received: 1200000, size: 3100000 });
          await new Promise(resolve => { window.fixture.finishArtifact = resolve; });
        }
        const f = window.fixture.peerFile;
        return { method: f.method || 'direct', key: 'test-file', name: f.name, size: atob(f.data).length, type: f.type };
      }
      if (name === 'workspace.readLinkArtifact') return window.fixture.peerFile.data;
      if (name === 'project.openArtifact' || name === 'project.openArtifactFolder') {
        const target = input.archiveEnd === 50 && input.projectId === 'p1' && input.taskId === archivedTask.id ? archivedTask :
          projects.find(p => p.ref.id === input.projectId)?.tasks.find(t => t.id === input.taskId);
        if (!target?.artifacts.some(a => a.id === input.artifactId)) throw Error('请选择本项目的本机成果');
        if (name === 'project.openArtifact' && window.fixture.workspaceTarget.error) throw Error(window.fixture.workspaceTarget.error);
        if (window.fixture.artifactError) throw Error(window.fixture.artifactError);
        return { opened: true };
      }
      if (name === 'project.openMain') {
        if (window.fixture.delayOpen) await new Promise(r => { window.fixture.finishOpen = r; });
        if (window.fixture.openError) throw Error(window.fixture.openError);
        return { opened: true, multipleConversations: window.fixture.workspaceTarget.multipleConversations };
      }
      if (name === 'project.feedback') {
        if (window.fixture.delayFeedback === true || window.fixture.delayFeedback === input.projectId) { window.fixture.delayFeedback = false; await new Promise(r => { window.fixture.finishFeedback = r; }); }
        if (window.fixture.race) { window.fixture.race = false; window.fixture.prune(); throw Error('成果已更新'); }
        if (window.fixture.failFeedback === true || window.fixture.failFeedback === input.projectId) { window.fixture.failFeedback = false; throw Error('回执连接中断'); }
        const target = projects.find(p => p.ref.id === input.projectId);
        if (!target || input.revision !== undefined && target.revision !== input.revision) throw Error('项目已更新');
        if (window.fixture.noWrite) return clone({project:target});
        const updates = input.items.map(i => {
          const t = target.tasks.find(t => t.id === i.taskId);
          if (i.kind === 'blocked' && t.blockedRevision === i.itemRevision) return [i, t];
          const a = i.kind === 'acceptance' ? t?.acceptance.find(a => a.id === i.itemId) : t?.decisions.find(d => d.id === i.itemId);
          if (!a || i.kind === 'acceptance' && (t.phase !== 'ready' || (i.reviewTotal !== undefined && i.reviewTotal !== t.acceptance.filter(a => a.status === 'pending').length) || a.status !== 'pending' || a.revision !== i.itemRevision || a.fingerprint !== i.fingerprint)) throw Error('stale');
          return [i, a];
        });
        for (const [i, a] of updates) {
          if (i.kind === 'blocked') { a.blockedStatus = i.result === 'discarded' ? 'discarded' : 'replied'; continue; }
          if (i.kind === 'acceptance') a.status = i.result;
          else a.answer = i.result === 'discarded' ? null : i.answer;
          a.history.push({ result:i.result ?? i.answer, revision:i.itemRevision ?? 1, note:i.note, source:'主人', at:new Date().toISOString() });
        }
        target.deliveries.push({ id: 'summary', subject: '用户反馈', body: '', state: 'pending' }); target.revision++;
        target.requests.push({ id: input.requestId, fingerprint: await digest(input) });
        if (window.fixture.loseFeedbackReceipt) { window.fixture.loseFeedbackReceipt = false; throw Error('提交回执丢失'); }
        return clone({ project: target });
      }
      if (name === 'workspace.linkFeedback') {
        const project = links.peers.find(p => p.id === input.id).report.projects.find(p => p.id === input.projectId);
        if (options.delayLinkReply) {
          if (fixture.finishLinkReply) throw Error('正在确认上次提交，请稍候');
          await new Promise(resolve => { fixture.finishLinkReply = () => { delete fixture.finishLinkReply; resolve(); }; });
        }
        if (window.fixture.linkTimeout) return { state: 'uncertain', requestId: input.requestId, reason: '连接超时' };
        if (options.rejectLinkFeedback) return { state: 'rejected', requestId: input.requestId, reason: '项目已更新' };
        if (window.fixture.lostLinkFeedback === input.requestId) { const {id,...wire}=input; return { state: 'submitted', requestId: input.requestId, fingerprint:await digest(wire) }; }
        if (input.revision !== project.feedback.revision) return { state: 'rejected', requestId: input.requestId, reason: '项目已更新' };
        if (!options.laggingReport) project.feedback.tasks = [];
        project.feedback.revision++;
        if (options.peerProjectPage) {
          const { id, ...wire } = input;
          return { state: 'submitted', requestId: input.requestId, fingerprint: await digest(wire) };
        }
        window.fixture.lostLinkFeedback = input.requestId;
        return { state: 'uncertain', requestId: input.requestId, reason: '待核对：连接超时或断开' };
      }
      if (name === 'workspace.links') {
        if (input.operation === 'read') return clone(links);
        if (input.operation === 'invite') {
          if (window.fixture.inviteError) throw Error(window.fixture.inviteError);
          Object.assign(links, { enabled: true, host: '100.64.0.42', port: 43123, publicUrl: 'http://100.64.0.42:43123', listening: 'http://100.64.0.42:43123' });
          return { ...clone(links), invitation: { code: 'AB1.fixture', expiresAt: new Date(Date.now() + 120000).toISOString() } };
        }
        if (input.operation === 'join') links.peers.push(p('joined', undefined));
        if (input.operation === 'rename') links.name = input.name.trim();
        const peer = links.peers.find(p => p.id === input.id);
        if (input.operation === 'relate') peer.relation = input.relation ?? undefined;
        if (input.operation === 'share') Object.assign(peer, input, { sharingSet: true });
        if (input.operation === 'revoke') links.peers = links.peers.filter(p => p.id !== input.id);
        links.revision++; return clone(links);
      }
      if (name === window.fixture.holdRead) await new Promise((resolve, reject) => {
        window.fixture.finishRead = ok => { delete window.fixture.holdRead; ok ? resolve() : reject(Error('read unavailable')); };
      });
      if (name === 'workspace.hermesApprovalMode') return 'smart';
      if (name === 'workspace.connections' && options.hermes && input.operation === 'read') {
        return { connection: hermes, a2a: { url: 'http://127.0.0.1:1234', port: 5678, revision: 1, entries: [] } };
      }
      if (name === 'workspace.agent.targets') return { agentWorkspace: 'identity:test', availableAgents,
        ...(options.bot || options.availableBot ? { bots: [{ id: 'new-bot', name: '工作管家', agent: 'antigravity', paused: false,
          agents: options.firstSetup ? ['antigravity', 'claude', 'codex'] : ['antigravity', 'grok'] }] } : options.emptyBots ? { bots: [] } : {}),
        sessions: clone(sessions), workspaces: [{ workspace: 'identity:test', name: '示例工作区', path: '/test/工作区 with spaces' }],
        ...(window.fixture.setup ? { setup: clone(window.fixture.setup), projectUsesCodex: !!window.fixture.projectUsesCodex } : {}) };
      if (name === 'workspace.setup') return applyFixtureSetup(input.confirmation);
      if (name === 'workspace.setup.codexHome') {
        if (!input.path.startsWith('/')) throw Error('CODEX_HOME 必须是完整绝对路径');
        stored['workspace.setup.codexHome'] = input.path;
        const setup = window.fixture.setup;
        const newHooks = input.path + '/hooks.json';
        setup.paths = setup.paths.map(file => file === setup.codexHooks ? newHooks : file);
        Object.assign(setup, { codexHooks: newHooks, codexHome: input.path, confirmation: 'c'.repeat(64) });
        return { path: input.path };
      }
      if (name === 'workspace.agent.switch') {
        if (input.revision !== workspace.revision) throw Error('工作间已更新');
        if (input.mode !== 'cancel' && !workspace.runId && window.fixture.setup?.confirmation) applyFixtureSetup(input.setupConfirmation);
        workspace.revision++;
        if (input.mode === 'bot') workspace.takeover = { id: 'selection', target: { title: '工作管家', workspace: '', agent: input.agent }, state: 'waiting', expiresAt: new Date(Date.now() + 600000).toISOString() };
        else if (input.mode === 'cancel') delete workspace.takeover;
        else workspace.takeover = { id: String(workspace.revision), target: input.mode === 'new' ? { title: '新的 ' + input.agent + ' 会话' } : sessions.find(s => s.handle === input.handle), state: 'waiting', expiresAt: new Date(Date.now() + 600000).toISOString() };
        if (input.mode === 'bot' && window.fixture.delayBot) {
          window.fixture.delayBot = false;
          workspace.takeover.state = 'sending';
          window.fixture.emit();
          await new Promise(resolve => { window.fixture.finishBot = resolve; });
          Object.assign(workspace.takeover, { state: 'waiting' });
          workspace.takeover.target.handle = 'bot-side-chat';
        }
        if (window.fixture.delaySwitch) { window.fixture.delaySwitch = false; window.fixture.emit(); await new Promise(r => { window.fixture.finishSwitch = r; }); }
        return clone(workspace);
      }
      if (name === 'workspace.connections') return [];
      throw Error('Unexpected ' + name);
    } } };
  }, { options });
  await page.goto(`http://127.0.0.1:${server.address().port}/panel`);
  await page.locator('.home-layer .home').waitFor({ state: 'attached' });
}
const rail = () => page.locator('.home-layer .inbox');
const dock = () => page.getByRole('region', { name: '待提交', exact: true });
const row = title => rail().getByRole('button', { name: title, exact: true });
const review = title => rail().getByRole('checkbox', { name: new RegExp('选择验收 · ' + title) });
const currentLayer = () => page.locator('.pane-layers > .layer:not([inert])');
const activeHeader = () => page.locator('.pane.wide-pane:visible .pane-top, .top');
const back = async () => {
  await activeHeader().getByRole('button', { name: /^返回「/ }).click();
};
const home = async () => {
  const jump = page.getByRole('button', { name: /^(回首页|关闭，回到组织)$/, exact: true });
  if (await jump.count()) await jump.click();
  else if (await activeHeader().getByRole('button', { name: /^返回「/ }).count()) await back();
  await page.getByRole('heading', { name: '组织', exact: true }).waitFor();
};
const project = async () => {
  await page.locator('[data-workspace=self] [data-project=p1] .pcard-h').click();
  await currentLayer().getByRole('tab', { name: '待处理', exact: true }).waitFor();
};
const openReview = async (title = '页面交付') => {
  await row(title).click();
  const area = page.locator('.wide-pane').count().then(n => n ? currentLayer() : rail());
  const body = await area;
  await body.getByRole('button', { name: '通过', exact: true }).first().waitFor();
  return body;
};
const rightClickArtifact = async entry => {
  await entry.evaluate(async el => {
    await Promise.all((el.closest('.xp')?.getAnimations() ?? []).map(animation => animation.finished));
    el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    await new Promise(resolve => requestAnimationFrame(resolve));
  });
  await entry.click({ button: 'right' });
};
try {
  await setup({ inboxBatch: true, width: 400 });
  await test('background overview retries silently, retains content on failure and clears the notice after recovery', async () => {
    const failReads = (count, name) => page.evaluate(([count, name]) => {
      fixture.calls.length = 0; fixture.overviewFailures = count; fixture.project.ref.name = name; fixture.emit();
    }, [count, name]);
    const attempts = () => page.evaluate(() => fixture.calls.filter(c => c.name === 'workspace.overview').length);
    await failReads(1, '更新后的项目');
    await page.waitForFunction(() => fixture.overviewFailures === 0);
    assert.equal(await page.locator('.toast').count(), 0);
    await page.getByText('更新后的项目', { exact: true }).first().waitFor();
    assert.equal(await attempts(), 2);
    await failReads(3, '恢复后的项目');
    const notice = page.getByRole('status').filter({ hasText: '当前显示上次的内容' });
    await notice.waitFor();
    assert.equal(await attempts(), 3);
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.ok(await page.getByText('更新后的项目', { exact: true }).first().isVisible());
    await notice.getByRole('button', { name: '重试' }).click();
    await page.getByText('恢复后的项目', { exact: true }).first().waitFor();
    assert.equal(await notice.count(), 0);
  });
  await setup({ inboxBatch: true, width: 400 });
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.mouse.move(1, 1); // Let Edge acknowledge its first native input before timing panel actions.
  await test('narrow inbox starts with three rows and no dock, expands and collapses the rest', async () => {
    assert.equal(await rail().locator('[data-inbox-row]').count(), 3);
    assert.equal(await dock().count(), 0);
    await rail().getByRole('button', { name: '再看 2 条' }).click();
    assert.equal(await rail().locator('[data-inbox-row]').count(), 5);
    await rail().getByRole('button', { name: '收起' }).click();
    await rail().getByRole('button', { name: '再看 2 条' }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.home-layer .inbox [data-inbox-row]').length === 3);
  });
  await setup({ inboxBatch: true, delegatedFeedback: true, width: 360 });
  await test('home inbox groups by workspace ID and keeps hidden entries selectable', async () => {
    const toggle = id => rail().locator(`[aria-controls=inbox-workspace-${id}]`);
    const group = id => rail().locator(`#inbox-workspace-${id}`);
    const entry = id => group(id).getByRole('button', { name: '对方页面交付', exact: true });
    const titles = id => group(id).locator('[data-inbox-row]').evaluateAll(rows => rows.map(e => e.getAttribute('aria-label')));
    const count = () => rail().locator('.sec-h .pill').innerText();
    const screenshot = async state => {
      if (!process.env.PANEL_EVIDENCE_DIR) return;
      await page.mouse.move(1, 1);
      await rail().screenshot({ path: path.join(process.env.PANEL_EVIDENCE_DIR, `inbox-groups-${state}.png`), animations: 'disabled' });
    };
    await page.evaluate(() => {
      const [up, down] = fixture.links.peers;
      fixture.links.name = '本机工作间';
      fixture.projects[0].ref.name = 'AgentBoat';
      up.name = '海边工作间'; down.name = '设计工作间';
      up.report.projects[0].name = 'SeaSearch';
      const copy = structuredClone(up.report.projects[0]);
      copy.feedback.tasks = copy.feedback.tasks.slice(0, 1);
      copy.feedback.tasks[0].acceptance[0].title = '设计工作间成果';
      down.report.projects = [copy];
      fixture.emit();
    });
    await rail().getByRole('button', { name: '海边工作间，2 条待处理', exact: true }).waitFor();
    assert.equal(await count(), '8');
    assert.equal(await toggle('local').getAttribute('aria-label'), '本机工作间，5 条待处理');
    assert.equal(await toggle('peer-down').getAttribute('aria-label'), '设计工作间，1 条待处理');
    assert.deepEqual(await titles('peer-up'), ['对方页面交付']);
    await rail().getByRole('button', { name: '再看 3 条', exact: true }).click();
    assert.deepEqual(await titles('peer-up'), ['对方页面交付', '对方设计决定']);
    await page.evaluate(() => document.fonts.ready.then(() => true));
    await screenshot('expanded');
    await toggle('peer-up').focus();
    await page.keyboard.press('Enter');
    await screenshot('collapsed');
    assert.equal(await count(), '8');
    assert.equal(await toggle('peer-up').getAttribute('aria-expanded'), 'false');
    assert.equal(await toggle('peer-up').getAttribute('aria-label'), '海边工作间，2 条待处理');
    assert.equal(await entry('peer-up').count(), 0);
    assert.equal(await toggle('local').getAttribute('aria-expanded'), 'true');
    assert.equal(await toggle('peer-down').getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Tab');
    assert.equal(await toggle('peer-down').evaluate(e => e === document.activeElement), true);
    await group('local').locator('[data-inbox-row]').last().focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await entry('peer-down').evaluate(e => e === document.activeElement), true);
    await rail().getByRole('button', { name: '收起', exact: true }).click();
    await rail().getByRole('button', { name: '再看 2 条', exact: true }).waitFor();
    await rail().getByRole('button', { name: '全选验收', exact: true }).click();
    await dock().getByRole('button', { name: '已选 6 条 · 4 个项目', exact: true }).waitFor();
    const sheets = () => page.evaluate(() => fixture.stored['panel.feedbackState']);
    await page.waitForFunction(() => !!fixture.stored['panel.feedbackState']?.['["down","p1"]']);
    const saved = await sheets();
    assert.deepEqual(Object.keys(saved).sort(), ['["down","p1"]', '["up","p1"]', 'p1', 'p2']);
    await page.evaluate(() => { fixture.links.peers[0].name = fixture.links.peers[1].name; fixture.emit(); });
    await rail().getByRole('button', { name: '设计工作间，2 条待处理', exact: true }).waitFor();
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.top button.spin'));
    assert.deepEqual(await sheets(), saved);
    assert.equal(await count(), '8');
    assert.equal(await toggle('peer-up').getAttribute('aria-expanded'), 'false');
    assert.equal(await toggle('peer-down').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.home-layer').evaluate(e => e.scrollWidth <= e.clientWidth), true);
    await entry('peer-down').click();
    await group('peer-down').getByText('设计工作间成果', { exact: true }).waitFor();
    await toggle('peer-up').press('Space');
    const identities = await Promise.all(['peer-up', 'peer-down'].map(id => entry(id).getAttribute('data-inbox-row')));
    assert.deepEqual(identities.map(id => JSON.parse(JSON.parse(id)[0])), [['up', 'p1'], ['down', 'p1']]);
    await entry('peer-up').click();
    await group('peer-up').getByText('成果 remote-a', { exact: true }).waitFor();
    assert.equal(await group('peer-up').getByRole('checkbox', { name: /选择验收/ }).isChecked(), true);
    await entry('peer-up').focus();
    await toggle('peer-up').evaluate(e => e.click());
    assert.equal(await toggle('peer-up').evaluate(e => e === document.activeElement), true);
    await page.setViewportSize({ width: 1040, height: 900 });
    await page.locator('.home.wide').waitFor();
    assert.equal(await page.locator('.wide-pane').count(), 0);
    assert.deepEqual(await sheets(), saved);
    await page.waitForFunction(() => fixture.stored['panel.home']?.collapsedInboxGroups.includes('peer-up'));
    const stored = await page.evaluate(() => fixture.stored);
    stored['panel.home'].at -= 60 * 60_000;
    await setup({ inboxBatch: true, delegatedFeedback: true, width: 360, stored });
    assert.equal(await toggle('peer-up').getAttribute('aria-expanded'), 'false');
    assert.equal(await toggle('local').getAttribute('aria-expanded'), 'true');
  });
  await setup({ inboxBatch: true, width: 400 });
  await test('reopening an inline review uses the overview until the current task arrives', async () => {
    await openReview();
    await row('页面交付').click();
    await page.evaluate(() => { fixture.delayProject = 'p1'; fixture.prune(); });
    await row('页面交付').click();
    const body = rail().locator('.irow.open .irow-b');
    await body.getByText('成果 a1', { exact: true }).waitFor();
    assert.equal(await body.getByRole('button').count(), 0);
    await page.evaluate(() => fixture.finishRead());
    await body.getByText('第 2 版', { exact: true }).waitFor();
    await row('页面交付').click();
  });
  await setup({ inboxBatch: true, width: 400 });
  await test('unconfirmed snapshot persists across reopen; mismatched id is never success', async () => {
    await review('页面交付').check();
    await page.evaluate(() => {fixture.noWrite=true;});
    await dock().getByRole('button',{name:'提交 2 条'}).click();
    await page.getByRole('alert').filter({hasText:'缺少匹配的写入凭证'}).waitFor();
    const stored=await page.evaluate(()=>fixture.stored);
    const original=stored['panel.feedbackState'].p1.attempt.input;
    await setup({stored});
    await page.getByRole('alert').filter({hasText:'缺少匹配的写入凭证'}).waitFor();
    await page.evaluate(id=>fixture.project.requests.push({id,fingerprint:'different'}),original.requestId);
    await dock().getByRole('button',{name:'提交 2 条'}).click();
    await page.waitForFunction(()=>fixture.stored['panel.feedbackState'].p1.attempt.rejected===true);
    assert.equal(await review('页面交付').isChecked(),true);
    assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.name==='project.feedback').length),0);
    assert.deepEqual(await page.evaluate(()=>fixture.stored['panel.feedbackState'].p1.attempt.input),original);
  });
  await setup({width:1040});
  await test('two open panels merge different items, refuse stale undo, and retain the latest draft after reopen', async()=>{
    const hub=await browser.newPage(); await hub.addScriptTag({content:draftModel+';globalThis.fixtureDraftModel=draftModel;globalThis.sheets={};'});
    await setup({width:1040,inboxBatch:true},hub);const first=page;
    await review('页面交付').check();
    await hub.waitForFunction(()=>Object.keys(sheets.p1?.entries??{}).length===2);
    page=undefined;await setup({width:1040,inboxBatch:true},hub);const second=page;
    await review('移动端交付').check();await hub.waitForFunction(()=>!!sheets.p2);
    page=first;const body=await openReview();await body.getByRole('button',{name:'需要修改',exact:true}).first().click();
    await hub.waitForFunction(()=>Object.values(sheets.p1.entries).some(d=>d.result==='changes_requested'));
    page=second;await review('页面交付').uncheck();
    await page.getByRole('alert').filter({hasText:'另一个面板'}).waitFor();
    await setup({width:1040,inboxBatch:true},hub);
    await dock().getByRole('button',{name:'提交 3 条'}).waitFor();assert.equal(await review('移动端交付').isChecked(),true);
    assert.equal(await review('页面交付').evaluate(el=>el.indeterminate),true);
    await first.close();await hub.close();
  });
  await setup({width:1040});
  await test('durable prepare failure never sends a write',async()=>{
    await review('页面交付').check();await page.evaluate(()=>{fixture.failPrepare=true;});
    await dock().getByRole('button',{name:'提交 2 条'}).click();
    await page.getByRole('alert').filter({hasText:'请求记录未保存'}).waitFor();
    assert.equal(await review('页面交付').isChecked(),true);
    assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.name==='project.feedback').length),0);
  });
  await setup({width:1040,inboxBatch:true});
  await test('9+1 partial result is visible before the slow overview; no project pre-read',async()=>{
    await page.evaluate(async()=>{
      const [first,second]=fixture.projects;
      first.ref.id='a'.repeat(24);second.ref.id='b'.repeat(24);
      const seed=first.tasks[0].acceptance[0];
      first.tasks[0].acceptance=Array.from({length:8},(_,i)=>({...seed,id:'item-'+i,revision:2,fingerprint:String(i+1).padStart(64,'0')}));
      fixture.emit();
    });
    await rail().getByRole('button',{name:'全选验收'}).click();
    await dock().getByRole('button',{name:'提交 10 条'}).waitFor();
    await page.evaluate(()=>{fixture.failFeedback=fixture.delayFeedback=fixture.projects[0].ref.id;fixture.delayOverview=true;fixture.calls.length=0;});
    await dock().getByRole('button',{name:'提交 10 条'}).click();
    await page.waitForFunction(()=>!!fixture.finishFeedback && fixture.projects[1].requests.length===1);
    const busy = dock().getByRole('button',{name:'提交 10 条'});
    assert.equal(await busy.getAttribute('aria-busy'), 'true');
    assert.equal(await busy.isDisabled(), true);
    assert.equal(await busy.innerText(), '提交 10 条');
    assert.equal(await page.getByText(/正在准备提交|正在保存提交记录|正在提交…|已写入，正在更新选择/).count(), 0);
    const start=Date.now();await page.evaluate(()=>fixture.finishFeedback());
    await page.getByRole('alert').filter({hasText:'其余已提交 1 条'}).waitFor({timeout:1800});
    assert.ok(Date.now()-start<1800);
    const calls=await page.evaluate(()=>fixture.calls);assert.equal(calls.filter(c=>c.name==='project.read').length,0);
    assert.deepEqual(calls.filter(c=>c.name==='project.feedback').map(c=>c.input.items.length).sort((a,b)=>b-a),[9,1]);
    await dock().getByRole('button',{name:'提交 9 条'}).waitFor();
    assert.equal(await page.evaluate(()=>fixture.calls.some(c=>c.name==='workspace.overview')),false);
  });
  await setup({width:1040});
  await test('home and settings share the bound main status, time and color',async()=>{
    for(const [state,label,tone] of [['work','工作中 · 5 分钟前开始','work'],['need','等你 · 5 分钟前开始','need'],['idle','待命',''],['offline','离线','bad'],['unknown','在线','']]) {
      await page.evaluate(state=>{fixture.live.main={handle:fixture.workspace.session.handle,status:{state,since:Date.now()-300000}};fixture.emit();},state);
      const lead=page.locator('[data-workspace=self] .lead');
      await lead.getByText(new RegExp(label.replace(' · ',' . '))).waitFor();
      assert.equal((await lead.locator('.dot').getAttribute('class')).trim(),('dot '+tone).trim());
      if (state==='work') {await page.getByRole('button',{name:'设置',exact:true}).click();await currentLayer().locator('.lead').getByText(/工作中 · 5 分钟前开始/).waitFor();await home();}
    }
  });
  await test('主 agent 默认选 bot，两种表单互斥，选择已有 bot 只传本机 ID', async () => {
    await setup({ bot: true });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const manage = page.getByRole('button', { name: '管理主 agent' });
    assert.match(await manage.innerText(), /当前 bot · Codex.*预计恢复/);
    await manage.click();
    await currentLayer().getByText('已写入职责说明', { exact: false }).waitFor();
    assert.match(await currentLayer().innerText(), /备份位置：\/fixture\/plugin-data\/bot-soul-backups\/original.md/);
    const layer = currentLayer(), botTab = layer.getByRole('tab', { name: 'bot', exact: true });
    assert.equal(await botTab.getAttribute('aria-selected'), 'true');
    await layer.getByLabel('Bot', { exact: true }).waitFor();
    for (const label of ['工作区', '待命工作区', 'Agent']) assert.equal(await layer.getByLabel(label, { exact: true }).count(), 0);
    assert.equal(await layer.getByRole('button', { name: '新开一个主 agent' }).count(), 0);
    await layer.getByRole('tab', { name: '新会话' }).click();
    await layer.getByLabel('工作区', { exact: true }).waitFor();
    await layer.getByLabel('Agent', { exact: true }).waitFor();
    await layer.getByRole('button', { name: '新开一个主 agent' }).waitFor();
    assert.equal(await layer.getByLabel('Bot', { exact: true }).count(), 0);
    assert.equal(await layer.getByRole('button', { name: '设为主 bot' }).count(), 0);
    await botTab.click();
    assert.equal(await layer.getByLabel('Bot 代理').inputValue(), 'antigravity');
    assert.deepEqual(await layer.getByLabel('Bot 代理').locator('option').evaluateAll(options => options.map(o => o.value)), ['antigravity', 'grok']);
    await layer.getByRole('button', { name: '设为主 bot' }).click();
    await currentLayer().getByText(/等待接管绑定 · 工作管家/).waitFor();
    const choice = await page.evaluate(() => fixture.calls.find(c => c.name === 'workspace.agent.switch').input);
    assert.deepEqual(choice, { revision: 1, mode: 'bot', botId: 'new-bot', agent: 'antigravity' });
  });
  await test('普通主会话默认选新会话，可切换到本机 bot', async () => {
    await setup({ availableBot: true });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '管理主 agent' }).click();
    const tab = currentLayer().getByRole('tab', { name: '新会话' });
    await tab.waitFor();
    assert.equal(await tab.getAttribute('aria-selected'), 'true');
    assert.equal(await currentLayer().getByRole('button', { name: '设为主 bot' }).count(), 0);
  });
  await test('首次 bot 设置预览、错误和一键绑定，Codex 提示按需显示，绑定后修复 hooks', async () => {
    await setup({ unbound: true, availableBot: true, firstSetup: true });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '管理主 agent' }).click();
    const layer = currentLayer(), tab = layer.getByRole('tab', { name: 'bot', exact: true });
    const confirm = layer.getByRole('button', { name: '完成首次设置并设为主 bot' });
    const hookPath = '/fixture/custom-codex/hooks.json';
    await confirm.waitFor();
    assert.equal(await tab.getAttribute('aria-selected'), 'true');
    await layer.getByText('/fixture/.agents/skills/agentboat-workspace', { exact: true }).waitFor();
    await layer.getByText(hookPath, { exact: true }).waitFor();
    assert.equal(await layer.getByText(/输入 \/hooks/).count(), 0);
    await layer.getByLabel('Bot 代理').selectOption('claude');
    assert.equal(await layer.getByText(/输入 \/hooks/).count(), 0);
    await layer.getByLabel('Bot 代理').selectOption('codex');
    await layer.getByText(/写入定义后.*SessionStart、UserPromptSubmit、PreToolUse 和 Stop.*Codex 会话所在 PATH 可运行 Node ≥22/).waitFor();
    await layer.getByLabel('Bot 代理').selectOption('antigravity');
    assert.equal(await page.evaluate(() => fixture.calls.filter(c => ['workspace.agent.switch', 'workspace.setup'].includes(c.name)).length), 0);
    await page.evaluate(() => { fixture.failSetup = true; });
    await confirm.click();
    const failure = layer.getByRole('alert').filter({ hasText: '写入失败' });
    assert.match(await failure.innerText(), /custom-codex\/hooks\.json[\s\S]*备份位置：\/fixture\/\.agentboat\/backups\/setup-retry/);
    assert.equal(await page.evaluate(() => fixture.workspace.takeover), undefined);
    await page.evaluate(() => { fixture.delayBot = true; });
    await confirm.click();
    await layer.getByText(/正在启动对话 · 工作管家/).waitFor();
    await page.evaluate(() => fixture.finishBot());
    await layer.getByText(/等待接管绑定 · 工作管家/).waitFor();
    await page.evaluate(() => {
      delete fixture.workspace.takeover;
      Object.assign(fixture.workspace, { runId: 'run_new_bot', bot: { id: 'new-bot', name: '工作管家', agent: 'antigravity' },
        session: { handle: 'bot-side-chat', title: '新接管对话', agent: 'antigravity', online: 'online' } });
      fixture.emit();
    });
    await layer.getByText('run_new_bot', { exact: true }).waitFor();
    await layer.getByText('bot-side-chat', { exact: true }).waitFor();
    assert.equal(await layer.getByText(/输入 \/hooks/).count(), 0);
    await page.evaluate(() => {
      fixture.projectUsesCodex = true;
      fixture.setup.paths = [fixture.setup.codexHooks];
      fixture.setup.confirmation = 'b'.repeat(64);
      fixture.emit();
    });
    await layer.getByText(hookPath, { exact: true }).waitFor();
    await layer.getByRole('button', { name: '确认修复' }).click();
    await layer.getByText(/Codex hook 定义已写入.*SessionStart、UserPromptSubmit、PreToolUse 和 Stop/).waitFor();
    assert.equal(await layer.getByRole('button', { name: '确认修复' }).count(), 0);
    const actions = await page.evaluate(() => fixture.calls.filter(c => ['workspace.agent.switch', 'workspace.setup'].includes(c.name)));
    assert.deepEqual(actions.map(c => c.input.setupConfirmation ?? c.input.confirmation), ['a'.repeat(64), 'a'.repeat(64), 'b'.repeat(64)]);
  });
  await test('自定义 Codex 目录保存后更新预览，首次绑定在线或新会话都带确认凭据', async () => {
    for (const mode of ['existing', 'new']) {
      await setup({ unbound: true, emptyBots: true, firstSetup: true });
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: '管理主 agent' }).click();
      const layer = currentLayer();
      const action = layer.getByRole('button', { name: mode === 'existing' ? '完成首次设置并绑定' : '完成首次设置并新开主 agent', exact: true }).first();
      await action.waitFor();
      await layer.getByRole('button', { name: '高级选项' }).click();
      const field = layer.getByLabel('CODEX_HOME'), save = layer.getByRole('button', { name: '保存 Codex 目录' });
      assert.equal(await field.inputValue(), '/fixture/custom-codex');
      await field.fill('../relative');
      assert.equal(await action.isDisabled(), true);
      await save.click();
      await layer.getByRole('alert').filter({ hasText: '完整绝对路径' }).waitFor();
      assert.equal(await page.evaluate(() => fixture.stored['workspace.setup.codexHome']), undefined);
      await field.fill('/fixture/chosen-codex');
      await save.click();
      await layer.getByText('/fixture/chosen-codex/hooks.json', { exact: true }).waitFor();
      await action.click();
      await layer.getByText(/等待接管绑定/).waitFor();
      const request = await page.evaluate(() => fixture.calls.find(c => c.name === 'workspace.agent.switch').input);
      assert.equal(request.mode, mode);
      assert.equal(request.setupConfirmation, 'c'.repeat(64));
    }
  });
  await test('settings details show available data while reads are pending and recover locally', async () => {
    await setup({ coldMain: true, holdAgents: true, hermes: true });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const manage = page.getByRole('button', { name: '管理主 agent' });
    assert.match(await manage.innerText(), /正在获取状态/);
    const hold = name => page.evaluate(name => { delete fixture.finishRead; fixture.holdRead = name; }, name);
    const finish = ok => page.evaluate(ok => fixture.finishRead(ok), ok);
    await hold('workspace.agent.targets');
    await manage.click();
    const detail = currentLayer();
    await detail.getByText('正在读取在线会话…').waitFor();
    assert.match(await detail.innerText(), /统筹会话/);
    await detail.getByText('绑定详情').click();
    await detail.getByText('run_main', { exact: true }).waitFor();
    await finish(false);
    await detail.getByText('在线会话暂时无法读取').waitFor();
    await detail.getByRole('button', { name: '重试' }).click();
    await detail.getByText('甲会话').waitFor();
    await back();
    await hold('workspace.connections');
    await page.getByRole('button', { name: 'Hermes', exact: true }).click();
    await detail.getByText('正在读取连接设置…').waitFor();
    await detail.getByText('未检查', { exact: true }).waitFor();
    assert.equal(await detail.getByRole('button', { name: '保存' }).count(), 0);
    await finish(false);
    await detail.getByText('连接设置暂时无法读取').waitFor();
    await hold('workspace.hermesApprovalMode');
    await detail.getByRole('button', { name: '重试' }).click();
    await detail.getByText('正在读取审批方式…').waitFor();
    const address = detail.getByLabel('对方的地址', { exact: true });
    assert.equal(await address.inputValue(), 'http://127.0.0.1:1234');
    await address.fill('http://127.0.0.1:4321');
    await finish(true);
    await detail.getByText('电脑操作的批准：smart').waitFor();
    assert.equal(await address.inputValue(), 'http://127.0.0.1:4321');
    await hold('workspace.connections');
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.waitForFunction(() => typeof fixture.finishRead === 'function');
    await finish(false);
    await detail.getByText('连接设置暂时无法读取').waitFor();
    assert.equal(await address.inputValue(), 'http://127.0.0.1:4321');
    assert.deepEqual(await page.evaluate(() => fixture.calls.filter(c => c.name === 'workspace.connections').map(c => c.input.operation)), ['read', 'read', 'read']);
  });
  await setup({width:1040});
  await test('single write confirms without waiting for background overview',async()=>{
    await review('页面交付').check();await page.evaluate(()=>{
      fixture.delayOverview=true;fixture.calls.length=0;fixture.timing=[];
      const request=orca.plugin.request;
      orca.plugin.request=async(name,input)=>{const start=performance.now();
        if(name==='project.feedback')await new Promise(r=>setTimeout(r,90));
        try{return await request(name,input);}finally{fixture.timing.push({step:name==='panel.feedbackState'?(input.change?.attempt?.value?'save-request':'save-draft'):name,ms:Math.round(performance.now()-start)});}
      };
    });
    const start=Date.now();await dock().getByRole('button',{name:'提交 2 条'}).click();
    await page.getByRole('status').filter({hasText:'已提交 2 条'}).waitFor({timeout:1800});
    assert.ok(Date.now()-start<1800);assert.equal(await page.evaluate(()=>fixture.calls.some(c=>c.name==='project.read')),false);
    if(process.env.PANEL_EVIDENCE_DIR) await fs.writeFile(path.join(process.env.PANEL_EVIDENCE_DIR,'timing-after-fixture.json'),JSON.stringify([...(await page.evaluate(()=>fixture.timing)),{step:'click-through-confirmation',ms:Date.now()-start}],null,2));
    assert.equal(await page.evaluate(()=>fixture.calls.some(c=>c.name==='workspace.overview')),false);
  });
  await setup({inboxBatch:true,width:400});
  await test('narrow rows expand together and share one persisted draft with the dock', async () => {
    await row('设计决定').click();
    await rail().getByRole('radio', { name: '方案一' }).check();
    assert.equal(await page.locator('.pane').count(), 0);
    await dock().getByRole('button', { name: '提交 1 条' }).waitFor();
    const body = await openReview();
    assert.equal(await row('设计决定').getAttribute('aria-expanded'), 'true');
    await body.getByRole('button', { name: '通过', exact: true }).first().click();
    const passNote = body.getByRole('textbox', { name: '通过留言（选填）' }).first();
    await passNote.fill('请继续完善页面');
    await review('页面交付').check();
    assert.equal(await rail().getByRole('button', { name: '通过', exact: true, pressed: true }).count(), 2);
    assert.equal(await passNote.inputValue(), '请继续完善页面');
    await body.getByRole('button', { name: '这 2 项全部通过' }).click();
    assert.equal(await passNote.inputValue(), '请继续完善页面');
    await rail().getByRole('button', { name: '需要修改', exact: true }).first().click();
    assert.equal(await review('页面交付').evaluate(e => e.indeterminate), true);
    assert.equal(await dock().getByRole('button', { name: '提交 3 条' }).isDisabled(), true);
    assert.equal(await rail().getByRole('textbox', { name: '修改意见' }).inputValue(), '');
    await rail().getByRole('textbox', { name: '修改意见' }).fill('请调整标题');
    assert.equal(await dock().getByRole('button', { name: '提交 3 条' }).isEnabled(), true);
    await dock().getByRole('button', { name: '已选 3 条 · 1 个项目' }).click();
    assert.equal(await dock().getByRole('button', { name: /^移除/ }).count(), 3);
    await page.keyboard.press('Escape');
    assert.equal(await dock().getByRole('button', { name: /^移除/ }).count(), 0);
    await page.waitForFunction(() => Object.values(fixture.stored['panel.feedbackState']?.p1?.entries ?? {}).length === 3);
  });
  await setup({ inboxBatch: true, width: 400, manyProjects: true, idleProjects: true });
  await test('background patch preserves row, fold, editor, cursor and focus while new rows appear', async () => {
    const body = await openReview();
    await body.getByRole('button', { name: '需要修改', exact: true }).first().click();
    const fold = page.getByRole('button', { name: /^还没有任务的项目/ });
    await fold.click();
    const input = body.getByRole('textbox', { name: '修改意见' });
    await input.fill('要保留正在写的意见');
    await input.evaluate(e => { e.setSelectionRange(3, 6); window.originalEditor = e; window.originalRow = e.closest('.irow'); });
    await page.evaluate(() => {
      const a = fixture.live.agents[0]; fixture.live.agents.unshift({ ...a, id: 'new', title: '新到一件' }); fixture.emit();
    });
    await row('新到一件').waitFor();
    assert.equal(await fold.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await input.evaluate(e => [e === originalEditor, e.closest('.irow') === originalRow, e === document.activeElement, e.selectionStart, e.selectionEnd, e.value]),
      [true, true, true, 3, 6, '要保留正在写的意见']);
  });
  await setup({ inboxBatch: true, width: 400, longInbox: true });
  await test('grouped submit records rows before removal and preserves the scroller', async () => {
    await rail().getByRole('button', { name: /^再看 / }).click();
    await rail().getByRole('button', { name: '全选验收' }).click();
    const layer = page.locator('.home-layer');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => !document.querySelector('.home-layer .irows')
      .getAnimations({ subtree: true }).some(a => a.pending || a.playState === 'running'));
    const scroll = await layer.evaluate(e => { e.scrollTop = 360; return e.scrollTop; });
    assert.equal(scroll, 360);
    // Removing 全选验收 changes the header height, so compare the visible row, not scrollTop.
    const rowTop = () => row('待回复 5').evaluate(e => e.getBoundingClientRect().top - e.closest('.home-layer').getBoundingClientRect().top);
    const before = await rowTop();
    await page.evaluate(() => { fixture.delayFeedback = true; });
    await dock().getByRole('button', { name: '提交 14 条' }).click();
    await dock().getByRole('button', { name: '提交 14 条' }).waitFor({ state: 'visible' });
    assert.equal(await dock().getByRole('button', { name: '提交 14 条' }).isDisabled(), true);
    await page.waitForFunction(() => !!fixture.finishFeedback);
    await page.evaluate(() => fixture.finishFeedback());
    await rail().getByText('页面交付 · ✓ 已提交', { exact: true }).waitFor();
    assert.ok(Math.abs(await rowTop() - before) < 12);
    await rail().getByText('页面交付 · ✓ 已提交', { exact: true }).waitFor({ state: 'detached' });
    await dock().waitFor({ state: 'hidden' });
    assert.ok(Math.abs(await rowTop() - before) < 12);
    const sent = await page.evaluate(() => fixture.calls.filter(c => c.name === 'project.feedback').map(c => c.input));
    assert.deepEqual(sent.map(s => [s.projectId, s.items.length]).sort(), [['p1', 13], ['p2', 1]]);
    assert.equal(await rail().locator('.pill').innerText(), '32');
  });
  for (const change of ['revision', 'withdrawn', 'added', 'race']) {
    await setup({ inboxBatch: true, width: 1040 });
    await test(`one ${change} project keeps its entire batch while the other submits`, async () => {
      await rail().getByRole('button', { name: '全选验收' }).click();
      await page.evaluate(change => {
        const t = fixture.project.tasks[0];
        if (change === 'revision') fixture.prune();
        if (change === 'withdrawn') t.phase = 'working';
        if (change === 'added') t.acceptance.push({ ...t.acceptance[0], id: 'new' });
        if (change === 'race') fixture.race = true;
      }, change);
      await dock().getByRole('button', { name: '提交 4 条' }).click();
      const alert = page.getByRole('alert').filter({ hasText: '未确认提交' });
      await alert.waitFor();
      await dock().getByRole('button', { name: '已选 3 条 · 1 个项目' }).waitFor();
      const projects = await page.evaluate(() => fixture.calls.filter(c => c.name === 'project.feedback').map(c => c.input.projectId).sort());
      assert.deepEqual(projects, ['p1', 'p2']);
      if (change === 'race') { await page.waitForTimeout(3300); assert.equal(await alert.isVisible(), true); }
    });
  }
  await setup({ width: 1040 });
  await test('retry after a missing receipt applies the newly written snapshot immediately', async () => {
    await review('页面交付').check();
    await page.evaluate(() => { fixture.noWrite = true; });
    const submit = dock().getByRole('button', { name: '提交 2 条' });
    await submit.click();
    await page.getByRole('alert').filter({ hasText: '缺少匹配的写入凭证' }).waitFor();
    await page.evaluate(() => { fixture.noWrite = false; fixture.delayOverview = true; });
    await submit.click();
    await dock().waitFor({ state: 'hidden' });
    await rail().locator('.irow.submitted').waitFor({ state: 'detached' });
    assert.equal(await review('页面交付').count(), 0);
    const ids = await page.evaluate(() => fixture.calls.filter(c => c.name === 'project.feedback').map(c => c.input.requestId));
    assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
  });
  await setup({ width: 1040 });
  await test('lost feedback receipt is recognized and never sent a second time', async () => {
    await review('页面交付').check();
    await page.evaluate(() => { fixture.loseFeedbackReceipt = true; });
    await dock().getByRole('button', { name: '提交 2 条' }).click();
    await page.getByRole('alert').filter({ hasText: '回执丢失' }).waitFor();
    const first = await page.evaluate(() => fixture.calls.find(c => c.name === 'project.feedback').input.requestId);
    assert.equal(await page.evaluate(() => fixture.stored['panel.feedbackState'].p1.attempt.input.requestId), first);
    await dock().getByRole('button', { name: '提交 2 条' }).click();
    await dock().waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.name === 'project.feedback').length), 1);
  });
  await setup({ width: 1040 });
  await test('a pass note is optional, survives a failed write and appears in the passed history', async () => {
    const title = '调研 Orca v1.4.277 对 AgentBoat 的可用更新';
    const note = '按报告里的建议开始修改';
    await page.evaluate(title => {
      fixture.project.ref.name = 'AgentBoat（隔离夹具）';
      const task = fixture.project.tasks[0];
      task.title = title;
      task.goal = '核对 Orca 更新对 AgentBoat 的可用建议';
      task.progress = '已提交 Orca 更新调研报告';
      task.acceptance.splice(1);
      task.artifacts = [{ id: 'report', label: 'Orca 1.4.277 更新调研报告', version: 'v1', url: '/fixture/report.md' }];
      Object.assign(task.acceptance[0], { title: '核对 Orca 更新建议', artifactIds: ['report'],
        details: '从成果打开报告。确认它按优先级列出 Antigravity 技能与角色提示、保留原 Run 的恢复、清理设置和旧会话卡顿。可用 orca status --environment local --json 和 orca plugin list --environment local --json 复核 Windows 版本。预期报告明确标出 Mac、手机和本轮未实测的操作。' });
      fixture.emit();
    }, title);
    await row(title).waitFor();
    await project();
    await currentLayer().getByRole('tab', { name: '任务', exact: true }).click();
    await currentLayer().getByRole('button', { name: title, exact: true }).click();
    const card = currentLayer().getByRole('region', { name: '要你处理', exact: true });
    const pass = card.getByRole('button', { name: '通过', exact: true });
    const field = card.getByRole('textbox', { name: '通过留言（选填）' });
    const submit = dock().getByRole('button', { name: '提交 1 条' });
    await pass.waitFor();
    assert.equal(await field.count(), 0);
    await pass.click();
    assert.equal(await submit.isEnabled(), true);
    await field.fill(note);
    await card.getByRole('button', { name: '需要修改', exact: true }).click();
    assert.equal(await field.count(), 0);
    assert.equal(await submit.isDisabled(), true);
    assert.equal(await card.getByRole('textbox', { name: '修改意见' }).inputValue(), '');
    await card.getByRole('button', { name: '丢弃', exact: true }).click();
    assert.equal(await submit.isEnabled(), true);
    assert.equal(await card.getByRole('textbox', { name: '丢弃原因（选填）' }).inputValue(), '');
    await pass.click();
    assert.equal(await field.inputValue(), '');
    await field.fill(note);
    assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.name === 'project.feedback').length), 0);
    const evidence = process.env.PANEL_EVIDENCE_DIR;
    if (evidence) await page.screenshot({ path: path.join(evidence, 'acceptance-pass-note-draft.png'), animations: 'disabled' });
    await page.evaluate(() => { fixture.failFeedback = true; });
    await submit.click();
    await page.getByRole('alert').filter({ hasText: '回执连接中断' }).waitFor();
    assert.equal(await field.inputValue(), note);
    assert.equal(await pass.getAttribute('aria-pressed'), 'true');
    if (evidence) await page.screenshot({ path: path.join(evidence, 'acceptance-pass-note-retry.png'), animations: 'disabled' });
    await submit.click();
    await page.getByRole('status').filter({ hasText: '已提交 1 条' }).waitFor();
    await currentLayer().getByRole('button', { name: /^记录/ }).click();
    await currentLayer().getByText(/核对 Orca 更新建议.*第 1 版.*已通过/).waitFor();
    await currentLayer().getByText(`通过留言：${note}`, { exact: true }).waitFor();
    const receipt = await page.evaluate(() => ({
      submissions: fixture.calls.filter(c => c.name === 'project.feedback').map(c => c.input),
      receipts: fixture.project.requests,
      acceptance: fixture.project.tasks[0].acceptance[0],
      deliveries: fixture.project.deliveries.length,
    }));
    assert.equal(receipt.submissions.length, 2);
    assert.deepEqual(receipt.submissions[0], receipt.submissions[1]);
    assert.deepEqual(receipt.submissions[0].items.map(i => [i.itemId, i.result, i.note]), [['a1', 'passed', note]]);
    assert.deepEqual(receipt.receipts.map(r => r.id), [receipt.submissions[0].requestId]);
    assert.equal(receipt.deliveries, 1);
    assert.equal(receipt.acceptance.status, 'passed');
    assert.deepEqual(receipt.acceptance.history.map(h => [h.result, h.note]), [['passed', note]]);
    if (evidence) {
      await page.screenshot({ path: path.join(evidence, 'acceptance-pass-note-history.png'), animations: 'disabled' });
      await fs.writeFile(path.join(evidence, 'acceptance-pass-note-receipt.json'), JSON.stringify(receipt, null, 2));
    }
  });
  await setup({ width: 1040, inboxBatch: true });
  await test('decision text and reviews share one strict-JSON batch and close a completed detail', async () => {
    await review('页面交付').check();
    assert.equal(await page.evaluate(() => fixture.calls.some(c => c.name === 'project.feedback')), false);
    await row('设计决定').click();
    await currentLayer().getByRole('radio', { name: '其他', exact: true }).check();
    await dock().getByRole('button', { name: '提交 3 条' }).waitFor();
    assert.equal(await dock().getByRole('button', { name: '提交 3 条' }).isDisabled(), true);
    await currentLayer().getByRole('textbox', { name: '你的决定' }).fill('自定义方案');
    await dock().getByRole('button', { name: '提交 3 条' }).click();
    await page.getByRole('status').filter({ hasText: '已提交 3 条' }).waitFor();
    await page.locator('.wide-pane').waitFor({ state: 'hidden' });
    const sent = await page.evaluate(() => fixture.calls.filter(c => c.name === 'project.feedback'));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].input.items.filter(i => i.kind === 'acceptance').length, 2);
    assert.equal(sent[0].input.items.find(i => i.kind === 'decision').answer, '自定义方案');
    await page.getByRole('status').filter({ hasText: '已提交 3 条' }).waitFor({ state: 'hidden' });
  });
  await setup({ width:1040, inboxBatch:true, blocked:true });
  await test('blocked note shares one submission with acceptance and decision and permits a follow-up', async () => {
    await row('等待补建').click();
    await currentLayer().getByRole('textbox', {name:'受阻备注'}).fill('补建完成');
    await row('设计决定').click();
    await currentLayer().getByRole('radio', {name:'方案一'}).check();
    await (await openReview()).getByRole('button', {name:'通过',exact:true}).first().click();
    await dock().getByRole('button', {name:'提交 3 条'}).click();
    await row('等待补建').getByText(/已答复，等项目处理/).waitFor();
    const sent = await page.evaluate(() => fixture.calls.filter(c => c.name === 'project.feedback'));
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].input.items.map(i => i.kind), ['blocked', 'decision', 'acceptance']);
    assert.equal(sent[0].input.items[0].note, '补建完成');
    await row('等待补建').click();
    await currentLayer().getByRole('button', {name:'丢弃',exact:true}).click();
    await dock().getByRole('button', {name:'提交 1 条'}).click();
    await row('等待补建').waitFor({state:'hidden'});
  });
  await setup({ width: 1040, inboxBatch: true });
  await test('owner can discard reviews and decisions together with an optional reason and read the task history', async () => {
    const body = await openReview();
    await body.getByRole('button', {name:'丢弃', exact:true}).first().click();
    await body.getByRole('textbox', {name:'丢弃原因（选填）'}).fill('改用新版');
    await body.getByRole('button', {name:'通过', exact:true}).last().click();
    await row('设计决定').click();
    await currentLayer().getByRole('button', {name:'丢弃', exact:true}).click();
    await dock().getByRole('button', {name:'提交 3 条'}).click();
    await page.getByRole('status').filter({hasText:'已提交 3 条'}).waitFor();
    await row('设计决定').waitFor({state:'hidden'});
    await row('页面交付').waitFor({state:'hidden'});
    const sent = await page.evaluate(() => fixture.calls.filter(c => c.name === 'project.feedback'));
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].input.items.map(i => [i.kind, i.result, i.note ?? '']), [
      ['acceptance','discarded','改用新版'], ['acceptance','passed',''], ['decision','discarded','']]);
    await project();
    await currentLayer().getByRole('tab', {name:'任务', exact:true}).click();
    await currentLayer().getByRole('button', {name:'页面交付', exact:true}).click();
    await currentLayer().getByRole('button', {name:/^记录/}).click();
    await currentLayer().getByText(/成果 a1.*第 1 版.*已丢弃.*主人.*改用新版/).waitFor();
  });
  await setup();
  await test('expanded narrow row follows the same task into the wide detail', async () => {
    const body = await openReview();
    await body.getByRole('button', { name: '需要修改', exact: true }).first().click();
    await body.getByRole('textbox', { name: '修改意见' }).fill('调整布局');
    await page.setViewportSize({ width: 1040, height: 900 });
    const editor = currentLayer().getByRole('textbox', { name: '修改意见' });
    await editor.waitFor();
    assert.equal(await editor.inputValue(), '调整布局');
    await page.setViewportSize({ width: 400, height: 900 });
    await editor.waitFor();
    assert.equal(await editor.inputValue(), '调整布局');
  });
  for (const width of [1040, 400]) {
    await setup({ width, archive: true });
    await test(`only latest artifacts appear and the owner can expire a group at ${width}px`, async () => {
      await page.evaluate(() => {
        const t = fixture.project.tasks[0];
        const artifact = (id, version, registeredAt) => ({ id, label: '原稿', version, registeredAt, url: '/example/' + id });
        t.artifacts = [artifact('old', 'v9', '2025-01-01'), artifact('new', '原稿', '2025-03-01')];
        fixture.project.tasks.push({ ...t, id: 'second', title: '插画', acceptance: [], artifacts: [
          artifact('other', 'v2', '2025-02-01'), { ...t.artifacts[1], id: 'copy', label: '交付图', registeredAt: '2025-02-20' }
        ] });
      });
      await project();
      await currentLayer().getByRole('tab', { name: '成果', exact: true }).click();
      const panel = currentLayer().getByRole('tabpanel');
      const titles = () => panel.locator('.item').evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label')));
      assert.deepEqual(await titles(), ['原稿']);
      assert.match(await panel.innerText(), /页面交付、插画 · 登记/);
      const entry = panel.getByRole('button', { name: '原稿', exact: true });
      assert.equal(await entry.evaluate(el => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: innerWidth - 1, clientY: innerHeight - 1 }))), false);
      const menu = page.getByRole('menu', { name: '成果操作' }), viewport = page.viewportSize();
      const bounds = await menu.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
      await menu.getByRole('menuitem', { name: '打开所在文件夹' }).click();
      assert.deepEqual(await page.evaluate(() => fixture.calls.filter(c => c.name === 'project.openArtifactFolder').map(c => c.input)),
        [{ projectId: 'p1', taskId: 't1', artifactId: 'new' }]);
      await panel.evaluate(el => { el.style.minHeight = '100vh'; });
      await rightClickArtifact(entry);
      await menu.waitFor();
      assert.ok(await panel.evaluate(el => {
        const layer = el.closest('.layer'), before = layer.scrollTop;
        layer.scrollTop = layer.scrollHeight;
        return layer.scrollTop > before;
      }));
      await menu.waitFor({ state: 'detached' });
      await panel.evaluate(el => { el.style.minHeight = ''; });
      await entry.click();
      assert.equal(await panel.getByRole('button', { name: /旧版本/ }).count(), 0);
      await panel.getByRole('button', { name: '标为过期', exact: true }).click();
      await panel.getByRole('button', { name: '取消' }).click();
      assert.deepEqual(await titles(), ['原稿']);
      await panel.getByRole('button', { name: '标为过期', exact: true }).click();
      await panel.getByRole('button', { name: '确认标为过期' }).click();
      await panel.getByText('还没有成果').waitFor();
      await currentLayer().getByRole('tab', { name: '任务', exact: true }).click();
      await currentLayer().getByRole('button', { name: '页面交付', exact: true }).click();
      await currentLayer().getByRole('button', { name: /^成果 / }).click();
      await currentLayer().getByRole('button', { name: '原稿 · 已过期', exact: true }).waitFor();
      await currentLayer().getByRole('button', { name: '原稿 · v9 · 旧版本', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => fixture.calls.filter(c => c.name === 'project.openArtifact').map(c => c.input)), [
        { projectId: 'p1', taskId: 't1', artifactId: 'new' },
        { projectId: 'p1', taskId: 't1', artifactId: 'old' }
      ]);
    });
    await setup({ width, inboxBatch: true, artifacts: true });
    await test(`artifact actions use the owning project and report failures at ${width}px`, async () => {
      if (width === 1040) await openReview('页面交付');
      else await rail().getByRole('button', { name: '再看 2 条' }).click();
      const body = await openReview('移动端交付');
      const calls = () => page.evaluate(() => fixture.calls.filter(c => c.name === 'project.openArtifact').map(c => c.input));
      const expected = artifactId => ({ projectId: 'p2', taskId: 't2', artifactId });
      const entry = body.getByRole('button', { name: '打开成果 · 设计文档', exact: true });
      const menu = page.getByRole('menu', { name: '成果操作' });
      assert.match(await entry.getAttribute('title'), /右键打开所在文件夹/);
      await rightClickArtifact(entry);
      await menu.waitFor();
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
      assert.equal(await entry.evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('Shift+F10');
      await page.keyboard.press('Enter');
      assert.deepEqual(await page.evaluate(() => fixture.calls.filter(c => c.name === 'project.openArtifactFolder').map(c => c.input)), [expected('md')]);
      await body.getByRole('button', { name: '打开成果 · 网页预览', exact: true }).click({ button: 'right' });
      assert.equal(await menu.count(), 0);
      await entry.click();
      await page.evaluate(() => { fixture.artifactError = '成果文件不存在或无法访问'; });
      await body.getByRole('button', { name: '打开成果 · 样稿 v9', exact: true }).click();
      const error = page.getByRole('alert').filter({ hasText: '打不开「样稿 v9」：成果文件不存在或无法访问' });
      await error.waitFor();
      assert.deepEqual(await calls(), ['md', 'html'].map(expected));
      await page.evaluate(() => { delete fixture.artifactError; });
      await error.getByRole('button', { name: '重试' }).click();
      await error.waitFor({ state: 'detached' });
      await body.getByRole('button', { name: '任务详情', exact: true }).click();
      const detail = currentLayer();
      await detail.getByRole('button', { name: '打开成果 · 样稿 v9', exact: true }).click();
      await detail.getByRole('button', { name: /^成果 / }).click();
      const taskEntry = detail.getByRole('button', { name: '设计文档 · v1', exact: true });
      await rightClickArtifact(taskEntry);
      await activeHeader().getByRole('heading', { name: '移动端交付', exact: true }).click();
      await menu.waitFor({ state: 'detached' });
      await rightClickArtifact(taskEntry);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      assert.deepEqual(await calls(), ['md', 'html', 'html', 'html', 'md'].map(expected));
    });
  }
  await setup({ archive: true });
  await test('project tasks open readable archive batches, task details and their archived artifacts', async () => {
    await page.locator('[data-project=p1] .pcard-h').click();
    await currentLayer().getByRole('tab', { name: 'Agent', exact: true }).click();
    assert.equal(await currentLayer().getByRole('button', { name: /项已归档/ }).count(), 0);
    await currentLayer().getByRole('tab', { name: '任务', exact: true }).click();
    await currentLayer().getByRole('button', { name: '更早的 1 项已归档' }).click();
    await currentLayer().getByText('通知 2 条 · 来源消息 1 条 · 请求凭证 3 条 · 历史 4 条').waitFor();
    const archivedRow = currentLayer().getByRole('button', { name: '归档任务' });
    assert.match(await archivedRow.getAttribute('aria-description'), /已完成 · .+/);
    await archivedRow.click();
    await activeHeader().getByRole('heading', { name: '归档任务' }).waitFor();
    await currentLayer().getByText('旧版页面已验收').waitFor();
    await currentLayer().getByRole('region', { name: '验收' }).getByText('已通过').waitFor();
    await currentLayer().getByRole('region', { name: '决定' }).getByText('第一版').waitFor();
    assert.doesNotMatch(await currentLayer().innerText(), /历史原文|现在谁在做/);
    await currentLayer().getByRole('button', { name: /^成果 / }).click();
    const archiveEntry = currentLayer().getByRole('button', { name: '验收文档 · v1' });
    const target = { projectId: 'p1', taskId: 't1', artifactId: 'md', archiveEnd: 50 };
    await rightClickArtifact(archiveEntry);
    await page.getByRole('menuitem', { name: '打开所在文件夹' }).click();
    await archiveEntry.click();
    assert.deepEqual(await page.evaluate(() => fixture.calls.filter(c => c.name.startsWith('project.openArtifact')).slice(-2).map(c => c.input)), [target, target]);
    await back();
    await currentLayer().getByRole('button', { name: '更早一批' }).click();
    await currentLayer().getByText('这批没有归档任务').waitFor();
    await currentLayer().getByText('通知 5 条 · 来源消息 0 条 · 请求凭证 4 条 · 历史 0 条').waitFor();
    assert.equal(await currentLayer().getByRole('button', { name: '更早一批' }).count(), 0);
  });
  await setup({ manyProjects: true, idleProjects: true });
  await test('nested navigation restores tab, scroll, focus and open folds and hides covered content', async () => {
    await page.getByRole('button', { name: /^还没有任务的项目/ }).click();
    await page.locator('[data-workspace=down] .wsr-h').click();
    const homeLayer = page.locator('.home-layer');
    await homeLayer.evaluate(e => { e.scrollTop = 94; });
    await page.locator('[data-project=p1] .pcard-h').click();
    const scroll = await homeLayer.evaluate(e => e.scrollTop);
    await currentLayer().getByRole('tab', { name: '任务', exact: true }).click();
    await currentLayer().getByRole('button', { name: '页面交付', exact: true }).click();
    await page.locator('.top').getByRole('heading', { name: '页面交付' }).waitFor();
    assert.equal(await activeHeader().getByRole('button', { name: '返回「示例项目」' }).count(), 1);
    assert.equal(await page.locator('.covered .xp.open .pcard').first().evaluate(e => getComputedStyle(e).visibility), 'hidden');
    assert.equal(await currentLayer().locator('section').first().getAttribute('aria-label'), '要你处理');
    for (const name of ['成果', '来源消息', '记录']) assert.equal(await currentLayer().getByRole('button', { name, exact: true }).count(), 0);
    assert.equal(await currentLayer().getByRole('button', { name: '目标' }).getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Alt+ArrowLeft');
    assert.equal(await currentLayer().getByRole('tab', { name: '任务', exact: true }).getAttribute('aria-selected'), 'true');
    await back();
    assert.equal(await page.getByRole('button', { name: /^还没有任务的项目/ }).getAttribute('aria-expanded'), 'true');
    assert.equal(await homeLayer.evaluate(e => e.scrollTop), scroll);
    assert.equal(await page.locator('[data-project=p1] .pcard-h').evaluate(e => e === document.activeElement), true);
  });
  await setup({ width: 1040, inboxBatch: true, twoWaitingAgents: true });
  await test('wide inbox switches rows by keyboard; detail is shared by projects and settings', async () => {
    const body = await openReview();
    await page.locator('.pane-top h2').filter({ hasText: '页面交付' }).waitFor();
    assert.equal(await row('页面交付').getAttribute('aria-expanded'), 'true');
    assert.equal(await body.getByRole('button', { name: '任务详情', exact: true }).count(), 1);
    const previous = rail().getByRole('button', { name: '设计决定', exact: true });
    await previous.focus(); await page.keyboard.press('ArrowDown');
    assert.equal(await row('页面交付').evaluate(e => e === document.activeElement), true);
    await page.keyboard.press('ArrowUp');
    await page.locator('.pane-top h2').filter({ hasText: '设计决定' }).waitFor();
    assert.equal(await previous.evaluate(e => e === document.activeElement), true);
    await back();
    await project();
    await page.getByRole('button', { name: '项目设置', exact: true }).click();
    await currentLayer().getByRole('heading', { name: '分工', exact: true }).waitFor();
    assert.equal(await rail().isVisible(), true);
    assert.equal(await page.getByRole('button', { name: '关闭，回到组织' }).count(), 1);
    await page.setViewportSize({ width: 400, height: 900 });
    await page.locator('.top').getByRole('heading', { name: '项目设置' }).waitFor();
    assert.equal(await rail().isVisible(), false);
    await page.setViewportSize({ width: 1040, height: 900 });
    await page.locator('.wide-pane .pane-top').getByRole('heading', { name: '项目设置' }).waitFor();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await currentLayer().getByRole('heading', { name: '隐藏的项目', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '返回「组织」', exact: true }).count(), 1);
    assert.equal(await rail().isVisible(), true);
  });
  await setup({ width: 1040, longInbox: true });
  await test('wide detail remains in view at the bottom while the rail shares the home scroll', async () => {
    await row('页面交付').scrollIntoViewIfNeeded();
    const layer = page.locator('.home-layer');
    const old = await layer.evaluate(e => e.scrollTop);
    assert.ok(old > 0);
    await row('页面交付').click();
    await currentLayer().getByRole('button', { name: '任务详情' }).waitFor();
    assert.equal(await layer.evaluate(e => e.scrollTop), old);
    assert.equal(await rail().evaluate(e => e.scrollHeight <= e.clientHeight + 1), true);
    const pane = await page.locator('.wide-pane').boundingBox();
    const top = await page.locator('.top').boundingBox();
    assert.ok(pane.y >= top.y + top.height && pane.y + pane.height <= 900);
    assert.equal(await currentLayer().evaluate(e => e.scrollHeight > e.clientHeight), true);
    await back();
    assert.equal(await layer.evaluate(e => e.scrollTop), old);
    assert.equal(await row('页面交付').evaluate(e => e === document.activeElement), true);
  });
  await setup({ twoWaitingAgents: true });
  await test('agent inline detail and one-click actions use the exact terminal or workspace', async () => {
    await rail().getByRole('button', { name: '去回答', exact: true }).first().click();
    await page.getByRole('status').filter({ hasText: '已打开会话' }).waitFor();
    await row('等待设计决定').click();
    assert.equal(await rail().getByText('这里暂不能查看或回答聊天问题，请在打开的会话里回答。', { exact: true }).count(), 1);
    await rail().getByRole('button', { name: '打开会话去回答', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => fixture.hostCalls), [
      { method: 'terminal.focus', terminalId: 'term-need' }, { method: 'workspace.open', workspaceId: 'identity:chat-workspace' }
    ]);
  });
  for (const [width, versionLabel] of [[320, '版本 v1.2.34'], [1040, '版本未知']]) {
    await setup({ width, versionLabel });
    await test(`settings shows ${versionLabel} at ${width}px`, async () => {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const label = currentLayer().getByText(versionLabel, { exact: true });
      await (await label.elementHandle()).waitForElementState('stable');
      const box = await label.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= page.viewportSize().height);
    });
  }
  await setup({ width: 320 });
  await test('settings five sections fit 320 and unsaved forms return immediately with continue editing', async () => {
    for (const [label, start, end] of [['刷新', 'M3 12a9 9', 'M8 16H3v5'], ['设置', 'M9.671 4.136', 'M15 12a3 3 0 1 0-6 0 3 3 0 1 0 6 0Z']]) {
      const button = page.locator('.top').getByRole('button', { name: label, exact: true });
      assert.equal(await button.getAttribute('title'), label);
      assert.equal(await button.getAttribute('aria-label'), label);
      const svg = button.locator('svg');
      const graphic = await svg.locator('path').getAttribute('d');
      assert.ok(graphic.startsWith(start) && graphic.endsWith(end));
      assert.equal(await svg.getAttribute('stroke-width'), '2');
      assert.equal((await svg.boundingBox()).width, 14);
    }
    if (process.env.PANEL_EVIDENCE_DIR) await page.locator('.top').screenshot({ path: path.join(process.env.PANEL_EVIDENCE_DIR, 'toolbar.png'), animations: 'disabled' });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    for (const name of ['主 agent', '外部连接', '工作间连接', '机器', '隐藏的项目']) {
      const section = currentLayer().getByRole('region', { name, exact: true });
      const heading = section.locator(':scope > .sec-h > h2');
      assert.equal(await heading.innerText(), name);
      if (name === '主 agent') {
        const manage = section.getByRole('button', { name: '管理主 agent', exact: true });
        assert.equal(await section.getByText('主 agent', { exact: true }).count(), 1);
        assert.equal(await section.locator('.sec-h button').count(), 0);
        assert.ok((await manage.boundingBox()).y >= (await heading.boundingBox()).y + (await heading.boundingBox()).height);
      }
    }
    assert.equal(await currentLayer().evaluate(e => e.scrollWidth <= e.clientWidth), true);
    if (process.env.PANEL_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.PANEL_EVIDENCE_DIR, 'settings-320.png'), animations: 'disabled' });
    await currentLayer().getByRole('button', { name: '工作间 free', exact: true }).click();
    await currentLayer().getByRole('button', { name: '改关系', exact: true }).click();
    await currentLayer().getByRole('radio', { name: '上级 · 画在你上面' }).check();
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })));
    assert.equal(await currentLayer().getByRole('radio', { name: '上级 · 画在你上面' }).isChecked(), true);
    await page.keyboard.press('Escape');
    await currentLayer().getByRole('button', { name: '改关系', exact: true }).waitFor();
    await page.getByRole('button', { name: '继续编辑' }).click();
    assert.equal(await currentLayer().getByRole('radio', { name: '上级 · 画在你上面' }).isChecked(), true);
  });
  await setup({ width: 1040, inboxBatch: true });
  await test('inbox shows read-only overview details while loading and ignores an older selection', async () => {
    await page.evaluate(() => { fixture.delayProject = 'p1'; });
    await row('页面交付').click();
    await currentLayer().getByText('成果 a1', { exact: true }).waitFor();
    assert.equal(await currentLayer().getByRole('button').count(), 0);
    assert.ok(await currentLayer().getByRole('status').isVisible());
    await row('移动端交付').click();
    await currentLayer().getByText('成果 b1', { exact: true }).waitFor();
    await page.evaluate(() => fixture.finishRead());
    assert.equal(await page.locator('.pane-top h2').innerText(), '移动端交付');
    assert.equal(await currentLayer().getByText('成果 a1', { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.name === 'project.read').length), 0);
    await back(); await page.evaluate(() => { fixture.failRead = 'p1'; });
    await page.locator('[data-project=p1] .pcard-h').click();
    await currentLayer().getByRole('alert').getByText('模拟读取错误').waitFor();
    await currentLayer().getByRole('button', { name: '重试' }).click();
    await currentLayer().getByRole('tab', { name: '待处理' }).waitFor();
  });
  for (const age of [1, 31]) {
    await setup({ stored: { 'panel.home': { at: Date.now() - age * 60000, pages: [{ kind: 'home' }, { kind: 'project', projectId: 'p1' }], tabs: {p1: 'tasks'} } } });
    await test(`reopen after ${age} minutes uses the recent page only`, async () => {
      if (age === 1) await currentLayer().getByRole('tab', { name: '任务', selected: true }).waitFor();
      else await page.getByRole('heading', { name: '组织', exact: true }).waitFor();
    });
  }
  await setup({ projectLead: true });
  await test('project main session opens once and project settings retain switch and cancel', async () => {
    await project();
    await currentLayer().getByText('Claude · 当前设计会话 · 在线 · 备用正在启动', { exact: true }).waitFor();
    await currentLayer().getByRole('button', { name: '打开会话', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '点一下主会话的标签' }).waitFor();
    await page.getByRole('button', { name: '项目设置', exact: true }).click();
    await currentLayer().getByText('当前主会话', { exact: true }).waitFor();
    await currentLayer().getByRole('button', { name: '换成它', exact: true }).first().click();
    await currentLayer().getByText(/正在等 编码会话/).waitFor();
    await currentLayer().getByRole('button', { name: '取消', exact: true }).click();
    await currentLayer().getByText(/正在等 编码会话/).waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.name === 'project.openMain').length), 1);
  });
  await setup({ projectLead: true });
  await test('backup lead and dated handover are visible in the project card and settings', async () => {
    await page.evaluate(() => { fixture.project.backup = { primary: fixture.project.activeSession.handle, handle: 'backup-test', agent: 'codex', phase: 'active', history: [{ at: Date.now(), text: '备用已接管原 Run' }] }; fixture.emit(); });
    await project();
    await currentLayer().getByText(/备用 Codex · 处理中 · 当前备用负责/).waitFor();
    await page.getByRole('button', { name: '项目设置', exact: true }).click();
    await currentLayer().getByRole('button', { name: /接管记录/ }).click();
    await currentLayer().getByText('备用已接管原 Run', { exact: false }).waitFor();
  });
  await setup({ projectUnbound: true });
  await test('unbound project keeps create and bind in the header and empty inbox', async () => {
    await page.getByRole('button', { name: /^还没有任务的项目/ }).click();
    await project();
    await currentLayer().getByText('这个项目还没有主会话', { exact: true }).waitFor();
    assert.equal(await currentLayer().getByRole('button', { name: '新建主会话', exact: true }).count(), 2);
    assert.equal(await currentLayer().getByRole('button', { name: '绑定已有会话', exact: true }).count(), 2);
    await currentLayer().getByRole('button', { name: '绑定已有会话', exact: true }).first().click();
    await currentLayer().getByRole('heading', { name: '在线会话', exact: true }).waitFor();
  });
  await test('unavailable saved roles require an explicit replacement from the workspace catalog', async () => {
    await setup({ availableAgents: [{ id: 'antigravity', name: 'Antigravity', default: true }] });
    await project();
    await page.getByRole('button', { name: '项目设置', exact: true }).click();
    const layer = currentLayer(), save = layer.getByRole('button', { name: '保存', exact: true });
    assert.equal(await layer.getByLabel('新会话代理', { exact: true }).inputValue(), '');
    assert.equal(await layer.getByLabel('备用代理', { exact: true }).inputValue(), 'antigravity');
    assert.equal(await layer.getByRole('button', { name: '新开一个主会话', exact: true }).isDisabled(), true);
    assert.equal(await save.isDisabled(), true);
    for (const label of ['设计', '代码', '审查']) {
      const picker = layer.getByLabel(label, { exact: true });
      assert.equal(await picker.inputValue(), '');
      await picker.selectOption('antigravity');
    }
    await save.click();
    await page.waitForFunction(() => fixture.project.roles.review === 'antigravity');
    assert.deepEqual(await page.evaluate(() => fixture.project.roles), { design: 'antigravity', code: 'antigravity', review: 'antigravity' });
  });
  await test('project lead preferences save only the chosen agents', async () => {
    await setup({ projectLead: true });
    await page.evaluate(() => { fixture.project.leadAgents = { primary: { agent: 'codex' }, backup: { agent: 'antigravity' } }; });
    await project();
    await page.getByRole('button', { name: '项目设置', exact: true }).click();
    const layer = currentLayer(), primary = layer.getByLabel('默认主用', { exact: true }), backup = layer.getByLabel('备用代理', { exact: true });
    assert.equal(await primary.inputValue(), 'codex');
    assert.equal(await backup.inputValue(), 'antigravity');
    const save = layer.getByRole('button', { name: '保存主会话设置', exact: true });
    await primary.selectOption('antigravity');
    assert.equal(await save.isDisabled(), true);
    await backup.selectOption('codex');
    await save.click();
    await page.waitForFunction(() => fixture.project.leadAgents?.primary.agent === 'antigravity');
    assert.deepEqual(await page.evaluate(() => fixture.calls.find(c => c.name === 'project.settings').input.leadAgents),
      { primary: { agent: 'antigravity' }, backup: { agent: 'codex' } });
  });
  await test('an offline primary lets its acting backup become primary and keeps the Run', async () => {
    await setup({ projectLead: true, projectBackupRecovery: true });
    await project();
    await page.getByRole('button', { name: '项目设置', exact: true }).click();
    const layer = currentLayer(), promote = layer.getByRole('button', { name: '将当前代管备用转正为主会话', exact: true });
    const backup = layer.getByLabel('备用代理', { exact: true }), save = layer.getByRole('button', { name: '保存主会话设置', exact: true });
    await backup.waitFor();
    assert.equal(await promote.count(), 0);
    await page.evaluate(() => { fixture.project.activeSession.online = 'offline'; fixture.emit(); });
    await promote.waitFor();
    await layer.getByLabel('默认主用', { exact: true }).selectOption('antigravity');
    await backup.selectOption('codex');
    await save.click();
    await page.waitForFunction(() => fixture.project.leadAgents?.backup.agent === 'codex');
    assert.equal(await page.evaluate(() => fixture.project.backup.phase), 'active');
    const runId = await page.evaluate(() => fixture.project.runId);
    await page.evaluate(() => { fixture.delayProjectSwitch = true; });
    await promote.click();
    await page.waitForFunction(() => !!fixture.finishProjectSwitch);
    assert.equal(await promote.isDisabled(), true);
    await page.evaluate(() => fixture.finishProjectSwitch());
    await promote.waitFor({ state: 'hidden' });
    await layer.getByText(/Antigravity · 代管会话 · 在线/).waitFor();
    assert.equal(await page.evaluate(() => fixture.project.runId), runId);
    assert.equal(await page.evaluate(() => fixture.calls.find(c => c.name === 'project.lead' && c.input.mode).input.mode), 'promote');
  });
  await test('legacy Codex lead shows its inherited backup without blocking primary preferences', async () => {
    await setup({ legacyCodexLead: true });
    await project();
    await page.getByRole('button', { name: '项目设置', exact: true }).click();
    const layer = currentLayer(), primary = layer.getByLabel('默认主用', { exact: true }), backup = layer.getByLabel('备用代理', { exact: true });
    const save = layer.getByRole('button', { name: '保存主会话设置', exact: true });
    assert.equal(await primary.inputValue(), 'antigravity');
    assert.equal(await backup.inputValue(), 'antigravity');
    assert.equal(await layer.getByText('主用与备用需要选择不同的代理', { exact: true }).count(), 0);
    await primary.selectOption('claude');
    await backup.selectOption('codex');
    assert.equal(await save.isDisabled(), true);
    await backup.selectOption('antigravity');
    await save.click();
    await page.waitForFunction(() => fixture.project.leadAgents?.primary.agent === 'claude');
    assert.deepEqual(await page.evaluate(() => fixture.project.leadAgents), { primary: { agent: 'claude' } });
  });
  await test('waiting project offers only cancellation in both lead views and restores actions after cancellation or expiry', async () => {
    await setup({ projectUnbound: true, clock: true, backupAgent: 'codex' });
    await page.getByRole('button', { name: /^还没有任务的项目/ }).click();
    await project();
    await page.getByRole('button', { name: '项目设置', exact: true }).click();
    const layer = currentLayer(), cancel = layer.getByRole('button', { name: '取消', exact: true });
    for (const label of ['新会话代理', '设计', '代码', '审查']) {
      assert.deepEqual(await layer.getByLabel(label, { exact: true }).locator('option').allTextContents(), ['Claude', 'Codex', 'Antigravity']);
    }
    const create = () => layer.getByRole('button', { name: '新开一个主会话', exact: true }).click();
    const checkWaiting = async () => {
      await layer.getByText(/正在等 新的 codex 会话 接管，还剩 \d+ 分钟/i).waitFor();
      await layer.getByText('接管后会自动配一个 Codex 备用', { exact: true }).waitFor();
      assert.equal(await cancel.count(), 1);
      assert.equal(await layer.getByText(/还没有主会话/).count(), 0);
      assert.equal(await layer.getByRole('button', { name: /新建主会话|绑定已有会话|新开一个主会话|换成它/ }).count(), 0);
    };
    await create();
    await checkWaiting();
    await page.evaluate(() => { fixture.delayProject = 'p1'; });
    await back();
    await checkWaiting();
    await page.waitForFunction(() => !!fixture.finishRead);
    await page.evaluate(() => fixture.finishRead());
    await cancel.click();
    await layer.getByText('这个项目还没有主会话').waitFor();
    assert.equal(await layer.getByRole('button', { name: '绑定已有会话' }).first().isEnabled(), true);
    await layer.getByRole('button', { name: '新建主会话' }).first().click();
    await create();
    await checkWaiting();
    await back();
    await page.evaluate(() => {
      delete fixture.project.takeover.backupAgent;
      fixture.project.takeover.expiresAt = new Date(Date.now() + 60000).toISOString();
      fixture.emit();
    });
    await layer.getByText(/接管后会自动配/).waitFor({ state: 'hidden' });
    await cancel.waitFor();
    await page.clock.fastForward(90000);
    await layer.getByText('这个项目还没有主会话').waitFor();
    await layer.getByRole('button', { name: '新建主会话' }).first().click();
    await layer.getByRole('button', { name: '新开一个主会话' }).waitFor();
    await layer.getByRole('button', { name: '换成它' }).first().waitFor();
  });
  await test('bound project displays backup startup through the opening phase', async () => {
    await setup({ projectLead: true });
    await project();
    const card = currentLayer().locator('.project-lead');
    await card.getByText(/备用正在启动/).waitFor();
    for (const phase of ['unavailable', 'opening']) {
      await home();
      await page.evaluate(phase => { fixture.project.backup = { agent: 'codex', phase, history: [] }; }, phase);
      await project();
      await card.getByText(/主用 Claude.*备用正在启动/).waitFor();
      assert.equal(await card.getByText(/没有备用/).count(), 0);
    }
  });
  await setup();
  await test('workspace error after opening is visible and a removed workspace disables the action', async () => {
    await project();
    await page.evaluate(() => { fixture.openError = '无法打开'; fixture.workspaceTarget = { error: '这个项目当前没有工作区' }; });
    await currentLayer().getByRole('button', { name: '打开会话', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '无法打开' }).waitFor();
    assert.equal(await currentLayer().getByRole('button', { name: '打开会话', exact: true }).isDisabled(), true);
  });
  await setup({ width: 1040 });
  await test('reduced motion disables all motion while rows and pages still open', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openReview();
    assert.equal(await page.locator('#panel').evaluate(e => e.getAnimations({ subtree: true }).length), 0);
    await page.getByRole('button', { name: '任务详情', exact: true }).click();
    await currentLayer().getByRole('heading', { name: '要你处理' }).waitFor();
    assert.equal(await page.locator('#panel').evaluate(e => e.getAnimations({ subtree: true }).length), 0);
  });
  await test('Run questions and worker reports never enter the owner inbox', async () => {
    for (const width of [400, 1160]) {
      await setup({ width, ownerQuestion: true, ownerReport: true,
        stored: { 'panel.home': { at: Date.now(), pages: [{ kind: 'home' }, { kind: 'question', projectId: 'p1', id: 'msg_report' }] } } });
      const privateRows = page.locator('.irow').filter({ hasText: /请登录测试面板|页面已交付/ });
      assert.equal(await privateRows.count(), 0);
      assert.equal(await page.locator('.pane').count(), 0);
      const workspace = page.getByRole('button', { name: /我的工作间/ }).first();
      if (await workspace.getAttribute('aria-expanded') === 'false') await workspace.click();
      await page.getByRole('button', { name: /示例项目/ }).first().click();
      await page.locator('.pane .irow').filter({ hasText: '页面交付' }).waitFor();
      assert.equal(await privateRows.count(), 0);
    }
  });
  if (hasMockup) await test('v8 mockup pages open in a headless browser', async () => {
    page = await browser.newPage(); page.on('pageerror', e => errors.push(e.message));
    for (const kind of ['home', 'project', 'task', 'project-settings', 'settings', 'main', 'connections', 'connection', 'add-connection', 'links', 'machines', 'agents', 'peer', 'peer-project', 'relation']) {
      const params = new URLSearchParams({ page: kind, id: ['connection'].includes(kind) ? 'hermes' : ['task'].includes(kind) ? 't1' : ['relation'].includes(kind) ? 'out' : 'ops', project: 'web', pid: 'ox0' });
      await page.goto(pathToFileURL(mockup).href + '#' + params); await page.locator('#panel').waitFor();
    }
  });
  else console.log('SKIP v8 mockup pages: private docs/design/workspace-mockup-v8.html is absent');
  await test('工作间旧接管期间暂停切换，且没有重开备用操作', async () => {
    await setup({ width: 400 });
    await page.evaluate(() => { fixture.workspace.backup = { phase: 'returning', history: [], cycle: 'c', agent: 'codex' }; fixture.emit(); });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '管理主 agent', exact: true }).click();
    await currentLayer().getByText(/原接管正在处理/).waitFor();
    assert.equal(await currentLayer().getByRole('button', { name: '重新开备用' }).count(), 0);
    assert.equal(await currentLayer().getByRole('button', { name: '新开一个主 agent' }).isDisabled(), true);
    await page.evaluate(() => { delete fixture.workspace.backup; fixture.emit(); });
    await currentLayer().getByText(/原接管正在处理/).waitFor({ state: 'detached' });
    assert.equal(await currentLayer().getByRole('button', { name: '新开一个主 agent' }).isEnabled(), true);
  });
  for (const unbound of [true, false]) {
    await setup({ unbound, emptyBots: unbound, width: 300 });
    await test(`main agent one-click ${unbound ? 'set' : 'replace'}, pending cancel/reselect, expiry/failure and new Claude/Codex`, async () => {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: '管理主 agent', exact: true }).click();
      const action = unbound ? '设为主 agent' : '换成它';
      assert.equal(await page.getByRole('checkbox').count(), 0);
      await currentLayer().getByRole('button', { name: '新开一个主 agent' }).waitFor();
      assert.equal(await page.getByLabel('切换方式', { exact: true }).count(), 0);
      assert.equal(await currentLayer().getByLabel('Bot', { exact: true }).count(), 0);
      await page.evaluate(() => { fixture.delaySwitch = true; });
      await page.getByRole('button', { name: action, exact: true }).nth(0).click();
      await page.getByText('等待接管绑定 · 甲会话，还剩 10 分钟', { exact: true }).waitFor();
      if (unbound) {
        await currentLayer().getByText(/在 Orca 左侧 Bots 点 ＋ → New bot → Start from scratch/).waitFor();
        assert.equal(await page.getByRole('button', { name: '刷新', exact: true }).count(), 1);
      }
      assert.equal(await page.getByRole('button', { name: action, exact: true }).nth(1).isEnabled(), true);
      assert.equal(await page.getByRole('button', { name: '取消', exact: true }).isEnabled(), true);
      await page.getByRole('button', { name: action, exact: true }).nth(1).click();
      await page.getByText('等待接管绑定 · 乙会话，还剩 10 分钟', { exact: true }).waitFor();
      await page.evaluate(() => fixture.finishSwitch());
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await page.getByRole('button', { name: '取消', exact: true }).waitFor({ state: 'detached' });
      await page.getByRole('button', { name: '新开一个主 agent', exact: true }).click();
      await page.getByText('等待接管绑定 · 新的 claude 会话，还剩 10 分钟', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Agent', { exact: true }).inputValue(), 'claude');
      await page.getByLabel('Agent', { exact: true }).selectOption('codex');
      await page.getByRole('button', { name: '新开一个主 agent', exact: true }).click();
      await page.getByText('等待接管绑定 · 新的 codex 会话，还剩 10 分钟', { exact: true }).waitFor();
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
    assert.equal(await page.locator('.home>.inbox,.home>.organization').count(), 2);
    assert.equal(await page.locator('[data-workspace=self]').count(), 1);
    assert.equal(await page.locator('.inbox .pill').innerText(), '2');
    assert.equal(await page.locator('[data-workspace=self] .wsr-top .pill').innerText(), '2');
    assert.equal(await page.locator('[data-workspace=pending]').count(), 0);
    assert.equal(await page.locator('.org-up [data-workspace=up],.org-kids [data-workspace=down],.org-side [data-workspace=side]').count(), 3);
    assert.equal(await page.locator('[data-workspace=down] .flag').count(), 1);
    assert.equal(await page.locator('[data-workspace=off] .flag').count(), 0);
    assert.equal(await page.locator('.org-free [data-workspace=free]').count(), 1);
    assert.equal(await page.locator('.org-kids').evaluate(e => getComputedStyle(e.firstElementChild, '::before').borderLeftStyle), 'solid');
    assert.equal(await page.locator('.org-side').evaluate(e => getComputedStyle(e.firstElementChild, '::before').borderLeftStyle), 'dashed');
    await page.evaluate(() => {
      const report = fixture.links.peers.find(p => p.id === 'down').report; report.scope = 'summary'; delete report.mainAgent;
      for (const project of report.projects) { delete project.tasks; delete project.activity; }
      fixture.emit();
    });
    await page.waitForFunction(() => !document.querySelector('[data-workspace=down] .flag'));
  });
  await test('remote workspace shows connection and projects, readonly summary hides task details', async () => {
    await page.locator('[data-workspace=down] .wsr-h').click();
    const body = page.locator('[data-workspace=down] .wsr-b');
    assert.equal(await body.getByRole('heading').allTextContents().then(x => x.join(',')), '项目');
    assert.equal(await body.getByText(/已连接/).count(), 1);
    assert.equal(await body.getByText('对方只开放了项目摘要，看不到 agent', { exact: true }).count(), 1);
    assert.equal(await body.getByRole('button', { name: '派活', exact: true }).count(), 0);
    assert.equal(await body.getByText('主 agent', { exact: true }).count(), 0);
    await body.getByRole('button', { name: '开放的项目' }).click();
    assert.equal(await currentLayer().locator('input,textarea').count(), 0); assert.equal(await page.getByText('受阻任务', { exact: true }).count(), 0);
    await home();
  });
  await setup({ width: 1040 });
  await test('remote details reuse local main and project cards and show read-only live agents', async () => {
    const own = page.locator('[data-workspace=self] .wsr-b');
    const node = page.locator('[data-workspace=down]'), body = node.locator('.wsr-b');
    await node.locator('.wsr-h').click();
    const structure = target => target.locator('.lead, .pcard, .pcard-h, .pcard-b, .arow').evaluateAll(nodes => [...new Set(nodes.map(n => n.className))]);
    assert.deepEqual(await structure(body), await structure(own));
    await body.locator('.lead').getByText('Codex · 对方统筹会话 · 工作中 · 5 分钟前开始', { exact: true }).waitFor();
    await body.locator('.pcard .arow').getByText('工作中 · 3 分钟前开始', { exact: true }).waitFor();
    assert.equal(await body.getByText('✓ 已完成 1 个', { exact: true }).count(), 1);
    assert.equal(await body.getByText('agent 未全部列出', { exact: true }).count(), 1);
    for (const name of ['全部 agent', '打开主会话', '设为主 agent', '外部连接', '主 agent']) {
      assert.equal(await body.getByRole('button', { name, exact: true }).count(), 0);
    }
    assert.equal(await body.getByText('外部连接', { exact: true }).count(), 0);
    if (process.env.PANEL_EVIDENCE_DIR) await node.screenshot({ path: path.join(process.env.PANEL_EVIDENCE_DIR, 'peer-details.png') });
    await body.getByRole('button', { name: '开放的项目', exact: true }).click();
    await currentLayer().getByRole('button', { name: '受阻任务', exact: true }).waitFor();
    await currentLayer().getByRole('tab', { name: 'Agent' }).click();
    await currentLayer().locator('.acol .aitem[data-st=work]').getByText('核对布局', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '打开会话', exact: true }).count(), 0);
    assert.equal(await currentLayer().locator('input,textarea').count(), 0);
    await home();
  });
  await setup();
  await test('connection keeps advanced settings collapsed; invite copies and join needs only a code', async () => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '邀请或加入', exact: true }).click();
    const invite = page.getByRole('button', { name: '邀请', exact: true }), join = page.getByRole('button', { name: '加入', exact: true });
    const advanced = page.getByRole('button', { name: '高级', exact: true }).locator('..');
    assert.equal(await advanced.locator('.fold-h').getAttribute('aria-expanded'), 'false');
    for (const label of ['监听 IP', '端口', '访问地址', 'TLS', 'TLS 证书', 'TLS 私钥']) assert.equal(await advanced.getByLabel(label, { exact: true }).isVisible(), false);
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
    assert.equal(await advanced.locator('.fold-h').getAttribute('aria-expanded'), 'false');
    await advanced.locator('.fold-h').click();
    assert.equal(await advanced.getByLabel('监听 IP', { exact: true }).inputValue(), '100.64.0.42');
    assert.equal(await advanced.getByLabel('端口', { exact: true }).inputValue(), '43123');
    await advanced.locator('.fold-h').evaluate(summary => {
      summary.click();
      const input = document.querySelector('[data-focus="对方的连接码"]');
      input.value = '  AB1.fixture  ';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await join.click();
    await page.getByRole('status').filter({ hasText: '已加入工作间' }).waitFor();
    assert.deepEqual(await page.evaluate(() => fixture.calls.filter(c => c.name === 'workspace.links').map(c => c.input)), [
      { operation: 'invite' }, { operation: 'join', code: 'AB1.fixture' }
    ]);
    assert.equal(await advanced.locator('.fold-h').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#panel').evaluate(e => e.scrollWidth <= e.clientWidth), true);
  });
  await setup();
  await test('disconnect removes only the selected workspace from the connection list', async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const list = page.getByRole('region', { name: '工作间连接', exact: true });
    const disconnected = list.getByRole('button', { name: '工作间 down', exact: true });
    await disconnected.click();
    await page.getByRole('checkbox', { name: '确认断开这个工作间', exact: true }).check();
    await page.getByRole('button', { name: '断开连接', exact: true }).click();
    await list.getByRole('button', { name: '工作间 side', exact: true }).waitFor();
    assert.equal(await disconnected.count(), 0);
    assert.deepEqual(await page.evaluate(() => fixture.calls.filter(c => c.name === 'workspace.links').map(c => c.input)), [{ operation: 'revoke', id: 'down' }]);
  });
  await setup({ width: 1040, delegatedFeedback: true, peerProjectPage: true });
  await test('peer project shares local tabs and inbox, respects read-only and offline reports, and submits delegated feedback', async () => {
    const tabs = () => currentLayer().getByRole('tab');
    const tab = name => currentLayer().getByRole('tab', { name, exact: true });
    const shot = async state => {
      if (process.env.PANEL_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.PANEL_EVIDENCE_DIR, 'peer-project-' + state + '.png'), animations: 'disabled' });
    };
    await project();
    const tabStructure = () => tabs().evaluateAll(nodes => nodes.map(n => [n.className, n.textContent.replace(/[0-9]/g, ''), !!n.querySelector('.n')]));
    const localTabs = (await tabStructure()).slice(0, 3);
    const leadStyle = await currentLayer().locator('.project-lead').getAttribute('class');
    await home();
    await review('对方页面交付 · 对方示例项目 · 工作间 up').waitFor();
    const up = page.locator('[data-workspace=up]');
    await up.locator('.wsr-h').click();
    await up.getByRole('button', { name: '对方示例项目', exact: true }).click();
    assert.deepEqual((await tabStructure()).slice(0, 3), localTabs);
    assert.equal(await currentLayer().locator('.project-lead').getAttribute('class'), leadStyle);
    assert.deepEqual(await tabs().allTextContents(), ['待处理4', '任务3', 'Agent3', '成果2']);
    await tab('成果').click();
    const artifacts = currentLayer().getByRole('tabpanel');
    assert.equal(await artifacts.getByText('设计原稿 · v1', { exact: true }).count(), 1);
    assert.equal(await artifacts.getByRole('button', { name: /旧版本|标为过期/ }).count(), 0);
    await artifacts.getByRole('button', { name: '设计原稿 · v1' }).click({ button: 'right' });
    assert.equal(await page.getByRole('menu', { name: '成果操作' }).count(), 0);
    const openFile = async (name, type, data) => {
      await page.evaluate(f => { fixture.peerFile = f; }, { name, type, data });
      await artifacts.getByRole('button', { name: '设计原稿 · v1' }).click();
      return page.getByRole('dialog', { name: '设计原稿 · v1' });
    };
    await page.evaluate(() => { fixture.delayArtifact = true; });
    const image = await openFile('design.png', 'image/png', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a82kAAAAASUVORK5CYII=');
    await image.getByRole('status').filter({ hasText: '分块传输 1.2/3.1 MB' }).waitFor();
    await page.evaluate(() => { fixture.peerFile.method = 'chunks'; fixture.delayArtifact = false; fixture.finishArtifact(); });
    await image.getByRole('status').filter({ hasText: /^分块传输$/ }).waitFor();
    await image.getByRole('img').waitFor();
    await page.waitForFunction(() => document.querySelector('dialog img')?.naturalWidth === 1);
    await image.getByRole('button', { name: '关闭' }).click();
    const svg = await openFile('design.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><circle r="2"/></svg>').toString('base64'));
    await page.waitForFunction(() => document.querySelector('dialog img')?.naturalWidth === 4);
    assert.equal(await svg.locator('svg, iframe, object').count(), 0);
    await svg.getByRole('button', { name: '关闭' }).click();
    const markdown = '# 设计说明\n<em>原文</em>';
    const doc = await openFile('design.md', 'text/markdown', Buffer.from(markdown).toString('base64'));
    assert.equal(await doc.getByRole('status').textContent(), '整文件直传');
    assert.equal(await doc.locator('pre').textContent(), markdown);
    assert.equal(await doc.locator('em').count(), 0);
    await doc.getByRole('button', { name: '关闭' }).click();
    const html = '<h1>文档</h1>', source = Buffer.from(html).toString('base64');
    const download = await openFile('design.html', 'application/octet-stream', source);
    await download.getByRole('button', { name: '保存到本机' }).click();
    assert.deepEqual(await page.evaluate(() => fixture.calls.filter(c => c.name === 'files.saveAs').at(-1).input), { suggestedName: 'design.html', data: html });
    assert.equal(await download.locator('iframe, object, embed, pre, img, canvas, h1').count(), 0);
    await download.getByRole('button', { name: '关闭' }).click();
    const pdfData = await fs.readFile(new URL('./panel-jpeg2000-fixture.pdf', import.meta.url));
    const pdf = await openFile('design.pdf', 'application/pdf', pdfData.toString('base64'));
    // A missing decoder can still produce a full-size white canvas.
    await page.waitForFunction(() => {
      const pixel = document.querySelector('dialog canvas')?.getContext('2d').getImageData(30, 30, 1, 1).data;
      return pixel && pixel[0] === 31 && pixel[1] === 211 && pixel[2] === 94;
    });
    await pdf.getByRole('button', { name: '关闭' }).click();
    await page.evaluate(() => { fixture.artifactError = '对方离线，暂时无法获取成果'; });
    await artifacts.getByRole('button', { name: '设计原稿 · v1' }).click();
    const offline = page.getByRole('dialog');
    await offline.getByRole('status').filter({ hasText: '对方离线' }).waitFor();
    assert.equal(await offline.getByRole('alert').count(), 0);
    await page.evaluate(() => { delete fixture.artifactError; });
    await offline.getByRole('button', { name: '重试' }).click();
    await page.getByRole('dialog').locator('canvas').waitFor();
    await page.getByRole('button', { name: '关闭', exact: true }).last().click();
    await artifacts.getByRole('button', { name: '网页预览 · v1' }).click();
    assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.name === 'shell.openExternal').at(-1).input), 'https://example.com/preview');
    await currentLayer().getByText('来自「工作间 up」，可代为处理').waitFor();
    await tab('任务').click();
    assert.deepEqual(await currentLayer().locator('.item .body .xs').allTextContents(), ['待验收', '待决定', '待验收']);
    assert.doesNotMatch(await currentLayer().innerText(), /ready|working/);
    await tab('Agent').click();
    assert.equal(await currentLayer().locator('.acol').count(), 3);
    await tab('待处理').click();
    const check = currentLayer().getByRole('checkbox', { name: /选择验收 · 对方页面交付/ });
    await page.evaluate(() => {
      const peer = fixture.links.peers[0];
      fixture.originalFeedback = peer.report.projects[0].feedback;
      delete peer.report.projects[0].feedback;
      fixture.emit();
    });
    await currentLayer().getByText('对方未开放代为处理').waitFor();
    assert.equal(await check.isDisabled(), true);
    assert.equal(await currentLayer().getByRole('button', { name: '全选验收' }).count(), 0);
    assert.equal(await review('对方页面交付').count(), 0);
    await currentLayer().getByRole('button', { name: '对方页面交付', exact: true }).click();
    await currentLayer().locator('.irow.open .irow-b').getByText('成果 remote-a').waitFor();
    await shot('readonly');
    await page.evaluate(() => { fixture.links.peers[0].report.feedbackTruncated = true; fixture.emit(); });
    await currentLayer().getByText(/超过同步上限/).waitFor();
    await page.evaluate(() => {
      const peer = fixture.links.peers[0];
      delete peer.report.feedbackTruncated;
      peer.report.projects[0].feedback = fixture.originalFeedback;
      fixture.emit();
    });
    await currentLayer().getByRole('button', { name: '全选验收' }).click();
    assert.equal(await check.isChecked(), true);
    await currentLayer().getByRole('button', { name: '对方页面交付', exact: true }).click();
    await currentLayer().getByRole('button', { name: '丢弃', exact: true }).click();
    await currentLayer().getByRole('textbox', { name:'丢弃原因（选填）' }).fill('已换新版');
    await shot('delegated');
    await page.evaluate(() => {
      const peer = fixture.links.peers[0]; fixture.connectedReport = peer.report;
      peer.offlineFeedback = peer.report.projects.map(({ id, name, feedback }) => ({ id, name, feedback }));
      delete peer.report; peer.status = 'offline'; fixture.emit();
    });
    await currentLayer().getByText('「工作间 up」离线，暂不能提交', { exact: true }).first().waitFor();
    assert.deepEqual(await tabs().allTextContents(), ['待处理3']);
    assert.equal(await check.isDisabled(), true);
    assert.equal(await dock().getByRole('button', { name: '提交 2 条' }).isDisabled(), true);
    await shot('offline');
    await page.evaluate(() => {
      const peer = fixture.links.peers[0]; peer.report = fixture.connectedReport; delete peer.offlineFeedback;
      peer.status = 'connected'; fixture.emit();
    });
    await dock().getByRole('button', { name: '提交 2 条' }).click();
    await page.getByRole('status').filter({ hasText: '已提交 2 条' }).waitFor();
    const writes = await page.evaluate(() => fixture.calls.filter(c => ['workspace.linkFeedback', 'project.feedback'].includes(c.name)));
    assert.deepEqual(writes.map(c => [c.name, c.input.id, c.input.projectId]), [['workspace.linkFeedback', 'up', 'p1']]);
    assert.deepEqual(writes[0].input.items.map(i => [i.taskId, i.result]), [['t1', 'discarded'], ['second', 'passed']]);
  });
  await setup({ width: 1040, delegatedFeedback: true, laggingReport: true });
  await test('delegated feedback uses the home inbox, one submit bar, and the original retry request', async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await currentLayer().getByRole('region', { name: '工作间连接', exact: true }).getByRole('button', { name: '工作间 up', exact: true }).click();
    const permission = currentLayer().getByRole('checkbox', { name: '允许对方代为处理' });
    const scope = currentLayer().getByLabel('开放范围', { exact: true });
    assert.equal(await permission.isEnabled(), false);
    await scope.selectOption('details');
    await permission.check();
    await currentLayer().getByText('对方能替你决定、验收和答复受阻项，提交后立即在本机生效。').waitFor();
    await currentLayer().getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
    assert.equal(await page.evaluate(() => fixture.calls.find(c => c.input?.operation === 'share').input.delegateFeedback), true);
    await scope.selectOption('summary');
    assert.equal(await permission.isEnabled(), false);
    assert.equal(await permission.isChecked(), false);
    await home();
    await page.evaluate(() => {
      const remote = fixture.links.peers[0].report.projects[0].feedback;
      remote.tasks.push({ id:'b', title:'对方等待补建', phase:'blocked', acceptance:[], decisions:[], artifacts:[] });
      fixture.emit();
    });
    await row('对方设计决定').click();
    assert.equal(await row('对方等待补建').count(), 0); // Older peers do not advertise a blocked revision.
    await currentLayer().getByRole('radio', { name: '浅色', exact: true }).check();
    await page.evaluate(() => {
      Object.assign(fixture.links.peers[0].report.projects[0].feedback.tasks.at(-1), {blockedRevision:3, progress:'请补建'});
      fixture.emit();
    });
    await row('对方等待补建').click();
    await currentLayer().getByRole('textbox', { name:'受阻备注' }).fill('已补建');
    await row('对方页面交付').click();
    await currentLayer().getByRole('button', { name: '打开成果 · 设计原稿', exact: true }).waitFor();
    await currentLayer().getByRole('button', { name: '打开成果 · 网页预览', exact: true }).click();
    const remoteRow = row('对方页面交付').locator('..');
    await remoteRow.getByText(/对方示例项目/).waitFor();
    await review('对方页面交付').check();
    await currentLayer().getByRole('textbox', { name: '通过留言（选填）' }).fill('按报告里的建议开始修改');
    await review('页面交付 · 示例项目').check();
    if (process.env.PANEL_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.PANEL_EVIDENCE_DIR, 'delegated-inbox.png'), animations: 'disabled' });
    await page.evaluate(() => {
      const peer = fixture.links.peers[0]; fixture.remoteReport = peer.report;
      peer.offlineFeedback = peer.report.projects; delete peer.report; peer.status = 'offline'; fixture.emit();
    });
    await dock().getByText('「工作间 up」离线，暂不能提交').waitFor();
    assert.equal(await dock().getByRole('button', { name: '提交 5 条' }).isEnabled(), false);
    assert.equal(await row('对方页面交付').isVisible(), true);
    await page.evaluate(() => {
      const peer = fixture.links.peers[0]; peer.report = fixture.remoteReport; delete peer.offlineFeedback; peer.status = 'connected'; fixture.emit();
    });
    await dock().getByRole('button', { name: '提交 5 条' }).click();
    await page.getByRole('status').filter({ hasText: '已提交 3 条' }).waitFor();
    const calls = await page.evaluate(() => fixture.calls.filter(c => ['project.feedback', 'workspace.linkFeedback'].includes(c.name)));
    const local = calls.filter(c => c.name === 'project.feedback'), remote = calls.filter(c => c.name === 'workspace.linkFeedback');
    assert.deepEqual(local.map(c => [c.input.projectId, c.input.items.length]), [['p1', 2]]);
    assert.deepEqual(remote.map(c => [c.input.projectId, c.input.items.length]), [['p1', 3], ['p1', 3]]);
    assert.deepEqual(remote[0].input.items.find(i => i.kind === 'blocked'), {taskId:'b', kind:'blocked', itemId:'b', itemRevision:3, note:'已补建'});
    assert.deepEqual(remote[0].input.items.find(i => i.kind === 'acceptance'), {taskId:'t1', kind:'acceptance', itemId:'remote-a', itemRevision:1,
      reviewTotal:1, result:'passed', note:'按报告里的建议开始修改', fingerprint:'version-1-remote-a'});
    assert.deepEqual(remote[0], remote[1]);
    assert.deepEqual(await page.evaluate(() => fixture.calls.find(c => c.name === 'shell.openExternal').input), 'https://example.com/preview');
  });
  const selectTwoPeerProjects = async () => {
    await setup({ width: 1040, delegatedFeedback: true, peerProjectPage: true, delayLinkReply: true });
    await page.evaluate(() => {
      const projects = fixture.links.peers[0].report.projects;
      const project = structuredClone(projects[0]);
      const title = '对方移动端交付';
      Object.assign(project, { id: 'p2', name: '对方移动项目', pending: 1, tasks: [{ ...project.tasks[0], title }] });
      project.feedback.tasks = [{ ...project.feedback.tasks[0], title }];
      projects.push(project);
      fixture.emit();
    });
    await review('对方页面交付').check();
    await review('对方移动端交付').check();
    await dock().getByRole('button', { name: '提交 2 条' }).click();
  };
  await test('batch claims and submits two projects on one peer in order', async () => {
    await selectTwoPeerProjects();
    const finish = async count => {
      await page.waitForFunction(() => !!fixture.finishLinkReply);
      const state = await page.evaluate(() => {
        const calls = fixture.calls.filter(c => c.name === 'workspace.linkFeedback').map(c => [c.input.id, c.input.projectId]);
        const claims = Object.entries(fixture.stored['panel.feedbackState']).filter(([, sheet]) => sheet.attempt?.checkingUntil).map(([id]) => id);
        fixture.finishLinkReply();
        return { calls, claims };
      });
      assert.deepEqual(state.calls, [['up', 'p1'], ['up', 'p2']].slice(0, count));
      assert.deepEqual(state.claims, [JSON.stringify(['up', 'p' + count])]);
    };
    await finish(1);
    await finish(2);
    await page.getByRole('status').filter({ hasText: '已提交 2 条' }).waitFor();
    assert.equal(await page.getByText('正在确认上次提交，请稍候').count(), 0);
  });
  await test('a timed-out project and a failed preflight share the batch alert', async () => {
    await selectTwoPeerProjects();
    await page.waitForFunction(() => !!fixture.finishLinkReply);
    await page.evaluate(() => {
      fixture.linkTimeout = true;
      fixture.overviewFailures = 10;
      delete fixture.links.peers[0].report.projects[1].feedback;
      fixture.finishLinkReply();
    });
    const alert = page.getByRole('alert');
    await alert.filter({ hasText: '「对方移动项目 · 工作间 up」未确认提交：项目已隐藏或读不到' })
      .filter({ hasText: '「对方示例项目 · 工作间 up」未确认提交：连接超时' }).waitFor();
    await alert.getByRole('button', { name: '关闭提示' }).click();
    await alert.waitFor({ state: 'hidden' });
  });
  let uncertainStorage;
  await setup({ width: 1040, delegatedFeedback: true });
  await test('dismissed timeout stays closed after refresh and reopen; offline attempts are never retried', async () => {
    await review('对方页面交付').check();
    await page.evaluate(() => { fixture.linkTimeout = true; fixture.links.peers[0].report.projects[0].feedback.revision = 7; });
    await dock().getByRole('button', { name: '提交 1 条' }).click();
    await page.waitForFunction(() => Object.values(fixture.stored['panel.feedbackState']).some(s => s.attempt?.autoChecked));
    await page.getByRole('button', { name: '关闭提示' }).click();
    await page.getByRole('alert').waitFor({ state: 'hidden' });
    await page.evaluate(() => fixture.emit());
    const stored = await page.evaluate(() => fixture.stored);
    const sheet = stored['panel.feedbackState']['["up","p1"]'];
    assert.equal(sheet.attempt.input.revision, 7);
    assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.name === 'workspace.linkFeedback').length), 2);
    delete sheet.attempt.autoChecked; // Reopen with a persisted timeout still due for its first check.
    uncertainStorage = stored;
    await setup({ width: 1040, delegatedFeedback: true, stored, offlinePeer: true });
    await dock().getByText('「工作间 up」离线，暂不能提交').waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.name === 'workspace.linkFeedback').length), 0);
  });
  await test('a newer complete report settles the original items without sending', async () => {
    await page.evaluate(() => {
      const peer = fixture.links.peers[0];
      peer.report = { projects: peer.offlineFeedback };
      const feedback = peer.report.projects[0].feedback;
      feedback.revision = 30;
      feedback.tasks = feedback.tasks.filter(t => t.id !== 't1');
      peer.status = 'connected'; fixture.emit();
    });
    await page.getByRole('status').filter({ hasText: '对方已处理' }).waitFor();
    assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.name === 'workspace.linkFeedback').length), 0);
    assert.equal(await page.evaluate(() => fixture.stored['panel.feedbackState']['["up","p1"]'].attempt), undefined);
  });
  await setup({ width: 1040, delegatedFeedback: true, stored: uncertainStorage, rejectLinkFeedback: true });
  await test('definitive rejection on reopen displays its reason after the old timeout was dismissed', async () => {
    await page.getByRole('alert').filter({ hasText: '项目已更新' }).waitFor();
    assert.equal(await page.evaluate(() => fixture.stored['panel.feedbackState']['["up","p1"]'].attempt.rejected), true);
  });
  await test('two reopened panels share one automatic check of a legacy attempt', async () => {
    const hub = await browser.newPage();
    await hub.addScriptTag({ content: draftModel + ';globalThis.fixtureDraftModel=draftModel;' });
    await hub.evaluate(sheets => { window.sheets = sheets; }, uncertainStorage['panel.feedbackState']);
    await setup({ delegatedFeedback: true, delayLinkReply: true, rejectLinkFeedback: true }, hub);
    const first = page;
    await first.waitForFunction(() => !!fixture.finishLinkReply);
    page = undefined;
    await setup({ delegatedFeedback: true }, hub);
    assert.equal(await dock().getByRole('button', { name: '提交 1 条' }).isDisabled(), true);
    assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.name === 'workspace.linkFeedback').length), 0);
    await first.evaluate(() => fixture.finishLinkReply());
    await first.getByRole('alert').filter({ hasText: '项目已更新' }).waitFor();
    assert.equal(await first.evaluate(() => fixture.calls.filter(c => c.name === 'workspace.linkFeedback').length), 1);
    await first.close(); await hub.close();
  });
  await setup();
  await test('workspace name saves independently of invalid network draft and updates the organization', async () => {
    await page.getByRole('button', { name: '＋ 连接', exact: true }).click();
    const advanced = page.getByRole('button', { name: '高级', exact: true }).locator('..');
    const name = page.getByLabel('工作间名称', { exact: true });
    assert.equal(await advanced.getByLabel('工作间名称', { exact: true }).count(), 0);
    assert.equal(await name.isVisible(), true);
    await advanced.locator('.fold-h').click();
    await advanced.getByLabel('监听 IP', { exact: true }).fill('invalid');
    await name.fill('更新后的工作间');
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '名称已保存' }).waitFor();
    assert.equal(await advanced.getByLabel('监听 IP', { exact: true }).inputValue(), 'invalid');
    assert.deepEqual(await page.evaluate(() => fixture.calls.filter(c => c.name === 'workspace.links').map(c => c.input)), [
      { operation: 'rename', revision: 1, name: '更新后的工作间' }
    ]);
    await home();
    await page.locator('[data-workspace=self]').getByText('更新后的工作间', { exact: true }).waitFor();
  });
  await setup();
  await test('relation suggestions are drafts, user edits survive relation switches, later relation preserves sharing', async () => {
    await page.locator('[data-workspace=free]').getByRole('button', { name: '标关系' }).click();
    await page.getByRole('radio', { name: '上级 · 画在你上面' }).check();
    assert.equal(await page.getByLabel('开放范围').inputValue(), 'summary');
    assert.equal(await page.getByText(/派活|往来请求/).count(), 0);
    assert.equal(await page.getByRole('checkbox', { name: '全部项目', exact: true }).isChecked(), true);
    assert.equal(await page.getByRole('checkbox', { name: '示例项目', exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => fixture.links.peers.find(p => p.id === 'free').relation), undefined);
    await page.getByLabel('开放范围').selectOption('details'); await page.getByRole('radio', { name: '下级 · 画在你下面' }).check();
    assert.equal(await page.getByLabel('开放范围').inputValue(), 'details');
    await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('heading', { name: '组织', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => fixture.links.peers.find(p => p.id === 'free').scope), 'details');
    assert.deepEqual(await page.evaluate(() => fixture.calls.find(c => c.input?.operation === 'share').input.projectIds), []);
    assert.equal(await page.evaluate(() => fixture.links.peers.find(p => p.id === 'free').allProjects), true);
    await page.locator('[data-workspace=free] .wsr-h').click(); await page.locator('[data-workspace=free]').getByRole('button', { name: '连接设置' }).click(); await page.getByRole('button', { name: '改关系', exact: true }).click();
    await page.getByRole('radio', { name: '平级 · 虚线相连' }).check(); assert.equal(await page.getByLabel('开放范围').count(), 0);
    await page.getByRole('button', { name: '保存', exact: true }).click(); await page.waitForFunction(() => fixture.links.peers.find(p => p.id === 'free').relation === 'peer');
    assert.equal(await page.evaluate(() => fixture.links.peers.find(p => p.id === 'free').scope), 'details');
    assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.input?.operation === 'share').length), 1);
  });
  await setup({ manyProjects: true });
  await test('all projects disables checked project options, summarizes the saved scope and restores previous checks', async () => {
    const node = page.locator('[data-workspace=free]');
    const openPeer = async () => {
      const settings = node.getByRole('button', { name: '连接设置' });
      if (!await settings.isVisible()) await node.locator('.wsr-h').click();
      await settings.click();
    };
    await openPeer();
    await page.getByLabel('开放范围').selectOption('summary');
    assert.equal(await page.getByText(/派活|往来请求/).count(), 0);
    const selectAll = page.getByRole('checkbox', { name: '全部项目', exact: true });
    const first = page.getByRole('checkbox', { name: '示例项目', exact: true });
    const second = page.getByRole('checkbox', { name: '项目 2', exact: true });
    await first.check();
    await selectAll.check();
    assert.deepEqual(await page.getByRole('region', { name: '开放哪些项目' }).locator('input[type=checkbox]').evaluateAll(inputs => inputs.slice(1).map(i => i.checked && i.disabled)), Array(14).fill(true));
    assert.equal(await selectAll.evaluate(e => document.activeElement === e), true);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('region', { name: '你向对方开放' }).getByText('全部项目', { exact: true }).waitFor();
    assert.equal(await first.count(), 0);
    await home();
    assert.equal(await node.getByText(/你开放：全部项目/).count(), 0);
    await project();
    await page.getByRole('button', { name: '项目设置', exact: true }).click();
    await page.getByRole('region', { name: '开放给了谁' }).getByText('工作间 free', { exact: true }).waitFor();
    await home(); await openPeer();
    await page.getByRole('button', { name: '编辑开放设置', exact: true }).click();
    await selectAll.uncheck();
    assert.equal(await first.isChecked() && await first.isEnabled(), true);
    assert.equal(!await second.isChecked() && await second.isEnabled(), true);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
    assert.deepEqual(await page.evaluate(() => fixture.calls.filter(c => c.input?.operation === 'share').map(c => [c.input.allProjects, c.input.projectIds])), [[true, ['p1']], [false, ['p1']]]);
  });
  await setup();
  await test('host agents distinguish need/work and show one unreadable notice', async () => { await page.getByRole('button', { name: '全部 agent', exact: true }).click(); assert.equal(await page.locator('[data-st=need]').count(), 1); assert.equal(await page.locator('[data-st=work]').count(), 1); assert.ok(!(await page.locator('[data-st=work]').innerText()).includes('未核实')); await page.evaluate(() => { fixture.live.ok = false; fixture.live.agents = []; fixture.emit(); }); await page.getByText(/agent 状态暂时读不到/).waitFor(); assert.equal(await currentLayer().getByText('agent 状态暂时读不到', { exact: true }).count(), 1); });
  await setup({ inboxBatch: true });
  await test('home drops removed projects and stale details while showing registered projects without workspaces', async () => {
    const local = page.locator('[data-workspace=self]');
    await local.getByRole('button', { name: '示例项目', exact: true }).click();
    await page.evaluate(() => {
      fixture.removedProjects = ['p1']; fixture.workspaceTarget = { error: '这个项目当前没有工作区' };
      fixture.projects[1].tasks[0].artifacts = [{ id: 'local', label: '本机成果', version: 'v1', url: '/example/file' }, { id: 'link', label: '网页成果', version: 'v1', url: 'https://example.com/' }];
      fixture.emit();
    });
    await page.getByRole('alert').filter({ hasText: '项目已从 Orca 移除' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '打开会话', exact: true }).count(), 0);
    await home();
    await local.getByRole('button', { name: '移动项目', exact: true }).waitFor();
    assert.equal(await local.locator('.pcard').count(), 1);
    await rail().getByText('页面交付', { exact: true }).waitFor({ state: 'detached' });
    assert.equal(await page.locator('.inbox .pill').innerText(), '1');
    await local.getByRole('button', { name: '移动项目', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '打开会话', exact: true }).isDisabled(), true);
    await page.getByText('这个项目当前没有工作区', { exact: true }).waitFor();
    await page.getByRole('tab', { name: '任务', exact: true }).click();
    await page.getByRole('button', { name: '移动端交付', exact: true }).click();
    await page.getByRole('button', { name: /^成果 / }).click();
    await page.getByRole('button', { name: '本机成果 · v1', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '打不开「本机成果」：这个项目当前没有工作区' }).waitFor();
    await page.getByRole('button', { name: '网页成果 · v1', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => fixture.calls.filter(c => c.name === 'shell.openExternal').map(c => c.input)), ['https://example.com/']);
  });
  await setup({ inboxBatch: true, boundMainFolder: true, width: 1040 });
  await test('the home project cards omit the bound main directory but retain the main agent', async () => {
    const local = page.locator('[data-workspace=self]');
    await local.getByRole('button', { name: '移动项目', exact: true }).waitFor();
    await local.getByText(/工作间主会话/).waitFor();
    assert.equal(await local.getByRole('button', { name: '主会话目录', exact: true }).count(), 0);
    assert.equal(await rail().getByRole('button', { name: '页面交付', exact: true }).count(), 0);
    assert.equal(await rail().getByRole('button', { name: '等批准', exact: true }).count(), 0);
    if (process.env.PANEL_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.PANEL_EVIDENCE_DIR, 'main-directory-hidden.png'), animations: 'disabled' });
  });
  await setup({ holdAgents: true });
  await test('project opens while agent status is pending and stays usable after timeout', async () => {
    await project();
    await page.getByRole('tab', { name: '任务', exact: true }).click();
    await page.getByRole('button', { name: '页面交付', exact: true }).waitFor();
    await page.evaluate(() => fixture.agentTimeout());
    await currentLayer().getByText('agent 状态暂时读不到', { exact: true }).waitFor();
    assert.equal(await page.locator('.dock .toast:visible').count(), 0);
    await page.getByRole('button', { name: '页面交付', exact: true }).click();
    await currentLayer().getByText('已交付', { exact: true }).waitFor();
  });
  await setup({ manyProjects: true });
  await test('agent failure and truncation each render once across home, project and task pages', async () => {
    await page.evaluate(() => { fixture.live.ok = false; fixture.emit(); });
    await page.getByText(/agent 状态暂时读不到/).waitFor();
    await project();
    assert.equal(await currentLayer().getByText('agent 状态暂时读不到', { exact: true }).count(), 1);
    await page.getByRole('tab', { name: 'Agent', exact: true }).click();
    assert.equal(await currentLayer().getByText('agent 状态暂时读不到', { exact: true }).count(), 1);
    await page.getByRole('tab', { name: '任务', exact: true }).click();
    await page.getByRole('button', { name: '页面交付', exact: true }).click();
    assert.equal(await currentLayer().getByText('agent 状态暂时读不到', { exact: true }).count(), 1);
    await page.evaluate(() => { fixture.live.ok = true; fixture.live.truncated = true; fixture.emit(); });
    await currentLayer().getByText('agent 状态未全部读取', { exact: true }).waitFor();
    assert.equal(await currentLayer().getByText('agent 状态暂时读不到', { exact: true }).count(), 0);
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
    await page.getByText(/agent 状态暂时读不到/).waitFor();
    assert.equal(await rail().locator('.pill').innerText(), '1');
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
    for (const id of ['p1', 'p2', 'p3']) assert.equal(await page.locator(`[data-project=${id}]`).isVisible(), true);
    assert.equal(await page.locator('[data-project=p4], [data-project=p5]').count(), 0);
    const idle = page.getByRole('button', { name: /^还没有任务的项目/ });
    await idle.click();
    for (const id of ['p4', 'p5']) assert.equal(await page.locator(`.fold-b [data-project=${id}]`).isVisible(), true);
    await page.evaluate(() => { fixture.live.agents.find(a => a.projectId === 'p2').state = 'done'; fixture.emit(); });
    await page.locator('.fold-b [data-project=p2]').waitFor();
    assert.equal(await page.locator('[data-project=p3]').isVisible(), true);
    await page.evaluate(() => { fixture.live.ok = false; fixture.emit(); });
    await page.getByText(/agent 状态暂时读不到/).waitFor();
    assert.equal(await page.locator('.fold-b [data-project=p3]').count(), 1);
    assert.equal(await page.locator('[data-project=p1]').isVisible(), true);
  });
  await setup();
  await test('keyboard tabs, escape navigation, focus, long input retention', async () => { await project(); const tasks = page.getByRole('tab', { name: '任务', exact: true }); await tasks.focus(); await page.keyboard.press('ArrowRight'); assert.equal(await page.getByRole('tab', { name: 'Agent', exact: true }).getAttribute('aria-selected'), 'true'); await page.keyboard.press('Escape'); await page.getByRole('heading', { name: '组织', exact: true }).waitFor(); await page.locator('[data-workspace=off] .wsr-h').focus(); await page.keyboard.press('Enter'); assert.equal(await page.locator('[data-workspace=off] .wsr-h').getAttribute('aria-expanded'), 'true'); });
  await test('editing retains focus and long input during refresh', async () => {
    await page.getByRole('button', { name: '＋ 连接', exact: true }).click();
    await page.getByRole('button', { name: '高级', exact: true }).click();
    const input = page.getByLabel('访问地址', { exact: true }), text = 'https://' + 'work-room.'.repeat(45) + 'example.com';
    await input.fill(text); await page.evaluate(() => fixture.emit());
    await page.waitForFunction(text => document.activeElement?.getAttribute('data-focus') === '访问地址' && document.activeElement.value === text, text);
    assert.equal(await input.inputValue(), text); assert.equal(await page.locator('#panel').evaluate(e => e.scrollWidth <= e.clientWidth), true);
  });
  await setup();
  await test('task/settings pages load, completion page caps twenty cards', async () => {
    await project(); await page.getByRole('tab', { name: '任务', exact: true }).click(); await page.getByRole('button', { name: '页面交付' }).click(); await page.getByRole('button', { name: '目标', exact: true }).waitFor();
    await page.keyboard.press('Escape'); await page.getByRole('button', { name: '项目设置', exact: true }).click(); await page.getByRole('heading', { name: '分工', exact: true }).waitFor();
    await home(); await page.getByRole('button', { name: '设置', exact: true }).click();
    for (const name of ['主 agent', '外部连接', '工作间连接', '机器', '隐藏的项目']) await currentLayer().getByRole('heading', { name, exact: true }).waitFor();
    await home();
    await page.evaluate(() => { for (let i = 0; i < 25; i++) fixture.live.agents.push({ ...fixture.live.agents[0], id: 'done' + i, state: 'done', rawState: 'done' }); fixture.emit(); });
    await page.getByRole('button', { name: '全部 agent', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('[data-st=done]').length === 20);
  });
  for (const [dataset, fixture] of [['daily', { inboxBatch: true }], ['busy', { manyProjects: true, longInbox: true }], ['empty', { empty: true, unbound: true }]]) {
    for (const [width, theme] of [[320, 'light'], [400, 'dark'], [1040, 'light'], [1040, 'dark']]) {
      await setup({ ...fixture, width });
      await test(`${dataset} · ${theme} · ${width}: no overflow and original Orca styling`, async () => {
        await page.evaluate(theme => { document.documentElement.className = theme; }, theme);
        assert.equal(await page.locator('.home-layer').evaluate(e => e.scrollWidth <= e.clientWidth), true);
        assert.equal(await page.locator('.wsr.me>.wsr-top').evaluate(e => getComputedStyle(e).backgroundColor), theme === 'dark' ? 'rgb(229, 229, 229)' : 'rgb(23, 23, 23)');
        if (dataset !== 'empty') assert.equal(await page.locator('.pcard').first().evaluate(e => getComputedStyle(e).borderTopWidth), '0px');
        if (dataset === 'daily' && process.env.PANEL_EVIDENCE_DIR) {
          await page.screenshot({ path: path.join(process.env.PANEL_EVIDENCE_DIR, `panel-${theme}-${width}.png`), animations: 'disabled' });
          await openReview();
          await review('页面交付').check();
          await page.screenshot({ path: path.join(process.env.PANEL_EVIDENCE_DIR, `detail-${theme}-${width}.png`), animations: 'disabled' });
        }
      });
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(JSON.stringify({ checks: results.length, errors, externalRequests: external, results }));
} finally { await browser.close(); server.close(); }
