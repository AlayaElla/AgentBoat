import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { testCoordinator } from './test-runtime'
import { fingerprint, fresh } from './store'
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

async function fixture(project: Project, workspace?: Workspace, exports?: string, main = primary) {
  const host = mockHost({ storage: { ['project:' + project.ref.id]: project as any, ...(workspace ? { workspace: workspace as any } : {}) } })
  const env = { sessions: [main], inventoryFailed: false, available: true, failLaunch: false, owner: main.handle as string | null, generation: 1, installed: ['claude', 'codex'], spaces: [{ workspace: main.workspace, name: '项目', path: main.path }], launches: [] as { workspace: string; agent: string; options: unknown; prompt: string }[],
    catalogReads: 0, contacts: [] as string[], mailRuns: [] as string[], controls: [] as { handle: string; prompt: string }[], deliveries: [] as string[], reports: [] as any[] }
  let c!: ReturnType<typeof testCoordinator>
  const worker = await mountWorker({ default: api => {
    c = testCoordinator(api, {
      projects: async () => { env.catalogReads++; return env.available ? [project.ref] : [] },
      targets: async () => {
        if (env.inventoryFailed) throw Error('inventory timed out')
        return { sessions: env.sessions, workspaces: env.spaces }
      },
      runBinding: async id => ({ owner: env.owner, generation: id === 'run_park' ? 1 : env.generation, objective: id === 'run_park' ? 'AgentBoat 备用待命 ' + (await c.store.get(project.ref.id)).backup?.cycle : undefined }),
      syncContacts: async jobs => { env.contacts = jobs.map(j => j.id); return Object.fromEntries(jobs.map(j => [j.id, { dispatch: 'ctx_contact' }])) },
      installedAgents: async () => env.installed.map(id => ({ id, name: id, default: id === 'codex' })),
      identify: async (handle, run, own) => { assert.equal(run, own); return env.sessions.find(s => s.handle === handle)! },
      mail: async runId => { env.mailRuns.push(runId); return { reports: [], questions: [], waiting: env.reports } },
      launchMain: async (workspace, agent, prompt, options) => {
        env.launches.push({ workspace, agent, prompt, options })
        if (env.failLaunch) throw Error('模拟启动回执丢失')
        env.sessions.push({ ...main, handle: 'orca_session_id:backup', title: '备用', agent })
        return 'orca_session_id:backup'
      },
      requestTakeover: async (handle, prompt) => { env.controls.push({ handle, prompt }) },
      send: async (run, d) => { env.deliveries.push([run, env.owner, d.subject].join('|')); return {} }
    }, undefined, exports)
  } }, { host })
  const poll = async () => { await c.checkBackups(); await c.flush(project.ref.id) }
  const command = (action: LeadAction, note?: string, receipt: { confirm?: boolean; currentRunId?: string; generation?: number; standbyRunId?: string } = {}) => {
    const msg = [...env.controls].reverse().find(m => m.prompt.includes(' lead-' + action + ' '))!
    const token = msg.prompt.split(' lead-' + action + ' ')[1].split(' ')[1]
    return worker.request('lead.control', { action, runId: project.runId, caller: msg.handle === 'dispatch:ctx_contact' ? main.handle : msg.handle, token, note, ...receipt })
  }
  return { c, worker, env, poll, command, close: async () => { c.stop(); await worker.deactivate() } }
}
const bound = () => ({ ...fresh(refs[0]), leadAgents: { primary: { agent: 'claude' }, backup: { agent: 'codex' } },
  runId: 'run_project', mainAgentHandle: primary.handle, mainSession: primary })
test('主用绑定在其他项目工作区时，只在该工作区可用后原地补开备用', async () => {
  const p = { ...bound(), ref: refs[1] }, { env, poll, c, close } = await fixture(p)
  try {
    env.spaces = [p.ref]
    await poll()
    const missing = (await c.store.get(p.ref.id)).backup
    assert.equal(missing?.phase, 'unavailable')
    assert.equal(missing?.problem, '找不到已绑定主会话的工作区')
    assert.equal(env.launches.length, 0)
    env.spaces.push(refs[0])
    await poll()
    assert.deepEqual(env.launches.map(l => l.workspace), [primary.workspace])
    assert.equal((await c.store.get(p.ref.id)).backup?.phase, 'standby')
  } finally { await close() }
})

for (const agent of ['codex', 'antigravity']) test('项目主用探测超时后接管和交回原 Run：' + agent, async () => {
  const main = { ...primary, agent, handle: `orca_session_id:${agent}_lead` }
  const p: Project = { ...fresh(refs[0]), runId: 'run_project', mainAgentHandle: main.handle, mainSession: main }
  if (agent === 'codex') p.leadAgents = { primary: { agent }, backup: { agent: 'antigravity' } }
  const { env, poll, command, c, close } = await fixture(p, undefined, undefined, main)
  env.installed.push('antigravity')
  const realNow = Date.now
  let clock = now
  Date.now = () => clock
  try {
    await Promise.all([poll(), poll()])
    assert.equal(env.launches.length, 1)
    assert.equal(env.launches[0].agent, agent === 'codex' ? 'antigravity' : 'codex')
    assert.deepEqual(env.launches[0].options, {})
    assert.equal(env.controls.length, 0)
    env.reports.push({ at: now - 16 * minute, title: '执行者已完成', report: { id: 'msg_1', body: '完成', at: now - 16 * minute, taskId: 't', dispatchId: 'd', runId: p.runId } })
    await c.refreshQuestions()
    await poll()
    assert.equal(env.controls.length, 1)
    assert.equal(env.controls[0].handle, main.handle)
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
    env.generation = NaN
    await assert.rejects(() => command('take'), /代次/)
    await poll(); assert.equal((await c.store.get(p.ref.id)).backup?.phase, 'taking')
    env.generation = 2
    // Orca changed its owner just before the plugin restarted; recover from run-show.
    const interrupted = await c.store.get(p.ref.id)
    const reboot = await fixture(interrupted, undefined, undefined, main)
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
    assert.equal(env.controls[2].handle, 'dispatch:ctx_contact')
    await command('ready'); await c.flush(p.ref.id)
    await command('ready')
    await command('handoff', '已验收 A，剩 B'); await c.flush(p.ref.id)
    assert.ok(env.controls.at(-1)!.prompt.includes('剩 B'))
    assert.deepEqual(await command('resume'), { useRun: p.runId })
    env.owner = main.handle
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

test('聊天 Run 的空 handle 使用已有绑定，接管和交回都核对本会话回执与最新代次', async () => {
  const p = bound(), { c, env, poll, command, close } = await fixture(p)
  try {
    env.owner = null
    await poll()
    assert.deepEqual(env.contacts, [])
    assert.equal(env.launches.length, 1)
    env.sessions = env.sessions.filter(s => s.handle !== primary.handle)
    await poll()
    assert.deepEqual(await command('take'), { useRun: p.runId })
    const confirm = (action: LeadAction, generation: number, currentRunId = p.runId) =>
      command(action, undefined, { confirm: true, generation, currentRunId })
    await assert.rejects(() => confirm('take', 1), /回执/)
    env.generation = 2
    await poll()
    assert.equal((await c.store.get(p.ref.id)).backup?.phase, 'taking')
    assert.deepEqual(env.contacts, [])
    assert.deepEqual(await command('take'), { checkRun: p.runId })
    await assert.rejects(() => confirm('take', 1), /回执/)
    await assert.rejects(() => confirm('take', 2, 'run_other'), /回执/)
    await confirm('take', 2)
    env.sessions.push(primary)
    await c.store.mutate(p.ref.id, undefined, row => { row.backup!.since -= 61 * minute })
    await poll()
    await command('ready'); await c.flush(p.ref.id)
    await command('handoff', '剩余工作已登记', { standbyRunId: 'run_park' }); await c.flush(p.ref.id)
    assert.deepEqual(await command('resume'), { useRun: p.runId })
    env.generation++
    await confirm('resume', 3)
    await poll(); assert.deepEqual(env.contacts, [])
    env.sessions = env.sessions.filter(s => s.handle !== primary.handle)
    await poll(); assert.equal(env.controls.at(-1)?.handle, 'run:run_park')
    assert.equal((await c.store.get(p.ref.id)).backup?.phase, 'taking')
  } finally { await close() }
})

test('联络只在接管成功后建立，重启延用原编号，取消、切换、隐藏和删除时撤销', async () => {
  const p = bound()
  const b = { primary: primary.handle, agent: 'codex', handle: 'orca_session_id:backup', phase: 'active' as const,
    since: now, cycle: 'take-cycle', history: [], contact: { id: 'f15efee8-33d0-4655-b50f-2c427d2c5c10', workspace: primary.workspace, primary: primary.handle } }
  const exports = mkdtempSync(path.join(os.tmpdir(), 'agentboat-contact-'))
  const { c, env, poll, close } = await fixture({ ...p, backup: b }, undefined, exports)
  try {
    await poll(); await poll()
    assert.deepEqual(env.contacts, [b.contact.id])
    env.available = false; await poll(); assert.deepEqual(env.contacts, [])
    env.available = true; await poll()
    const saved = await c.store.get(p.ref.id)
    const reboot = await fixture(saved)
    try { await reboot.poll(); assert.deepEqual(reboot.env.contacts, [b.contact.id]) } finally { await reboot.close() }
    for (const phase of ['taking', 'failed', 'standby'] as const) {
      await c.store.mutate(p.ref.id, undefined, r => { r.backup!.phase = phase })
      await poll(); assert.deepEqual(env.contacts, [])
    }
    await c.store.mutate(p.ref.id, undefined, r => { r.hidden = true; r.backup!.phase = 'active' })
    await poll(); assert.deepEqual(env.contacts, [])
    await c.store.mutate(p.ref.id, undefined, r => { r.hidden = false; r.runId = 'run_replaced'; delete r.backup })
    await poll(); assert.deepEqual(env.contacts, [])
    await c.store.remove(p.ref.id, (await c.store.get(p.ref.id)).revision, async () => { env.available = false })
    await c.checkBackups(); assert.deepEqual(env.contacts, [])
    assert.ok(env.mailRuns.every(id => [p.runId, 'run_replaced'].includes(id)))
  } finally { await close(); rmSync(exports, { recursive: true, force: true }) }
})

test('联络路由恢复前交回通知保留在队列，恢复后只发送一次', async () => {
  const p = bound()
  const backup = { primary: primary.handle, agent: 'codex', handle: 'orca_session_id:backup', phase: 'returning' as const,
    since: now, cycle: 'cycle', history: [], contact: { id: 'contact', workspace: primary.workspace, primary: primary.handle } }
  const { c, env, poll, close } = await fixture({ ...p, backup, deliveries: [{ id: 'resume', subject: '', body: '', state: 'pending',
    targetRunId: p.runId, control: { action: 'resume', cycle: backup.cycle, handle: primary.handle } }] })
  try {
    env.owner = backup.handle
    await c.flush(p.ref.id)
    assert.equal((await c.store.get(p.ref.id)).deliveries[0].state, 'pending')
    await poll(); await poll()
    assert.deepEqual(env.controls.map(m => m.handle), ['dispatch:ctx_contact'])
  } finally { await close() }
})

test('没有备用的原因按角色通知一次，原因修复后自动清除', async () => {
  const p = bound(), w = { version: 1, revision: 1, requests: [], runId: 'run_workspace', session: { ...primary, workspace: 'id:workspace', path: '/workspace', handle: 'orca_session_id:workspace' } } as Workspace
  const { c, env, poll, close } = await fixture(p, w)
  try {
    env.owner = 'term_other'
    await poll(); await poll()
    let row = await c.store.get(p.ref.id)
    assert.ok(row.backup?.problem?.includes('归属'))
    assert.equal(row.deliveries.filter(d => d.subject.includes('主会话') && d.targetRunId === w.runId).length, 1)
    env.spaces = []; await poll(); await poll()
    row = await c.store.get(p.ref.id)
    assert.ok(row.backup?.problem?.includes('工作区'))
    assert.equal(row.deliveries.filter(d => d.targetRunId === w.runId).length, 2)
    env.spaces = [{ workspace: primary.workspace, name: '项目', path: primary.path }]
    await poll()
    assert.equal((await c.store.get(p.ref.id)).deliveries.filter(d => d.targetRunId === w.runId).length, 2)
    env.owner = primary.handle; await poll()
    row = await c.store.get(p.ref.id)
    assert.equal(row.backup?.phase, 'standby')
    assert.equal(row.backup?.problem, undefined)
  } finally { await close() }
})

for (const agent of ['claude', 'codex', 'antigravity']) test('项目备用缺失或重复时等待配置恢复，主用 ' + agent, async () => {
  const p: Project = bound()
  delete p.leadAgents
  const { c, env, poll, close } = await fixture(p)
  try {
    env.installed = [agent]
    env.sessions = [{ ...primary, agent }]
    await poll(); await poll()
    const row = await c.store.get(p.ref.id)
    assert.equal(row.backup?.phase, 'unavailable')
    assert.match(row.backup?.problem ?? '', agent === 'codex' ? /与当前主用相同/ : /未启用备用代理 codex/)
    assert.deepEqual(row.backup?.history, [])
    assert.equal(row.deliveries.length, 0)
    assert.equal(env.launches.length, 0)
    const other = agent === 'codex' ? 'antigravity' : 'codex'
    if (agent === 'codex') await c.store.mutate(p.ref.id, undefined, p => { p.leadAgents = { primary: { agent }, backup: { agent: other } } })
    env.installed.push(other)
    await poll(); await poll()
    assert.deepEqual(env.launches.map(l => l.agent), [other])
    assert.equal((await c.store.get(p.ref.id)).backup?.phase, 'standby')
  } finally { await close() }
})

test('失败后仅在主人确认当前版本时重新开一次', async () => {
  const p = bound(), { c, env, worker, poll, close } = await fixture(p)
  try {
    env.failLaunch = true; await poll(); await poll()
    const row = await c.store.get(p.ref.id)
    const retry = (confirm: boolean, revision = row.revision) => worker.request('lead.retry', { projectId: p.ref.id, revision, confirm })
    await assert.rejects(() => retry(false), /确认/)
    assert.equal(env.launches.length, 1)
    env.failLaunch = false
    await retry(true)
    await assert.rejects(() => retry(true))
    await poll()
    assert.equal(env.launches.length, 2)
    assert.equal((await c.store.get(p.ref.id)).backup?.phase, 'standby')
  } finally { await close() }
})

test('空闲项目每轮只读取一次项目目录', async () => {
  const p = bound(), { c, env, close } = await fixture({ ...p, backup: { primary: primary.handle, agent: 'codex',
    handle: 'spare', phase: 'standby', cycle: 'c', since: now, history: [] } })
  try {
    await c.checkBackups()
    assert.equal(env.catalogReads, 1)
  } finally { await close() }
})

test('清单超时保持待命，完整清单确认主用消失后才接管', async () => {
  const p = bound(), { c, env, poll, close } = await fixture(p)
  try {
    await poll()
    env.sessions = env.sessions.filter(s => s.handle !== primary.handle)
    env.inventoryFailed = true
    await poll()
    assert.equal(env.controls.length, 0)
    assert.equal((await c.store.get(p.ref.id)).backup?.phase, 'standby')
    env.inventoryFailed = false
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
    env.sessions = [primary]; await poll()
    assert.ok(!Object.hasOwn((await c.store.get(p.ref.id)).backup!, 'problem'))
  } finally { await close() }
})

test('普通工作间不打开备用，旧探测保留且停止发出', async () => {
  const p = fresh(refs[0]), { c, env, worker, close } = await fixture(p)
  try {
    env.sessions[0] = { ...primary, agent: 'codex' }
    await worker.request('workspace.agent', { operation: 'bind', revision: 0, requestId: 'first', caller: primary.handle, runId: 'run_workspace', currentRunId: 'run_workspace' })
    await c.checkBackups()
    assert.equal((await c.store.workspace()).backup, undefined)
    await c.store.mutateWorkspace(w => {
      w.backup = { primary: primary.handle, handle: 'orca_session_id:spare', phase: 'probing', agent: 'claude', cycle: 'old', since: now, history: [] }
      w.retired = [{ id: 'old-probe', targetRunId: w.runId, subject: '旧探测', body: '未发出', state: 'pending', control: { action: 'ready', cycle: 'old', handle: primary.handle } }]
    })
    await c.checkBackups()
    const binding = await worker.request('workspace.agent', { operation: 'read' })
    assert.equal(binding.backup, undefined)
    assert.equal((await c.store.workspace()).retired?.[0].state, 'pending')
    assert.deepEqual(env.controls, [])
    assert.deepEqual(env.launches, [])
    await assert.rejects(() => worker.request('lead.retry', { revision: binding.revision, confirm: true }), /工作间/)
  } finally { await close() }
})

test('升级时已发出的工作间接管保留原 Run 和消息，交回后不再启动备用', async () => {
  const p = fresh(refs[0]), spare = { ...primary, handle: 'orca_session_id:codex_spare', agent: 'codex' }
  const { c, env, worker, close } = await fixture(p, {
    version: 1, revision: 0, requests: [], runId: 'run_workspace', session: primary,
    backup: { primary: primary.handle, handle: spare.handle, phase: 'taking', agent: spare.agent, cycle: 'legacy', since: now, history: [], generation: 1, credential: fingerprint('take') },
    retired: [{ id: 'matter', targetRunId: 'run_workspace', state: 'uncertain', subject: '原业务消息', body: '消息正文' }]
  })
  try {
    env.sessions.push(spare)
    const input = { action: 'take' as const, runId: 'run_workspace', caller: spare.handle, token: 'take' }
    const read = () => worker.request('workspace.agent', { operation: 'read' })
    assert.equal((await read()).backup?.phase, 'taking')
    await assert.rejects(async () => worker.request('workspace.agent.switch', { mode: 'existing', revision: (await read()).revision, handle: spare.handle }), /接管结束/)
    assert.deepEqual(await worker.request('lead.control', input), { useRun: input.runId })
    env.owner = spare.handle; env.generation++
    assert.deepEqual(await worker.request('lead.control', input), { done: true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal((await read()).backup?.phase, 'active')
    await c.store.mutateWorkspace(w => { w.backup!.phase = 'returning'; w.backup!.credential = fingerprint('resume') })
    env.owner = primary.handle; env.generation++
    assert.deepEqual(await worker.request('lead.control', { ...input, action: 'resume', caller: primary.handle, token: 'resume' }), { done: true })
    await c.checkBackups()
    const w = await c.store.workspace()
    assert.equal(w.runId, input.runId)
    assert.equal(w.retired?.find(m => m.id === 'matter')?.body, '消息正文')
    assert.equal((await read()).backup, undefined)
    assert.deepEqual(env.launches, [])
  } finally { await close() }
})
