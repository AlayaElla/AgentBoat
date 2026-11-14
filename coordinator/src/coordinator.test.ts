import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { createCoordinator } from './worker'
import { refs, deliverable } from './fixtures'
import { fresh, feedback, submitTask } from './store'
import { normalizeFeishu } from './feishu'
import type { OrcaWorkerApi } from 'orca/worker'
import type { CoordinatorRuntime } from './runtime'

test('concurrent requests, replay and project boundaries preserve records', async () => {
  const runtime: CoordinatorRuntime = { projects: async () => refs, verifyRun: async () => {}, send: async () => ({}) }
  const host = mockHost()
  const worker = await mountWorker({ default: (orca: OrcaWorkerApi) => { createCoordinator(orca, runtime) } }, { host })
  await worker.request('project.read', { projectId: 'p1' })
  const input = { operation: 'submit' as const, projectId: 'p1', revision: 0, requestId: 'r1', task: deliverable }
  const a = await worker.request('project.agent', input)
  assert.equal(a.project!.revision, 1)
  assert.equal((await worker.request('project.agent', input)).project!.revision, 1)
  await assert.rejects(() => worker.request('project.agent', { ...input, task: { ...deliverable, title: 'changed' } }))
  await assert.rejects(() => worker.request('project.agent', { ...input, requestId: 'stale' }))
  const settings = { projectId: 'p1', revision: 1, roles: fresh(refs[0]).roles, feishu: { enabled: false, appId: 'app', chatIds: ['chat1'], senderIds: ['user1'] }, appSecret: 'private' }
  const writes = await Promise.allSettled([worker.request('project.settings', settings), worker.request('project.settings', settings)])
  assert.equal(writes.filter(x => x.status === 'fulfilled').length, 1)
  assert.equal(JSON.stringify(host.data().storage).includes('private'), false)
  assert.equal(host.data().secrets['feishu:p1'], 'private')
  const second = await worker.request('project.read', { projectId: 'p2' })
  assert.equal(second.project!.tasks.length, 0)
  await assert.rejects(() => worker.request('project.settings', { ...settings, projectId: 'p2', revision: 0 }))
  await assert.rejects(() => worker.request('project.agent', { ...input, projectId: 'not-here' }))
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('acceptance keeps user conclusions and resets only changed items', () => {
  const p = fresh(refs[0])
  submitTask(p, { ...deliverable, acceptance: [...deliverable.acceptance, { ...deliverable.acceptance[0], id: 'stable', title: '文字' }] })
  for (const a of p.tasks[0].acceptance) feedback(p, { taskId: 'task-1', kind: 'acceptance', itemId: a.id, itemRevision: 1, result: 'passed' })
  submitTask(p, deliverable)
  assert.equal(p.tasks[0].acceptance[0].status, 'passed')
  submitTask(p, { ...deliverable, artifacts: [{ ...deliverable.artifacts[0], id: 'page-v2', version: 'v2' }], acceptance: [{ ...deliverable.acceptance[0], artifactIds: ['page-v2'] }] })
  assert.deepEqual(p.tasks[0].acceptance.map(a => [a.id, a.status, a.revision]), [['page-check', 'pending', 2], ['stable', 'passed', 1]])
  assert.equal(p.tasks[0].acceptance[0].history.length, 1)
  assert.throws(() => feedback(p, { taskId: 'task-1', kind: 'acceptance', itemId: 'page-check', itemRevision: 1, result: 'passed' }))
  assert.throws(() => submitTask(p, { ...deliverable, phase: 'completed' }))
  assert.throws(() => submitTask(p, { ...deliverable, artifacts: [{ ...deliverable.artifacts[0], url: 'D:\\Other\\secret.txt' }] }))
})

test('Feishu routing deduplicates, links threads and does not resend uncertain notifications', async () => {
  const p = fresh(refs[0]); p.runId = 'run_test'
  p.feishu = { enabled: true, appId: 'app', chatIds: ['chat'], senderIds: ['user'] }
  const other = fresh(refs[1])
  const host = mockHost({ storage: { 'project:p1': p as any, 'project:p2': other as any } })
  let coordinator!: ReturnType<typeof createCoordinator>, sends = 0
  const runtime: CoordinatorRuntime = { projects: async () => refs, verifyRun: async () => {}, send: async () => { sends++; throw new Error('timeout') } }
  const worker = await mountWorker({ default: (orca: OrcaWorkerApi) => { coordinator = createCoordinator(orca, runtime) } }, { host })
  const raw = { sender: { sender_type: 'user', sender_id: { open_id: 'user' } }, message: { message_id: 'm1', chat_id: 'chat', message_type: 'text', content: JSON.stringify({ text: '新增需求' }) } }
  const event = normalizeFeishu('app', raw)!
  assert.equal(normalizeFeishu('app', { ...raw, sender: { ...raw.sender, sender_type: 'app' } }), null)
  assert.equal(normalizeFeishu('app', { ...raw, message: { ...raw.message, content: 'null' } }), null)
  await coordinator.ingest('app', { ...event, senderId: 'stranger' })
  assert.equal((await coordinator.store.get('p1')).events.length, 0)
  await coordinator.ingest('app', event)
  await coordinator.ingest('app', event)
  await coordinator.flush('p1')
  assert.equal(sends, 1)
  assert.equal((await coordinator.store.get('p1')).deliveries[0].state, 'uncertain')
  await coordinator.flush('p1'); assert.equal(sends, 1)
  await coordinator.store.mutate('p1', undefined, p => submitTask(p, { ...deliverable, sourceIds: [event.id] }))
  const reply = normalizeFeishu('app', { ...raw, message: { ...raw.message, message_id: 'm2', root_id: 'm1' } })!
  await coordinator.ingest('app', reply)
  await coordinator.flush('p1')
  const saved = await coordinator.store.get('p1')
  assert.equal(saved.events.length, 2)
  assert.equal(saved.events[1].taskId, 'task-1')
  assert.ok(saved.tasks[0].sourceIds.includes(reply.id))
  assert.equal((await coordinator.store.get('p2')).events.length, 0)
  await worker.deactivate()
})

test('restart preserves an in-flight notification without resending', async () => {
  const p = fresh(refs[0]); p.runId = 'run_test'
  p.deliveries.push({ id: 'old', subject: 'prior', body: 'saved', state: 'sending' })
  const host = mockHost({ storage: { 'project:p1': p as any } })
  let coordinator!: ReturnType<typeof createCoordinator>, sends = 0
  const runtime: CoordinatorRuntime = { projects: async () => refs, verifyRun: async () => {}, send: async () => { sends++; return {requestId:'receipt'} } }
  const worker = await mountWorker({ default: async (orca: OrcaWorkerApi) => { coordinator = createCoordinator(orca, runtime); await coordinator.start() } }, { host })
  await coordinator.flush('p1')
  assert.equal((await coordinator.store.get('p1')).deliveries[0].state, 'uncertain')
  assert.equal(sends, 0)
  coordinator.stop()
  await worker.deactivate()
})
