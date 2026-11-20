import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'
import { activeUserDataPath, pluginDataPath } from '../scripts/orca-cli.mjs'
import type { BotBinding, BotTarget } from './model'
import { updateBotSoul } from './bot-soul'

type Call = (args: string[]) => Promise<any>
type Rpc = (method: 'bots.list' | 'bots.update', params?: object) => Promise<any>
export const botHomeHandle = (value: unknown): value is string =>
  typeof value === 'string' && /^orca_session_id:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)

export function localEndpoint(transports: unknown, platform = process.platform): string {
  const windows = platform === 'win32'
  const kind = windows ? 'named-pipe' : 'unix'
  const endpoint = Array.isArray(transports) && transports.find(t => t?.kind === kind)?.endpoint
  if (typeof endpoint !== 'string' || endpoint.includes('\0') ||
      !(windows ? endpoint.startsWith('\\\\.\\pipe\\') : path.posix.isAbsolute(endpoint))) throw Error('本机 Orca 通道不可用')
  return endpoint
}

async function localRpc(method: Parameters<Rpc>[0], params?: object) {
  let metadata
  try { metadata = JSON.parse(await readFile(path.join(activeUserDataPath(), 'orca-runtime.json'), 'utf8')) }
  catch { throw Error('本机 Orca 通道配置不可用') }
  const endpoint = localEndpoint(metadata?.transports)
  if (typeof metadata.authToken !== 'string' || !metadata.authToken) throw Error('本机 Orca 通道不可用')
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint), id = randomUUID()
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
  constructor(private call: Call, private rpc: Rpc = localRpc, private data = pluginDataPath()) {}
  async list(): Promise<BotTarget[]> {
    const { bots } = await this.call(['bot', 'list'])
    if (!Array.isArray(bots)) throw Error('本机 bot 列表不完整')
    return bots.filter(b => !b.server && (!b.hostId || b.hostId === 'local')).map(target)
  }
  private async record(id: string) {
    return (await this.rpc('bots.list')).bots.find((b: any) => b.id === id && b.hostId === 'local')
  }
  async find(id: string) {
    const bot = await this.record(id)
    return bot ? target(bot) : undefined
  }
  async writeSoul(bot: BotTarget, spaces: { botHomeKey?: string; path: string }[], prior?: BotBinding['soul']) {
    const row = await this.record(bot.id)
    if (!row || row.paused || row.agent !== bot.agent || !row.folderWorkspaceId) throw Error('无法核对 bot 家目录，请刷新本机 bot 列表')
    const homes = spaces.filter(s => s.botHomeKey === 'folder:' + row.folderWorkspaceId)
    if (homes.length !== 1) throw Error('找不到唯一的 bot 家目录，请检查 Orca 中该 bot 的工作区')
    const home = homes[0].path
    return updateBotSoul(bot.id, home, this.data, target(row).name, prior)
  }
  async removeSoul(bot: BotBinding, home?: string) {
    const folder = bot.soul?.home ?? home
    if (!folder) throw Error('请手动核对旧 bot 的家目录和 SOUL.md')
    await updateBotSoul(bot.id, folder, this.data, undefined, bot.soul)
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
    const result = await this.call(['bot', 'new-chat', '--bot', id])
    const handle = 'orca_session_id:' + result.sessionId
    if (!botHomeHandle(handle)) throw Error('请在 Orca 核对新开的 bot 主对话')
    return handle
  }
  async original(bot: BotTarget) {
    const full = await this.record(bot.id)
    if (!full || full.paused !== false || full.agent !== bot.agent) throw Error('bot 已暂停或发生变化')
    if (full.launch != null && (typeof full.launch !== 'object' || Array.isArray(full.launch))) throw Error('bot 启动设置无法核对')
    return { agent: bot.agent, ...(full.launch ? { launch: full.launch as Record<string, unknown> } : {}) }
  }
  async update(bot: BotTarget, agent: string, launch?: Record<string, unknown>, expected?: Awaited<ReturnType<LocalBots['original']>>) {
    if (!['claude', 'codex'].includes(agent)) throw Error('不支持此 agent')
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
