import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import type { AgentSession } from './model'
import { createCoordinator } from './worker'
import { fresh } from './store'
import { refs } from './fixtures'
import { mainTargets } from './runtime'
import { OrgCanvas } from './org-canvas'

const session: AgentSession = { handle: 'orca_session_id:test-next', title: '测试接管会话', workspace: 'identity:test-workspace', workspaceName: '测试工作区', path: '/test/workspace', agent: 'claude', online: 'online' }
const tokenFrom = (prompt: string) => /一次性接管凭据：([^\n]+)/.exec(prompt)![1]

test('unknown takeover send and old-agent notification are durable and never automatically retried', async () => {
  const host = mockHost({ storage: { workspace: { version: 1, revision: 0, runId: 'run_old', requests: [] } } })
  let c!: ReturnType<typeof createCoordinator>, sends = 0, requests = 0, prompt = ''
  const worker = await mountWorker({ default: (api: OrcaWorkerApi) => { c = createCoordinator(api, {
    projects: async () => [], verifyRun: async () => {}, identify: async () => session,
    targets: async () => ({ sessions: [session], workspaces: [] }),
    requestTakeover: async (_h, p) => { requests++; prompt = p; throw Error('test timeout') },
    send: async () => { sends++; throw Error('test notification timeout') }
  }) } }, { host })
  try {
    const t = await worker.request('workspace.agent.switch', { mode: 'existing', revision: 0, handle: session.handle })
    assert.equal(t.takeover?.state, 'uncertain'); assert.equal(t.runId, 'run_old')
    await c.start(); await c.start(); assert.equal(requests, 1)
    const bound = await worker.request('workspace.agent', { operation: 'bind', revision: t.revision, requestId: 'test', caller: session.handle, runId: 'run_new', token: tokenFrom(prompt) })
    assert.equal(bound.previousNotice, 'uncertain'); assert.equal(bound.runId, 'run_new')
    await c.start(); assert.equal(sends, 1)
  } finally { c.stop(); await worker.deactivate() }
})

for (const mode of ['existing', 'new'] as const) test(`main takeover ${mode}: target owns new Run, only valid token replaces legacy binding, notices follow new binding`, async () => {
  const project = fresh(refs[0]); project.runId = 'run_project'
  const legacy = { version: 1, revision: 2, runId: 'run_old', requests: [] }
  const host = mockHost({ storage: { workspace: legacy, 'project:p1': project as any } })
  const prompts: string[] = [], sends: { run: string; subject: string }[] = []
  let c!: ReturnType<typeof createCoordinator>, storage!: OrcaWorkerApi['storage'], launched = 0
  const worker = await mountWorker({ default: (api: OrcaWorkerApi) => {
    storage = api.storage
    c = createCoordinator(api, {
      projects: async () => refs, verifyRun: async () => {},
      identify: async (handle, run) => { if (handle !== session.handle || run !== 'run_next') throw Error('not own Run'); return session },
      targets: async () => ({ sessions: [session], workspaces: [{ workspace: session.workspace, name: session.workspaceName, path: session.path }] }),
      requestTakeover: async (handle, prompt) => { assert.equal(handle, session.handle); prompts.push(prompt) },
      launchMain: async (workspace, agent, prompt) => { assert.equal(workspace, session.workspace); assert.equal(agent, 'claude'); launched++; prompts.push(prompt); return session.handle },
      send: async (run, d) => { sends.push({ run, subject: d.subject }); return {} }
    }, { sync: async () => {}, stop() {}, state: () => ({ state: 'off', message: '' }), send: async () => 'test' })
  } }, { host })
  try {
    const before = await worker.request('workspace.agent', { operation: 'read' })
    assert.equal(before.runId, 'run_old'); assert.equal(before.session, undefined)
    assert.deepEqual(host.data().storage.workspace, legacy)
    const bind = { operation: 'bind' as const, runId: 'run_next', caller: session.handle, revision: 2, requestId: 'test-bind' }
    await assert.rejects(() => worker.request('workspace.agent', bind))
    const switching = await worker.request('workspace.agent.switch', { revision: 2, mode, ...(mode === 'existing' ? { handle: session.handle } : { workspace: session.workspace, agent: 'claude' }) })
    assert.equal(switching.runId, 'run_old'); assert.equal(switching.takeover?.state, 'waiting')
    assert.equal(launched, mode === 'new' ? 1 : 0)
    const token = tokenFrom(prompts[0]); assert.equal(JSON.stringify(host.data().storage).includes(token), false)
    assert.equal(JSON.stringify(switching).includes('tokenHash'), false)
    const current = () => worker.request('workspace.agent', { operation: 'read' })
    await assert.rejects(() => worker.request('workspace.agent.switch', { revision: switching.revision, mode, handle: session.handle }))
    await assert.rejects(() => worker.request('workspace.agent', { ...bind, revision: switching.revision, token: 'wrong' }))
    await assert.rejects(() => worker.request('workspace.agent', { ...bind, revision: switching.revision }))
    await assert.rejects(() => worker.request('workspace.agent', { ...bind, revision: switching.revision, token, caller: 'another' }))
    await c.store.mutateWorkspace(w => { w.takeover!.expiresAt = new Date(Date.now() - 1).toISOString() })
    const expiredRevision = (await current()).revision
    await assert.rejects(() => worker.request('workspace.agent', { ...bind, revision: expiredRevision, token }))
    await c.store.mutateWorkspace(w => { w.takeover!.expiresAt = new Date(Date.now() + 60000).toISOString() })
    const good = { ...bind, revision: (await current()).revision, token }
    const bound = await worker.request('workspace.agent', good)
    assert.equal(bound.runId, 'run_next'); assert.equal(bound.session?.title, session.title); assert.equal(bound.session?.online, 'online')
    assert.ok(bound.boundAt); assert.equal(bound.takeover, undefined)
    assert.deepEqual(await worker.request('workspace.agent', good), bound)
    await assert.rejects(() => worker.request('workspace.agent', { ...good, revision: bound.revision, requestId: 'reused-token' }))
    assert.equal(sends.filter(s => s.run === 'run_old' && s.subject === '工作间主 agent 已切换').length, 1)
    await worker.request('project.agent', { operation: 'submit', projectId: 'p1', revision: 0, requestId: 'after-takeover', task: { id: 'after', title: '测试新通知', goal: '测试', phase: 'blocked' } })
    await c.flush('p1')
    assert.ok(sends.some(s => s.run === 'run_next' && s.subject.includes('测试新通知')))
    await c.store.mutateMessaging(m => { m.feishu = { enabled: true, appId: 'test-app', chatIds: ['chat'], senderIds: ['owner'] } })
    await c.ingest('test-app', { id: 'new-feishu', source: 'feishu', sourceId: 'test-app:event', threadId: '', chatId: 'chat', senderId: 'owner', text: '测试新飞书消息', receivedAt: new Date().toISOString() })
    await c.flushMailbox()
    assert.ok(sends.some(s => s.run === 'run_next' && s.subject === '飞书工作间消息'))
    assert.equal(sends.filter(s => s.run === 'run_old').length, 1)
    const canvas = new OrgCanvas({ storage, plugin: { request: (n: string, i: any) => worker.request(n, i) } } as any)
    await canvas.load()
    const node = canvas.graph('projects').nodes.find(n => n.id === 'main')!
    for (const value of [session.title, session.path, session.workspaceName, 'Claude', 'run_next', '在线']) assert.ok(node.detail.includes(value))
    const saved = JSON.stringify(host.data().storage)
    await worker.request('workspace.overview'); await worker.request('project.read', { projectId: 'p1' })
    assert.equal(JSON.stringify(host.data().storage), saved)
    assert.deepEqual(worker.refusals, [])
  } finally { c.stop(); await worker.deactivate() }
})

test('status count follows submissions, feedback, hide and restore; command opens overview', async () => {
  const host = mockHost(), opened: boolean[] = []
  let c!: ReturnType<typeof createCoordinator>
  const worker = await mountWorker({ default: (api: OrcaWorkerApi) => { c = createCoordinator(api, {
    projects: async () => refs, verifyRun: async () => {}, send: async () => ({}), openOverview: async () => { opened.push(true) }
  }) } }, { host })
  const count = async () => { await c.updateStatus(); return (host.callsOf('statusBar.update').at(-1) as any).text }
  try {
    assert.equal(await count(), '项目协作 · 待处理 0')
    let p = (await worker.request('project.agent', { operation: 'submit', projectId: 'p1', revision: 0, requestId: 'status', task: { id: 't', title: '测试数量', goal: '测试', phase: 'working', decisions: [{ id: 'd', question: '测试问题', options: ['是'] }] } })).project!
    assert.equal(await count(), '项目协作 · 待处理 1')
    p = (await worker.request('project.visibility', { projectId: 'p1', revision: p.revision, hidden: true })).project!
    assert.equal(await count(), '项目协作 · 待处理 0')
    p = (await worker.request('project.visibility', { projectId: 'p1', revision: p.revision, hidden: false })).project!
    assert.equal(await count(), '项目协作 · 待处理 1')
    await worker.request('project.feedback', { projectId: 'p1', revision: p.revision, taskId: 't', kind: 'decision', itemId: 'd', answer: '是' })
    assert.equal(await count(), '项目协作 · 待处理 0')
    await worker.command('workspace.overview'); assert.equal(opened.length, 1)
    assert.ok(worker.posts.some(p => p.event === 'workspace.open'))
    assert.deepEqual(worker.refusals, [])
  } finally { c.stop(); await worker.deactivate() }
})

test('runtime target parser uses exact chat session and terminal pane; unknown liveness is never online', () => {
  const ws = { address: { environment: 'local', worktree: 'identity:workspace' }, path: '/test', displayName: '工作区', agents: [
    { paneKey: 'structured-agent-session-test-session:pane', conversationName: '会话', agentType: 'claude', subagentObservation: 'live' },
    { paneKey: 'tab:leaf', agentType: 'codex', agentWait: { liveness: 'live' } },
    { paneKey: 'structured-agent-session-stale:pane', agentType: 'claude', state: 'working' },
    { paneKey: 'structured-agent-session-child:pane', parentPaneKey: 'parent', subagentObservation: 'live' }
  ] }
  const t = mainTargets([ws], [{ tabId: 'tab', leafId: 'leaf', handle: 'terminal-exact', connected: true, writable: true }])
  assert.deepEqual(t.sessions.map(s => [s.handle, s.online]), [['orca_session_id:test-session', 'online'], ['terminal-exact', 'online'], ['orca_session_id:stale', 'unknown']])
  assert.equal(mainTargets([{ ...ws, hostId: 'remote' }], []).sessions.length, 0)
})
