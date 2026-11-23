import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { refs, sample } from './fixtures'
import { testCoordinator as createCoordinator } from './test-runtime'
import type { AgentSession } from './model'

test('role registry mirrors active bindings, replaces old roles and drops deleted projects', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentboat-roles-')), file = path.join(dir, 'roles.json')
  const project = sample().project!
  project.mainAgentHandle = 'orca_session_id:claude_previous'
  let available = [...refs]
  let main: AgentSession = { handle: 'orca_session_id:claude_main', workspace: 'main', workspaceName: '主会话', path: dir, online: 'online', agent: 'claude', title: '主会话' }
  const host = mockHost({ storage: { 'project:p1': project as any } })
  let c!: ReturnType<typeof createCoordinator>
  const worker = await mountWorker({ default: api => { c = createCoordinator(api, {
    projects: async () => available, identify: async () => main,
    removeProject: async ref => { available = available.filter(p => p.id !== ref.id) }
  }, undefined, path.join(dir, 'exports'), undefined, file) } }, { host })
  const read = () => JSON.parse(readFileSync(file, 'utf8')).sessions
  const errors: unknown[] = []
  let samples = 0
  let watcher: ReturnType<typeof setInterval> | undefined
  try {
    await c.start()
    assert.match(read()['orca_session_id:claude_previous'].summary, /待决定 1 项，待验收 1 项/)
    watcher = setInterval(() => { try { read(); samples++ } catch (e) { errors.push(e) } }, 1)
    await worker.request('workspace.agent', { operation: 'bind', revision: 0, runId: 'run_workroom', currentRunId: 'run_workroom', caller: main.handle, requestId: 'workspace-bind' })
    assert.equal(read()[main.handle].role, 'workspace-main')
    assert.equal(read()[main.handle].directory, dir)
    assert.match(read()[main.handle].summary, /工作间待处理/)
    await c.store.mutateMessaging(m => { m.inbox.push({ appId: 'demo', state: 'pending',
      event: { id: 'demo', source: 'feishu', sourceId: 'demo', senderId: 'demo', threadId: 'demo', chatId: 'demo', receivedAt: '', text: 'secret text never projected' } }) })
    assert.match(read()[main.handle].summary, /待交付 1 条/)
    assert.ok(!readFileSync(file, 'utf8').includes('secret text'))
    await c.checkBackups(); await c.flush('p1')
    await worker.request('project.agent', { operation: 'bind', projectId: 'p1', revision: (await c.store.get('p1')).revision, runId: 'run_next', caller: 'orca_session_id:claude_next', requestId: 'project-bind' })
    assert.equal(read()['orca_session_id:claude_previous'], undefined)
    assert.equal(read()['orca_session_id:claude_next'].projectId, 'p1')
    await c.checkBackups(); await c.flush('p1')
    await worker.request('project.agent', { operation: 'bind', projectId: 'p1', revision: (await c.store.get('p1')).revision, runId: 'run_codex', caller: 'orca_session_id:codex_next', requestId: 'codex-bind' })
    assert.equal(read()['orca_session_id:claude_next'], undefined)
    assert.equal(read()['orca_session_id:codex_next'].runId, 'run_codex')
    await c.store.mutate('p1', undefined, p => { p.backup = { primary: p.mainAgentHandle!, handle: 'orca_session_id:claude_spare', agent: 'claude', phase: 'active', since: 1, cycle: 'test', history: [] } })
    assert.equal(read()['orca_session_id:codex_next'].standby, true)
    assert.equal(read()['orca_session_id:claude_spare'].standby, undefined)
    const old = main.handle
    main = { ...main, handle: 'orca_session_id:claude_replacement' }
    await c.store.mutateWorkspace(w => { w.session = main; w.runId = 'run_replacement' })
    assert.equal(read()[old], undefined)
    assert.equal(read()[main.handle].role, 'workspace-main')
    main = { ...main, handle: 'orca_session_id:10000000-0000-4000-9000-000000000001' }
    await c.store.mutateWorkspace(w => { w.session = main })
    assert.equal(read()[main.handle], undefined)
    const spare = 'orca_session_id:codex_old_standby'
    await c.store.mutateWorkspace(w => { w.backup = { primary: main.handle, handle: spare, agent: 'codex', phase: 'standby', cycle: 'old', since: 1, history: [] } })
    assert.equal(read()[spare], undefined)
    await c.store.mutateWorkspace(w => { w.backup!.phase = 'taking'; w.backup!.credential = 'issued' })
    assert.equal(read()[spare].standby, true)
    await c.store.mutateWorkspace(w => { w.bot = { id: 'bot-1', name: '测试', agent: 'claude', paused: false } })
    assert.equal(read()[main.handle].bot, true)
    assert.equal(read()[spare], undefined)
    await c.store.mutateWorkspace(w => { w.runId = ''; delete w.session; delete w.backup; delete w.bot })
    assert.equal(read()[main.handle], undefined)
    await c.checkBackups(); await c.flush('p1')
    const ref = await c.store.get('p1')
    await worker.request('project.delete', { projectId: 'p1', revision: ref.revision, confirm: 'p1' })
    assert.deepEqual(read(), {})
    assert.deepEqual(readdirSync(dir).sort(), ['exports', 'roles.json'])
    assert.ok(samples > 0)
    assert.deepEqual(errors, [])
  } finally { clearInterval(watcher); c.stop(); await worker.deactivate(); rmSync(dir, { recursive: true, force: true }) }
})
