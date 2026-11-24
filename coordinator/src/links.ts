import { reasonText } from './artifact-errors'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP, type AddressInfo, type LookupFunction } from 'node:net'
import { lookup } from 'node:dns'
import { networkInterfaces } from 'node:os'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import { actingMain, blockedRevision, projectCounts, attention, compareAgentActivity, groupedAttention, isProjectShared, isRecentAgent, labels, mainStatus, mainAgentStates, taskState, type AgentActivity, type AgentsSnapshot, type MainAgentActivity, type Project, type Task, type WorkspaceBinding } from './model'
import { fail, fingerprint, object, revision, strings, text, type FeedbackItem } from './store'
import { LinkMessages, type IncomingMessage, type MessageExchange, type WireMessage } from './link-messages'
import { LinkArtifacts, artifactRef, streamTimeout, type ArtifactExchange, type ArtifactRef } from './link-artifacts'
import { ArtifactStream } from './artifact-stream'
import { LinkFiles } from './link-files'
import { setTimeout as delay } from 'node:timers/promises'
import { validAgentId } from '../../workspace/agent-launch.mjs'

type Scope = 'none' | 'summary' | 'details'
const catalogPollMin = 2_000, catalogPollMax = 8_000
export interface Sharing { scope: Scope; allProjects: boolean; projectIds: string[]; delegateFeedback?: boolean }
export type FeedbackTask = Pick<Task, 'id' | 'title' | 'phase' | 'blockedRevision' | 'blockedStatus'> & {
  decisions: Pick<Task['decisions'][number], 'id' | 'question' | 'options' | 'answer'>[]
  acceptance: Omit<Task['acceptance'][number], 'history'>[]
  artifacts: Task['artifacts']
  goal?: string; progress?: string
}
type DelegatedProject = { revision: number; tasks: FeedbackTask[] }
export interface DelegatedFeedback { projectId: string; revision: number; requestId: string; items: FeedbackItem[] }
export type FeedbackReply = { requestId: string; state: 'submitted' | 'rejected' | 'uncertain'; fingerprint?: string; reason?: string }
type FeedbackExchange = { request?: DelegatedFeedback; reply?: FeedbackReply }
export interface SharedReport {
  workspaceId: string; name: string; scope: Scope; updatedAt: string
  mainAgent?: MainAgentActivity | null
  feedbackTruncated?: true
  projects: { id: string; name: string; updatedAt: string; counts: Record<string, number>; pending: number
    tasks?: { title: string; blockedPending?: boolean; phase: Task['phase']; state: ReturnType<typeof taskState>; decisions: string[]; acceptance: string[] }[]
    activity?: { agents: AgentActivity[]; truncated: boolean } | null; feedback?: DelegatedProject }[]
}
type LocalActivity = { workspace: WorkspaceBinding; live: AgentsSnapshot }
interface Peer extends Sharing { id: string; workspaceId: string; name: string; endpoint: string; state: 'active' | 'pending'; relation?: 'above' | 'below' | 'peer'; sharingSet?: boolean; lastSyncAt?: string }
interface LinkData {
  version: 1; revision: number; workspaceId: string; name: string
  enabled: boolean; host: string; port: number; publicUrl: string; tls: boolean; peers: Peer[]
}
export interface LinksSnapshot extends Omit<LinkData, 'peers'> {
  listening: string; error: string
  peers: (Peer & { status: 'connected' | 'offline' | 'pending'; receivedAt?: string; report?: SharedReport; offlineFeedback?: Pick<SharedReport['projects'][number], 'id' | 'name' | 'feedback'>[] } & Partial<Awaited<ReturnType<LinkMessages['summarize']>>>)[]
  invitation?: { code: string; expiresAt: string }
}
const peerFields = new Set<keyof Peer>(['id', 'workspaceId', 'name', 'endpoint', 'state', 'scope', 'allProjects', 'projectIds', 'delegateFeedback', 'relation', 'sharingSet', 'lastSyncAt'])
const defaults = (): Sharing => ({ scope: 'none', allProjects: false, projectIds: [] })
const secretKey = (id: string) => `workspace-link:${id}`
const id = (v: unknown) => {
  const s = text(v, '工作间编号', 64)
  if (!/^[\w-]+$/.test(s)) fail('工作间编号格式不正确')
  return s
}
const equal = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
const tailscale = new BlockList()
tailscale.addSubnet('100.64.0.0', 10, 'ipv4')
tailscale.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6')
const loopback = new BlockList()
loopback.addSubnet('127.0.0.0', 8, 'ipv4')
loopback.addAddress('::1', 'ipv6')

function httpNetwork(host: string): 'loopback' | 'tailscale' | undefined {
  const address = host.replace(/^\[(.*)\]$/, '$1').toLowerCase().replace(/\.$/, '')
  const version = isIP(address), family = version === 6 ? 'ipv6' : 'ipv4'
  if (address === 'localhost' || version && loopback.check(address, family)) return 'loopback'
  if (address.endsWith('.ts.net') || version && tailscale.check(address, family)) return 'tailscale'
}
export function invitationHost(interfaces = networkInterfaces()): string {
  const addresses = Object.values(interfaces).flat().filter(info => info && !info.internal && httpNetwork(info.address) === 'tailscale')
  return (addresses.find(info => info?.family === 'IPv4') ?? addresses[0])?.address ?? '127.0.0.1'
}
export function endpoint(value: unknown): string {
  let u: URL
  try { u = new URL(text(value, '访问地址', 2048)) } catch { return fail('请填写完整的 HTTP(S) 地址') }
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' ||
    !(u.protocol === 'https:' || u.protocol === 'http:' && httpNetwork(u.hostname))) fail('仅回环或 Tailscale 地址可使用 HTTP，其余地址须使用 HTTPS；地址不能含路径、凭据或参数')
  return u.origin
}
function validateListener(d: Pick<LinkData, 'host' | 'port' | 'publicUrl' | 'tls' | 'enabled'>) {
  if (!isIP(d.host) || d.host === '0.0.0.0' || /^[:0]+$/.test(d.host) || !Number.isInteger(d.port) || d.port < 0 || d.port > 65535) fail('请填写明确的监听 IP 与 0–65535 端口，不能绑定所有地址')
  if (d.publicUrl) endpoint(d.publicUrl)
  if (d.enabled && !httpNetwork(d.host) && (!d.tls || !d.publicUrl.startsWith('https://'))) fail('此监听地址需要 TLS 和 HTTPS 访问地址')
}
function sharing(raw: unknown): Omit<Sharing, 'projectIds'> & { projectIds?: string[] } {
  const r = object(raw)
  if (!['none', 'summary', 'details'].includes(r.scope)) fail('开放范围不正确')
  if (r.allProjects !== undefined && typeof r.allProjects !== 'boolean') fail('全部项目设置不正确')
  if (r.delegateFeedback !== undefined && typeof r.delegateFeedback !== 'boolean' || r.delegateFeedback && r.scope !== 'details') fail('含任务详情时才能允许对方代为处理')
  return { scope: r.scope, allProjects: r.allProjects === true, projectIds: r.projectIds === undefined ? undefined : strings(r.projectIds, '开放的项目'), delegateFeedback: r.delegateFeedback === true }
}
const LIMIT = 180_000
const waitTime = 25_000
type Receipts = Omit<MessageExchange, 'messages'>
const noReceipts: Receipts = { received: [] }
const hasReceipts = (r: Receipts) => !!(r.received.length || r.progress?.length || r.rejected?.length)
const maxPeers = 50, maxProjectAgents = 20, maxReportAgents = 100, maxActivityTitle = 200
const knownAgent = (value: unknown): value is string => value === '' || validAgentId(value)
const publicAgent = (value: string) => knownAgent(value) ? value : ''
const canDelegate = (p: Sharing) => p.scope === 'details' && p.delegateFeedback === true

function delegatedProject(p: Project): DelegatedProject {
  return { revision: p.revision, tasks: p.tasks.flatMap(t => {
    if (t.phase === 'paused') return []
    const decisions = t.decisions.filter(d => d.answer === undefined).map(({ id, question, options }) => ({ id, question, options }))
    const acceptance = t.phase === 'ready' ? t.acceptance.filter(a => a.status === 'pending').map(({ id, title, details, artifactIds, revision, status, fingerprint }) => ({ id, title, details, artifactIds, revision, status, fingerprint })) : []
    const version = blockedRevision(t)
    if (!decisions.length && !acceptance.length && version === undefined) return []
    const ids = new Set(acceptance.flatMap(a => a.artifactIds))
    const artifacts = t.artifacts.filter(a => ids.has(a.id) && !a.expired).map(({ id, label, version, url, registeredAt }) => ({ id, label, version, url: /^https?:\/\//i.test(url) ? url : '', ...(registeredAt && { registeredAt }) }))
    return [{ id: t.id, title: t.title, phase: t.phase, decisions, acceptance, artifacts,
      ...(version !== undefined && { blockedRevision: version, ...(t.blockedStatus && { blockedStatus: t.blockedStatus }), progress: t.progress.trim() || t.goal }) }]
  }) }
}

// The only input is local records and activity, filtered by the same project scope.
export function report(projects: Project[], peer: Sharing, workspaceId: string, name: string, activity?: LocalActivity): SharedReport {
  const details = peer.scope === 'details', allowed = projects.filter(p => isProjectShared(p, peer))
  const result: SharedReport = { workspaceId, name, scope: peer.scope, updatedAt: new Date().toISOString(), projects:
    allowed.map(p => {
      const tasks = p.tasks
      return { id: p.ref.id, name: p.ref.name, updatedAt: p.updatedAt || '', counts: Object.fromEntries(Object.entries(projectCounts(p)).filter(([, count]) => count)),
        pending: groupedAttention(attention(p)).length,
        ...(details ? { activity: null, tasks: tasks.map(t => ({ title: t.title, phase: t.phase, state: taskState(t),
          ...(t.phase === 'blocked' && { blockedPending: blockedRevision(t) !== undefined }),
          decisions: t.decisions.filter(d => d.answer === undefined).map(d => d.question),
          acceptance: t.phase === 'ready' ? t.acceptance.filter(a => a.status === 'pending').map(a => a.title) : [] })) } : {}) }
    }) }
  if (!details) return result
  const workspace = activity?.workspace, session = actingMain(workspace), status = mainStatus(session, activity?.live)
  result.mainAgent = workspace?.runId ? { agent: publicAgent(session?.agent ?? ''), title: (session?.title ?? '').slice(0, maxActivityTitle),
    online: status.state === 'unknown' ? session?.online ?? 'unknown' : status.state === 'offline' ? 'offline' : 'online', activity: status } : null
  if (canDelegate(peer)) {
    let remaining = LIMIT - 2048 - Buffer.byteLength(JSON.stringify(result))
    // shortcut: keep each project's actionable report whole within a sync frame; page it if projects exceed the frame.
    for (const [i, p] of allowed.entries()) {
      const feedback = delegatedProject(p)
      const bytes = Buffer.byteLength(JSON.stringify(feedback)) + 12
      if (bytes > remaining) { result.feedbackTruncated = true; continue }
      result.projects[i].feedback = feedback; remaining -= bytes
    }
  }
  const live = activity?.live
  if (!live?.ok) return result
  for (const p of result.projects) p.activity = { agents: [], truncated: !!live.truncated }
  // Keep additions within the existing sync frame, including unusually long titles.
  let bytes = Math.min(24_000, LIMIT - 2048 - Buffer.byteLength(JSON.stringify(result))), remaining = maxReportAgents
  const now = Date.now()
  const byProject = new Map(allowed.map((p, i) => [p.ref.id, { project: p, activity: result.projects[i].activity! }]))
  const recent = live.agents.filter(a => byProject.has(a.projectId) && isRecentAgent(a, now)).sort(compareAgentActivity)
  for (const a of recent) {
    const { project, activity } = byProject.get(a.projectId)!
    if (!remaining || activity.agents.length >= maxProjectAgents) { activity.truncated = true; continue }
    const taskTitle = a.taskId ? project.tasks.find(t => t.id === a.taskId)?.title : undefined
    const agent: AgentActivity = { agent: publicAgent(a.agent), role: a.role, state: a.state, title: a.title.slice(0, maxActivityTitle), since: a.since,
      ...(taskTitle ? { taskTitle: taskTitle.slice(0, maxActivityTitle) } : {}) }
    const size = Buffer.byteLength(JSON.stringify(agent)) + 1
    if (size > bytes) { activity.truncated = true; continue }
    activity.agents.push(agent); bytes -= size; remaining--
  }
  return result
}
function received(raw: unknown, peer: Peer): SharedReport {
  const r = object(raw)
  if (r.workspaceId !== peer.workspaceId || !['none', 'summary', 'details'].includes(r.scope) || !Array.isArray(r.projects) || r.projects.length > 100 || r.scope === 'none' && r.projects.length) fail('对端上报格式不正确')
  const str = (v: unknown, max = 4000) => typeof v === 'string' && v.length <= max ? v : fail('对端文字格式不正确')
  const titles = (v: unknown) => { if (!Array.isArray(v) || v.length > 100) fail('对端标题格式不正确'); return v.map(x => str(x)) }
  const details = r.scope === 'details'
  let mainAgent: MainAgentActivity | null = null, reportedAgents = 0
  if (details && r.mainAgent !== null) {
    const m = object(r.mainAgent)
    if (!knownAgent(m.agent) || typeof m.online !== 'string' || !Object.hasOwn(mainAgentStates, m.online)) fail('对端主 agent 格式不正确')
    let activity: MainAgentActivity['activity']
    if (m.activity !== undefined) {
      const value = object(m.activity)
      if (value.state === 'work' || value.state === 'need') {
        if (!Number.isSafeInteger(value.since) || value.since <= 0) fail('对端主 agent 时间不正确')
        activity = { state: value.state, since: value.since }
      } else if (['idle', 'offline', 'unknown'].includes(value.state)) activity = { state: value.state }
      else fail('对端主 agent 状态不正确')
    }
    mainAgent = { ...(activity ? { activity } : {}), agent: m.agent, online: m.online as MainAgentActivity['online'], title: str(m.title, maxActivityTitle) }
  }
  if (!details && 'mainAgent' in r || r.feedbackTruncated !== undefined && (!details || r.feedbackTruncated !== true)) fail('对端上报格式不正确')
  return { workspaceId: peer.workspaceId, name: text(r.name, '工作间名称', 200), scope: r.scope, updatedAt: str(r.updatedAt, 100), ...(details ? { mainAgent } : {}), ...(r.feedbackTruncated ? { feedbackTruncated: true } : {}), projects: r.projects.map((raw: unknown) => {
    const p = object(raw), c = object(p.counts), counts: Record<string, number> = {}
    for (const k of Object.keys(labels)) if (c[k] !== undefined) {
      if (!Number.isSafeInteger(c[k]) || c[k] < 0) fail('对端计数不正确'); counts[k] = c[k]
    }
    if (!Number.isSafeInteger(p.pending) || p.pending < 0) fail('对端待处理计数不正确')
    const out: SharedReport['projects'][number] = { id: id(p.id), name: str(p.name, 200), updatedAt: str(p.updatedAt, 100), counts, pending: p.pending }
    if (details) {
      if (!Array.isArray(p.tasks) || p.tasks.length > 1000) fail('对端任务格式不正确')
      out.tasks = p.tasks.map((v: unknown) => {
        const t = object(v), decisions = titles(t.decisions), acceptance = titles(t.acceptance)
        if (!['working', 'ready', 'completed', 'blocked', 'paused'].includes(t.phase) ||
          typeof t.state !== 'string' || !Object.hasOwn(labels, t.state) ||
          t.phase === 'blocked' && typeof t.blockedPending !== 'boolean') fail('对端任务阶段不正确')
        return { title: str(t.title, 200), phase: t.phase, state: t.state as keyof typeof labels, decisions, acceptance,
          ...(t.phase === 'blocked' && { blockedPending: t.blockedPending }) }
      })
      out.activity = null
      if (p.activity !== null) {
        const activity = object(p.activity)
        if (typeof activity.truncated !== 'boolean' || !Array.isArray(activity.agents) || activity.agents.length > maxProjectAgents || (reportedAgents += activity.agents.length) > maxReportAgents) fail('对端 agent 列表格式不正确')
        out.activity = { truncated: activity.truncated, agents: activity.agents.map((raw: unknown) => {
          const a = object(raw)
          if (!knownAgent(a.agent) || !['worker', 'session'].includes(a.role) || !['need', 'work', 'done'].includes(a.state) ||
            !Number.isFinite(a.since) || a.since < 0 || a.since > 8.64e15) fail('对端 agent 状态格式不正确')
          return { agent: a.agent, role: a.role, state: a.state, title: str(a.title, maxActivityTitle), since: a.since,
            ...(a.taskTitle === undefined ? {} : { taskTitle: str(a.taskTitle, maxActivityTitle) }) }
        }) }
      }
      if (p.feedback !== undefined) out.feedback = receivedFeedback(p.feedback)
    } else if ('activity' in p || 'feedback' in p) fail('对端上报格式不正确')
    return out
  }) }
}

function receivedFeedback(raw: unknown): DelegatedProject {
  const r = object(raw)
  const list = (value: unknown, max: number) => Array.isArray(value) && value.length <= max ? value.map(object) : fail('对端待处理列表格式不正确')
  return { revision: revision(r.revision), tasks: list(r.tasks, 1000).map(t => {
    if (!['working', 'ready', 'completed', 'blocked'].includes(t.phase)) fail('对端待处理任务状态不正确')
    if (t.blockedRevision !== undefined && (t.phase !== 'blocked' || t.blockedStatus !== undefined && t.blockedStatus !== 'replied')) fail('对端受阻项格式不正确')
    return { id: text(t.id, '任务编号', 200), title: text(t.title, '任务名称', 200), phase: t.phase,
      ...(t.blockedRevision !== undefined && { blockedRevision: revision(t.blockedRevision), ...(t.blockedStatus && { blockedStatus: t.blockedStatus }), progress: text(t.progress, '受阻说明', 16000) }),
      decisions: list(t.decisions, 100).map(d => ({ id: text(d.id, '决定编号', 200), question: text(d.question, '问题', 4000), options: strings(d.options, '选项', 10).map(x => text(x, '选项', 200)) })),
      acceptance: list(t.acceptance, 100).map(a => {
        if (t.phase !== 'ready' || a.status !== 'pending' || typeof a.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(a.fingerprint)) fail('对端验收格式不正确')
        return { id: text(a.id, '验收编号', 200), title: text(a.title, '验收标题', 200), details: text(a.details, '验收步骤', 8000), artifactIds: strings(a.artifactIds, '成果编号'), revision: revision(a.revision), fingerprint: a.fingerprint, status: 'pending' }
      }),
      artifacts: list(t.artifacts, 1000).map(a => {
        const url = a.url === '' ? '' : text(a.url, '成果链接', 4096)
        if (url && !/^https?:\/\//i.test(url)) fail('对端成果链接格式不正确')
        if (url) new URL(url)
        const registeredAt = a.registeredAt === undefined ? undefined : text(a.registeredAt, '成果登记时间', 100)
        if (registeredAt && !Number.isFinite(Date.parse(registeredAt))) fail('对端成果登记时间不正确')
        return { id: text(a.id, '成果编号', 200), label: text(a.label, '成果名称', 200), version: text(a.version, '成果版本', 200), url, ...(registeredAt && { registeredAt }) }
      }) }
  }) }
}

function feedbackRequest(raw: unknown): DelegatedFeedback {
  const r = object(raw)
  if (!Array.isArray(r.items) || r.items.length > 100) fail('反馈条目格式不正确')
  return { projectId: id(r.projectId), revision: revision(r.revision), requestId: id(r.requestId), items: r.items }
}
function syncPacket(report: SharedReport | undefined, pending: WireMessage[], receipts: Receipts, feedback: FeedbackExchange, id?: string, version?: string) {
  const exchange: MessageExchange = { messages: [], ...receipts }
  const packet = { id, version, artifact: undefined as ArtifactExchange | undefined, report, exchange, feedback: feedback.request || feedback.reply ? feedback : undefined }
  const fits = () => Buffer.byteLength(JSON.stringify(packet)) <= LIMIT
  if (packet.feedback && !fits()) packet.report = undefined
  for (const m of pending) {
    exchange.messages.push(m)
    // Let the oldest message through when a large report would crowd it out.
    if (!fits() && exchange.messages.length === 1) packet.report = undefined
    if (!fits()) { exchange.messages.pop(); break }
  }
  if (hasReceipts(receipts) && !fits()) packet.report = undefined
  return packet
}
function panelChanged(packet: ReturnType<typeof syncPacket>) {
  return !packet.artifact || packet.report || packet.feedback || packet.exchange.messages.length || hasReceipts(packet.exchange)
}
async function jsonBody(stream: AsyncIterable<Buffer>): Promise<any> {
  const chunks: Buffer[] = []; let size = 0
  for await (const c of stream) { size += c.length; if (size > LIMIT) fail('工作间消息过大'); chunks.push(c) }
  return object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
}
// Check the actual destination of a plain HTTP hostname before sending credentials.
const lookupHttpHost: LookupFunction = (host, options, callback) => {
  lookup(host, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '', 0)
    const network = httpNetwork(host)
    const safe = addresses.filter(a => network && httpNetwork(a.address) === network)
    if (!safe.length) return callback(new Error('Invalid HTTP address'), '', 0)
    if (options.all) callback(null, safe)
    else callback(null, safe[0].address, safe[0].family)
  })
}
function connect(url: string, route: string, headers: http.OutgoingHttpHeaders, signal?: AbortSignal) {
  const u = new URL(endpoint(url) + route)
  return (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', rejectUnauthorized: true, signal,
    ...(u.protocol === 'http:' && { agent: false, lookup: lookupHttpHost }), headers })
}
async function call(url: string, route: string, body: unknown, token = '', signal?: AbortSignal): Promise<any> {
  const data = JSON.stringify(body)
  if (Buffer.byteLength(data) > LIMIT) fail('工作间上报过大，请减少开放的项目')
  return new Promise((resolve, reject) => {
    const req = connect(url, route, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
      ...(token && { Authorization: 'Bearer ' + token }) }, signal)
    req.once('response', res => {
      if (res.statusCode !== 200) { res.resume(); reject(Object.assign(new Error(res.statusCode === 401 ? '连接已断开或凭据无效' : '对端未接受请求，请核对连接状态'), { status: res.statusCode })); return }
      void jsonBody(res).then(resolve, () => reject(new Error('对端未返回有效的工作间消息')))
    })
    req.setTimeout(route === '/wait' ? waitTime + 5000 : 5000, () => req.destroy()); req.once('error', () => reject(new Error('无法连接对端，请核对地址和网络'))); req.end(data)
  })
}

export class WorkspaceLinks {
  private stream: ArtifactStream
  private artifacts: LinkArtifacts
  private messages: LinkMessages
  private receipts = new Map<string, Receipts>()
  private originVersion = randomUUID()
  private versions = new Map<string, string>()
  private waiters = new Map<string, (status?: number) => void>()
  private watchers = new Map<string, AbortController>()
  private running = false
  private signaling = false
  private lastReport = new Map<string, number>()
  private recentActivity?: { at: number; result: Promise<LocalActivity> }
  private initial: LinkData = { version: 1, revision: 0, workspaceId: randomUUID(), name: '我的工作间', enabled: false, host: '127.0.0.1', port: 0, publicUrl: '', tls: false, peers: [] }
  private server?: http.Server | https.Server
  private timer?: ReturnType<typeof setInterval>
  private catalogTimer?: ReturnType<typeof setTimeout>
  private catalogDelay = catalogPollMin
  private pollingCatalog = false
  private invitation?: { token: string; expires: number }
  private incoming = new Map<string, { report: SharedReport; receivedAt: string; offline?: boolean }>()
  private feedbackPending = new Map<string, { request: DelegatedFeedback; sent: boolean; finish: (result: FeedbackReply) => void }>()
  private feedbackReplies = new Map<string, FeedbackReply>()
  private chain: Promise<unknown> = Promise.resolve()
  private syncing = new Map<string, Promise<string | undefined>>()
  private listening = ''
  private error = ''
  constructor(private orca: Pick<OrcaWorkerApi, 'storage' | 'secrets'> & Partial<Pick<OrcaWorkerApi, 'log' | 'panels'>>, private projects: () => Promise<Project[]>, private changed: () => void, private chooseHost = invitationHost, private enqueue?: (peer: Peer, messages: IncomingMessage[]) => Promise<void>, private activity?: () => Promise<LocalActivity>, files = new LinkFiles(), private checkCatalog?: () => Promise<unknown>, private applyFeedback?: (peer: Peer, input: DelegatedFeedback) => Promise<string | undefined>) {
    this.messages = new LinkMessages(files)
    this.artifacts = new LinkArtifacts(files, line => orca.log?.(line), progress => orca.panels?.post('workspace.artifactProgress', progress))
    this.stream = new ArtifactStream(this.artifacts, connect, async (peerId, ref) => {
      const peer = (await this.data()).peers.find(p => p.id === peerId && p.state === 'active')
      if (!peer) fail(reasonText('offline'))
      return this.artifactSource(peer, ref)
    })
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const p = this.chain.then(fn); this.chain = p.catch(() => {}); return p }
  private async data(): Promise<LinkData> {
    const raw = await this.orca.storage.get('workspace.links')
    if (raw == null) return structuredClone(this.initial)
    const d = structuredClone(object(raw)) as LinkData
    if (d.version !== 1 || !Array.isArray(d.peers) || d.peers.some(p => !p || Object.keys(p).some(key => !peerFields.has(key as keyof Peer)) || !['active', 'pending'].includes(p.state) || typeof p.allProjects !== 'boolean' || !Array.isArray(p.projectIds) || p.delegateFeedback !== undefined && typeof p.delegateFeedback !== 'boolean')) fail('工作间连接记录不兼容，请保留数据并检查版本')
    return d
  }
  private async save(d: LinkData) { if (Buffer.byteLength(JSON.stringify(d)) > 100_000) fail('连接记录已达上限'); await this.orca.storage.set('workspace.links', d as any) }
  private async recordIncoming(d: LinkData, peer: Peer, report: SharedReport) {
    const receivedAt = new Date().toISOString()
    if (!peer.lastSyncAt || peer.name !== report.name) {
      peer.name = report.name; peer.lastSyncAt = receivedAt; await this.save(d)
    }
    this.incoming.set(peer.id, { report, receivedAt })
  }
  async snapshot(includeMessages = false): Promise<LinksSnapshot> {
    const { d, summaries } = await this.serial(async () => {
      const d = await this.data(); let changed = false
      for (const p of d.peers) {
        const incoming = this.incoming.get(p.id)
        if (incoming && Date.now() - Date.parse(incoming.receivedAt) >= 35_000 && p.lastSyncAt !== incoming.receivedAt) { p.lastSyncAt = incoming.receivedAt; changed = true }
      }
      if (changed) await this.save(d)
      const records = includeMessages ? await this.messages.data() : undefined
      const summaries = records ? await Promise.all(d.peers.map(p => this.messages.summarize(records, p.id))) : []
      return { d, summaries }
    })
    return { ...d, listening: this.listening, error: this.error, peers: d.peers.map((p, i) => {
      const incoming = this.incoming.get(p.id), fresh = incoming && !incoming.offline && Date.now() - Date.parse(incoming.receivedAt) < 35_000
      const offlineFeedback = !fresh && incoming ? incoming.report.projects.filter(p => p.feedback?.tasks.length).map(({ id, name, feedback }) => ({ id, name, feedback })) : []
      return { ...p, status: fresh ? 'connected' : p.state === 'pending' ? 'pending' : 'offline',
        ...(incoming ? { receivedAt: incoming.receivedAt, lastSyncAt: incoming.receivedAt } : {}), ...(p.state === 'active' && fresh ? { report: incoming!.report } : {}),
        ...(offlineFeedback.length ? { offlineFeedback } : {}),
        ...summaries[i] }
    }) }
  }
  async configure(input: Record<string, any>) {
    await this.serial(async () => {
      const d = await this.data()
      if (d.revision !== input.revision) fail('连接设置已更新，请刷新后再保存')
      if (typeof input.enabled !== 'boolean' || typeof input.tls !== 'boolean') fail('监听与 TLS 设置不正确')
      const publicUrl = input.publicUrl ? endpoint(input.publicUrl) : ''
      const next = { ...d, name: input.name === undefined ? d.name : text(input.name, '工作间名称', 200), enabled: input.enabled, host: input.host, port: input.port, publicUrl, tls: input.tls, revision: d.revision + 1 }
      validateListener(next)
      if (input.certificate || input.privateKey) {
        if (!input.certificate || !input.privateKey) fail('请同时填写证书与私钥')
        // Validate before changing either live listener or secret storage.
        https.createServer({ cert: input.certificate, key: input.privateKey }).close()
        await this.orca.secrets.set('workspace-links-tls', JSON.stringify({ cert: input.certificate, key: input.privateKey }))
      }
      if (input.enabled && input.tls && !await this.orca.secrets.get('workspace-links-tls')) fail('请填写 TLS 证书与私钥')
      await this.save(next)
      await this.listen(next)
    })
    this.changed(); return this.snapshot()
  }
  async rename(input: Record<string, any>) {
    const name = text(input.name, '工作间名称', 200)
    await this.serial(async () => {
      const d = await this.data()
      if (d.revision !== input.revision) fail('连接设置已更新，请刷新后再保存')
      if (d.name !== name) await this.save({ ...d, name, revision: d.revision + 1 })
    })
    this.localChanged(); this.changed(); return this.snapshot()
  }
  async start() {
    const d = await this.serial(async () => { const d = await this.data(); await this.listen(d); return d })
    this.running = true
    for (const p of d.peers) this.watch(p)
    clearInterval(this.timer)
    this.timer = setInterval(() => { void this.refresh().catch(() => {}) }, 10_000); this.timer.unref()
    this.catalogDelay = catalogPollMin
    this.scheduleCatalog()
  }
  private scheduleCatalog() {
    clearTimeout(this.catalogTimer)
    if (!this.running || !this.checkCatalog || this.pollingCatalog) return
    // shortcut: Orca has no project catalog event; poll while sharing until one is available.
    this.catalogTimer = setTimeout(async () => {
      this.pollingCatalog = true
      this.catalogDelay = Math.min(this.catalogDelay * 2, catalogPollMax)
      try {
        const d = await this.data()
        if (d.peers.some(p => p.state === 'active' && p.scope !== 'none')) await this.checkCatalog!()
      } catch { /* Check the catalog again on the next poll. */ }
      finally {
        this.pollingCatalog = false
        this.scheduleCatalog()
      }
    }, this.catalogDelay)
    this.catalogTimer.unref()
  }
  private activeCatalog() {
    if (this.catalogDelay === catalogPollMin) return
    this.catalogDelay = catalogPollMin
    this.scheduleCatalog()
  }
  private async listen(d: LinkData) {
    this.closeListener()
    this.error = ''
    if (d.enabled) {
      try {
        validateListener(d)
        const network = d.tls ? undefined : httpNetwork(d.host)
        const serve = (q: http.IncomingMessage, s: http.ServerResponse) => {
          if (network === 'tailscale' && httpNetwork(q.socket.remoteAddress || '') !== network) { s.writeHead(403).end(); return }
          void this.serve(q, s)
        }
        this.server = d.tls ? https.createServer(JSON.parse(await this.orca.secrets.get('workspace-links-tls') || '{}'), serve) : http.createServer(serve)
        this.server.requestTimeout = streamTimeout; this.server.headersTimeout = 5000; this.server.maxConnections = 4 * maxPeers + 16
        await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(d.port, d.host, resolve) })
        this.listening = `${d.tls ? 'https' : 'http'}://${isIP(d.host) === 6 ? `[${d.host}]` : d.host}:${(this.server.address() as AddressInfo).port}`
        this.server.on('error', () => { this.closeListener(); this.error = '监听已停止，请检查地址与端口'; this.changed() })
        this.error = ''
      } catch { this.closeListener(); this.error = '无法监听，请检查地址、端口和 TLS 证书' }
    }
  }
  private closeListener() { this.server?.closeAllConnections(); this.server?.close(); this.server = undefined; this.listening = ''; this.invitation = undefined }
  stop() {
    this.running = false
    this.stream.stop()
    this.artifacts.stop()
    clearInterval(this.timer)
    clearTimeout(this.catalogTimer)
    for (const watcher of this.watchers.values()) watcher.abort()
    this.watchers.clear()
    for (const { request, finish } of this.feedbackPending.values()) finish({ requestId: request.requestId, state: 'uncertain', reason: '连接已停止，请重试核对' })
    this.feedbackReplies.clear()
    this.closeListener()
  }
  async invite() {
    const invitation = await this.serial(async () => {
      const d = await this.data(), enabled = d.enabled
      if (!enabled && d.host === this.initial.host && !d.tls && !d.publicUrl) d.host = this.chooseHost()
      d.enabled = true
      if (!this.listening) await this.listen(d)
      if (!this.listening) fail(this.error || '无法启动工作间连接监听')
      try {
        const url = endpoint(d.publicUrl || this.listening)
        if (!enabled || !d.port || !d.publicUrl) {
          d.port = (this.server!.address() as AddressInfo).port
          d.publicUrl = url
          d.revision++
          await this.save(d)
        }
        this.invitation = { token: randomBytes(32).toString('base64url'), expires: Date.now() + 120_000 }
        return { code: `AB1.${Buffer.from(JSON.stringify({ workspaceId: d.workspaceId, name: d.name, url, token: this.invitation.token })).toString('base64url')}`, expiresAt: new Date(this.invitation.expires).toISOString() }
      } catch (e) { if (!enabled) this.closeListener(); throw e }
    })
    this.changed()
    return { ...await this.snapshot(), invitation }
  }
  async cancelInvite() { await this.serial(async () => { this.invitation = undefined }); return this.snapshot() }
  async join(code: string) {
    let c: Record<string, any>
    try { if (!code.startsWith('AB1.') || code.length > 6000) throw Error(); c = object(JSON.parse(Buffer.from(code.slice(4), 'base64url').toString('utf8'))) } catch { return fail('连接码格式不正确') }
    const url = endpoint(c.url), workspaceId = id(c.workspaceId), name = text(c.name, '对端名称', 200), token = randomBytes(32).toString('base64url'), connectionId = randomUUID()
    text(c.token, '连接码', 100)
    const d = await this.serial(async () => {
      const d = await this.data()
      if (d.workspaceId === workspaceId || d.peers.some(p => p.workspaceId === workspaceId)) fail('工作间已连接或结果待核对，请刷新原连接')
      if (d.peers.length >= maxPeers) fail('连接数量已达上限')
      await this.orca.secrets.set(secretKey(connectionId), token)
      d.peers.push({ id: connectionId, workspaceId, name, endpoint: url, state: 'pending', ...defaults() }); d.revision++; await this.save(d); return d
    })
    try {
      const result = await call(url, '/pair', { invite: c.token, id: connectionId, workspaceId: d.workspaceId, name: d.name, token })
      if (result.workspaceId !== workspaceId) fail('对端身份与连接码不一致')
      await this.serial(async () => {
        const d = await this.data(), p = d.peers.find(p => p.id === connectionId)
        if (p) { p.state = 'active'; d.revision++; await this.save(d) }
      })
      await this.sync(connectionId)
      this.watch({ id: connectionId, endpoint: url })
    } catch { /* Pairing may have succeeded remotely. Refresh the pending connection. */ }
    this.changed(); return this.snapshot()
  }
  async share(input: Record<string, any>) {
    const { projectIds, ...setting } = sharing(input), own = await this.projects()
    await this.serial(async () => {
      const d = await this.data()
      if (input.revision !== d.revision) fail('连接已更新，请刷新后再保存')
      const p = d.peers.find(p => p.id === input.id && p.state === 'active')
      if (!p) fail('请选择有效连接')
      const knownIds = new Set([...p.projectIds, ...own.map(p => p.ref.id)])
      if (projectIds?.some(id => !knownIds.has(id))) fail('只能开放本工作间自己的项目')
      Object.assign(p, setting, { projectIds: projectIds ?? p.projectIds, sharingSet: true }); d.revision++; await this.save(d)
      this.stream.stop(p.id) // In-flight senders must observe the new sharing scope immediately.
    })
    this.wake(input.id); await this.sync(input.id); this.changed(); return this.snapshot()
  }
  async relate(input: Record<string, any>) {
    if (input.relation !== null && !['above', 'below', 'peer'].includes(input.relation)) fail('请选择有效关系')
    await this.serial(async () => {
      const d = await this.data(), p = d.peers.find(p => p.id === input.id && p.state === 'active')
      if (input.revision !== d.revision) fail('连接已更新，请刷新后再保存')
      if (!p) fail('请选择有效连接')
      if (input.relation === null && !p.relation) return
      if (input.relation === null) delete p.relation
      else p.relation = input.relation
      d.revision++; await this.save(d)
    })
    this.changed(); return this.snapshot()
  }
  async revoke(connectionId: string) {
    const p = await this.serial(async () => {
      const d = await this.data(), p = d.peers.find(p => p.id === connectionId)
      if (!p) fail('连接不存在')
      const token = await this.orca.secrets.get(secretKey(p.id))
      await this.removePeer(d, p.id)
      return { ...p, token }
    })
    if (p.endpoint && p.token) { try { await call(p.endpoint, '/revoke', { id: p.id }, p.token) } catch { /* Local authorization is already revoked; offline peers learn on their next sync. */ } }
    this.changed(); return this.snapshot()
  }
  async send(input: Record<string, any>) {
    const connectionId = id(input.id)
    await this.serial(async () => {
      const d = await this.data(), p = d.peers.find(p => p.id === connectionId && p.state === 'active')
      if (!p) fail('请选择有效连接')
      await this.messages.send(p.id, input)
      this.wake(p.id)
    })
    if (this.running) void this.sync(connectionId).catch(() => {})
    else await this.sync(connectionId)
    this.changed(); return this.snapshot(true)
  }
  async openArtifact(connectionId: string, input: ArtifactRef) {
    const ref = artifactRef(input)
    const { result } = await this.serial(async () => {
      const p = (await this.data()).peers.find(p => p.id === connectionId && p.state === 'active')
      if (!p) fail(reasonText('offline'))
      const last = this.incoming.get(p.id)
      if (!last || last.offline || Date.now() - Date.parse(last.receivedAt) >= 35_000) fail('对方离线，暂时无法获取成果')
      const token = await this.orca.secrets.get(secretKey(p.id))
      if (!token) fail(reasonText('offline'))
      const wake = () => {
        this.wake(p.id)
        if (p.endpoint) void this.sync(p.id).catch(() => {})
      }
      return { result: this.artifacts.start(p.id, ref, p.endpoint ? (offer, signal) => this.stream.pull(p, token, offer, signal) : undefined, wake) }
    })
    return result
  }
  async readArtifact(connectionId: string, key: string, offset: number) {
    const peer = (await this.data()).peers.find(p => p.id === connectionId && p.state === 'active')
    if (!peer) fail(reasonText('offline'))
    return this.artifacts.files.readArtifact(peer.id, peer.workspaceId, key, offset)
  }
  private async artifactSource(peer: Peer, ref: ArtifactRef) {
    const project = (await this.projects()).find(p => p.ref.id === ref.projectId)
    if (!project || project.ref.hostId !== 'local' || !canDelegate(peer) || !isProjectShared(project, peer)) fail(reasonText('denied'))
    const artifact = project.tasks.find(t => t.id === ref.taskId)?.artifacts.find(a => a.id === ref.artifactId)
    if (!artifact) fail(reasonText('unregistered'))
    if (artifact.expired) fail(reasonText('expired'))
    if (!delegatedProject(project).tasks.find(t => t.id === ref.taskId)?.artifacts.some(a => a.id === ref.artifactId)) fail(reasonText('withdrawn'))
    if (/^https?:/i.test(artifact.url)) fail(reasonText('web'))
    return { root: project.ref.path, file: artifact.url, version: artifact.version }
  }
  async submitFeedback(connectionId: string, input: unknown): Promise<FeedbackReply> {
    const request = feedbackRequest(input)
    if (Buffer.byteLength(JSON.stringify(request)) > LIMIT - 16_000) return { requestId: request.requestId, state: 'rejected', reason: '反馈内容过长，请减少本次提交内容' }
    const { endpoint, result } = await this.serial(async () => {
      const p = (await this.data()).peers.find(p => p.id === connectionId && p.state === 'active')
      if (!p) fail('连接已断开')
      if (this.feedbackPending.has(p.id)) fail('正在确认上次提交，请稍候')
      // A reconnect can carry the original request even if its item is now finished.
      const incoming = this.incoming.get(p.id)
      if (!incoming || incoming.offline || Date.now() - Date.parse(incoming.receivedAt) >= 35_000) fail('对方离线，暂不能提交')
      const offline: FeedbackReply = { requestId: request.requestId, state: 'uncertain', reason: '连接超时或断开，请重试核对' }
      const result = new Promise<FeedbackReply>(resolve => {
        const finish = (result: FeedbackReply) => { clearTimeout(timer); this.feedbackPending.delete(p.id); resolve(result) }
        // Allow a 10s fallback refresh and two 5s sync legs on a reverse connection.
        const timer = setTimeout(() => finish(offline), 20_000)
        this.feedbackPending.set(p.id, { request, sent: false, finish })
      })
      this.wake(p.id)
      return { endpoint: p.endpoint, result }
    })
    if (endpoint) void this.sync(connectionId).catch(() => {})
    return result
  }
  private async receiveFeedback(p: Peer, raw: unknown) {
    if (raw === undefined) return
    const exchange = object(raw)
    if (exchange.reply !== undefined) {
      const r = object(exchange.reply), pending = this.feedbackPending.get(p.id)
      if (pending && r.requestId === pending.request.requestId && ['submitted', 'rejected', 'uncertain'].includes(r.state)) {
        if (r.state === 'submitted' && r.fingerprint !== fingerprint(pending.request))
          pending.finish({ requestId: r.requestId, state: 'uncertain', reason: '缺少匹配的写入凭证' })
        else pending.finish({ requestId: r.requestId, state: r.state, ...(r.state === 'submitted' ? { fingerprint: r.fingerprint } : {}), ...(typeof r.reason === 'string' ? { reason: r.reason.slice(0, 1000) } : {}) })
      }
    }
    if (exchange.request === undefined) return
    const request = feedbackRequest(exchange.request)
    const requestId = request.requestId
    try {
      if (!canDelegate(p) || !this.applyFeedback) fail('对方未允许代为处理')
      const fingerprint = await this.applyFeedback(p, request)
      if (!fingerprint) throw Error('没有写入凭证')
      return { requestId, state: 'submitted', fingerprint } as const
    } catch (e) {
      if (e instanceof Error && (e as Error & { code?: string }).code === 'invalid_request')
        return { requestId, state: 'rejected', reason: e.message.slice(0, 1000) } as const
      return { requestId, state: 'uncertain', reason: '对端未能确认写入，请重试核对' } as const
    }
  }
  private async removePeer(d: LinkData, connectionId: string) {
    await this.orca.secrets.delete(secretKey(connectionId))
    this.stream.stop(connectionId)
    await this.artifacts.stop(connectionId)
    await this.messages.revoke(connectionId)
    this.waiters.get(connectionId)?.(401)
    this.watchers.get(connectionId)?.abort()
    this.lastReport.delete(connectionId)
    this.versions.delete(connectionId)
    this.receipts.delete(connectionId)
    this.feedbackReplies.delete(connectionId)
    const pending = this.feedbackPending.get(connectionId)
    pending?.finish({ requestId: pending.request.requestId, state: 'uncertain', reason: '连接已断开，请在对方工作间核对' })
    this.incoming.delete(connectionId)
    d.peers = d.peers.filter(p => p.id !== connectionId)
    d.revision++
    await this.save(d)
  }
  private receiveMessages(peer: Peer, exchange: unknown) {
    return this.messages.receive(peer.id, exchange, messages => this.enqueue?.(peer, messages) ?? Promise.resolve(), peer.workspaceId)
  }
  private async localReport(p: Peer, d: LinkData) {
    // Most bulk rounds only carry bytes. Refresh the report periodically on longer transfers.
    if (this.artifacts.hasData(p.id) && Date.now() - (this.lastReport.get(p.id) ?? 0) < 5000) return
    this.lastReport.set(p.id, Date.now())
    let activity: LocalActivity | undefined
    if (p.scope === 'details' && this.activity) {
      if (!this.recentActivity || Date.now() - this.recentActivity.at >= 2000)
        this.recentActivity = { at: Date.now(), result: this.activity() }
      activity = await this.recentActivity.result
    }
    return report(await this.projects(), p, d.workspaceId, d.name, activity)
  }
  private version(peerId: string) { return this.versions.get(peerId) ?? this.originVersion }
  private wake(peerId: string) {
    this.activeCatalog()
    this.versions.set(peerId, randomUUID())
    this.waiters.get(peerId)?.()
  }
  localChanged() {
    this.recentActivity = undefined
    if (!this.running || this.signaling) return
    this.signaling = true
    setImmediate(() => {
      this.signaling = false
      if (!this.running) return
      void this.serial(() => this.data()).then(d => {
        for (const p of d.peers) {
          this.wake(p.id)
          if (p.endpoint) void this.sync(p.id).catch(() => {})
        }
      }).catch(() => {})
    })
  }
  private watch(p: Pick<Peer, 'id' | 'endpoint'>) {
    if (!this.running || !p.endpoint || this.watchers.has(p.id)) return
    const state = new AbortController(), signal = state.signal
    this.watchers.set(p.id, state)
    void (async () => {
      let backoff = 250, pushCount = 0
      let pushing = Promise.resolve()
      while (!signal.aborted) {
        try {
          const version = await this.sync(p.id, signal)
          if (signal.aborted) return
          const token = await this.orca.secrets.get(secretKey(p.id))
          if (!token) return
          if (!version) throw Error()
          const waited = await call(p.endpoint, '/wait', { id: p.id, since: version }, token, signal)
          if (waited.offer && pushCount < 2) {
            // The next open can arrive before the previous push's HTTP acknowledgement.
            pushCount++
            pushing = pushing.then(async () => {
              if (signal.aborted) return
              const peer = (await this.data()).peers.find(peer => peer.id === p.id && peer.state === 'active')
              if (peer) await this.stream.push(peer, token, waited.offer)
            }).catch(() => {}).finally(() => { pushCount-- })
          }
          backoff = 250
        } catch (e) {
          if (signal.aborted) return
          await this.syncFailed(p.id, e)
          this.changed()
          await delay(backoff, undefined, { signal, ref: false })
          backoff = Math.min(backoff * 2, 10_000)
        }
      }
    })().catch(() => {}).finally(() => { if (this.watchers.get(p.id) === state) this.watchers.delete(p.id) })
  }
  async refresh() { const d = await this.serial(() => this.data()); const peers = d.peers.filter(p => p.endpoint); await Promise.all(peers.map(p => this.sync(p.id))); if (peers.length) this.changed(); return this.snapshot() }
  private async packet(p: Peer, outgoing: SharedReport | undefined, receipts: Receipts, request = false, reply = this.feedbackReplies.get(p.id)) {
    const pending = this.feedbackPending.get(p.id), sending = pending && !pending.sent ? pending : undefined
    const artifact = await this.artifacts.packet(p.id, ref => this.artifactSource(p, ref))
    const packet = syncPacket(outgoing, await this.messages.pending(p.id), receipts, { request: sending?.request, reply }, request ? p.id : undefined, request ? undefined : this.version(p.id))
    const m = packet.exchange.messages.find(m => m.files)
    if (m) {
      const chunk = await this.messages.chunk(p.id, m)
      if (chunk) {
        m.chunk = chunk
        const tooLarge = () => Buffer.byteLength(JSON.stringify(packet)) > LIMIT
        if (tooLarge()) packet.report = undefined
        while (tooLarge() && packet.exchange.messages.at(-1) !== m) packet.exchange.messages.pop()
        if (tooLarge()) delete m.chunk
      }
    }
    packet.artifact = artifact
    if (artifact && Buffer.byteLength(JSON.stringify(packet)) > LIMIT) {
      packet.report = undefined
      if (Buffer.byteLength(JSON.stringify(packet)) > LIMIT) {
        // The receiver repeats its offset. Messages, file attachments and feedback go first.
        packet.artifact = { request: artifact.request, receipt: artifact.receipt, deferred: artifact.reply?.requestId }
        if (Buffer.byteLength(JSON.stringify(packet)) > LIMIT) packet.artifact = undefined
      }
    }
    if (sending) sending.sent = true
    return packet
  }
  private async sync(connectionId: string, signal?: AbortSignal): Promise<string | undefined> {
    signal ??= this.watchers.get(connectionId)?.signal
    if (signal?.aborted) return
    const running = this.syncing.get(connectionId)
    if (running) { await running; return this.sync(connectionId, signal) }
    const work = (async () => {
      while (!signal?.aborted) {
        const result = await this.syncOne(connectionId, signal)
        if (!result?.more) return result?.version
      }
    })()
    this.syncing.set(connectionId, work)
    try { return await work } finally { if (this.syncing.get(connectionId) === work) this.syncing.delete(connectionId) }
  }
  private async syncOne(connectionId: string, signal?: AbortSignal) {
    try {
      const d = await this.serial(() => this.data()), p = d.peers.find(p => p.id === connectionId)
      if (!p?.endpoint) return
      const token = await this.orca.secrets.get(secretKey(p.id))
      if (!token) throw Error()
      const outgoing = await this.localReport(p, d)
      const packet = await this.serial(async () => {
        if ((await this.data()).revision !== d.revision) return
        return this.packet(p, outgoing, this.receipts.get(p.id) ?? noReceipts, true)
      })
      if (!packet) return
      const result = await call(p.endpoint, '/sync', packet, token, signal)
      const version = id(result.version)
      const incoming = result.report === undefined ? undefined : received(result.report, p)
      const more = await this.serial(async () => { const now = await this.data(), current = now.peers.find(x => x.id === p.id); if (!current) return false
        const { more, ...acknowledgements } = await this.receiveMessages(incoming ? { ...current, name: incoming.name } : current, result.exchange)
        if (hasReceipts(acknowledgements)) this.receipts.set(p.id, acknowledgements)
        else this.receipts.delete(p.id)
        if (current.state === 'pending') { current.state = 'active'; now.revision++; await this.save(now) }
        if (incoming) await this.recordIncoming(now, current, incoming)
        if (this.feedbackReplies.get(p.id) === packet.feedback?.reply) this.feedbackReplies.delete(p.id)
        this.artifacts.sent(p.id, packet.artifact)
        const reply = await this.receiveFeedback(current, result.feedback)
        if (reply) this.feedbackReplies.set(p.id, reply)
        const nextReceipt = hasReceipts(acknowledgements) && JSON.stringify(acknowledgements) !== JSON.stringify(this.exchangeReceipts(packet.exchange))
        const nextArtifact = await this.artifacts.receive(p.id, p.workspaceId, result.artifact)
        if (result.exchange.messages.length || result.feedback || result.artifact) this.activeCatalog()
        return nextArtifact || !!reply || more || nextReceipt && (this.running || !!acknowledgements.progress?.length)
      })
      if (this.running && panelChanged(result)) this.changed()
      return { version, more }
    } catch (e) {
      if (!signal?.aborted) await this.syncFailed(connectionId, e)
    }
  }
  private exchangeReceipts({ messages, ...receipts }: MessageExchange): Receipts { return receipts }
  private async syncFailed(connectionId: string, e: unknown) {
    await this.serial(async () => {
      const last = this.incoming.get(connectionId)?.receivedAt, d = await this.data(), p = d.peers.find(p => p.id === connectionId)
      if (!p) return
      if ((e as { status?: number }).status === 401) return this.removePeer(d, connectionId)
      if (last && p.lastSyncAt !== last) { p.lastSyncAt = last; await this.save(d) }
      const incoming = this.incoming.get(connectionId)
      if (incoming) incoming.offline = true
    })
  }
  private async authenticated(d: LinkData, peerId: unknown, authorization: string | undefined) {
    const p = d.peers.find(p => p.id === peerId && p.state === 'active')
    const token = p && await this.orca.secrets.get(secretKey(p.id))
    return p && token && equal(authorization || '', 'Bearer ' + token) ? p : undefined
  }
  private async serve(req: http.IncomingMessage, res: http.ServerResponse) {
    // Preserve the shorter control-body deadline while allowing a bounded binary upload.
    if (req.url !== '/artifact/push') {
      const timer = setTimeout(() => req.destroy(), 5000)
      req.once('end', () => clearTimeout(timer)).once('close', () => clearTimeout(timer))
    }
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)) }
    try {
      if (req.method === 'POST' && (req.url === '/artifact/get' || req.url === '/artifact/push')) {
        const p = await this.authenticated(await this.data(), req.headers['x-workspace-link'], req.headers.authorization)
        if (!p) { req.resume(); reply(401, {}); return }
        await this.stream.serve(p, req, res, req.url === '/artifact/get' ? await jsonBody(req) : undefined)
        return
      }
      if (req.method !== 'POST' || !['/pair', '/sync', '/revoke', '/wait'].includes(req.url || '')) { req.resume(); reply(404, { error: 'Not found' }); return }
      const body = await jsonBody(req)
      const sync = await this.serial(async () => {
        const d = await this.data()
        if (req.url === '/pair') {
          if (!this.invitation || this.invitation.expires <= Date.now() || typeof body.invite !== 'string' || !equal(body.invite, this.invitation.token)) { reply(401, { error: 'Unauthorized' }); return }
          const workspaceId = id(body.workspaceId), connectionId = id(body.id), token = text(body.token, '凭据', 100)
          if (!/^[A-Za-z0-9_-]{43}$/.test(token) || workspaceId === d.workspaceId || d.peers.some(p => p.id === connectionId || p.workspaceId === workspaceId) || d.peers.length >= maxPeers) fail('连接请求不正确')
          const name = text(body.name, '工作间名称', 200)
          this.invitation = undefined
          await this.orca.secrets.set(secretKey(connectionId), token)
          d.peers.push({ id: connectionId, workspaceId, name, endpoint: '', state: 'active', ...defaults() }); d.revision++; await this.save(d)
          reply(200, { workspaceId: d.workspaceId }); this.changed(); return
        }
        const p = await this.authenticated(d, body.id, req.headers.authorization)
        if (!p) { reply(401, { error: 'Unauthorized' }); return }
        if (req.url === '/wait') {
          const since = id(body.since)
          this.waiters.get(p.id)?.()
          if (since !== this.version(p.id) || this.artifacts.offer(p.id)) { reply(200, { offer: this.artifacts.takeOffer(p.id) }); return }
          const cleanup = () => {
            clearTimeout(timer)
            if (this.waiters.get(p.id) === finish) this.waiters.delete(p.id)
          }
          const finish = (status = 200) => { cleanup(); if (!res.destroyed) reply(status, status === 200 ? { offer: this.artifacts.takeOffer(p.id) } : {}) }
          const timer = setTimeout(finish, waitTime)
          res.once('close', cleanup)
          this.waiters.set(p.id, finish)
          return
        }
        if (req.url === '/revoke') {
          await this.removePeer(d, p.id); reply(200, {}); this.changed(); return
        }
        const incoming = body.report === undefined ? undefined : received(body.report, p)
        const { more: _, ...acknowledgements } = await this.receiveMessages(incoming ? { ...p, name: incoming.name } : p, body.exchange)
        await this.artifacts.receive(p.id, p.workspaceId, body.artifact)
        const feedback = await this.receiveFeedback(p, body.feedback)
        if (incoming) await this.recordIncoming(d, p, incoming)
        if (body.exchange.messages.length || body.feedback || body.artifact) this.activeCatalog()
        return { p, d, acknowledgements, feedback }
      })
      if (!sync) return
      const outgoing = await this.localReport(sync.p, sync.d)
      await this.serial(async () => {
        if ((await this.data()).revision !== sync.d.revision) fail('工作间连接已更新')
        const response = await this.packet(sync.p, outgoing, sync.acknowledgements, false, sync.feedback)
        if (Buffer.byteLength(JSON.stringify(response)) > LIMIT) fail('工作间上报过大')
        reply(200, response)
        this.artifacts.sent(sync.p.id, response.artifact)
        if (panelChanged(body)) this.changed()
      })
    } catch { if (!res.headersSent) reply(400, { error: 'Invalid workspace request' }); req.resume() }
  }
}
