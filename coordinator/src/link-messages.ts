import type { StorageApi } from 'orca'
import { fail, fingerprint, maxMessageLength, object, text } from './store'

const maxPending = 10
const maxRecent = 10
export const linkMessageHistory = 50
const maxPendingBytes = 150_000
const storageKey = 'workspace.link-messages'

export interface WireMessage { requestId: string; text: string }
export interface MessageExchange { messages: WireMessage[]; received: string[] }
type State = 'pending' | 'delivered' | 'received'
type Message = {
  peerId: string; requestId: string; hash: string; at: string; state: State; text?: string; preview?: string
}

const preview = (body = '') => [...body].slice(0, 200).join('')
const bodyBytes = (body: string) => Buffer.byteLength(JSON.stringify(body)) - 2
const requestId = (value: unknown) => text(value, '消息编号', 64)
function message(value: unknown): WireMessage {
  const m = object(value)
  return { requestId: requestId(m.requestId), text: text(m.text, '消息正文', maxMessageLength) }
}

// All reads and writes are serialized by WorkspaceLinks.
export class LinkMessages {
  constructor(private storage: Pick<StorageApi, 'get' | 'set'>) {}

  async data(): Promise<Message[]> {
    const raw = await this.storage.get(storageKey)
    if (raw === null || raw === undefined) return []
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
    await this.storage.set(storageKey, this.compact(records))
  }

  summarize(records: Message[], peerId: string) {
    const own = records.filter(m => m.peerId === peerId)
    return { pendingMessages: own.filter(m => m.state === 'pending').length,
      recentMessages: own.slice(-maxRecent).reverse().map(m => ({ requestId: m.requestId, preview: m.preview ?? preview(m.text), at: m.at, state: m.state })) }
  }

  async send(peerId: string, input: unknown) {
    const m = message(input), records = await this.data(), hash = fingerprint([peerId, m.text])
    const prior = records.find(r => r.requestId === m.requestId && r.state !== 'received')
    if (prior) {
      if (prior.hash !== hash) fail('消息编号已用于其他内容')
      return
    }
    const pending = records.filter(r => r.state === 'pending')
    if (pending.filter(r => r.peerId === peerId).length >= maxPending) fail('此连接待送达的消息已达上限，原记录已保留')
    if (pending.reduce((bytes, r) => bytes + bodyBytes(r.text!), bodyBytes(m.text)) > maxPendingBytes) fail('工作间待送达的消息已达容量上限，原记录已保留')
    records.push({ ...m, peerId, hash, at: new Date().toISOString(), state: 'pending' })
    await this.save(records)
  }

  async pending(peerId: string): Promise<WireMessage[]> {
    return (await this.data()).filter(m => m.peerId === peerId && m.state === 'pending').map(m => ({ requestId: m.requestId, text: m.text! }))
  }

  async receive(peerId: string, raw: unknown, enqueue: (messages: WireMessage[]) => Promise<void>) {
    const wire = object(raw)
    if (!Array.isArray(wire.messages) || wire.messages.length > maxPending || !Array.isArray(wire.received) || wire.received.length > maxPending) fail('工作间消息格式不正确')
    const messages = wire.messages.map(message) as WireMessage[]
    const received = new Set(wire.received.map(requestId))
    const records = await this.data(), additions: WireMessage[] = []
    let changed = false
    for (const m of messages) {
      const hash = fingerprint(m.text)
      const prior = records.find(r => r.peerId === peerId && r.requestId === m.requestId && r.state === 'received')
      if (prior) {
        if (prior.hash !== hash) fail('对端消息编号重复且正文不同')
      } else {
        additions.push(m)
        records.push({ ...m, peerId, hash, at: new Date().toISOString(), state: 'received' })
      }
    }
    for (const r of records) if (r.peerId === peerId && r.state === 'pending' && received.has(r.requestId)) { r.state = 'delivered'; changed = true }
    if (additions.length || changed) {
      if (additions.length) await enqueue(additions)
      await this.save(records)
    }
    return [...new Set(messages.map(m => m.requestId))]
  }

  async revoke(peerId: string) {
    const records = await this.data(), kept = records.filter(m => m.peerId !== peerId)
    if (kept.length !== records.length) await this.save(kept)
  }
}
