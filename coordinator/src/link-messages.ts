import { fail, fingerprint, maxMessageLength, object, text } from './store'
import { LinkFiles, maxLinkFiles, safeFiles, wireChunk, wireFiles, type FileChunk, type LinkFile, type ReceivedFile } from './link-files'

const maxPending = 10
const maxRecent = 10
export const linkMessageHistory = 50
const maxPendingBytes = 150_000

export interface WireMessage { requestId: string; text: string; files?: LinkFile[]; chunk?: FileChunk }
type FileError = 'capacity' | 'checksum'
export type IncomingMessage = WireMessage & { attachments?: ReceivedFile[]; fileError?: FileError }
export interface MessageExchange {
  messages: WireMessage[]; received: string[]
  progress?: { requestId: string; offsets: number[] }[]
  rejected?: { requestId: string; reason: FileError }[]
}
type State = 'pending' | 'delivered' | 'received' | 'failed'
type Message = {
  peerId: string; requestId: string; hash: string; at: string; state: State; text?: string; preview?: string
  files?: LinkFile[]; spool?: string; fileError?: FileError
}

const preview = (body = '') => [...body].slice(0, 200).join('')
const bodyBytes = (body: string) => Buffer.byteLength(JSON.stringify(body)) - 2
const requestId = (value: unknown) => text(value, '消息编号', 64)
function message(value: unknown): WireMessage {
  const m = object(value)
  const files = wireFiles(m.files), chunk = wireChunk(m.chunk)
  if (chunk && !files) fail('文件分块缺少附件清单')
  return { requestId: requestId(m.requestId), text: files && (m.text === undefined || m.text === '') ? '' : text(m.text, '消息正文', maxMessageLength),
    ...(files ? { files } : {}), ...(chunk ? { chunk } : {}) }
}
export const incomingHash = (m: WireMessage) => fingerprint(m.files ? [m.text, m.files] : m.text)
export const fileErrorText = { capacity: '已达此工作间的 1 GB 接收上限，未保存新附件', checksum: '附件 SHA-256 校验失败，未保存附件' }

// All reads and writes are serialized by WorkspaceLinks.
export class LinkMessages {
  private progress = new Map<string, Map<string, number[]>>()
  constructor(private files: LinkFiles) {}

  async data(): Promise<Message[]> {
    const raw = await this.files.messageJournal()
    if (raw === undefined) return []
    if (!Array.isArray(raw)) fail('工作间消息记录格式不正确')
    return structuredClone(raw) as unknown as Message[]
  }

  private compact(records: Message[]) {
    const recent = new Map<string, number>()
    return [...records].reverse().filter(m => {
      if (m.state === 'pending') return true
      const count = recent.get(m.peerId) ?? 0
      if (count >= linkMessageHistory) return false
      if (m.text !== undefined) {
        m.preview = preview(m.text)
        delete m.text
      }
      recent.set(m.peerId, count + 1)
      return true
    }).reverse()
  }

  private async save(records: Message[]) {
    await this.files.saveMessageJournal(this.compact(records))
  }

  async summarize(records: Message[], peerId: string) {
    const own = records.filter(m => m.peerId === peerId)
    const recent = own.slice(-maxRecent).reverse().map(m => ({
      requestId: m.requestId, preview: m.preview ?? preview(m.text), at: m.at, state: m.state as State | 'receiving',
      ...(m.files ? { files: m.files.map((f, i) => ({ name: f.name, size: f.size, type: f.type, transferred: m.state === 'pending' ? this.progress.get(peerId)?.get(m.requestId)?.[i] ?? 0 : m.fileError ? 0 : f.size })) } : {}),
      ...(m.fileError ? { fileError: fileErrorText[m.fileError] } : {})
    }))
    for (const m of await this.files.incomplete(peerId)) recent.push({ requestId: m.requestId, preview: '', at: m.at, state: 'receiving',
      files: m.files.map((f, i) => ({ name: f.name, size: f.size, type: f.type, transferred: m.offsets[i] })) })
    return { pendingMessages: own.filter(m => m.state === 'pending').length,
      recentMessages: recent.sort((a, b) => b.at.localeCompare(a.at)).slice(0, maxRecent) }
  }

  async send(peerId: string, input: unknown) {
    const raw = object(input), key = requestId(raw.requestId), records = await this.data()
    const prior = records.find(r => r.requestId === key && r.state !== 'received')
    const pending = records.filter(r => r.state === 'pending')
    const own = pending.filter(r => r.peerId === peerId)
    if (!prior && own.length >= maxPending) fail('此连接待送达的消息已达上限，原记录已保留')
    const body = raw.files !== undefined && (raw.text === undefined || raw.text === '') ? '' : text(raw.text, '消息正文', maxMessageLength)
    if (!prior && pending.reduce((bytes, r) => bytes + bodyBytes(r.text!), bodyBytes(body)) > maxPendingBytes) fail('工作间待送达的消息已达容量上限，原记录已保留')
    const staged = raw.files === undefined ? undefined : await this.files.stage(peerId, raw.files,
      prior ? 0 : own.reduce((n, r) => n + (r.files?.reduce((size, f) => size + f.size, 0) ?? 0), 0))
    let saved = false
    try {
      const hash = fingerprint(staged ? [peerId, body, staged.files] : [peerId, body])
      if (prior) {
        if (prior.hash !== hash) fail('消息编号已用于其他内容')
        return
      }
      records.push({ requestId: key, text: body, peerId, hash, at: new Date().toISOString(), state: 'pending', ...staged })
      await this.save(records)
      saved = true
    } finally { if (staged && !saved) await this.files.discard(peerId, staged.spool) }
  }

  async pending(peerId: string): Promise<WireMessage[]> {
    return (await this.data()).filter(m => m.peerId === peerId && m.state === 'pending').map(m => ({ requestId: m.requestId, text: m.text!, ...(m.files ? { files: m.files } : {}) }))
  }

  async chunk(peerId: string, message: WireMessage) {
    const row = (await this.data()).find(m => m.peerId === peerId && m.requestId === message.requestId && m.state === 'pending')
    if (row?.files && row.spool) return this.files.chunk(peerId, row.spool, row.files, this.progress.get(peerId)?.get(row.requestId) ?? row.files.map(() => 0))
  }

  async receive(peerId: string, raw: unknown, enqueue: (messages: IncomingMessage[]) => Promise<void>, workspaceId = peerId) {
    const wire = object(raw)
    if (!Array.isArray(wire.messages) || wire.messages.length > maxPending || !Array.isArray(wire.received) || wire.received.length > maxPending) fail('工作间消息格式不正确')
    const messages = wire.messages.map(message) as WireMessage[]
    const extra = (key: string): unknown[] => {
      const list = wire[key] ?? []
      if (!Array.isArray(list) || list.length > maxPending) fail('工作间文件回执不正确')
      return list
    }
    const offsets = extra('progress').map(raw => {
      const { requestId: key, offsets } = object(raw)
      if (!Array.isArray(offsets) || offsets.length > maxLinkFiles || offsets.some(n => !Number.isSafeInteger(n) || n < 0)) fail('工作间文件进度不正确')
      return { requestId: requestId(key), offsets: offsets as number[] }
    })
    const refused = new Map(extra('rejected').map(raw => {
      const { requestId: key, reason } = object(raw)
      if (reason !== 'capacity' && reason !== 'checksum') fail('工作间文件回执不正确')
      return [requestId(key), reason as FileError] as const
    }))
    const received = new Set(wire.received.map(requestId))
    const records = await this.data(), additions: IncomingMessage[] = [], cleanup: string[] = []
    const result: Omit<MessageExchange, 'messages'> = { received: [] }
    const progress = new Map(this.progress.get(peerId))
    let more = false
    let changed = false
    for (const m of messages) {
      const hash = incomingHash(m)
      const prior = records.find(r => r.peerId === peerId && r.requestId === m.requestId && r.state === 'received')
      if (prior && prior.hash !== hash) fail('对端消息编号重复且正文不同')
      let fileError = prior?.fileError, attachments: ReceivedFile[] | undefined
      if (!prior && m.files) {
        const transfer = await this.files.receive(peerId, workspaceId, m.requestId, hash, m.files, m.chunk)
        if ('offsets' in transfer) {
          (result.progress ??= []).push({ requestId: m.requestId, offsets: transfer.offsets })
          continue
        }
        if ('error' in transfer) fileError = transfer.error
        else attachments = transfer.files
      }
      if (!prior) {
        const { chunk, ...body } = m
        const files = attachments?.map(({ path, ...f }) => f) ?? (m.files && safeFiles(m.files))
        additions.push({ ...body, ...(attachments ? { attachments } : {}), ...(fileError ? { fileError } : {}) })
        records.push({ ...body, ...(files ? { files } : {}), ...(fileError ? { fileError } : {}), peerId, hash, at: new Date().toISOString(), state: 'received' })
      }
      if (fileError) {
        const rejects = result.rejected ??= []
        if (!rejects.some(r => r.requestId === m.requestId)) rejects.push({ requestId: m.requestId, reason: fileError })
      } else if (!result.received.includes(m.requestId)) result.received.push(m.requestId)
    }
    for (const r of records) if (r.peerId === peerId && r.state === 'pending') {
      const reason = r.files && refused.get(r.requestId)
      if (reason || received.has(r.requestId)) {
        r.state = reason ? 'failed' : 'delivered'
        if (reason) r.fileError = reason
        if (r.spool) { cleanup.push(r.spool); delete r.spool }
        progress.delete(r.requestId)
        changed = true
      } else if (r.files) {
        const next = offsets.find(entry => entry.requestId === r.requestId)?.offsets
        if (next && (next.length !== r.files.length || next.some((n, i) => n > r.files![i].size))) fail('工作间文件进度不正确')
        if (next) {
          const previous = progress.get(r.requestId)
          more ||= !previous || next.some((n, i) => n !== previous[i])
          progress.set(r.requestId, next)
        }
      }
    }
    if (additions.length || changed) {
      if (additions.length) await enqueue(additions)
      await this.save(records)
    }
    if (progress.size) this.progress.set(peerId, progress)
    else this.progress.delete(peerId)
    for (const spool of cleanup) await this.files.discard(peerId, spool)
    return { ...result, more: more || changed && records.some(r => r.peerId === peerId && r.state === 'pending') }
  }

  async revoke(peerId: string) {
    const records = await this.data(), kept = records.filter(m => m.peerId !== peerId)
    if (kept.length !== records.length) await this.save(kept)
    this.progress.delete(peerId)
    await this.files.revoke(peerId)
  }
}
