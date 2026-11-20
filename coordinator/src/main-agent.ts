import { botHomeHandle } from './bot-runtime'
import { needsLeadCompaction } from './project-archive'
import { backupView, type BackupLeads } from './backup-lead'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { promptClientPath } from '../scripts/orca-cli.mjs'
import type { OrcaWorkerApi } from 'orca/worker'
import { agents, backupInCharge, type AgentSession, type Delivery, type LeadSwitch, type MainTakeover, type Project, type StoredTakeover, type WorkspaceBinding } from './model'
import type { CoordinatorRuntime } from './runtime'
import type { AgentLaunch } from '../../workspace/agent-launch.mjs'
import { ProjectStore, fail, fingerprint, takeoverActive, text, revision } from './store'

const mainSecurityBoundary = 'Run 归属由会话自报；替换授权来自面板一次性凭据。同一系统用户的本机程序可读写插件数据。'
export const roleReminder = {
  workspace: '提醒：你是工作间管理员，项目里的活交给项目主会话。',
  project: '提醒：实现交给执行者，成果用 submit 登记待验收。'
}

export function takeoverView(t?: StoredTakeover): MainTakeover | undefined {
  if (!t) return
  const { id, target, expiresAt, state, error } = t
  return takeoverActive(t) ? { id, target, expiresAt, state, ...(error ? { error } : {}) }
    : { id, target, expiresAt, state: 'expired', error: '对方没在有效期内完成绑定' }
}
export function recoverTakeover(t?: StoredTakeover) {
  if (t?.state === 'sending') {
    t.state = 'uncertain'
    t.error = '插件重启，接管请求是否送达未知，请核对目标会话'
  }
}
type Inventory = Awaited<ReturnType<CoordinatorRuntime['targets']>>
type Binding = { takeover?: StoredTakeover; bot?: WorkspaceBinding['bot']; session?: AgentSession; mainAgentHandle?: string }
export async function switchLead(runtime: CoordinatorRuntime, input: LeadSwitch, options: {
  targets: () => Promise<Inventory>
  mutate: (update: (binding: Binding) => void | Promise<void>, expected?: number) => Promise<unknown>
  changed: () => void
  role: keyof typeof roleReminder
  prompt: (token: string, expiresAt: string) => string
  subject?: string
  launch?: Omit<AgentLaunch, 'agent'>
}) {
  const expected = revision(input.revision), { mutate, changed } = options
  async function clearPendingSoul(w: Binding, nextId?: string) {
    const prior = w.takeover?.bot
    if (!prior) return
    if (w.takeover?.state === 'sending') fail('正在准备 bot 的接管通知，请稍后再切换')
    if (prior.soul && prior.id !== w.bot?.id && prior.id !== nextId) {
      await runtime.bots!.removeSoul(prior)
      delete w.takeover
    }
  }
  if (input.mode === 'cancel') {
    await mutate(async w => { await clearPendingSoul(w); delete w.takeover }, expected)
    changed()
    return
  }
  const bot = input.mode === 'bot' && options.role === 'workspace' && input.botId ? await runtime.bots?.find(input.botId) : undefined
  if (input.mode === 'bot' && (!bot || bot.paused || !['claude','codex'].includes(bot.agent))) fail('所选 bot 不可用')
  if (!bot && input.mode !== 'existing' && input.mode !== 'new') fail('请选择切换方式')
  const targets = await options.targets()
  const existing = input.mode === 'existing', agent = input.agent ?? ''
  const target = bot ? { handle: '', title: bot.name, workspace: '', workspaceName: '', path: '', agent: bot.agent, online: 'unknown' as const } : existing ? targets.sessions.find(s => s.handle === input.handle && s.online === 'online') : (() => {
    const w = targets.workspaces.find(w => w.workspace === input.workspace)
    if (!w || !Object.hasOwn(agents, agent)) return
    return { handle: '', title: `新的 ${agents[agent as keyof typeof agents]} 会话`, workspace: w.workspace, workspaceName: w.name, path: w.path, agent, online: 'unknown' as const }
  })()
  if (!target) fail('目标会话或工作区已不可用，请刷新后选择')
  if (!existsSync(promptClientPath())) fail('找不到接管脚本，请检查 AgentBoat 安装')
  const token = randomBytes(32).toString('base64url'), id = randomUUID(), expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
  let preparationError: Error | undefined
  await mutate(async w => {
    if (target.handle && (w.session?.handle ?? w.mainAgentHandle) === target.handle) fail('该会话已经是主会话')
    const prior = w.takeover
    if (prior && takeoverActive(prior) &&
      (bot ? prior.bot?.id === bot.id : existing ? prior.target.handle === target.handle : prior.mode === input.mode && prior.target.workspace === target.workspace && prior.target.agent === target.agent)) fail('该会话的接管请求已发起')
    await clearPendingSoul(w, bot?.id)
    let binding: WorkspaceBinding['bot']
    if (bot) {
      const priorBot = prior?.bot?.id === bot.id ? prior.bot : w.bot
      try {
        const soul = await runtime.bots!.writeSoul(bot, targets.workspaces, priorBot?.id === bot.id ? priorBot.soul : undefined)
        binding = { id: bot.id, name: bot.name, soul }
      } catch (e) {
        if (!prior || w.takeover) throw e
        // The previous pending bot was already cleaned up. Persist its cancellation.
        preparationError = e as Error
        return
      }
    }
    w.takeover = { id, target, expiresAt, tokenHash: fingerprint(token), state: 'sending', mode: bot ? 'bot' : existing ? 'existing' : 'new',
      ...(binding ? { bot: binding } : {}) }
  }, expected)
  changed()
  if (preparationError) throw preparationError
  const prompt = `${options.prompt(token, expiresAt)}\n\n${roleReminder[options.role]}`
  let handle: string
  let newHome: string | undefined
  try {
    if (bot) newHome = await runtime.bots!.newHome(bot.id)
    handle = bot ? (await runtime.botMail!('bot:' + bot.id, '请接管工作间主 agent', prompt, 'handoff')).recipient
      : existing ? (await runtime.requestTakeover(target.handle, prompt, options.subject), target.handle)
      : await runtime.launchMain(target.workspace, target.agent, prompt, options.launch)
    if (bot && (!botHomeHandle(handle) || handle !== newHome)) fail('未确认新主对话的收件地址')
  } catch {
    await mutate(w => {
      if (w.takeover?.id !== id) return
      w.takeover.state = 'uncertain'
      w.takeover.error = bot && !newHome ? '职责说明已写入，新主对话未确认。请核对 bot 主对话后取消并重试' : '接管请求未能确认送达，请核对目标会话后重试'
    })
    changed()
    return
  }
  await mutate(w => {
    if (w.takeover?.id !== id) return
    w.takeover.target.handle = handle
    w.takeover.state = 'waiting'
  })
  changed()
}

export function mainAgent(orca: OrcaWorkerApi, store: ProjectStore, runtime: CoordinatorRuntime, changed: () => void, bound: () => void, projects: () => Promise<Project[]>, backups: BackupLeads, sample: () => import('./model').AgentsSnapshot) {
  async function read(sample?: import('./model').AgentsSnapshot): Promise<WorkspaceBinding> {
    const w = await store.workspace()
    const takeover = takeoverView(w.takeover)
    const previous = w.retired?.filter(d => d.id.startsWith('retired:')).at(-1)
    const s = w.session
    const activity = sample?.ok && sample.main?.handle === s?.handle ? sample.main?.status : undefined
    const online = sample ? activity?.state === 'offline' ? 'offline' : activity && activity.state !== 'unknown' ? 'online' : 'unknown' : s ? await runtime.targets().then(t => t.sessions.find(x => x.handle === s.handle)?.online ?? 'offline' as const).catch(() => 'unknown' as const) : 'unknown'
    const current = w.bot && await runtime.bots?.find(w.bot.id).catch(() => undefined)
    return { revision: w.revision, runId: w.runId, ...(w.bot ? { bot: { ...w.bot, ...current } } : {}),
      ...(w.backup ? { backup: backupView(w.backup) } : {}), securityBoundary: mainSecurityBoundary,
      ...(s ? { session: { ...s, online: w.botSwitch ? 'unknown' : online } } : {}), ...(w.boundAt ? { boundAt: w.boundAt } : {}),
      ...(w.runId ? { projectNames: (await projects()).filter(p => !p.hidden && p.runId === w.runId).map(p => p.ref.name) } : {}),
      ...(previous ? { previousNotice: previous.state } : {}),
      ...(takeover ? { takeover } : {}) }
  }
  const waitingForBot = (w: import('./model').Workspace) => !!(w.botSwitch || w.botQuota || w.botStopped)
  async function deliver(run: string, d: Delivery, fromQueue = false): Promise<{ requestId?: string }> {
    const w = await store.workspace()
    if (!w.bot || w.runId !== run) return runtime.send(run, d)
    const waiting = waitingForBot(w)
    if (!fromQueue && (d.informational || waiting)) {
      await store.mutateWorkspace(row => {
        if (row.runId !== run) fail('工作间绑定已变化')
        const queue = row.retired ??= [], id = 'bot-mail:' + d.id
        if (!queue.some(x => x.id === id)) queue.push({ ...d, id, createdAt: Date.now(), targetRunId: run, state: 'pending' })
      })
      return {}
    }
    const receipt = await runtime.botMail!('run:' + run, d.subject, d.body, d.informational ? 'status' : 'handoff', w.session?.handle)
    if (receipt.quota) await backups.saveQuota(run, receipt.quota)
    return {}
  }
  let flushing: Promise<void> | undefined
  function flushRetired(): Promise<void> {
    if (flushing) return flushing
    flushing = (async () => {
      while (true) {
        const w = await store.workspace()
        const waiting = waitingForBot(w)
        const eligible = (d: Delivery) => d.state === 'pending' && backups.canSend(w, d) &&
          !(w.bot && waiting && !d.control && !d.ownerAlert && d.targetRunId === w.runId)
        const d = w.retired?.find(d => eligible(d) && (!d.informational || Date.now() - (d.createdAt ?? 0) >= 5 * 60_000))
        if (!d) break
        const batch = d.informational ? w.retired!.filter(x => x.informational && x.targetRunId === d.targetRunId && eligible(x)).slice(0, 20) : [d]
        const ids = new Set(batch.map(x => x.id))
        await store.mutateWorkspace(w => { for (const x of w.retired!) if (ids.has(x.id)) x.state = 'sending' })
        let state: 'sent' | 'uncertain' = 'sent'
        try {
          if (d.ownerAlert) {
            await store.mutateMessaging(m => {
              if (m.feishu.enabled) for (const chatId of m.feishu.chatIds) {
                const id = d.id + ':' + chatId
                if (!m.deliveries.some(x => x.id === id)) m.deliveries.push({ ...d, id, external: { channel: 'feishu', appId: m.feishu.appId, chatId } })
              }
            })
            bound()
          } else if (d.control) await backups.send('', d)
          else await deliver(d.targetRunId!, d.informational ? { ...d, subject: '工作间进展摘要', body: batch.map(x => x.subject).join('\n') } : d, true)
        } catch { state = 'uncertain' }
        await store.mutateWorkspace(w => {
          for (const x of w.retired!) if (ids.has(x.id)) x.state = state
          if (state === 'sent') w.retired = w.retired!.filter(x => !ids.has(x.id) || !x.id.startsWith('bot-mail:'))
        })
      }
    })().finally(() => { flushing = undefined })
    return flushing
  }
  orca.panels.handle('workspace.agent', async (input): Promise<WorkspaceBinding> => {
    if (input.operation === 'bind') {
      const runId = text(input.runId, 'Run 编号', 200), caller = text(input.caller, '调用会话', 500)
      if (input.checkOnly !== undefined && typeof input.checkOnly !== 'boolean') fail('checkOnly 必须是布尔值；检查请用 main-bind --check')
      await runtime.verifyRun(runId, caller)
      const session = await runtime.identify(caller, runId, input.currentRunId)
      const pending = (await store.workspace()).takeover?.bot
      if (pending) {
        if (!pending.soul) fail('此接管请求尚未写入职责说明，请在面板重新选择 bot')
        const current = await runtime.bots?.find(pending.id)
        if (!current || current.paused || current.agent !== session.agent || await runtime.bots!.home(current) !== caller) fail('当前会话不是所选 bot 的主对话')
      }
      await store.bindWorkspace(revision(input.revision), runId, { id: text(input.requestId, '请求编号', 200), input }, session, input.token, input.checkOnly, runtime.bots)
      if (input.checkOnly) return { ...await read(), check: { canTakeOver: true, message: '可以接管；本次只核实，凭据和绑定均未改变', runId, session } }
      bound()
      await flushRetired(); changed()
    } else if (input.operation !== 'read') fail('不支持的工作间操作')
    return read(input.operation === 'read' ? sample() : undefined)
  })
  orca.panels.handle('workspace.agent.targets', async () => {
    const t = await runtime.targets('display')
    const bots = await runtime.bots?.list().catch(() => undefined)
    return { ...t, ...(bots ? { bots } : {}), sessions: t.sessions.filter(s => s.online === 'online') }
  })
  orca.panels.handle('workspace.agent.switch', async input => {
    await switchLead(runtime, input, {
      role: 'workspace',
      targets: () => runtime.targets(), mutate: (update, expected) => store.mutateWorkspace(update, expected), changed,
      prompt: (token, expiresAt) => `开启工作间管理。主人已在项目协作面板发起切换，请由当前会话接管工作间主 agent。先读 $agentboat-workspace；自己创建新的协调 Run。接管脚本绝对路径：${JSON.stringify(promptClientPath())}\n用 node 调用此路径的 main-read，再以最新 revision 和唯一 requestId 调用 main-bind --check；检查通过后重读 main-read，以最新 revision 和新的 requestId 正式 main-bind。main-bind 从标准输入接收 JSON；caller 由脚本从当前 Orca 环境取得，不要填写别人的会话或 Run。一次性接管凭据：${token}\n有效至：${expiresAt}\n仅用于本次接管，不保存到文件或记忆，不转发。绑定成功后先读取 overview 补齐之前的待办；已经送达原主 agent 的通知不会补发。`
    })
    await flushRetired()
    return read()
  })
  async function recover() {
    const w = await store.workspace()
    const legacyBot = (bot: WorkspaceBinding['bot']) => bot && ('standbyWorkspace' in bot || 'standbyPath' in bot)
    if (legacyBot(w.bot) || legacyBot(w.takeover?.bot) || (w.bot && w.backup) || needsLeadCompaction(w) || w.takeover?.state === 'sending' || w.retired?.some(d => d.state === 'sending')) await store.mutateWorkspace(w => {
      for (const bot of [w.bot, w.takeover?.bot]) {
        if (bot && 'standbyWorkspace' in bot) delete bot.standbyWorkspace
        if (bot && 'standbyPath' in bot) delete bot.standbyPath
      }
      if (w.bot && w.backup) {
        if (w.backup.handle) w.bot.standbyRetired = true
        if (backupInCharge(w.backup) || w.backup.phase === 'taking') {
          w.botStopped = true
          w.bot.result = '原待命会话的接管状态需要核对。请在面板重新选择主 agent。'
          delete w.botSwitch; delete w.botQuota
        }
        delete w.backup
        if ('botHandoff' in w) delete w.botHandoff
        w.retired = w.retired?.filter(d => !d.control && !d.id.startsWith('lead-recheck:'))
      }
      recoverTakeover(w.takeover)
      for (const d of w.retired ?? []) if (d.state === 'sending') d.state = 'uncertain'
    })
    void flushRetired().catch(() => {})
  }
  return { read, recover, flushRetired, deliver }
}
