import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { readAgents, agentState, maxAgentWorkspaces, maxAgents } from './agents'
import { testCoordinator } from './test-runtime'
import { fresh, projectKey } from './store'
import { refs } from './fixtures'
import { OrcaRuntime } from './runtime'

const workspace = { id: 'ws-one', hostId: 'local', projectId: refs[0].repoId, path: '/example', kind: 'worktree', name: '示例', branch: 'main' }
const agent = (state = 'working', sessionId = 's1') => ({ terminalId: null, title: '会话', agent: 'codex', state, stateStartedAt: Date.now(), sessionId })
async function snapshot(workspaces: any[], agents: any, projects: any[] = [], read: (args: string[]) => Promise<any> = async () => ({}), truncated = false) {
  const host = mockHost({ results: { 'workspace.list': { workspaces, truncated }, 'agents.list': agents } })
  let api!: OrcaWorkerApi
  const worker = await mountWorker({ default: value => { api = value } }, { host })
  try { return { result: await readAgents(api.host, read, projects), host } }
  finally { await worker.deactivate() }
}

test('host status maps waiting/blocked to need, working to work and done to done', async () => {
  assert.deepEqual(['waiting', 'blocked', 'working', 'done'].map(s => agentState(s as any)), ['need', 'need', 'work', 'done'])
  const old = { ...agent('done', 'old'), stateStartedAt: Date.now() - 86400001 }
  const { result, host } = await snapshot([workspace, { ...workspace, id: 'remote', hostId: 'ssh:remote' }], { agents: [...['waiting', 'blocked', 'working', 'done'].map((s, i) => agent(s, 's' + i)), old] })
  assert.equal(result.ok, true); assert.deepEqual(result.agents.map(a => a.state), ['need', 'need', 'work', 'done'])
  assert.ok(result.agents.every(a => a.projectId === projectKey('local', refs[0].repoId)))
  assert.deepEqual(host.callsOf('agents.list'), [{ workspaceId: workspace.id }])
  assert.deepEqual(host.refusals, [])
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

test('host catalog matches exact local project IDs and canonical workspaces, refusing truncation', async () => {
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
    await assert.rejects(() => runtime.projects(api.host), /未完整/)
    assert.deepEqual(host.refusals, [])
  } finally { await worker.deactivate() }
})

test('status events refresh panel and status bar without any panel request, recover errors and dispose', async () => {
  const host = mockHost(); let c!: ReturnType<typeof testCoordinator>, state = 'waiting', reads = 0, unavailable = false
  const worker = await mountWorker({ default: api => { c = testCoordinator(api, { agents: async () => {
    reads++
    if (unavailable) throw Error('host unavailable')
    return { ok: true, at: Date.now(), agents: [{ id: 'one', projectId: 'p1', agent: 'codex', role: 'session', state: agentState(state as any), rawState: state, title: '测试', since: Date.now() }] }
  } }) } }, { host })
  const emit = () => worker.emit('agent.status.changed', { workspaceId: 'ws', paneKey: 'pane', state: state as any, receivedAt: Date.now() })
  try {
    await emit(); assert.equal((host.callsOf('statusBar.update').at(-1) as any).text, '工作间 · 待处理 1')
    assert.ok(worker.posts.some(p => p.event === 'project.changed'))
    const before = reads; await worker.request('workspace.agents'); assert.equal(reads, before)
    state = 'working'; await emit(); assert.equal((host.callsOf('statusBar.update').at(-1) as any).text, '工作间 · 待处理 0')
    unavailable = true; await emit(); assert.ok((host.callsOf('statusBar.update').at(-1) as any).tooltip.includes('agent 状态读不到'))
    assert.equal((await worker.request('workspace.agents')).ok, false)
    unavailable = false; state = 'blocked'; await emit(); assert.equal((host.callsOf('statusBar.update').at(-1) as any).text, '工作间 · 待处理 1')
    c.stop(); const stopped = reads; await emit(); assert.equal(reads, stopped)
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
