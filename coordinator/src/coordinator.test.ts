import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { createCoordinator } from './worker'
import { refs, deliverable } from './fixtures'
import { fresh, feedback, submitTask, ProjectStore } from './store'
import { report } from './links'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeFeishu } from './feishu'
import type { OrcaWorkerApi } from 'orca/worker'
import type { CoordinatorRuntime } from './runtime'

test('hide preserves legacy records and agent writes, excludes all workspace surfaces and pauses queued reminders until restore', async () => {
  const p = fresh(refs[0]); p.runId = 'run_project'
  submitTask(p, deliverable)
  p.deliveries.push({ id: 'queued-feishu', subject: 'queued', body: 'queued', state: 'pending', external: { channel: 'feishu', appId: 'test', chatId: 'chat' } },
    { id: 'queued-agent', subject: 'agent', body: 'agent', state: 'pending' })
  const host = mockHost({ storage: { 'project:p1': p as any, workspace: { version: 1, revision: 0, runId: 'run_main', requests: [] },
    'workspace.messaging': { version: 1, revision: 0, feishu: { enabled: true, appId: 'test', chatIds: ['chat'], senderIds: ['user'] }, inbox: [], deliveries: [] } } })
  const sends: string[] = [], agents: string[] = []
  let c!: ReturnType<typeof createCoordinator>
  const worker = await mountWorker({ default: (api: OrcaWorkerApi) => { c = createCoordinator(api, {
    projects: async () => refs, verifyRun: async () => {}, send: async run => { agents.push(run); return {} }
  }, { state: () => ({ state: 'connected', message: '' }), sync: async () => {}, stop() {}, send: async d => { sends.push(d.id); return 'sent' } }) } }, { host })
  try {
    assert.deepEqual((await worker.request('project.read', { projectId: 'p1' })).project, p)
    const hidden = (await worker.request('project.visibility', { projectId: 'p1', revision: 0, hidden: true })).project!
    assert.deepEqual(hidden.tasks, p.tasks)
    const all = await worker.request('workspace.overview')
    assert.deepEqual(all.projects.map(p => p.ref.id), ['p2']); assert.deepEqual(all.hidden, [refs[0]])
    assert.deepEqual(all.attention, [])
    assert.deepEqual(report([hidden], { scope: 'details', projectIds: ['p1'], acceptTasks: 'deny' }, 'own', 'own').projects, [])
    await worker.request('project.agent', { operation: 'submit', projectId: 'p1', revision: hidden.revision, requestId: 'hidden-submit', task: {
      id: 'hidden-task', title: '隐藏中继续工作', goal: '目标', phase: 'blocked', decisions: [{ id: 'ask', question: '隐藏中的问题' }]
    } })
    await c.flush('p1')
    assert.deepEqual(sends, []); assert.deepEqual(agents, ['run_project'])
    const saved = await c.store.get('p1')
    assert.equal(saved.tasks.length, 2)
    assert.equal(saved.deliveries.filter(d => d.external).length, 1)
    assert.equal(saved.deliveries.find(d => d.id === 'queued-feishu')!.state, 'pending')
    const restored = (await worker.request('project.visibility', { projectId: 'p1', revision: saved.revision, hidden: false })).project!
    await c.flush('p1')
    assert.deepEqual(sends, ['queued-feishu'])
    const visible = await worker.request('workspace.overview')
    assert.ok(visible.projects.some(p => p.ref.id === 'p1')); assert.equal(visible.hidden!.length, 0)
    assert.equal(visible.attention.length, 3)
    assert.equal(report([restored], { scope: 'details', projectIds: ['p1'], acceptTasks: 'deny' }, 'own', 'own').projects.length, 1)
    const current = await c.store.get('p1')
    await worker.request('project.agent', { operation: 'submit', projectId: 'p1', revision: current.revision, requestId: 'visible-submit', task: {
      id: 'visible-task', title: '恢复后提醒', goal: '目标', phase: 'blocked'
    } })
    await c.flush('p1'); assert.equal(sends.length, 2)
    assert.deepEqual(worker.refusals, [])
  } finally { c.stop(); await worker.deactivate() }
})

test('delete refreshes Orca catalog, requires exact confirmation and revision, exports the complete record before removing only its key', async () => {
  const p = fresh(refs[0]); submitTask(p, deliverable)
  const other = fresh(refs[1]), directory = await mkdtemp(path.join(os.tmpdir(), 'agentboat-delete-test-'))
  let catalog = refs, unavailable = false, c!: ReturnType<typeof createCoordinator>
  const host = mockHost({ storage: { 'project:p1': p as any, 'project:p2': other as any } })
  const worker = await mountWorker({ default: (api: OrcaWorkerApi) => { c = createCoordinator(api, {
    projects: async () => { if (unavailable) throw Error('offline'); return catalog }, verifyRun: async () => {}, send: async () => ({})
  }, undefined, directory) } }, { host })
  const input = { projectId: 'p1', revision: 0, confirm: 'p1' }
  try {
    await assert.rejects(() => worker.request('project.delete', { ...input, confirm: 'wrong' }))
    await assert.rejects(() => worker.request('project.delete', { ...input, revision: 99 }))
    await assert.rejects(() => worker.request('project.delete', input))
    catalog = [refs[1]]; unavailable = true
    await assert.rejects(() => worker.request('project.delete', input))
    assert.deepEqual(await readdir(directory), [])
    assert.deepEqual(await c.store.get('p1'), p)
    unavailable = false
    const answer = await worker.request('project.delete', input)
    assert.equal(answer.deleted, 'p1')
    assert.equal(path.dirname(answer.exportPath), directory)
    assert.deepEqual(JSON.parse(await readFile(answer.exportPath, 'utf8')), p)
    assert.deepEqual(await c.store.all(), [other]); assert.deepEqual(await c.store.get('p2'), other)
    assert.deepEqual((await worker.request('workspace.overview')).projects.map(p => p.ref.id), ['p2'])
    await assert.rejects(() => worker.request('project.delete', input))
    assert.equal((await readdir(directory)).length, 1)
  } finally { c.stop(); await worker.deactivate() }
})

test('failed export never deletes or alters a project', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentboat-export-failure-')), blocked = path.join(directory, 'file')
  await writeFile(blocked, 'not a directory')
  const p = fresh(refs[0]), values = new Map<string, any>([['project:p1', p]])
  const store = new ProjectStore({ get: async k => values.get(k), set: async (k, v) => { values.set(k, v) }, keys: async () => [...values.keys()],
    delete: async k => { values.delete(k) } }, blocked)
  await assert.rejects(() => store.remove('p1', 0, async () => {}))
  assert.deepEqual(await store.get('p1'), p)
})

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

test('overview reads legacy and closed projects without writing and includes every queue and execution', async () => {
  const p = fresh(refs[0]); p.runId = 'run_project'
  submitTask(p, { ...deliverable, executions: [{ runId: 'run_job', taskId: 'orca-task', dispatchId: 'dispatch', agent: 'codex' }] })
  submitTask(p, { id: 'blocked', title: '依赖受阻', goal: '修复依赖', phase: 'blocked', decisions: [{ id: 'ask', question: '选择方案？' }] })
  submitTask(p, { ...deliverable, id: 'rework' })
  feedback(p, { taskId: 'rework', kind: 'acceptance', itemId: 'page-check', itemRevision: 1, result: 'changes_requested', note: '调整标题' })
  const host = mockHost({ storage: { 'project:p1': p as any } })
  const before = structuredClone(host.data().storage)
  const runtime: CoordinatorRuntime = { projects: async () => [refs[1]], verifyRun: async () => {}, send: async () => { throw new Error('must not send') } }
  const worker = await mountWorker({ default: (orca: OrcaWorkerApi) => { createCoordinator(orca, runtime) } }, { host })
  const all = await worker.request('workspace.overview')
  assert.deepEqual(all.workspace, { revision: 0, runId: '' })
  assert.deepEqual(all.attention.map(a => a.kind).sort(), ['blocked', 'decision', 'review', 'rework'])
  assert.equal(all.projects.length, 2)
  assert.equal(all.projects[0].counts.review, 1)
  assert.equal(all.projects[0].agents[0].dispatchId, 'dispatch')
  assert.equal(all.projects[0].agents[0].projectTaskId, 'task-1')
  assert.deepEqual((await worker.request('project.agent', { operation: 'read', projectId: 'p1' })).project, p)
  assert.deepEqual(host.data().storage, before)
  await worker.deactivate()
})

test('workspace binding validates Runs, revisions and request replay, and supports a project coordinator Run', async () => {
  const p = fresh(refs[0]); p.runId = 'run_project'
  const host = mockHost({ storage: { 'project:p1': p as any } })
  const verified: string[] = []
  const runtime: CoordinatorRuntime = { projects: async () => refs, verifyRun: async id => { verified.push(id); if (id === 'invalid') throw new Error('invalid Run') }, send: async () => ({}) }
  const worker = await mountWorker({ default: (orca: OrcaWorkerApi) => { createCoordinator(orca, runtime) } }, { host })
  const input = { operation: 'bind' as const, revision: 0, requestId: 'main-bind', runId: 'run_project' }
  await assert.rejects(() => worker.request('workspace.agent', { ...input, runId: 'invalid' }))
  assert.deepEqual(await worker.request('workspace.agent', input), { revision: 1, runId: 'run_project' })
  assert.deepEqual(await worker.request('workspace.agent', input), { revision: 1, runId: 'run_project' })
  await assert.rejects(() => worker.request('workspace.agent', { ...input, runId: 'run_other' }))
  await assert.rejects(() => worker.request('workspace.agent', { ...input, requestId: 'stale' }))
  await assert.rejects(() => worker.request('project.agent', { operation: 'bind', projectId: 'p2', revision: 0, requestId: 'reuse', runId: 'run_project' }))
  assert.ok(verified.includes('run_project'))
  assert.deepEqual((await worker.request('workspace.overview')).workspace, { revision: 1, runId: 'run_project' })
  await worker.deactivate()
})

test('main messages use the existing source queue and retries never duplicate a delivery', async () => {
  const p = fresh(refs[0]); p.runId = 'run_project'
  const host = mockHost({ storage: { 'project:p1': p as any, workspace: { version: 1, revision: 1, runId: 'run_main', requests: [] } } })
  let coordinator!: ReturnType<typeof createCoordinator>
  const sends: { runId: string; body: string }[] = []
  const runtime: CoordinatorRuntime = { projects: async () => refs, verifyRun: async () => {}, send: async (runId, d) => { sends.push({ runId, body: d.body }); return { requestId: 'sent-main-message' } } }
  const worker = await mountWorker({ default: (orca: OrcaWorkerApi) => { coordinator = createCoordinator(orca, runtime) } }, { host })
  const input = { projectId: 'p1', revision: 0, requestId: 'message-1', runId: 'run_main', text: '请核对本项目进展' }
  await assert.rejects(() => worker.request('workspace.message', { ...input, runId: 'run_unknown' }))
  await assert.rejects(() => worker.request('workspace.message', { ...input, projectId: 'p2' }))
  await worker.request('workspace.message', input)
  await worker.request('workspace.message', input)
  await coordinator.flush('p1')
  const saved = await coordinator.store.get('p1')
  assert.equal(saved.events.length, 1)
  assert.equal(saved.events[0].source, 'workspace-agent')
  assert.equal(saved.events[0].senderId, 'run_main')
  assert.equal(saved.deliveries[0].requestId, 'sent-main-message')
  assert.equal(sends.length, 1)
  assert.equal(sends[0].runId, 'run_project')
  assert.ok(sends[0].body.includes('主 agent来源资料'))
  assert.equal((await coordinator.store.get('p2')).events.length, 0)
  await worker.deactivate()
})

test('project transitions notify main once, including new acceptance versions and completion after feedback', async () => {
  const host = mockHost({ storage: { workspace: { version: 1, revision: 1, runId: 'run_main', requests: [] } } })
  let coordinator!: ReturnType<typeof createCoordinator>
  const sends: { runId: string; body: string }[] = []
  const runtime: CoordinatorRuntime = { projects: async () => refs, verifyRun: async () => {}, send: async (runId, d) => { sends.push({ runId, body: d.body }); return { requestId: `sent-${sends.length}` } } }
  const worker = await mountWorker({ default: (orca: OrcaWorkerApi) => { coordinator = createCoordinator(orca, runtime) } }, { host })
  const submit = async (task: unknown, requestId: string) => {
    const p = await worker.request('project.read', { projectId: 'p1' })
    await worker.request('project.agent', { operation: 'submit', projectId: 'p1', revision: p.project!.revision, requestId, task })
    await coordinator.flush('p1')
  }
  await submit({ ...deliverable, phase: 'working' }, 'working')
  assert.equal(sends.length, 0)
  await submit(deliverable, 'ready')
  assert.equal(sends.length, 1)
  await submit(deliverable, 'same')
  assert.equal(sends.length, 1)
  await submit({ id: 'block', title: '受阻任务', goal: '确认依赖', phase: 'blocked', decisions: [{ id: 'ask', question: '如何选择？' }] }, 'block')
  assert.equal(sends.length, 3)
  await submit({ ...deliverable, artifacts: [{ ...deliverable.artifacts[0], id: 'v2', version: 'v2' }], acceptance: [{ ...deliverable.acceptance[0], artifactIds: ['v2'] }] }, 'v2')
  assert.equal(sends.length, 4)
  const p = await coordinator.store.get('p1')
  await worker.request('project.feedback', { projectId: 'p1', revision: p.revision, taskId: 'task-1', kind: 'acceptance', itemId: 'page-check', itemRevision: 2, result: 'passed' })
  await coordinator.flush('p1')
  assert.equal(sends.length, 5)
  assert.ok(sends.every(s => s.runId === 'run_main' && s.body.includes('项目 p1 / 任务')))
  assert.ok(sends.at(-1)!.body.includes('已完成'))
  await worker.request('workspace.overview')
  await coordinator.flush('p1')
  assert.equal(sends.length, 5)
  await worker.deactivate()
})

test('unbound main produces no notifications; restart keeps uncertain main delivery without resend', async () => {
  const host = mockHost()
  let coordinator!: ReturnType<typeof createCoordinator>, sends = 0
  const runtime: CoordinatorRuntime = { projects: async () => refs, verifyRun: async () => {}, send: async () => { sends++; throw new Error('timeout') } }
  const worker = await mountWorker({ default: (orca: OrcaWorkerApi) => { coordinator = createCoordinator(orca, runtime) } }, { host })
  await worker.request('project.agent', { operation: 'submit', projectId: 'p1', revision: 0, requestId: 'unbound', task: deliverable })
  assert.equal((await coordinator.store.get('p1')).deliveries.length, 0)
  await worker.request('workspace.agent', { operation: 'bind', revision: 0, requestId: 'main', runId: 'run_main' })
  // Binding and restarting never backfill old pending acceptance.
  await coordinator.start(); await coordinator.flush('p1')
  assert.equal(sends, 0)
  const p = await coordinator.store.get('p1')
  await worker.request('project.agent', { operation: 'submit', projectId: 'p1', revision: p.revision, requestId: 'block', task: { id: 'block', title: '阻塞', goal: '处理依赖', phase: 'blocked' } })
  await coordinator.flush('p1')
  assert.equal(sends, 1)
  const saved = await coordinator.store.get('p1')
  assert.equal(saved.deliveries[0].state, 'uncertain')
  await coordinator.start(); await coordinator.flush('p1')
  assert.equal(sends, 1)
  await coordinator.store.mutate('p1', undefined, p => { p.deliveries[0].state = 'sending' })
  await coordinator.start(); await coordinator.flush('p1')
  assert.equal((await coordinator.store.get('p1')).deliveries[0].state, 'uncertain')
  assert.equal(sends, 1)
  coordinator.stop(); await worker.deactivate()
})
