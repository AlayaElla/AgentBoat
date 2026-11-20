import { randomBytes, randomUUID } from 'node:crypto'
import { botHomeHandle } from './bot-runtime'
import { backupDefaults } from '../../workspace/agent-launch.mjs'
import { promptClientPath } from '../scripts/orca-cli.mjs'
import { awaitingLeadControl, expectedPhases, backupInCharge, type AgentSession, type BackupLead, type ContactRoutes, type Delivery, type LeadAction, type Project, type Workspace } from './model'
import type { CoordinatorRuntime } from './runtime'
import { fail, fingerprint, ProjectStore, takeoverActive, text } from './store'

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
const offline = (s?: AgentSession) => !s || s.online === 'offline'

export function stopped(session: AgentSession | undefined, pendingSince: number | undefined, now: number) {
  if (offline(session)) return 'Orca 中找不到在线会话'
  if (session?.online === 'online' && ['done', 'blocked', 'waiting'].includes(session.state ?? '') &&
    pendingSince !== undefined && now - pendingSince > 15 * 60_000) return '待处理事项已超过 15 分钟'
}

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
    if (w.botSwitch && now >= w.botSwitch.until && !takeoverActive(w.takeover)) {
      await this.fallback(w, 'bot 切换超时，主对话未接回 Run', now)
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
    return !d.control || !takeoverActive(r.takeover) && !!this.controlTarget(r.backup, d.control)
  }

  async missing(r: Binding, reason: string, ownerRun: string, single = false) {
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
    pending: { at: number; title: string }[], context: string, ownerRun: string, now = Date.now()) {
    if (!available(r) || !r.runId) return
    const id = key(r), b = r.backup
    const w = 'ref' in r ? undefined : r, bot = w?.bot
    let live = inventory.sessions.find(s => s.handle === session.handle && s.workspace === session.workspace)
    let botProblem: string | undefined
    if (w && bot) {
      if (w.botSwitch && await this.inventoryStatus(w, true, now)) return
      const api = this.runtime.bots!
      let current: import('./model').BotTarget | undefined, home: string | undefined
      try {
        current = await api.find(bot.id)
        if (current && !current.paused) home = await api.home(current)
      } catch {
        // A failed read proves neither deletion nor quota exhaustion.
        if (w.botSwitch || !stopped(live, pending.length ? Math.min(...pending.map(p => p.at)) : undefined, now)) return
        botProblem = '无法核对 bot 主对话'
      }

      if (w.botSwitch) {
        if (!current || current.paused || current.agent !== w.botSwitch.agent) await this.fallback(w, 'bot 切换中再次停住', now)
        return
      }
      const currentSession = home && inventory.sessions.find(s => s.handle === home && s.workspace === session.workspace)
      const idle = currentSession && currentSession.online === 'online' && currentSession.state === 'done'
      if (current && home && b?.phase === 'active' && idle &&
        (w.originalBot ? !!bot.recoveryAt && now >= bot.recoveryAt : now - b.since >= hour)) {
        await this.updateBinding(r, row => {
          row.backup!.phase = 'handoff'
          control(row, 'handoff', 'bot 主对话已空闲，请完成手头事项、提交交接说明后待命。')
        })
        this.changed(''); return
      }
      if (w.botHandoff && b?.phase === 'returning') {
        if (!current || !home || current.paused) return this.fallback(w, '交回时 bot 不可用', now)
        if (idle) return this.switchBot(w, current, true, now, home)
        return
      }
      if (b?.phase === 'standby' && current && home && currentSession && currentSession.agent === current.agent && home !== session.handle &&
        (await this.runtime.runBinding(w.runId)).owner === home) {
        await this.updateBinding(w, row => {
          const workspace = row as Workspace
          workspace.session = currentSession; workspace.backup!.primary = home
          delete workspace.botQuota
        })
        this.changed(''); return
      }
      if (!home || home !== session.handle) {
        live = undefined
        botProblem ??= !current ? 'bot 已删除' : current.paused ? 'bot 已暂停' : '已绑定的 bot 主对话不可用'
      }
      if (b && ['standby', 'single', 'unavailable', 'failed'].includes(b.phase) && current && home === session.handle) {
        if (w.botQuota?.home === home && !w.originalBot) return this.switchBot(w, current, false, now)
        if (w.botQuota && w.originalBot) return this.fallback(w, '替换后的 agent 再次用完额度', now)
        if (w.originalBot && current.agent !== w.originalBot.agent && bot.recoveryAt && now >= bot.recoveryAt && live?.online === 'online' && live.state === 'done') return this.switchBot(w, current, true, now)
      }
    }
    const standbyWorkspace = bot?.standbyWorkspace ?? session.workspace
    if (unopened(b)) {
      if (!session.agent) return this.missing(r, '无法识别主会话的 agent 类型', ownerRun)
      const { agent, ...options } = backupDefaults(w?.originalBot?.agent ?? session.agent)
      if (bot && !inventory.workspaces.some(w => w.workspace === standbyWorkspace && w.path === bot.standbyPath && w.path !== session.path)) return this.missing(r, '待命会话的独立工作区不可用', ownerRun)
      const installed = await this.runtime.installedAgents(standbyWorkspace).catch(() => undefined)
      if (!installed) return this.missing(r, '无法读取 Orca 的可启动 agent 列表', ownerRun)
      if (!installed.includes(agent)) {
        if (installed.includes('codex') || installed.includes('claude')) return this.missing(r, '', ownerRun, true)
        return this.missing(r, 'Orca 没有可启动的 Claude 或 Codex', ownerRun)
      }
      const run = await this.runtime.runBinding(r.runId).catch(() => undefined)
      const saved = 'ref' in r ? r.mainAgentHandle : r.session?.handle
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
        handle = await this.runtime.launchMain(standbyWorkspace, agent, `你是「${label(r)}」主会话的备用。平时待命；收到接管通知后先读插件记录。`, options)
      } catch { /* The launch may have reached Orca. Preserve the claim. */ }
      await this.mutate(id, row => {
        if (row.backup?.cycle !== cycle) return
        if (handle) { row.backup.handle = handle; row.backup.phase = 'standby'; delete row.backup.notified }
        else this.launchFailure(row, ownerRun)
      })
      this.changed(id)
      return
    }
    if (!b) return
    if (!bot && (!b.contact || this.routes[b.contact.id]?.closed) && backupInCharge(b)) {
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
      const standby = inventory.sessions.find(s => s.handle === b.handle && s.workspace === standbyWorkspace)
      const confirmedAt = b.confirmedAt
      if (confirmedAt !== undefined) pending = pending.filter(p => p.at > confirmedAt)
      const oldest = pending.length ? Math.min(...pending.map(p => p.at)) : undefined
      const reason = botProblem || stopped(live, oldest === undefined || !b.consumed ? oldest : Math.max(oldest, b.since), now)
      const waitingForStandby = b.phase === 'taking' || b.phase === 'handoff' ? b.since : oldest && Math.max(oldest, b.since)
      const primaryInCharge = b.phase === 'standby' || b.phase === 'probing'
      const backupReason = stopped(standby, primaryInCharge ? undefined : waitingForStandby, now)
      const uncertain = queue(r).some(d => d.control && awaitingLeadControl(b, d.control) && d.state === 'uncertain')
      const route = b.contact && this.routes[b.contact.id]
      const problem = route?.error ? '主用联络未就绪：' + route.error : reason && backupReason ? '主用和备用均停住，请主人核对会话' : uncertain ? '接管通知送达待核对，请查看目标会话' : undefined
      const missing = offline(live)
      const expired = b.phase === 'probing' && b.lastProbe !== undefined && now - b.lastProbe >= probeWait
      const stillWaiting = oldest !== undefined && b.lastProbe !== undefined && oldest <= b.lastProbe
      if (b.phase === 'standby' && !missing && reason && standby?.online === 'online') {
        await this.updateBinding(r, row => {
          const b = row.backup!
          b.phase = 'probing'; b.cycle = randomUUID(); delete b.lastProbe; delete b.problem
          control(row, 'ready', '如能继续处理，请在 10 分钟内确认。')
        })
      } else if (primaryInCharge && reason && standby?.online === 'online' &&
        (missing || expired && stillWaiting)) {
        if (bot && w) return this.fallback(w, reason + '，未确认可切换的额度回执', now)
        const cause = missing ? reason : reason + '，主用探测已超过 10 分钟未确认'
        await this.updateBinding(r, row => {
          const b = row.backup!
          b.phase = 'taking'; b.since = now; b.cycle = randomUUID(); delete b.problem
          control(row, 'take', `${cause}。先用 ${id ? 'read ' + id : 'overview --brief'} 读插件记录，接管后核对原 Run 收件箱。待处理：${pending.slice(0, 12).map(p => p.title.slice(0, 120)).join('、') || '暂无'}。进行中的任务和执行者：${context || '暂无已登记任务'}。`)
          b.history.push({ at: now, text: `请求 ${b.handle} 接管：${cause}` })
        })
      } else if (expired && !missing && !stillWaiting) {
        await this.updateBinding(r, row => { row.backup!.phase = 'standby'; delete row.backup!.credential })
      } else if (!bot && b.phase === 'active' && (!b.contact || route?.dispatch) && now - (b.lastProbe ?? b.since) >= hour && live?.online === 'online' &&
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
      if (w.runId !== run || !w.bot || w.session?.handle !== quota.home || w.botSwitch || w.backup?.phase === 'taking' || backupInCharge(w.backup)) return
      w.botQuota = quota
      if (w.backup?.phase === 'probing') w.backup.phase = 'standby'
    })
  }

  private async fallback(w: Workspace, reason: string, now: number) {
    const run = await this.runtime.runBinding(w.runId).catch(() => undefined)
    await this.store.mutateWorkspace(row => {
      if (row.bot?.id !== w.bot?.id || row.runId !== w.runId || row.botSwitch?.cycle !== w.botSwitch?.cycle || row.backup?.cycle !== w.backup?.cycle || !available(row)) return
      delete row.botHandoff
      delete row.botSwitch; delete row.botQuota
      const b = row.backup!
      if (run && Number.isSafeInteger(run.generation) && (!run.owner || run.owner === w.botSwitch?.recipient || run.owner === b.primary || run.owner === b.handle)) {
        b.generation = run.generation
        if (run.owner) b.previousOwner = run.owner
      }
      row.bot!.reason ??= reason
      if (!b.handle) {
        b.phase = 'failed'; b.problem = '没有可接管的待命会话'
        ownerAlert(row, reason + '。目前没有已确认的接管者，请在面板选择在线会话。'); return
      }
      b.phase = 'taking'; b.cycle = randomUUID(); b.since = now
      control(row, 'take', reason + '。接回原 Run，读取 overview 和 Run 收件箱后继续。')
      const recovery = row.originalBot && !row.bot!.recoveryAt ? '恢复时间未知，额度恢复后请手动设置主 agent。' : ''
      ownerAlert(row, reason + '。正等待 ' + b.agent + ' 待命会话接管，请在面板核对接管结果。' + recovery)
    })
    this.changed('')
  }

  private async switchBot(w: Workspace, bot: import('./model').BotTarget, returning: boolean, now: number, oldHome = w.session!.handle) {
    const api = this.runtime.bots!, original = w.originalBot
    const agent = returning ? original?.agent ?? bot.agent : backupDefaults(bot.agent).agent
    const token = randomBytes(32).toString('base64url'), cycle = randomUUID()
    let claimed: Workspace | undefined
    try {
      const saved = await api.original(bot)
      const run = await this.runtime.runBinding(w.runId)
      const previous = w.botHandoff ? w.backup!.handle : w.session!.handle
      if (!Number.isSafeInteger(run.generation) || run.owner !== null && run.owner !== previous) throw Error('Run 归属已变化')
      claimed = await this.store.mutateWorkspace(row => {
        row.originalBot ??= saved
        if (!returning) {
          row.bot!.reason = bot.agent + ' 额度已用完'
          if (row.botQuota?.recoveryAt) row.bot!.recoveryAt = row.botQuota.recoveryAt
          else delete row.bot!.recoveryAt
        }
        row.botSwitch = { cycle, until: now + probeWait, oldHome, agent, returning, credential: fingerprint(token), generation: run.generation }
        delete row.botQuota
      }, w.revision)
      if (agent === bot.agent) await api.newHome(bot.id)
      else await api.update(bot, agent, returning ? original?.launch : undefined, saved)
      const latest = await this.store.workspace()
      if (latest.botSwitch?.cycle !== cycle || !available(latest)) return
      const prompt = `请接回工作间协调 Run，完成后读 overview。一次性命令：\nnode ${JSON.stringify(promptClientPath())} lead-take ${w.runId} ${token}`
      const { recipient, quota } = await this.runtime.botMail!('bot:' + bot.id, '接回工作间协调 Run', prompt + (w.botHandoff ? '\n待命会话的交接说明：' + w.botHandoff : ''), 'handoff')
      if (quota) throw Error('新主对话也停在额度上限')
      if (!botHomeHandle(recipient) || recipient === oldHome || recipient === w.backup?.handle) throw Error('收件地址未切换')
      await this.store.mutateWorkspace(row => {
        if (row.botSwitch?.cycle === cycle) row.botSwitch.recipient = recipient
      })
      this.changed('')
    } catch {
      if (claimed) await this.fallback(claimed, 'bot 切换失败或回执无法核对', now)
      else if ((await this.store.workspace()).revision === w.revision) await this.fallback(w, 'bot 或 Run 记录无法核对，切换失败', now)
    }
  }

  private finishTransfer(row: Binding, ownerRun: string, generation: number) {
    const b = row.backup!, took = b.phase === 'taking'
    b.consumed = b.credential; delete b.credential; delete b.problem; delete b.lastProbe
    delete b.previousOwner
    if (took && ('ref' in row || !row.bot)) {
      const workspace = 'ref' in row ? row.mainSession?.workspace ?? row.ref.workspace : row.session?.workspace
      if (workspace) b.contact = { id: randomUUID(), projectId: key(row), workspace, primary: b.primary }
    } else delete b.contact
    delete b.receiptGeneration
    b.generation = generation
    b.phase = took ? 'active' : 'standby'; b.since = Date.now()
    record(row, took ? `${b.handle} 已接管 ${b.primary} 的 Run` : `${b.handle} 已交回，${b.primary} 继续处理`, ownerRun)
    if (!('ref' in row) && row.bot) ownerAlert(row, took ? `${row.bot.reason ?? '主用停住'}。现由 ${b.agent} 待命会话接管，请在面板查看主对话。` : `现由 ${row.session?.agent} 主对话管理，无需操作。`)
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
      target = this.controlTarget(b, c) || fail('主用的联络 Dispatch 尚未就绪')
      b.credential = fingerprint(token)
      probing = b.phase === 'probing'
      if (c.action === 'ready' && !probing) b.lastProbe = Date.now()
      const command = `node ${JSON.stringify(promptClientPath())} lead-${c.action} ${r.runId} ${token}`
      body = d.body + '\n' + command + (c.action === 'handoff' ? ' "已做事项和剩余工作"' : '')
    })
    if (body) {
      const w = !id && await this.store.workspace()
      if (w && w.bot && probing) {
        try {
          const receipt = await this.runtime.botMail!(target, d.subject, body, 'handoff', target)
          if (receipt.quota) await this.saveQuota(w.runId, receipt.quota)
        } catch {
          await this.fallback(w, '主对话探测未获回执，原因不明', Date.now())
          throw Error('主对话探测未获回执')
        }
      } else await this.runtime.requestTakeover(target, body, d.subject)
    }
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
    const botTake = !!swap && action === 'take' && caller === swap.recipient && Date.now() < swap.until && hash === swap.credential
    if (r === workspace && workspace.bot && !swap && action === 'take' && b?.primary === caller && b.consumed === hash) return { done: true }
    if (!available(r) || !b || (swap ? !botTake : caller !== (action === 'take' || action === 'handoff' ? b.handle : b.primary))) fail('调用会话与当前绑定不符')
    if (roles.some(other => other !== r && other.runId && (('ref' in other ? other.mainAgentHandle : other.session?.handle) === caller || other.backup?.handle === caller))) fail('此会话同时绑定其他角色，请先核对')
    if (b.consumed === hash) return { done: true }
    if (!botTake && (!expectedPhases[action].includes(b.phase) || hash !== b.credential)) fail('凭据已失效')
    let homeSession: AgentSession | undefined
    if (botTake) {
      const current = await this.runtime.bots!.find(workspace.bot!.id)
      if (!current || current.paused || current.agent !== swap!.agent || caller === swap!.oldHome || await this.runtime.bots!.home(current) !== caller) fail('收件地址不是新的 bot 主对话')
      homeSession = (await this.runtime.targets()).sessions.find(s => s.handle === caller && s.agent === current.agent && s.workspace === workspace.session!.workspace && s.online === 'online')
      if (!homeSession) fail('新主对话尚未就绪')
    }
    let transferGeneration: number | undefined
    if (action === 'take' || action === 'resume') {
      const { owner, generation } = await this.runtime.runBinding(runId)
      if (!Number.isSafeInteger(generation)) fail('Run 接管回执缺少代次')
      const previous = botTake && workspace.botHandoff ? b.handle : action === 'take' ? b.previousOwner ?? b.primary : b.handle
      const baseline = swap?.generation ?? b.generation
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
      const objective = 'AgentBoat 备用待命 ' + b.cycle
      if (!input.standbyRunId) return { park: objective }
      const parked = await this.runtime.runBinding(input.standbyRunId)
      if (input.standbyRunId === runId || parked.owner !== null || parked.objective !== objective || parked.generation !== 1) fail('备用待命 Run 不符')
    } else if (input.standbyRunId) fail('此步骤不接受备用待命 Run')
    await this.mutate(id, row => {
      const b = row.backup!
      if (homeSession && swap && !('ref' in row) && transferGeneration !== undefined) {
        if (Date.now() >= swap.until) fail('接管已超时')
        row.session = homeSession; b.primary = caller; b.phase = b.handle ? 'standby' : 'unavailable'
        b.consumed = hash; b.generation = transferGeneration; b.confirmedAt = Date.now()
        delete b.credential; delete b.lastProbe; delete b.problem; delete row.botSwitch; delete row.botHandoff
        const result = (swap.returning ? '已切回 ' : '已切换至 ') + swap.agent + '，bot 主对话已接管 Run。'
        const recovery = row.bot!.recoveryAt
        ownerAlert(row, result + (swap.returning ? '无需操作。' : recovery ? `预计 ${new Date(recovery).toLocaleString()} 恢复，空闲时自动切回，无需操作。` : '恢复时间未知，请在额度恢复后手动选择主 agent。'))
        b.history.push({ at: Date.now(), text: result })
        if (swap.returning) { delete row.originalBot; delete row.bot!.reason; delete row.bot!.recoveryAt }
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
        if (!('ref' in row) && row.bot) row.botHandoff = note
        else control(row, 'resume', '备用的交接说明：\n' + note + '\n接回后继续处理。')
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
