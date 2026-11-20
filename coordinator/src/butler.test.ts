import { assert, test } from 'orca/testing'
import http from 'node:http'
import { Readable } from 'node:stream'
import { Butler, butlerUrl } from './butler'
import { sample } from './fixtures'

const token = 'test-only-inbound-token-1234567890123456789', other = 'test-only-outbound-token-1234567890123456789'
async function instance(url = 'http://127.0.0.1:9900', failNotification = false, name = 'Hermes') {
  const storage = new Map<string, any>([['project:p1', sample().project]]), secrets = new Map<string, string>(), notices: any[] = []
  const before = structuredClone(storage.get('project:p1'))
  const api = { storage: { get: async (k: string) => structuredClone(storage.get(k) ?? null), set: async (k: string, v: any) => { assert.equal(k, 'workspace.a2a:butler'); storage.set(k, structuredClone(v)) } },
    secrets: { get: async (k: string) => secrets.get(k) ?? null, set: async (k: string, v: string) => { secrets.set(k, v) } } }
  const b = new Butler(api as any, async () => 'run_mock', async (runId, id, body) => { notices.push({ runId, id, body }); if (failNotification) throw Error('Mock notification unavailable') }, () => {}, 'butler', () => name)
  await b.handle({ operation: 'save', revision: 0, enabled: true, port: 0, url, inboundToken: token, outboundToken: other })
  return { b, storage, secrets, notices, before }
}
async function rpc(b: Butler, method: string, params: any, bearer = token) {
  const r = await fetch(b.listening, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'rpc-test', method, params }) })
  return { code: r.status, body: await r.json() as any }
}
const params = (id: string, text = '模拟Hermes提醒', immediate = true) => ({ message: { messageId: id, role: 'ROLE_USER', contextId: 'ctx-daily', parts: [{ text }] }, configuration: { returnImmediately: immediate } })
async function until(fn: () => Promise<boolean>) { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)) }; throw Error('Condition timed out') }

test('incoming message preserves a Unicode character split between HTTP chunks', async () => {
  const { b } = await instance()
  try {
    const text = '你好', body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: params('split-message', text) })), split = body.indexOf(Buffer.from(text)) + 1
    const request = Object.assign(Readable.from([body.subarray(0, split), body.subarray(split)]), { method: 'POST', url: '/', socket: { remoteAddress: '127.0.0.1' }, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
    let result: any
    await (b as any).serve(request, { writeHead: (code: number) => assert.equal(code, 200), end: (data: string) => { result = JSON.parse(data) } })
    assert.equal(result.result.task.history[0].parts[0].text, text)
  } finally { b.stop() }
})

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
    assert.equal(notices.length, 1); assert.ok(notices[0].body.includes('来自外部连接「Hermes」')); assert.equal(notices[0].runId, 'run_mock')
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
    else {
      if (r.params.id.startsWith('orca-connection-check:')) { res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: -32001, message: 'Task not found' } })); return }
      polls++
    }
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
    assert.equal(failed.task.status.state, 'TASK_STATE_FAILED'); assert.ok(failed.error!.includes('不会自动重发')); assert.ok(failed.error!.includes('HTTP 401'))
    assert.equal(sends, 3); b.stop(); await b.start(); await b.tick(); assert.equal(sends, 3)
    assert.deepEqual(storage.get('project:p1'), before)
  } finally { b.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) }
})

for (const [httpStatus, rpcCode, reason, connection, action] of [
  [401, -32050, 'unauthorized', '令牌错误', '对方的令牌'],
  [403, -32052, "peer 'ip:127.0.0.1' not trusted", '对方不信任', '信任名单'],
  [200, -32001, 'Task not found', '已连接', ''],
  [200, -32601, 'Method not found', '连接失败', 'A2A 接口'],
] as const) test(`connection check: HTTP ${httpStatus} / JSON-RPC ${rpcCode} → ${connection}`, async () => {
  const queries: any[] = []
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'GET') { res.end(JSON.stringify({ name: 'public mock Hermes', supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] })); return }
    assert.equal(req.headers.authorization, `Bearer ${other}`)
    assert.equal(req.headers['a2a-version'], '1.0')
    let raw = ''; for await (const c of req) raw += c
    const r = JSON.parse(raw); queries.push(r)
    res.writeHead(httpStatus)
    res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: rpcCode, message: `${reason} ${other} ${token}` } }))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { b, storage, notices } = await instance(`http://127.0.0.1:${(server.address() as any).port}`)
  try {
    const before = structuredClone([...storage])
    const s = await b.handle({ operation: 'check' })
    assert.equal(s.connection, connection)
    assert.equal(queries.length, 1); assert.equal(queries[0].method, 'GetTask')
    assert.ok(queries[0].params.id.startsWith('orca-connection-check:')); assert.equal(queries[0].params.historyLength, 0)
    if (connection !== '已连接') {
      for (const expected of [`HTTP ${httpStatus}`, `JSON-RPC ${rpcCode}`, reason, action]) assert.ok(s.error.includes(expected))
    } else assert.equal(s.error, '')
    assert.equal(JSON.stringify(s).includes(other), false); assert.equal(JSON.stringify(s).includes(token), false)
    assert.deepEqual([...storage], before); assert.deepEqual(notices, [])
    console.log(JSON.stringify({ check: connection, error: s.error, method: queries[0].method, writes: 0, notifications: notices.length }))
  } finally { b.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) }
})

test('connection check: unreachable service records network type and directs user to service/address', async () => {
  const server = http.createServer()
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as any).port}`
  await new Promise<void>(r => server.close(() => r()))
  const { b, notices } = await instance(url)
  try {
    const s = await b.handle({ operation: 'check' })
    assert.equal(s.connection, '服务不可达')
    for (const expected of ['TypeError', 'ECONNREFUSED', '对端服务', '对方的地址']) assert.ok(s.error.includes(expected))
    assert.deepEqual(notices, [])
    console.log(JSON.stringify({ check: s.connection, error: s.error, notifications: notices.length }))
  } finally { b.stop() }
})

test('send and poll failures preserve HTTP/RPC diagnostics, redact echoes, and never resend failed writes', async () => {
  let sends = 0, polls = 0, rejectPoll = true
  const privateText = '模拟私密请求正文，不能进入错误日志'
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c
    const r = JSON.parse(raw)
    res.setHeader('Content-Type', 'application/json')
    if (r.method === 'SendMessage') {
      sends++
      if (sends === 1) {
        res.writeHead(403)
        res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: -32052, message: `peer 'ip:127.0.0.1' not trusted ${other} ${token} ${privateText} ${raw}`, data: { token: other, request: raw } } }))
        return
      }
    } else {
      polls++
      if (rejectPoll) { res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: -32602, message: 'Invalid parameters' } })); return }
    }
    const task = { id: 'remote-diagnostic', contextId: 'ctx-daily', status: { state: r.method === 'GetTask' ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_WORKING' } }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: r.method === 'GetTask' ? task : { task } }))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { b, storage, notices, before } = await instance(`http://127.0.0.1:${(server.address() as any).port}`, true)
  try {
    const send = { operation: 'send' as const, runId: 'run_mock', requestId: 'diagnostic-failed', text: privateText }
    await b.handle(send); await b.tick(); await b.tick()
    const failed = (await b.handle({ operation: 'read' })).entries[0]
    for (const expected of ['HTTP 403', 'JSON-RPC -32052', "peer 'ip:127.0.0.1' not trusted", '不会自动重发']) assert.ok(failed.error!.includes(expected))
    for (const hidden of [other, token, privateText, '"jsonrpc"']) assert.equal(failed.error!.includes(hidden), false)
    assert.equal(failed.task.status.state, 'TASK_STATE_FAILED')
    assert.equal(failed.notification, 'uncertain'); assert.ok(failed.error!.includes('主 agent 通知结果待核对'))
    assert.equal(notices[0].body.includes(privateText), false)
    await b.handle(send); await b.tick(); assert.equal(sends, 1)
    await b.handle({ ...send, requestId: 'diagnostic-poll' }); await b.tick(); await b.tick()
    const polled = (await b.snapshot()).entries[1]
    for (const expected of ['HTTP 200', 'JSON-RPC -32602', 'Invalid parameters', '继续查询原任务']) assert.ok(polled.error!.includes(expected))
    assert.equal(polled.remoteId, 'remote-diagnostic'); assert.equal(polled.task.status.state, 'TASK_STATE_WORKING')
    assert.equal(sends, 2); assert.equal(polls, 1)
    rejectPoll = false; await b.tick()
    assert.equal((await b.snapshot()).entries[1].error, '主 agent 通知结果待核对，不自动重发'); assert.equal(sends, 2)
    assert.deepEqual(storage.get('project:p1'), before)
    console.log(JSON.stringify({ sendError: failed.error, pollError: polled.error, tokensRedacted: true, requestBodyRedacted: true, sends }))
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


test('A2A compacts completed payloads and keeps exact deduplication, failures stop one round', async () => {
  const f = await instance(undefined, true, '联系人甲')
  try {
    const entry = (id: string, notification: string, state: string, size = 1) => ({ id, direction: 'incoming', hash: id, notification,
      task: { id: 'task-' + id, contextId: 'context', status: { state, timestamp: new Date().toISOString() }, history: [{ messageId: id, role: 'ROLE_USER', parts: [{ text: 'x'.repeat(size) }] }] } })
    f.storage.set('workspace.a2a:butler', { version: 1, revision: 1, enabled: true, port: 0, url: 'http://127.0.0.1:9900', entries: [
      entry('ended', 'sent', 'TASK_STATE_COMPLETED', 185000), entry('first', 'pending', 'TASK_STATE_SUBMITTED'), entry('second', 'pending', 'TASK_STATE_SUBMITTED')] })
    await f.b.handle({ operation: 'save', revision: 1, enabled: false, port: 0, url: 'http://127.0.0.1:9900' })
    const send = { operation: 'send' as const, requestId: 'new-request', text: '测试', runId: 'run_mock' }
    await assert.rejects(() => f.b.handle(send), /请先启用「联系人甲」/)
    await assert.rejects(() => f.b.handle({ ...send, operation: 'reply', id: 'absent' }), /找不到「联系人甲」来源任务/)
    const compact = await f.b.snapshot()
    assert.equal(compact.entries[0].id, 'ended'); assert.equal(compact.entries[0].hash, 'ended'); assert.deepEqual(compact.entries[0].task.history, [])
    assert.equal(compact.entries[1].task.history.length, 1)
    f.storage.get('workspace.a2a:butler').enabled = true
    await (f.b as any).flushNotifications()
    assert.deepEqual((await f.b.snapshot()).entries.map(e => e.notification), ['sent', 'uncertain', 'pending']); assert.equal(f.notices.length, 1)
    const data = f.storage.get('workspace.a2a:butler')
    data.entries.push(...Array.from({ length: 101 }, (_, i) => entry('closed-' + i, 'sent', 'TASK_STATE_COMPLETED')))
    await f.b.handle({ operation: 'save', revision: data.revision, enabled: false, port: 0, url: data.url })
    const retained = (await f.b.snapshot()).entries
    assert.equal(retained.length, 102)
    assert.deepEqual(retained.slice(0, 3).map(e => e.id), ['first', 'second', 'closed-1'])
    assert.equal(retained.at(-1)?.id, 'closed-100')
  } finally { f.b.stop() }
})

test('A2A rejected storage writes never replace credentials', async () => {
  const f = await instance()
  try {
    await assert.rejects(() => f.b.handle({ operation: 'save', revision: 0, enabled: false, port: 0, url: 'http://127.0.0.1:9900', inboundToken: other, outboundToken: token }))
    const data = f.storage.get('workspace.a2a:butler'); data.entries = [{ id: 'pending', notification: 'pending', task: { status: { state: 'TASK_STATE_SUBMITTED' }, history: ['x'.repeat(200000)] } }]; f.storage.set('workspace.a2a:butler', data)
    await assert.rejects(() => f.b.handle({ operation: 'save', revision: data.revision, enabled: false, port: 0, url: data.url, inboundToken: other, outboundToken: token }))
    assert.equal(f.secrets.get('butler:inbound'), token); assert.equal(f.secrets.get('butler:outbound'), other)
  } finally { f.b.stop() }
})
