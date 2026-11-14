import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import { taskState, type Project, type WorkspaceRequest } from './model'
import { fail, object, strings, text } from './store'
import { WorkspaceRequests } from './requests'

export type Scope = 'none' | 'summary' | 'details'
export interface Sharing { scope: Scope; projectIds: string[]; acceptTasks: 'deny' | 'confirm' | 'auto' }
export interface SharedReport {
  workspaceId: string; name: string; scope: Scope; updatedAt: string
  projects: { id: string; name: string; updatedAt: string; counts: Record<string, number>; pending: number
    tasks?: { title: string; phase: string; decisions: string[]; acceptance: string[] }[] }[]
}
interface Peer extends Sharing { id: string; workspaceId: string; name: string; endpoint: string; state: 'active' | 'pending' | 'revoked' }
interface LinkData {
  version: 1; revision: number; workspaceId: string; name: string
  enabled: boolean; host: string; port: number; publicUrl: string; tls: boolean; peers: Peer[]
}
export interface LinksSnapshot extends Omit<LinkData, 'peers'> {
  requests?: WorkspaceRequest[]
  listening: string; error: string
  peers: (Peer & { status: 'connected' | 'offline' | 'pending' | 'revoked'; receivedAt?: string; report?: SharedReport })[]
  invitation?: { code: string; expiresAt: string }
}
const defaults = (): Sharing => ({ scope: 'none', projectIds: [], acceptTasks: 'deny' })
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
export function endpoint(value: unknown): string {
  let u: URL
  try { u = new URL(text(value, '访问地址', 2048)) } catch { return fail('请填写完整的 HTTP(S) 地址') }
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' ||
    !(u.protocol === 'https:' || u.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname))) fail('非回环地址必须使用 HTTPS；地址不能含路径、凭据或参数')
  return u.origin
}
function sharing(raw: unknown): Sharing {
  const r = object(raw)
  if (!['none', 'summary', 'details'].includes(r.scope) || !['deny', 'confirm', 'auto'].includes(r.acceptTasks)) fail('开放范围或派活设置不正确')
  return { scope: r.scope, projectIds: strings(r.projectIds, '开放的项目'), acceptTasks: r.acceptTasks }
}
// Only locally owned project records enter this projection. Incoming reports have no route into it.
export function report(projects: Project[], peer: Sharing, workspaceId: string, name: string): SharedReport {
  return { workspaceId, name, scope: peer.scope, updatedAt: new Date().toISOString(), projects: peer.scope === 'none' ? [] :
    projects.filter(p => !p.hidden && peer.projectIds.includes(p.ref.id)).map(p => {
      const external = p.events.filter(e => e.source === 'workspace-external')
      const tasks = p.tasks.filter(t => !external.some(e => e.taskId === t.id || t.sourceIds.includes(e.id)))
      const counts: Record<string, number> = {}
      for (const t of tasks) { const state = taskState(t); counts[state] = (counts[state] || 0) + 1 }
      return { id: p.ref.id, name: p.ref.name, updatedAt: p.updatedAt || '', counts,
        pending: tasks.reduce((n, t) => n + t.decisions.filter(d => d.answer === undefined).length + (t.phase === 'ready' ? t.acceptance.filter(a => a.status === 'pending').length : 0), 0),
        ...(peer.scope === 'details' ? { tasks: tasks.map(t => ({ title: t.title, phase: t.phase,
          decisions: t.decisions.filter(d => d.answer === undefined).map(d => d.question),
          acceptance: t.phase === 'ready' ? t.acceptance.filter(a => a.status === 'pending').map(a => a.title) : [] })) } : {}) }
    }) }
}
function received(raw: unknown, peer: Peer): SharedReport {
  const r = object(raw)
  if (r.workspaceId !== peer.workspaceId || !['none', 'summary', 'details'].includes(r.scope) || !Array.isArray(r.projects) || r.projects.length > 100 || r.scope === 'none' && r.projects.length) fail('对端上报格式不正确')
  const str = (v: unknown, max = 4000) => typeof v === 'string' && v.length <= max ? v : fail('对端文字格式不正确')
  const titles = (v: unknown) => { if (!Array.isArray(v) || v.length > 100) fail('对端标题格式不正确'); return v.map(x => str(x)) }
  return { workspaceId: peer.workspaceId, name: str(r.name, 200), scope: r.scope, updatedAt: str(r.updatedAt, 100), projects: r.projects.map((raw: unknown) => {
    const p = object(raw), c = object(p.counts), counts: Record<string, number> = {}
    for (const k of ['working', 'decision', 'review', 'rework', 'completed', 'blocked', 'paused']) if (c[k] !== undefined) {
      if (!Number.isSafeInteger(c[k]) || c[k] < 0) fail('对端计数不正确'); counts[k] = c[k]
    }
    if (!Number.isSafeInteger(p.pending) || p.pending < 0) fail('对端待处理计数不正确')
    const out: SharedReport['projects'][number] = { id: id(p.id), name: str(p.name, 200), updatedAt: str(p.updatedAt, 100), counts, pending: p.pending }
    if (r.scope === 'details') {
      if (!Array.isArray(p.tasks) || p.tasks.length > 1000) fail('对端任务格式不正确')
      out.tasks = p.tasks.map((v: unknown) => { const t = object(v); if (!['working', 'ready', 'completed', 'blocked', 'paused'].includes(t.phase)) fail('对端任务阶段不正确'); return { title: str(t.title, 200), phase: t.phase, decisions: titles(t.decisions), acceptance: titles(t.acceptance) } })
    }
    return out
  }) }
}
const LIMIT = 180_000
async function jsonBody(stream: AsyncIterable<Buffer>): Promise<any> {
  const chunks: Buffer[] = []; let size = 0
  for await (const c of stream) { size += c.length; if (size > LIMIT) fail('工作间消息过大'); chunks.push(c) }
  return object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
}
async function call(url: string, route: string, body: unknown, token = ''): Promise<any> {
  const u = new URL(endpoint(url) + route), data = JSON.stringify(body)
  if (Buffer.byteLength(data) > LIMIT) fail('工作间上报过大，请减少开放的项目')
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(token ? { Authorization: `Bearer ${token}` } : {})
    } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(Object.assign(new Error(res.statusCode === 401 ? '连接已撤销或凭据无效' : '对端未接受请求，请核对连接状态'), { status: res.statusCode })); return }
      void jsonBody(res).then(resolve, () => reject(new Error('对端未返回有效的工作间消息')))
    })
    req.setTimeout(5000, () => req.destroy()); req.once('error', () => reject(new Error('无法连接对端，请核对地址和网络'))); req.end(data)
  })
}

export class WorkspaceLinks {
  readonly requests: WorkspaceRequests
  private initial: LinkData = { version: 1, revision: 0, workspaceId: randomUUID(), name: '我的工作间', enabled: false, host: '127.0.0.1', port: 0, publicUrl: '', tls: false, peers: [] }
  private server?: http.Server | https.Server
  private timer?: ReturnType<typeof setInterval>
  private invitation?: { token: string; expires: number }
  private incoming = new Map<string, { report: SharedReport; receivedAt: string }>()
  private failures = new Map<string, string>()
  private chain: Promise<unknown> = Promise.resolve()
  private syncing = new Map<string, Promise<void>>()
  private listening = ''
  private error = ''
  constructor(private orca: Pick<OrcaWorkerApi, 'storage' | 'secrets'>, private projects: () => Promise<Project[]>, private changed: () => void) { this.requests = new WorkspaceRequests(orca.storage) }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const p = this.chain.then(fn); this.chain = p.catch(() => {}); return p }
  private async data(): Promise<LinkData> {
    const raw = await this.orca.storage.get('workspace.links')
    if (!raw) return structuredClone(this.initial)
    const d = structuredClone(object(raw)) as LinkData
    if (d.version !== 1 || !Array.isArray(d.peers)) fail('工作间连接记录不兼容，请保留数据并检查版本')
    return d
  }
  private async save(d: LinkData) { if (Buffer.byteLength(JSON.stringify(d)) > 100_000) fail('连接记录已达上限'); await this.orca.storage.set('workspace.links', d as any) }
  async snapshot(): Promise<LinksSnapshot> {
    const d = await this.serial(() => this.data())
    return { ...d, requests: (await this.requests.data()).requests, listening: this.listening, error: this.error, peers: d.peers.map(p => {
      const incoming = this.incoming.get(p.id), fresh = incoming && Date.now() - Date.parse(incoming.receivedAt) < 35_000 && !this.failures.has(p.id)
      return { ...p, status: p.state === 'revoked' ? 'revoked' : fresh ? 'connected' : p.state === 'pending' ? 'pending' : 'offline',
        ...(incoming ? { receivedAt: incoming.receivedAt } : {}), ...(p.state === 'active' && fresh ? { report: incoming!.report } : {}) }
    }) }
  }
  async configure(input: Record<string, any>) {
    await this.serial(async () => {
      const d = await this.data()
      if (d.revision !== input.revision) fail('连接设置已更新，请刷新后再保存')
      if (typeof input.enabled !== 'boolean' || typeof input.tls !== 'boolean' || !isIP(input.host) || ['0.0.0.0', '::'].includes(input.host) || !Number.isInteger(input.port) || input.port < 0 || input.port > 65535) fail('请填写明确的监听 IP 与 0–65535 端口，不能绑定所有地址')
      const publicUrl = input.publicUrl ? endpoint(input.publicUrl) : ''
      if (input.enabled && !['127.0.0.1', '::1'].includes(input.host) && (!input.tls || !publicUrl.startsWith('https:'))) fail('非回环监听必须配置 TLS 和 HTTPS 访问地址')
      if (input.certificate || input.privateKey) {
        if (!input.certificate || !input.privateKey) fail('请同时填写证书与私钥')
        // Validate before changing either live listener or secret storage.
        https.createServer({ cert: input.certificate, key: input.privateKey }).close()
        await this.orca.secrets.set('workspace-links-tls', JSON.stringify({ cert: input.certificate, key: input.privateKey }))
      }
      if (input.enabled && input.tls && !await this.orca.secrets.get('workspace-links-tls')) fail('请填写 TLS 证书与私钥')
      Object.assign(d, { name: text(input.name, '工作间名称', 200), enabled: input.enabled, host: input.host, port: input.port, publicUrl, tls: input.tls, revision: d.revision + 1 })
      await this.save(d)
    })
    await this.start(); this.changed(); return this.snapshot()
  }
  async start() {
    this.stop()
    this.error = ''
    const d = await this.serial(() => this.data())
    if (d.enabled) {
      try {
        this.server = d.tls ? https.createServer(JSON.parse(await this.orca.secrets.get('workspace-links-tls') || '{}'), (q, s) => { void this.serve(q, s) }) : http.createServer((q, s) => { void this.serve(q, s) })
        this.server.requestTimeout = 5000; this.server.headersTimeout = 5000; this.server.maxConnections = 32
        await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(d.port, d.host, resolve) })
        this.listening = `${d.tls ? 'https' : 'http'}://${isIP(d.host) === 6 ? `[${d.host}]` : d.host}:${(this.server.address() as import('node:net').AddressInfo).port}`
        this.server.on('error', () => { this.error = '监听已停止，请检查地址与端口'; this.changed() })
        this.error = ''
      } catch { this.stop(); this.error = '无法监听，请检查地址、端口和 TLS 证书' }
    }
    this.timer = setInterval(() => { void this.refresh().catch(() => {}) }, 10_000); this.timer.unref()
  }
  stop() { if (this.timer) clearInterval(this.timer); this.server?.closeAllConnections(); this.server?.close(); this.server = undefined; this.listening = ''; this.invitation = undefined }
  async invite() {
    const s = await this.snapshot()
    if (!this.listening) fail('请先启用工作间连接监听')
    this.invitation = { token: randomBytes(32).toString('base64url'), expires: Date.now() + 120_000 }
    return { ...s, invitation: { code: `AB1.${Buffer.from(JSON.stringify({ workspaceId: s.workspaceId, name: s.name, url: s.publicUrl || this.listening, token: this.invitation.token })).toString('base64url')}`, expiresAt: new Date(this.invitation.expires).toISOString() } }
  }
  cancelInvite() { this.invitation = undefined; return this.snapshot() }
  async join(code: string) {
    let c: Record<string, any>
    try { if (!code.startsWith('AB1.') || code.length > 6000) throw Error(); c = object(JSON.parse(Buffer.from(code.slice(4), 'base64url').toString('utf8'))) } catch { return fail('连接码格式不正确') }
    const url = endpoint(c.url), workspaceId = id(c.workspaceId), name = text(c.name, '对端名称', 200), token = randomBytes(32).toString('base64url'), connectionId = randomUUID()
    text(c.token, '连接码', 100)
    const d = await this.serial(async () => {
      const d = await this.data()
      if (d.workspaceId === workspaceId || d.peers.some(p => p.workspaceId === workspaceId && p.state !== 'revoked')) fail('工作间已连接或结果待核对，请刷新原连接')
      if (d.peers.length >= 50) fail('连接数量已达上限')
      await this.orca.secrets.set(secretKey(connectionId), token)
      d.peers.push({ id: connectionId, workspaceId, name, endpoint: url, state: 'pending', ...defaults() }); d.revision++; await this.save(d); return d
    })
    try {
      const result = await call(url, '/pair', { invite: c.token, id: connectionId, workspaceId: d.workspaceId, name: d.name, token })
      if (result.workspaceId !== workspaceId) fail('对端身份与连接码不一致')
      await this.serial(async () => { const d = await this.data(); d.peers.find(p => p.id === connectionId)!.state = 'active'; d.revision++; await this.save(d) })
      await this.sync(connectionId)
    } catch { this.failures.set(connectionId, '连接结果待核对，请刷新原连接；不要重复使用连接码') }
    this.changed(); return this.snapshot()
  }
  async share(input: Record<string, any>) {
    const setting = sharing(input), own = await this.projects()
    if (setting.projectIds.some(id => !own.some(p => p.ref.id === id))) fail('只能开放本工作间自己的项目')
    await this.serial(async () => { const d = await this.data(); if (input.revision !== d.revision) fail('连接已更新，请刷新后再保存'); const p = d.peers.find(p => p.id === input.id && p.state === 'active'); if (!p) fail('请选择有效连接'); Object.assign(p, setting); d.revision++; await this.save(d) })
    await this.sync(input.id); this.changed(); return this.snapshot()
  }
  async revoke(connectionId: string) {
    const p = await this.serial(async () => {
      const d = await this.data(), p = d.peers.find(p => p.id === connectionId)
      if (!p) fail('连接不存在')
      p.state = 'revoked'; d.revision++; await this.save(d); this.incoming.delete(p.id)
      await this.requests.disconnect(p.id)
      const token = await this.orca.secrets.get(secretKey(p.id)); await this.orca.secrets.delete(secretKey(p.id)); return { ...p, token }
    })
    if (p.endpoint && p.token) { try { await call(p.endpoint, '/revoke', { id: p.id }, p.token) } catch { /* Local authorization is already revoked; offline peers learn on their next sync. */ } }
    this.changed(); return this.snapshot()
  }
  async request(input: Record<string, any>, operation: 'send' | 'decide' | 'update' | 'attach') {
    await this.serial(async () => {
      const d = await this.data(), p = d.peers.find(p => p.id === input.peerId && p.state === 'active')
      if (!p) fail('请选择有效连接')
      if (operation === 'send') await this.requests.send(p.id, p.workspaceId, input)
      else if (operation === 'attach') await this.requests.attach(p.id, input.id, text(input.projectId, '项目编号', 200))
      else await this.requests.update(input, operation === 'decide')
    })
    await this.sync(input.peerId); this.changed(); return this.snapshot()
  }
  async refresh() { const d = await this.serial(() => this.data()); await Promise.all(d.peers.filter(p => p.endpoint && p.state !== 'revoked').map(p => this.sync(p.id))); this.changed(); return this.snapshot() }
  private async sync(connectionId: string): Promise<void> {
    const running = this.syncing.get(connectionId)
    if (running) { await running; return this.sync(connectionId) }
    const work = this.syncOne(connectionId)
    this.syncing.set(connectionId, work)
    try { await work } finally { if (this.syncing.get(connectionId) === work) this.syncing.delete(connectionId) }
  }
  private async syncOne(connectionId: string) {
    try {
      const d = await this.serial(() => this.data()), p = d.peers.find(p => p.id === connectionId)
      if (!p || p.state === 'revoked' || !p.endpoint) return
      const token = await this.orca.secrets.get(secretKey(p.id))
      if (!token) throw Error()
      const exchange = await this.serial(() => this.requests.envelope(p.id))
      const result = await call(p.endpoint, '/sync', { id: p.id, report: report(await this.projects(), p, d.workspaceId, d.name), exchange }, token)
      const incoming = received(result.report, p)
      await this.serial(async () => { const now = await this.data(), current = now.peers.find(x => x.id === p.id); if (!current || current.state === 'revoked') return
        if (current.state === 'pending') { current.state = 'active'; now.revision++; await this.save(now) }
        await this.requests.receive(p.id, p.workspaceId, current.acceptTasks, result.exchange)
        this.incoming.set(p.id, { report: incoming, receivedAt: new Date().toISOString() }); this.failures.delete(p.id)
      })
    } catch (e) {
      if ((e as { status?: number }).status === 401) await this.serial(async () => {
        const d = await this.data(), p = d.peers.find(p => p.id === connectionId)
        if (p && p.state !== 'revoked') { p.state = 'revoked'; d.revision++; await this.save(d); await this.requests.disconnect(p.id); await this.orca.secrets.delete(secretKey(p.id)) }
      })
      this.failures.set(connectionId, '对端离线、连接已撤销或凭据无效'); this.incoming.delete(connectionId)
    }
  }
  private async serve(req: http.IncomingMessage, res: http.ServerResponse) {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)) }
    try {
      if (req.method !== 'POST' || !['/pair', '/sync', '/revoke'].includes(req.url || '')) { req.resume(); reply(404, { error: 'Not found' }); return }
      const body = await jsonBody(req)
      await this.serial(async () => {
        const d = await this.data()
        if (req.url === '/pair') {
          if (!this.invitation || this.invitation.expires <= Date.now() || typeof body.invite !== 'string' || !equal(body.invite, this.invitation.token)) { reply(401, { error: 'Unauthorized' }); return }
          const workspaceId = id(body.workspaceId), connectionId = id(body.id), token = text(body.token, '凭据', 100)
          if (!/^[A-Za-z0-9_-]{43}$/.test(token) || workspaceId === d.workspaceId || d.peers.some(p => p.id === connectionId || p.workspaceId === workspaceId && p.state !== 'revoked') || d.peers.length >= 50) fail('连接请求不正确')
          const name = text(body.name, '工作间名称', 200)
          this.invitation = undefined
          await this.orca.secrets.set(secretKey(connectionId), token)
          d.peers.push({ id: connectionId, workspaceId, name, endpoint: '', state: 'active', ...defaults() }); d.revision++; await this.save(d)
          reply(200, { workspaceId: d.workspaceId }); this.changed(); return
        }
        const p = d.peers.find(p => p.id === body.id && p.state === 'active'), token = p && await this.orca.secrets.get(secretKey(p.id))
        if (!p || !token || !equal(req.headers.authorization || '', `Bearer ${token}`)) { reply(401, { error: 'Unauthorized' }); return }
        if (req.url === '/revoke') {
          p.state = 'revoked'; d.revision++; await this.save(d); await this.requests.disconnect(p.id); await this.orca.secrets.delete(secretKey(p.id)); this.incoming.delete(p.id); reply(200, {}); this.changed(); return
        }
        const incoming = received(body.report, p), outgoing = report(await this.projects(), p, d.workspaceId, d.name)
        await this.requests.receive(p.id, p.workspaceId, p.acceptTasks, body.exchange)
        const response = { report: outgoing, exchange: await this.requests.envelope(p.id) }
        if (Buffer.byteLength(JSON.stringify(response)) > LIMIT) fail('工作间上报过大')
        this.incoming.set(p.id, { report: incoming, receivedAt: new Date().toISOString() }); this.failures.delete(p.id)
        reply(200, response); this.changed()
      })
    } catch { if (!res.headersSent) reply(400, { error: 'Invalid workspace request' }); req.resume() }
  }
}
