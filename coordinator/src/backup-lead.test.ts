import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { testCoordinator } from './test-runtime'
import { fresh } from './store'
import { refs } from './fixtures'
import type { AgentSession, LeadAction, Project, Workspace } from './model'
import { stopped } from './backup-lead'

const now = Date.now(), minute = 60_000
const primary: AgentSession = { handle: 'orca_session_id:claude_lead', workspace: refs[0].workspace, workspaceName: '项目', path: refs[0].path, title: '主用', online: 'online', agent: 'claude', state: 'done' }

test('在线主用存在超过十五分钟的待办且已知不在工作时才需要探测', () => {
  assert.ok(stopped(undefined, undefined, now))
  assert.ok(stopped({ ...primary, online: 'offline' }, undefined, now))
  assert.equal(stopped(primary, undefined, now), undefined)
  assert.equal(stopped(primary, now - 15 * minute, now), undefined)
  assert.ok(stopped(primary, now - 15 * minute - 1, now))
  for (const state of ['working', 'future']) assert.equal(stopped({ ...primary, state }, 1, now), undefined)
  assert.equal(stopped({ ...primary, online: 'unknown' }, 1, now), undefined)
})

async function fixture(project: Project, workspace?: Workspace) {
  const host = mockHost({ storage: { ['project:' + project.ref.id]: project as any, ...(workspace ? { workspace: workspace as any } : {}) } })
  const env = { sessions: [primary], available: true, failLaunch: false, owner: primary.handle, launches: [] as { agent: string; options: unknown; prompt: string }[],
    controls: [] as { handle: string; prompt: string }[], deliveries: [] as string[], reports: [] as any[] }
  let c!: ReturnType<typeof testCoordinator>
  const worker = await mountWorker({ default: api => {
    c = testCoordinator(api, {
      projects: async () => env.available ? [project.ref] : [],
      targets: async () => ({ sessions: env.sessions, workspaces: [{ workspace: primary.workspace, name: '项目', path: primary.path }] }),
      runOwner: async () => env.owner,
      identify: async (handle, run, own) => { assert.equal(run, own); return env.sessions.find(s => s.handle === handle)! },
      mail: async () => ({ reports: [], questions: [], waiting: env.reports }),
      launchMain: async (_, agent, prompt, options) => {
        env.launches.push({ agent, prompt, options })
        if (env.failLaunch) throw Error('模拟启动回执丢失')
        env.sessions.push({ ...primary, handle: 'orca_session_id:backup', title: '备用', agent })
        return 'orca_session_id:backup'
      },
      requestTakeover: async (handle, prompt) => { env.controls.push({ handle, prompt }) },
      send: async (run, d) => { env.deliveries.push([run, env.owner, d.subject].join('|')); return {} }
    })
  } }, { host })
  const poll = async () => { await c.checkBackups(); await c.flush(project.ref.id) }
  const command = (action: LeadAction, note?: string) => {
    const msg = [...env.controls].reverse().find(m => m.prompt.includes(' lead-' + action + ' '))!
    const token = msg.prompt.split(' lead-' + action + ' ')[1].split(' ')[1]
    return worker.request('lead.control', { action, runId: project.runId, caller: msg.handle, token, note })
  }
  return { c, worker, env, poll, command, close: async () => { c.stop(); await worker.deactivate() } }
}
const bound = () => ({ ...fresh(refs[0]), runId: 'run_project', mainAgentHandle: primary.handle, mainSession: primary })
test('在线主用探测满十分钟未确认才接管原 Run，随后可恢复交回', async () => {
  const p = bound(), { env, poll, command, c, close } = await fixture(p)
  const realNow = Date.now
  let clock = now
  Date.now = () => clock
  try {
    await Promise.all([poll(), poll()])
    assert.equal(env.launches.length, 1)
    assert.deepEqual(env.launches[0].options, { model: 'gpt-6.2-astra', effort: 'xhigh', surface: 'chat' })
    assert.equal(env.controls.length, 0)
    env.reports.push({ at: now - 16 * minute, title: '执行者已完成', report: { id: 'msg_1', body: '完成', at: now - 16 * minute, taskId: 't', dispatchId: 'd', runId: p.runId } })
    await c.refreshQuestions()
    await poll()
    assert.equal(env.controls.length, 1)
    assert.equal(env.controls[0].handle, primary.handle)
    assert.ok(env.controls[0].prompt.includes('lead-ready'))
    clock += 10 * minute - 1
    await poll()
    assert.equal(env.controls.length, 1)
    clock++
    await poll(); await poll()
    assert.equal(env.controls.length, 2)
    assert.ok(env.controls[1].prompt.includes('执行者已完成'))
    assert.deepEqual(await command('take'), { useRun: p.runId })
    env.owner = env.controls[1].handle
    // Orca changed its owner just before the plugin restarted; recover from run-show.
    const interrupted = await c.store.get(p.ref.id)
    const reboot = await fixture(interrupted)
    try {
      reboot.env.owner = env.owner; reboot.env.sessions = env.sessions
      await reboot.poll()
      assert.equal((await reboot.c.store.get(p.ref.id)).backup?.phase, 'active')
      assert.equal(reboot.env.launches.length, 0)
      assert.equal(reboot.env.controls.length, 0)
    } finally { await reboot.close() }
    await poll()
    assert.deepEqual(await command('take'), { done: true })
    await c.store.mutate(p.ref.id, undefined, p => { p.deliveries.push({ id: 'after', state: 'pending', subject: '新任务', body: '消息' }) })
    await c.flush(p.ref.id)
    assert.ok(env.deliveries.includes(p.runId + '|' + env.owner + '|新任务'))
    assert.equal((await c.store.get(p.ref.id)).backup?.phase, 'active')
    await poll()
    assert.equal(env.controls.length, 2)
    await c.store.mutate(p.ref.id, undefined, p => { p.backup!.since -= 61 * minute })
    await poll(); await poll()
    assert.equal(env.controls.length, 3)
    assert.equal(env.controls[2].handle, primary.handle)
    await command('ready'); await c.flush(p.ref.id)
    await command('ready')
    await command('handoff', '已验收 A，剩 B'); await c.flush(p.ref.id)
    assert.ok(env.controls.at(-1)!.prompt.includes('剩 B'))
    assert.deepEqual(await command('resume'), { useRun: p.runId })
    env.owner = primary.handle
    await command('resume'); await command('resume')
    assert.equal((await c.store.get(p.ref.id)).backup?.phase, 'standby')
    assert.equal(env.controls.length, 5)
  } finally { Date.now = realNow; await close() }
})

test('未关联任务的旧消息只探测一次，主用确认后只对新积压再探测', async () => {
  const p = bound()
  const event = { id: 'old', source: 'owner', sourceId: 'old', threadId: '', chatId: '', senderId: 'owner', text: '项目状态如何？', receivedAt: new Date(now - 24 * 60 * minute).toISOString() }
  p.events.push(event)
  // An old notification with unknown delivery can remain in the queue indefinitely.
  p.deliveries.push({ id: 'old-notice', subject: '进展', body: '', state: 'uncertain', createdAt: now - 60 * minute })
  const { c, env, poll, command, close } = await fixture(p)
  const realNow = Date.now
  let clock = now
  Date.now = () => clock
  try {
    await poll(); await poll(); await poll()
    assert.deepEqual(env.controls.map(m => m.handle), [primary.handle])
    clock += 9 * minute
    await command('ready'); await command('ready')
    const saved = await c.store.get(p.ref.id)
    assert.equal(saved.backup?.phase, 'standby')
    assert.equal(saved.backup?.confirmedAt, clock)
    assert.equal(saved.events[0].taskId, undefined)
    clock += 24 * 60 * minute
    const reboot = await fixture(saved)
    try {
      reboot.env.sessions = env.sessions
      await reboot.poll(); await reboot.poll()
      assert.equal(reboot.env.controls.length, 0)
      await reboot.c.store.mutate(p.ref.id, undefined, r => { r.events.push({ ...event, id: 'new', sourceId: 'new', receivedAt: new Date(clock).toISOString() }) })
      clock += 16 * minute
      await reboot.poll()
      assert.deepEqual(reboot.env.controls.map(m => m.handle), [primary.handle])
      assert.equal((await reboot.c.store.get(p.ref.id)).backup?.phase, 'probing')
    } finally { await reboot.close() }
  } finally { Date.now = realNow; await close() }
})

test('完整清单中找不到主用时直接通知备用接管', async () => {
  const p = bound(), { env, poll, close } = await fixture(p)
  try {
    await poll()
    env.sessions = env.sessions.filter(s => s.handle !== primary.handle)
    await poll()
    assert.deepEqual(env.controls.map(m => m.handle), ['orca_session_id:backup'])
    assert.ok(env.controls[0].prompt.includes('lead-take'))
  } finally { await close() }
})

test('无绑定、隐藏和移除的项目跳过；启动失败记录一次；两者离线不误报接管', async () => {
  const p = bound(), { c, env, poll, close } = await fixture({ ...p, runId: '' })
  try {
    await poll()
    await c.store.mutate(p.ref.id, undefined, row => { row.runId = p.runId; row.hidden = true })
    await poll()
    await c.store.mutate(p.ref.id, undefined, row => { row.hidden = false })
    env.available = false; await poll()
    assert.equal(env.launches.length, 0)
    env.available = true; env.failLaunch = true; await poll(); await poll()
    assert.equal(env.launches.length, 1)
    assert.ok((await c.store.get(p.ref.id)).backup?.history[0].text.includes('启动回执'))
    await c.store.mutate(p.ref.id, undefined, row => { row.backup!.phase = 'standby'; row.backup!.handle = 'missing' })
    env.sessions = []; await poll(); await poll()
    const b = (await c.store.get(p.ref.id)).backup!
    assert.equal(b.phase, 'standby')
    assert.ok(b.problem?.includes('均停住'))
    assert.equal(env.controls.length, 0)
  } finally { await close() }
})

test('工作间绑定后成对创建，Codex 主用配 Claude，重启前的启动请求不重开', async () => {
  const p = fresh(refs[0]), { c, env, worker, close } = await fixture(p)
  try {
    env.sessions[0] = { ...primary, agent: 'codex' }
    await worker.request('workspace.agent', { operation: 'bind', revision: 0, requestId: 'first', caller: primary.handle, runId: 'run_workspace', currentRunId: 'run_workspace' })
    await c.checkBackups()
    assert.equal(env.launches.length, 1)
    assert.equal(env.launches[0].agent, 'claude')
    const binding = await worker.request('workspace.agent', { operation: 'read' })
    assert.equal(binding.backup?.handle, 'orca_session_id:backup')
    await c.store.mutateWorkspace(w => { w.backup!.phase = 'opening'; delete w.backup!.handle })
    await c.checkBackups()
    assert.equal((await c.store.workspace()).backup?.phase, 'failed')
    assert.equal(env.launches.length, 1)
  } finally { await close() }
})
