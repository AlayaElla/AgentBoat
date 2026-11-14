import { assert, test, mockHost, mountWorker } from 'orca/testing'
import http from 'node:http'
import type { OrcaWorkerApi } from 'orca/worker'
import { Butler, butlerUrl } from './butler'
import { createCoordinator } from './worker'
import { refs, sample } from './fixtures'

const token = 'test-only-inbound-token-1234567890123456789', other = 'test-only-outbound-token-1234567890123456789'
async function instance(url = 'http://127.0.0.1:9900') {
  const storage = new Map<string, any>([['project:p1', sample().project]]), secrets = new Map<string, string>(), notices: any[] = []
  const before = structuredClone(storage.get('project:p1'))
  const api = { storage: { get: async (k: string) => structuredClone(storage.get(k) ?? null), set: async (k: string, v: any) => { assert.equal(k, 'workspace.butler'); storage.set(k, structuredClone(v)) } },
    secrets: { get: async (k: string) => secrets.get(k) ?? null, set: async (k: string, v: string) => { secrets.set(k, v) } } }
  const b = new Butler(api as any, async () => 'run_mock', async (runId, id, body) => { notices.push({ runId, id, body }) }, () => {})
  await b.handle({ operation: 'save', revision: 0, enabled: true, port: 0, url, inboundToken: token, outboundToken: other })
  return { b, storage, secrets, notices, before }
}
async function rpc(b: Butler, method: string, params: any, bearer = token) {
  const r = await fetch(b.listening, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'rpc-test', method, params }) })
  return { code: r.status, body: await r.json() as any }
}
const params = (id: string, text = '模拟管家提醒', immediate = true) => ({ message: { messageId: id, role: 'ROLE_USER', contextId: 'ctx-daily', parts: [{ text }] }, configuration: { returnImmediately: immediate } })
async function until(fn: () => Promise<boolean>) { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)) }; throw Error('Condition timed out') }

test('Hermes → main → reply → Hermes: v1 async, blocking, deduplication, auth, loopback and project isolation', async () => {
  const { b, storage, secrets, notices, before } = await instance()
  try {
    assert.ok(b.listening.startsWith('http://127.0.0.1:'))
    assert.equal((b as any).server.address().address, '127.0.0.1')
    for (const url of ['http://0.0.0.0:9900', 'https://example.com', 'http://127.0.0.1/projects', 'http://user:pass@127.0.0.1']) assert.throws(() => butlerUrl(url))
    assert.equal((await rpc(b, 'SendMessage', params('wrong'), 'wrong')).code, 401)
    const unauth = await fetch(b.listening + '/.well-known/agent-card.json'); assert.equal(unauth.status, 401)
    const card = await (await fetch(b.listening + '/.well-known/agent-card.json', { headers: { Authorization: `Bearer ${token}` } })).json() as any
    assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0')
    assert.equal(card.capabilities.streaming, false)
    assert.equal(JSON.stringify(card).includes('project:p1'), false)
    assert.equal((await fetch(b.listening + '/projects', { headers: { Authorization: `Bearer ${token}` } })).status, 404)
    assert.equal((await rpc(b, 'projects.list', {})).body.error.code, -32601)
    const first = (await rpc(b, 'SendMessage', params('incoming-1'))).body.result.task
    assert.equal(first.status.state, 'TASK_STATE_SUBMITTED')
    await b.tick()
    assert.equal(notices.length, 1); assert.ok(notices[0].body.includes('来自管家')); assert.equal(notices[0].runId, 'run_mock')
    const duplicate = (await rpc(b, 'SendMessage', params('incoming-1'))).body.result.task
    assert.equal(duplicate.id, first.id); await b.tick(); assert.equal(notices.length, 1)
    assert.equal((await rpc(b, 'SendMessage', params('incoming-1', '不同内容'))).body.error.code, -32602)
    await assert.rejects(() => b.handle({ operation: 'reply', runId: 'wrong', id: first.id, requestId: 'reply', text: '模拟回应' }))
    const reply = { operation: 'reply' as const, runId: 'run_mock', id: first.id, requestId: 'reply-1', text: '模拟回应，已转告主人' }
    await b.handle(reply); await b.handle(reply)
    const result = (await rpc(b, 'GetTask', { id: first.id })).body.result
    assert.equal(result.status.state, 'TASK_STATE_COMPLETED'); assert.equal(result.history.length, 2); assert.equal(result.artifacts[0].parts[0].text, reply.text)
    assert.deepEqual((await rpc(b, 'GetTask', { id: first.id, historyLength: 0 })).body.result.history, [])
    assert.equal((await rpc(b, 'GetTask', { id: first.id, historyLength: -1 })).body.error.code, -32602)
    const blocking = rpc(b, 'SendMessage', params('incoming-2', '模拟需要确认', false))
    await until(async () => (await b.snapshot()).entries.length === 2)
    const second = (await b.snapshot()).entries.find(e => e.id === 'incoming-2')!
    await b.handle({ ...reply, id: second.task.id, requestId: 'reply-2' })
    assert.equal((await blocking).body.result.task.status.state, 'TASK_STATE_COMPLETED')
    assert.deepEqual(storage.get('project:p1'), before)
    assert.equal(JSON.stringify([...storage]).includes(token), false); assert.equal(JSON.stringify(await b.snapshot()).includes(other), false)
    assert.equal(secrets.get('butler:inbound'), token)
    b.stop(); await b.start()
    assert.equal((await rpc(b, 'GetTask', { id: first.id })).body.result.status.state, 'TASK_STATE_COMPLETED')
  } finally { b.stop() }
})

test('blocking Hermes outbound does not prevent an inbound clarification from reaching main', async () => {
  let release!: () => void
  const ready = new Promise<void>(r => { release = r })
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the mock request */ }
    await ready
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ jsonrpc: '2.0', result: { task: { id: 'blocking-remote', contextId: 'ctx-nested', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ parts: [{ text: '模拟长任务结束' }] }] } } }))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { b, notices } = await instance(`http://127.0.0.1:${(server.address() as any).port}`)
  try {
    await b.handle({ operation: 'send', runId: 'run_mock', requestId: 'nested-out', contextId: 'ctx-nested', text: '模拟长任务' })
    await until(async () => (await b.snapshot()).entries[0].task.status.state === 'TASK_STATE_WORKING')
    await rpc(b, 'SendMessage', params('nested-in', '模拟长任务里的确认问题'))
    await until(async () => notices.some(n => n.body.includes('模拟长任务里的确认问题')))
    release(); await b.tick()
    assert.ok(notices.some(n => n.body.includes('模拟长任务结束')))
  } finally { release(); b.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) }
})

test('main → mock Hermes → result → main preserves context, polls durable tasks and never resends uncertain writes', async () => {
  let sends = 0, polls = 0, reject = false
  const contexts: string[] = []
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${other}`)
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'GET') { res.end(JSON.stringify({ name: 'mock Hermes', supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] })); return }
    let raw = ''; for await (const c of req) raw += c
    const r = JSON.parse(raw)
    if (r.method === 'SendMessage') { sends++; contexts.push(r.params.message.contextId); if (reject) { res.writeHead(401); res.end('{}'); return } }
    else polls++
    const task = { id: `remote-${sends}`, contextId: 'ctx-daily', status: { state: r.method === 'GetTask' ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_WORKING' }, ...(r.method === 'GetTask' ? { artifacts: [{ artifactId: 'mock-result', parts: [{ text: '模拟查资料结果' }] }] } : {}) }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: r.method === 'GetTask' ? task : { task } }))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as any).port}`, { b, notices, storage, before } = await instance(url)
  try {
    assert.equal((await b.handle({ operation: 'check' })).connection, '已连接')
    const send = { operation: 'send' as const, runId: 'run_mock', requestId: 'send-1', contextId: 'ctx-daily', text: '模拟查资料' }
    await b.handle(send); await b.tick(); await b.tick()
    assert.equal(sends, 1); assert.equal(polls, 1); assert.equal(notices.length, 1); assert.ok(notices[0].body.includes('模拟查资料结果'))
    await b.handle(send); await b.tick(); assert.equal(sends, 1); assert.equal(notices.length, 1)
    await assert.rejects(() => b.handle({ ...send, text: '换内容' }))
    await b.handle({ ...send, requestId: 'send-2' }); await b.tick(); await b.tick()
    assert.deepEqual(contexts, ['ctx-daily', 'ctx-daily'])
    reject = true
    await b.handle({ ...send, requestId: 'send-failed' }); await b.tick(); await b.tick()
    const failed = (await b.snapshot()).entries.find(e => e.id === 'send-failed')!
    assert.equal(failed.task.status.state, 'TASK_STATE_FAILED'); assert.ok(failed.error!.includes('不会自动重发'))
    assert.equal(sends, 3); b.stop(); await b.start(); await b.tick(); assert.equal(sends, 3)
    assert.deepEqual(storage.get('project:p1'), before)
  } finally { b.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) }
})

test('disabling while Hermes is busy leaves queued messages unsent', async () => {
  let release!: () => void, calls = 0
  const ready = new Promise<void>(r => { release = r })
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    calls++; await ready
    res.end(JSON.stringify({ jsonrpc: '2.0', result: { task: { id: 'mock-disabled', contextId: 'ctx-daily', status: { state: 'TASK_STATE_COMPLETED' } } } }))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { b } = await instance(`http://127.0.0.1:${(server.address() as any).port}`)
  try {
    const input = { operation: 'send' as const, runId: 'run_mock', text: '模拟排队消息' }
    await b.handle({ ...input, requestId: 'active' }); await b.handle({ ...input, requestId: 'queued' })
    await until(async () => calls === 1)
    const s = await b.snapshot()
    await b.handle({ operation: 'save', revision: s.revision, enabled: false, port: 0, url: s.url })
    release(); await b.tick()
    assert.equal(calls, 1)
    assert.equal((await b.snapshot()).entries.find(e => e.id === 'queued')!.task.status.state, 'TASK_STATE_SUBMITTED')
  } finally { release(); b.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) }
})

test('legacy storage and coordinator handlers keep all existing records and require bound main Run', async () => {
  const p = sample().project!, host = mockHost({ storage: { 'project:p1': p as any, workspace: { version: 1, revision: 0, runId: 'mock-main', requests: [] } } })
  let c!: ReturnType<typeof createCoordinator>
  const worker = await mountWorker({ default: (api: OrcaWorkerApi) => { c = createCoordinator(api, { projects: async () => refs, verifyRun: async () => {}, send: async () => ({}) }) } }, { host })
  try {
    const s = await worker.request('workspace.butler', { operation: 'read' })
    assert.equal(s.enabled, false); assert.deepEqual(s.entries, [])
    assert.equal((await worker.request('workspace.overview')).butler!.enabled, false)
    assert.deepEqual(host.data().storage['project:p1'], p)
    await assert.rejects(() => worker.request('workspace.butler', { operation: 'send', runId: 'project-run', requestId: 'no', text: '模拟拒绝' }))
    assert.deepEqual(host.data().storage['project:p1'], p)
  } finally { c.stop(); await worker.deactivate() }
})
