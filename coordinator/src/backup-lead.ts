import { randomBytes, randomUUID } from 'node:crypto'
import { backupDefaults } from '../../workspace/agent-launch.mjs'
import { clientPath } from '../scripts/orca-cli.mjs'
import type { AgentSession, BackupLead, Delivery, LeadAction, Project, Workspace } from './model'
import type { CoordinatorRuntime } from './runtime'
import { fail, fingerprint, ProjectStore, takeoverActive, text } from './store'

const hour = 3600_000
const probeWait = 10 * 60_000
type Binding = Project | Workspace
const key = (r: Binding) => 'ref' in r ? r.ref.id : ''
const queue = (r: Binding) => 'ref' in r ? r.deliveries : r.retired ??= []
const label = (r: Binding) => 'ref' in r ? r.ref.name : '工作间'
const available = (r: Binding) => !('ref' in r && r.hidden) && !takeoverActive(r.takeover)
const expectedPhases: Record<LeadAction, BackupLead['phase'][]> = {
  take: ['taking'], ready: ['probing', 'active'], handoff: ['handoff'], resume: ['returning']
}
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
  constructor(private store: ProjectStore, private runtime: CoordinatorRuntime, private visible: (id: string) => Promise<unknown>,
    private changed: (id: string) => void) {}

  private mutate(id: string, update: (r: Binding) => void, revision?: number) {
    return id ? this.store.mutate(id, revision, update) : this.store.mutateWorkspace(update, revision)
  }

  async inspect(r: Binding, session: AgentSession, inventory: Awaited<ReturnType<CoordinatorRuntime['targets']>>,
    pending: { at: number; title: string }[], context: string, ownerRun: string, now = Date.now()) {
    if (!available(r) || !r.runId) return
    const id = key(r), b = r.backup
    const live = inventory.sessions.find(s => s.handle === session.handle && s.workspace === session.workspace)
    if (!b) {
      if (!session.agent || !inventory.workspaces.some(w => w.workspace === session.workspace) || await this.runtime.runOwner(r.runId) !== session.handle) return
      const { agent, ...options } = backupDefaults(session.agent)
      const cycle = randomUUID()
      await this.mutate(id, row => {
        if ('ref' in row) { row.mainSession = session; row.mainAgentHandle = session.handle }
        else row.session = session
        row.backup = { primary: session.handle, agent, cycle, phase: 'opening', since: now, history: [] }
      }, r.revision)
      let handle: string | undefined
      try {
        handle = await this.runtime.launchMain(session.workspace, agent, `你是「${label(r)}」主会话的备用。平时待命；收到接管通知后先读插件记录。`, options)
      } catch { /* The launch may have reached Orca. Preserve the claim. */ }
      await this.mutate(id, row => {
        if (row.backup?.cycle !== cycle) return
        if (handle) { row.backup.handle = handle; row.backup.phase = 'standby' }
        else this.launchFailure(row, ownerRun)
      })
      this.changed(id)
      return
    }
    if (b.credential && (b.phase === 'taking' || b.phase === 'returning')) {
      const target = b.phase === 'taking' ? b.handle : b.primary
      if (target && await this.runtime.runOwner(r.runId) === target) {
        await this.mutate(id, row => this.finishTransfer(row, ownerRun), r.revision)
        this.changed(id)
        return
      }
    }
    if (b.phase === 'opening') {
      await this.mutate(id, row => this.launchFailure(row, ownerRun), r.revision)
    } else if (b.phase === 'failed') return
    else {
      const standby = inventory.sessions.find(s => s.handle === b.handle && s.workspace === session.workspace)
      const confirmedAt = b.confirmedAt
      if (confirmedAt !== undefined) pending = pending.filter(p => p.at > confirmedAt)
      const oldest = pending.length ? Math.min(...pending.map(p => p.at)) : undefined
      const reason = stopped(live, oldest === undefined || !b.consumed ? oldest : Math.max(oldest, b.since), now)
      const waitingForStandby = b.phase === 'taking' || b.phase === 'handoff' ? b.since : oldest && Math.max(oldest, b.since)
      const primaryInCharge = b.phase === 'standby' || b.phase === 'probing'
      const backupReason = stopped(standby, primaryInCharge ? undefined : waitingForStandby, now)
      const uncertain = queue(r).some(d => d.control?.cycle === b.cycle && d.state === 'uncertain' && expectedPhases[d.control.action].includes(b.phase))
      const problem = reason && backupReason ? '主用和备用均停住，请主人核对会话' : uncertain ? '接管通知送达待核对，请查看目标会话' : undefined
      const missing = offline(live)
      const expired = b.phase === 'probing' && b.lastProbe !== undefined && now - b.lastProbe >= probeWait
      const stillWaiting = oldest !== undefined && b.lastProbe !== undefined && oldest <= b.lastProbe
      if (b.phase === 'standby' && !missing && reason && standby?.online === 'online') {
        await this.mutate(id, row => {
          const b = row.backup!
          b.phase = 'probing'; b.cycle = randomUUID(); delete b.lastProbe; delete b.problem
          control(row, 'ready', '如能继续处理，请在 10 分钟内确认。')
        }, r.revision)
      } else if (primaryInCharge && reason && standby?.online === 'online' &&
        (missing || expired && stillWaiting)) {
        const cause = missing ? reason : reason + '，主用探测已超过 10 分钟未确认'
        await this.mutate(id, row => {
          const b = row.backup!
          b.phase = 'taking'; b.since = now; b.cycle = randomUUID(); delete b.problem
          control(row, 'take', `${cause}。先用 ${id ? 'read ' + id : 'overview --brief'} 读插件记录，接管后核对原 Run 收件箱。待处理：${pending.slice(0, 12).map(p => p.title).join('、') || '暂无'}。进行中的任务和执行者：${context || '暂无已登记任务'}。`)
          b.history.push({ at: now, text: `请求 ${b.handle} 接管：${cause}` })
        }, r.revision)
      } else if (expired && !missing && !stillWaiting) {
        await this.mutate(id, row => { row.backup!.phase = 'standby'; delete row.backup!.credential }, r.revision)
      } else if (b.phase === 'active' && now - (b.lastProbe ?? b.since) >= hour && live?.online === 'online' &&
        !queue(r).some(d => d.control?.cycle === b.cycle && d.control.action === 'ready' && (d.state === 'pending' || d.state === 'sending'))) {
        await this.mutate(id, row => { row.backup!.lastProbe = now; control(row, 'ready', '额度已恢复请确认。') }, r.revision)
      } else if (problem !== b.problem) {
        await this.mutate(id, row => { row.backup!.problem = problem; if (problem) record(row, problem, ownerRun) }, r.revision)
      } else return
    }
    this.changed(id)
  }

  private finishTransfer(row: Binding, ownerRun: string) {
    const b = row.backup!, took = b.phase === 'taking'
    b.consumed = b.credential; delete b.credential; delete b.problem; delete b.lastProbe
    b.phase = took ? 'active' : 'standby'; b.since = Date.now()
    record(row, took ? `${b.handle} 已接管 ${b.primary} 的 Run` : `${b.handle} 已交回，${b.primary} 继续处理`, ownerRun)
  }

  private launchFailure(r: Binding, ownerRun: string) {
    r.backup!.phase = 'failed'
    r.backup!.problem = '备用启动回执未确认，请核对工作区会话'
    record(r, r.backup!.problem, ownerRun)
  }

  // Tokens exist in the addressed session only. A queued prompt contains no reusable credential.
  async send(id: string, d: Delivery): Promise<{ requestId?: string }> {
    if (id) await this.visible(id)
    const c = d.control!, token = randomBytes(32).toString('base64url')
    let body: string | undefined, probing = false
    await this.mutate(id, r => {
      const b = r.backup
      if (!available(r) || !b || b.cycle !== c.cycle || !expectedPhases[c.action].includes(b.phase) || r.runId !== d.targetRunId) return
      b.credential = fingerprint(token)
      probing = b.phase === 'probing'
      if (c.action === 'ready' && !probing) b.lastProbe = Date.now()
      const command = `node ${JSON.stringify(clientPath)} lead-${c.action} ${r.runId} ${token}`
      body = d.body + '\n' + command + (c.action === 'handoff' ? ' "已做事项和剩余工作"' : '')
    })
    if (body) await this.runtime.requestTakeover(c.handle, body, d.subject)
    // Start the grace period only after Orca acknowledges delivery.
    if (probing) await this.mutate(id, r => {
      if (r.backup?.cycle === c.cycle && r.backup.phase === 'probing') r.backup.lastProbe = Date.now()
    })
    return {}
  }

  async command(input: { runId: string; action: LeadAction; caller: string; token: string; confirm?: boolean; note?: string }) {
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
    if (action === 'take' || action === 'resume') {
      const owner = await this.runtime.runOwner(runId)
      if (owner !== caller) {
        if (input.confirm || owner !== (action === 'take' ? b.primary : b.handle)) fail('Run 协调者不符，请核对后继续')
        return { useRun: runId }
      }
    }
    await this.mutate(id, row => {
      const b = row.backup!
      if (action === 'take' || action === 'resume') return this.finishTransfer(row, workspace.runId)
      delete b.credential; b.consumed = hash; b.since = Date.now(); delete b.problem
      if (action === 'ready') {
        b.confirmedAt = b.since
        if (b.phase === 'probing') { b.phase = 'standby'; delete b.lastProbe; return }
        b.phase = 'handoff'; control(row, 'handoff', '主用已确认恢复，请提交交接说明后待命。')
      } else if (action === 'handoff') {
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
  const { credential, consumed, ...view } = b
  return view
}
