import { Client, EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk'
import { readFile, realpath, stat } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { lookup } from 'node:dns'
import { isIP } from 'node:net'
import type { Project, SourceEvent, ConnectionState, Delivery } from './model'
import { artifactUrl, fail, fingerprint, workspaceNotices } from './store'

const imageLimit = 10 * 1024 * 1024
export function publicImageAddress(address: string): boolean {
  if (isIP(address) === 6) return /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(db8|0):/i.test(address)
  if (isIP(address) !== 4) return false
  const [a, b, c] = address.split('.').map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 100 && b >= 64 && b <= 127 || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99) || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113)
}
async function downloadImage(url: string, redirects = 0): Promise<Buffer> {
  const parsed = new URL(url)
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || redirects > 3) fail('图片链接不可用')
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && !publicImageAddress(host)) fail('图片地址不允许')
  return new Promise((resolve, reject) => {
    const req = (parsed.protocol === 'https:' ? https : http).get(parsed, {
      // Resolve and validate in the socket lookup to prevent DNS rebinding into local services.
      lookup(hostname, options, callback) {
        lookup(hostname, { all: true }, (error, addresses) => {
          if (error || !addresses.length || addresses.some(a => !publicImageAddress(a.address))) { (callback as any)(new Error('图片地址不允许')); return }
          if (options.all) (callback as any)(null, addresses)
          else (callback as any)(null, addresses[0].address, addresses[0].family)
        })
      }, timeout: 10000
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
        res.destroy(); void downloadImage(new URL(res.headers.location, parsed).href, redirects + 1).then(resolve, reject); return
      }
      if (res.statusCode !== 200 || !res.headers['content-type']?.startsWith('image/')) { res.destroy(); reject(new Error('图片下载失败')); return }
      const chunks: Buffer[] = []; let size = 0
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > imageLimit) res.destroy(new Error('图片超过 10 MB')); else chunks.push(chunk) })
      res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('图片下载超时'))); req.on('error', reject)
  })
}
async function imageBytes(url: string, root?: string): Promise<Buffer> {
  if (/^https?:/i.test(url)) {
    return downloadImage(url)
  }
  if (!root) fail('图片缺少项目路径')
  const base = await realpath(root), file = await realpath(url)
  artifactUrl(file, base)
  const info = await stat(file)
  if (!info.isFile() || info.size > imageLimit) fail('图片文件不可用或超过 10 MB')
  const bytes = await readFile(file)
  if (bytes.length > imageLimit) fail('图片超过 10 MB')
  return bytes
}

export interface MessageTransport {
  state(appId: string): ConnectionState
  sync(projects: Project[], secret: (id: string) => Promise<string | null>): Promise<void>
  send(delivery: Delivery): Promise<string>
  stop(): void
}

export function notifyFeishu(before: Project, after: Project, config: Project['feishu']): void {
  if (!config.enabled || after.hidden) return
  const prior = new Set(workspaceNotices(before).map(n => fingerprint(n.key)))
  for (const n of workspaceNotices(after)) {
    if (prior.has(fingerprint(n.key))) continue
    const [, kind, itemId] = n.key
    const d = kind === 'decision' ? n.task.decisions.find(d => d.id === itemId) : undefined
    const a = kind === 'review' ? n.task.acceptance.find(a => a.id === itemId) : undefined
    const target = d || a ? { projectId: after.ref.id, taskId: n.task.id, kind: d ? 'decision' as const : 'acceptance' as const,
      itemId: String(itemId), itemRevision: a?.revision ?? 1, fingerprint: a?.fingerprint ?? fingerprint([d!.question, d!.options]) } : undefined
    const artifacts = a ? n.task.artifacts.filter(x => a.artifactIds.includes(x.id)) : n.task.artifacts
    const details = d ? `${d.question}\n${d.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n回复此提醒：选项编号、完整选项或「决定：你的决定」。`
      : a ? `${a.title} · 第 ${a.revision} 版\n${a.details}\n回复此提醒：「通过」或「修改：具体意见」。` : n.action
    for (const chatId of config.chatIds) {
      const id = `feishu:${fingerprint([config.appId, chatId, n.key])}`
      if (!after.deliveries.some(x => x.id === id)) after.deliveries.push({ id, subject: `${after.ref.name} · ${n.task.title}`,
        body: `${details}\n[项目 ${after.ref.id} / 任务 ${n.task.id}]`, state: 'pending',
        external: { channel: 'feishu', appId: config.appId, chatId, ...(target ? { target } : {}), artifacts, root: after.ref.path } })
    }
  }
}

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
    chatId: message.chat_id, senderId, text: messageText.slice(0, 20000), receivedAt: new Date().toISOString(),
    replyToIds: [...new Set([message.parent_id, message.root_id].filter((x): x is string => typeof x === 'string' && !!x))]
  }
}

export class FeishuSources implements MessageTransport {
  private clients = new Map<string, { client: WSClient; api: Client; signature: string; state: ConnectionState }>()
  constructor(private receive: (appId: string, event: SourceEvent) => Promise<void>, private changed: () => void, private loadImage = imageBytes) {}
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
      this.clients.set(appId, { client, api: new Client({ appId, appSecret: value, logger: quiet }), state, signature: fingerprint(value) })
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
  async send(delivery: Delivery): Promise<string> {
    const target = delivery.external!, api = this.clients.get(target.appId)?.api
    if (!api) fail('飞书应用未连接，消息保留待核对')
    const rows: any[][] = [[{ tag: 'text', text: delivery.body }]]
    for (const a of target.artifacts ?? []) {
      const remote = /^https?:/i.test(a.url)
      rows.push([remote ? { tag: 'a', text: `${a.label} · ${a.version}`, href: a.url } : { tag: 'text', text: `${a.label} · ${a.version}：在 App 里查看` }])
      if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(remote ? new URL(a.url).pathname : a.url)) continue
      try {
        const uploaded = await api.im.image.create({ data: { image_type: 'message', image: await this.loadImage(a.url, target.root) } })
        if (!uploaded?.image_key) throw new Error('image upload')
        rows.push([{ tag: 'img', image_key: uploaded.image_key }])
      } catch { rows.push([{ tag: 'text', text: '图片未能上传，请在 App 里查看。' }]) }
    }
    const data = { msg_type: 'post', content: JSON.stringify({ zh_cn: { title: delivery.subject, content: rows } }), uuid: fingerprint(delivery.id).slice(0, 32) }
    try {
      const result = target.replyTo ? await api.im.message.reply({ path: { message_id: target.replyTo }, data })
        : await api.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { ...data, receive_id: target.chatId } })
      if (result.code !== 0 || !result.data?.message_id) throw new Error('send')
      return result.data.message_id
    } catch { throw new Error('飞书发送结果待核对，请检查应用、权限和网络；不会自动重发') }
  }
  stop(): void { for (const { client } of this.clients.values()) client.close({ force: true }); this.clients.clear() }
}
