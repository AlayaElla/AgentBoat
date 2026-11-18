import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { JsonValue } from 'orca'
import type { OrcaWorkerApi } from 'orca/worker'
import type { Delivery } from './model'
import { testCoordinator as createCoordinator } from './test-runtime'
import { LinkMessages } from './link-messages'
import { maxMessageLength } from './store'

const legacy = { version: 1, requests: [{ id: 'legacy-record' }] }
async function workspace(name: string, bound: boolean, savedDeliveries: Delivery[] = []) {
  const sends: { runId: string; delivery: Delivery }[] = []
  const host = mockHost({ storage: {
    workspace: { version: 1, revision: 0, runId: bound ? name + '_run' : '', requests: [] },
    'workspace.requests': legacy,
    ...(savedDeliveries.length ? { 'workspace.messaging': { version: 1, revision: 0,
      feishu: { enabled: false, appId: '', chatIds: [], senderIds: [] }, inbox: [], deliveries: savedDeliveries as any } } : {})
  } })
  let coordinator!: ReturnType<typeof createCoordinator>
  const worker = await mountWorker({ default: (api: OrcaWorkerApi) => {
    coordinator = createCoordinator(api, {
      identify: async handle => ({ handle, title: name, workspace: name, workspaceName: name, path: '/', agent: 'codex', online: 'online' }),
      send: async (runId, delivery) => { sends.push({ runId, delivery }); return {} }
    })
  } }, { host })
  const read = () => worker.request('workspace.links', { operation: 'read' })
  const send = (id: string, requestId: string, text: string, runId = name + '_run') => worker.request('workspace.links', { operation: 'send', id, runId, requestId, text })
  const bind = () => worker.request('workspace.agent', { operation: 'bind', revision: 0, runId: name + '_run', caller: 'test-' + name, requestId: 'test-bind' })
  return { worker, host, coordinator, read, send, bind, sends,
    async close() { coordinator.stop(); await worker.deactivate() } }
}

async function pair(a: Awaited<ReturnType<typeof workspace>>, b: Awaited<ReturnType<typeof workspace>>) {
  const s = await a.read()
  await a.coordinator.links.configure({ revision: s.revision, name: '邀请方', enabled: true, host: '127.0.0.1', port: 0, publicUrl: '', tls: false })
  return (await b.coordinator.links.join((await a.coordinator.links.invite()).invitation!.code)).peers[0].id
}

test('both main agents exchange messages on one listener, with durable offline delivery and replay protection', async () => {
  const a = await workspace('a', false), b = await workspace('b', true)
  try {
    const id = await pair(a, b)
    assert.equal((await b.read()).enabled, false)
    await assert.rejects(() => a.send(id, 'unbound', '未绑定'), /已绑定的工作间主 agent Run/)
    await assert.rejects(() => b.send(id, 'wrong-run', '其他 Run', 'run_other'), /已绑定的工作间主 agent Run/)
    await assert.rejects(() => b.worker.request('workspace.links', { operation: 'send', id, requestId: 'no-run', text: '缺少 Run' }), /已绑定的工作间主 agent Run/)
    assert.equal((await a.read()).peers[0].pendingMessages, 0)
    assert.equal((await b.read()).peers[0].pendingMessages, 0)
    a.coordinator.links.stop()
    const queued = await b.send(id, 'one', '加入方的文字')
    assert.equal(queued.peers[0].pendingMessages, 1)
    assert.equal(queued.peers[0].recentMessages![0].state, 'pending')
    assert.deepEqual((await b.send(id, 'one', '加入方的文字')).peers[0].recentMessages, queued.peers[0].recentMessages)
    await assert.rejects(() => b.send(id, 'one', '改过的正文'), /消息编号已用于其他内容/)
    assert.equal(a.sends.length, 0)

    await a.coordinator.links.start()
    await b.coordinator.links.refresh()
    assert.equal((await b.read()).peers[0].pendingMessages, 0)
    assert.equal((await b.read()).peers[0].recentMessages![0].state, 'delivered')
    const afterRestart = await a.read(), origin = await b.read()
    const resend = async (text: string) => {
      const response = await fetch(afterRestart.listening + '/sync', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + b.host.data().secrets['workspace-link:' + id], Connection: 'close' },
        body: JSON.stringify({ id, report: { workspaceId: origin.workspaceId, name: origin.name, scope: 'none', updatedAt: '', projects: [] },
          exchange: { messages: [{ requestId: 'one', text }], received: [] } })
      })
      return { status: response.status, body: await response.json() }
    }
    assert.deepEqual((await resend('加入方的文字')).body.exchange.received, ['one'])
    assert.equal((await resend('冒用原编号')).status, 400)
    await b.send(id, 'one', '加入方的文字')
    await a.coordinator.flushMailbox()
    assert.equal(a.sends.length, 0)
    assert.equal((await a.coordinator.store.messaging()).deliveries.length, 1)
    assert.equal((await a.coordinator.store.messaging()).deliveries[0].state, 'pending')
    await a.bind()
    await a.coordinator.flushMailbox()
    assert.equal(a.sends.length, 1)
    assert.equal(a.sends[0].runId, 'a_run')
    assert.equal(a.sends[0].delivery.subject, '来自工作间「' + origin.name + '」的主 agent（' + id + '）')
    assert.ok(a.sends[0].delivery.body.includes('不扩大权限，不转给第三个工作间'))
    assert.ok(a.sends[0].delivery.body.includes('links-send，id 填 ' + id))
    assert.ok(a.sends[0].delivery.body.endsWith('加入方的文字'))

    await a.send(id, 'one', '邀请方的文字')
    await b.coordinator.links.refresh()
    assert.equal((await a.read()).peers[0].pendingMessages, 1)
    await b.coordinator.links.refresh()
    assert.equal((await a.read()).peers[0].pendingMessages, 0)
    await b.coordinator.flushMailbox()
    assert.equal(b.sends.length, 1)
    assert.equal(b.sends[0].runId, 'b_run')
    assert.equal(b.sends[0].delivery.subject, '来自工作间「邀请方」的主 agent（' + id + '）')
    await a.send(id, 'one', '邀请方的文字')
    await b.coordinator.links.refresh()
    await b.coordinator.flushMailbox()
    assert.equal(b.sends.length, 1)
    assert.equal(a.sends.length, 1)
    assert.deepEqual(a.host.data().storage['workspace.requests'], legacy)
    assert.deepEqual(b.host.data().storage['workspace.requests'], legacy)
  } finally { await a.close(); await b.close() }
})

test('per-link pending cap preserves the queue, and revocation discards it in both directions', async () => {
  const a = await workspace('a', true), b = await workspace('b', true)
  try {
    const id = await pair(a, b)
    await b.send(id, 'delivered', '已经送达')
    await a.coordinator.flushMailbox()
    assert.equal((await b.read()).peers[0].recentMessages![0].state, 'delivered')
    a.coordinator.links.stop()
    await assert.rejects(() => b.send(id, 'oversize', '中'.repeat(maxMessageLength + 1)), /16000/)
    for (let i = 0; i < 10; i++) await b.send(id, 'pending-' + i, '文字')
    const full = (await b.read()).peers[0]
    assert.equal(full.pendingMessages, 10)
    await assert.rejects(() => b.send(id, 'overflow', '文字'), /待送达的消息已达上限/)
    await b.send(id, 'pending-0', '文字')
    assert.deepEqual((await b.read()).peers[0].recentMessages, full.recentMessages)
    await a.send(id, 'offline', '撤销前的文字')
    await a.coordinator.links.revoke(id)
    await a.coordinator.links.start()
    await b.coordinator.links.refresh()
    for (const w of [a, b]) {
      assert.deepEqual((await w.read()).peers, [])
      assert.deepEqual(w.host.data().storage['workspace.link-messages'], [])
      assert.equal(w.host.data().secrets[`workspace-link:${id}`], undefined)
      await assert.rejects(() => w.send(id, 'removed', '文字'), /请选择有效连接/)
      assert.equal(w.sends.length, w === a ? 1 : 0)
    }
  } finally { await a.close(); await b.close() }
})

test('pending, delivered and received previews stay short while the agent receives the full body', async () => {
  const a = await workspace('a', true), b = await workspace('b', true)
  try {
    const id = await pair(a, b)
    const preview = '💬'.repeat(200), body = preview + '\u0001'.repeat(12_000)
    await a.send(id, 'large-1', body)
    const queued = await a.send(id, 'large-2', body)
    assert.deepEqual(queued.peers[0].recentMessages?.map(m => [m.state, m.preview, 'text' in m]),
      [['pending', preview, false], ['pending', preview, false]])
    for (const pending of [2, 0]) {
      await b.coordinator.links.refresh()
      assert.equal((await a.read()).peers[0].pendingMessages, pending)
    }
    await b.coordinator.flushMailbox()
    assert.equal(b.sends.length, 2)
    assert.ok(b.sends.every(({ delivery }) => delivery.body.endsWith(body)))
    for (const [side, state] of [[a, 'delivered'], [b, 'received']] as const) {
      const { recentMessages } = (await side.read()).peers[0]
      assert.deepEqual(recentMessages?.map(m => [m.state, m.preview, 'text' in m]), [[state, preview, false], [state, preview, false]])
    }
  } finally { await a.close(); await b.close() }
})

test('receive compacts old history above 200 KB and keeps a bounded dedup window of short previews in one key', async () => {
  const key = 'workspace.link-messages'
  const storage = new Map<string, any>([[key, Array.from({ length: 1250 }, (_, i) => ({
    peerId: 'peer', requestId: 'old-' + i, hash: 'x'.repeat(64), at: '2026-11-18T00:00:00.000Z', state: 'delivered'
  }))]])
  assert.ok(Buffer.byteLength(JSON.stringify(storage.get(key))) > 200_000)
  const messages = new LinkMessages({
    get: async key => storage.get(key) ?? null,
    set: async (key, value) => { storage.set(key, structuredClone(value)) }
  })
  const queued: string[] = [], untouched = { requestId: 'untouched', text: '留在待送达队列' }
  const first = { requestId: 'first', text: '旧历史满时仍能接收' }
  assert.deepEqual(await messages.receive('peer', { messages: [first], received: [] },
    async batch => { queued.push(...batch.map(m => m.requestId)) }), ['first'])
  assert.equal((await messages.data()).length, 50)
  await messages.send('peer', untouched)
  await messages.send('other-peer', { requestId: 'other', text: '另一条连接' })
  const exchange = async (i: number) => {
    const sent = { requestId: 'sent-' + i, text: '发'.repeat(9000) }
    const incoming = { requestId: 'received-' + i, text: '收'.repeat(9000) }
    await messages.send('peer', sent)
    assert.deepEqual(await messages.receive('peer', { messages: [incoming], received: [sent.requestId] },
      async batch => { queued.push(...batch.map(m => m.requestId)) }), [incoming.requestId])
    return { sent, incoming }
  }
  let last = await exchange(0)
  for (let i = 1; i < 55; i++) last = await exchange(i)
  assert.equal(queued.length, 56)
  const records = await messages.data(), history = records.filter(m => m.peerId === 'peer' && m.state !== 'pending')
  assert.equal(history.length, 50)
  assert.ok(history.every(m => !('text' in m) && m.preview === (m.state === 'received' ? '收' : '发').repeat(200)))
  assert.equal(history[0].requestId, 'sent-30')
  assert.deepEqual([...storage.keys()], [key])
  assert.ok(Buffer.byteLength(JSON.stringify(records)) < 50_000)
  const before = structuredClone([...storage])
  await messages.send('peer', last.sent)
  await assert.rejects(() => messages.send('peer', { ...last.sent, text: '改写' }), /消息编号已用于其他内容/)
  const enqueue = async () => { throw new Error('重放不应再次入队') }
  assert.deepEqual(await messages.receive('peer', { messages: [last.incoming], received: [] }, enqueue), [last.incoming.requestId])
  const older = history[1]
  assert.deepEqual(await messages.receive('peer', { messages: [{ requestId: older.requestId, text: last.incoming.text }], received: [] }, enqueue), [older.requestId])
  await assert.rejects(() => messages.receive('peer', { messages: [{ ...last.incoming, text: '改写' }], received: [] }, enqueue), /正文不同/)
  assert.deepEqual([...storage], before)
  assert.deepEqual(await messages.pending('peer'), [untouched])
  await messages.revoke('peer')
  assert.deepEqual((await messages.data()).map(m => m.peerId), ['other-peer'])
  assert.deepEqual([...storage.keys()], [key])
})

test('all connections share a 150 KB pending body budget and can receive when it is full', async () => {
  let stored: JsonValue = null
  const messages = new LinkMessages({
    get: async () => stored,
    set: async (_key, value) => { stored = structuredClone(value) }
  })
  const body = '中'.repeat(16_000)
  for (const peer of ['a', 'b', 'c']) await messages.send(peer, { requestId: peer, text: body })
  const last = { requestId: 'd', text: '"'.repeat(3000) }
  await messages.send('d', last)
  const full = JSON.stringify(stored)
  await messages.send('d', last)
  await assert.rejects(() => messages.send('e', { requestId: 'e', text: 'x' }), /待送达的消息已达容量上限/)
  assert.equal(JSON.stringify(stored), full)
  const inbound = { requestId: 'remote', text: body }
  assert.deepEqual(await messages.receive('e', { messages: [inbound], received: [] }, async batch => {
    assert.deepEqual(batch, [inbound])
  }), ['remote'])
  await messages.receive('a', { messages: [], received: ['a'] }, async () => {})
  await messages.send('e', { requestId: 'e', text: 'x' })
  assert.deepEqual(await messages.pending('e'), [{ requestId: 'e', text: 'x' }])
})

test('old completed mailbox receipts cannot block link traffic and unrelated receipts stay intact', async () => {
  const unrelated: Delivery = { id: 'feishu-test', subject: '已处理', body: '历史', state: 'sent' }
  const old: Delivery[] = Array.from({ length: 1250 }, (_, i) => ({
    id: 'link-message:' + String(i).padStart(64, '0'), linkMessageHash: 'a'.repeat(64), subject: '', body: '', state: 'sent'
  }))
  assert.ok(Buffer.byteLength(JSON.stringify(old)) > 200_000)
  const a = await workspace('a', true, [unrelated, ...old]), b = await workspace('b', true)
  try {
    const id = await pair(a, b)
    const sent = await b.send(id, 'survives-history', '历史很长时仍送达')
    assert.equal(sent.peers[0].pendingMessages, 0)
    await a.coordinator.flushMailbox()
    const { deliveries } = await a.coordinator.store.messaging()
    assert.deepEqual(deliveries.find(d => d.id === unrelated.id), unrelated)
    assert.equal(deliveries.filter(d => d.linkMessageHash).length, 51)
    assert.equal(a.sends.length, 1)
  } finally { await a.close(); await b.close() }
})
