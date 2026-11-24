import { randomBytes, randomUUID } from 'node:crypto'
import { botHomeHandle, BotStartRejected } from './bot-runtime'
import { projectLeadAgents } from '../../workspace/agent-launch.mjs'
import { promptClientPath } from '../scripts/orca-cli.mjs'
import { awaitingLeadControl, expectedPhases, backupInCharge, workspaceBackupInFlight, type AgentSession, type BackupLead, type BotTarget, type ContactRoutes, type Delivery, type LeadAction, type Project, type Workspace } from './model'
import { targetOnline, type CoordinatorRuntime, type TargetInventory } from './runtime'
import { fail, fingerprint, ProjectStore, resetBackup, takeoverActive, text } from './store'

function ownerAlert(w: Workspace, message: string) {
  w.bot!.result = message
  const deliveries = w.retired ??= []
  deliveries.push({ id: 'bot-alert:' + randomUUID(), ownerAlert: true, subject: '工作间主 agent', body: message, state: 'pending' })
}
const hour = 3600_000
const probeWait = 10 * 60_000
type Binding = Project | Workspace
const key = (r: Binding) => 'ref' in r ? r.ref.id : ''
const queue = (r: Binding) => 'ref' in r ? r.deliveries : r.retired ??= []
const label = (r: Binding) => 'ref' in r ? r.ref.name : '工作间'
const available = (r: Binding) => !('ref' in r && r.hidden) && !takeoverActive(r.takeover)
const chat = (handle?: string) => !!handle?.startsWith('orca_session_id:')
const unopened = (b?: BackupLead) => !b || b.phase === 'unavailable' || b.phase === 'single'
type LeadState = Pick<AgentSession, 'online' | 'state'>
const bothStopped = '主用和备用均停住，请主人核对会话'

function leadState(inventory: TargetInventory | undefined, workspace: string, handle?: string, previous?: TargetInventory): LeadState {
  const session = inventory?.sessions.find(s => s.handle === handle && s.workspace === workspace)
  if (session) return session
  // Absence is evidence only when two complete reads agree.
  return { online: handle && targetOnline(previous, handle, workspace) === 'offline' &&
    targetOnline(inventory, handle, workspace) === 'offline' ? 'offline' : 'unknown' }
}

export function stopped(session: LeadState, pendingSince: number | undefined, now: number) {
  if (session.online === 'offline') return 'Orca 中找不到在线会话'
  if (session.online === 'online' && ['done', 'blocked', 'waiting'].includes(session.state ?? '') &&
    pendingSince !== undefined && now - pendingSince > 15 * 60_000) return '待处理事项已超过 15 分钟'
}

export const projectBackupBusy = (b?: BackupLead) => !!b && ['opening', 'taking', 'active', 'handoff', 'returning'].includes(b.phase)
export const projectBackupCanRecover = (b?: BackupLead): b is BackupLead => b?.phase === 'active' || b?.phase === 'returning'
export const pendingBotSwitch = (w: Workspace) => !w.botStopped || w.botSwitch?.recipient ? w.botSwitch : undefined

function record(r: Binding, message: string, ownerRun: string) {
  const b = r.backup!
  b.history.push({ at: Date.now(), text: message })
  if (ownerRun) queue(r).push({ id: 'lead-notice:' + randomUUID(), targetRunId: ownerRun, subject: label(r) + ' · 主会话', body: message + '。请告知主人。', state: 'pending' })
}

function control(r: Binding, action: LeadAction, body: string) {
  const b = r.backup!
  delete b.credential
  queue(r).push({ id: 'lead-control:' + randomUUID(), subject: { take: '备用接管', ready: '主用状态确认', handoff: '请写交接说明', resume: '主用交回' }[action], body,
    control: { action, cycle: b.cycle, handle: action === 'ready' || action === 'resume' ? b.primary : b.handle! }, targetRunId: r.runId, state: 'pending' })
}

export class BackupLeads {
  private routes: ContactRoutes = {}
  private inventoryUnavailable = false
  async inventoryStatus(w: Workspace, available: boolean, now = Date.now()) {
    this.inventoryUnavailable = !available
    if (w.botSwitch && !w.botStopped && now >= w.botSwitch.until && !takeoverActive(w.takeover)) {
      await this.stopBot(w, 'bot 切换超时，接收会话未确认接回 Run')
      return true
    }
    return false
  }
  async syncContacts(rows: Binding[], sessions?: AgentSession[], workspaces?: string[]) {
    const wanted = rows.flatMap(row => row.runId && !('ref' in row && row.hidden) && row.backup?.contact &&
      backupInCharge(row.backup) ? [{ ...row.backup.contact, online: sessions?.some(s => s.handle === row.backup!.primary && s.online === 'online') }] : [])
    this.routes = await this.runtime.syncContacts(wanted, workspaces)
    return this.routes
  }

  constructor(private store: ProjectStore, private runtime: CoordinatorRuntime, private visible: (id: string) => Promise<unknown>,
    private changed: (id: string) => void) {}

  projectPrimaryUnavailable(project: Project, inventory: TargetInventory) {
    const b = project.backup
    if (!projectBackupCanRecover(b) || !b.primary) return false
    // A contact's `closed` flag acknowledges our own cleanup. Only Orca's session error proves closure.
    const error = b.contact?.primary === b.primary ? this.routes[b.contact.id]?.error : undefined
    const sessionId = b.primary.slice('orca_session_id:'.length)
    const workspace = project.mainSession?.handle === b.primary ? project.mainSession.workspace : b.contact?.workspace
    return targetOnline(inventory, b.primary, workspace) === 'offline' ||
      (chat(b.primary) && !!error?.startsWith(`Agent session ${sessionId} has ended: its chat was closed.`))
  }

  async verifyProjectPromotion(runId: string, backup: BackupLead, session: AgentSession) {
    const { owner, generation } = await this.runtime.runBinding(runId)
    if (!Number.isSafeInteger(generation) || generation !== backup.generation ||
      (owner !== session.handle && !(backup.phase === 'active' && owner === null && chat(session.handle)))) fail('Run 归属或代次与当前代管备用不符，请核对后再操作')
  }

  private mutate(id: string, update: (r: Binding) => void, revision?: number) {
    return id ? this.store.mutate(id, revision, update) : this.store.mutateWorkspace(update, revision)
  }

  private async updateBinding(r: Binding, update: (row: Binding) => void) {
    const id = key(r)
    if (id) await this.visible(id)
    return this.mutate(id, update, r.revision)
  }

  private controlTarget(b: BackupLead | undefined, c: NonNullable<Delivery['control']>) {
    if (b && awaitingLeadControl(b, c)) {
      if (backupInCharge(b) && c.handle === b.primary) {
        const dispatch = b.contact && this.routes[b.contact.id]?.dispatch
        return dispatch && 'dispatch:' + dispatch
      }
      if (c.action === 'take' && b.standbyRunId) return 'run:' + b.standbyRunId
    }
    return c.handle
  }

  canSend(r: Binding, d: Delivery) {
    if (!('ref' in r) && r.bot && this.inventoryUnavailable && !d.ownerAlert) return false
    if (d.control && !('ref' in r) && (!workspaceBackupInFlight(r.backup) || !awaitingLeadControl(r.backup, d.control))) return false
    return !d.control || !takeoverActive(r.takeover) && !!this.controlTarget(r.backup, d.control)
  }

  async missing(r: Binding, reason: string, ownerRun: string, single = false) {
    if (!('ref' in r)) return
    if (!unopened(r.backup)) return
    const phase = single ? 'single' : 'unavailable'
    const notify = !single && !!ownerRun && !r.backup?.notified?.includes(reason)
    if (r.backup?.phase === phase && r.backup.problem === (single ? undefined : reason) && !notify) return
    await this.updateBinding(r, row => {
      const b = row.backup ??= { primary: ('ref' in row ? row.mainAgentHandle : row.session?.handle) ?? '', agent: '', phase, since: Date.now(), cycle: randomUUID(), history: [] }
      b.phase = phase
      if (single) delete b.problem
      else b.problem = reason
      if (notify) { (b.notified ??= []).push(reason); record(row, '没有备用：' + reason, ownerRun) }
    })
    this.changed(key(r))
  }

  async retry(id: string, revision: number, confirm: boolean) {
    if (!id) fail('工作间请在主 agent 面板选择 bot 和代理')
    if (confirm !== true || !Number.isSafeInteger(revision)) fail('请确认重新开备用')
    if (id) await this.visible(id)
    await this.mutate(id, row => {
      if (!available(row) || !row.runId || row.backup?.phase !== 'failed') fail('只有启动失败的备用可以重开')
      row.backup.phase = 'unavailable'
      delete row.backup.problem
    }, revision)
    this.changed(id)
  }

  async inspect(r: Binding, session: AgentSession, inventory: Awaited<ReturnType<CoordinatorRuntime['targets']>>,
    pending: { at: number; title: string }[] | undefined, context: string, ownerRun: string, now = Date.now(),
    recheck = () => this.runtime.targets().catch(() => undefined)) {
    if (!available(r) || !r.runId) return
    const id = key(r), b = r.backup
    const w = 'ref' in r ? undefined : r, bot = w?.bot
    const { workspace, handle } = session
    let live = leadState(inventory, workspace, handle)
    if (w && bot) {
      if (live.online === 'unknown') live = leadState(await recheck(), workspace, handle, inventory)
      if (w.botSwitch && await this.inventoryStatus(w, true, now)) return
      const oldest = pending?.length ? Math.min(...pending.map(p => p.at)) : undefined
      const reason = stopped(live, oldest === undefined ? undefined : Math.max(oldest, w.botReceipt?.confirmedAt ?? 0), now)
      const api = this.runtime.bots
      let current: BotTarget | undefined, home: string | undefined
      try {
        current = await api?.find(bot.id)
        if (current && !current.paused && !w.botSwitch) {
          home = bot.side ? await api!.hasSideChat(current, session.handle) ? session.handle : undefined : await api!.home(current)
        }
      } catch {
        if (reason && !w.botSwitch && !w.botStopped) await this.stopBot(w, reason + '，无法核对 bot 主对话')
        return
      }
      if (w.botSwitch) {
        if (!current || current.paused || !w.botSwitch.side && current.agent !== w.botSwitch.agent) await this.stopBot(w, 'bot 切换中再次停住')
        return
      }
      if (!bot.side && current && home && home !== session.handle) {
        const next = inventory.sessions.find(s => s.handle === home && s.workspace === session.workspace && s.agent === current.agent && s.online === 'online')
        if (next && (await this.runtime.runBinding(w.runId)).owner === home) {
          await this.store.mutateWorkspace(row => {
            row.session = next
            delete row.botQuota; delete row.botStopped; delete row.botReceipt
            if (row.originalBot?.agent === next.agent) {
              delete row.originalBot; delete row.bot!.recoveryAt; delete row.bot!.reason
            }
            ownerAlert(row, '新的 bot 主对话已接回 Run。')
          }, w.revision)
          this.changed(''); return
        }
      }
      if (w.botStopped) return
      if (!current || current.paused || !home || home !== session.handle) return this.stopBot(w,
        !current ? '找不到已绑定的 bot' : current.paused ? 'bot 已暂停' : '已绑定的 bot 主对话不可用', current?.name)
      if (w.botQuota?.home === home) {
        if (w.originalBot) return this.stopBot(w, '替换后的 agent 再次用完额度', current.name)
        return this.switchBot(w, current, now)
      }
      if (reason) return this.stopBot(w, reason + '，未收到额度用完的回执', current.name)
      if (w.originalBot && session.agent !== w.originalBot.agent && bot.recoveryAt && now >= bot.recoveryAt && live?.online === 'online' && live.state === 'done') return this.switchBot(w, current, now, w.originalBot.agent, true)
      return
    }
    if (w && !workspaceBackupInFlight(b)) return
    if ('ref' in r && b?.phase === 'standby') {
      let configured
      try { configured = projectLeadAgents(r.leadAgents, session.agent).backup }
      catch { /* Keep an existing backup while its template is unreadable. */ }
      if (configured !== undefined && configured?.agent !== b.agent) {
        await this.updateBinding(r, row => resetBackup(row, session.handle))
        this.changed(id)
        return
      }
    }
    if ('ref' in r && unopened(b)) {
      if (!session.agent) return this.missing(r, '无法识别主会话的 agent 类型', ownerRun)
      const installed = await this.runtime.installedAgents(session.workspace).catch(() => undefined)
      if (!installed) return this.missing(r, '无法读取 Orca 的可启动 agent 列表', ownerRun)
      let backup
      try { backup = projectLeadAgents(r.leadAgents, session.agent).backup }
      catch { return this.missing(r, '项目主会话模板无法读取，请核对本机模板', ownerRun) }
      if (!backup) return this.missing(r, '', ownerRun, true)
      const { agent, ...options } = backup
      if (agent === session.agent) return this.missing(r, '备用代理与当前主用相同，请调整项目设置', ownerRun)
      if (!installed.some(a => a.id === agent)) return this.missing(r, `当前工作区未启用备用代理 ${agent}`, ownerRun)
      const run = await this.runtime.runBinding(r.runId).catch(() => undefined)
      const saved = r.mainAgentHandle
      if (!run || !Number.isSafeInteger(run.generation) || (run.owner !== session.handle && !(run.owner === null && chat(session.handle) && saved === session.handle))) {
        return this.missing(r, run ? 'Run 归属与已绑定的主会话不符' : '无法读取已绑定的 Run', ownerRun)
      }
      const cycle = randomUUID()
      await this.updateBinding(r, row => {
        if ('ref' in row) { row.mainSession = session; row.mainAgentHandle = session.handle }
        else row.session = session
        row.backup = { primary: session.handle, agent, cycle, phase: 'opening', since: now, history: b?.history ?? [], ...(b?.notified ? { notified: b.notified } : {}), generation: run.generation }
      })
      let handle: string | undefined
      try {
        handle = await this.runtime.launchMain(session.workspace, agent, `你是「${label(r)}」主会话的备用。平时待命；收到接管通知后先读插件记录。`, options)
      } catch { /* The launch may have reached Orca. Preserve the claim. */ }
      await this.mutate(id, row => {
        if (row.backup?.cycle !== cycle) return
        if (handle && handle !== row.backup.primary) { row.backup.handle = handle; row.backup.phase = 'standby'; delete row.backup.notified }
        else this.launchFailure(row, ownerRun)
      })
      this.changed(id)
      return
    }
    if (!b) return
    if ((!b.contact || this.routes[b.contact.id]?.closed) && backupInCharge(b)) {
      await this.updateBinding(r, row => { row.backup!.contact = { id: randomUUID(), projectId: id, workspace: session.workspace, primary: b.primary } })
      this.changed(id)
      return
    }
    if (b.credential && (b.phase === 'taking' || b.phase === 'returning')) {
      const target = b.phase === 'taking' ? b.handle : b.primary
      const run = await this.runtime.runBinding(r.runId)
      if (target && chat(target) && run.owner === null && b.generation !== undefined && run.generation > b.generation && b.receiptGeneration !== run.generation) {
        await this.updateBinding(r, row => {
          row.backup!.receiptGeneration = run.generation
          queue(row).push({ id: 'lead-recheck:' + b.cycle + ':' + run.generation, subject: '请确认 Run 接手回执',
            body: '如在本会话执行过最近一次接管或交回命令，请重新执行原命令，核对本会话的 Run 回执。', targetRunId: r.runId, state: 'pending' })
        })
        this.changed(id)
        return
      }
      if (target && run.owner === target && Number.isSafeInteger(run.generation)) {
        await this.updateBinding(r, row => this.finishTransfer(row, ownerRun, run.generation))
        this.changed(id)
        return
      }
    }
    if (b.phase === 'opening') {
      await this.updateBinding(r, row => this.launchFailure(row, ownerRun))
    } else if (b.phase === 'failed') {
      if (!ownerRun || !b.problem || b.notified?.includes(b.problem)) return
      await this.updateBinding(r, row => this.launchFailure(row, ownerRun))
    }
    else {
      let standby = leadState(inventory, workspace, b.handle)
      let observed = inventory
      if (live.online === 'unknown' || b.handle && standby.online === 'unknown') {
        const fresh = await recheck()
        if (fresh) {
          observed = fresh
          live = leadState(fresh, workspace, handle, inventory)
          standby = leadState(fresh, workspace, b.handle, inventory)
        }
      }
      const confirmedAt = b.confirmedAt
      if (confirmedAt !== undefined) pending = pending?.filter(p => p.at > confirmedAt)
      const oldest = pending?.length ? Math.min(...pending.map(p => p.at)) : undefined
      const since = oldest === undefined || !b.consumed ? oldest : Math.max(oldest, b.since)
      const waitingForStandby = b.phase === 'taking' || b.phase === 'handoff' ? b.since : oldest && Math.max(oldest, b.since)
      const primaryInCharge = b.phase === 'standby' || b.phase === 'probing'
      const expired = b.phase === 'probing' && b.lastProbe !== undefined && now - b.lastProbe >= probeWait
      const stillWaiting = oldest !== undefined && b.lastProbe !== undefined && oldest <= b.lastProbe
      let reason = stopped(live, since, now)
      if (primaryInCharge && reason && standby.online === 'online' &&
        (b.phase === 'standby' || live.online === 'offline' || expired && stillWaiting)) {
        const fresh = await this.runtime.targets().catch(() => undefined)
        live = leadState(fresh, workspace, handle, observed)
        standby = leadState(fresh, workspace, b.handle, observed)
        reason = stopped(live, since, now)
      }
      const backupReason = stopped(standby, primaryInCharge ? undefined : waitingForStandby, now)
      const uncertain = queue(r).some(d => d.control && awaitingLeadControl(b, d.control) && d.state === 'uncertain')
      const route = b.contact && this.routes[b.contact.id]
      // An unreadable inbox cannot confirm that a nonworking session cleared its backlog.
      const pendingUnknown = pending === undefined
      const holdingAlert = b.problem === bothStopped &&
        (reason || live.online === 'unknown' || pendingUnknown && live.state !== 'working') &&
        (backupReason || standby.online === 'unknown' || pendingUnknown && !primaryInCharge && waitingForStandby === undefined && standby.state !== 'working')
      const problem = holdingAlert ? bothStopped : route?.error ? '主用联络未就绪：' + route.error
        : reason && backupReason ? bothStopped : uncertain ? '接管通知送达待核对，请查看目标会话' : undefined
      const missing = live.online === 'offline'
      if (b.phase === 'standby' && !missing && reason && standby.online === 'online') {
        await this.updateBinding(r, row => {
          const b = row.backup!
          b.phase = 'probing'; b.cycle = randomUUID(); delete b.lastProbe; delete b.problem
          control(row, 'ready', '如能继续处理，请在 10 分钟内确认。')
        })
      } else if (primaryInCharge && reason && standby.online === 'online' &&
        (missing || expired && stillWaiting)) {
        const cause = missing ? reason : reason + '，主用探测已超过 10 分钟未确认'
        await this.updateBinding(r, row => {
          const b = row.backup!
          b.phase = 'taking'; b.since = now; b.cycle = randomUUID(); delete b.problem
          control(row, 'take', `${cause}。先用 ${id ? 'read ' + id : 'overview --brief'} 读插件记录，接管后核对原 Run 收件箱。待处理：${pending ? pending.slice(0, 12).map(p => p.title.slice(0, 120)).join('、') || '暂无' : '收件箱待核对'}。进行中的任务和执行者：${context || '暂无已登记任务'}。`)
          b.history.push({ at: now, text: `请求 ${b.handle} 接管：${cause}` })
        })
      } else if (expired && live.online === 'online' && pending && !stillWaiting) {
        await this.updateBinding(r, row => { row.backup!.phase = 'standby'; delete row.backup!.credential })
      } else if (b.phase === 'active' && (!b.contact || route?.dispatch) && now - (b.lastProbe ?? b.since) >= hour && live?.online === 'online' &&
        !queue(r).some(d => d.control?.cycle === b.cycle && d.control.action === 'ready' && (d.state === 'pending' || d.state === 'sending'))) {
        await this.updateBinding(r, row => { row.backup!.lastProbe = now; control(row, 'ready', '额度已恢复请确认。') })
      } else if (problem !== b.problem) {
        await this.updateBinding(r, row => {
          if (problem) { row.backup!.problem = problem; record(row, problem, ownerRun) }
          else delete row.backup!.problem
        })
      } else return
    }
    this.changed(id)
  }

  async saveQuota(run: string, quota: NonNullable<Workspace['botQuota']>) {
    await this.store.mutateWorkspace(w => {
      if (w.runId !== run || !w.bot || w.session?.handle !== quota.home) return
      w.botQuota = quota
    })
  }

  private async stopBot(w: Workspace, reason: string, name = w.bot?.name || w.bot?.id, startUnconfirmed = false) {
    const swap = w.botSwitch && (await this.store.workspace()).botSwitch
    const keepReceipt = !!swap?.recipient && swap.cycle === w.botSwitch?.cycle && await this.runtime.runBinding(w.runId)
      .then(run => run.owner === swap.recipient || run.generation !== swap.generation).catch(() => true)
    await this.store.mutateWorkspace(row => {
      if (!row.bot || row.bot.id !== w.bot?.id || row.runId !== w.runId || row.session?.handle !== w.session?.handle ||
        row.botSwitch?.cycle !== w.botSwitch?.cycle || (!row.botSwitch && row.botQuota?.home !== w.botQuota?.home) || row.botStopped || !available(row)) return
      if (!keepReceipt && !startUnconfirmed) delete row.botSwitch
      row.botStopped = true
      const quota = row.botQuota && w.botSwitch?.manual ? '当前 bot 对话已用完额度。' : ''
      ownerAlert(row, `${quota}${reason}。工作间已暂停自动处理，等待主人。` +
        (keepReceipt ? '请在接收会话重新确认原 Run 回执。' : `请在工作间主 agent 面板为 ${name} 选择可用代理，或切回普通会话。`))
    })
    this.changed('')
  }

  async chooseBotAgent(w: Workspace, botId: string, agent: string) {
    if (!w.bot || w.bot.id !== botId || !w.session || pendingBotSwitch(w) || !available(w)) fail('请等当前工作间接管结束')
    if (agent === w.session.agent && !w.botStopped) fail('该代理已负责此工作间')
    const bot = await this.runtime.bots?.find(botId)
    if (!bot || bot.paused) fail('所选 bot 不可用')
    await this.switchBot(w, bot, Date.now(), agent, false, true)
  }

  private async switchBot(w: Workspace, bot: BotTarget, now: number, selected?: string, returning = false, manual = false) {
    const api = this.runtime.bots!
    const oldHome = w.session!.handle
    const token = randomBytes(32).toString('base64url'), cycle = randomUUID()
    let claimed: Workspace | undefined
    let started = false
    try {
      const choices = await api.choices(bot)
      const primary = w.session!.agent, preferred = primary === 'codex' ? 'claude' : 'codex'
      const agent = selected ?? (choices.includes(preferred) ? preferred : choices.find(a => a !== primary))
      if (!agent || !choices.includes(agent)) fail('该 bot 没有可切换的代理')
      const run = await this.runtime.runBinding(w.runId)
      if (!Number.isSafeInteger(run.generation) || run.owner !== null && run.owner !== oldHome) fail('Run 归属已变化，请先核对协调者')
      claimed = await this.store.mutateWorkspace(row => {
        if (!manual && !returning) {
          row.originalBot ??= { agent: primary }
          row.bot!.reason = primary + ' 额度已用完'
          if (row.botQuota?.recoveryAt) row.bot!.recoveryAt = row.botQuota.recoveryAt
          else delete row.bot!.recoveryAt
        }
        row.botSwitch = { cycle, until: now + probeWait, oldHome, agent, returning, side: true, ...(manual ? { manual: true } : {}), credential: fingerprint(token), generation: run.generation }
        if (!manual) delete row.bot!.result
        delete row.botStopped
      }, w.revision)
      const next = await api.startChat(bot, agent)
      if (!botHomeHandle(next) || next === oldHome) fail('收件地址未切换')
      started = true
      const latest = await this.store.mutateWorkspace(row => {
        if (row.botSwitch?.cycle === cycle && !row.botStopped && available(row)) row.botSwitch.recipient = next
      })
      if (latest.botSwitch?.cycle !== cycle || latest.botSwitch.recipient !== next || latest.botStopped || !available(latest)) return
      const prompt = `请接回工作间协调 Run，完成后读 overview。一次性命令：\nnode ${JSON.stringify(promptClientPath())} lead-take ${w.runId} ${token}`
      const { recipient, quota } = await this.runtime.botMail!(next, '接回工作间协调 Run', prompt, 'handoff')
      if (quota) return this.stopBot(claimed, '新主对话也停在额度上限', bot.name)
      if (recipient !== next) fail('未确认 bot 对话的收件地址')
      this.changed('')
    } catch (error) {
      const rejected = !started && error instanceof BotStartRejected
      if (manual && rejected && claimed && !w.botStopped && !w.botQuota && await this.keepBotAfterFailedSwitch(claimed, bot)) throw error
      if (claimed) {
        const startUnconfirmed = manual && !started && !rejected
        await this.stopBot(claimed, startUnconfirmed ? '请在 Orca 核对 bot 对话的启动回执' : 'bot 切换失败或回执无法核对', bot.name, startUnconfirmed)
      }
      else if (manual) throw error
      else if ((await this.store.workspace()).revision === w.revision) await this.stopBot(w, '切换失败：' + (error as Error).message, bot.name)
    }
  }

  private async keepBotAfterFailedSwitch(claimed: Workspace, bot: BotTarget) {
    const session = claimed.session!, api = this.runtime.bots!
    let kept = false
    await this.store.mutateWorkspace(async row => {
      const swap = row.botSwitch
      if (!swap || swap.cycle !== claimed.botSwitch?.cycle || swap.recipient || row.botStopped || row.botQuota || !available(row) ||
        row.runId !== claimed.runId || row.session?.handle !== session.handle || row.bot?.id !== bot.id) return
      try {
        const current = await api.find(bot.id)
        if (!current || current.paused || !(row.bot.side ? await api.hasSideChat(current, session.handle) : await api.home(current) === session.handle)) return
        const { sessions } = await this.runtime.targets()
        if (!sessions.some(s => s.handle === session.handle && s.workspace === session.workspace && s.agent === session.agent && s.online === 'online')) return
        const run = await this.runtime.runBinding(row.runId)
        if (run.owner !== session.handle || run.generation !== swap.generation) return
        delete row.botSwitch; kept = true
      } catch { /* Unverified state follows the normal pause path. */ }
    })
    if (kept) this.changed('')
    return kept
  }

  private finishTransfer(row: Binding, ownerRun: string, generation: number) {
    const b = row.backup!, took = b.phase === 'taking'
    b.consumed = b.credential; delete b.credential; delete b.problem; delete b.lastProbe
    if (took) {
      const workspace = 'ref' in row ? row.mainSession?.workspace ?? row.ref.workspace : row.session?.workspace
      if (workspace) b.contact = { id: randomUUID(), projectId: key(row), workspace, primary: b.primary }
    } else delete b.contact
    delete b.receiptGeneration
    b.generation = generation
    b.phase = took ? 'active' : 'standby'; b.since = Date.now()
    record(row, took ? `${b.handle} 已接管 ${b.primary} 的 Run` : `${b.handle} 已交回，${b.primary} 继续处理`, ownerRun)
  }

  private launchFailure(r: Binding, ownerRun: string) {
    const b = r.backup!, reason = '备用启动回执未确认，请核对工作区会话'
    b.phase = 'failed'; b.problem = reason
    if (ownerRun && !b.notified?.includes(reason)) {
      (b.notified ??= []).push(reason)
      record(r, '没有备用：' + reason, ownerRun)
    } else if (!b.history.some(e => e.text === '没有备用：' + reason)) record(r, '没有备用：' + reason, '')
  }

  // Tokens exist in the addressed session only. A queued prompt contains no reusable credential.
  async send(id: string, d: Delivery): Promise<{ requestId?: string }> {
    if (id) await this.visible(id)
    const c = d.control!, token = randomBytes(32).toString('base64url')
    let body: string | undefined, probing = false, target = c.handle
    await this.mutate(id, r => {
      const b = r.backup
      if (!available(r) || !b || !awaitingLeadControl(b, c) || r.runId !== d.targetRunId) return
      if (!id && !workspaceBackupInFlight(b)) return
      target = this.controlTarget(b, c) || fail('主用的联络 Dispatch 尚未就绪')
      b.credential = fingerprint(token)
      probing = b.phase === 'probing'
      if (c.action === 'ready' && !probing) b.lastProbe = Date.now()
      const command = `node ${JSON.stringify(promptClientPath())} lead-${c.action} ${r.runId} ${token}`
      body = d.body + '\n' + command + (c.action === 'handoff' ? ' "已做事项和剩余工作"' : '')
    })
    if (body) await this.runtime.requestTakeover(target, body, d.subject)
    // Start the grace period only after Orca acknowledges delivery.
    if (probing) await this.mutate(id, r => {
      if (r.backup?.cycle === c.cycle && r.backup.phase === 'probing') r.backup.lastProbe = Date.now()
    })
    return {}
  }

  async command(input: { runId: string; action: LeadAction; caller: string; token: string; confirm?: boolean; currentRunId?: string; generation?: number; standbyRunId?: string; note?: string }) {
    const { runId, caller, action } = input, hash = fingerprint(text(input.token, '凭据', 128))
    if (!Object.hasOwn(expectedPhases, action)) fail('接管命令无效')
    const workspace = await this.store.workspace()
    const roles = [workspace, ...await this.store.all()]
    const r = roles.find(row => row.runId === runId)
    if (!r || !runId) fail('已解除绑定')
    const id = key(r)
    if (id) await this.visible(id)
    const b = r.backup
    const swap = !('ref' in r) && r.botSwitch || undefined
    const botTake = !!swap && action === 'take' && caller === swap.recipient && hash === swap.credential
    if (!available(r)) fail('调用会话与当前绑定不符')
    if (roles.some(other => other !== r && other.runId && (('ref' in other ? other.mainAgentHandle : other.session?.handle) === caller || other.backup?.handle === caller))) fail('此会话同时绑定其他角色，请先核对')
    if (!('ref' in r) && r.bot) {
      if (!swap && action === 'take' && r.session?.handle === caller && r.botReceipt?.consumed === hash) return { done: true }
      if (!botTake) fail('调用会话与当前绑定不符')
    } else {
      if (!b || caller !== (action === 'take' || action === 'handoff' ? b.handle : b.primary)) fail('调用会话与当前绑定不符')
      if (b.consumed === hash) return { done: true }
      if (!id && !workspaceBackupInFlight(b)) fail('工作间备用已停用')
      if (!expectedPhases[action].includes(b.phase) || hash !== b.credential) fail('凭据已失效')
    }
    let homeSession: AgentSession | undefined
    if (botTake) {
      const current = await this.runtime.bots!.find(workspace.bot!.id)
      const api = this.runtime.bots!
      if (!current || current.paused || caller === swap!.oldHome || !(swap!.side ? await api.hasSideChat(current, caller)
        : current.agent === swap!.agent && await api.home(current) === caller)) fail('收件地址不是新的 bot 对话')
      homeSession = (await this.runtime.targets()).sessions.find(s => s.handle === caller && s.agent === swap!.agent && s.workspace === workspace.session!.workspace && s.online === 'online')
      if (!homeSession) fail('新主对话尚未就绪')
    }
    let transferGeneration: number | undefined
    if (action === 'take' || action === 'resume') {
      const { owner, generation } = await this.runtime.runBinding(runId)
      if (!Number.isSafeInteger(generation)) fail('Run 接管回执缺少代次')
      const previous = swap ? swap.oldHome : action === 'take' ? b!.primary : b!.handle
      const baseline = swap?.generation ?? b?.generation
      if (swap && (workspace.botStopped || Date.now() >= swap.until) && (generation <= swap.generation || owner !== caller && !input.confirm)) fail('接管已暂停，请核对已执行的 Run 回执')
      if (owner !== caller) {
        if (input.confirm) {
          // A chat supplies its own run-current receipt. run-show independently corroborates its generation.
          if (owner !== null || !chat(caller) || input.currentRunId !== runId ||
            input.generation !== generation || (baseline !== undefined && generation <= baseline)) fail('Run 接管回执不符')
        } else {
          if (owner === null && chat(caller) && baseline !== undefined && baseline !== generation) return { checkRun: runId }
          if (owner !== previous && !(owner === null && chat(previous))) fail('Run 协调者不符，请核对后继续')
          return { useRun: runId }
        }
      }
      transferGeneration = generation
    }
    if (action === 'handoff' && chat(caller) && (await this.runtime.runBinding(runId)).owner === null) {
      // The old coordinator's address keeps redirecting to the business Run after handback.
      // A separate standby inbox keeps the next takeover prompt reachable.
      const objective = 'AgentBoat 备用待命 ' + b!.cycle
      if (!input.standbyRunId) return { park: objective }
      const parked = await this.runtime.runBinding(input.standbyRunId)
      if (input.standbyRunId === runId || parked.owner !== null || parked.objective !== objective || parked.generation !== 1) fail('备用待命 Run 不符')
    } else if (input.standbyRunId) fail('此步骤不接受备用待命 Run')
    await this.mutate(id, row => {
      const b = row.backup!
      if (homeSession && swap && !('ref' in row) && transferGeneration !== undefined) {
        row.session = homeSession
        if (swap.side) row.bot!.side = true
        row.botReceipt = { consumed: hash, confirmedAt: Date.now() }
        delete row.botSwitch; delete row.botStopped; delete row.botQuota
        const result = (swap.returning ? '已切回 ' : '已切换至 ') + swap.agent + '，bot 对话已接管 Run。'
        const recovery = row.bot!.recoveryAt
        ownerAlert(row, result + (swap.manual || swap.returning ? '' : recovery ? `预计 ${new Date(recovery).toLocaleString()} 恢复，空闲时自动切回。` : '恢复时间未知，可在额度恢复后从面板切回。'))
        if (swap.manual || swap.returning) { delete row.originalBot; delete row.bot!.reason; delete row.bot!.recoveryAt }
        return
      }
      if (transferGeneration !== undefined) return this.finishTransfer(row, workspace.runId, transferGeneration)
      delete b.credential; b.consumed = hash; b.since = Date.now(); delete b.problem
      if (action === 'ready') {
        b.confirmedAt = b.since
        if (b.phase === 'probing') { b.phase = 'standby'; delete b.lastProbe; return }
        b.phase = 'handoff'; control(row, 'handoff', '主用已确认恢复，请提交交接说明后待命。')
      } else if (action === 'handoff') {
        if (input.standbyRunId) b.standbyRunId = input.standbyRunId
        const note = text(input.note, '交接说明', 4000)
        b.phase = 'returning'
        control(row, 'resume', '备用的交接说明：\n' + note + '\n接回后继续处理。')
      }
    }, r.revision)
    this.changed(id)
    return { done: true }
  }
}

export function backupView(b?: BackupLead) {
  if (!b) return
  const { credential, consumed, notified, ...view } = b
  return view
}
