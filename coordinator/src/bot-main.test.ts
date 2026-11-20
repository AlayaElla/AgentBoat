import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { LocalBots, quotaReceipt } from './bot-runtime'
import { BackupLeads } from './backup-lead'
import { mainAgent } from './main-agent'
import { ProjectStore } from './store'
import { OrcaRuntime, type CoordinatorRuntime } from './runtime'
import type { AgentSession, BotTarget } from './model'

const first = 'orca_session_id:10000000-0000-4000-9000-000000000001'
const second = 'orca_session_id:20000000-0000-4000-9000-000000000002'
const third = 'orca_session_id:30000000-0000-4000-9000-000000000003'
const initial: BotTarget = { id: 'bot-1', name: '统筹', agent: 'claude', paused: false }
const primary: AgentSession = { handle: first, workspace: 'bot-folder', workspaceName: '统筹', title: 'Home', path: '/bots/one', agent: 'claude', online: 'online', state: 'done' }
const standby = { ...primary, handle: 'orca_session_id:codex_spare', workspace: 'standby', path: '/standby', agent: 'codex' }

test('额度回执要求对应地址、警告码和 Orca 的额度文字，恢复时间使用本机时钟', () => {
  const now = new Date(2026, 10, 20, 8, 0).getTime(), reset = now + 3 * 3600000
  const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(reset)
  const warning = { code: 'recipient_delivery_held', recipient: first, message: `Queued. ${first} stopped at its usage limit; Orca continues it at ${clock}, then delivers this.` }
  const read = (w: object) => quotaReceipt({ warnings: [w] }, first, now)
  assert.deepEqual(read(warning), { home: first, recoveryAt: reset })
  assert.deepEqual(read({ ...warning, message: warning.message.replace(clock, 'unknown clock') }), { home: first })
  assert.equal(read({ ...warning, recipient: second }), undefined)
  assert.equal(read({ ...warning, code: 'other' }), undefined)
  assert.equal(read({ ...warning, message: 'usage limit?' }), undefined)
})

test('插件 handoff 使用实际收件回执，缺失消息编号时保留未知状态', async () => {
  const runtime = new OrcaRuntime(async () => assert.fail('测试不能启动 Orca'))
  const warning = { code: 'recipient_delivery_held', recipient: first, message: 'Queued. ' + first + ' stopped at its usage limit and Orca has no reset time to promise; delivery waits until the chat continues.' }
  let message: { id: string; to_handle: string } | undefined = { id: 'receipt', to_handle: first }
  ;(runtime as any).call = async (args: string[]) => {
    assert.ok(args.includes('handoff')); assert.ok(args.includes('bot:bot-1'))
    return { message, warnings: [warning] }
  }
  assert.deepEqual(await runtime.botMail('bot:bot-1','接管','模拟','handoff'), { recipient: first, quota: { home: first } })
  message = undefined
  await assert.rejects(() => runtime.botMail('bot:bot-1','接管','模拟','handoff'), /回执/)
})

test('本机 bot 名单与远端隔离；每次更新先读完整记录，仅写 agent 和原 launch', async () => {
  let current = { ...initial }
  const calls: any[] = [], launch = { model: 'original', effort: 'high' }
  const cli = async (args: string[]) => {
    if (args[1] === 'list') return { bots: [current, { ...current, server: { name: 'Mac' }, id: 'another' }] }
    assert.equal(args.at(-1), initial.id)
    return { bot: '读取之间发生改名', chats: [{ id: 'side', home: false }, { id: first.slice(16), home: true }] }
  }
  const api = new LocalBots(cli, async (method, params: any) => {
    calls.push([method, params])
    if (method === 'bots.list') return { bots: [{ ...current, hostId: 'local', launch, permissionMode: 'keep' }] }
    current = { ...current, agent: params.updates.agent, name: '新名' }
    return { bot: current }
  }, true)
  const original = await api.original(initial)
  assert.deepEqual(await api.list(), [initial])
  assert.equal(await api.home(initial), first)
  const other = await api.update(initial, 'codex')
  await api.update(other, original.agent, original.launch)
  assert.deepEqual(calls.filter(([m]) => m === 'bots.update').map(([,p]) => p), [
    { botId: initial.id, updates: { agent: 'codex' } }, { botId: initial.id, updates: { agent: 'claude', launch } }])
  assert.deepEqual(calls.map(([m]) => m), ['bots.list','bots.list','bots.update','bots.list','bots.update'])
  await assert.rejects(() => new LocalBots(cli, async () => assert.fail('RPC'), false).list())
})

async function setup() {
  const env = { current: { ...initial } as BotTarget | undefined, home: first as string | undefined, owner: null as string | null,
    generation: 2, reject: false, next: second, warning: '', resets: [] as string[], sends: [] as { target: string; body: string; type: string }[], updates: [] as any[], sessions: [primary, standby], launches: [] as string[] }
  const inventory = () => ({ sessions: env.sessions, workspaces: [primary, standby].map(s => ({ workspace: s.workspace, path: s.path, name: s.title })) })
  const runtime = {
    bots: { find: async (id: string) => env.current?.id === id ? env.current : undefined, home: async () => env.home, list: async () => env.current ? [env.current] : [],
      newHome: async (id: string) => { env.resets.push(id) },
      original: async () => ({ agent: 'claude', launch: { model: 'saved' } }),
      update: async (_: BotTarget, agent: string, launch?: object) => {
        env.updates.push([agent, launch]); if (env.reject) throw Error('refused')
        return env.current = { ...initial, agent }
      } },
    botMail: async (target: string, subject: string, body: string, type: string) => {
      env.sends.push({ target, body, type })
      return { recipient: env.next, quota: quotaReceipt({ warnings: [{ code: 'recipient_delivery_held', recipient: first, message: env.warning }] }, first) }
    },
    requestTakeover: async (target: string, body: string) => { env.sends.push({ target, body, type: 'control' }) },
    runBinding: async () => ({ owner: env.owner, generation: env.generation }),
    identify: async (handle: string) => env.sessions.find(s => s.handle === handle),
    verifyRun: async () => {}, targets: async () => inventory(), installedAgents: async () => ['codex','claude'],
    launchMain: async (ws: string) => { env.launches.push(ws); return standby.handle },
    send: async () => ({})
  } as unknown as CoordinatorRuntime
  let store!: ProjectStore, backups!: BackupLeads, main!: ReturnType<typeof mainAgent>
  const worker = await mountWorker({ default: orca => {
    store = new ProjectStore(orca.storage)
    backups = new BackupLeads(store, runtime, async () => {}, () => {})
    main = mainAgent(orca, store, runtime, () => {}, () => {}, async () => [], backups, () => ({ ok: false, at: 0, agents: [] }))
  } }, { host: mockHost() })
  const poll = async () => {
    const w = await store.workspace()
    await backups.inspect(w, w.session!, inventory(), [], '', w.runId)
    await main.flushRetired()
  }
  const bind = async () => {
    env.next = first
    const choice = await worker.request('workspace.agent.switch', { mode: 'bot', revision: 0, botId: initial.id, workspace: standby.workspace })
    await worker.request('workspace.agent', { operation: 'bind', revision: choice.revision, requestId: 'bind', runId: 'run_bot',
      currentRunId: 'run_bot', caller: first, token: /一次性接管凭据：([^\n]+)/.exec(env.sends[0].body)![1] })
    await store.mutateMessaging(m => { m.feishu = { enabled: true, appId: 'fake', chatIds: ['owner'], senderIds: [] } })
    await poll()
    env.next = second
  }
  return { env, worker, store, backups, main, poll, bind }
}

test('面板绑定、独立备用、切换宽限、凭据接回原 Run、到点空闲切回和飞书队列', async () => {
  const { env, worker, store, backups, main, poll, bind } = await setup()
  try {
    await bind()
    assert.deepEqual(env.launches, [standby.workspace])
    assert.equal((await store.workspace()).bot?.id, initial.id)
    await main.deliver('run_bot', { id: 'q', body: '请处理', subject: '待决定', state: 'pending' })
    assert.equal(env.sends.at(-1)?.type, 'handoff')
    for (const id of ['a','b']) await main.deliver('run_bot', { id, body: id, subject: id, state: 'pending', informational: true })
    await main.flushRetired()
    assert.equal(env.sends.filter(s => s.type === 'status').length, 0)
    await store.mutateWorkspace(w => { for (const d of w.retired!) if (d.informational) d.createdAt = 1 })
    await main.flushRetired()
    assert.deepEqual(env.sends.filter(s => s.type === 'status').map(s => s.body), ['a\nb'])
    await backups.saveQuota('run_bot', { home: first, recoveryAt: Date.now() - 1 })
    await poll(); await poll()
    assert.equal((await store.workspace()).backup?.phase, 'standby')
    const confirm = async (handle: string, agent: string) => {
      const token = env.sends.at(-1)!.body.split(' ').at(-1)!
      const input = { action: 'take' as const, caller: handle, runId: 'run_bot', token }
      await assert.rejects(() => backups.command(input))
      env.home = handle
      env.sessions = [{ ...primary, agent, handle }, standby]
      assert.deepEqual(await backups.command(input), { useRun: 'run_bot' })
      env.generation++
      assert.deepEqual(await backups.command({ ...input, confirm: true, currentRunId: 'run_bot', generation: env.generation }), { done: true })
      await main.flushRetired()
    }
    env.home = undefined; await poll()
    assert.ok((await store.workspace()).botSwitch)
    await confirm(second, 'codex')
    env.sessions[0] = { ...env.sessions[0], state: 'working' }
    await poll(); assert.equal(env.updates.length, 1)
    env.sessions[0].state = 'done'; env.next = third
    await poll(); await confirm(third, 'claude')
    assert.deepEqual(env.updates, [['codex', undefined], ['claude', { model: 'saved' }]])
    assert.equal((await store.workspace()).originalBot, undefined)
    assert.equal((await store.messaging()).deliveries.filter(d => d.external?.chatId === 'owner').length, 2)
  } finally { await worker.deactivate() }
})

test('同名和改名按 ID 识别，额度恢复时间未知时等主人，面板可选回普通会话', async () => {
  const { env, worker, store, backups, main, poll, bind } = await setup()
  try {
    await bind()
    env.current!.name = '新名字'
    const read = () => worker.request('workspace.agent', { operation: 'read' })
    assert.equal((await read()).bot?.name, '新名字')
    assert.equal((await store.workspace()).bot?.name, undefined)
    env.warning = 'Queued. ' + first + ' stopped at its usage limit and Orca has no reset time to promise; delivery waits until the chat continues.'
    await main.deliver('run_bot', { id: 'request', subject: '请处理', body: '请处理', state: 'pending' })
    env.warning = ''
    await poll()
    assert.equal(env.sends.at(-1)?.target, 'bot:bot-1')
    const token = env.sends.at(-1)!.body.split(' ').at(-1)!
    env.home = second; env.owner = second; env.generation++
    env.sessions = [{ ...primary, handle: second, agent: 'codex' }, standby]
    const input = { action: 'take' as const, caller: second, token, runId: 'run_bot' }
    await backups.command(input)
    assert.deepEqual(await backups.command(input), { done: true })
    await poll()
    assert.equal(env.updates.length, 1)
    assert.match((await read()).bot!.result!, /恢复时间未知/)
    env.current = { ...initial, name: '新名字', id: 'different' }
    assert.equal((await read()).bot?.name, undefined)
    const choice = await worker.request('workspace.agent.switch', { mode: 'existing', handle: standby.handle, revision: (await read()).revision })
    await worker.request('workspace.agent', { operation: 'bind', revision: choice.revision, requestId: 'rollback', runId: 'run_old_session', currentRunId: 'run_old_session', caller: standby.handle,
      token: /一次性接管凭据：([^\n]+)/.exec(env.sends.at(-1)!.body)![1] })
    assert.equal((await read()).bot, undefined)
    assert.equal((await store.workspace()).originalBot, undefined)
  } finally { await worker.deactivate() }
})

test('待命会话提交交接后，在空闲 bot 上重开主对话接回 Run', async () => {
  const { env, worker, store, backups, poll, bind } = await setup()
  try {
    await bind()
    await store.mutateWorkspace(w => { w.backup!.phase = 'active'; w.backup!.since = 1 })
    env.owner = standby.handle
    await poll()
    const msg = env.sends.at(-1)!
    assert.match(msg.body, /lead-handoff run_bot/)
    const token = /lead-handoff run_bot (\S+)/.exec(msg.body)![1]
    await backups.command({ caller: standby.handle, action: 'handoff', token, note: '两项待验收', runId: 'run_bot' })
    await poll()
    assert.deepEqual(env.resets, ['bot-1'])
    assert.match(env.sends.at(-1)!.body, /两项待验收/)
    env.home = second; env.sessions = [{ ...primary, handle: second }, standby]
    const request = { caller: second, action: 'take' as const, token: /lead-take run_bot (\S+)/.exec(env.sends.at(-1)!.body)![1], runId: 'run_bot' }
    assert.deepEqual(await backups.command(request), { useRun: 'run_bot' })
    env.owner = second; env.generation++
    await backups.command(request)
    assert.equal((await store.workspace()).backup?.phase, 'standby')
    assert.equal((await store.workspace()).botHandoff, undefined)
  } finally { await worker.deactivate() }
})

test('不明回执等探测超时，运行时掉线期间只排队，恢复后备用接管', async () => {
  const { env, worker, store, backups, main, bind } = await setup()
  try {
    await bind()
    env.warning = 'Queued. unexpected response'
    const overdue = [{ at: Date.now() - 16 * 60000, title: '等待处理' }]
    const inspect = async (now: number) => backups.inspect(await store.workspace(), primary,
      { sessions: env.sessions, workspaces: [] }, overdue, '', 'run_bot', now)
    await inspect(Date.now()); await main.flushRetired()
    assert.equal((await store.workspace()).backup?.phase, 'probing')
    await inspect(Date.now() + 11 * 60000)
    assert.equal((await store.workspace()).backup?.phase, 'taking')
    assert.equal(env.updates.length, 0)
    await backups.inventoryStatus(await store.workspace(), false)
    await main.flushRetired()
    assert.equal(env.sends.some(s => s.target === standby.handle), false)
    assert.equal((await store.messaging()).deliveries.filter(d => d.external?.chatId === 'owner').length, 1)
    await backups.inventoryStatus(await store.workspace(), true)
    await main.flushRetired()
    assert.equal(env.sends.filter(s => s.target === standby.handle).length, 1)
  } finally { await worker.deactivate() }
})

for (const issue of ['拒绝','旧地址','超时','删除','暂停']) test('bot ' + issue + ' 时，备用拿到原 Run 的一次性接管命令', async () => {
  const { env, worker, store, backups, poll, bind } = await setup()
  try {
    await bind()
    if (issue === '删除') env.current = undefined
    else if (issue === '暂停') env.current!.paused = true
    else {
      env.reject = issue === '拒绝'
      if (issue === '旧地址') env.next = first
      await backups.saveQuota('run_bot', { home: first })
    }
    await poll()
    if (issue === '超时') await store.mutateWorkspace(w => { w.botSwitch!.until = 0 })
    await poll()
    assert.equal((await store.workspace()).backup?.phase, 'taking')
    const msg = env.sends.find(s => s.target === standby.handle)!
    assert.match(msg.body, /lead-take run_bot/)
    env.owner = standby.handle
    await backups.command({ action: 'take', caller: standby.handle, token: msg.body.split(' ').at(-1)!, runId: 'run_bot' })
    assert.equal((await store.workspace()).backup?.phase, 'active')
    assert.equal(env.updates.length, ['删除','暂停'].includes(issue) ? 0 : 1)
  } finally { await worker.deactivate() }
})
