import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import path from 'node:path'
import { activeUserDataPath, pluginDataPath } from '../scripts/orca-cli.mjs'
import type { BotBinding, BotTarget } from './model'
import { updateBotSoul } from './bot-soul'

type Call = (args: string[]) => Promise<any>
type Rpc = (method: 'bots.list' | 'bots.agentChoices' | 'agentSession.createSupport' | 'bots.session.start', params?: object) => Promise<any>
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
    const { bots, botsEnabled } = await this.rpc('bots.list')
    if (!Array.isArray(bots)) throw Error('本机 bot 列表不完整')
    const local = bots.filter(b => b.hostId === 'local' && !b.paused)
    if (botsEnabled === false || !local.length) return []
    const agents = await this.agentChoices()
    return Promise.all(local.map(async row => ({ ...target(row), agents: await this.available(row.folderWorkspaceId, agents) })))
  }
  private async agentChoices(): Promise<string[]> {
    const { agents } = await this.rpc('bots.agentChoices')
    if (!Array.isArray(agents) || agents.some(agent => typeof agent !== 'string' || !agent)) throw Error('Orca bot 代理列表不完整')
    return [...new Set(agents)]
  }
  private async available(folder: unknown, agents: string[]) {
    if (typeof folder !== 'string' || !folder) return []
    const checks = await Promise.all(agents.map(async agent => {
      const result = await this.rpc('agentSession.createSupport', { worktree: 'folder:' + folder, agent }).catch(() => undefined)
      return result?.supported === true ? agent : ''
    }))
    return checks.filter(Boolean)
  }
  private async record(id: string) {
    const { bots, botsEnabled } = await this.rpc('bots.list')
    return botsEnabled === false ? undefined : bots.find((b: any) => b.id === id && b.hostId === 'local')
  }
  async choices(bot: BotTarget) {
    const row = await this.record(bot.id)
    if (!row || row.paused || row.agent !== bot.agent) throw Error('bot 已暂停或发生变化')
    return this.available(row.folderWorkspaceId, await this.agentChoices())
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
  private async chats(bot: BotTarget): Promise<{ id: string; home: boolean; closed: boolean }[]> {
    const result = await this.call(['bot', 'chats', '--bot', bot.id])
    if (!Array.isArray(result.chats)) throw Error('bot 对话列表无法核对')
    return result.chats.filter((c: any) => c.closed === false)
  }
  async home(bot: BotTarget) {
    const homes = (await this.chats(bot)).filter(c => c.home === true)
    if (!homes.length) return
    const handle = 'orca_session_id:' + homes[0].id
    if (homes.length !== 1 || !botHomeHandle(handle)) throw Error('bot 主对话标识无效')
    return handle
  }
  async hasSideChat(bot: BotTarget, handle: string) {
    return botHomeHandle(handle) && (await this.chats(bot)).some(c => c.home === false && 'orca_session_id:' + c.id === handle)
  }
  async startChat(bot: BotTarget, agent: string) {
    if (!(await this.choices(bot)).includes(agent)) throw Error('该代理在所选 bot 中不可用')
    // The Home Chat reset retires its previous session and drops unread bot requests.
    const result = await this.rpc('bots.session.start', { botId: bot.id, agent })
    const handle = 'orca_session_id:' + result.sessionId
    if (!botHomeHandle(handle) || !await this.hasSideChat(bot, handle)) throw Error('请在 Orca 核对 bot 对话的启动回执')
    return handle
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
