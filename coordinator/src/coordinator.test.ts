import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { testCoordinator as createCoordinator } from './test-runtime'
import { refs, deliverable } from './fixtures'
import { fresh, feedback, submitTask, ProjectStore, overview, notifyWorkspace } from './store'
import { report } from './links'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { CoordinatorRuntime } from './runtime'
import { assertProjectIdle, OrcaRuntime } from './runtime'
import { groupedAttention } from './model'
const mainSession = { handle: 'orca_session_id:test-main', title: '测试主会话', workspace: 'id:test', workspaceName: '测试工作区', path: '/test', agent: 'claude', online: 'online' as const }

test('connections isolate multiple A2A configs, tokens and histories', async () => {
  const legacy = { version: 1, revision: 2, enabled: false, port: 9901, url: 'http://127.0.0.1:9900', entries: [] }
  const token = 'test-only-token-12345678901234567890', host = mockHost({ storage: { 'workspace.connections': { version: 1, entries: [{ id: 'butler', name: 'Hermes', type: 'a2a' }] }, 'workspace.a2a:butler': legacy, workspace: { version: 1, revision: 0, runId: 'run_main', requests: [] } }, secrets: { 'butler:inbound': token, 'butler:outbound': token } })
  let c!: ReturnType<typeof createCoordinator>
  const worker = await mountWorker({ default: (api: OrcaWorkerApi) => { c = createCoordinator(api, { projects: async () => [], verifyRun: async () => {}, hermesApprovalMode: async () => 'smart', send: async () => ({}) }) } }, { host })
  try {
    const list = await worker.request('workspace.connections', { operation: 'read' }) as import('./connections').Connection[]
    assert.equal(list[0].name, 'Hermes'); assert.equal(list[0].id, 'butler')
    assert.equal((await worker.request('workspace.connections', { operation: 'read', name: 'Hermes' }) as import('./connections').ConnectionDetail).approvalMode, 'smart')
    await assert.rejects(() => worker.request('workspace.connections', { operation: 'save', type: 'a2a', name: 'Hermes', enabled: false, port: 0, url: legacy.url }), /名字不能重复/)
    assert.deepEqual(host.data().storage['workspace.a2a:butler'], legacy)
    const added = await worker.request('workspace.connections', { operation: 'save', type: 'a2a', name: 'Second', enabled: true, port: 0, url: 'http://127.0.0.1:9999', inboundToken: token + 'second', outboundToken: token + 'peer' }) as import('./connections').ConnectionDetail
    assert.notEqual(added.connection.id, 'butler'); assert.ok(added.a2a!.listening)
    assert.deepEqual(host.data().storage['workspace.a2a:butler'], legacy); assert.equal(host.data().secrets['butler:inbound'], token)
    const rpc = async (bearer: string) => fetch(added.a2a!.listening, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'missing' } }) })
    assert.equal((await rpc(token)).status, 401)
    assert.equal(((await (await rpc(token + 'second')).json()) as any).error.code, -32001)
    const inbound = await fetch(added.a2a!.listening, { method: 'POST', headers: { Authorization: `Bearer ${token}second`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'SendMessage', params: { message: { messageId: 'second-only', role: 'ROLE_USER', parts: [{ text: 'mock isolated message' }] }, configuration: { returnImmediately: true } } }) })
    assert.equal(inbound.status, 200)
    const isolated = await worker.request('workspace.connections', { operation: 'read', connectionId: added.connection.id }) as import('./connections').ConnectionDetail
    assert.equal(isolated.a2a!.entries.length, 1); assert.deepEqual(host.data().storage['workspace.a2a:butler'], legacy)
    await assert.rejects(() => worker.request('workspace.connections', { operation: 'save', connectionId: added.connection.id, name: 'Second', enabled: true, port: 0, url: added.a2a!.url, revision: isolated.a2a!.revision, inboundToken: token + 'changed', outboundToken: 'short' }))
    assert.equal(host.data().secrets[`${added.connection.id}:inbound`], token + 'second')
    const renamed = await worker.request('workspace.connections', { operation: 'save', connectionId: added.connection.id, name: 'Renamed', enabled: true, port: 0, url: added.a2a!.url, revision: isolated.a2a!.revision }) as import('./connections').ConnectionDetail
    assert.equal(renamed.connection.name, 'Renamed')
    assert.equal((await worker.request('workspace.connections', { operation: 'read', name: 'Renamed' }) as import('./connections').ConnectionDetail).a2a!.inboundSecretSaved, true)
    await assert.rejects(() => worker.request('workspace.connections', { operation: 'send', name: 'Renamed', runId: 'wrong', requestId: 'x', text: 'mock' }))
    await worker.request('workspace.connections', { operation: 'delete', connectionId: added.connection.id, confirm: true })
    assert.equal(host.data().secrets[`${added.connection.id}:inbound`], undefined)
    assert.equal((await worker.request('workspace.connections', { operation: 'read' }) as any[]).length, 1)
    assert.deepEqual(host.data().storage['workspace.a2a:butler'], legacy)
    assert.equal(JSON.stringify(host.data().storage).includes(token), false)
  } finally { c.stop(); await worker.deactivate() }
})

test('remove uses exact setup, checks every session and terminal, and fails closed on incomplete inventory', async () => {
  const ref = refs[0], idle = { repoId: ref.repoId, hostId: ref.hostId, path: ref.path, worktreeId: 'w', agents: [], liveTerminalCount: 0, unverifiableTerminalCount: 0, hasAttachedPty: false }
  for (const patch of [{ agents: [{ subagentObservation: 'live' }] }, { liveTerminalCount: 1 }, { unverifiableTerminalCount: 1 }, { hasAttachedPty: true }]) assert.throws(() => assertProjectIdle(ref, { worktrees: [{ ...idle, ...patch }] }, { terminals: [] }), /先关掉/)
  assert.throws(() => assertProjectIdle(ref, { worktrees: [idle], truncated: true }, { terminals: [] }), /不完整/)
  assert.throws(() => assertProjectIdle(ref, { worktrees: [idle] }, { terminals: [{ repoId: ref.repoId }] }), /先关掉/)
  assertProjectIdle(ref, { worktrees: [idle] }, { terminals: [] })
  const calls: string[][] = [], runtime = new OrcaRuntime(async () => 'unused')
  ;(runtime as any).call = async (args: string[]) => { calls.push(args); return args[0] === 'project' && args[1] === 'setups' ? { setups: [{ ...idle, id: 'exact' }] } : args[0] === 'terminal' ? { terminals: [] } : { worktrees: args.includes('ps') && !calls.some(a => a[1] === 'setup-delete') ? [idle] : [] } }
  await runtime.removeProject(ref)
  assert.deepEqual(calls.find(a => a[1] === 'setup-delete'), ['project', 'setup-delete', '--setup', 'exact', '--force'])
})

test('attention counts reviews per task and excludes rework consistently', () => {
  const p = fresh(refs[0]); submitTask(p, deliverable)
  p.tasks[0].acceptance.push({ ...p.tasks[0].acceptance[0], id: 'second' })
  const all = requireOverview(p)
  assert.equal(groupedAttention(all.attention).length, 1); assert.equal(groupedAttention(all.attention)[0].count, 2)
  p.tasks[0].acceptance.forEach(a => a.status = 'changes_requested')
  assert.equal(groupedAttention(requireOverview(p).attention).length, 0)
})
function requireOverview(p: import('./model').Project) { return overview(p ? [p] : [], { version: 1, revision: 0, runId: '', requests: [] }) }

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
    assert.equal((await readdir(directory)).length, 1)
    assert.deepEqual(await c.store.get('p1'), p)
    unavailable = false
    const answer = await worker.request('project.delete', input)
    assert.equal(answer.deleted, 'p1')
    assert.equal(path.dirname(answer.exportPath), directory)
    assert.deepEqual(JSON.parse(await readFile(answer.exportPath, 'utf8')), p)
    assert.deepEqual(await c.store.all(), [other]); assert.deepEqual(await c.store.get('p2'), other)
    assert.deepEqual((await worker.request('workspace.overview')).projects.map(p => p.ref.id), ['p2'])
    await assert.rejects(() => worker.request('project.delete', input))
    assert.equal((await readdir(directory)).length, 2)
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
  const runtime: Partial<CoordinatorRuntime> = { projects: async () => refs, verifyRun: async () => {}, send: async () => ({}) }
  const host = mockHost()
  const worker = await mountWorker({ default: (orca: OrcaWorkerApi) => { createCoordinator(orca, runtime) } }, { host })
  await worker.request('project.read', { projectId: 'p1' })
  const input = { operation: 'submit' as const, projectId: 'p1', revision: 0, requestId: 'r1', task: deliverable }
  const a = await worker.request('project.agent', input)
  assert.equal(a.project!.revision, 1)
  assert.equal((await worker.request('project.agent', input)).project!.revision, 1)
  await assert.rejects(() => worker.request('project.agent', { ...input, task: { ...deliverable, title: 'changed' } }))
  await assert.rejects(() => worker.request('project.agent', { ...input, requestId: 'stale' }))
  const settings = { projectId: 'p1', revision: 1, roles: fresh(refs[0]).roles }
  const writes = await Promise.allSettled([worker.request('project.settings', settings), worker.request('project.settings', settings)])
  assert.equal(writes.filter(x => x.status === 'fulfilled').length, 1)
  assert.equal(JSON.stringify(host.data().storage).includes('private'), false)
  const second = await worker.request('project.read', { projectId: 'p2' })
  assert.equal(second.project!.tasks.length, 0)
  await assert.rejects(() => worker.request('project.agent', { ...input, projectId: 'not-here' }))
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('acceptance keeps user conclusions and resets only changed items', () => {
  const p = fresh(refs[0])
  submitTask(p, { ...deliverable, acceptance: [...deliverable.acceptance, { ...deliverable.acceptance[0], id: 'stable', title: '文字' }] })
  for (const a of p.tasks[0].acceptance) feedback(p, { items: [{ taskId: 'task-1', kind: 'acceptance', itemId: a.id, itemRevision: 1, result: 'passed' }] })
  submitTask(p, deliverable)
  assert.equal(p.tasks[0].acceptance[0].status, 'passed')
  submitTask(p, { ...deliverable, artifacts: [{ ...deliverable.artifacts[0], id: 'page-v2', version: 'v2' }], acceptance: [{ ...deliverable.acceptance[0], artifactIds: ['page-v2'] }] })
  assert.deepEqual(p.tasks[0].acceptance.map(a => [a.id, a.status, a.revision]), [['page-check', 'pending', 2], ['stable', 'passed', 1]])
  assert.equal(p.tasks[0].acceptance[0].history.length, 1)
  assert.throws(() => feedback(p, { items: [{ taskId: 'task-1', kind: 'acceptance', itemId: 'page-check', itemRevision: 1, result: 'passed' }] }))
  assert.throws(() => submitTask(p, { ...deliverable, phase: 'completed' }))
  assert.throws(() => submitTask(p, { ...deliverable, artifacts: [{ ...deliverable.artifacts[0], url: 'D:\\Other\\secret.txt' }] }))
})

test('restart preserves an in-flight notification without resending', async () => {
  const p = fresh(refs[0]); p.runId = 'run_test'
  p.deliveries.push({ id: 'old', subject: 'prior', body: 'saved', state: 'sending' })
  const host = mockHost({ storage: { 'project:p1': p as any } })
  let coordinator!: ReturnType<typeof createCoordinator>, sends = 0
  const runtime: Partial<CoordinatorRuntime> = { projects: async () => refs, verifyRun: async () => {}, send: async () => { sends++; return {requestId:'receipt'} } }
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
  feedback(p, { items: [{ taskId: 'rework', kind: 'acceptance', itemId: 'page-check', itemRevision: 1, result: 'changes_requested', note: '调整标题' }] })
  const host = mockHost({ storage: { 'project:p1': p as any } })
  const before = structuredClone(host.data().storage)
  const runtime: Partial<CoordinatorRuntime> = { projects: async () => [refs[1]], verifyRun: async () => {}, send: async () => { throw new Error('must not send') } }
  const worker = await mountWorker({ default: (orca: OrcaWorkerApi) => { createCoordinator(orca, runtime) } }, { host })
  const all = await worker.request('workspace.overview')
  assert.equal(all.workspace.revision, 0); assert.equal(all.workspace.runId, '')
  assert.deepEqual(all.attention.map(a => a.kind).sort(), ['blocked', 'decision', 'review', 'rework'])
  assert.equal(all.projects.length, 2)
  assert.equal(all.projects[0].counts.review, 1)
  assert.equal(all.projects[0].agents[0].dispatchId, 'dispatch')
  assert.equal(all.projects[0].agents[0].projectTaskId, 'task-1')
  assert.deepEqual((await worker.request('project.agent', { operation: 'read', projectId: 'p1' })).project, p)
  assert.deepEqual({ ...host.data().storage, 'workspace.connections': undefined }, { ...before, 'workspace.connections': undefined })
  await worker.deactivate()
})

test('workspace binding validates Runs, revisions, occupied project Runs and request replay', async () => {
  const p = fresh(refs[0]); p.runId = 'run_project'
  const host = mockHost({ storage: { 'project:p1': p as any } })
  const verified: string[] = []
  const runtime: Partial<CoordinatorRuntime> = { projects: async () => refs, identify: async () => mainSession, verifyRun: async id => { verified.push(id); if (id === 'invalid') throw new Error('invalid Run') }, send: async () => ({}) }
  const worker = await mountWorker({ default: (orca: OrcaWorkerApi) => { createCoordinator(orca, runtime) } }, { host })
  const input = { operation: 'bind' as const, revision: 0, requestId: 'main-bind', runId: 'run_workspace', caller: mainSession.handle }
  await assert.rejects(() => worker.request('workspace.agent', { ...input, runId: 'run_project', checkOnly: true }))
  await assert.rejects(() => worker.request('workspace.agent', { ...input, runId: 'invalid' }))
  const bound = await worker.request('workspace.agent', input)
  assert.equal(bound.runId, 'run_workspace'); assert.equal(bound.session?.handle, mainSession.handle)
  assert.deepEqual(await worker.request('workspace.agent', input), bound)
  await assert.rejects(() => worker.request('workspace.agent', { ...input, runId: 'run_other' }))
  await assert.rejects(() => worker.request('workspace.agent', { ...input, requestId: 'stale' }))
  await assert.rejects(() => worker.request('project.agent', { operation: 'bind', projectId: 'p2', revision: 0, requestId: 'reuse', runId: 'run_project' }))
  assert.ok(verified.includes('run_project'))
  assert.deepEqual((await worker.request('workspace.overview')).workspace, bound)
  await worker.deactivate()
})

test('main messages use the existing source queue and retries never duplicate a delivery', async () => {
  const p = fresh(refs[0]); p.runId = 'run_project'
  const host = mockHost({ storage: { 'project:p1': p as any, workspace: { version: 1, revision: 1, runId: 'run_main', requests: [] } } })
  let coordinator!: ReturnType<typeof createCoordinator>
  const sends: { runId: string; body: string }[] = []
  const runtime: Partial<CoordinatorRuntime> = { projects: async () => refs, verifyRun: async () => {}, send: async (runId, d) => { sends.push({ runId, body: d.body }); return { requestId: 'sent-main-message' } } }
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
  const runtime: Partial<CoordinatorRuntime> = { projects: async () => refs, verifyRun: async () => {}, send: async (runId, d) => { sends.push({ runId, body: d.body }); return { requestId: `sent-${sends.length}` } } }
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
  assert.equal(sends.length, 2)
  await submit({ ...deliverable, artifacts: [{ ...deliverable.artifacts[0], id: 'v2', version: 'v2' }], acceptance: [{ ...deliverable.acceptance[0], artifactIds: ['v2'] }] }, 'v2')
  assert.equal(sends.length, 3)
  const p = await coordinator.store.get('p1')
  await worker.request('project.feedback', { projectId: 'p1', revision: p.revision, items: [{ taskId: 'task-1', kind: 'acceptance', itemId: 'page-check', itemRevision: 2, result: 'passed'  }] })
  await coordinator.flush('p1')
  assert.equal(sends.length, 4)
  assert.ok(sends.every(s => s.runId === 'run_main' && s.body.includes('项目 p1 / 任务')))
  assert.ok(sends.at(-1)!.body.includes('已完成'))
  await worker.request('workspace.overview')
  await coordinator.flush('p1')
  assert.equal(sends.length, 4)
  await worker.deactivate()
})

test('unbound main produces no notifications; restart keeps uncertain main delivery without resend', async () => {
  const host = mockHost()
  let coordinator!: ReturnType<typeof createCoordinator>, sends = 0
  const runtime: Partial<CoordinatorRuntime> = { projects: async () => refs, identify: async () => mainSession, verifyRun: async () => {}, send: async () => { sends++; throw new Error('timeout') } }
  const worker = await mountWorker({ default: (orca: OrcaWorkerApi) => { coordinator = createCoordinator(orca, runtime) } }, { host })
  await worker.request('project.agent', { operation: 'submit', projectId: 'p1', revision: 0, requestId: 'unbound', task: deliverable })
  assert.equal((await coordinator.store.get('p1')).deliveries.length, 0)
  await worker.request('workspace.agent', { operation: 'bind', revision: 0, requestId: 'main', runId: 'run_main', caller: mainSession.handle })
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


test('Feishu connection rename/delete/recreate keeps project data and credentials isolated', async () => {
  const project = fresh(refs[0]), feishu = { enabled: false, appId: 'test-workspace-app', chatIds: ['test-chat'], senderIds: ['test-user'] }
  const host = mockHost({ storage: { 'workspace.connections': { version: 1, entries: [{ id: 'feishu', name: '??', type: 'feishu' }] }, 'project:p1': project as any, 'workspace.messaging': { version: 1, revision: 4, feishu, inbox: [], deliveries: [] } }, secrets: { 'feishu:@workspace': 'test-workspace-secret', 'feishu:p1': 'test-project-secret' } })
  let c!: ReturnType<typeof createCoordinator>
  const worker = await mountWorker({ default: (api: OrcaWorkerApi) => { c = createCoordinator(api, { projects: async () => refs, verifyRun: async () => {}, send: async () => ({}) }, { state: () => ({ state: 'off', message: '' }), sync: async () => {}, stop() {}, send: async () => 'sent' }) } }, { host })
  try {
    const list = await worker.request('workspace.connections', { operation: 'read' }) as import('./connections').Connection[]
    assert.deepEqual(list.map(c => c.type), ['feishu'])
    const renamed = await worker.request('workspace.connections', { operation: 'save', connectionId: 'feishu', name: 'Notifications', revision: 4, feishu }) as import('./connections').ConnectionDetail
    assert.equal(renamed.connection.name, 'Notifications'); assert.equal(host.data().secrets['feishu:@workspace'], 'test-workspace-secret')
    await assert.rejects(() => worker.request('workspace.connections', { operation: 'save', type: 'feishu', name: 'Another', revision: 0, feishu }), /已经有飞书/)
    await assert.rejects(() => worker.request('workspace.connections', { operation: 'delete', connectionId: 'feishu' }), /请确认/)
    await worker.request('workspace.connections', { operation: 'delete', connectionId: 'feishu', confirm: true })
    assert.equal(host.data().secrets['feishu:@workspace'], undefined)
    assert.deepEqual(await worker.request('workspace.connections', { operation: 'read' }), [])
    const recreated = await worker.request('workspace.connections', { operation: 'save', type: 'feishu', name: 'New notifications', revision: 0, feishu, appSecret: 'test-new-secret' }) as import('./connections').ConnectionDetail
    assert.equal(recreated.connection.id, 'feishu'); assert.ok(recreated.feishu!.revision > renamed.feishu!.revision)
    assert.equal(host.data().secrets['feishu:@workspace'], 'test-new-secret')
    assert.equal(host.data().secrets['feishu:p1'], 'test-project-secret'); assert.deepEqual(host.data().storage['project:p1'], project)
  } finally { c.stop(); await worker.deactivate() }
})

test('batch feedback validates every item before one commit and one summary delivery', async () => {
  const p = fresh(refs[0]); p.runId = 'project-run'
  submitTask(p, { ...deliverable, decisions: [{ id: 'direction', question: '方向？', options: ['甲', '乙'] }] })
  const items = [{ taskId: 'task-1', kind: 'acceptance', itemId: 'page-check', itemRevision: 1, result: 'passed' },
    { taskId: 'task-1', kind: 'decision', itemId: 'direction', answer: '甲' }]
  const before = structuredClone(p)
  for (const invalid of [[items[0], { ...items[1], itemId: 'missing' }], [items[0], null], [items[0], items[0]]]) {
    assert.throws(() => feedback(p, { items: invalid }), /第 2 条/); assert.deepEqual(p, before)
  }
  for (const phase of ['working', 'blocked', 'completed', 'paused'] as const) {
    p.tasks[0].phase = phase
    assert.throws(() => feedback(p, { items: [items[0]] })); assert.equal(p.tasks[0].acceptance[0].status, 'pending')
  }
  p.tasks[0].phase = 'ready'; p.tasks[0].acceptance[0].status = 'changes_requested'
  assert.throws(() => feedback(p, { items: [items[0]] })); p.tasks[0].acceptance[0].status = 'pending'
  assert.throws(() => feedback(p, items[0]), /反馈条目/)
  const values = new Map<string, any>([['project:p1', p]])
  const store = new ProjectStore({ get: async k => values.get(k), set: async (k,v) => { values.set(k,structuredClone(v)) }, keys: async () => [...values.keys()], delete: async k => { values.delete(k) } })
  const saved = await store.mutate('p1', 0, p => feedback(p, { items }))
  assert.equal(saved.revision, 1); assert.equal(saved.deliveries.length, 1)
  assert.equal(saved.tasks[0].acceptance[0].status, 'passed'); assert.equal(saved.tasks[0].decisions[0].answer, '甲')
  assert.ok(saved.deliveries[0].body.includes('验收通过')); assert.ok(saved.deliveries[0].body.includes('决定已提交'))
  await assert.rejects(() => store.mutate('p1', 1, p => feedback(p, { items: [items[1]] })), /问题已回答/)
  assert.equal((await store.get('p1')).revision, 1)
})

test('one submission produces one workspace summary and retains per-item deduplication', () => {
  const before = fresh(refs[0]), after = structuredClone(before)
  submitTask(after, { ...deliverable, decisions: [{ id: 'one', question: '第一项？' }, { id: 'two', question: '第二项？' }] })
  notifyWorkspace(before, after, 'main-run')
  assert.equal(after.deliveries.length, 1); assert.equal(after.deliveries[0].noticeKeys!.length, 3)
  assert.ok(after.deliveries[0].body.includes('第一项')); assert.ok(after.deliveries[0].body.includes('第二项')); assert.ok(after.deliveries[0].body.includes('请用户验收'))
  notifyWorkspace(before, after, 'main-run'); assert.equal(after.deliveries.length, 1)
  const prior = structuredClone(after)
  submitTask(after, { ...deliverable, decisions: [{ id: 'three', question: '第三项？' }] })
  notifyWorkspace(prior, after, 'main-run')
  assert.equal(after.deliveries.length, 2); assert.equal(after.deliveries[1].noticeKeys!.length, 1)
})

test('empty connections reads never write defaults or migrate old keys', async () => {
  const host = mockHost({ storage: { 'workspace.butler': { version: 1, enabled: false }, 'workspace.messaging': { version: 1, revision: 0, feishu: { enabled: false, appId: 'residual', chatIds: [], senderIds: [] }, inbox: [], deliveries: [] } } })
  const before = structuredClone(host.data().storage)
  const worker = await mountWorker({ default: (api: OrcaWorkerApi) => { createCoordinator(api, {}) } }, { host })
  try { assert.deepEqual(await worker.request('workspace.connections', { operation: 'read' }), []); assert.deepEqual(host.data().storage, before) }
  finally { await worker.deactivate() }
})
