import { assert, test, mockHost, mountWorker } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import type { Delivery } from './model'
import { testCoordinator as createCoordinator } from './test-runtime'
import { normalizeFeishu, type MessageTransport } from './feishu'
import { fresh, submitTask } from './store'
import { refs } from './fixtures'
import { requestState } from './model'
import { WorkspaceRequests } from './requests'

test('wire validation is atomic, binds origin to the authenticated connection, and rejects forged histories', async () => {
  const values = new Map<string, any>(), requests = new WorkspaceRequests({ get: async k => values.get(k), set: async (k, v) => { values.set(k, structuredClone(v)) } })
  const input = { ...content('ignored', 'foreign'), id: 'foreign', createdAt: 'today', workspaceId: 'forged-third-party', peerId: 'forged' }
  await requests.receive('trusted-peer', 'trusted-workspace', 'confirm', { requests: [input], updates: [] })
  const saved = await requests.data()
  assert.equal(saved.requests[0].workspaceId, 'trusted-workspace')
  assert.equal(saved.requests[0].peerId, 'trusted-peer')
  await assert.rejects(() => requests.receive('trusted-peer', 'trusted-workspace', 'auto', { requests: [{ ...input, title: 'changed' }], updates: [] }))
  assert.deepEqual(await requests.data(), saved)
  await assert.rejects(() => requests.receive('trusted-peer', 'trusted-workspace', 'auto', { requests: [{ ...input, id: 'would-create' }], updates: [{ id: 'missing', updates: [] }] }))
  assert.deepEqual(await requests.data(), saved)
  await requests.send('trusted-peer', 'trusted-workspace', content('trusted-peer', 'outgoing'))
  const update = { id: 'unique-update', status: 'accepted', note: '', links: [], at: 'today' }
  await requests.receive('trusted-peer', 'trusted-workspace', 'auto', { requests: [], updates: [{ id: 'outgoing', updates: [update] }] })
  const before = await requests.data()
  await assert.rejects(() => requests.receive('trusted-peer', 'trusted-workspace', 'auto', { requests: [], updates: [{ id: 'outgoing', updates: [{ ...update, note: 'changed' }] }] }))
  await assert.rejects(() => requests.receive('trusted-peer', 'trusted-workspace', 'auto', { requests: [], updates: [{ id: 'outgoing', updates: [update, { ...update, status: 'completed' }] }] }))
  await assert.rejects(() => requests.receive('third-peer', 'third-workspace', 'auto', { requests: [], updates: [{ id: 'outgoing', updates: [update] }] }))
  assert.deepEqual(await requests.data(), before)
})

async function workspace(name: string) {
  const sends: Delivery[] = [], agents: Delivery[] = []
  let timeout = false, coordinator!: ReturnType<typeof createCoordinator>
  const transport: MessageTransport = { state: () => ({ state: 'connected', message: '' }), sync: async () => {}, stop() {}, send: async d => {
    sends.push(structuredClone(d)); if (timeout) throw Error('simulated timeout'); return `message_${sends.length}`
  } }
  const project = fresh(refs[0]); project.runId = 'project_run'
  const host = mockHost({ storage: {
    workspace: { version: 1, revision: 1, runId: `${name}_main`, requests: [] }, 'project:p1': project as any,
    'workspace.messaging': { version: 1, revision: 0, feishu: { enabled: true, appId: name, chatIds: ['test_chat'], senderIds: ['test_user'] }, inbox: [], deliveries: [] }
  } })
  const worker = await mountWorker({ default: (api: OrcaWorkerApi) => { coordinator = createCoordinator(api, {
    projects: async () => refs, verifyRun: async () => {}, send: async (_run, d) => { agents.push(structuredClone(d)); return { requestId: 'mock-receipt' } }
  }, transport) } }, { host })
  const request = (operation: 'send' | 'update' | 'decide' | 'attach', input: any) => worker.request('workspace.requests', { operation, runId: `${name}_main`, ...input })
  const state = async (id: string) => requestState((await coordinator.links.snapshot()).requests!.find(r => r.id === id)!)
  const reply = async (id: string, text: string, parent: string, sender = 'test_user') => {
    await coordinator.ingest(name, normalizeFeishu(name, { sender: { sender_type: 'user', sender_id: { open_id: sender } },
      message: { message_id: id, chat_id: 'test_chat', parent_id: parent, message_type: 'text', content: JSON.stringify({ text }) } })!)
    await coordinator.flushMailbox(); await coordinator.flushRequestNotifications()
  }
  return { coordinator, worker, host, sends, agents, request, state, reply, timeout: () => { timeout = true }, async close() { coordinator.stop(); await worker.deactivate() } }
}
async function connect(a: Awaited<ReturnType<typeof workspace>>, b: Awaited<ReturnType<typeof workspace>>) {
  const s = await a.coordinator.links.snapshot()
  await a.coordinator.links.configure({ ...s, enabled: true, host: '127.0.0.1', port: 0, tls: false, publicUrl: '' })
  const joined = await b.coordinator.links.join((await a.coordinator.links.invite()).invitation!.code)
  return joined.peers.find(p => p.workspaceId === s.workspaceId)!.id
}
async function rule(w: Awaited<ReturnType<typeof workspace>>, peerId: string, acceptTasks: string) {
  const s = await w.coordinator.links.snapshot()
  await w.coordinator.links.share({ id: peerId, revision: s.revision, scope: 'details', projectIds: ['p1'], acceptTasks })
}
const content = (peerId: string, requestId: string) => ({ peerId, requestId, title: `测试请求 ${requestId}`, context: '测试背景，仅回环', expected: '测试文字和链接', links: ['https://example.com/input'] })

test('panel dispatch uses bound main, queues offline, notifies once and rejects unbound main', async () => {
  const a = await workspace('panel-A'), b = await workspace('panel-B')
  try {
    const peerId = await connect(a, b)
    const input = { operation: 'send' as const, ...content(peerId, 'panel-issued') }
    await a.worker.request('workspace.requests', input)
    await a.worker.request('workspace.requests', input)
    assert.equal(a.agents.filter(d => d.subject.startsWith('已派活')).length, 1)
    assert.equal((await a.coordinator.links.snapshot()).requests!.find(r => r.id === 'panel-issued')!.panelIssued, true)
    assert.equal((await b.coordinator.links.snapshot()).requests!.some(r => r.id === 'panel-issued'), false)
    await b.coordinator.links.refresh()
    assert.equal((await b.coordinator.links.snapshot()).requests!.some(r => r.id === 'panel-issued'), true)
    await a.coordinator.store.mutateWorkspace(w => { w.runId = '' })
    await assert.rejects(() => a.worker.request('workspace.requests', { ...input, requestId: 'unbound' }), /主 agent/)
  } finally { await a.close(); await b.close() }
})

test('loopback requests: deny, confirmation via Feishu, auto handoff, progress/results and exact replay across one-way reachability', async () => {
  const a = await workspace('A'), b = await workspace('B')
  try {
    const peerId = await connect(a, b), original = structuredClone(a.host.data().storage['project:p1'])
    assert.equal((await a.coordinator.links.snapshot()).peers[0].endpoint, '')
    assert.equal((await b.coordinator.links.snapshot()).enabled, false)
    await a.request('send', content(peerId, 'denied'))
    await b.coordinator.links.refresh(); await b.coordinator.links.refresh()
    assert.equal(await a.state('denied'), 'rejected')
    assert.equal((await a.coordinator.links.snapshot()).requests![0].updates[0].note, '对方不接受派活')
    await a.coordinator.flushRequestNotifications()
    assert.ok(a.sends.some(d => d.subject.includes('已拒绝')))

    await rule(b, peerId, 'confirm')
    await a.request('send', content(peerId, 'confirm-accept'))
    await b.coordinator.links.refresh(); await b.coordinator.flushRequestNotifications(); await b.coordinator.links.refresh()
    assert.equal(await a.state('confirm-accept'), 'confirm')
    const overview = await b.worker.request('workspace.overview')
    assert.ok(overview.links!.requests!.some(r => r.id === 'confirm-accept' && requestState(r) === 'confirm'))
    const reminder = b.sends.find(d => d.external?.workspaceRequest?.id === 'confirm-accept')!
    assert.ok(reminder.body.includes('接受') && reminder.body.includes('拒绝'))
    const messageId = (await b.coordinator.store.messaging()).deliveries.find(d => d.id === reminder.id)!.external!.messageId!
    await b.reply('outsider', '接受', messageId, 'outsider')
    assert.equal(await b.state('confirm-accept'), 'confirm')
    await b.reply('accept', '接受：按范围处理', messageId)
    await b.reply('accept', '接受：按范围处理', messageId)
    assert.equal(await a.state('confirm-accept'), 'accepted')
    assert.ok(b.agents.some(d => d.subject.includes('已接受') && d.body.includes('confirm-accept')))
    await b.request('attach', { peerId, id: 'confirm-accept', projectId: 'p1' })
    await b.request('attach', { peerId, id: 'confirm-accept', projectId: 'p1' })
    const project = await b.coordinator.store.get('p1')
    assert.equal(project.events.filter(e => e.source === 'workspace-external').length, 1)
    const update = { peerId, id: 'confirm-accept', requestId: 'progress-one', status: 'working', note: '测试进展' }
    await b.request('update', update); await b.request('update', update)
    assert.equal(await a.state('confirm-accept'), 'working')
    await assert.rejects(() => b.request('update', { ...update, note: 'changed' }))
    await b.request('update', { ...update, requestId: 'complete', status: 'completed', note: '测试结果', links: ['https://example.com/result'] })
    await a.coordinator.flushRequestNotifications()
    assert.equal(await a.state('confirm-accept'), 'completed')
    assert.ok(a.agents.some(d => d.body.includes('测试进展')))
    assert.ok(a.sends.some(d => d.subject.includes('已完成') && d.body.includes('https://example.com/result')))
    const before = structuredClone((await a.coordinator.links.snapshot()).requests), count = a.sends.length
    await b.coordinator.links.refresh(); await a.coordinator.flushRequestNotifications()
    await a.request('send', content(peerId, 'confirm-accept'))
    assert.deepEqual((await a.coordinator.links.snapshot()).requests, before)
    assert.equal(a.sends.length, count)

    await a.request('send', content(peerId, 'confirm-reject'))
    await b.coordinator.links.refresh(); await b.coordinator.flushRequestNotifications()
    const rejectReminder = (await b.coordinator.store.messaging()).deliveries.find(d => d.external?.workspaceRequest?.id === 'confirm-reject')!
    await b.reply('reject', '拒绝：测试原因', rejectReminder.external!.messageId!)
    assert.equal(await a.state('confirm-reject'), 'rejected')

    await rule(a, peerId, 'auto')
    await b.request('send', content(peerId, 'reverse-auto'))
    assert.equal(await b.state('reverse-auto'), 'accepted')
    await a.coordinator.flushRequestNotifications()
    assert.ok(a.agents.some(d => d.subject.includes('已接受') && d.body.includes('reverse-auto')))
    await a.request('update', { peerId, id: 'reverse-auto', requestId: 'reverse-result', status: 'failed', note: '测试失败结果' })
    await b.coordinator.links.refresh()
    assert.equal(await b.state('reverse-auto'), 'failed')
    assert.deepEqual(a.host.data().storage['project:p1'], original)
  } finally { await a.close(); await b.close() }
})

test('durable retries/restart, revoke both ways, third-party isolation, auth and invalid input fail closed', async () => {
  const a = await workspace('A'), b = await workspace('B'), c = await workspace('C')
  try {
    const ab = await connect(a, b), bc = await connect(c, b)
    await rule(b, ab, 'auto'); await rule(b, bc, 'auto')
    // Stop the inviter, persist an outgoing request, then resume the same endpoint.
    const as = await a.coordinator.links.snapshot(), port = Number(new URL(as.listening).port)
    a.coordinator.links.stop()
    await b.request('send', content(ab, 'offline-pending'))
    assert.equal(await b.state('offline-pending'), 'sent')
    await a.coordinator.links.configure({ ...as, port })
    await b.coordinator.links.refresh()
    assert.equal(await b.state('offline-pending'), 'rejected')
    await a.request('send', { ...content(ab, 'private-request'), title: 'A PRIVATE REQUEST', context: 'A PRIVATE CONTEXT' })
    await b.coordinator.links.refresh()
    await b.request('attach', { peerId: ab, id: 'private-request', projectId: 'p1' })
    await b.coordinator.store.mutate('p1', undefined, p => {
      submitTask(p, { id: 'local', title: 'B LOCAL TITLE', goal: '本地目标', phase: 'working' })
      const event = p.events.find(e => e.source === 'workspace-external')!
      submitTask(p, { id: 'external', title: 'A PRIVATE TASK', goal: 'A PRIVATE GOAL', progress: 'A PRIVATE PROGRESS', phase: 'ready', sourceIds: [event.id],
        decisions: [{ id: 'decision', question: 'A PRIVATE DECISION', options: ['A PRIVATE OPTION'] }],
        artifacts: [{ id: 'artifact', label: 'A PRIVATE ARTIFACT', version: 'v1', url: 'https://example.com/private' }],
        acceptance: [{ id: 'acceptance', title: 'A PRIVATE ACCEPTANCE', details: 'A PRIVATE DETAILS', artifactIds: ['artifact'] }] })
      // Legacy taskId-only association must be filtered as well.
      const legacy = structuredClone(p.tasks[1]); legacy.id = 'legacy-external'; legacy.sourceIds = []; p.tasks.push(legacy)
      p.events.push({ ...event, id: 'legacy-source', taskId: legacy.id })
    })
    await rule(b, bc, 'auto'); await b.coordinator.links.refresh()
    const cs = await c.coordinator.links.snapshot(), third = cs.peers.find(p => p.id === bc)!
    assert.deepEqual(third.report!.projects.map(p => p.id), ['p1'])
    assert.deepEqual(third.report!.projects[0].tasks!.map(t => t.title), ['B LOCAL TITLE'])
    assert.deepEqual(third.report!.projects[0].counts, { working: 1 })
    assert.equal(third.report!.projects[0].pending, 0)
    assert.equal(JSON.stringify(cs).includes('A PRIVATE'), false)
    assert.equal(JSON.stringify(await b.coordinator.links.requests.envelope(bc)).includes('A PRIVATE'), false)
    await assert.rejects(() => b.worker.request('workspace.requests', { operation: 'send', ...content(ab, 'wrong-main'), runId: 'wrong' }))
    await assert.rejects(() => b.request('send', { ...content(ab, 'bad-link'), links: ['file:///secret'] }))
    await assert.rejects(() => b.request('send', { ...content(ab, 'bad-secret'), links: ['https://user:secret@example.com'] }))
    await assert.rejects(() => b.request('update', { peerId: ab, id: 'private-request', requestId: 'bad-state', status: 'accepted', note: 'invalid' }))
    const token = b.host.data().secrets[`workspace-link:${ab}`]
    const response = await fetch((await a.coordinator.links.snapshot()).listening + '/sync', { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: JSON.stringify({ id: ab }) })
    assert.equal(response.status, 401)
    assert.ok(token)
    const beforeRestart = structuredClone(b.host.data().storage['workspace.requests'])
    await b.coordinator.start()
    assert.deepEqual(b.host.data().storage['workspace.requests'], beforeRestart)
    await b.coordinator.links.refresh()
    await a.coordinator.links.revoke(ab)
    assert.equal(await a.state('private-request'), 'disconnected')
    await b.coordinator.links.refresh()
    assert.equal(await b.state('private-request'), 'disconnected')
    assert.equal((await b.coordinator.links.snapshot()).peers.find(p => p.id === ab)!.state, 'revoked')
    await assert.rejects(() => b.request('send', content(ab, 'after-revoke')))
    await c.request('send', content(bc, 'revoke-joiner'))
    await b.coordinator.links.refresh(); await b.coordinator.links.revoke(bc)
    assert.equal(await c.state('revoke-joiner'), 'disconnected')
    assert.equal(await b.state('revoke-joiner'), 'disconnected')
  } finally { await a.close(); await b.close(); await c.close() }
})

test('request reminders keep uncertain delivery and never duplicate after repeated sync or restart', async () => {
  const a = await workspace('A'), b = await workspace('B')
  try {
    const peerId = await connect(a, b)
    await rule(b, peerId, 'confirm'); b.timeout()
    await a.request('send', content(peerId, 'uncertain'))
    await b.coordinator.links.refresh(); await b.coordinator.flushRequestNotifications()
    const sends = b.sends.length
    assert.equal((await b.coordinator.store.messaging()).deliveries.find(d => d.external?.workspaceRequest)!.state, 'uncertain')
    await b.coordinator.start(); await b.coordinator.links.refresh(); await b.coordinator.flushRequestNotifications()
    assert.equal(b.sends.length, sends)
    assert.equal((await b.coordinator.links.snapshot()).requests!.length, 1)
  } finally { await a.close(); await b.close() }
})
