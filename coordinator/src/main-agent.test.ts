import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import type { AgentSession } from './model'
import { testCoordinator as createCoordinator } from './test-runtime'
import { fresh } from './store'
import { refs } from './fixtures'
import { mainTargets, OrcaRuntime } from './runtime'
import { roleReminder } from './main-agent'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { defaultAgent } from './model'

const session: AgentSession = { handle: 'orca_session_id:test-next', title: '测试接管会话', workspace: 'identity:test-workspace', workspaceName: '测试工作区', path: '/test/workspace', agent: 'claude', online: 'online' }
const tokenFrom = (prompt: string) => /一次性接管凭据：([^\n]+)/.exec(prompt)![1]

const projectWorkspaceId = 'identity:wt2:local:project'
const projectRef = { ...refs[0], workspace: projectWorkspaceId }
const projectSession: AgentSession = { ...session, workspace: projectWorkspaceId, path: projectRef.path }
const testWorkspace = { id: projectWorkspaceId, projectId: projectRef.repoId, hostId: 'local', path: projectRef.path, kind: 'worktree', name: '本项目', branch: 'main' }

test('project lead switches only within its workspace and preserves tasks and queued deliveries', async () => {
  const p = fresh(projectRef), other = fresh(refs[1])
  p.runId = 'run_old'
  p.mainAgentHandle = 'orca_session_id:claude_old'
  p.tasks.push({ id: 'task', title: '已存在的问题', goal: '保留现场', phase: 'working', progress: '', executions: [
    { runId: 'run_existing', taskId: 'task_existing', dispatchId: 'dispatch_existing', agent: 'codex' }
  ], artifacts: [], decisions: [{ id: 'decision', question: '下一步', options: ['继续'], history: [] }], acceptance: [], sourceIds: [], updatedAt: '' })
  p.deliveries.push({ id: 'queued', subject: '队列', body: '给当前项目主会话', state: 'pending' })
  other.runId = 'run_taken'
  const old: AgentSession = { ...projectSession, handle: p.mainAgentHandle, title: '当前会话' }
  const replacement: AgentSession = { ...projectSession, handle: 'orca_session_id:antigravity_replacement', title: '替补会话', agent: 'antigravity' }
  const outsider = { ...projectSession, handle: 'other-workspace', workspace: 'identity:elsewhere' }
  const occupied = { ...projectSession, handle: 'orca_session_id:codex_other_project', agent: 'codex' }
  other.mainAgentHandle = occupied.handle
  let sessions = [old, projectSession, replacement, outsider, occupied]
  const host = mockHost({ storage: { 'project:p1': p as any, 'project:p2': other as any, workspace: { version: 1, revision: 0, runId: 'run_owner', requests: [] } }, results: {
    'workspace.list': { workspaces: [testWorkspace, { ...testWorkspace, id: outsider.workspace, projectId: refs[1].repoId }], truncated: false },
    'agents.list': { agents: [] }
  } })
  let c!: ReturnType<typeof createCoordinator>
  const requests: { handle: string; prompt: string; subject?: string }[] = [], notices: { run: string; body: string }[] = []
  const worker = await mountWorker({ default: api => { c = createCoordinator(api, {
    projects: async () => [projectRef, refs[1]],
    targets: async () => ({ sessions, workspaces: [{ workspace: projectWorkspaceId, name: '本项目', path: p.ref.path }] }),
    identify: async (handle, run, own) => {
      const target = sessions.find(s => s.handle === handle && s.online === 'online')
      if (!target || run !== own) throw Error('会话不在线或 Run 不匹配')
      return target
    },
    requestTakeover: async (handle, prompt, subject) => { requests.push({ handle, prompt, subject }) },
    send: async (run, d) => { notices.push({ run, body: d.body }); return {} }
  }) } }, { host })
  const read = () => worker.request('project.lead', { projectId: 'p1' })
  const choose = async (handle: string) => worker.request('project.lead', { projectId: 'p1', revision: (await read()).binding.revision, mode: 'existing', handle })
  const bind = async (r: number, i: number, runId: string, caller = requests[i].handle) => worker.request('project.agent', {
    projectId: 'p1', operation: 'bind', revision: r, requestId: 'handoff-' + runId, runId, currentRunId: runId, caller, token: tokenFrom(requests[i].prompt)
  })
  try {
    await assert.rejects(() => worker.request('project.agent', { operation: 'bind', projectId: 'p1', revision: p.revision, requestId: 'conflicting-bind', runId: 'run_owner' }), /独立的项目 Run/)
    const start = await read()
    assert.deepEqual(start.sessions.map(s => s.handle), [old.handle, projectSession.handle, replacement.handle, occupied.handle])
    assert.deepEqual(start.binding.session, old)
    await assert.rejects(() => choose(outsider.handle), /不可用/)
    await assert.rejects(() => choose(occupied.handle), /已用于其他主会话/)
    await assert.rejects(() => worker.request('workspace.projectLead', { projectId: 'p1', revision: 0, mode: 'existing', handle: projectSession.handle, runId: 'run_other' }), /已绑定的工作间主 agent Run/)
    assert.equal(requests.length, 0)
    const first = await worker.request('workspace.projectLead', { projectId: 'p1', revision: 0, mode: 'existing', handle: projectSession.handle, runId: 'run_owner' })
    assert.equal(first.binding.runId, 'run_old')
    assert.equal(first.binding.takeover?.state, 'waiting')
    assert.ok(requests[0].prompt.includes('$orca-project-coordinator'))
    assert.ok(requests[0].prompt.includes('project-lead-bind'))
    assert.ok(requests[0].prompt.endsWith(roleReminder.project))
    assert.ok(requests[0].subject?.includes('接管项目主会话'))
    assert.equal(JSON.stringify(first).includes('tokenHash'), false)
    const snapshot = await worker.request('project.read', { projectId: 'p1' })
    assert.equal(JSON.stringify(snapshot).includes('tokenHash'), false)
    assert.equal(JSON.stringify(host.data().storage).includes(tokenFrom(requests[0].prompt)), false)
    await assert.rejects(() => choose(projectSession.handle), /已发起/)
    const switched = await choose(replacement.handle)
    await assert.rejects(() => bind(switched.binding.revision, 0, 'run_replaced'), /接管凭据/)
    await assert.rejects(() => bind(switched.binding.revision, 1, 'run_taken'), /已绑定其他项目/)
    await assert.rejects(() => bind(switched.binding.revision, 1, 'run_owner'), /独立的项目 Run/)
    await assert.rejects(() => bind(switched.binding.revision, 1, 'run_wrong_identity', projectSession.handle), /不属于当前会话/)
    const cancelled = await worker.request('project.lead', { projectId: 'p1', revision: switched.binding.revision, mode: 'cancel' })
    assert.equal(cancelled.binding.takeover, undefined)
    await assert.rejects(() => bind(cancelled.binding.revision, 1, 'run_cancelled'), /接管凭据/)
    await choose(projectSession.handle)
    await c.store.mutate('p1', undefined, p => { p.takeover!.expiresAt = new Date(Date.now() - 1).toISOString() })
    const expired = await read()
    assert.equal(expired.binding.takeover?.state, 'expired')
    await assert.rejects(() => bind(expired.binding.revision, 2, 'run_expired'), /接管凭据/)
    const final = await choose(replacement.handle)
    sessions = [old, projectSession]
    await assert.rejects(() => bind(final.binding.revision, 3, 'run_next'), /不在线/)
    sessions.push(replacement)
    const bound = await bind(final.binding.revision, 3, 'run_next')
    assert.equal(bound.project?.runId, 'run_next')
    assert.equal(bound.project?.mainAgentHandle, replacement.handle)
    assert.equal(bound.lead?.session?.agent, 'antigravity')
    await assert.rejects(() => worker.request('project.agent', { operation: 'bind', projectId: 'p1', revision: bound.project!.revision, requestId: 'unsafe-rebind', runId: 'run_other' }), /接管凭据/)
    assert.equal(bound.lead?.takeover, undefined)
    assert.equal(bound.lead?.session?.title, replacement.title)
    assert.deepEqual(bound.project?.tasks, p.tasks)
    await c.flush('p1')
    assert.equal(notices.filter(n => n.run === 'run_old' && n.body.includes('停止派活') && n.body.includes(replacement.title)).length, 1)
    assert.deepEqual(notices.filter(n => n.run === 'run_next').map(n => n.body), [`给当前项目主会话\n\n${roleReminder.project}`])
    await bind(final.binding.revision, 3, 'run_next')
    await c.flush('p1')
    assert.equal(notices.length, 2)
    sessions = []
    const offline = (await read()).binding.session
    assert.equal(offline?.online, 'offline'); assert.equal(offline?.title, replacement.title)
  } finally { c.stop(); await worker.deactivate() }
})

test('project roles and new leads use the current workspace catalog and Orca launch preferences', async () => {
  const launches: string[][] = [], fakeCli = new OrcaRuntime(async () => 'never-start-a-real-process')
  ;(fakeCli as any).call = async (args: string[]) => {
    launches.push(args)
    return { outcome: { kind: 'structured', sessionId: 'fake-' + launches.length }, prompt: { outcome: 'journaled' } }
  }
  const host = mockHost({ storage: { 'project:p1': fresh(projectRef) as any }, results: {
    'workspace.list': { workspaces: [testWorkspace], truncated: false }, 'agents.list': { agents: [] }
  } })
  let c!: ReturnType<typeof createCoordinator>, ref = projectRef
  let installed = ['claude', 'codex', 'antigravity', 'qoder']
  const worker = await mountWorker({ default: api => { c = createCoordinator(api, {
    projects: async () => [ref], launchMain: fakeCli.launchMain.bind(fakeCli),
    installedAgents: async workspace => { assert.equal(workspace, projectWorkspaceId); return installed.map(id => ({ id, name: id, default: id === 'qoder' })) },
    targets: async () => ({ sessions: [], workspaces: [{ workspace: projectWorkspaceId, name: '本项目', path: ref.path }] })
  }) } }, { host })
  const read = () => worker.request('project.lead', { projectId: ref.id })
  const launch = async (agent?: string) => worker.request('project.lead', { projectId: ref.id, revision: (await read()).binding.revision, mode: 'new', ...(agent ? { agent } : {}) })
  try {
    assert.equal(defaultAgent((await read()).availableAgents!), 'qoder')
    const roles = { design: 'antigravity', code: 'codex', review: 'qoder' }
    const settings = await worker.request('project.settings', { projectId: ref.id, revision: (await read()).binding.revision, roles })
    assert.deepEqual(settings.project!.roles, roles)
    assert.deepEqual((await read()).leadAgents, { primary: { agent: 'antigravity' }, backup: { agent: 'codex' } })
    for (const choice of [undefined, 'codex']) {
      const result = await launch(choice)
      assert.equal(result.binding.takeover?.target.handle, 'orca_session_id:fake-' + launches.length)
      assert.equal(result.binding.takeover?.state, 'waiting')
      assert.equal(result.binding.takeover?.backupAgent, choice === 'codex' ? undefined : 'codex')
      const argv = launches.at(-1)!, agent = choice ?? 'antigravity'
      const flag = (k: string) => argv.includes('--' + k) ? argv[argv.indexOf('--' + k) + 1] : undefined
      assert.equal(flag('agent'), agent)
      assert.equal(flag('model'), undefined)
      assert.equal(flag('effort'), undefined)
      assert.equal(flag('surface'), undefined)
      assert.equal(flag('worktree'), projectWorkspaceId)
      await assert.rejects(() => launch(choice), /已发起/)
      await worker.request('project.lead', { projectId: ref.id, revision: result.binding.revision, mode: 'cancel' })
    }
    const saveLead = async (leadAgents: import('./model').Project['leadAgents']) =>
      worker.request('project.settings', { projectId: ref.id, revision: (await read()).binding.revision, leadAgents })
    await assert.rejects(() => saveLead({ backup: { agent: 'antigravity' } }), /需要选择不同/)
    await saveLead({ primary: { agent: 'codex' }, backup: { agent: 'antigravity' } })
    const fresh = await read()
    const auto = { projectId: ref.id, revision: fresh.binding.revision, workspace: projectWorkspaceId, mode: 'new' as const, startOnly: true }
    const manual = { projectId: auto.projectId, revision: auto.revision, mode: auto.mode }
    const double = await Promise.allSettled([worker.request('project.lead', auto), worker.request('project.lead', manual)])
    assert.equal(double.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal((await read()).binding.takeover?.target.agent, 'codex')
    assert.equal((await read()).binding.takeover?.backupAgent, 'antigravity')
    installed = ['codex']
    assert.deepEqual((await read()).roleAgents?.map(a => a.id), ['codex'])
    await assert.rejects(() => worker.request('project.settings', { projectId: ref.id, revision: (host.data().storage['project:p1'] as any).revision, roles }), /不可用/)
    assert.deepEqual((await worker.request('project.read', { projectId: ref.id })).project?.roles, roles)
    await c.store.mutate(ref.id, undefined, project => { project.takeover!.state = 'sending' })
    await c.start()
    assert.equal((await read()).binding.takeover?.state, 'uncertain')
    await assert.rejects(() => launch('antigravity'), /不可用/)
    assert.equal(launches.length, 3)
    ref = { ...ref, workspace: '' }
    host.respond('workspace.list', { workspaces: [], truncated: false })
    assert.ok((await read()).workspaceError?.includes('没有工作区'))
    await assert.rejects(() => launch(), /没有工作区/)
    assert.equal(launches.length, 3)
  } finally { c.stop(); await worker.deactivate() }
})

for (const runId of ['', 'run_old']) test(`takeover can be replaced and cancelled while sending, old credentials stay invalid (${runId || 'unbound'})`, async () => {
  const other = { ...session, handle: 'orca_session_id:other', title: '另一个会话' }
  const host = mockHost({ storage: { workspace: { version: 1, revision: 0, runId, requests: [] } } })
  let c!: ReturnType<typeof createCoordinator>, started!: () => void, finish!: () => void
  const sending = new Promise<void>(r => { started = r }), delay = new Promise<void>(r => { finish = r })
  const prompts: string[] = []
  const worker = await mountWorker({ default: (api: OrcaWorkerApi) => { c = createCoordinator(api, {
    targets: async () => ({ sessions: [session, other], workspaces: [] }), identify: async handle => handle === session.handle ? session : other,
    requestTakeover: async (handle, prompt) => { prompts.push(prompt); if (handle === session.handle) { started(); await delay; throw Error('late timeout') } }
  }) } }, { host })
  try {
    const first = worker.request('workspace.agent.switch', { mode: 'existing', revision: 0, handle: session.handle })
    await sending
    const read = () => worker.request('workspace.agent', { operation: 'read' })
    const replacement = await worker.request('workspace.agent.switch', { mode: 'existing', revision: (await read()).revision, handle: other.handle })
    finish(); await first
    assert.equal((await read()).takeover?.id, replacement.takeover?.id)
    assert.equal((await read()).takeover?.state, 'waiting')
    const bind = (token: string, caller = other.handle) => worker.request('workspace.agent', { operation: 'bind', revision: (host.data().storage.workspace as any).revision, requestId: 'bind-test', runId: 'run_new', caller, token, checkOnly: true })
    await assert.rejects(() => bind(tokenFrom(prompts[0]), session.handle))
    assert.ok((await bind(tokenFrom(prompts[1]))).check?.canTakeOver)
    const cancelled = await worker.request('workspace.agent.switch', { mode: 'cancel', revision: (await read()).revision })
    assert.equal(cancelled.takeover, undefined); assert.equal(cancelled.runId, runId)
    await assert.rejects(() => bind(tokenFrom(prompts[1])))
    const retry = await worker.request('workspace.agent.switch', { mode: 'existing', revision: cancelled.revision, handle: other.handle })
    const accepted = await worker.request('workspace.agent', { operation: 'bind', revision: retry.revision, requestId: 'fresh-bind', runId: 'run_new', caller: other.handle, token: tokenFrom(prompts[2]) })
    assert.equal(accepted.runId, 'run_new'); assert.equal(accepted.takeover, undefined)
    await assert.rejects(() => bind(tokenFrom(prompts[2])))
  } finally { finish(); c.stop(); await worker.deactivate() }
})

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
    assert.ok(t.takeover?.error?.includes('未能确认送达'))
    await c.start(); await c.start(); assert.equal(requests, 1)
    const bound = await worker.request('workspace.agent', { operation: 'bind', revision: t.revision, requestId: 'test', caller: session.handle, runId: 'run_new', token: tokenFrom(prompt) })
    assert.equal(bound.previousNotice, 'uncertain'); assert.equal(bound.runId, 'run_new')
    await c.store.mutateWorkspace(w => { w.retired!.push({ id: 'lead-control:fixture', subject: '探测', body: '', state: 'sent' }) })
    assert.equal((await worker.request('workspace.agent', { operation: 'read' })).previousNotice, 'uncertain')
    await c.start(); assert.equal(sends, 1)
  } finally { c.stop(); await worker.deactivate() }
})

for (const mode of ['existing', 'new'] as const) test(`main takeover ${mode}: target owns new Run, only valid token replaces the previous binding, notices follow new binding`, async () => {
  const project = fresh(refs[0]); project.runId = 'run_project'
  const binding = { version: 1, revision: 2, session: { ...session, handle: 'previous-handle' }, runId: 'run_old', requests: [] }
  const host = mockHost({ storage: { workspace: binding, 'project:p1': project as any } })
  const prompts: string[] = [], sends: { run: string; subject: string; body: string }[] = []
  let c!: ReturnType<typeof createCoordinator>, launched = 0
  const worker = await mountWorker({ default: (api: OrcaWorkerApi) => {
    c = createCoordinator(api, {
      projects: async () => refs, verifyRun: async () => {},
      identify: async (handle, run) => { if (handle !== session.handle || run !== 'run_next') throw Error('not own Run'); return session },
      targets: async () => ({ sessions: [session], workspaces: [{ workspace: session.workspace, name: session.workspaceName, path: session.path }] }),
      requestTakeover: async (handle, prompt) => { assert.equal(handle, session.handle); prompts.push(prompt) },
      launchMain: async (workspace, agent, prompt) => { assert.equal(workspace, session.workspace); assert.equal(agent, 'claude'); launched++; prompts.push(prompt); return session.handle },
      send: async (run, d) => { sends.push({ run, subject: d.subject, body: d.body }); return {} }
    }, { sync: async () => {}, stop() {}, state: () => ({ state: 'off', message: '' }), send: async () => 'test' })
  } }, { host })
  try {
    const before = await worker.request('workspace.agent', { operation: 'read' })
    assert.equal(before.runId, 'run_old'); assert.equal(before.session?.handle, 'previous-handle')
    assert.deepEqual(host.data().storage.workspace, binding)
    const bind = { operation: 'bind' as const, runId: 'run_next', caller: session.handle, revision: 2, requestId: 'test-bind' }
    await assert.rejects(() => worker.request('workspace.agent', bind))
    const switching = await worker.request('workspace.agent.switch', { revision: 2, mode, ...(mode === 'existing' ? { handle: session.handle } : { workspace: session.workspace, agent: 'claude' }) })
    assert.equal(switching.runId, 'run_old'); assert.equal(switching.takeover?.state, 'waiting')
    assert.equal(launched, mode === 'new' ? 1 : 0)
    const token = tokenFrom(prompts[0]); assert.equal(JSON.stringify(host.data().storage).includes(token), false)
    const script = JSON.parse(/接管脚本绝对路径：([^\n]+)/.exec(prompts[0])![1])
    assert.ok(path.isAbsolute(script)); assert.ok(existsSync(script)); assert.ok(prompts[0].includes('main-bind --check'))
    assert.ok(prompts[0].endsWith(roleReminder.workspace))
    assert.equal(JSON.stringify(switching).includes('tokenHash'), false)
    const current = () => worker.request('workspace.agent', { operation: 'read' })
    await assert.rejects(() => worker.request('workspace.agent', { ...bind, revision: switching.revision, token: 'wrong' }))
    await assert.rejects(() => worker.request('workspace.agent', { ...bind, revision: switching.revision }))
    await assert.rejects(() => worker.request('workspace.agent', { ...bind, revision: switching.revision, token, caller: 'another' }))
    await c.store.mutateWorkspace(w => { w.takeover!.expiresAt = new Date(Date.now() - 1).toISOString() })
    const expiredRevision = (await current()).revision
    assert.equal((await current()).takeover?.state, 'expired')
    assert.equal((await current()).takeover?.error, '对方没在有效期内完成绑定')
    await assert.rejects(() => worker.request('workspace.agent', { ...bind, revision: expiredRevision, token }))
    await c.store.mutateWorkspace(w => { w.takeover!.expiresAt = new Date(Date.now() + 60000).toISOString() })
    const good = { ...bind, revision: (await current()).revision, token }
    const savedBeforeCheck = structuredClone(host.data().storage), sendsBeforeCheck = sends.length
    const checked = await worker.request('workspace.agent', { ...good, checkOnly: true })
    assert.equal(checked.check?.canTakeOver, true)
    assert.deepEqual(host.data().storage, savedBeforeCheck); assert.equal(sends.length, sendsBeforeCheck)
    assert.equal((await worker.request('workspace.agent', { ...good, checkOnly: true })).check?.canTakeOver, true)
    await assert.rejects(() => worker.request('workspace.agent', { ...good, checkOnly: true, token: undefined }))
    await c.store.mutateWorkspace(w => { w.takeover!.target.handle = '' })
    await assert.rejects(() => worker.request('workspace.agent', { ...good, checkOnly: true, revision: (host.data().storage.workspace as any).revision }))
    await c.store.mutateWorkspace(w => { w.takeover!.target.handle = session.handle })
    good.revision = (await current()).revision
    const bound = await worker.request('workspace.agent', good)
    assert.equal(bound.runId, 'run_next'); assert.equal(bound.session?.title, session.title); assert.equal(bound.session?.online, 'online')
    assert.ok(bound.securityBoundary?.includes('一次性凭据'))
    assert.ok(bound.boundAt); assert.equal(bound.takeover, undefined)
    assert.deepEqual(await worker.request('workspace.agent', good), bound)
    await assert.rejects(() => worker.request('workspace.agent', { ...good, revision: bound.revision, requestId: 'reused-token' }))
    await assert.rejects(() => worker.request('workspace.agent', { ...good, checkOnly: true, revision: bound.revision, requestId: 'check-reused-token' }))
    assert.equal(sends.filter(s => s.run === 'run_old' && s.subject === '工作间主 agent 已切换').length, 1)
    await worker.request('project.agent', { operation: 'submit', projectId: 'p1', revision: 0, requestId: 'after-takeover', task: { id: 'after', title: '测试新通知', goal: '测试', phase: 'blocked' } })
    await c.flush('p1')
    assert.ok(sends.some(s => s.run === 'run_next' && s.subject.includes('测试新通知')))
    await c.store.mutateMessaging(m => { m.feishu = { enabled: true, appId: 'test-app', chatIds: ['chat'], senderIds: ['owner'] } })
    await c.ingest('test-app', { id: 'new-feishu', source: 'feishu', sourceId: 'test-app:event', threadId: '', chatId: 'chat', senderId: 'owner', text: '测试新飞书消息', receivedAt: new Date().toISOString() })
    await c.flushMailbox()
    assert.ok(sends.some(s => s.run === 'run_next' && s.subject === '飞书工作间消息' && s.body.endsWith('测试新飞书消息\n回复用 feishu-reply，eventId 填来源编号。')))
    assert.equal(sends.filter(s => s.run === 'run_old').length, 1)
    const saved = JSON.stringify(host.data().storage)
    await worker.request('workspace.overview'); await worker.request('project.read', { projectId: 'p1' })
    assert.equal(JSON.stringify(host.data().storage), saved)
    assert.deepEqual(worker.refusals, [])
  } finally { c.stop(); await worker.deactivate() }
})

test('chatNotDeclarable: plugin independently reads Run and sessions, never queries run-current for a chat', async () => {
  const runtime = new OrcaRuntime(async () => 'unused'), calls: string[][] = []
  let observation = 'live'
  ;(runtime as any).call = async (args: string[]) => {
    calls.push(args)
    if (args[1] === 'run-current') throw Error('chatNotDeclarable: cannot declare another chat')
    if (args[1] === 'run-show') return { run: { id: args[3], coordinator_handle: null, consumer_generation: 1 } }
    if (args[0] === 'terminal') return { terminals: [] }
    return { worktrees: [{ address: { environment: 'local', worktree: session.workspace }, path: session.path, agents: [{ paneKey: 'structured-agent-session-test-next:pane', agentType: 'claude', subagentObservation: observation }] }] }
  }
  await assert.rejects(() => (runtime as any).call(['orchestration', 'run-current', '--from', session.handle]), /chatNotDeclarable/)
  calls.length = 0
  await runtime.verifyRun('run_next')
  assert.equal((await runtime.identify(session.handle, 'run_next', 'run_next')).handle, session.handle)
  await assert.rejects(() => runtime.identify(session.handle, 'run_next', 'run_other'), /自报/)
  await assert.rejects(() => runtime.identify(session.handle, 'run_next'), /自报/)
  await assert.rejects(() => runtime.identify('orca_session_id:missing', 'run_next', 'run_next'), /在线/)
  observation = 'unverifiable'
  await assert.rejects(() => runtime.identify(session.handle, 'run_next', 'run_next'), /在线/)
  assert.ok(calls.some(a => a[1] === 'run-show'))
  assert.equal(calls.some(a => a.includes('run-current') || a.includes('--from')), false)
})

test('new-agent launch accepts Orca 1.4.258 flat receipts and uses the chat session ID, not its tab handle', async () => {
  const runtime = new OrcaRuntime(async () => 'unused')
  const chat = { outcome: { kind: 'structured', sessionId: 'claude_test', handle: 'structured-agent-session-claude_test' }, prompt: { outcome: 'journaled' } }
  for (const result of [chat]) {
    ;(runtime as any).call = async () => result
    assert.equal(await runtime.launchMain('workspace', 'claude', 'test'), 'orca_session_id:claude_test')
  }
  ;(runtime as any).call = async () => ({ outcome: { kind: 'terminal', handle: 'terminal-exact' }, prompt: { outcome: 'handed-to-terminal' } })
  assert.equal(await runtime.launchMain('workspace', 'claude', 'test'), 'terminal-exact')
  ;(runtime as any).call = async () => ({ outcome: chat.outcome, prompt: { outcome: 'unknown' } })
  await assert.rejects(() => runtime.launchMain('workspace', 'claude', 'test'), /待核对/)
  ;(runtime as any).call = async () => ({ outcome: { kind: 'structured', handle: 'structured-agent-session-unknown' }, prompt: chat.prompt })
  await assert.rejects(() => runtime.launchMain('workspace', 'claude', 'test'), /待核对/)
})

test('Run coordinator, when Orca provides it, independently rejects a conflicting caller', async () => {
  const runtime = new OrcaRuntime(async () => 'unused')
  ;(runtime as any).call = async () => ({ run: { id: 'run_next', coordinator_handle: 'terminal-owner' } })
  await runtime.verifyRun('run_next', 'terminal-owner')
  await assert.rejects(() => runtime.verifyRun('run_next', 'terminal-other'), /协调者/)
  await runtime.verifyRun('run_next')
  ;(runtime as any).call = async () => ({ run: { id: 'run_next', coordinator_handle: null } })
  await runtime.verifyRun('run_next', session.handle)
})

test('status count follows submissions, feedback, hide and restore; command opens overview', async () => {
  const host = mockHost(), opened: boolean[] = []
  let c!: ReturnType<typeof createCoordinator>
  const worker = await mountWorker({ default: (api: OrcaWorkerApi) => { c = createCoordinator(api, {
    projects: async () => refs, verifyRun: async () => {}, send: async () => ({}), openOverview: async () => { opened.push(true) }
  }) } }, { host })
  const count = async () => { await c.updateStatus(); return (host.callsOf('statusBar.update').at(-1) as any).text }
  try {
    assert.equal(await count(), '工作间 · 待处理 0')
    let p = (await worker.request('project.agent', { operation: 'submit', projectId: 'p1', revision: 0, requestId: 'status', task: { id: 't', title: '测试数量', goal: '测试', phase: 'working', decisions: [{ id: 'd', question: '测试问题', options: ['是'] }] } })).project!
    assert.equal(await count(), '工作间 · 待处理 1')
    p = (await worker.request('project.visibility', { projectId: 'p1', revision: p.revision, hidden: true })).project!
    assert.equal(await count(), '工作间 · 待处理 0')
    p = (await worker.request('project.visibility', { projectId: 'p1', revision: p.revision, hidden: false })).project!
    assert.equal(await count(), '工作间 · 待处理 1')
    await worker.request('project.feedback', { projectId: 'p1', revision: p.revision, items: [{ taskId: 't', kind: 'decision', itemId: 'd', answer: '是'  }] })
    assert.equal(await count(), '工作间 · 待处理 0')
    await worker.command('workspace.overview'); assert.equal(opened.length, 1)
    assert.ok(worker.posts.some(p => p.event === 'workspace.open'))
    assert.deepEqual(worker.refusals, [])
  } finally { c.stop(); await worker.deactivate() }
})

test('Orca send and takeover subjects have one project-coordinator prefix without changing stored deliveries', async () => {
  const runtime = new OrcaRuntime(async () => 'unused'), calls: string[][] = []
  ;(runtime as any).call = async (args: string[]) => { calls.push(args); return { mutation: { requestId: 'mock-receipt' } } }
  for (const subject of ['模拟提醒', '【项目协作】模拟提醒']) {
    const delivery = { id: 'test-only', subject, body: '模拟正文', state: 'pending' as const }, before = structuredClone(delivery)
    await runtime.send('run_mock', delivery)
    const args = calls.at(-1)!
    assert.equal(args[args.indexOf('--subject') + 1], '【项目协作】模拟提醒')
    assert.deepEqual(delivery, before)
  }
  await runtime.requestTakeover('mock-session', '模拟接管提示')
  const args = calls.at(-1)!
  assert.equal(args[args.indexOf('--subject') + 1], '【项目协作】请接管工作间主 agent')
})

test('runtime target parser uses exact chat session and terminal pane; unknown liveness is never online', () => {
  const ws = { address: { environment: 'local', worktree: 'identity:workspace' }, path: '/test', displayName: '工作区', agents: [
    { paneKey: 'structured-agent-session-test-session:pane', conversationName: '会话', agentType: 'claude', subagentObservation: 'live' },
    { paneKey: 'structured-agent-session-idle:pane', agentType: 'claude', subagentObservation: 'unverifiable' },
    { paneKey: 'structured-agent-session-closed:pane', agentType: 'claude', subagentObservation: 'exited' },
    { paneKey: 'tab:leaf', agentType: 'codex', agentWait: { liveness: 'live' } },
    { paneKey: 'structured-agent-session-stale:pane', agentType: 'claude', state: 'working' },
    { paneKey: 'structured-agent-session-child:pane', parentPaneKey: 'parent', subagentObservation: 'live' }
  ] }
  const t = mainTargets([ws], [{ tabId: 'tab', leafId: 'leaf', handle: 'terminal-exact', connected: true, writable: true }])
  assert.deepEqual(t.sessions.map(s => [s.handle, s.online]), [['orca_session_id:test-session', 'online'], ['orca_session_id:idle', 'unknown'], ['orca_session_id:closed', 'offline'], ['terminal-exact', 'online'], ['orca_session_id:stale', 'unknown']])
  assert.equal(mainTargets([{ ...ws, hostId: 'remote' }], []).sessions.length, 0)
  for (const time of [undefined, NaN, Infinity, 0]) {
    const [session] = mainTargets([{ ...ws, agents: [{ ...ws.agents[4], stateStartedAt: time }] }], []).sessions
    assert.equal(session.state, 'working')
    assert.equal(Object.hasOwn(session, 'stateStartedAt'), time === 0)
  }
})
