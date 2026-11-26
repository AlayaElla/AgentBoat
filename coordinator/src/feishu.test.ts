import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { testCoordinator as createCoordinator } from './test-runtime'
import { FeishuSources, normalizeFeishu, publicImageAddress, type MessageTransport } from './feishu'
import { deliverable, refs } from './fixtures'
import { fresh, ProjectStore, fingerprint } from './store'
import type { Delivery, SourceEvent } from './model'

const config = { enabled: true, appId: 'app_demo', chatIds: ['chat_demo'], senderIds: ['user_demo'] }
const event = (id: string, text: string, parent?: string, user = 'user_demo'): SourceEvent => normalizeFeishu('app_demo', {
  sender: { sender_type: 'user', sender_id: { open_id: user } },
  message: { message_id: id, chat_id: 'chat_demo', parent_id: parent, message_type: 'text', content: JSON.stringify({ text }) }
})!
async function fixture(main = true) {
  const sends: Delivery[] = [], mainSends: { run: string; delivery: Delivery }[] = []
  let failSend = false, coordinator!: ReturnType<typeof createCoordinator>
  const transport: MessageTransport = { state: () => ({ state: 'connected', message: '' }), sync: async () => {}, stop() {}, send: async d => {
    sends.push(structuredClone(d)); if (failSend) throw new Error('mock timeout'); return `sent_${sends.length}`
  } }
  const host = mockHost({ storage: {
    'workspace': { version: 1, revision: 1, runId: main ? 'run_main' : '', requests: [] },
    'workspace.messaging': { version: 1, revision: 0, feishu: config, inbox: [], deliveries: [] } as any,
    'project:p1': fresh(refs[0]) as any, 'project:p2': fresh(refs[1]) as any
  } })
  const worker = await mountWorker({ default: (api: OrcaWorkerApi) => { coordinator = createCoordinator(api, {
    projects: async () => refs, verifyRun: async () => {}, send: async (run, d) => { mainSends.push({ run, delivery: d }); return { requestId: 'mock_receipt' } }
  }, transport) } }, { host })
  const submit = async (task: unknown, requestId: string, projectId = 'p1') => {
    const p = await coordinator.store.get(projectId)
    await worker.request('project.agent', { operation: 'submit', projectId, revision: p.revision, requestId, task })
    await coordinator.flush(projectId)
  }
  const ingest = async (e: SourceEvent) => { await coordinator.ingest('app_demo', e); await coordinator.flushMailbox(); await coordinator.flush('p1') }
  return { worker, host, coordinator, transport, sends, mainSends, submit, ingest, timeout: () => { failSend = true } }
}

test('workspace Feishu settings do not modify project records and store credentials only in secrets', async () => {
  const f = await fixture()
  const before = await f.coordinator.store.all()
  const saved = await f.worker.request('workspace.connections', { operation: 'save', type: 'feishu', name: '飞书', revision: 0, feishu: config, appSecret: 'mock-only-secret' })
  assert.equal((saved as import('./connections').ConnectionDetail).feishu!.secretSaved, true)
  assert.equal(JSON.stringify(f.host.data().storage).includes('mock-only-secret'), false)
  assert.equal(f.host.data().secrets['feishu:@workspace'], 'mock-only-secret')
  assert.deepEqual(await f.coordinator.store.all(), before)
  await assert.rejects(() => f.worker.request('workspace.connections', { operation: 'save', type: 'feishu', name: '飞书', revision: 0, feishu: config }))
  await f.worker.deactivate()
})

test('workspace messages reach main once and agent replies return to the originating Feishu message', async () => {
  const f = await fixture(), e = event('hello', '项目现在怎么样？'), before = await f.coordinator.store.all()
  await Promise.all([f.ingest(e), f.ingest(e)])
  assert.equal(f.mainSends.length, 1)
  assert.equal(f.mainSends[0].run, 'run_main')
  assert.ok(f.mainSends[0].delivery.body.includes(e.id))
  const input = { runId: 'run_main', eventId: e.id, requestId: 'reply_demo', text: '正在处理，稍后给你结果。' }
  await f.worker.request('workspace.reply', input)
  await f.worker.request('workspace.reply', input)
  assert.equal(f.sends.length, 1)
  assert.equal(f.sends[0].external!.replyTo, 'hello')
  assert.equal(f.sends[0].external!.chatId, 'chat_demo')
  await assert.rejects(() => f.worker.request('workspace.reply', { ...input, runId: 'run_other' }))
  await assert.rejects(() => f.worker.request('workspace.reply', { ...input, text: 'different' }))
  await f.ingest(event('followup', '明天再看', 'sent_1'))
  assert.equal(f.mainSends.length, 2)
  assert.deepEqual(await f.coordinator.store.all(), before)
  await f.worker.deactivate()
})

test('reminders go directly to Feishu with options and review steps even without a main agent', async () => {
  const f = await fixture(false)
  await f.submit({ id: 'choose', title: '选择方向', goal: '确认方向', phase: 'blocked', decisions: [{ id: 'style', question: '选哪个？', options: ['浅色', '深色'] }] }, 'decision')
  await f.submit(deliverable, 'review')
  await f.submit({ id: 'done', title: '已完成', goal: '完成', phase: 'completed' }, 'done')
  assert.equal(f.mainSends.length, 0)
  assert.equal(f.sends.length, 4)
  assert.ok(f.sends.some(d => d.body.includes('1. 浅色\n2. 深色')))
  assert.ok(f.sends.some(d => d.body.includes(deliverable.acceptance[0].details) && d.external?.target?.itemRevision === 1))
  const count = f.sends.length
  await f.submit(deliverable, 'same'); await f.coordinator.start(); await f.coordinator.flush('p1')
  assert.equal(f.sends.length, count)
  await f.worker.deactivate()
})

test('quoted reminders record decisions, changes and acceptance on their exact project and version; duplicate events do nothing', async () => {
  const f = await fixture(false)
  await f.submit({ id: 'choose', title: '选择方向', goal: '确认方向', phase: 'working', decisions: [{ id: 'style', question: '选哪个？', options: ['浅色', '深色'] }] }, 'decision')
  const e = event('decision', '2', 'sent_1')
  await Promise.all([f.ingest(e), f.ingest(e)])
  let p = await f.coordinator.store.get('p1')
  assert.equal(p.tasks[0].decisions[0].answer, '深色')
  assert.equal(p.tasks[0].decisions[0].history.length, 1)
  assert.ok(p.tasks[0].decisions[0].history[0].note.includes('app_demo/decision'))
  assert.ok(p.tasks[0].decisions[0].history[0].note.endsWith('\n2'))
  await f.submit(deliverable, 'review')
  const reminder = (await f.coordinator.store.get('p1')).deliveries.find(d => d.external?.target?.kind === 'acceptance')!
  await f.ingest(event('changes', '修改：主按钮更醒目', reminder.external!.messageId))
  p = await f.coordinator.store.get('p1')
  const item = p.tasks.find(t => t.id === 'task-1')!.acceptance[0]
  assert.equal(item.status, 'changes_requested')
  assert.equal(item.history[0].revision, 1)
  assert.ok(item.history[0].note.endsWith('\n修改：主按钮更醒目'))
  await f.submit({ ...deliverable, artifacts: [{ ...deliverable.artifacts[0], id: 'v2', version: 'v2' }], acceptance: [{ ...deliverable.acceptance[0], artifactIds: ['v2'] }] }, 'review-v2')
  await f.ingest(event('stale', '通过', reminder.external!.messageId))
  p = await f.coordinator.store.get('p1')
  assert.equal(p.tasks.find(t => t.id === 'task-1')!.acceptance[0].history.length, 1)
  const latest = p.deliveries.find(d => d.external?.target?.itemRevision === 2)!
  const pass = event('pass', '@_user_1 通过', latest.external!.messageId)
  await f.ingest(pass); await f.ingest(pass)
  p = await f.coordinator.store.get('p1')
  const history = p.tasks.find(t => t.id === 'task-1')!.acceptance[0].history
  assert.deepEqual(history.map(h => [h.result, h.revision]), [['changes_requested', 1], ['passed', 2]])
  assert.equal((await f.coordinator.store.get('p2')).tasks.length, 0)
  // Recovering a saved inbound after the project commit must not record feedback twice.
  await f.coordinator.store.mutateMessaging(m => { m.inbox.find(x => x.event.id === pass.id)!.state = 'pending' })
  await f.coordinator.start()
  assert.equal((await f.coordinator.store.get('p1')).tasks.find(t => t.id === 'task-1')!.acceptance[0].history.length, 2)
  await f.worker.deactivate()
})

test('old Feishu reminders cannot pass a discarded review or answer a discarded decision', async () => {
  const f = await fixture(false)
  try {
    await f.submit({ ...deliverable, decisions: [{ id: 'style', question: '风格？', options: ['简洁'] }] }, 'original')
    await f.submit({ ...deliverable, acceptance: [{ id: 'page-check', discarded: true, reason: '已过期' }],
      decisions: [{ id: 'style', discarded: true, reason: '已过期' }] }, 'withdraw')
    const reminders = f.sends.filter(d => d.external?.target)
    assert.equal(reminders.length, 2)
    for (const d of reminders) {
      const decision = d.external!.target!.kind === 'decision'
      await f.ingest(event('late-' + d.id, decision ? '1' : '通过', 'sent_' + (f.sends.indexOf(d) + 1)))
    }
    const [t] = (await f.coordinator.store.get('p1')).tasks
    assert.deepEqual([t.acceptance[0].status, t.decisions[0].answer], ['discarded', null])
    assert.deepEqual([t.acceptance[0].history.length, t.decisions[0].history.length], [1, 1])
  } finally { await f.worker.deactivate() }
})

test('Feishu answers only the current decision presentation, including when the original artifacts return', async () => {
  const f = await fixture(false)
  const first = deliverable.artifacts[0], second = { ...first, id: 'comparison', version: 'v2' }
  const task = { id: 'choose', phase: 'working' }
  const choice = { id: 'style', question: '选哪个？', options: ['浅色', '深色'] }
  const receipt = async () => (await f.coordinator.store.get('p1')).deliveries.filter(d => d.external?.target?.kind === 'decision').at(-1)!
  try {
    await f.submit({ ...task, title: '选择方向', goal: '确认方向', artifacts: [first, second], decisions: [choice] }, 'initial')
    const bare = await receipt()
    assert.deepEqual(bare.external?.artifacts, [])
    await f.submit({ ...task, decisions: [{ id: choice.id, artifactIds: [first.id] }] }, 'attach')
    await f.ingest(event('before-attachment', '1', bare.external?.messageId))
    assert.match(f.sends.at(-1)!.body, /回复最新提醒/)
    const original = await receipt()
    await f.submit({ ...task, decisions: [{ id: choice.id, artifactIds: [second.id] }] }, 'replace')
    const replaced = await receipt()
    assert.deepEqual(replaced.external?.artifacts?.map(a => a.id), [second.id])
    await f.ingest(event('stale', '2', original.external?.messageId))
    assert.match(f.sends.at(-1)!.body, /回复最新提醒/)
    assert.equal((await f.coordinator.store.get('p1')).tasks[0].decisions[0].answer, undefined)
    await f.submit({ ...task, decisions: [{ id: choice.id, artifactIds: [first.id] }] }, 'restore')
    const current = await receipt()
    assert.equal(current.external?.target?.itemId, choice.id)
    assert.notEqual(current.external?.target?.presentation, original.external?.target?.presentation)
    assert.deepEqual(current.external?.artifacts?.map(a => a.id), [first.id])
    await f.ingest(event('old-again', '1', original.external?.messageId))
    assert.match(f.sends.at(-1)!.body, /回复最新提醒/)
    const answer = event('current', '2', current.external?.messageId)
    await Promise.all([f.ingest(answer), f.ingest(answer)])
    await f.coordinator.store.mutateMessaging(m => { m.inbox.find(x => x.event.id === answer.id)!.state = 'pending' })
    await f.coordinator.start()
    const saved = (await f.coordinator.store.get('p1')).tasks[0].decisions[0]
    assert.equal(saved.answer, '深色')
    assert.deepEqual(saved.history.map(h => h.result), ['深色'])
  } finally { f.coordinator.stop(); await f.worker.deactivate() }
})

test('Feishu accepts a provably current legacy reminder and rejects an unprovable receipt', async () => {
  const f = await fixture(false)
  const artifact = deliverable.artifacts[0]
  try {
    await f.submit({ id: 'choose', title: '选择方向', goal: '确认方向', phase: 'working', artifacts: [artifact], decisions: [
      { id: 'proved', question: '可核对？', options: ['是'], artifactIds: [artifact.id] },
      { id: 'unproved', question: '无法核对？', options: ['否'], artifactIds: [artifact.id] }
    ] }, 'initial')
    const reminders = await f.coordinator.store.mutate('p1', undefined, p => {
      for (const d of p.tasks[0].decisions) delete d.presentationRevision
      for (const delivery of p.deliveries) {
        const target = delivery.external?.target
        if (!target) continue
        delete target.presentation
        if (target.itemId === 'proved') delivery.createdAt = Date.parse(p.tasks[0].decisions[0].presentedAt!) + 1
        else delete delivery.createdAt
      }
    })
    for (const id of ['proved', 'unproved']) await f.ingest(event(id, '1', reminders.deliveries.find(d => d.external?.target?.itemId === id)?.external?.messageId))
    assert.match(f.sends.at(-1)!.body, /版本无法核对/)
    const [proved, unproved] = (await f.coordinator.store.get('p1')).tasks[0].decisions
    assert.deepEqual([proved.answer, proved.history.length, unproved.answer, unproved.history.length], ['是', 1, undefined, 0])
  } finally { f.coordinator.stop(); await f.worker.deactivate() }
})

test('unknown, ambiguous and unquoted feedback asks for clarification; unauthorized user and chat cannot write', async () => {
  const f = await fixture(false)
  await f.submit(deliverable, 'review')
  const before = await f.coordinator.store.all()
  await f.ingest(event('outsider', '通过', 'sent_1', 'stranger'))
  await f.ingest({ ...event('wrongchat', '通过', 'sent_1'), chatId: 'not_allowed' })
  assert.equal((await f.coordinator.store.messaging()).inbox.length, 0)
  assert.equal(f.sends.length, 1)
  await f.ingest(event('unquoted', '通过'))
  await f.ingest(event('unknown', '通过', 'not_found'))
  await f.ingest({ ...event('unknown_parent', '通过', 'not_found'), replyToIds: ['not_found', 'sent_1'] })
  await f.ingest(event('unclear', '可以', 'sent_1'))
  assert.ok(f.sends.slice(1).every(d => /请.*回复/.test(d.body)))
  assert.deepEqual(await f.coordinator.store.all(), before)
  await f.worker.deactivate()
})

test('timeout and restart keep Feishu sending uncertain without automatic resend', async () => {
  const f = await fixture(false)
  f.timeout(); await f.submit(deliverable, 'review')
  assert.equal((await f.coordinator.store.get('p1')).deliveries[0].state, 'uncertain')
  await f.coordinator.start(); await f.coordinator.flush('p1')
  assert.equal(f.sends.length, 1)
  await f.coordinator.store.mutateMessaging(m => { m.deliveries.push({ id: 'inflight', subject: 'mock', body: 'mock', state: 'sending', external: { channel: 'feishu', appId: 'app_demo', chatId: 'chat_demo' } }) })
  await f.coordinator.start()
  assert.equal((await f.coordinator.store.messaging()).deliveries[0].state, 'uncertain')
  assert.equal(f.sends.length, 1)
  await f.worker.deactivate()
})

test('restart initializes the Feishu transport before flushing saved pending reminders', async () => {
  const f = await fixture(false)
  await f.submit(deliverable, 'review')
  await new Promise<void>(resolve => setImmediate(resolve))
  await f.coordinator.store.mutate('p1', undefined, p => { p.deliveries[0].state = 'pending' })
  let ready = false
  f.transport.sync = async () => { await new Promise<void>(resolve => setImmediate(resolve)); ready = true }
  const send = f.transport.send
  f.transport.send = async d => { assert.equal(ready, true); return send(d) }
  await f.coordinator.start(); await f.coordinator.flush('p1')
  assert.equal((await f.coordinator.store.get('p1')).deliveries[0].state, 'sent')
  assert.equal(f.sends.length, 2)
  await f.worker.deactivate()
})

test('Feishu API adapter posts inline local images, hides file paths, and replies using the message API (mock only)', async () => {
  const dir = await mkdtemp(path.resolve('.orca/local-test/agentboat-demo-'))
  const file = path.join(dir, 'preview.png')
  await writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT9sAAAAASUVORK5CYII=', 'base64'))
  const calls: any[] = []
  const source = new FeishuSources(async () => {}, () => {})
  ;(source as any).clients.set('app_demo', { api: { im: {
    image: { create: async (input: any) => { assert.ok(Buffer.isBuffer(input.data.image)); return { image_key: 'img_demo' } } },
    message: { create: async (input: any) => { calls.push(input); return { code: 0, data: { message_id: 'created_demo' } } }, reply: async (input: any) => { calls.push(input); return { code: 0, data: { message_id: 'replied_demo' } } } }
  } } })
  const d: Delivery = { id: 'mock', subject: '验收图片', body: '核对布局', state: 'pending', external: { channel: 'feishu', appId: 'app_demo', chatId: 'chat_demo', root: dir,
    artifacts: [{ id: 'a', label: '预览', version: 'v1', url: file }, { id: 'b', label: '外部链接', version: 'v1', url: 'https://example.com/preview' }, { id: 'c', label: '说明', version: 'v1', url: path.join(dir, 'readme.md') }] } }
  assert.equal(await source.send(d), 'created_demo')
  assert.ok(calls[0].data.content.includes('img_demo'))
  assert.ok(calls[0].data.content.includes('在 App 里查看'))
  assert.equal(calls[0].data.content.includes(dir.replaceAll('\\', '\\\\')), false)
  assert.equal(calls[0].data.receive_id, 'chat_demo')
  assert.equal(await source.send({ ...d, external: { ...d.external!, replyTo: 'original_demo' } }), 'replied_demo')
  assert.equal(calls[1].path.message_id, 'original_demo')
  const remote = new FeishuSources(async () => {}, () => {}, async url => { assert.equal(url, 'https://example.com/image.png'); return Buffer.from('mock-image') })
  ;(remote as any).clients = (source as any).clients
  await remote.send({ ...d, external: { ...d.external!, artifacts: [{ id: 'remote', label: '网络图片', version: 'v1', url: 'https://example.com/image.png' }] } })
  assert.ok(calls[2].data.content.includes('img_demo'))
})

test('image download rejects local and reserved networks', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.0.1', '172.16.0.1', '100.64.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fc00::1', '2001:db8::1']) assert.equal(publicImageAddress(ip), false)
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(publicImageAddress(ip), true)
})

test('deleting Feishu preserves workspace request deduplication receipts', async () => {
  const f = await fixture()
  await f.worker.request('workspace.connections', { operation: 'save', type: 'feishu', name: '飞书', revision: 0, feishu: config, appSecret: 'mock-secret' })
  const receipt: Delivery = { id: 'workspace-request:peer:request:update', targetRunId: 'run_main', subject: '请求', body: '已通知', state: 'sent' }
  await f.coordinator.store.mutateMessaging(m => { m.deliveries.push(receipt, { ...receipt, id: 'feishu-delivery', external: { channel: 'feishu', appId: config.appId, chatId: 'chat_demo' } }) })
  await f.worker.request('workspace.connections', { operation: 'delete', connectionId: 'feishu', confirm: true })
  assert.deepEqual((await f.coordinator.store.messaging()).deliveries, [receipt]); assert.equal(f.host.data().secrets['feishu:@workspace'], undefined)
  await f.worker.deactivate()
})

test('mailbox stops a failed round with the remaining messages pending', async () => {
  const f = await fixture(false); f.timeout()
  await f.coordinator.store.mutateMessaging(m => { for (const id of ['first', 'second', 'third']) m.deliveries.push({ id, subject: 'mock', body: 'mock', state: 'pending', external: { channel: 'feishu', appId: config.appId, chatId: 'chat_demo' } }) })
  await f.coordinator.flushMailbox()
  assert.equal(f.sends.length, 1); assert.deepEqual((await f.coordinator.store.messaging()).deliveries.map(d => d.state), ['uncertain', 'pending', 'pending'])
  await f.worker.deactivate()
})

test('mailbox compacts finished payloads, keeps dedup hashes and preserves unfinished messages', async () => {
  const original = 'completed reply'.repeat(13000), pending = 'still pending'
  const receipt: Delivery = { id: 'agent-reply:done', subject: 'reply', body: original, state: 'sent', external: { channel: 'feishu', appId: 'app_demo', chatId: 'chat_demo', replyTo: 'done' } }
  const m = { version: 1, revision: 0, feishu: config, inbox: [{ appId: 'app_demo', event: event('done', original), state: 'done' }], deliveries: [receipt, { ...receipt, id: 'pending', state: 'pending', body: pending }] }
  const values = new Map<string, any>([['workspace.messaging', m]])
  const store = new ProjectStore({ get: async k => values.get(k), set: async (k,v) => { values.set(k,structuredClone(v)) }, keys: async () => [...values.keys()], delete: async k => { values.delete(k) } })
  const saved = await store.mutateMessaging(m => { m.feishu.enabled = false })
  assert.equal(saved.feishu.enabled, false); assert.ok(Buffer.byteLength(JSON.stringify(saved)) < 150000)
  assert.equal(saved.inbox[0].event.id, event('done','original').id); assert.equal(saved.inbox[0].event.text, '')
  assert.equal(saved.deliveries[0].receiptHash, fingerprint([original, 'done', 'app_demo'])); assert.equal(saved.deliveries[0].body, '')
  assert.equal(saved.deliveries[1].body, pending); assert.equal(saved.deliveries[1].state, 'pending')

  const open = event('unanswered', 'needs a reply')
  const recent = await store.mutateMessaging(m => {
    m.inbox.push({ appId: 'app_demo', event: open, state: 'done' })
    m.deliveries.push({ id: open.id, state: 'sent', subject: '', body: '' })
    for (let i = 0; i < 550; i++) {
      const id = 'closed-' + i
      m.inbox.push({ appId: 'app_demo', event: event(id, 'closed'), state: 'done' })
      m.deliveries.push({ ...receipt, id: 'agent-reply:' + id, body: '', external: { ...receipt.external!, replyTo: id } })
    }
    assert.ok(Buffer.byteLength(JSON.stringify(m)) > 200000)
    m.deliveries.push({ id: 'new', state: 'pending', subject: '', body: pending })
  })
  assert.equal(recent.inbox.length, 101)
  assert.equal(recent.inbox[0].event.text, open.text)
  assert.equal(recent.inbox[1].event.id, event('closed-450', 'closed').id)
  assert.equal(recent.deliveries.length, 103)
  assert.ok(recent.deliveries.some(d => d.id === open.id))
  assert.equal((await store.messaging()).deliveries.at(-1)?.id, 'new')
})

test('rejected Feishu saves leave existing credentials unchanged', async () => {
  const f = await fixture()
  await f.worker.request('workspace.connections', { operation: 'save', type: 'feishu', name: '飞书', revision: 0, feishu: config, appSecret: 'original-secret' })
  for (const appSecret of ['replacement-secret', '']) await assert.rejects(() => f.worker.request('workspace.connections', { operation: 'save', connectionId: 'feishu', name: '飞书', revision: 0, feishu: { ...config, appId: 'other-app', enabled: false }, appSecret }))
  assert.equal(f.host.data().secrets['feishu:@workspace'], 'original-secret')
  f.host.respond('storage.set', () => { throw Error('mock disk rejected') })
  for (const appSecret of ['replacement-secret', '']) await assert.rejects(() => f.worker.request('workspace.connections', { operation: 'save', connectionId: 'feishu', name: '飞书', revision: 1, feishu: { ...config, appId: 'other-app', enabled: false }, appSecret }))
  assert.equal(f.host.data().secrets['feishu:@workspace'], 'original-secret')
  await f.worker.deactivate()
})
