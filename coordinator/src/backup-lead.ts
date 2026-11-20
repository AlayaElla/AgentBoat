import { randomBytes, randomUUID } from 'node:crypto'
import { backupDefaults } from '../../workspace/agent-launch.mjs'
import { promptClientPath } from '../scripts/orca-cli.mjs'
import { awaitingLeadControl, expectedPhases, backupInCharge, type AgentSession, type BackupLead, type ContactRoutes, type Delivery, type LeadAction, type Project, type Workspace } from './model'
import type { CoordinatorRuntime } from './runtime'
import { fail, fingerprint, ProjectStore, takeoverActive, text } from './store'

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
    const live = inventory.sessions.find(s => s.handle === session.handle && s.workspace === session.workspace)
    if (unopened(b)) {
      if (!session.agent) return this.missing(r, '无法识别主会话的 agent 类型', ownerRun)
      const { agent, ...options } = backupDefaults(session.agent)
      const installed = await this.runtime.installedAgents(session.workspace).catch(() => undefined)
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
        handle = await this.runtime.launchMain(session.workspace, agent, `你是「${label(r)}」主会话的备用。平时待命；收到接管通知后先读插件记录。`, options)
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
      const standby = inventory.sessions.find(s => s.handle === b.handle && s.workspace === session.workspace)
      const confirmedAt = b.confirmedAt
      if (confirmedAt !== undefined) pending = pending.filter(p => p.at > confirmedAt)
      const oldest = pending.length ? Math.min(...pending.map(p => p.at)) : undefined
      const reason = stopped(live, oldest === undefined || !b.consumed ? oldest : Math.max(oldest, b.since), now)
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
        const cause = missing ? reason : reason + '，主用探测已超过 10 分钟未确认'
        await this.updateBinding(r, row => {
          const b = row.backup!
          b.phase = 'taking'; b.since = now; b.cycle = randomUUID(); delete b.problem
          control(row, 'take', `${cause}。先用 ${id ? 'read ' + id : 'overview --brief'} 读插件记录，接管后核对原 Run 收件箱。待处理：${pending.slice(0, 12).map(p => p.title.slice(0, 120)).join('、') || '暂无'}。进行中的任务和执行者：${context || '暂无已登记任务'}。`)
          b.history.push({ at: now, text: `请求 ${b.handle} 接管：${cause}` })
        })
      } else if (expired && !missing && !stillWaiting) {
        await this.updateBinding(r, row => { row.backup!.phase = 'standby'; delete row.backup!.credential })
      } else if (b.phase === 'active' && (!b.contact || route?.dispatch) && now - (b.lastProbe ?? b.since) >= hour && live?.online === 'online' &&
        !queue(r).some(d => d.control?.cycle === b.cycle && d.control.action === 'ready' && (d.state === 'pending' || d.state === 'sending'))) {
        await this.updateBinding(r, row => { row.backup!.lastProbe = now; control(row, 'ready', '额度已恢复请确认。') })
      } else if (problem !== b.problem) {
        await this.updateBinding(r, row => { row.backup!.problem = problem; if (problem) record(row, problem, ownerRun) })
      } else return
    }
    this.changed(id)
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
    if (!available(r) || !b || caller !== (action === 'take' || action === 'handoff' ? b.handle : b.primary)) fail('调用会话与当前绑定不符')
    if (roles.some(other => other !== r && other.runId && (('ref' in other ? other.mainAgentHandle : other.session?.handle) === caller || other.backup?.handle === caller))) fail('此会话同时绑定其他角色，请先核对')
    if (b.consumed === hash) return { done: true }
    if (!expectedPhases[action].includes(b.phase) || hash !== b.credential) fail('凭据已失效')
    let transferGeneration: number | undefined
    if (action === 'take' || action === 'resume') {
      const { owner, generation } = await this.runtime.runBinding(runId)
      if (!Number.isSafeInteger(generation)) fail('Run 接管回执缺少代次')
      const previous = action === 'take' ? b.primary : b.handle
      if (owner !== caller) {
        if (input.confirm) {
          // A chat supplies its own run-current receipt. run-show independently corroborates its generation.
          if (owner !== null || !chat(caller) || input.currentRunId !== runId ||
            input.generation !== generation || (b.generation !== undefined && generation <= b.generation)) fail('Run 接管回执不符')
        } else {
          if (owner === null && chat(caller) && b.generation !== undefined && b.generation !== generation) return { checkRun: runId }
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
      if (transferGeneration !== undefined) return this.finishTransfer(row, workspace.runId, transferGeneration)
      delete b.credential; b.consumed = hash; b.since = Date.now(); delete b.problem
      if (action === 'ready') {
        b.confirmedAt = b.since
        if (b.phase === 'probing') { b.phase = 'standby'; delete b.lastProbe; return }
        b.phase = 'handoff'; control(row, 'handoff', '主用已确认恢复，请提交交接说明后待命。')
      } else if (action === 'handoff') {
        if (input.standbyRunId) b.standbyRunId = input.standbyRunId
        const note = text(input.note, '交接说明', 4000)
        b.phase = 'returning'; control(row, 'resume', '备用的交接说明：\n' + note + '\n接回后继续处理。')
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
