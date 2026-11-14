import { randomUUID } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import { fail, fingerprint, object, text } from './store'
import { requestState, requestStates, type WorkspaceRequest, type RequestState, type RequestUpdate } from './model'
interface Data { version: 1; requests: WorkspaceRequest[]; operations: { id: string; fingerprint: string }[] }
const finished = (s: RequestState) => ['rejected', 'completed', 'failed', 'disconnected'].includes(s)
const optional = (v: unknown, label: string, max = 4000) => v === undefined || v === '' ? '' : text(v, label, max)
const identifier = (v: unknown) => {
  const s = text(v, '请求编号', 64)
  if (!/^[\w-]+$/.test(s)) fail('请求编号只允许字母、数字、下划线和连字符')
  return s
}
function links(v: unknown): string[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > 10) fail('最多附十个文字链接')
  return v.map(value => {
    const s = text(value, '链接', 2000)
    let u: URL
    try { u = new URL(s) } catch { return fail('请填写完整的 HTTP(S) 链接') }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) fail('只支持无凭据的 HTTP(S) 链接')
    return s
  })
}
function content(v: Record<string, any>) {
  return { title: text(v.title, '要做什么', 200), context: optional(v.context, '背景'), expected: text(v.expected, '期望结果', 4000), links: links(v.links) }
}
const next = (from: RequestState, to: RequestState) => from === 'sent' ? ['confirm', 'rejected', 'accepted'].includes(to)
  : from === 'confirm' ? ['accepted', 'rejected'].includes(to) : ['accepted', 'working'].includes(from) && ['working', 'completed', 'failed'].includes(to)

// Each connection exchanges only its own requests and receiver-authored, append-only updates.
export class WorkspaceRequests {
  constructor(private storage: Pick<OrcaWorkerApi['storage'], 'get' | 'set'>) {}
  async data(): Promise<Data> {
    const raw = await this.storage.get('workspace.requests')
    if (!raw) return { version: 1, requests: [], operations: [] }
    const d = structuredClone(object(raw)) as Data
    if (d.version !== 1 || !Array.isArray(d.requests) || !Array.isArray(d.operations)) fail('工作间请求记录不兼容，请保留数据并检查版本')
    return d
  }
  private async save(d: Data) {
    // shortcut: bounded request history; add paging before growing beyond the existing bridge size.
    const reserved = d.requests.filter(r => !finished(requestState(r))).length * 256
    if (Buffer.byteLength(JSON.stringify(d)) + reserved > 120_000) fail('工作间请求记录已达上限；原记录已保留')
    await this.storage.set('workspace.requests', d as any)
  }
  async send(peerId: string, workspaceId: string, input: Record<string, any>) {
    const d = await this.data(), id = identifier(input.requestId), fields = content(input)
    const prior = d.requests.find(r => r.id === id)
    if (prior) {
      if (prior.direction !== 'outgoing' || fingerprint([prior.peerId, content(prior)]) !== fingerprint([peerId, fields])) fail('请求编号已用于其他内容')
      return
    }
    d.requests.push({ id, peerId, workspaceId, direction: 'outgoing', ...fields, createdAt: new Date().toISOString(), updates: [] })
    await this.save(d)
  }
  async update(input: Record<string, any>, decide: boolean) {
    const d = await this.data(), operationId = text(input.requestId, '更新编号', 200), hash = fingerprint(input)
    const prior = d.operations.find(o => o.id === operationId)
    if (prior) { if (prior.fingerprint !== hash) fail('更新编号已用于其他内容'); return }
    const r = d.requests.find(r => r.id === input.id && r.peerId === input.peerId && r.direction === 'incoming')
    if (!r) fail('请选择本工作间收到的请求')
    const state = requestState(r), status = input.status as RequestState
    if (decide ? state !== 'confirm' || !['accepted', 'rejected'].includes(status) : !['accepted', 'working'].includes(state) || !['working', 'completed', 'failed'].includes(status)) fail('请求状态已改变，请刷新后处理')
    r.updates.push({ id: randomUUID(), status, note: optional(input.note, '进展或结果', 6000), links: links(input.links), at: new Date().toISOString() })
    if (!decide && !r.updates.at(-1)!.note) fail('请填写进展或结果')
    d.operations.push({ id: operationId, fingerprint: hash }); await this.save(d)
  }
  async attach(peerId: string, id: string, projectId: string) {
    const d = await this.data(), r = d.requests.find(r => r.peerId === peerId && r.id === id && r.direction === 'incoming')
    if (!r || !['accepted', 'working'].includes(requestState(r))) fail('只能接手已接受的外部请求')
    if (r.projectId && r.projectId !== projectId) fail('请求已交给其他项目')
    r.projectId = projectId; await this.save(d)
  }
  async disconnect(peerId: string) {
    const d = await this.data(); let changed = false
    for (const r of d.requests.filter(r => r.peerId === peerId && !finished(requestState(r)))) {
      r.updates.push({ id: randomUUID(), status: 'disconnected', note: '连接已断开', links: [], at: new Date().toISOString() }); changed = true
    }
    if (changed) await this.save(d)
  }
  async envelope(peerId: string) {
    const d = await this.data()
    return { requests: d.requests.filter(r => r.peerId === peerId && r.direction === 'outgoing').map(r => ({ id: r.id, ...content(r), createdAt: r.createdAt })),
      updates: d.requests.filter(r => r.peerId === peerId && r.direction === 'incoming').map(r => ({ id: r.id, updates: r.updates })) }
  }
  async receive(peerId: string, workspaceId: string, rule: 'deny' | 'confirm' | 'auto', raw: unknown) {
    if (raw === undefined) return // Older peers continue to exchange reports only.
    const wire = object(raw), d = await this.data()
    if (!Array.isArray(wire.requests) || !Array.isArray(wire.updates) || wire.requests.length > 500 || wire.updates.length > 500) fail('工作间请求格式不正确')
    let changed = false
    for (const value of wire.requests) {
      const v = object(value), id = identifier(v.id), fields = content(v), createdAt = text(v.createdAt, '请求时间', 100)
      const prior = d.requests.find(r => r.id === id && r.peerId === peerId)
      if (prior) {
        if (prior.direction !== 'incoming' || fingerprint([content(prior), prior.createdAt]) !== fingerprint([fields, createdAt])) fail('对端请求编号重复且内容不同')
        continue
      }
      const status = rule === 'deny' ? 'rejected' : rule === 'auto' ? 'accepted' : 'confirm'
      d.requests.push({ id, peerId, workspaceId, direction: 'incoming', ...fields, createdAt,
        updates: [{ id: randomUUID(), status, note: rule === 'deny' ? '对方不接受派活' : '', links: [], at: new Date().toISOString() }] }); changed = true
    }
    for (const value of wire.updates) {
      const v = object(value), id = identifier(v.id), r = d.requests.find(r => r.id === id && r.peerId === peerId && r.direction === 'outgoing')
      if (!r || !Array.isArray(v.updates) || v.updates.length > 500) fail('对端状态没有对应请求')
      const updates: RequestUpdate[] = v.updates.map((raw: unknown) => {
        const u = object(raw)
        if (!Object.hasOwn(requestStates, u.status) || u.status === 'sent' || u.status === 'disconnected') fail('对端请求状态不正确')
        return { id: identifier(u.id), status: u.status, note: optional(u.note, '进展或结果', 6000), links: links(u.links), at: text(u.at, '更新时间', 100) }
      })
      if (r.updates.some((u, i) => i < updates.length && fingerprint(u) !== fingerprint(updates[i]))) fail('对端状态历史发生冲突')
      let state = requestState(r)
      for (const u of updates.slice(r.updates.length)) {
        if (r.updates.some(x => x.id === u.id) || !next(state, u.status)) fail('对端状态顺序不正确')
        r.updates.push(u); state = u.status; changed = true
      }
    }
    if (changed) await this.save(d)
  }
}
