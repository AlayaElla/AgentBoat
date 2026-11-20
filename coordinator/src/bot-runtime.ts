import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'
import { activeUserDataPath } from '../scripts/orca-cli.mjs'
import type { BotTarget } from './model'

type Call = (args: string[]) => Promise<any>
type Rpc = (method: 'bots.list' | 'bots.update', params?: object) => Promise<any>
export const botHomeHandle = (value: unknown): value is string =>
  typeof value === 'string' && /^orca_session_id:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)

async function localRpc(method: Parameters<Rpc>[0], params?: object) {
  let metadata
  try { metadata = JSON.parse(await readFile(path.join(activeUserDataPath(), 'orca-runtime.json'), 'utf8')) }
  catch { throw Error('本机 Orca 通道配置不可用') }
  const pipe = metadata.transports?.find((t: any) => t.kind === 'named-pipe')?.endpoint
  if (typeof pipe !== 'string' || !pipe.startsWith('\\\\.\\pipe\\') || !metadata.authToken) throw Error('本机 Orca 通道不可用')
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipe), id = randomUUID()
    const abort = () => { socket.destroy(); reject(Error(method + ' 本机调用未确认')) }
    const timer = setTimeout(abort, 15000)
    socket.once('error', abort).once('close', () => { clearTimeout(timer); reject(Error(method + ' 通道已关闭')) })
    socket.once('connect', () => socket.write(JSON.stringify({ id, authToken: metadata.authToken, method, params }) + '\n'))
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      if (buffer.length > 8 * 1024 * 1024) return abort()
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        try {
          const frame = JSON.parse(line)
          if (frame.id !== id) continue
          if (!frame.ok) return abort()
          resolve(frame.result); socket.destroy(); return
        } catch { return abort() }
      }
    })
  })
}

function target({ id, name, agent, paused }: BotTarget): BotTarget {
  if (![id, name, agent].every(v => typeof v === 'string' && v.length) || typeof paused !== 'boolean') throw Error('bot 记录不完整')
  return { id, name, agent, paused }
}

export class LocalBots {
  constructor(private call: Call, private rpc: Rpc = localRpc, private enabled = process.platform === 'win32') {}
  async list(): Promise<BotTarget[]> {
    if (!this.enabled) throw Error('此机器使用会话绑定')
    const { bots } = await this.call(['bot', 'list'])
    if (!Array.isArray(bots)) throw Error('本机 bot 列表不完整')
    return bots.filter(b => !b.server && (!b.hostId || b.hostId === 'local')).map(target)
  }
  private async record(id: string) {
    if (!this.enabled) throw Error('本机不支持 bot 切换')
    return (await this.rpc('bots.list')).bots.find((b: any) => b.id === id && b.hostId === 'local')
  }
  async find(id: string) {
    const bot = await this.record(id)
    return bot ? target(bot) : undefined
  }
  async home(bot: BotTarget) {
    const result = await this.call(['bot', 'chats', '--bot', bot.id])
    if (!Array.isArray(result.chats)) throw Error('bot 主对话无法核对')
    const homes = result.chats.filter((c: any) => c.home === true && !c.closed)
    if (!homes.length) return
    const handle = 'orca_session_id:' + homes[0].id
    if (homes.length !== 1 || !botHomeHandle(handle)) throw Error('bot 主对话标识无效')
    return handle
  }
  async newHome(id: string) {
    if (!this.enabled) throw Error('本机不支持 bot 切换')
    await this.call(['bot', 'new-chat', '--bot', id])
  }
  async original(bot: BotTarget) {
    const full = await this.record(bot.id)
    if (!full || full.paused !== false || full.agent !== bot.agent) throw Error('bot 已暂停或发生变化')
    if (full.launch != null && (typeof full.launch !== 'object' || Array.isArray(full.launch))) throw Error('bot 启动设置无法核对')
    return { agent: bot.agent, ...(full.launch ? { launch: full.launch as Record<string, unknown> } : {}) }
  }
  async update(bot: BotTarget, agent: string, launch?: Record<string, unknown>, expected?: Awaited<ReturnType<LocalBots['original']>>) {
    if (!this.enabled || !['claude', 'codex'].includes(agent)) throw Error('不支持此 agent')
    const before = await this.original(bot)
    if (expected && !isDeepStrictEqual(before, expected)) throw Error('切换前 bot 启动设置已变化')
    await this.rpc('bots.update', { botId: bot.id, updates: { agent, ...(launch ? { launch } : {}) } })
    const current = (await this.list()).find(b => b.id === bot.id)
    if (!current || current.paused || current.agent !== agent) throw Error('agent 切换未确认')
    return current
  }
}

// Orca prints a local clock (with a day for future dates). Round-trip its locale;
// an unfamiliar clock leaves recovery manual.
function resetTime(clock: string, now: number) {
  if (clock.length > 100) return
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
  const dated = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const day = new Date(now)
  for (let d = 0; d <= 366; d++, day.setDate(day.getDate() + 1)) {
    const fmt = d ? dated : time
    // Match the date before enumerating minutes on a candidate day.
    if (d && !dated.formatToParts(day).filter(p => ['weekday','day','month'].includes(p.type)).every(p => clock.includes(p.value))) continue
    const start = new Date(day).setHours(0, 0, 0, 0), end = new Date(day).setHours(24, 0, 0, 0)
    for (let at = start; at < end; at += 60000) if (fmt.format(at) === clock && at >= now - 60000) return at

  }
}
export function quotaReceipt(result: any, home: string, now = Date.now()) {
  if (!Array.isArray(result?.warnings)) return
  const prefix = 'Queued. ' + home + ' stopped at its usage limit'
  const warning = result.warnings.find((w: any) => w?.code === 'recipient_delivery_held' && w.recipient === home && typeof w.message === 'string' && w.message.startsWith(prefix))
  if (!warning) return
  const tail = warning.message.slice(prefix.length)
  const scheduled = /^; Orca continues it at (.+), then delivers this\.$/.exec(tail)
  if (!scheduled && !/^( and Orca (has no reset time to promise|has not scheduled a continue for it|will not continue it on its own \([^)]+\))| while its workspace sleeps);/.test(tail)) return
  const recoveryAt = scheduled && resetTime(scheduled[1], now)
  return { home, ...(recoveryAt ? { recoveryAt } : {}) }
}
