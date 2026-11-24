import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { BotStartRejected, LocalBots, localEndpoint, quotaReceipt } from './bot-runtime'
import { workspaceSoul } from './bot-soul'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { testCoordinator } from './test-runtime'
import { BackupLeads } from './backup-lead'
import { mainAgent, type WorkspaceSetup } from './main-agent'
import { fingerprint, ProjectStore } from './store'
import { mainTargets, OrcaRuntime, type CoordinatorRuntime } from './runtime'
import type { AgentSession, BotTarget } from './model'

const first = 'orca_session_id:10000000-0000-4000-9000-000000000001'
const second = 'orca_session_id:20000000-0000-4000-9000-000000000002'
const third = 'orca_session_id:30000000-0000-4000-9000-000000000003'
const initial: BotTarget = { id: 'bot-1', name: '统筹', agent: 'claude', paused: false }
const primary: AgentSession = { handle: first, workspace: 'bot-folder', workspaceName: '统筹', title: 'Home', path: '/bots/one', agent: 'claude', online: 'online', state: 'done' }
const standby = { ...primary, handle: 'orca_session_id:codex_spare', workspace: 'standby', path: '/standby', agent: 'codex' }

test('本机 RPC 只接受当前平台的管道类型与绝对地址', () => {
  const pipe = { kind: 'named-pipe', endpoint: '\\\\.\\pipe\\orca-test' }
  const unix = { kind: 'unix', endpoint: '/tmp/orca-test.sock' }
  const tcp = { kind: 'tcp', endpoint: '127.0.0.1:1234' }
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const [local, foreign] = platform === 'win32' ? [pipe, unix] : [unix, pipe]
    assert.equal(localEndpoint([tcp, foreign, local], platform), local.endpoint)
    for (const invalid of [[tcp, foreign], [{ ...local, endpoint: foreign.endpoint }], [{ ...local, endpoint: 'relative' }],
      [{ ...local, endpoint: local.endpoint + '\0suffix' }]]) {
      assert.throws(() => localEndpoint(invalid, platform), /本机 Orca 通道不可用/)
    }
  }
})

test('按本机工作区与磁盘 ID 更新 SOUL，备份原字节，保留主人内容', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentboat-soul-'))
  const home = path.join(root, 'bot-2'), old = path.join(root, 'bot'), data = path.join(root, 'plugin-data')
  const soul = path.join(home, 'SOUL.md'), diskId = path.join(home, 'bot.json')
  const row = { ...initial, name: '新名字', folderWorkspaceId: 'two', hostId: 'local' }
  const api = new LocalBots(async () => assert.fail('CLI'), async () => ({ bots: [row] }), data)
  const homes = mainTargets([['two', home], ['one', old]].map(([id, folder]) => ({
    botHome: true, worktreeId: 'folder:' + id, path: folder, address: { environment: 'local', worktree: id }
  })), []).workspaces
  const binding = { id: row.id }
  const write = () => api.writeSoul(row, homes)
  const get = () => readFile(soul, 'utf8')
  const heading = '## AgentBoat 工作间管理员', start = '<!-- agentboat:workspace-main:start -->', end = '<!-- agentboat:workspace-main:end -->'
  const block = [heading, start, '', workspaceSoul, '', end].join('\r\n')
  try {
    await mkdir(old); await mkdir(home)
    await writeFile(path.join(old, 'bot.json'), JSON.stringify({ id: 'retired', name: row.name }))
    await writeFile(path.join(old, 'SOUL.md'), '旧 bot')
    await writeFile(diskId, JSON.stringify(row))
    await assert.rejects(() => api.writeSoul(row, []), /家目录/)
    const created = await write()
    assert.equal(created.backup, undefined)
    assert.equal(await get(), '# 新名字\n\n' + block.replaceAll('\r\n', '\n') + '\n')
    const template = '\uFEFF# 旧名\r\n\r\nDescribe 旧名 here: what it is for, how it talks, and what it must never do.\r\n'
    await writeFile(soul, template)
    const seeded = await write()
    assert.equal(path.dirname(seeded.backup!), path.join(data, 'bot-soul-backups'))
    assert.equal(await readFile(seeded.backup!, 'utf8'), template)
    assert.equal(await get(), '\uFEFF# 新名字\r\n\r\n' + block + '\r\n')
    for (const custom of ['', '主人正文', '主人正文\n', '\uFEFF主人正文\r\n\r\n', template + '另有安排']) {
      await writeFile(soul, custom)
      const saved = await write()
      assert.equal(await readFile(saved.backup!, 'utf8'), custom)
      if (custom) assert.ok((await get()).startsWith(custom))
      await api.removeSoul({ ...binding, soul: saved })
      if (custom) assert.equal(await get(), custom)
      else assert.ok(!(await get()).includes(heading))
    }
    const prefix = '\uFEFF# 新名字\r\n\r\n主人前言  \r\n\r\n', suffix = '\r\n\r\n主人后记  '
    const edited = prefix + block.replace(workspaceSoul, '曾编辑的旧职责') + suffix
    await writeFile(soul, edited)
    const replaced = await write()
    assert.equal(await get(), prefix + block + suffix)
    assert.equal(await readFile(replaced.backup!, 'utf8'), edited)
    await writeFile(soul, edited)
    await api.removeSoul({ ...binding, soul: replaced })
    assert.equal(await get(), prefix + suffix)
    assert.equal(await readFile(path.join(old, 'SOUL.md'), 'utf8'), '旧 bot')
    for (const markers of [start, end, end + '\n' + start, start + '\n' + start + '\n' + end]) {
      await writeFile(soul, markers)
      await assert.rejects(write, /标记/)
      await assert.rejects(() => api.removeSoul({ ...binding, soul: replaced }), /标记/)
      assert.equal(await get(), markers)
    }
    await writeFile(soul, '主人新内容')
    const unavailable = new LocalBots(async () => assert.fail('CLI'), async () => ({ bots: [row] }), diskId)
    await assert.rejects(() => unavailable.writeSoul(row, homes), /SOUL.md/)
    assert.equal(await get(), '主人新内容')
    await writeFile(diskId, JSON.stringify({ ...row, id: 'other' }))
    await assert.rejects(write, /ID/)
    await assert.rejects(() => api.removeSoul({ ...binding, soul: replaced }), /ID/)
    assert.deepEqual((await readdir(home)).sort(), ['SOUL.md', 'bot.json'])
    await rm(home, { recursive: true })
    await assert.rejects(write, /家目录|SOUL.md/)
    await api.removeSoul({ ...binding, soul: replaced })
  } finally { await rm(root, { recursive: true, force: true }) }
})

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

test('bot 代理由宿主选项和该 bot 工作区启动支持共同决定，启动独立对话并核实归属', async () => {
  const current = { ...initial, agent: 'antigravity', hostId: 'local', folderWorkspaceId: 'one' }
  const calls: any[] = []
  let opened = second
  const cli = async (args: string[]) => {
    assert.deepEqual(args, ['bot', 'chats', '--bot', initial.id])
    return { chats: [{ id: second.slice(16), home: false, closed: false }, { id: first.slice(16), home: true, closed: false }] }
  }
  const api = new LocalBots(cli, async (method, params: any) => {
    calls.push([method, params])
    if (method === 'bots.list') return { bots: [current, { ...current, id: 'elsewhere', hostId: 'mac' }] }
    if (method === 'bots.agentChoices') return { agents: ['antigravity', 'omp', 'grok'] }
    if (method === 'agentSession.createSupport') {
      assert.equal(params.worktree, 'folder:one')
      return { supported: params.agent !== 'omp' }
    }
    return { sessionId: opened.slice(16) }
  })
  assert.deepEqual((await api.list()).map(b => [b.id, b.agents]), [[initial.id, ['antigravity', 'grok']]])
  assert.equal(await api.home(current), first)
  await assert.rejects(() => api.startChat(current, 'omp'), /不可用/)
  assert.equal(await api.startChat(current, 'antigravity'), second)
  opened = first
  await assert.rejects(() => api.startChat(current, 'grok'), /启动回执/)
  assert.deepEqual(calls.filter(([method]) => method === 'bots.session.start'), [
    ['bots.session.start', { botId: initial.id, agent: 'antigravity' }], ['bots.session.start', { botId: initial.id, agent: 'grok' }]])
})

function botRuntime() {
  const env = { current: { ...initial } as BotTarget | undefined, home: first as string | undefined, owner: null as string | null,
    soulActions: [] as string[], soulError: '', startTo: first as string | undefined, sideChats: new Set<string>(), choices: ['claude', 'codex', 'antigravity', 'grok'],
    generation: 2, reject: false, next: second, warning: '', sends: [] as { target: string; body: string; type: string }[], starts: [] as string[], sessions: [primary, standby], launches: [] as string[] }
  const inventory = () => ({ sessions: env.sessions, workspaces: [primary, standby].map(s => ({ workspace: s.workspace, path: s.path, name: s.title })) })
  const runtime = {
    bots: { find: async (id: string) => env.current?.id === id ? env.current : undefined, home: async () => env.home,
      list: async () => env.current ? [{ ...env.current, agents: env.choices }] : [],
      choices: async () => env.choices, hasSideChat: async (_: BotTarget, handle: string) => env.sideChats.has(handle),
      writeSoul: async (bot: BotTarget) => {
        env.soulActions.push('write ' + bot.id)
        if (env.soulError) throw Error(env.soulError)
        return { home: primary.path, backup: '/fixture/backup.md' }
      },
      removeSoul: async (bot: BotTarget) => {
        if (env.soulError) throw Error(env.soulError)
        env.soulActions.push('remove ' + bot.id)
      },
      startChat: async (bot: BotTarget, agent: string) => {
        env.soulActions.push(`start ${bot.id} ${agent}`); env.starts.push(agent)
        if (env.reject) throw new BotStartRejected('refused')
        const handle = env.startTo ?? env.next
        env.sideChats.add(handle)
        return handle
      } },
    botMail: async (target: string, subject: string, body: string, type: string) => {
      env.soulActions.push('mail ' + target)
      env.sends.push({ target, body, type })
      return { recipient: env.next, quota: quotaReceipt({ warnings: [{ code: 'recipient_delivery_held', recipient: first, message: env.warning }] }, first) }
    },
    requestTakeover: async (target: string, body: string) => { env.sends.push({ target, body, type: 'control' }) },
    runBinding: async () => ({ owner: env.owner, generation: env.generation }),
    identify: async (handle: string) => env.sessions.find(s => s.handle === handle),
    verifyRun: async () => {}, targets: async () => inventory(), installedAgents: async () => ['codex', 'claude'].map(id => ({ id, name: id, default: id === 'codex' })),
    launchMain: async (ws: string) => { env.launches.push(ws); return standby.handle },
    send: async (target: string, d: { body: string }) => { env.sends.push({ target, body: d.body, type: 'run' }); return {} }
  } as unknown as CoordinatorRuntime
  return { env, inventory, runtime }
}

async function setup(firstSetup?: WorkspaceSetup) {
  const { env, inventory, runtime } = botRuntime()
  let store!: ProjectStore, backups!: BackupLeads, main!: ReturnType<typeof mainAgent>
  const worker = await mountWorker({ default: orca => {
    store = new ProjectStore(orca.storage)
    backups = new BackupLeads(store, runtime, async () => {}, () => {})
    main = mainAgent(orca, store, runtime, () => {}, () => {}, async () => [], backups, () => ({ ok: false, at: 0, agents: [] }), firstSetup)
  } }, { host: mockHost() })
  const poll = async () => {
    const w = await store.workspace()
    await backups.inspect(w, w.session!, inventory(), [], '', w.runId)
    await main.flushRetired()
  }
  const bind = async () => {
    env.next = first
    const choice = await worker.request('workspace.agent.switch', { mode: 'bot', revision: 0, botId: initial.id })
    await worker.request('workspace.agent', { operation: 'bind', revision: choice.revision, requestId: 'bind', runId: 'run_bot',
      currentRunId: 'run_bot', caller: first, token: /一次性接管凭据：([^\n]+)/.exec(env.sends[0].body)![1] })
    await store.mutateMessaging(m => { m.feishu = { enabled: true, appId: 'fake', chatIds: ['owner'], senderIds: [] } })
    await poll()
    env.next = second
    env.startTo = undefined
    env.starts.length = 0
  }
  return { env, worker, store, backups, main, poll, bind, runtime }
}

test('面板确认首次设置后才启动 bot，失败保留路径，绑定后可单独修复 hooks', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'agentboat-bot-setup-'))
  const code: typeof import('../../workspace/install.mjs') = await import(new URL('../../workspace/install.mjs', import.meta.url).href)
  const config = { home, codexHome: path.join(home, 'custom-codex'), env: { ...process.env, CODEX_HOME: path.join(home, 'other-codex') } }
  const hooks = path.join(config.codexHome, 'hooks.json'), backup = path.join(home, '.agentboat/backups/setup-fixture')
  let failInstall = true
  const { env, worker, store } = await setup({
    preview: () => code.previewSetup(config),
    apply: confirmation => {
      if (failInstall) throw Error('写入失败：' + hooks + '\n备份位置：' + backup)
      env.soulActions.push('setup')
      return code.applySetup(confirmation, config)
    }
  })
  const panel = { panel: 'project-coordinator' }
  const targets = () => worker.request('workspace.agent.targets', {}, panel)
  const choose = (setupConfirmation?: string, context = panel) => worker.request('workspace.agent.switch',
    { mode: 'bot', revision: 0, botId: initial.id, ...(setupConfirmation ? { setupConfirmation } : {}) }, context)
  try {
    const plan = (await targets()).setup!
    assert.ok(plan.paths.includes(hooks))
    await assert.rejects(choose, /确认首次设置路径/)
    await assert.rejects(() => choose(plan.confirmation, { panel: 'another-panel' }), /主 agent 页面/)
    await assert.rejects(() => choose(plan.confirmation), error => {
      assert.ok(error instanceof Error && error.message.includes(hooks) && error.message.includes(backup))
      return true
    })
    assert.deepEqual(await readdir(home), [])
    assert.deepEqual(env.soulActions, [])
    assert.equal((await store.workspace()).takeover, undefined)
    failInstall = false
    env.next = first
    const waiting = await choose(plan.confirmation)
    assert.equal(waiting.takeover?.state, 'waiting')
    assert.deepEqual(env.soulActions, ['setup', 'write bot-1', 'start bot-1 claude', 'mail ' + first])
    assert.match(await readFile(hooks, 'utf8'), /--agentboat-role-harness/)
    await assert.rejects(() => readFile(path.join(config.env.CODEX_HOME, 'hooks.json')), e => (e as NodeJS.ErrnoException).code === 'ENOENT')
    const result = await worker.request('workspace.agent', { operation: 'bind', revision: waiting.revision, requestId: 'setup-bind',
      runId: 'run_bot', currentRunId: 'run_bot', caller: first, token: /一次性接管凭据：([^\n]+)/.exec(env.sends[0].body)![1] })
    assert.equal(result.runId, 'run_bot')
    assert.equal(result.session?.handle, first)
    const drift = JSON.parse(await readFile(hooks, 'utf8'))
    drift.hooks.Stop[0].hooks[0].timeout = 45
    await writeFile(hooks, JSON.stringify(drift))
    const repair = (await targets()).setup!
    assert.deepEqual(repair.paths, [hooks])
    assert.deepEqual((await worker.request('workspace.setup', { confirmation: repair.confirmation! }, panel)).completed, [hooks])
    assert.equal((await targets()).setup!.confirmation, undefined)
    assert.equal((await store.workspace()).runId, 'run_bot')
    assert.deepEqual(env.starts, ['claude'])
  } finally {
    await worker.deactivate()
    await rm(home, { recursive: true, force: true })
  }
})

test('bot ignores delivered Feishu mail, uncertain notifications and read questions, then stops on overdue queued mail', async () => {
  const { runtime } = botRuntime()
  const host = mockHost()
  let c!: ReturnType<typeof testCoordinator>
  const worker = await mountWorker({ default: api => {
    c = testCoordinator(api, { ...runtime, mail: async () => ({ waiting: [], reports: [], questions: [
      { id: 'read', from: 'worker', subject: '已读问题', body: '已读', at: 1, read: true }
    ] }) })
  } }, { host })
  try {
    await c.store.mutateWorkspace(w => { w.runId = 'run_bot'; w.session = primary; w.bot = { id: initial.id }; w.boundAt = new Date(1).toISOString() })
    await c.store.mutateMessaging(m => {
      m.inbox.push({ appId: 'app', state: 'done', event: { id: 'seen', source: 'feishu', sourceId: 'app:seen', chatId: 'chat', senderId: 'owner', threadId: 'thread', receivedAt: new Date(1).toISOString(), text: '好的' } })
      m.deliveries.push({ id: 'seen', targetRunId: 'run_bot', state: 'sent', subject: '已送达', body: '' },
        { id: 'check', state: 'uncertain', subject: '待核对', body: '', createdAt: 1 })
    })
    await c.checkBackups()
    assert.ok(!(await c.store.workspace()).botStopped)
    await c.store.mutateMessaging(m => { m.deliveries.push({ id: 'queued', state: 'pending', subject: '待送达', body: '', createdAt: 1 }) })
    await c.checkBackups()
    assert.ok((await c.store.workspace()).botStopped)
  } finally { c.stop(); await worker.deactivate() }
})

test('先写职责再开独立对话，投递并核对收件地址，准备失败时允许取消', async () => {
  const { env, worker, store } = await setup()
  const choose = async () => worker.request('workspace.agent.switch', { mode: 'bot', revision: (await store.workspace()).revision, botId: initial.id })
  const cancel = async () => worker.request('workspace.agent.switch', { mode: 'cancel', revision: (await store.workspace()).revision })
  try {
    env.soulError = '请修复 SOUL.md 标记'
    await assert.rejects(choose, /SOUL.md/)
    assert.equal((await store.workspace()).takeover, undefined)
    env.soulError = ''; env.reject = true
    assert.match((await choose()).takeover!.error!, /对话启动未确认/)
    assert.equal(env.sends.length, 0)
    await cancel()
    env.reject = false
    const mismatch = await choose()
    assert.equal(mismatch.takeover!.state, 'uncertain')
    assert.equal(mismatch.takeover!.target.handle, first)
    await cancel()
    env.soulActions.length = 0; env.next = first
    assert.equal((await choose()).takeover!.state, 'waiting')
    assert.deepEqual(env.soulActions, ['write bot-1', 'start bot-1 claude', 'mail ' + first])
    await cancel()
    assert.equal(env.soulActions.at(-1), 'remove bot-1')
  } finally { await worker.deactivate() }
})

test('从原 bot 换到另一个 bot，正式接管通过才清理原职责', async () => {
  const { env, worker, store, bind } = await setup()
  try {
    await bind()
    env.current = { ...initial, id: 'bot-2' }
    env.next = second
    env.sessions = [{ ...primary, handle: second }, standby]
    await worker.request('workspace.agent.switch', { mode: 'bot', botId: 'bot-2', revision: (await store.workspace()).revision })
    const input = { operation: 'bind' as const, revision: (await store.workspace()).revision, runId: 'run_two', currentRunId: 'run_two',
      caller: second, requestId: 'second-bot', token: /一次性接管凭据：([^\n]+)/.exec(env.sends.at(-1)!.body)![1] }
    await worker.request('workspace.agent', { ...input, checkOnly: true })
    assert.ok(!env.soulActions.includes('remove bot-1'))
    env.soulError = '请核对旧 bot 的 SOUL.md 标记'
    await assert.rejects(() => worker.request('workspace.agent', input), /SOUL.md/)
    const unchanged = await worker.request('workspace.agent', { operation: 'read' })
    assert.equal(unchanged.bot?.id, 'bot-1')
    assert.equal(unchanged.takeover?.error, env.soulError)
    env.soulError = ''
    input.revision = unchanged.revision
    const result = await worker.request('workspace.agent', input)
    assert.equal(result.bot?.id, 'bot-2')
    assert.ok(result.bot?.soul?.backup)
    await worker.request('workspace.agent', input)
    assert.equal(env.soulActions.filter(s => s === 'remove bot-1').length, 1)
  } finally { await worker.deactivate() }
})

test('Antigravity 可绑定为工作间 bot，同一 bot 可用其他宿主代理接回原 Run', async () => {
  const { env, worker, store, backups, main, bind } = await setup()
  try {
    env.current!.agent = 'antigravity'
    env.sessions[0] = { ...primary, agent: 'antigravity' }
    await bind()
    const choose = async (agent: string) => worker.request('workspace.agent.switch', { mode: 'bot', revision: (await store.workspace()).revision, botId: initial.id, agent })
    await assert.rejects(() => choose('kimi'), /没有可切换/)
    assert.deepEqual(env.starts, [])
    assert.equal((await choose('grok')).switchingBotAgent, 'grok')
    await main.deliver('run_bot', { id: 'pending', subject: '留言', body: '继续处理', state: 'pending' })
    assert.deepEqual(env.starts, ['grok'])
    assert.ok(env.sideChats.has(first))
    const sent = env.sends.at(-1)!
    assert.equal(sent.target, second)
    env.sessions.push({ ...primary, handle: second, agent: 'grok' })
    const take = { action: 'take' as const, caller: second, runId: 'run_bot', token: sent.body.split(' ').at(-1)! }
    assert.deepEqual(await backups.command(take), { useRun: 'run_bot' })
    env.owner = second; env.generation++
    assert.deepEqual(await backups.command(take), { done: true })
    await main.flushRetired()
    assert.equal(env.sends.find(s => s.body === '继续处理')?.target, 'run:run_bot')
    const saved = await worker.request('workspace.agent', { operation: 'read' })
    assert.equal(saved.bot?.agent, 'grok')
    assert.equal(saved.session?.handle, second)
    assert.equal(saved.switchingBotAgent, undefined)
    assert.equal(env.current!.agent, 'antigravity')
  } finally { await worker.deactivate() }
})

test('手动新开 bot 对话被拒绝时，保留仍持有原 Run 的旧代理', async () => {
  const { env, worker, store, main, bind } = await setup()
  try {
    await bind()
    env.owner = first
    env.reject = true
    const prior = await store.workspace()
    await assert.rejects(() => worker.request('workspace.agent.switch', { mode: 'bot', revision: prior.revision, botId: initial.id, agent: 'codex' }), /refused/)
    const after = await store.workspace()
    assert.equal(after.botSwitch, undefined)
    assert.equal(after.botStopped, undefined)
    assert.equal(after.runId, prior.runId)
    assert.deepEqual(after.session, prior.session)
    assert.ok(!env.sends.some(s => s.target === second))
    await main.deliver(after.runId, { id: 'after-refusal', subject: '留言', body: '继续处理', state: 'pending' })
    assert.equal(env.sends.at(-1)?.target, 'run:' + after.runId)
    assert.equal(env.sends.at(-1)?.body, '继续处理')
  } finally { await worker.deactivate() }
})

test('手动换 bot 启动回执未知时保留切换记录并暂停，主人仍可重选', async () => {
  const { env, worker, store, main, bind, runtime } = await setup()
  try {
    await bind()
    env.owner = first
    const startChat = runtime.bots!.startChat
    runtime.bots!.startChat = async () => { throw Error('bots.session.start 本机调用未确认') }
    const choose = async () => worker.request('workspace.agent.switch', { mode: 'bot', revision: (await store.workspace()).revision, botId: initial.id, agent: 'codex' })
    const paused = await choose()
    assert.equal(paused.botStopped, true)
    assert.match(paused.bot!.result!, /核对 bot 对话的启动回执/)
    assert.equal((await store.workspace()).botSwitch?.agent, 'codex')
    const sent = env.sends.length
    await main.deliver('run_bot', { id: 'after-unknown', subject: '留言', body: '暂缓', state: 'pending' })
    assert.equal(env.sends.length, sent)
    runtime.bots!.startChat = startChat
    assert.equal((await choose()).switchingBotAgent, 'codex')
  } finally { await worker.deactivate() }
})

test('手动换 bot 期间收到了旧地址额度回执，拒绝启动后仍保留回执并暂停', async () => {
  const { env, worker, store, main, bind, runtime } = await setup()
  try {
    await bind()
    env.owner = first
    const quota = { home: first, recoveryAt: Date.now() + 60_000 }
    let returnQuota!: () => void, refuseStart!: () => void
    const mailSent = new Promise<void>(sent => {
      runtime.botMail = async () => {
        sent()
        await new Promise<void>(resolve => { returnQuota = resolve })
        return { recipient: first, quota }
      }
    })
    const opening = new Promise<void>(started => {
      runtime.bots!.startChat = async () => {
        started()
        await new Promise<void>(resolve => { refuseStart = resolve })
        throw new BotStartRejected('refused')
      }
    })
    const delivery = main.deliver('run_bot', { id: 'old-in-flight', subject: '留言', body: '正在投递', state: 'pending' })
    await mailSent
    const switching = worker.request('workspace.agent.switch', { mode: 'bot', revision: (await store.workspace()).revision, botId: initial.id, agent: 'codex' })
    await opening
    returnQuota(); await delivery
    refuseStart()
    const paused = await switching
    assert.equal(paused.botStopped, true)
    assert.match(paused.bot!.result!, /当前 bot 对话已用完额度/)
    const saved = await store.workspace()
    assert.equal(saved.session?.handle, first)
    assert.deepEqual(saved.botQuota, quota)
  } finally { await worker.deactivate() }
})

test('旧版已经投递的 bot Home 接管请求可在升级后接回原 Run', async () => {
  const { env, worker, store, backups, bind } = await setup()
  try {
    await bind()
    env.current!.agent = 'codex'; env.home = second
    env.sessions.push({ ...primary, handle: second, agent: 'codex' })
    await store.mutateWorkspace(w => {
      delete w.bot!.side
      w.botSwitch = { cycle: 'old', oldHome: first, agent: 'codex', until: Date.now() - 1,
        credential: fingerprint('issued'), generation: env.generation, recipient: second, returning: false }
    })
    env.owner = second; env.generation++
    await backups.inventoryStatus(await store.workspace(), true)
    assert.ok((await store.workspace()).botStopped)
    assert.deepEqual(await backups.command({ action: 'take', caller: second, runId: 'run_bot', token: 'issued' }), { done: true })
    assert.equal((await store.workspace()).session?.handle, second)
    assert.equal((await store.workspace()).botStopped, undefined)
    assert.deepEqual(env.starts, [])
  } finally { await worker.deactivate() }
})

test('面板绑定、无需备用、切换宽限、凭据接回原 Run、到点空闲切回和飞书队列', async () => {
  const { env, worker, store, backups, main, poll, bind } = await setup()
  try {
    await bind()
    assert.deepEqual(env.launches, [])
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
    assert.equal((await store.workspace()).backup, undefined)
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
    await poll(); assert.equal(env.starts.length, 1)
    env.sessions[0].state = 'done'; env.next = third
    await poll(); await confirm(third, 'claude')
    assert.deepEqual(env.starts, ['codex', 'claude'])
    assert.equal(env.current!.agent, 'claude')
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
    assert.equal((await store.workspace()).bot?.name, initial.name)
    env.warning = 'Queued. ' + first + ' stopped at its usage limit and Orca has no reset time to promise; delivery waits until the chat continues.'
    await main.deliver('run_bot', { id: 'request', subject: '请处理', body: '请处理', state: 'pending' })
    env.warning = ''
    await poll()
    assert.equal(env.sends.at(-1)?.target, second)
    const token = env.sends.at(-1)!.body.split(' ').at(-1)!
    env.home = second; env.owner = second; env.generation++
    env.sessions = [{ ...primary, handle: second, agent: 'codex' }, standby]
    const input = { action: 'take' as const, caller: second, token, runId: 'run_bot' }
    await backups.command(input)
    assert.deepEqual(await backups.command(input), { done: true })
    await poll()
    assert.equal(env.starts.length, 1)
    assert.match((await read()).bot!.result!, /恢复时间未知/)
    env.current = { ...initial, name: '新名字', id: 'different' }
    assert.equal((await read()).bot?.name, initial.name)
    const choice = await worker.request('workspace.agent.switch', { mode: 'existing', handle: standby.handle, revision: (await read()).revision })
    await worker.request('workspace.agent', { operation: 'bind', revision: choice.revision, requestId: 'rollback', runId: 'run_old_session', currentRunId: 'run_old_session', caller: standby.handle,
      token: /一次性接管凭据：([^\n]+)/.exec(env.sends.at(-1)!.body)![1] })
    assert.equal((await read()).bot, undefined)
    assert.ok(env.soulActions.includes('remove bot-1'))
    assert.equal((await store.workspace()).originalBot, undefined)
  } finally { await worker.deactivate() }
})

for (const [issue, reason] of [
  ['拒绝', '切换失败'], ['旧地址', '回执无法核对'], ['超时', '切换超时'], ['二次停住', '再次用完额度'],
  ['删除', '找不到已绑定的 bot'], ['暂停', 'bot 已暂停'], ['原因不明', '未收到额度用完的回执']
]) test('bot ' + issue + ' 时通知主人一次并暂停处理', async () => {
  const { env, worker, store, backups, main, poll, bind } = await setup()
  try {
    await bind()
    if (issue === '删除') env.current = undefined
    else if (issue === '暂停') env.current!.paused = true
    else if (issue === '原因不明') {
      const w = await store.workspace()
      await backups.inspect(w, primary, { sessions: env.sessions, workspaces: [] }, [{ at: 1, title: '等待处理' }], '', w.runId)
    } else {
      env.reject = issue === '拒绝'
      if (issue === '旧地址') env.next = first
      if (issue === '二次停住') await store.mutateWorkspace(w => { w.originalBot = { agent: 'codex' } })
      await backups.saveQuota('run_bot', { home: first })
    }
    await poll()
    if (issue === '超时') {
      await store.mutateWorkspace(w => { w.botSwitch!.until = 0 })
      await backups.inventoryStatus(await store.workspace(), false)
    }
    await poll(); await poll()
    const { bot, botStopped, backup, botSwitch } = await store.workspace()
    assert.equal(backup, undefined)
    assert.equal(botSwitch, undefined)
    assert.equal(botStopped, true)
    assert.match(bot!.result!, new RegExp(reason))
    assert.match(bot!.result!, /等待主人.*为 统筹 选择可用代理.*切回普通会话/)
    assert.deepEqual((await store.messaging()).deliveries.filter(d => d.external?.chatId === 'owner').map(d => d.body), [bot!.result])
    const count = env.sends.length
    await main.deliver('run_bot', { id: 'later', body: '新事项', subject: '待处理', state: 'pending' })
    await main.flushRetired()
    assert.equal(env.sends.length, count)
    assert.ok((await store.workspace()).retired?.some(d => d.id === 'bot-mail:later' && d.state === 'pending'))
    assert.ok(!env.sends.some(s => s.target === standby.handle))
    assert.deepEqual(env.launches, [])
    if (issue === '暂停') {
      const choice = await worker.request('workspace.agent.switch', { mode: 'existing', handle: standby.handle, revision: (await store.workspace()).revision })
      const token = /一次性接管凭据：([^\n]+)/.exec(env.sends.at(-1)!.body)![1]
      await worker.request('workspace.agent', { operation: 'bind', revision: choice.revision, requestId: 'manual', runId: 'run_manual', caller: standby.handle, token })
      assert.equal(env.sends.find(s => s.body === '新事项')?.target, 'run_manual')
    }
  } finally { await worker.deactivate() }
})
