import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { readAgents, agentState, maxAgentWorkspaces, maxAgents } from './agents'
import { testCoordinator } from './test-runtime'
import { fresh, projectKey } from './store'
import { refs } from './fixtures'
import { OrcaRuntime } from './runtime'

const workspace = { id: 'ws-one', hostId: 'local', projectId: refs[0].repoId, path: '/example', kind: 'worktree', name: '示例', branch: 'main' }
const agent = (state = 'working', sessionId = 's1') => ({ terminalId: null, title: '会话', agent: 'codex', state, stateStartedAt: Date.now(), sessionId })
async function snapshot(workspaces: any[], agents: any, projects = [fresh({ ...refs[0], id: projectKey('local', refs[0].repoId) })], read: (args: string[]) => Promise<any> = async () => ({}), truncated = false, main?: import('./model').AgentSession) {
  const host = mockHost({ results: { 'workspace.list': { workspaces, truncated }, 'agents.list': agents } })
  let api!: OrcaWorkerApi
  const worker = await mountWorker({ default: value => { api = value } }, { host })
  try { return { result: await readAgents(api.host, read, projects, main), host } }
  finally { await worker.deactivate() }
}

test('bound main samples its own workspace without showing it as a project; exact identity only', async () => {
  const main = { handle: 'orca_session_id:main', workspace: 'id:' + workspace.id, path: workspace.path, workspaceName: '测试', title: '同名', agent: 'claude', online: 'online' as const }
  const since = Date.now() - 300000
  for (const [state, expected] of [['working','work'],['waiting','need'],['blocked','need'],['done','idle'],['other','unknown'],['exited','offline'],['duplicate','unknown']]) {
    const own = { paneKey: 'structured-agent-session-main:pane', stateStartedAt: since, state, subagentObservation: state === 'exited' ? 'exited' : 'live' }
    const inventory = { worktrees: [{ address: { environment: 'local', worktree: main.workspace }, agents: [own, { ...own, paneKey: 'structured-agent-session-other:pane', state:'working' }, ...(state === 'duplicate' ? [own] : [])] }] }
    const { result, host } = await snapshot([workspace], { agents: [] }, [], async () => inventory, false, main)
    assert.equal(host.callsOf('agents.list').length, 1); assert.deepEqual(result.agents, [])
    assert.deepEqual(result.main, { handle: main.handle, status: ['work','need'].includes(expected) ? {state: expected, since} : {state: expected} })
  }
  const terminal = { ...main, handle:'term-exact' }
  const { result } = await snapshot([workspace], { agents:[{...agent('working'),title:'同名',terminalId:'other'}, {...agent('waiting'),title:'同名',terminalId:terminal.handle,stateStartedAt:since}] }, [], undefined, false, terminal)
  assert.deepEqual(result.main?.status,{state:'need',since})
})

test('host status maps waiting/blocked to need, working to work and done to done', async () => {
  assert.deepEqual(['waiting', 'blocked', 'working', 'done'].map(s => agentState(s as any)), ['need', 'need', 'work', 'done'])
  const old = { ...agent('done', 'old'), stateStartedAt: Date.now() - 86400001 }
  const { result, host } = await snapshot([workspace, { ...workspace, id: 'remote', hostId: 'ssh:remote' }, { ...workspace, id: 'old', projectId: 'removed' }], { agents: [...['waiting', 'blocked', 'working', 'done'].map((s, i) => agent(s, 's' + i)), old] })
  assert.equal(result.ok, true); assert.deepEqual(result.agents.map(a => a.state), ['need', 'need', 'work', 'done'])
  assert.ok(result.agents.every(a => a.projectId === projectKey('local', refs[0].repoId)))
  assert.deepEqual(host.callsOf('agents.list'), [{ workspaceId: workspace.id }])
  assert.deepEqual(host.refusals, [])
})

test('opening a waiting agent uses its live terminal or workspace and rejects stale selections', async () => {
  const ref = { ...refs[0], id: projectKey('local', refs[0].repoId) }
  const terminal = { ...agent('waiting', 'shared-session'), terminalId: 'terminal-exact' }
  const chat = { ...agent('blocked', 'shared-session'), task: { title: '关联的任务' } }
  const host = mockHost({ results: {
    'workspace.list': { workspaces: [workspace], truncated: false }, 'agents.list': { agents: [terminal, chat] },
    'terminal.focus': { focused: true }, 'workspace.open': { opened: true }
  } })
  let c!: ReturnType<typeof testCoordinator>
  const worker = await mountWorker({ default: api => {
    c = testCoordinator(api, { projects: async () => [ref], agents: projects => readAgents(api.host, async () => ({}), projects) })
  } }, { host })
  try {
    const [a, b] = (await worker.request('workspace.agents')).agents
    assert.equal(a.terminalId, terminal.terminalId); assert.equal(a.workspaceId, workspace.id)
    assert.equal(b.terminalId, undefined); assert.equal(b.workspaceId, workspace.id); assert.equal(b.taskTitle, '关联的任务')
    const open = (id: string) => worker.request('workspace.agent.open', { id })
    assert.deepEqual(await open(a.id), { opened: true, focusedTerminal: true })
    assert.deepEqual(host.callsOf('terminal.focus'), [{ terminalId: terminal.terminalId }]); assert.deepEqual(host.callsOf('workspace.open'), [])
    assert.deepEqual(await open(b.id), { opened: true, focusedTerminal: false })
    assert.deepEqual(host.callsOf('workspace.open'), [{ workspaceId: workspace.id }])
    host.respond('terminal.focus', { focused: false })
    await assert.rejects(() => open(a.id), /未切换到这个会话/)
    host.respond('agents.list', { agents: [{ ...terminal, state: 'working' }] })
    await assert.rejects(() => open(a.id), /已不需要你处理/)
    await assert.rejects(() => open(b.id), /已不需要你处理/)
    assert.equal(host.callsOf('terminal.focus').length, 2); assert.equal(host.callsOf('workspace.open').length, 1)
    assert.deepEqual(host.refusals, [])
  } finally { c.stop(); await worker.deactivate() }
})

test('exact terminal identities join saved executions; provider sessions, titles and ambiguous identities never join', async () => {
  const p = fresh({ ...refs[0], id: projectKey('local', refs[0].repoId) }); p.runId = 'run_one'
  p.tasks = [{ id: 't1', title: '插件任务', executions: [{ dispatchId: 'd1' }] }] as any
  const calls: string[][] = []
  const read = async (args: string[]) => { calls.push(args); return { workers: [{ dispatchId: 'd1', resource: { endpointIncarnation: 'structured:s1' } }, { dispatchId: 'd1', agentTerminalHandle: 'terminal-exact' }] } }
  const { result, host } = await snapshot([workspace, { ...workspace, id: 'ws-two' }], { agents: [agent(), { ...agent('working', 'terminal-session'), terminalId: 'terminal-exact' }, { ...agent('working', 'unknown'), task: { title: '插件任务' } }] }, [p], read)
  assert.equal(result.ok, true, JSON.stringify(host.refusals)); assert.equal(result.agents[0].taskId, undefined); assert.equal(result.agents[1].taskId, 't1'); assert.equal(result.agents[2].taskId, undefined)
  assert.equal(calls.length, 1); assert.equal(calls[0][1], 'worker-list')
  const ambiguous = await snapshot([workspace], { agents: [{ ...agent(), terminalId: 'terminal-exact' }] }, [p], async () => ({ workers: [{ dispatchId: 'd1', terminal: 'terminal-exact' }, { dispatchId: 'd2', terminal: 'terminal-exact' }] }))
  assert.equal(ambiguous.result.agents[0].taskId, undefined)
  const failedHistory = await snapshot([workspace], { agents: [agent()] }, [p], async () => { throw Error('unavailable') })
  assert.equal(failedHistory.result.ok, true); assert.equal(failedHistory.result.agents[0].taskId, undefined)
  p.hidden = true
  assert.equal((await snapshot([workspace], { agents: [agent()] }, [p])).host.callsOf('agents.list').length, 0)
})

test('host failures produce one bounded unreadable result and never leak host errors', async () => {
  const { result } = await snapshot([workspace], () => { throw Error('private host details') })
  assert.deepEqual(result.agents, []); assert.equal(result.ok, false); assert.equal(result.error, 'agent 状态读不到')
  assert.equal((await snapshot([workspace], { agents: [agent('unexpected')] })).result.ok, false)
})

test('status reuses its inspection sample while direct checks reread Orca', async () => {
  const runtime = new OrcaRuntime(async () => 'unused'), calls: string[] = []
  let incomplete = false
  let terminals: { handle: string; connected: boolean }[] = []
  const main = { handle: 'orca_session_id:test', workspace: 'id:test', agent: 'claude', path: '/test', title: '', workspaceName: '', online: 'unknown' as const }
  const stateStartedAt = Date.now()
  ;(runtime as any).call = async (args: string[]) => {
    assert.ok(!args.includes('--agent-wait'))
    calls.push(args[1])
    return args[1] === 'ps' ? { truncated: incomplete, worktrees: [{ address: { environment: 'local', worktree: main.workspace }, path: main.path,
      agents: [{ paneKey: 'structured-agent-session-test:pane', subagentObservation: 'live', state: 'working', stateStartedAt }] }] } : { terminals }
  }
  const host = mockHost({ results: { 'workspace.list': { workspaces: [], truncated: false } } })
  let api!: OrcaWorkerApi
  const worker = await mountWorker({ default: value => { api = value } }, { host })
  try {
    const sample = runtime.targets('sample')
    const initial = await runtime.agents([], api.host, main, sample)
    assert.deepEqual(initial.main?.status, { state: 'work', since: stateStartedAt })
    assert.deepEqual(calls, ['ps', 'list'])
    incomplete = true
    await runtime.targets('display')
    assert.deepEqual(calls, ['ps', 'list'])
    await assert.rejects(() => runtime.targets(), /会话列表不完整/)
    await assert.rejects(() => runtime.targets('sample'), /会话列表不完整/)
    assert.deepEqual((await runtime.agents([], api.host, main, sample)).main, initial.main)
    assert.deepEqual(calls, ['ps', 'list', 'ps', 'list', 'ps', 'list'])
    incomplete = false
    const terminal = { ...main, handle: 'disconnected-terminal' }
    terminals = [{ handle: terminal.handle, connected: false }]
    const direct = await runtime.agents([], api.host, terminal)
    assert.equal(direct.main?.status.state, 'offline')
    assert.deepEqual((await runtime.agents([], api.host, terminal, runtime.targets('sample'))).main, direct.main)
    terminals.push({ handle: terminal.handle, connected: true })
    const ambiguous = await runtime.agents([], api.host, terminal)
    assert.equal(ambiguous.main?.status.state, 'unknown')
    assert.deepEqual((await runtime.agents([], api.host, terminal, runtime.targets('sample'))).main, ambiguous.main)
  } finally { await worker.deactivate() }
})

test('workspace and agent caps and host truncation are explicitly reported', async () => {
  const workspaces = Array.from({ length: maxAgentWorkspaces + 1 }, (_, i) => ({ ...workspace, id: 'ws-' + i }))
  const capped = await snapshot(workspaces, { agents: [] })
  assert.equal(capped.host.callsOf('agents.list').length, maxAgentWorkspaces); assert.equal(capped.result.truncated, true)
  assert.equal((await snapshot([workspace], { agents: [] }, [], undefined, true)).result.truncated, true)
  const many = await snapshot(Array.from({ length: 41 }, (_, i) => ({ ...workspace, id: 'many-' + i })), { agents: Array.from({ length: 50 }, (_, i) => agent('working', 's' + i)) })
  assert.equal(many.result.agents.length, maxAgents, JSON.stringify(many.host.refusals)); assert.equal(many.result.truncated, true)
})

test('workspace write does not grant workspace read', async () => {
  const host = mockHost({ capabilities: ['workspace:write'] })
  let api!: OrcaWorkerApi
  const worker = await mountWorker({ default: value => { api = value } }, { host })
  try { await assert.rejects(() => api.host.call('workspace.list', {}), /capability/i) }
  finally { await worker.deactivate() }
})

for (const selector of ['identity:wt2:local:project', refs[0].workspace]) for (const runId of ['', 'run_project']) test(`project opens its own workspace (${selector}, ${runId || 'unbound'})`, async () => {
  const ref = { ...refs[0], workspace: selector }, p = fresh(ref); p.runId = runId
  const workspaceId = selector.replace(/^id:/, ''), own = { ...workspace, id: workspaceId, projectId: ref.repoId, path: ref.path }
  const host = mockHost({ storage: { 'project:p1': p as any }, results: {
    'workspace.list': { workspaces: [own, { ...own, id: 'other-workspace' }], truncated: false },
    'agents.list': { agents: [agent(), agent('done', 'second')] }, 'workspace.open': { opened: true }
  } })
  let c!: ReturnType<typeof testCoordinator>
  const worker = await mountWorker({ default: api => { c = testCoordinator(api, {
    projects: async () => [ref],
    targets: async () => { throw Error('workspace navigation must not read takeover targets') }
  }) } }, { host })
  try {
    assert.deepEqual((await worker.request('project.read', { projectId: ref.id })).workspaceTarget, { workspaceId })
    assert.deepEqual(await worker.request('project.openMain', { projectId: ref.id }), { opened: true, multipleConversations: true })
    assert.deepEqual(host.callsOf('workspace.open'), [{ workspaceId }]); assert.deepEqual(host.callsOf('agents.list')[0], { workspaceId })
    host.respond('agents.list', { agents: [] })
    assert.equal((await worker.request('project.openMain', { projectId: ref.id })).multipleConversations, false)
    host.respond('agents.list', () => { throw Error('agents unavailable') })
    assert.deepEqual(await worker.request('project.openMain', { projectId: ref.id }), { opened: true })
    host.respond('workspace.list', { workspaces: [{ ...own, id: 'other-workspace' }], truncated: false })
    await assert.rejects(() => worker.request('project.openMain', { projectId: ref.id }), /项目工作区已被移除或不可用/)
    assert.equal(host.callsOf('workspace.open').length, 3)
    assert.deepEqual(host.data().storage['project:p1'], p); assert.deepEqual(host.refusals, [])
  } finally { c.stop(); await worker.deactivate() }
})

for (const scenario of ['removed', 'wrong-project', 'remote', 'truncated', 'list-error', 'open-error']) test(`project workspace error: ${scenario}`, async () => {
  const ref = refs[0], p = fresh(ref), own = { ...workspace, id: ref.workspace.replace(/^id:/, ''), projectId: ref.repoId }
  const reason = scenario === 'truncated' ? '工作区列表未完整返回' : scenario === 'list-error' ? 'Orca: workspace inventory unavailable' : scenario === 'open-error' ? 'Orca: workspace open failed' : '项目工作区已被移除或不可用'
  const host = mockHost({ storage: { 'project:p1': p as any }, results: {
    'workspace.list': () => {
      if (scenario === 'list-error') throw Error(reason)
      return { truncated: scenario === 'truncated', workspaces: ['removed', 'truncated'].includes(scenario) ? [] : [{ ...own, ...(scenario === 'wrong-project' ? { projectId: 'other-project' } : {}), ...(scenario === 'remote' ? { hostId: 'ssh:remote' } : {}) }] }
    },
    'agents.list': { agents: [agent()] }, 'workspace.open': () => { throw Error(reason) }
  } })
  let c!: ReturnType<typeof testCoordinator>
  const worker = await mountWorker({ default: api => { c = testCoordinator(api, { projects: async () => refs }) } }, { host })
  try {
    const snapshot = await worker.request('project.read', { projectId: ref.id })
    if (scenario !== 'open-error') assert.ok(snapshot.workspaceTarget && 'error' in snapshot.workspaceTarget && snapshot.workspaceTarget.error.includes(reason))
    await assert.rejects(() => worker.request('project.openMain', { projectId: ref.id }), new RegExp(reason))
    assert.equal(host.callsOf('workspace.open').length, scenario === 'open-error' ? 1 : 0)
    assert.deepEqual(host.data().storage['project:p1'], p)
  } finally { c.stop(); await worker.deactivate() }
})

test('matching project writes fill missing display identity and preserve the recorded primary', async () => {
  const ref = refs[0], p = fresh(ref); p.runId = 'run_project'
  const own = { ...workspace, id: ref.workspace.replace(/^id:/, ''), projectId: ref.repoId }, lead = { ...own, id: 'lead-workspace' }
  const legacyAgent = 'custom_agent-fork'
  let caller = `orca_session_id:${legacyAgent}_12345678_1234_4321_8123_123456789abc`, c!: ReturnType<typeof testCoordinator>
  const host = mockHost({ storage: { 'project:p1': p as any }, results: { 'workspace.list': { workspaces: [own, lead], truncated: false }, 'agents.list': { agents: [agent()] }, 'workspace.open': { opened: true } } })
  const worker = await mountWorker({ default: api => { c = testCoordinator(api, {
    projects: async () => refs,
    targets: async () => ({ workspaces: [], sessions: [{ handle: caller, workspace: 'id:lead-workspace', workspaceName: 'Lead', path: '/lead', title: 'Main', agent: legacyAgent, online: 'unknown' }] }),
    verifyRun: async run => { if (run === 'run_forbidden') throw Error('existing Run check refused') }
  }) } }, { host })
  const submit = (handle: string, runId = 'run_project') => worker.request('project.agent', { operation: 'submit', projectId: ref.id, revision: (host.data().storage['project:p1'] as any).revision, requestId: crypto.randomUUID(), runId, caller: handle, task: { id: 't', title: 'Task', goal: 'Goal', phase: 'working' } })
  try {
    assert.equal((await worker.request('project.read', { projectId: ref.id })).mainAgent, undefined)
    const result = await submit(caller)
    assert.equal(result.project!.mainAgentHandle, caller); assert.equal(result.mainAgent, legacyAgent)
    assert.deepEqual(result.workspaceTarget, { workspaceId: own.id })
    assert.equal((await submit('orca_session_id:codex_project')).mainAgent, legacyAgent)
    await worker.request('project.openMain', { projectId: ref.id })
    assert.deepEqual(host.callsOf('workspace.open').at(-1), { workspaceId: lead.id })
    assert.equal((await submit('orca_session_id:claude_other', 'run_other')).project!.mainAgentHandle, caller)
    caller = 'orca_session_id:uuid-without-agent-prefix'
    assert.equal((await submit(caller)).mainAgent, legacyAgent)
    host.respond('workspace.list', { workspaces: [own], truncated: false })
    assert.deepEqual((await worker.request('project.read', { projectId: ref.id })).workspaceTarget, { workspaceId: own.id })
    await assert.rejects(() => worker.request('project.agent', { operation: 'bind', projectId: ref.id, revision: (host.data().storage['project:p1'] as any).revision, requestId: 'refused', runId: 'run_forbidden', caller }), /existing Run check refused/)
    await assert.rejects(() => worker.request('project.agent', { operation: 'bind', projectId: ref.id, revision: (host.data().storage['project:p1'] as any).revision, requestId: 'rebind', runId: 'run_next' }), /接管凭据/)
    const bound = await worker.request('project.agent', { operation: 'bind', projectId: ref.id, revision: (host.data().storage['project:p1'] as any).revision, requestId: 'same-run', runId: 'run_project', caller: 'orca_session_id:claude_bound' })
    assert.equal(bound.mainAgent, legacyAgent)
    const settings = await worker.request('project.settings', { projectId: ref.id, revision: bound.project!.revision, roles: bound.project!.roles, runId: 'run_project', caller: 'orca_session_id:codex_settings' })
    assert.equal(settings.mainAgent, legacyAgent)
    const before = structuredClone(host.data().storage['project:p1'])
    await assert.rejects(() => worker.request('project.agent', { operation: 'submit', projectId: ref.id, revision: (before as any).revision, requestId: 'invalid', runId: 'run_next', caller, task: {} }), /./)
    assert.deepEqual(host.data().storage['project:p1'], before)
  } finally { c.stop(); await worker.deactivate() }
})

test('host catalog matches exact local IDs even without workspaces, refusing a truncated project list', async () => {
  const host = mockHost({ results: {
    'project.list': { projects: [{ id: 'repo', name: '同名', kind: 'git', hostId: 'local', path: '/root' }, { id: 'remote', name: '同名', kind: 'git', hostId: 'ssh:remote', path: '/root' }], truncated: false },
    'workspace.list': { workspaces: [{ ...workspace, id: 'repo::/child', projectId: 'repo', path: '/child' }, { ...workspace, id: 'repo::/root', projectId: 'repo', path: '/root' }], truncated: false }
  } })
  let api!: OrcaWorkerApi
  const worker = await mountWorker({ default: value => { api = value } }, { host })
  const runtime = new OrcaRuntime(async () => { throw Error('CLI must not be used') })
  try {
    const projects = await runtime.projects(api.host)
    assert.deepEqual(projects, [{ id: projectKey('local', 'repo'), repoId: 'repo', hostId: 'local', name: '同名', path: '/root', workspace: 'id:repo::/root' }])
    host.respond('workspace.list', { workspaces: [{ ...workspace, id: 'identity:wt2:local:exact', projectId: 'repo', path: '/root' }], truncated: false })
    assert.equal((await runtime.projects(api.host))[0].workspace, 'identity:wt2:local:exact')
    host.respond('workspace.list', { workspaces: [], truncated: true })
    assert.deepEqual(await runtime.projects(api.host), [{ ...projects[0], workspace: '' }])
    host.respond('workspace.list', () => { throw Error('workspaces unavailable') })
    assert.deepEqual(await runtime.projects(api.host), [{ ...projects[0], workspace: '' }])
    host.respond('project.list', { projects: [], truncated: true })
    await assert.rejects(() => runtime.projects(api.host), /未完整/)
    assert.deepEqual(host.refusals, [])
  } finally { await worker.deactivate() }
})

test('status bursts sample once, publish visible changes only, and recover errors', async () => {
  const host = mockHost(); let c!: ReturnType<typeof testCoordinator>, state = 'waiting', taskId = 'first', reads = 0, unavailable = false
  const since = Date.now()
  const worker = await mountWorker({ default: api => { c = testCoordinator(api, { projects: async () => refs, agents: async () => {
    reads++
    if (unavailable) throw Error('host unavailable')
    return { ok: true, at: Date.now(), agents: [{ id: 'one', projectId: 'p1', agent: 'codex', role: 'worker', state: agentState(state as any), rawState: state, title: '测试', taskTitle: '测试', taskId, since }] }
  } }) } }, { host })
  const emit = () => worker.emit('agent.status.changed', { workspaceId: 'ws', paneKey: 'pane', state: state as any, receivedAt: Date.now() })
  try {
    const first = emit()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(reads, 0)
    await Promise.all([first, emit(), emit()])
    assert.equal(reads, 1)
    const posts = () => worker.posts.filter(p => p.event === 'project.changed').length
    assert.equal(posts(), 1)
    assert.equal((host.callsOf('statusBar.update').at(-1) as any).text, '工作间 · 待处理 1')
    const before = reads; await worker.request('workspace.agents'); assert.equal(reads, before)
    state = 'blocked'; await Promise.all([emit(), emit()])
    assert.equal(reads, 2); assert.equal(posts(), 1); assert.equal(host.callsOf('statusBar.update').length, 1)
    taskId = 'second'; await emit()
    assert.equal(posts(), 2)
    assert.equal((await worker.request('workspace.agents')).agents[0].taskId, 'second')
    state = 'working'; await emit(); assert.equal((host.callsOf('statusBar.update').at(-1) as any).text, '工作间 · 待处理 0')
    unavailable = true; await emit(); assert.ok((host.callsOf('statusBar.update').at(-1) as any).tooltip.includes('agent 状态读不到'))
    assert.equal((await worker.request('workspace.agents')).ok, false)
    unavailable = false; state = 'blocked'; await emit(); assert.equal((host.callsOf('statusBar.update').at(-1) as any).text, '工作间 · 待处理 1')
    const stopped = reads, pending = emit(); c.stop(); await pending; await emit(); assert.equal(reads, stopped)
    assert.deepEqual(worker.refusals, [])
  } finally { c.stop(); await worker.deactivate() }
})

test('an event arriving during a host read requests a fresh read before publishing', async () => {
  let release!: () => void, entered!: () => void, reads = 0, c!: ReturnType<typeof testCoordinator>
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const worker = await mountWorker({ default: api => { c = testCoordinator(api, { agents: async () => { reads++; if (reads === 1) { entered(); await gate } return { ok: true, at: Date.now(), agents: [] } } }) } })
  const event = { workspaceId: 'ws', paneKey: 'pane', state: 'working' as const, receivedAt: Date.now() }
  try {
    const first = worker.emit('agent.status.changed', event); await started
    const second = worker.emit('agent.status.changed', event); release(); await Promise.all([first, second])
    assert.equal(reads, 2)
  } finally { c.stop(); await worker.deactivate() }
})

test('a status event after the shared inventory starts supersedes that inventory', async () => {
  let release!: () => void, entered!: () => void, c!: ReturnType<typeof testCoordinator>
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const main = { handle: 'orca_session_id:main', workspace: 'id:' + workspace.id, path: workspace.path, workspaceName: workspace.name,
    title: '主会话', agent: 'codex', online: 'online' as const }
  const host = mockHost({ storage: { workspace: { version: 1, revision: 0, runId: 'run_main', requests: [], session: main } } })
  const since = Date.now(), samples: string[] = []
  let state: 'working' | 'waiting' = 'working'
  const worker = await mountWorker({ default: api => { c = testCoordinator(api, {
    targets: async () => {
      const session = { ...main, state }
      entered(); await gate
      return { sessions: [session], workspaces: [] }
    },
    agents: async (_projects, _host, _main, inventory) => {
      const observed = inventory ? (await inventory)?.sessions[0]?.state : state
      samples.push(observed ?? '')
      return { ok: true, at: Date.now(), agents: [], main: { handle: main.handle, status: { state: observed === 'waiting' ? 'need' : 'work', since } } }
    }
  }) } }, { host })
  try {
    await c.start(); await started
    state = 'waiting'
    const delivered = worker.emit('agent.status.changed', { workspaceId: workspace.id, paneKey: 'pane', state, receivedAt: Date.now() })
    release()
    await delivered
    assert.deepEqual(samples, ['working', 'waiting'])
    assert.equal((await worker.request('workspace.agents')).main?.status.state, 'need')
  } finally { release(); c.stop(); await worker.deactivate() }
})
