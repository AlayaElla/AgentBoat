import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { testCoordinator as createCoordinator } from './test-runtime'
import { refs, deliverable, sample } from './fixtures'
import { fresh, feedback, fingerprint, submitTask, ProjectStore, overview, notifyWorkspace } from './store'
import { report } from './links'
import { notifyFeishu } from './feishu'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { CoordinatorRuntime } from './runtime'
import { assertProjectIdle, OrcaRuntime, revealArtifact } from './runtime'
import { attention, groupedAttention, taskState } from './model'
import { inboxLimit, openRunMail, questionWait, questionMaxAge } from '../scripts/orca-questions.mjs'
import { escalationWait, projectSubmissions, reportSubmitted, reportWait, workerReport } from '../scripts/worker-reports.mjs'
const mainSession = { handle: 'orca_session_id:test-main', title: '测试主会话', workspace: 'id:test', workspaceName: '测试工作区', path: '/test', agent: 'claude', online: 'online' as const }

test('panel results reject invalid nested fields and log the request and path before transport', async () => {
  let value: unknown
  const worker = await mountWorker({ default: api => { createCoordinator(api, { targets: async () => ({ sessions: [], workspaces: [value] as any }) }) } }, { host: mockHost() })
  try {
    const read = () => worker.request('workspace.agent.targets')
    const child = { ok: true }
    value = { a: child, b: child, empty: Object.create(null), inherited: Object.create(child) }
    assert.equal((await read()).workspaces.length, 1)
    for (const invalid of [undefined, NaN, Infinity, -Infinity, 1n, Symbol(), () => {}, new Date(), new Map(), new Set(), new class {}()]) {
      value = { field: invalid }
      await assert.rejects(read, /workspace\.agent\.targets.*\$\.workspaces\[0\]\.field/)
      assert.match(worker.logs.at(-1)!, /workspace\.agent\.targets.*\$\.workspaces\[0\]\.field/)
    }
    const cycle: { loop?: object } = {}
    cycle.loop = cycle
    value = cycle
    await assert.rejects(read, /workspaces\[0\]\.loop.*循环引用/)
    value = Array(1)
    await assert.rejects(read, /workspaces\[0\]\[0\].*undefined/)
    value = { [Symbol()]: true }
    await assert.rejects(read, /workspaces\[0\]\[Symbol\]/)
  } finally { await worker.deactivate() }
})

test('hook-change reminder waits for a bound workspace and is sent once per release across restarts', async () => {
  const host = mockHost(), sent: string[] = []
  let c!: ReturnType<typeof createCoordinator>
  for (const version of ['1.0.0', '1.0.0', '1.0.1']) {
    const worker = await mountWorker({ default: api => { c = createCoordinator(api, {
      send: async (run, d) => { assert.equal(run, 'run_main'); sent.push(d.body); return {} }
    }) } }, { host })
    try {
      await c.start(version)
      await c.flushMailbox()
      if (!sent.length) {
        assert.equal((await c.store.messaging()).deliveries[0].state, 'pending')
        await c.store.mutateWorkspace(w => { w.runId = 'run_main' })
        await c.flushMailbox()
      }
    } finally { c.stop(); await worker.deactivate() }
  }
  assert.equal(sent.length, 2)
  assert.ok(sent[0].includes('1.0.0') && sent[1].includes('1.0.1'))
})

test('project content and client receipts return while background session inventory is slow', async () => {
  const p = { ...fresh(refs[0]), runId: 'run_project', mainAgentHandle: mainSession.handle }
  const host = mockHost({ storage: { 'project:p1': p as any } })
  let c!: ReturnType<typeof createCoordinator>, entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const inventory = new Promise<void>(resolve => { release = resolve })
  const worker = await mountWorker({ default: api => { c = createCoordinator(api, {
    projects: async () => refs,
    targets: async () => { entered(); await inventory; throw Error('inventory timed out') }
  }) } }, { host })
  const background = c.checkBackups()
  await started
  const timer = setTimeout(release, 800), start = performance.now()
  try {
    const [panel, receipt] = await Promise.all([
      worker.request('project.read', { projectId: 'p1' }),
      worker.request('project.agent', { operation: 'submit', projectId: 'p1', requestId: 'slow', revision: 0, task: deliverable })
    ])
    const elapsed = Math.round(performance.now() - start)
    console.log('slow inventory / project.read + submit receipt:', elapsed, 'ms')
    assert.equal(panel.project?.ref.id, 'p1')
    assert.equal(receipt.project?.requests.at(-1)?.id, 'slow')
    assert.ok(elapsed < 500)
  } finally { clearTimeout(timer); release(); await background; c.stop(); await worker.deactivate() }
})

test('overdue Run questions remind the project once and clear on a matching reply', async () => {
  const p = fresh(refs[0]); p.runId = 'run_fake'
  const host = mockHost({ storage: { 'project:p1': p as any, workspace: { version: 1, revision: 0, runId: 'run_main', session: mainSession, requests: [] } } })
  const ask = { id: 'msg_question', from_handle: 'dispatch:fake', to_handle: 'run:run_fake', run_id: 'run_fake', thread_id: 'msg_question',
    type: 'question', subject: 'Question', sequence: 10, created_at: new Date().toISOString(), body: '请登录\n从这台机器打开浏览器', read: 1 }
  const noise = Array.from({ length: inboxLimit - 3 }, (_, i) => ({ ...ask, id: 'msg_noise' + i, type: 'status', sequence: i + 20 }))
  const reply = { ...ask, id: 'msg_reply', from_handle: 'run:run_fake', to_handle: ask.from_handle, type: 'status', subject: 'Re: Question', sequence: 11 }
  const status = { runId: p.runId, taskId: 'orca-task', dispatchId: 'fake', dispatchStatus: 'dispatched', workerState: 'ready' }
  const task = { id: status.taskId, run_id: p.runId, status: 'dispatched', completed_at: null }
  let rows = [...noise, ask, { ...reply, to_handle: 'dispatch:wrong' }, { ...reply, thread_id: 'msg_other' }, { ...reply, type: 'question' }], failure = true
  const sent: string[] = [], runs: string[] = []
  let c!: ReturnType<typeof createCoordinator>
  const worker = await mountWorker({ default: api => { c = createCoordinator(api, { projects: async () => refs,
    mail: async run => { runs.push(run); if (failure) throw Error('fixture failure'); return openRunMail(rows, run, async () => ({ workers: [status], tasks: [task] })) },
    send: async (run, { body }) => { assert.equal(run, p.runId); sent.push(body); return {} } }) } }, { host })
  const pending = async () => (await worker.request('workspace.overview')).questions
  try {
    await c.refreshQuestions()
    assert.deepEqual(await pending(), []); assert.equal(sent.length, 0)
    failure = false
    await c.refreshQuestions()
    assert.deepEqual(await pending(), [])
    ask.created_at = new Date(Date.now() - questionWait - 1000).toISOString()
    await Promise.all([c.refreshQuestions(), c.refreshQuestions()])
    assert.deepEqual(await pending(), [{ id: ask.id, projectId: 'p1', runId: p.runId, from: ask.from_handle, title: '请登录', body: ask.body, at: Date.parse(ask.created_at) }])
    await c.flushMailbox()
    assert.equal(sent.length, 1)
    assert.ok(sent[0].includes(ask.body))
    await c.updateStatus()
    assert.ok((host.callsOf('statusBar.update').at(-1) as any).text.endsWith('待处理 0'))
    await c.refreshQuestions(); await c.flushMailbox()
    assert.equal(sent.length, 1)
    task.status = 'completed'
    await c.refreshQuestions()
    assert.deepEqual(await pending(), [])
    task.status = 'dispatched'
    failure = true
    await c.refreshQuestions()
    assert.deepEqual(await pending(), [])
    failure = false
    rows = [{ ...reply, sequence: 9 }, ...rows]
    await c.refreshQuestions()
    assert.equal((await pending())?.length, 1)
    rows = [reply, ...rows]
    await c.store.mutateMessaging(m => { m.deliveries[0].runNotice!.attemptedAt = Date.now() - escalationWait - 1000 })
    await c.refreshQuestions(); await c.flushMailbox()
    assert.deepEqual(await pending(), [])
    assert.equal(sent.length, 1)
    assert.equal((await c.store.messaging()).deliveries.length, 1)
    await c.store.mutate('p1', undefined, changed => { changed.runId = 'run_replaced' })
    assert.deepEqual(await pending(), [])
    await c.refreshQuestions()
    assert.equal(runs.at(-1), 'run_replaced')
    assert.deepEqual(await pending(), [])
  } finally { c.stop(); await worker.deactivate() }
})

test('questions and worker reports require recent mail from a verified unfinished dispatch and task', async () => {
  const run = 'run_fixture', now = Date.now()
  const row = (id: string, dispatch: string, age = questionWait + 1) => ({
    id, from_handle: 'dispatch:' + dispatch, to_handle: 'run:' + run, run_id: run, type: 'question',
    subject: 'Question', sequence: 1, created_at: new Date(now - age).toISOString(), body: '请登录'
  })
  const worker = (id: string, taskId = 'open', overrides = {}) => ({
    dispatchId: id, runId: run, taskId, dispatchStatus: 'dispatched', workerState: 'ready', ...overrides
  })
  const report = (id: string, dispatch: string, taskId: string, from: string, age: number) =>
    ({ ...row(id, dispatch, age), type: 'worker_done', from_handle: from, payload: JSON.stringify({ taskId, dispatchId: dispatch, outcome: 'succeeded' }) })
  const historicSenders = ['structworker_7fa88d8f', 'structworker_636a98be', 'structworker_441cd3ca']
  const messages = [
    row('recent', 'live'), row('edge', 'live', questionMaxAge), row('too-new', 'live', questionWait),
    row('expired', 'live', questionMaxAge + 1), row('finished', 'ended'), row('closed', 'released'),
    row('finished-task', 'ended-task'), row('worker-done', 'settled'), row('unverified', 'unknown'),
    { ...row('send-as-user', 'live'), from_handle: 'orca_session_id:untagged' },
    { ...row('legacy', 'live'), from_handle: 'structworker_fixture', payload: '{"dispatchId":"live","taskId":"open"}' },
    { ...row('wrong-sender', 'live'), from_handle: 'structworker_other', payload: '{"dispatchId":"live","taskId":"open"}' },
    ...historicSenders.map((handle, i) =>
      report('historic-' + i, 'historic-' + i, 'open', handle, (5 + i % 2) * questionMaxAge)),
    report('recent-report', 'live', 'open', 'structworker_fixture', reportWait + 1),
    report('too-new-report', 'live', 'open', 'structworker_fixture', reportWait),
    report('ended-dispatch', 'ended', 'open', 'dispatch:ended', reportWait + 1),
    report('ended-task', 'ended-task', 'closed', 'dispatch:ended-task', reportWait + 1)
  ]
  const results = await openRunMail(messages, run, async () => ({
    workers: [worker('live', 'open', { agentTerminalHandle: 'structworker_fixture' }), worker('ended', 'open', { dispatchStatus: 'completed' }),
      worker('released', 'open', { terminalState: 'released' }), worker('ended-task', 'closed'),
      worker('settled', 'open', { workerState: 'succeeded' }),
      ...historicSenders.map((handle, i) => worker('historic-' + i, 'open', { agentTerminalHandle: handle }))],
    tasks: [{ id: 'open', status: 'dispatched', run_id: run }, { id: 'closed', status: 'completed', run_id: run }]
  }), now)
  assert.deepEqual(results.questions.map(q => q.id), ['recent', 'edge', 'legacy'])
  assert.deepEqual(results.reports.map(q => q.id), ['recent-report'])
  assert.deepEqual(await openRunMail([row('old', 'live', questionMaxAge + 1)], run, async () => { throw Error('unexpected work lookup') }, now), { questions: [], reports: [] })
})

test('Run mail first reminds the project and escalates once after two hours unless the project submits', async () => {
  const now = Date.now(), project = fresh(refs[0]); project.runId = 'run_report'
  const host = mockHost({ storage: { 'project:p1': project as any,
    workspace: { version: 1, revision: 0, runId: 'run_main', session: mainSession, requests: [] } } })
  const raw = { type: 'worker_done', id: 'msg_report', run_id: project.runId, to_handle: 'run:' + project.runId, from_handle: 'structworker_fixture',
    body: '实现已完成，等待验收', created_at: new Date(now - reportWait + 10_000).toISOString(),
    payload: JSON.stringify({ taskId: 'orca-task', dispatchId: 'ctx_task', outcome: 'succeeded' }) }
  assert.equal(workerReport({ ...raw, payload: { _orcaLifecycleRejection: { reason: 'fixture' } } }), undefined)
  const sent: { run: string; body: string }[] = []
  let coordinator!: ReturnType<typeof createCoordinator>
  const worker = await mountWorker({ default: api => {
    coordinator = createCoordinator(api, { projects: async () => refs, mail: run => openRunMail([raw], run, async () => ({
      workers: [{ runId: run, taskId: 'orca-task', dispatchId: 'ctx_task', dispatchStatus: 'dispatched', workerState: 'ready', agentTerminalHandle: raw.from_handle }],
      tasks: [{ id: 'orca-task', run_id: run, status: 'dispatched' }]
    })), send: async (run, { subject, body }) => { if (subject.includes('执行者回报待提交')) sent.push({ run, body }); return {} } })
  } }, { host })
  async function submit(revision: number, id: string, orcaTaskId: string) {
    return worker.request('project.agent', { operation: 'submit', projectId: 'p1', revision, requestId: 'submit-' + id,
      task: { id, title: id, goal: id, phase: 'working', executions: [{ runId: project.runId, taskId: orcaTaskId, dispatchId: 'ctx_task', agent: 'codex' }] } })
  }
  try {
    await coordinator.refreshQuestions()
    assert.deepEqual((await worker.request('workspace.overview')).reports, [])
    raw.created_at = new Date(now - reportWait - 1000).toISOString()
    await coordinator.refreshQuestions(); await coordinator.flushMailbox()
    const raised = (await worker.request('workspace.overview')).reports
    assert.equal(raised?.length, 1)
    assert.equal(raised?.[0].from, 'structworker_fixture')
    assert.equal(sent.length, 1); assert.ok(sent[0].body.includes(raw.body))
    assert.equal(sent[0].run, project.runId)
    await coordinator.refreshQuestions(); await coordinator.flushMailbox()
    assert.equal(sent.length, 1)
    await coordinator.store.mutateMessaging(m => { m.deliveries[0].runNotice!.attemptedAt = Date.now() - escalationWait - 1000 })
    await coordinator.refreshQuestions(); await coordinator.flushMailbox()
    assert.deepEqual(sent.map(d => d.run), [project.runId, 'run_main'])
    await coordinator.refreshQuestions(); await coordinator.flushMailbox()
    assert.equal(sent.length, 2)
    await submit(0, 'other-task', 'other-orca-task')
    assert.deepEqual((await worker.request('workspace.overview')).reports, [])
    raw.id = 'msg_already_submitted'
    await coordinator.refreshQuestions(); await coordinator.flushMailbox()
    assert.deepEqual((await worker.request('workspace.overview')).reports, [])
    assert.equal(sent.length, 2)
    const saved = await coordinator.store.get('p1')
    const task = saved.tasks[0], report = workerReport(raw)!
    task.executions[0].taskId = 'orca-task'
    task.submittedAt = new Date(report.at! - 1000).toISOString()
    task.updatedAt = new Date(report.at! + 1000).toISOString()
    assert.ok(projectSubmissions(saved).some(proof => reportSubmitted(report, proof)))
    task.executions[0].taskId = 'unrelated'
    assert.ok(!projectSubmissions(saved).some(proof => reportSubmitted(report, proof)))
  } finally { await coordinator.flush('p1'); coordinator.stop(); await worker.deactivate() }
})

test('feedback returns the committed snapshot without waiting for delivery or session inventory', async () => {
  const project = fresh(refs[0]); project.runId = 'run_fake'; project.mainAgentHandle = 'test-session'; submitTask(project, deliverable)
  const host = mockHost({ storage: { 'project:p1': project as any } })
  let coordinator!: ReturnType<typeof createCoordinator>, release!: () => void, sends = 0, reads = 0
  const gate = new Promise<void>(resolve => {release=resolve})
  const worker = await mountWorker({ default: api => {coordinator=createCoordinator(api, {projects: async()=>refs,
    targets: async()=>{reads++;await gate;return {workspaces:[],sessions:[]}},send: async()=>{sends++;await gate;return {}}})}}, {host})
  try {
    const input = {projectId:'p1', revision:0, requestId:'timing', items:[{taskId:'task-1',kind:'acceptance' as const,itemId:'page-check',itemRevision:1,result:'passed'}]}
    const start=performance.now()
    const reply=await Promise.race([worker.request('project.feedback',input), new Promise<never>((_,reject)=>{setTimeout(()=>reject(Error('反馈等待后台操作')),1000).unref()})])
    assert.ok(performance.now()-start<1000);assert.equal(reads,0)
    assert.equal(reply.project!.tasks[0].acceptance[0].status,'passed')
    assert.equal(reply.project!.requests[0].id,input.requestId)
    await new Promise<void>(resolve=>setImmediate(resolve));assert.ok(sends>0)
  } finally {release();await coordinator.flush('p1');coordinator.stop();await worker.deactivate()}
})

test('independent panel edits merge; stale removals cannot erase a newer choice after reopening', async () => {
  const host = mockHost(); let coordinator!: ReturnType<typeof createCoordinator>
  const worker = await mountWorker({default: api => { coordinator = createCoordinator(api, {}) }}, {host})
  const draft = {taskId:'task', kind:'acceptance' as const, itemId:'a', title:'a', signature:'v1', result:'passed'}
  const key = '["task","acceptance","a"]', other = '["task","acceptance","b"]'
  const edit = (key: string, version: number, value: typeof draft | null) => worker.request('panel.feedbackState',{change:{projectId:'p1',items:[{key,version,value}]}})
  try {
    await Promise.all([edit(key,0,draft), edit(other,0,{...draft,itemId:'b'})])
    await assert.rejects(() => worker.request('panel.feedbackState', { change: { projectId: 'p1', exact: true, items: [{ key, version: 1 }, { key, version: 1 }] } }), /草稿编号重复/)
    await edit(key,1,{...draft,result:'changes_requested'})
    await assert.rejects(()=>edit(key,1,null),/另一个面板/)
    await edit(other,1,null)
    const saved=await worker.request('panel.feedbackState',{})
    assert.deepEqual(saved.p1.entries,{[key]:{...draft,result:'changes_requested'}})
    assert.deepEqual(host.data().storage['panel.feedbackState'],saved)
  } finally {coordinator.stop();await worker.deactivate()}
})

test('connections isolate multiple A2A configs, tokens and histories', async () => {
  const first = { version: 1, revision: 2, enabled: false, port: 9901, url: 'http://127.0.0.1:9900', entries: [] }
  const token = 'test-only-token-12345678901234567890', host = mockHost({ storage: { 'workspace.connections': { version: 1, entries: [{ id: 'butler', name: 'Hermes', type: 'a2a' }] }, 'workspace.a2a:butler': first, workspace: { version: 1, revision: 0, runId: 'run_main', requests: [] } }, secrets: { 'butler:inbound': token, 'butler:outbound': token } })
  let c!: ReturnType<typeof createCoordinator>
  const worker = await mountWorker({ default: (api: OrcaWorkerApi) => { c = createCoordinator(api, { projects: async () => [], verifyRun: async () => {}, hermesApprovalMode: async () => 'smart', send: async () => ({}) }) } }, { host })
  try {
    const list = await worker.request('workspace.connections', { operation: 'read' }) as import('./connections').Connection[]
    assert.equal(list[0].name, 'Hermes'); assert.equal(list[0].id, 'butler')
    const settings = await worker.request('workspace.connections', { operation: 'read', connectionId: 'butler', includeApprovalMode: false }) as import('./connections').ConnectionDetail
    assert.equal(settings.a2a?.url, first.url)
    assert.equal(settings.approvalMode, undefined)
    assert.equal(await worker.request('workspace.hermesApprovalMode'), 'smart')
    assert.equal((await worker.request('workspace.connections', { operation: 'read', name: 'Hermes' }) as import('./connections').ConnectionDetail).approvalMode, 'smart')
    await assert.rejects(() => worker.request('workspace.connections', { operation: 'save', type: 'a2a', name: 'Hermes', enabled: false, port: 0, url: first.url }), /名字不能重复/)
    assert.deepEqual(host.data().storage['workspace.a2a:butler'], first)
    const added = await worker.request('workspace.connections', { operation: 'save', type: 'a2a', name: 'Second', enabled: true, port: 0, url: 'http://127.0.0.1:9999', inboundToken: token + 'second', outboundToken: token + 'peer' }) as import('./connections').ConnectionDetail
    assert.notEqual(added.connection.id, 'butler'); assert.ok(added.a2a!.listening)
    assert.deepEqual(host.data().storage['workspace.a2a:butler'], first); assert.equal(host.data().secrets['butler:inbound'], token)
    const rpc = async (bearer: string) => fetch(added.a2a!.listening, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'missing' } }) })
    assert.equal((await rpc(token)).status, 401)
    assert.equal(((await (await rpc(token + 'second')).json()) as any).error.code, -32001)
    const inbound = await fetch(added.a2a!.listening, { method: 'POST', headers: { Authorization: `Bearer ${token}second`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'SendMessage', params: { message: { messageId: 'second-only', role: 'ROLE_USER', parts: [{ text: 'mock isolated message' }] }, configuration: { returnImmediately: true } } }) })
    assert.equal(inbound.status, 200)
    const isolated = await worker.request('workspace.connections', { operation: 'read', connectionId: added.connection.id }) as import('./connections').ConnectionDetail
    assert.equal(isolated.a2a!.entries.length, 1); assert.deepEqual(host.data().storage['workspace.a2a:butler'], first)
    await assert.rejects(() => worker.request('workspace.connections', { operation: 'save', connectionId: added.connection.id, name: 'Second', enabled: true, port: 0, url: added.a2a!.url, revision: isolated.a2a!.revision, inboundToken: token + 'changed', outboundToken: 'short' }))
    assert.equal(host.data().secrets[`${added.connection.id}:inbound`], token + 'second')
    const renamed = await worker.request('workspace.connections', { operation: 'save', connectionId: added.connection.id, name: 'Renamed', enabled: true, port: 0, url: added.a2a!.url, revision: isolated.a2a!.revision }) as import('./connections').ConnectionDetail
    assert.equal(renamed.connection.name, 'Renamed')
    assert.equal((await worker.request('workspace.connections', { operation: 'read', name: 'Renamed' }) as import('./connections').ConnectionDetail).a2a!.inboundSecretSaved, true)
    await assert.rejects(() => worker.request('workspace.connections', { operation: 'send', name: 'Renamed', runId: 'wrong', requestId: 'x', text: 'mock' }))
    await worker.request('workspace.connections', { operation: 'delete', connectionId: added.connection.id, confirm: true })
    assert.equal(host.data().secrets[`${added.connection.id}:inbound`], undefined)
    assert.equal((await worker.request('workspace.connections', { operation: 'read' }) as any[]).length, 1)
    assert.deepEqual(host.data().storage['workspace.a2a:butler'], first)
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
  const host = mockHost({ results: { 'project.list': { projects: [], truncated: false }, 'workspace.list': { workspaces: [], truncated: false } } })
  const worker = await mountWorker({ default: async api => { await runtime.removeProject(ref, api.host) } }, { host })
  await worker.deactivate()
  assert.deepEqual(calls.find(a => a[1] === 'setup-delete'), ['project', 'setup-delete', '--setup', 'exact', '--force'])
})

test('local artifact actions validate registered paths and archived tasks before opening', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agentboat-artifacts-'))
  const dir = path.join(temp, 'project')
  // A trailing non-breaking space survives Windows filesystem operations and is removed by trim().
  const outside = dir + '\u00a0'
  const ref = { ...refs[1], path: dir }, p = fresh(ref)
  const remote = { ...ref, id: 'remote', hostId: 'remote-host' }
  const files = ['设计稿.md', '样稿 v9.html', 'missing.md']
  const docs = path.join(dir, 'design files')
  const link = path.join(dir, 'outside-link'), revealed: [string, boolean][] = []
  let c!: ReturnType<typeof createCoordinator>, workspace = ref.workspace
  try {
    await mkdir(docs, { recursive: true })
    await mkdir(outside)
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    assert.ok((await realpath(link)).endsWith('\u00a0'))
    for (const name of files.slice(0, 2)) await writeFile(path.join(docs, name), 'fixture')
    const artifact = (id: string, url: string) => ({ id, label: id, version: 'v1', url })
    submitTask(p, { ...deliverable, artifacts: [
      ...files.map((name, i) => artifact(`a${i}`, path.join(docs, name))), artifact('directory', docs), artifact('root', dir),
      artifact('web', 'https://example.com/preview'), artifact('link', link)
    ], acceptance: [] })
    p.tasks[0].artifacts.push(artifact('outside', `${dir}${path.sep}..${path.sep}outside`))
    const host = mockHost({ storage: { 'project:p2': p as any }, results: {
      'editor.open': async (input: any) => {
        await readFile(path.join(dir, input.path))
        return { opened: true }
      }, 'workspace.open': { opened: true }
    } })
    const worker = await mountWorker({ default: api => { c = createCoordinator(api, {
      projects: async () => [refs[0], { ...ref, workspace }, remote],
      revealArtifact: async (file, directory) => { revealed.push([file, directory]) }
    }, undefined, path.join(dir, 'exports')) } }, { host })
    try {
      const open = (artifactId: string, projectId = ref.id) => worker.request('project.openArtifact', { projectId, taskId: deliverable.id, artifactId })
      const reveal = (artifactId: string, projectId = ref.id) => worker.request('project.openArtifactFolder', { projectId, taskId: deliverable.id, artifactId })
      assert.deepEqual(await open('a0'), { opened: true })
      assert.deepEqual(await open('a1'), { opened: true })
      await assert.rejects(() => open('a2'), /成果文件不存在或无法访问/)
      await assert.rejects(() => open('a0', refs[0].id), /请选择本项目的本机成果/)
      assert.deepEqual(await reveal('a1'), { opened: true })
      await assert.rejects(() => reveal('a2'), /成果文件不存在或无法访问/)
      for (const id of ['outside', 'link', 'root']) await assert.rejects(() => reveal(id), /成果路径不属于当前项目/)
      await assert.rejects(() => open('link'), /成果路径不属于当前项目/)
      await assert.rejects(() => reveal('web'), /请选择本项目的本机成果/)
      await assert.rejects(() => reveal('a0', remote.id), /请选择本项目的本机成果/)
      workspace = ''
      await assert.rejects(() => open('a0'), /这个项目当前没有工作区/)
      assert.deepEqual(await reveal('directory'), { opened: true })
      const workspaceId = ref.workspace.slice(3)
      assert.deepEqual(host.calls.filter(c => c.method === 'editor.open' || c.method === 'workspace.open'), files.slice(0, 2).flatMap(name => [
        { method: 'editor.open', params: { workspaceId, path: `design files/${name}` } }, { method: 'workspace.open', params: { workspaceId } }
      ]))
      workspace = ref.workspace
      const saved = await c.store.mutate(ref.id, 0, project => {
        project.tasks[0].updatedAt = '2020-01-01'
        for (let i = 0; i < 20; i++) submitTask(project, { ...deliverable, id: String(i), phase: 'completed', acceptance: [] })
      })
      const archived = { projectId: ref.id, taskId: deliverable.id, artifactId: 'a1', archiveEnd: saved.archive!.end }
      assert.deepEqual(await worker.request('project.openArtifact', archived), { opened: true })
      assert.deepEqual(await worker.request('project.openArtifactFolder', archived), { opened: true })
      await assert.rejects(() => open('a1'), /请选择本项目的本机成果/)
      await assert.rejects(() => worker.request('project.openArtifact', { ...archived, archiveEnd: 1 }), /归档批次不存在/)
      const file = await realpath(path.join(docs, files[1]))
      assert.deepEqual(revealed, [[file, false], [await realpath(docs), true], [file, false]])
    } finally { c.stop(); await worker.deactivate() }
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('artifact reveal passes native paths as arguments and accepts Explorer exit code 1', async () => {
  const windows = 'C:\\设计, 文件', unix = '/project/设计, 文件'
  const explorer = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe')
  for (const [platform, file, command, fileArgs, dirArgs] of [
    ['win32', windows, explorer, [`/select,"${windows}\\稿件.txt"`], [`"${windows}"`]],
    ['darwin', unix, '/usr/bin/open', ['-R', `${unix}/稿件.txt`], [unix]],
    ['linux', unix, 'xdg-open', [unix], [unix]]
  ] as const) {
    const calls: unknown[] = [], tail = platform === 'win32' ? '\\稿件.txt' : '/稿件.txt'
    const run: NonNullable<Parameters<typeof revealArtifact>[3]> = async (command, args, options) => {
      calls.push([command, args, options])
      if (platform === 'win32') throw Object.assign(new Error('Explorer delegated'), { code: 1 })
    }
    await revealArtifact(file + tail, false, platform, run)
    await revealArtifact(file, true, platform, run)
    const options = platform === 'win32' ? { shell: false, windowsVerbatimArguments: true } : { shell: false }
    assert.deepEqual(calls, [[command, fileArgs, options], [command, dirArgs, options]])
  }
  const missing = async () => { throw Object.assign(new Error('missing executable'), { code: 'ENOENT' }) }
  await assert.rejects(() => revealArtifact(windows, true, 'win32', missing), /missing executable/)
})

test('attention counts reviews per task and excludes rework consistently', () => {
  const p = fresh(refs[0]); submitTask(p, deliverable)
  p.tasks[0].acceptance.push({ ...p.tasks[0].acceptance[0], id: 'second' })
  const all = requireOverview(p)
  assert.equal(groupedAttention(all.attention).length, 1); assert.equal(groupedAttention(all.attention)[0].count, 2)
  p.tasks[0].acceptance.forEach(a => a.status = 'changes_requested')
  assert.equal(groupedAttention(requireOverview(p).attention).length, 0)
})
test('inbox task reads only the selected registered project task without a session lookup', async () => {
  const project = sample().project!
  project.mainAgentHandle = mainSession.handle
  const host = mockHost({ storage: { 'project:p1': project as any } })
  let sessionReads = 0
  const worker = await mountWorker({ default: api => { createCoordinator(api, {
    projects: async () => [refs[0]], targets: async () => { sessionReads++; return { sessions: [], workspaces: [] } }
  }) } }, { host })
  try {
    const read = (projectId: string, taskId: string) => worker.request('project.task', { projectId, taskId })
    assert.deepEqual(await read('p1', 'task-1'), project.tasks[0])
    assert.equal(await read('p1', 'missing'), null)
    assert.ok(!Object.hasOwn(await worker.request('project.agent', { operation: 'read', projectId: 'p1', taskId: 'missing' }), 'task'))
    await assert.rejects(() => read('p2', 'task-1'), /项目已从 Orca 移除/)
    assert.equal(sessionReads, 0)
  } finally { await worker.deactivate() }
})
function requireOverview(p: import('./model').Project) { return overview(p ? [p] : [], { version: 1, revision: 0, runId: '', requests: [] }) }

test('hide preserves project records and agent writes, excludes all workspace surfaces and pauses queued reminders until restore', async () => {
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
    assert.equal(await worker.request('project.task', { projectId: 'p1', taskId: deliverable.id }), null)
    assert.deepEqual(hidden.tasks, p.tasks)
    const all = await worker.request('workspace.overview')
    assert.deepEqual(all.projects.map(p => p.ref.id), ['p2']); assert.deepEqual(all.hidden, [refs[0]])
    assert.deepEqual(all.attention, [])
    assert.deepEqual(report([hidden], { scope: 'details', allProjects: true, projectIds: ['p1'] }, 'own', 'own').projects, [])
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
    assert.equal(report([restored], { scope: 'details', allProjects: false, projectIds: ['p1'] }, 'own', 'own').projects.length, 1)
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
  let catalog = refs, unavailable = false, removeAllowed = false, c!: ReturnType<typeof createCoordinator>
  const host = mockHost({ storage: { 'project:p1': p as any, 'project:p2': other as any } })
  const worker = await mountWorker({ default: (api: OrcaWorkerApi) => { c = createCoordinator(api, {
    projects: async () => { if (unavailable) throw Error('offline'); return catalog }, verifyRun: async () => {}, send: async () => ({}),
    removeProject: async ref => {
      if (!removeAllowed) throw Error('project still open')
      catalog = catalog.filter(p => p.id !== ref.id)
    }
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
    await assert.rejects(() => worker.request('project.delete', input), /项目已从 Orca 移除/)
    assert.deepEqual(await c.store.get('p1'), p)
    catalog = refs; removeAllowed = true
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

function projectStorage(project: ReturnType<typeof fresh>): ConstructorParameters<typeof ProjectStore>[0] {
  const values = new Map<string, any>([[`project:${project.ref.id}`, project]])
  return { get: async k => values.get(k), set: async (k, v) => { values.set(k, structuredClone(v)) },
    keys: async () => [...values.keys()], delete: async k => { values.delete(k) } }
}

test('failed export never deletes or alters a project', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentboat-export-failure-')), blocked = path.join(directory, 'file')
  await writeFile(blocked, 'not a directory')
  const p = fresh(refs[0])
  const store = new ProjectStore(projectStorage(p), blocked)
  await assert.rejects(() => store.remove('p1', 0, async () => {}))
  assert.deepEqual(await store.get('p1'), p)
})

test('first write archives oversized history and preserves actionable notifications and replay proofs across restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentboat-project-archive-'))
  const project = fresh(refs[0])
  submitTask(project, deliverable)
  const unfinished = (['pending', 'sending', 'uncertain'] as const).map(state => ({ id: state, state, subject: state, body: state }))
  const quoted = { id: 'quote', state: 'sent' as const, subject: '', body: '', external: { channel: 'feishu' as const, appId: 'app', chatId: 'chat', messageId: 'msg',
    target: { projectId: 'p1', taskId: deliverable.id, kind: 'acceptance' as const, itemId: 'page-check', itemRevision: 1, fingerprint: project.tasks[0].acceptance[0].fingerprint } } }
  const history = Array.from({ length: 50 }, (_, i) => ({ id: String(i), state: 'sent' as const, subject: '通知', body: 'x'.repeat(4200) }))
  project.deliveries.push(...unfinished, quoted, ...history)
  project.requests = Array.from({ length: 132 }, (_, i) => ({ id: String(i), fingerprint: fingerprint(i) }))
  const storage = projectStorage(project)
  const restart = () => new ProjectStore(storage, dir)
  try {
    assert.ok(Buffer.byteLength(JSON.stringify(project)) > 200_000)
    const store = restart()
    const saved = await store.mutate('p1', 0, p => { p.runId = 'main' })
    assert.ok(Buffer.byteLength(JSON.stringify(saved)) < 200_000)
    assert.deepEqual(saved.tasks, project.tasks)
    assert.deepEqual(saved.deliveries, [...unfinished, quoted, ...history.slice(-24)])
    const file = path.join(dir, (await readdir(dir))[0])
    const original = await readFile(file, 'utf8'), batch = JSON.parse(original)
    assert.deepEqual(batch.deliveries, history.slice(0, -24))
    assert.deepEqual(batch.requests, project.requests.slice(0, -128))
    // A crash after a partial append must not corrupt the next committed batch.
    await writeFile(file, '{"unfinished":', { flag: 'a' })
    const calls = [132, 133].map(i => store.mutate('p1', undefined, () => {}, { id: String(i), input: i }))
    const [, last] = await Promise.all(calls)
    assert.equal(last.revision, 3)
    assert.ok((await readFile(file, 'utf8')).startsWith(original))
    const resumed = restart()
    for (const i of [0, 4, 5]) {
      const replay = await resumed.mutate('p1', 0, () => { throw Error('duplicate write') }, { id: String(i), input: i })
      assert.equal(replay.revision, 3)
      assert.deepEqual(replay.requests.at(-1), project.requests[i])
    }
    await assert.rejects(() => resumed.mutate('p1', 0, () => {}, { id: '0', input: 'different' }), /不同内容/)
    assert.equal((await resumed.get('p1')).requests.length, 128)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('the first write archives whole completed tasks and submit restores their history and sources after restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentboat-tasks-'))
  const p = fresh(refs[0])
  submitTask(p, { ...deliverable, decisions: [{ id: 'd', question: '方向？' }] })
  feedback(p, { items: [{ taskId: deliverable.id, kind: 'decision', itemId: 'd', answer: '甲' },
    { taskId: deliverable.id, kind: 'acceptance', itemId: 'page-check', itemRevision: 1, result: 'passed' }] })
  const old = p.tasks[0]
  const original = { operation: 'submit' as const, projectId: 'p1', task: { id: old.id }, requestId: 'original', revision: 0 }
  p.requests.push({ id: original.requestId, fingerprint: fingerprint(original) })
  delete old.submittedAt // Older archived tasks only have updatedAt.
  old.updatedAt = '2020-01-01'; old.sourceIds.push('old')
  const event = { id: 'old', taskId: old.id, source: 'test', sourceId: '1', senderId: '', chatId: '', threadId: '', text: '原文', receivedAt: old.updatedAt }
  p.events.push(event)
  for (let i = 0; i < 20; i++) submitTask(p, { ...deliverable, id: String(i), phase: 'completed', acceptance: [] })
  for (const phase of ['working', 'blocked', 'paused', 'ready'] as const) {
    submitTask(p, { ...deliverable, phase, id: phase })
    p.tasks.at(-1)!.sourceIds.push(phase)
    p.events.push({ ...event, id: phase, taskId: phase })
  }
  submitTask(p, { ...deliverable, id: 'decision', decisions: [{ id: 'q', question: '下一步？' }] })
  submitTask(p, { ...deliverable, id: 'rework' })
  feedback(p, { items: [{ taskId: 'rework', kind: 'acceptance', itemId: 'page-check', itemRevision: 1, result: 'changes_requested', note: '修改' }] })
  const host = mockHost({ storage: { 'project:p1': p as any } })
  let c!: ReturnType<typeof createCoordinator>
  const mount = () => mountWorker({ default: api => { c = createCoordinator(api, { projects: async () => refs }, undefined, dir) } }, { host })
  let worker = await mount()
  try {
    const saved = await c.store.mutate('p1', 0, () => {})
    assert.deepEqual(saved.tasks, p.tasks.slice(1))
    assert.deepEqual(saved.events, p.events.slice(1))
    assert.equal(saved.archive?.taskCount, 1)
    c.stop(); await worker.deactivate(); worker = await mount()
    const read = () => worker.request('project.agent', { operation: 'read', projectId: 'p1', taskId: old.id })
    const result = await read()
    assert.equal(result.archiveStatus, '已归档')
    assert.deepEqual(result.task, old)
    const receipt = (await worker.request('project.agent', original)).submitted!
    assert.equal(receipt.id, old.id)
    assert.ok(!Object.hasOwn(receipt, 'submittedAt'))
    const report = { id: 'm', from: '', body: '', at: Date.parse(old.updatedAt) }
    assert.deepEqual(await c.store.archive.submittedReports({ ...saved, tasks: [] }, [report]), new Set(['m']))
    // An in-memory version supersedes its archived proof even when the cursor is unchanged.
    const newer = { ...report, at: report.at + 1 }
    assert.deepEqual(await c.store.archive.submittedReports({ ...saved, tasks: [] }, [newer]), new Set())
    const shadow = { ...old, submittedAt: '2000-01-01', updatedAt: '2000-01-01' }
    assert.deepEqual(await c.store.archive.submittedReports({ ...saved, tasks: [shadow] }, [report]), new Set())
    const archive = await worker.request('project.archive', { projectId: 'p1' })
    assert.deepEqual(archive, { end: saved.archive!.end, tasks: [old], deliveries: 0, events: 1, requests: 0, history: 0 })
    const input = { operation: 'submit' as const, projectId: 'p1', revision: 1, requestId: 'reopen',
      task: { id: old.id, phase: 'working', title: old.title, goal: old.goal, sourceIds: ['old'] } }
    const restored = (await worker.request('project.agent', input)).project!
    assert.equal(restored.archive?.taskCount, 0)
    const task = restored.tasks.find(t => t.id === old.id)!
    assert.deepEqual(task, { ...old, phase: 'working', updatedAt: task.updatedAt, submittedAt: task.submittedAt })
    assert.deepEqual(restored.events.find(e => e.id === 'old'), event)
    assert.equal((await read()).archiveStatus, undefined)
    assert.equal((await worker.request('project.agent', input)).project!.tasks.filter(t => t.id === old.id).length, 1)
  } finally { c.stop(); await worker.deactivate(); await rm(dir, { recursive: true, force: true }) }
})

test('each pressure stage stops as soon as the write fits and old feedback remains readable', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentboat-pressure-'))
  try {
    for (const stage of [1, 2, 3, 4]) {
      const p = fresh(refs[0])
      submitTask(p, { ...deliverable, phase: 'working', decisions: [{ id: 'd', question: '决定？' }] })
      const active = p.tasks[0], entry = { at: '2020-01-01', revision: 1, result: 'answer', note: 'x'.repeat(3000) }
      active.acceptance[0].history = [entry, entry]
      active.decisions[0].history = [entry, entry]
      submitTask(p, { ...deliverable, id: 'done', phase: 'completed', acceptance: [], progress: 'x'.repeat(5000) })
      p.requests = Array.from({ length: 100 }, (_, i) => ({ id: String(i), fingerprint: fingerprint(i) }))
      p.deliveries = [{ id: 'sent', state: 'sent', subject: '', body: 'x'.repeat(5000) }]
      active.progress = 'x'.repeat([0, 202000, 208000, 217000, 221000][stage] - Buffer.byteLength(JSON.stringify(p)))
      const storage = projectStorage(p)
      const saved = await new ProjectStore(storage, dir).mutate('p1', 0, () => {})
      assert.ok(Buffer.byteLength(JSON.stringify(saved)) <= 200000)
      assert.equal(saved.deliveries.length, 0)
      assert.equal(saved.requests.length, stage < 2 ? 100 : 1)
      assert.equal(saved.tasks.length, stage < 3 ? 2 : 1)
      assert.equal(saved.archive?.last?.history, stage === 4 ? 2 : 0)
      const reopened = new ProjectStore(storage, dir)
      assert.deepEqual(await reopened.archive.task(saved, active.id), active)
      if (stage === 4) {
        const archived = await reopened.mutate('p1', saved.revision, p => {
          const t = p.tasks[0]
          t.phase = 'completed'; t.progress = ''; t.updatedAt = '2000-01-01'
          t.decisions[0].answer = '甲'; t.acceptance[0].status = 'passed'
          for (let i = 0; i < 20; i++) submitTask(p, { ...deliverable, id: 'done-' + i, phase: 'completed', acceptance: [] })
        })
        assert.ok(!archived.tasks.some(t => t.id === active.id))
        await reopened.archive.restore(archived, active.id, [])
        assert.equal(archived.tasks.at(-1)!.acceptance[0].archivedHistory, 1)
        assert.deepEqual((await reopened.archive.task(archived, active.id))!.acceptance[0].history, active.acceptance[0].history)
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('uncommitted task versions are invisible after a failed storage write and active-only overflow keeps the original', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentboat-archive-commit-'))
  const p = fresh(refs[0])
  for (let i = 0; i < 22; i++) {
    submitTask(p, { ...deliverable, id: String(i), phase: 'completed', acceptance: [] })
    p.tasks.at(-1)!.updatedAt = new Date(i * 1000).toISOString()
  }
  const storage = projectStorage(p), store = new ProjectStore(storage, dir)
  try {
    const saved = await store.mutate('p1', 0, () => {})
    const failing = new ProjectStore({ ...storage, set: async () => { throw Error('storage offline') } }, dir)
    await assert.rejects(() => failing.mutate('p1', 1, async project => {
      await failing.archive.restore(project, '0', [])
      project.tasks.at(-1)!.title = '未提交版本'
    }), /storage offline/)
    const next = await store.mutate('p1', 1, project => { project.requests = Array.from({ length: 129 }, (_, i) => ({ id: String(i), fingerprint: fingerprint(i) })) })
    const restarted = new ProjectStore(storage, dir)
    assert.deepEqual(await restarted.archive.task(next, '0'), p.tasks[0])
    assert.equal((await restarted.archive.page(next)).previous!.end, saved.archive!.end)
    await assert.rejects(() => store.mutate('p1', 2, project => {
      project.tasks[0].phase = 'paused'; project.tasks[0].goal = 'x'.repeat(205000)
    }), /剩余记录用于当前工作.*成果文件/)
    assert.deepEqual(await store.get('p1'), next)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('lead history retains fifty per role, one sent workspace probe, and all outstanding control messages', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentboat-lead-history-'))
  const storage = projectStorage(fresh(refs[0])), store = new ProjectStore(storage, dir)
  const rows = (role: string) => Array.from({ length: 52 }, (_, at) => ({ at, text: role + at }))
  const backup = (role: string) => ({ primary: role, agent: 'codex', phase: 'taking' as const, since: 0, cycle: 'pending', history: rows(role) })
  try {
    const w = await store.mutateWorkspace(w => {
      w.backup = backup('workspace')
      const states = ['sent', 'pending', 'sending', 'uncertain', 'sent'] as const
      w.retired = states.map((state, i) => ({ id: String(i), state, subject: 'probe', body: '', control: { action: 'ready', cycle: String(i), handle: 'main' } }))
      w.retired.push({ ...w.retired[0], id: 'take', control: { action: 'take', cycle: 'pending', handle: 'spare' } })
    })
    assert.deepEqual(w.retired?.map(d => d.id), ['1','2','3','4','take'])
    assert.deepEqual(w.backup?.history, rows('workspace').slice(2))
    assert.equal(w.backup?.phase, 'taking')
    const waiting = await store.mutateWorkspace(w => {
      w.backup!.phase = 'probing'
      w.backup!.cycle = '4'
      w.retired!.push({ ...w.retired!.find(d => d.id === '4')!, id: 'stale', control: { action: 'ready', cycle: 'other', handle: 'main' } })
    })
    assert.ok(waiting.retired?.some(d => d.id === '4'))
    await store.mutate('p1', 0, p => { p.backup = backup('project') })
    await Promise.all([52, 53].map(at => store.mutateWorkspace(w => { w.backup!.history.push({ at, text: 'workspace' + at }) })))
    const restarted = new ProjectStore(storage, dir)
    for (const [owner, role, count] of [[await restarted.workspace(), 'workspace', 54], [await restarted.get('p1'), 'project', 52]] as const) {
      let page = await restarted.archive.leadHistory(owner)
      assert.equal(page.history.length, 50)
      const all = [...page.history]
      while (page.previousEnd) {
        page = await restarted.archive.leadHistory(owner, page.previousEnd)
        all.unshift(...page.history)
      }
      assert.deepEqual(all, Array.from({ length: count }, (_, at) => ({ at, text: role + at })))
    }
    assert.deepEqual((await readdir(dir)).map(f => f.split('-')[0]).sort(), ['project', 'workspace'])
    const append = (w: import('./model').Workspace) => { w.backup!.history.push({ at: 54, text: 'workspace54' }) }
    const interrupted = new ProjectStore({ ...storage, set: async () => { throw Error('interrupted') } }, dir)
    await assert.rejects(() => interrupted.mutateWorkspace(append), /interrupted/)
    const retry = await new ProjectStore(storage, dir).mutateWorkspace(append)
    const committed = await store.archive.leadHistory(retry, retry.archive!.end)
    assert.deepEqual(committed.history, [{ at: 4, text: 'workspace4' }])
    assert.deepEqual((await store.archive.leadHistory(retry, committed.previousEnd)).history, [{ at: 3, text: 'workspace3' }])
    const blocked = path.join(dir, 'blocked')
    await writeFile(blocked, '')
    const failing = new ProjectStore(storage, blocked)
    const saved = await failing.mutateWorkspace(w => { w.backup!.history = rows('retry') })
    assert.deepEqual(saved.backup?.history, rows('retry'))
    const rebound = await failing.bindWorkspace(saved.revision, 'new-run', { id: 'bind', input: {} }, mainSession)
    assert.equal(rebound.backup?.phase, 'unavailable')
    assert.equal(rebound.backup?.cycle === saved.backup?.cycle, false)
    assert.deepEqual(rebound.backup?.history, rows('retry'))
    assert.deepEqual((await failing.workspace()).backup?.history, rows('retry'))
    const project = await failing.mutate('p1', undefined, p => { p.backup!.history = rows('retry-project') })
    assert.deepEqual(project.backup?.history, rows('retry-project'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('archive failure retains history, permits writes that fit and describes an oversized write', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentboat-project-archive-failure-'))
  const blocked = path.join(dir, 'file'), project = fresh(refs[0])
  for (let i = 0; i < 21; i++) submitTask(project, { ...deliverable, id: String(i), phase: 'completed', acceptance: [] })
  project.events.push({ id: 'event', source: 'test', sourceId: 'one', senderId: '', chatId: '', threadId: '', text: '来源', receivedAt: '2001-01-01' })
  project.deliveries = Array.from({ length: 30 }, (_, i) => ({ id: String(i), state: 'sent', body: '', subject: '通知' }))
  project.requests = Array.from({ length: 129 }, (_, i) => ({ id: String(i), fingerprint: fingerprint(i) }))
  const store = new ProjectStore(projectStorage(project), blocked)
  try {
    await writeFile(blocked, '')
    const saved = await store.mutate('p1', 0, p => { p.runId = 'main' })
    assert.equal(saved.runId, 'main')
    assert.deepEqual(saved.requests, project.requests)
    assert.deepEqual(saved.tasks, project.tasks)
    assert.deepEqual(saved.events, project.events)
    assert.deepEqual(saved.deliveries, project.deliveries)
    await assert.rejects(() => store.mutate('p1', 1, p => { p.deliveries[0].body = 'x'.repeat(200_000) }), /200000.*通知.*归档失败/)
    assert.deepEqual(await store.get('p1'), saved)
  } finally { await rm(dir, { recursive: true, force: true }) }
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
  const registeredAt = p.tasks[0].artifacts[0].registeredAt
  assert.ok(registeredAt && registeredAt === p.tasks[0].submittedAt)
  for (const a of p.tasks[0].acceptance) feedback(p, { items: [{ taskId: 'task-1', kind: 'acceptance', itemId: a.id, itemRevision: 1, result: 'passed' }] })
  submitTask(p, deliverable)
  assert.equal(p.tasks[0].artifacts[0].registeredAt, registeredAt)
  assert.equal(p.tasks[0].acceptance[0].status, 'passed')
  submitTask(p, { ...deliverable, artifacts: [{ ...deliverable.artifacts[0], id: 'page-v2', version: 'v2' }], acceptance: [{ ...deliverable.acceptance[0], artifactIds: ['page-v2'] }] })
  assert.deepEqual(p.tasks[0].acceptance.map(a => [a.id, a.status, a.revision]), [['page-check', 'pending', 2], ['stable', 'passed', 1]])
  assert.equal(p.tasks[0].acceptance[0].history.length, 1)
  assert.throws(() => feedback(p, { items: [{ taskId: 'task-1', kind: 'acceptance', itemId: 'page-check', itemRevision: 1, result: 'passed' }] }))
  assert.throws(() => submitTask(p, { ...deliverable, phase: 'completed' }))
  assert.throws(() => submitTask(p, { ...deliverable, artifacts: [{ ...deliverable.artifacts[0], url: 'D:\\Other\\secret.txt' }] }))
})

test('renaming an artifact preserves its registration, acceptance and notifications', () => {
  const p = fresh(refs[0])
  submitTask(p, deliverable)
  const before = structuredClone(p)
  const renamed = { ...deliverable.artifacts[0], label: '项目首页' }
  submitTask(p, { ...deliverable, artifacts: [renamed] })
  assert.deepEqual(p.tasks[0].artifacts, [{ ...before.tasks[0].artifacts[0], label: renamed.label }])
  assert.deepEqual(p.tasks[0].acceptance, before.tasks[0].acceptance)
  notifyWorkspace(before, p, 'workspace-run')
  notifyFeishu(before, p, { enabled: true, appId: 'app', chatIds: ['chat'], senderIds: [] })
  assert.deepEqual(p.deliveries, before.deliveries)
  for (const change of [{ url: 'https://example.com/other' }, { version: 'v2' }]) {
    assert.throws(() => submitTask(p, { ...deliverable, artifacts: [{ ...renamed, ...change }] }), /成果编号已存在；新版本请登记新的成果编号/)
  }
})

test('lead and owner expire artifacts only after pending reviews are resolved', async () => {
  const p = fresh(refs[0])
  const other = { ...deliverable.artifacts[0], id: 'other', label: '说明' }
  submitTask(p, { ...deliverable, artifacts: [...deliverable.artifacts, other] })
  const original = p.tasks[0].acceptance[0]
  const remote = { ...refs[1], hostId: 'remote' }
  const host = mockHost({ storage: { 'project:p1': p as any } })
  let c!: ReturnType<typeof createCoordinator>
  const worker = await mountWorker({ default: api => { c = createCoordinator(api, { projects: async () => [refs[0], remote] }) } }, { host })
  const input = { projectId: 'p1', revision: 0, taskId: deliverable.id, artifactId: 'page-v1' }
  const marker = { id: 'page-v1', expired: true, reason: '改用新版' }
  const task = { id: deliverable.id, phase: 'ready', artifacts: [marker] }
  const submit = { projectId: 'p1', revision: 0, operation: 'submit' as const, requestId: 'expire', task }
  try {
    await assert.rejects(() => worker.request('project.expireArtifact', input), /请先撤下或处理/)
    await assert.rejects(() => worker.request('project.expireArtifact', { ...input, projectId: remote.id }), /本机项目/)
    await assert.rejects(() => worker.request('project.agent', submit), /请先撤下或处理/)
    const saved = (await worker.request('project.agent', { ...submit, task: { ...task, phase: 'working',
      acceptance: [{ id: original.id, discarded: true, reason: '已取代' }] } })).project!
    assert.deepEqual(saved.tasks[0].artifacts[0], { ...p.tasks[0].artifacts[0], expired: true, expiryReason: marker.reason })
    assert.equal(saved.tasks[0].acceptance[0].fingerprint, original.fingerprint)
    assert.deepEqual(saved.tasks[0].acceptance[0].artifactIds, original.artifactIds)
    await assert.rejects(() => worker.request('project.expireArtifact', { ...input, artifactId: other.id }), /项目已更新/)
    const result = (await worker.request('project.expireArtifact', { ...input, artifactId: other.id, revision: saved.revision })).project!
    assert.deepEqual(result.tasks[0].artifacts[1], { ...p.tasks[0].artifacts[1], expired: true })
    assert.deepEqual(result.tasks[0].acceptance, saved.tasks[0].acceptance)
    assert.deepEqual(result.deliveries, [])
    assert.throws(() => submitTask(result, { ...deliverable, acceptance: [{ ...deliverable.acceptance[0], id: 'new' }] }), /已过期/)
  } finally { c.stop(); await worker.deactivate() }
})

test('expiring an artifact with no reason keeps a resolved blocker quiet', () => {
  const p = fresh(refs[0])
  submitTask(p, { ...deliverable, phase: 'blocked', acceptance: [] })
  p.tasks[0].blockedStatus = 'replied'
  const before = structuredClone(p)
  submitTask(p, { id: deliverable.id, phase: 'blocked', artifacts: [{ id: 'page-v1', expired: true }] })
  assert.equal(p.tasks[0].artifacts[0].expired, true)
  assert.equal(p.tasks[0].blockedStatus, 'replied')
  notifyWorkspace(before, p, 'workspace-run')
  notifyFeishu(before, p, { enabled: true, appId: 'app', chatIds: ['chat'], senderIds: [] })
  assert.deepEqual(p.deliveries, [])
})

test('task updates preserve omitted titles and goals and validate supplied values', () => {
  const p = fresh(refs[0]), update = { id: deliverable.id, phase: 'working' }
  assert.throws(() => submitTask(p, update), /任务标题/)
  assert.throws(() => submitTask(p, { ...update, title: '标题' }), /任务目标/)
  submitTask(p, deliverable)
  submitTask(p, update)
  assert.equal(p.tasks[0].title, deliverable.title)
  assert.equal(p.tasks[0].goal, deliverable.goal)
  submitTask(p, { ...update, title: '新标题' })
  assert.equal(p.tasks[0].title, '新标题')
  assert.equal(p.tasks[0].goal, deliverable.goal)
  assert.throws(() => submitTask(p, { ...update, title: null }), /任务标题/)
  assert.throws(() => submitTask(p, { ...update, goal: '' }), /任务目标/)
})

test('blocked replies record owner words, allow supplements and discard, and expire on task submission', () => {
  const p = sample().project!, task = p.tasks[1], id = task.id
  delete task.blockedRevision // Existing blocked task from before reply support.
  const reply = { taskId: id, itemId: id, itemRevision: 0, kind: 'blocked', note: '  补建完成\n请再试  ' }
  const decision = { taskId: id, itemId: 'style', kind: 'decision', answer: '简洁明亮' }
  const review = { taskId: deliverable.id, itemId: 'page-check', kind: 'acceptance', itemRevision: 1, result: 'passed' }
  const write = (...items: object[]) => feedback(p, { items })
  for (const invalid of [{ ...reply, note: ' ' }, { ...reply, itemRevision: 1 }, { ...reply, itemId: 'other' }]) {
    assert.throws(() => write(decision, invalid), /第 2 条/)
    assert.equal(task.decisions[0].answer, undefined)
  }
  write(reply, decision, review)
  assert.equal(task.phase, 'blocked')
  assert.equal(task.blockedStatus, 'replied')
  assert.equal(attention(p).some(i => i.kind === 'blocked' && i.replied), true)
  assert.equal(p.deliveries.length, 1)
  assert.ok(p.deliveries[0].body.includes(reply.note))
  write({ ...reply, note: '先放着' })
  assert.deepEqual(p.events.map(e => [e.text, e.taskId, e.senderId]), [[reply.note, id, '主人'], ['先放着', id, '主人']])
  assert.deepEqual(task.sourceIds, p.events.map(e => e.id))
  const update = { id, title: task.title, goal: task.goal, phase: 'blocked' }
  submitTask(p, update)
  assert.equal(p.tasks[1].blockedStatus, undefined)
  assert.throws(() => write(reply), /受阻项已更新/)
  const current = { ...reply, itemRevision: p.tasks[1].blockedRevision }
  write({ ...current, result: 'discarded', note: '移到下周' })
  assert.equal(p.tasks[1].phase, 'blocked')
  assert.equal(attention(p).some(i => i.kind === 'blocked'), false)
  assert.match(p.deliveries.at(-1)!.body, /主人丢弃了这项受阻\n移到下周/)
  assert.throws(() => write(current), /受阻项已更新/)
  submitTask(p, { ...update, phase: 'working' })
  assert.equal(p.tasks[1].blockedStatus, undefined)
  assert.throws(() => write(current), /受阻项已更新/)
})

test('owner discards and competing passes commit once, with one project summary and no pending items', async () => {
  const p = fresh(refs[0])
  submitTask(p, { ...deliverable, decisions: [{ id: 'direction', question: '方向？' }] })
  const host = mockHost({ storage: { 'project:p1': p as any } })
  let c!: ReturnType<typeof createCoordinator>
  const worker = await mountWorker({ default: api => { c = createCoordinator(api, { projects: async () => refs }) } }, { host })
  try {
    const review = { taskId: deliverable.id, itemId: 'page-check', kind: 'acceptance' as const, itemRevision: 1, result: 'discarded' }
    const decision = { taskId: deliverable.id, itemId: 'direction', kind: 'decision' as const, result: 'discarded', note: '主人说方向已改' }
    const pass = { ...review, result: 'passed' }
    const write = (items: (typeof review | typeof decision)[]) => worker.request('project.feedback', { projectId: 'p1', items, caller: 'workspace-main' })
    await assert.rejects(() => write([review, pass]), /同一事项不能重复提交/)
    const concurrent = await Promise.allSettled([write([review, decision]), write([pass])])
    assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1)
    const saved = await c.store.get('p1'), [t] = saved.tasks
    assert.equal(t.acceptance[0].status, 'discarded')
    assert.equal(t.decisions[0].answer, null)
    assert.deepEqual(attention(saved), [])
    assert.equal(taskState(t), 'completed')
    for (const item of [t.acceptance[0], t.decisions[0]]) {
      assert.equal(item.history.length, 1)
      assert.equal(item.history[0].source, '主人')
      assert.ok(Date.parse(item.history[0].at))
    }
    assert.equal(t.decisions[0].history[0].note, decision.note)
    assert.equal(saved.deliveries.length, 1)
    assert.match(saved.deliveries[0].body, /首页布局.*\n已丢弃[\s\S]*方向？\n已丢弃\n主人说方向已改/)
    await assert.rejects(() => worker.request('project.feedback', { projectId: 'p1', items: [{ ...decision, result: undefined, answer: '旧客户端答案' }] }), /已丢弃/)
  } finally { c.stop(); await worker.deactivate() }
})

test('project withdraws pending items together, and only changed acceptance reopens with its history', () => {
  const p = fresh(refs[0])
  const original = { ...deliverable, decisions: [{ id: 'style', question: '风格？' }] }
  submitTask(p, original)
  const marker = { discarded: true, reason: '新版已取代' }
  const withdrawn = { ...deliverable, phase: 'completed', acceptance: [{ ...marker, id: 'page-check' }], decisions: [{ ...marker, id: 'style' }] }
  assert.throws(() => submitTask(p, { ...withdrawn, decisions: [] }), /不能标记为完成/)
  assert.equal(p.tasks[0].acceptance[0].status, 'pending')
  submitTask(p, withdrawn)
  submitTask(p, withdrawn)
  assert.equal(p.deliveries.length, 0)
  submitTask(p, original)
  assert.equal(taskState(p.tasks[0]), 'completed')
  assert.deepEqual(attention(p), [])
  for (const item of [p.tasks[0].acceptance[0], p.tasks[0].decisions[0]]) {
    assert.equal(item.history.length, 1)
    assert.deepEqual(item.history[0], { at: item.history[0].at, revision: 1, source: '项目主会话', result: 'discarded', note: marker.reason })
  }
  submitTask(p, { ...original, acceptance: [{ ...original.acceptance[0], details: '核对第二版' }] })
  assert.equal(taskState(p.tasks[0]), 'review')
  assert.deepEqual(attention(p).map(i => i.itemId), ['page-check'])
  assert.equal(p.tasks[0].acceptance[0].revision, 2)
  assert.equal(p.tasks[0].acceptance[0].history[0].result, 'discarded')
})

test('lead withdrawal clears rework without reopening a review or notifying itself', () => {
  const p = fresh(refs[0])
  const other = { ...deliverable.acceptance[0], id: 'other' }
  submitTask(p, { ...deliverable, acceptance: [...deliverable.acceptance, other] })
  const item = { taskId: deliverable.id, kind: 'acceptance', itemId: 'page-check', itemRevision: 1 }
  feedback(p, { items: [{ ...item, result: 'changes_requested', note: '需要调整' }] })
  assert.equal(taskState(p.tasks[0]), 'rework')
  assert.throws(() => feedback(p, { items: [{ ...item, result: 'discarded' }] }), /不在待验收状态/)
  const before = structuredClone(p)
  submitTask(p, { id: deliverable.id, phase: 'ready', acceptance: [{ id: item.itemId, discarded: true, reason: '该项已被取代' }] })
  notifyWorkspace(before, p, 'workspace-run')
  notifyFeishu(before, p, { enabled: true, appId: 'app', chatIds: ['chat'], senderIds: [] })
  assert.deepEqual(p.deliveries, before.deliveries)
  assert.equal(p.tasks[0].acceptance[0].status, 'discarded')
  assert.deepEqual(p.tasks[0].acceptance[0].history.map(h => [h.revision, h.result]), [[1, 'changes_requested'], [1, 'discarded']])
  assert.equal(taskState(p.tasks[0]), 'review')
  assert.deepEqual(attention(p).map(i => i.itemId), [other.id])
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

test('overview reads registered projects with closed workspaces without writing and includes their queues and executions', async () => {
  const p = fresh(refs[0]); p.runId = 'run_project'
  submitTask(p, { ...deliverable, executions: [{ runId: 'run_job', taskId: 'orca-task', dispatchId: 'dispatch', agent: 'codex' }] })
  submitTask(p, { id: 'blocked', title: '依赖受阻', goal: '修复依赖', phase: 'blocked', decisions: [{ id: 'ask', question: '选择方案？' }] })
  submitTask(p, { ...deliverable, id: 'rework' })
  feedback(p, { items: [{ taskId: 'rework', kind: 'acceptance', itemId: 'page-check', itemRevision: 1, result: 'changes_requested', note: '调整标题' }] })
  const host = mockHost({ storage: { 'project:p1': p as any, workspace: { version: 1, revision: 0, runId: p.runId, requests: [] } } })
  const before = structuredClone(host.data().storage)
  let catalogReads = 0
  const runtime: Partial<CoordinatorRuntime> = { projects: async () => { catalogReads++; return [{ ...refs[0], workspace: '' }, refs[1]] }, verifyRun: async () => {}, send: async () => { throw new Error('must not send') } }
  const worker = await mountWorker({ default: (orca: OrcaWorkerApi) => { createCoordinator(orca, runtime) } }, { host })
  const all = await worker.request('workspace.overview')
  assert.equal(catalogReads, 1)
  assert.deepEqual(all.workspace.projectNames, [p.ref.name])
  assert.equal(all.workspace.revision, 0); assert.equal(all.workspace.runId, p.runId)
  assert.deepEqual(all.attention.map(a => a.kind).sort(), ['blocked', 'decision', 'review', 'rework'])
  assert.equal(all.projects.length, 2)
  assert.equal(all.projects[0].counts.review, 1)
  assert.equal(all.projects[0].agents[0].dispatchId, 'dispatch')
  assert.equal(all.projects[0].agents[0].projectTaskId, 'task-1')
  assert.deepEqual((await worker.request('project.agent', { operation: 'read', projectId: 'p1' })).project, p)
  assert.deepEqual({ ...host.data().storage, 'workspace.connections': undefined }, { ...before, 'workspace.connections': undefined })
  await worker.deactivate()
})

test('incomplete workspace records fail without overwriting the binding', async () => {
  const saved = { version: 1, runId: 'run_bound' }, host = mockHost({ storage: { workspace: saved } })
  const worker = await mountWorker({ default: (orca: OrcaWorkerApi) => { createCoordinator(orca, {}) } }, { host })
  await assert.rejects(() => worker.request('workspace.agent', { operation: 'read' }), /工作间记录格式/)
  assert.deepEqual(host.data().storage.workspace, saved)
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
  assert.deepEqual((await worker.request('workspace.overview')).workspace, { ...bound, session: { ...bound.session, online: 'unknown' } })
  await worker.deactivate()
})

test('main messages use the existing source queue and retries never duplicate a delivery', async () => {
  const p = fresh(refs[0]); p.runId = 'run_project'
  const host = mockHost({ storage: { 'project:p1': p as any, workspace: { version: 1, revision: 1, runId: 'run_main', requests: [] } } })
  let coordinator!: ReturnType<typeof createCoordinator>
  const sends: { runId: string; body: string }[] = []
  let deliveredAfterBinding!: () => void
  const afterBinding = new Promise<void>(resolve => { deliveredAfterBinding = resolve })
  const runtime: Partial<CoordinatorRuntime> = { projects: async () => refs, verifyRun: async () => {}, send: async (runId, d) => {
    sends.push({ runId, body: d.body }); if (runId === 'run_new') deliveredAfterBinding()
    return { requestId: 'sent-main-message' }
  } }
  const worker = await mountWorker({ default: (orca: OrcaWorkerApi) => { coordinator = createCoordinator(orca, runtime) } }, { host })
  const input = { projectId: 'p1', revision: 0, requestId: 'message-1', runId: 'run_main', text: '请核对本项目进展' }
  await assert.rejects(() => worker.request('workspace.message', { ...input, runId: 'run_unknown' }))
  await assert.rejects(() => worker.request('workspace.message', { ...input, projectId: 'p2', runId: 'run_unknown' }))
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
  assert.ok(sends[0].body.includes('工作间主 agent 转来'))
  assert.equal((await coordinator.store.get('p2')).events.length, 0)
  const unbound = { projectId: 'p2', requestId: input.requestId, runId: input.runId, text: input.text }
  const queued = await worker.request('workspace.message', unbound)
  assert.equal(queued.queued, '项目还没有主会话，已排队')
  await worker.request('workspace.message', unbound)
  await coordinator.flush('p2')
  assert.equal(sends.length, 1)
  assert.equal((await coordinator.store.get('p2')).events.length, 1)
  assert.equal((await coordinator.store.get('p2')).deliveries[0].state, 'pending')
  await worker.request('project.agent', { operation: 'bind', projectId: 'p2', revision: queued.project!.revision, requestId: 'bind-p2', runId: 'run_new' })
  await Promise.race([afterBinding, new Promise((_, reject) => { setTimeout(() => reject(Error('绑定后没有启动投递')), 2000).unref() })])
  await coordinator.flush('p2')
  await worker.request('workspace.message', unbound)
  await coordinator.flush('p2')
  assert.deepEqual(sends.map(s => s.runId), ['run_project', 'run_new'])
  assert.equal((await coordinator.store.get('p2')).deliveries[0].state, 'sent')
  coordinator.stop(); await worker.deactivate()
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

test('empty connection reads do not create a directory', async () => {
  const host = mockHost()
  const before = structuredClone(host.data().storage)
  const worker = await mountWorker({ default: (api: OrcaWorkerApi) => { createCoordinator(api, {}) } }, { host })
  try { assert.deepEqual(await worker.request('workspace.connections', { operation: 'read' }), []); assert.deepEqual(host.data().storage, before) }
  finally { await worker.deactivate() }
})
