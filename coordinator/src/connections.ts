import { randomUUID } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import { Butler, type ButlerInput, type ButlerSnapshot } from './butler'
import type { MessagingSnapshot } from './model'
import { fail, text } from './store'

export interface Connection { id: string; type: 'feishu' | 'a2a'; name: string; enabled: boolean; state: 'off' | 'connecting' | 'connected' | 'error' | 'unchecked'; message: string }
type Entry = Pick<Connection, 'id' | 'type' | 'name'>
export interface ConnectionsInput extends Omit<ButlerInput, 'operation'> { operation: 'read' | 'save' | 'delete' | 'check' | 'send' | 'reply'; connectionId?: string; name?: string; type?: Entry['type']; confirm?: boolean; includeApprovalMode?: boolean; feishu?: import('./model').FeishuConfig; appSecret?: string }
export interface ConnectionDetail { connection: Connection; a2a?: ButlerSnapshot; feishu?: MessagingSnapshot; approvalMode?: string }

export class Connections {
  private entries: Entry[] = []
  private instances = new Map<string, Butler>()
  private chain: Promise<unknown> = Promise.resolve()
  private started = false
  constructor(private api: Pick<OrcaWorkerApi, 'storage' | 'secrets'>, private main: () => Promise<string>, private notify: (run: string, id: string, body: string, name: string) => Promise<unknown>, private changed: () => void,
    private messaging: () => Promise<MessagingSnapshot>, private saveFeishu: (input: any) => Promise<MessagingSnapshot>, private deleteFeishu: () => Promise<void>) {}
  private async directory() {
    const saved = await this.api.storage.get('workspace.connections') as { version: number; entries: Entry[] } | null
    if (saved) {
      if (saved.version !== 1 || !Array.isArray(saved.entries) || saved.entries.some(e => !e.id || !e.name || !['a2a', 'feishu'].includes(e.type))) fail('外部连接目录不兼容，请保留数据并检查版本')
      this.entries = structuredClone(saved.entries)
    } else this.entries = []
    return this.entries
  }
  private save() { return this.api.storage.set('workspace.connections', { version: 1, entries: this.entries } as any) }
  private instance(e: Entry) {
    let b = this.instances.get(e.id)
    if (!b) {
      const name = () => this.entries.find(x => x.id === e.id)?.name || e.name
      b = new Butler(this.api, this.main, (run, id, body) => this.notify(run, id, body, name()), this.changed, e.id, name)
      this.instances.set(e.id, b)
    }
    return b
  }
  async list(): Promise<Connection[]> {
    const entries = await this.directory()
    return Promise.all(entries.map(async e => (await this.detail(e)).connection))
  }
  private async detail(e: Entry): Promise<ConnectionDetail> {
    if (e.type === 'feishu') {
      const m = await this.messaging()
      return { feishu: m, connection: { ...e, enabled: m.feishu.enabled, state: m.feishu.enabled ? m.connection.state : 'off', message: m.connection.message } }
    }
    const b = await this.instance(e).snapshot()
    return { a2a: b, connection: { ...e, enabled: b.enabled, state: !b.enabled ? 'off' : b.error ? 'error' : b.connection === '已连接' ? 'connected' : 'unchecked', message: b.error } }
  }
  handle(input: ConnectionsInput): Promise<Connection[] | ConnectionDetail> {
    const work = this.chain.then(async () => {
      if (input.operation === 'read' && !input.connectionId && !input.name) return this.list()
      const entries = await this.directory()
      let e = input.connectionId ? entries.find(e => e.id === input.connectionId) : entries.find(e => e.name === input.name)
      if (e && input.operation === 'save' && input.type && !input.connectionId) fail('连接名字不能重复')
      const creating = !e && input.operation === 'save' && !input.connectionId
      if (creating) {
        if (!['a2a', 'feishu'].includes(input.type || '')) fail('请选择连接类型')
        if (input.type === 'feishu' && entries.some(e => e.type === 'feishu')) fail('已经有飞书连接')
        e = { id: input.type === 'feishu' ? 'feishu' : randomUUID(), type: input.type!, name: text(input.name, '名字', 100) }
      }
      if (!e) fail('外部连接不存在，请核对名字')
      if (input.operation === 'delete') {
        if (input.confirm !== true) fail('请确认删除这个连接的设置、凭据和往来记录')
        if (e.type === 'feishu') await this.deleteFeishu()
        else {
          const b = this.instance(e), s = await b.snapshot()
          await b.handle({ operation: 'save', revision: s.revision, enabled: false, port: s.port, url: s.url })
          b.stop(); await this.api.storage.delete(`workspace.a2a:${e.id}`)
          await this.api.secrets.delete(`${e.id}:inbound`); await this.api.secrets.delete(`${e.id}:outbound`); this.instances.delete(e.id)
        }
        this.entries = entries.filter(x => x.id !== e!.id); await this.save(); this.changed(); return this.list()
      }
      if (input.operation === 'save') {
        const name = text(input.name, '名字', 100)
        if (entries.some(x => x.id !== e!.id && x.name === name)) fail('连接名字不能重复')
        if (e.type === 'a2a') {
          for (const other of entries.filter(x => x.type === 'a2a' && x.id !== e!.id)) {
            const s = await this.instance(other).snapshot()
            if (input.port !== 0 && input.enabled && s.enabled && s.port === input.port) fail('监听端口已被另一个外部连接使用')
          }
          await this.instance(e).handle({ ...input, operation: 'save', revision: creating ? 0 : input.revision })
        } else await this.saveFeishu({ ...input, operation: 'save', revision: creating ? (await this.messaging()).revision : input.revision })
        e.name = name
        if (creating) entries.push(e)
        this.entries = entries; await this.save()
        if (creating && this.started && e.type === 'a2a') await this.instance(e).start()
        this.changed()
      } else if (input.operation !== 'read') {
        if (e.type !== 'a2a') fail('该操作只支持 A2A 连接')
        await this.instance(e).handle(input as ButlerInput)
      }
      return this.detail(e)
    })
    this.chain = work.catch(() => {}); return work
  }
  async start() { const entries = await this.directory(); this.started = true; for (const e of entries.filter(e => e.type === 'a2a')) await this.instance(e).start() }
  stop() { for (const b of this.instances.values()) b.stop() }
}
