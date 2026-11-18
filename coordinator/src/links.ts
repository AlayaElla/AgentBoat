import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP, type AddressInfo, type LookupFunction } from 'node:net'
import { lookup } from 'node:dns'
import { hostname, networkInterfaces } from 'node:os'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import { agents, compareAgentActivity, groupedAttention, isProjectShared, isRecentAgent, mainAgentStates, taskState, type AgentActivity, type AgentsSnapshot, type MainAgentActivity, type Project, type WorkspaceBinding } from './model'
import { attention, fail, object, strings, text } from './store'
import { LinkMessages, type IncomingMessage, type MessageExchange, type WireMessage } from './link-messages'
import { LinkFiles } from './link-files'
import { setTimeout as delay } from 'node:timers/promises'

export type Scope = 'none' | 'summary' | 'details'
export interface Sharing { scope: Scope; allProjects: boolean; projectIds: string[] }
export interface SharedReport {
  workspaceId: string; name: string; scope: Scope; updatedAt: string
  mainAgent?: MainAgentActivity | null
  projects: { id: string; name: string; updatedAt: string; counts: Record<string, number>; pending: number
    tasks?: { title: string; phase: string; decisions: string[]; acceptance: string[] }[]
    activity?: { agents: AgentActivity[]; truncated: boolean } | null }[]
}
type LocalActivity = { workspace: WorkspaceBinding; live: AgentsSnapshot }
interface Peer extends Sharing { id: string; workspaceId: string; name: string; endpoint: string; state: 'active' | 'pending'; relation?: 'above' | 'below' | 'peer'; sharingSet?: boolean; lastSyncAt?: string }
interface LinkData {
  version: 1; revision: number; workspaceId: string; name: string
  enabled: boolean; host: string; port: number; publicUrl: string; tls: boolean; peers: Peer[]
}
export interface LinksSnapshot extends Omit<LinkData, 'peers'> {
  listening: string; error: string
  peers: (Peer & { status: 'connected' | 'offline' | 'pending'; receivedAt?: string; report?: SharedReport } & Partial<Awaited<ReturnType<LinkMessages['summarize']>>>)[]
  invitation?: { code: string; expiresAt: string }
}
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
export function defaultWorkspaceName(host = hostname()): string {
  return host.split('.')[0] || '我的工作间'
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
  return { scope: r.scope, allProjects: r.allProjects === true, projectIds: r.projectIds === undefined ? undefined : strings(r.projectIds, '开放的项目') }
}
const LIMIT = 180_000
const waitTime = 25_000
type Receipts = Omit<MessageExchange, 'messages'>
const noReceipts: Receipts = { received: [] }
const hasReceipts = (r: Receipts) => !!(r.received.length || r.progress?.length || r.rejected?.length)
const maxPeers = 50, maxProjectAgents = 20, maxReportAgents = 100, maxActivityTitle = 200
const knownAgent = (value: unknown): value is string => typeof value === 'string' && (value === '' || Object.hasOwn(agents, value))
const publicAgent = (value: string) => knownAgent(value) ? value : ''

// The only input is local records and activity, filtered by the same project scope.
export function report(projects: Project[], peer: Sharing, workspaceId: string, name: string, activity?: LocalActivity): SharedReport {
  const details = peer.scope === 'details', allowed = projects.filter(p => isProjectShared(p, peer))
  const result: SharedReport = { workspaceId, name, scope: peer.scope, updatedAt: new Date().toISOString(), projects:
    allowed.map(p => {
      const tasks = p.tasks
      const counts: Record<string, number> = {}
      for (const t of tasks) { const state = taskState(t); counts[state] = (counts[state] || 0) + 1 }
      return { id: p.ref.id, name: p.ref.name, updatedAt: p.updatedAt || '', counts,
        pending: details ? groupedAttention(attention(p)).length : tasks.reduce((n, t) => n + t.decisions.filter(d => d.answer === undefined).length + (t.phase === 'ready' ? t.acceptance.filter(a => a.status === 'pending').length : 0), 0),
        ...(details ? { activity: null, tasks: tasks.map(t => ({ title: t.title, phase: t.phase,
          decisions: t.decisions.filter(d => d.answer === undefined).map(d => d.question),
          acceptance: t.phase === 'ready' ? t.acceptance.filter(a => a.status === 'pending').map(a => a.title) : [] })) } : {}) }
    }) }
  if (!details) return result
  const workspace = activity?.workspace, session = workspace?.session
  result.mainAgent = workspace?.runId ? { agent: publicAgent(session?.agent ?? ''), title: (session?.title ?? '').slice(0, maxActivityTitle), online: session?.online ?? 'unknown' } : null
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
    mainAgent = { agent: m.agent, online: m.online as MainAgentActivity['online'], title: str(m.title, maxActivityTitle) }
  }
  if (!details && 'mainAgent' in r) fail('对端上报格式不正确')
  return { workspaceId: peer.workspaceId, name: text(r.name, '工作间名称', 200), scope: r.scope, updatedAt: str(r.updatedAt, 100), ...(details ? { mainAgent } : {}), projects: r.projects.map((raw: unknown) => {
    const p = object(raw), c = object(p.counts), counts: Record<string, number> = {}
    for (const k of ['working', 'decision', 'review', 'rework', 'completed', 'blocked', 'paused']) if (c[k] !== undefined) {
      if (!Number.isSafeInteger(c[k]) || c[k] < 0) fail('对端计数不正确'); counts[k] = c[k]
    }
    if (!Number.isSafeInteger(p.pending) || p.pending < 0) fail('对端待处理计数不正确')
    const out: SharedReport['projects'][number] = { id: id(p.id), name: str(p.name, 200), updatedAt: str(p.updatedAt, 100), counts, pending: p.pending }
    if (details) {
      if (!Array.isArray(p.tasks) || p.tasks.length > 1000) fail('对端任务格式不正确')
      out.tasks = p.tasks.map((v: unknown) => { const t = object(v); if (!['working', 'ready', 'completed', 'blocked', 'paused'].includes(t.phase)) fail('对端任务阶段不正确'); return { title: str(t.title, 200), phase: t.phase, decisions: titles(t.decisions), acceptance: titles(t.acceptance) } })
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
    } else if ('activity' in p) fail('对端上报格式不正确')
    return out
  }) }
}
function syncPacket(report: SharedReport, pending: WireMessage[], receipts: Receipts, id?: string, version?: string) {
  const exchange: MessageExchange = { messages: [], ...receipts }
  const packet = { id, version, report: report as SharedReport | undefined, exchange }
  const fits = () => Buffer.byteLength(JSON.stringify(packet)) <= LIMIT
  for (const m of pending) {
    exchange.messages.push(m)
    // Let the oldest message through when a large report would crowd it out.
    if (!fits() && exchange.messages.length === 1) packet.report = undefined
    if (!fits()) { exchange.messages.pop(); break }
  }
  if (hasReceipts(receipts) && !fits()) packet.report = undefined
  return packet
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
async function call(url: string, route: string, body: unknown, token = '', signal?: AbortSignal): Promise<any> {
  const u = new URL(endpoint(url) + route), data = JSON.stringify(body)
  if (Buffer.byteLength(data) > LIMIT) fail('工作间上报过大，请减少开放的项目')
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', rejectUnauthorized: true, signal,
      ...(u.protocol === 'http:' ? { agent: false, lookup: lookupHttpHost } : {}), headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(token ? { Authorization: `Bearer ${token}` } : {})
    } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(Object.assign(new Error(res.statusCode === 401 ? '连接已断开或凭据无效' : '对端未接受请求，请核对连接状态'), { status: res.statusCode })); return }
      void jsonBody(res).then(resolve, () => reject(new Error('对端未返回有效的工作间消息')))
    })
    req.setTimeout(route === '/wait' ? waitTime + 5000 : 5000, () => req.destroy()); req.once('error', () => reject(new Error('无法连接对端，请核对地址和网络'))); req.end(data)
  })
}

export class WorkspaceLinks {
  private messages: LinkMessages
  private receipts = new Map<string, Receipts>()
  private originVersion = randomUUID()
  private versions = new Map<string, string>()
  private waiters = new Map<string, (status?: number) => void>()
  private watchers = new Map<string, AbortController>()
  private running = false
  private signaling = false
  private recentActivity?: { at: number; result: Promise<LocalActivity> }
  private initial: LinkData = { version: 1, revision: 0, workspaceId: randomUUID(), name: defaultWorkspaceName(), enabled: false, host: '127.0.0.1', port: 0, publicUrl: '', tls: false, peers: [] }
  private server?: http.Server | https.Server
  private timer?: ReturnType<typeof setInterval>
  private catalogTimer?: ReturnType<typeof setInterval>
  private invitation?: { token: string; expires: number }
  private incoming = new Map<string, { report: SharedReport; receivedAt: string }>()
  private chain: Promise<unknown> = Promise.resolve()
  private syncing = new Map<string, Promise<string | undefined>>()
  private listening = ''
  private error = ''
  constructor(private orca: Pick<OrcaWorkerApi, 'storage' | 'secrets'>, private projects: () => Promise<Project[]>, private changed: () => void, private chooseHost = invitationHost, private enqueue?: (peer: Peer, messages: IncomingMessage[]) => Promise<void>, private activity?: () => Promise<LocalActivity>, files?: LinkFiles, private checkCatalog?: () => Promise<unknown>) { this.messages = new LinkMessages(orca.storage, files) }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const p = this.chain.then(fn); this.chain = p.catch(() => {}); return p }
  private async data(): Promise<LinkData> {
    const raw = await this.orca.storage.get('workspace.links')
    if (!raw) return structuredClone(this.initial)
    const d = structuredClone(object(raw)) as LinkData
    if (d.version !== 1 || !Array.isArray(d.peers)) fail('工作间连接记录不兼容，请保留数据并检查版本')
    d.peers = d.peers.filter(({ state }: { state: string }) => state !== 'revoked').map(({ id, workspaceId, name, endpoint, state, relation, sharingSet, lastSyncAt, scope, allProjects, projectIds }) => {
      const configured = sharingSet ?? (scope !== 'none' || allProjects === true || projectIds.length > 0 ? true : undefined)
      return { id, workspaceId, name, endpoint, state, scope, allProjects: allProjects === true, projectIds,
        ...(relation === undefined ? {} : { relation }), ...(lastSyncAt === undefined ? {} : { lastSyncAt }),
        ...(configured === undefined ? {} : { sharingSet: configured }) }
    })
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
      const incoming = this.incoming.get(p.id), fresh = incoming && Date.now() - Date.parse(incoming.receivedAt) < 35_000
      return { ...p, status: fresh ? 'connected' : p.state === 'pending' ? 'pending' : 'offline',
        ...(incoming ? { receivedAt: incoming.receivedAt, lastSyncAt: incoming.receivedAt } : {}), ...(p.state === 'active' && fresh ? { report: incoming!.report } : {}),
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
    clearInterval(this.catalogTimer)
    if (this.checkCatalog) {
      // shortcut: Orca has no project catalog event; read the local catalog while sharing.
      this.catalogTimer = setInterval(() => {
        void this.data().then(d => {
          if (d.peers.some(p => p.state === 'active' && p.scope !== 'none')) return this.checkCatalog!()
        }).catch(() => {})
      }, 1000)
      this.catalogTimer.unref()
    }
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
        this.server.requestTimeout = 5000; this.server.headersTimeout = 5000; this.server.maxConnections = 2 * maxPeers + 16
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
    clearInterval(this.timer)
    clearInterval(this.catalogTimer)
    for (const watcher of this.watchers.values()) watcher.abort()
    this.watchers.clear()
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
  private async removePeer(d: LinkData, connectionId: string) {
    await this.orca.secrets.delete(secretKey(connectionId))
    await this.messages.revoke(connectionId)
    this.waiters.get(connectionId)?.(401)
    this.watchers.get(connectionId)?.abort()
    this.versions.delete(connectionId)
    this.receipts.delete(connectionId)
    this.incoming.delete(connectionId)
    d.peers = d.peers.filter(p => p.id !== connectionId)
    d.revision++
    await this.save(d)
  }
  private receiveMessages(peer: Peer, exchange: unknown) {
    return this.messages.receive(peer.id, exchange, messages => this.enqueue?.(peer, messages) ?? Promise.resolve(), peer.workspaceId)
  }
  private async localReport(p: Peer, d: LinkData) {
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
      let backoff = 250
      while (!signal.aborted) {
        try {
          const version = await this.sync(p.id, signal)
          if (signal.aborted) return
          const token = await this.orca.secrets.get(secretKey(p.id))
          if (!token) return
          if (!version) throw Error()
          await call(p.endpoint, '/wait', { id: p.id, since: version }, token, signal)
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
  private async packet(p: Peer, outgoing: SharedReport, receipts: Receipts, request = false) {
    const packet = syncPacket(outgoing, await this.messages.pending(p.id), receipts, request ? p.id : undefined, request ? undefined : this.version(p.id))
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
        const nextReceipt = hasReceipts(acknowledgements) && JSON.stringify(acknowledgements) !== JSON.stringify(this.exchangeReceipts(packet.exchange))
        return more || nextReceipt && (this.running || !!acknowledgements.progress?.length)
      })
      if (this.running) this.changed()
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
      this.incoming.delete(connectionId)
    })
  }
  private async serve(req: http.IncomingMessage, res: http.ServerResponse) {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)) }
    try {
      if (req.method !== 'POST' || !['/pair', '/sync', '/revoke', '/wait'].includes(req.url || '')) { req.resume(); reply(404, { error: 'Not found' }); return }
      const body = await jsonBody(req)
      await this.serial(async () => {
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
        const p = d.peers.find(p => p.id === body.id && p.state === 'active'), token = p && await this.orca.secrets.get(secretKey(p.id))
        if (!p || !token || !equal(req.headers.authorization || '', `Bearer ${token}`)) { reply(401, { error: 'Unauthorized' }); return }
        if (req.url === '/wait') {
          const since = id(body.since)
          this.waiters.get(p.id)?.()
          if (since !== this.version(p.id)) { reply(200, {}); return }
          const cleanup = () => {
            clearTimeout(timer)
            if (this.waiters.get(p.id) === finish) this.waiters.delete(p.id)
          }
          const finish = (status = 200) => { cleanup(); if (!res.destroyed) reply(status, {}) }
          const timer = setTimeout(finish, waitTime)
          res.once('close', cleanup)
          this.waiters.set(p.id, finish)
          return
        }
        if (req.url === '/revoke') {
          await this.removePeer(d, p.id); reply(200, {}); this.changed(); return
        }
        const incoming = body.report === undefined ? undefined : received(body.report, p), outgoing = await this.localReport(p, d)
        const { more: _, ...acknowledgements } = await this.receiveMessages(incoming ? { ...p, name: incoming.name } : p, body.exchange)
        const response = await this.packet(p, outgoing, acknowledgements)
        if (Buffer.byteLength(JSON.stringify(response)) > LIMIT) fail('工作间上报过大')
        if (incoming) await this.recordIncoming(d, p, incoming)
        reply(200, response); this.changed()
      })
    } catch { if (!res.headersSent) reply(400, { error: 'Invalid workspace request' }); req.resume() }
  }
}
