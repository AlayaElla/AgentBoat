import { EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk'
import type { Project, SourceEvent, ConnectionState } from './model'
import { fingerprint } from './store'

export function normalizeFeishu(appId: string, data: any): SourceEvent | null {
  const message = data?.message
  const senderId = data?.sender?.sender_id?.open_id
  if (data?.sender?.sender_type !== 'user' || !senderId || !message?.message_id || !message?.chat_id) return null
  let content: any
  try { content = JSON.parse(message.content) } catch { return null }
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null
  let messageText = ''
  if (message.message_type === 'text') messageText = typeof content.text === 'string' ? content.text : ''
  else if (message.message_type === 'post') {
    const post = content.content ? content : Object.values(content).find((x: any) => x?.content) as any
    const rows = Array.isArray(post?.content) ? post.content : []
    messageText = [typeof post?.title === 'string' ? post.title : '', ...rows.flat().map((x: any) => x?.text ?? x?.image_key ?? x?.file_key ?? '')].join('\n')
  } else messageText = `[${message.message_type}消息]\n${JSON.stringify(content)}`
  if (!messageText.trim()) return null
  return {
    id: `feishu:${fingerprint([appId, message.message_id]).slice(0, 24)}`,
    source: 'feishu', sourceId: `${appId}/${message.message_id}`,
    threadId: `${appId}/${message.root_id || message.thread_id || message.parent_id || message.message_id}`,
    chatId: message.chat_id, senderId, text: messageText.slice(0, 20000), receivedAt: new Date().toISOString()
  }
}

export class FeishuSources {
  private clients = new Map<string, { client: WSClient; signature: string; state: ConnectionState }>()
  constructor(private receive: (appId: string, event: SourceEvent) => Promise<void>, private changed: () => void) {}
  state(appId: string): ConnectionState { return this.clients.get(appId)?.state ?? { state: 'off', message: '' } }
  async sync(projects: Project[], secret: (id: string) => Promise<string | null>): Promise<void> {
    const wanted = new Map<string, string>()
    for (const p of projects.filter(x => x.feishu.enabled)) {
      const value = await secret(p.ref.id)
      if (!value || !p.feishu.appId) continue
      const previous = wanted.get(p.feishu.appId)
      if (previous && previous !== value) throw new Error('共用同一个飞书应用的项目需要使用相同凭据')
      wanted.set(p.feishu.appId, value)
    }
    for (const [id, entry] of this.clients) {
      const value = wanted.get(id)
      if (!value || entry.signature !== fingerprint(value)) { entry.client.close({ force: true }); this.clients.delete(id) }
    }
    for (const [appId, value] of wanted) {
      if (this.clients.has(appId)) continue
      const state: ConnectionState = { state: 'connecting', message: '' }
      const change = (next: ConnectionState) => { Object.assign(state, next); this.changed() }
      const quiet = { error() {}, warn() {}, info() {}, debug() {}, trace() {} }
      const client = new WSClient({ appId, appSecret: value, loggerLevel: LoggerLevel.error, logger: quiet,
        onReady: () => change({ state: 'connected', message: '' }),
        onReconnected: () => change({ state: 'connected', message: '' }),
        onReconnecting: () => change({ state: 'connecting', message: '正在重连' }),
        onError: () => change({ state: 'error', message: '飞书连接失败，请检查应用凭据、网络和事件订阅设置' })
      })
      this.clients.set(appId, { client, state, signature: fingerprint(value) })
      void client.start({ eventDispatcher: new EventDispatcher({ loggerLevel: LoggerLevel.error, logger: quiet }).register({
        'im.message.receive_v1': async (data: any) => {
          const event = normalizeFeishu(appId, data)
          if (event) {
            try { await this.receive(appId, event) }
            catch {
              change({ state: 'error', message: '新消息未能保存，请检查项目容量或 Orca 存储；已有记录已保留' })
              throw new Error('项目消息保存失败')
            }
          }
          return {}
        }
      }) }).catch(() => change({ state: 'error', message: '飞书连接未建立，请检查应用配置' }))
    }
    this.changed()
  }
  stop(): void { for (const { client } of this.clients.values()) client.close({ force: true }); this.clients.clear() }
}
