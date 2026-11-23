import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BotBinding } from './model'

const heading = '## AgentBoat 工作间管理员'
const start = '<!-- agentboat:workspace-main:start -->'
const end = '<!-- agentboat:workspace-main:end -->'
export const workspaceSoul = '你是本机 AgentBoat 工作间管理员。每次接管先读 $agentboat-workspace 和工作间 overview，从插件记录恢复待办、项目和执行者进度。收到接管 handoff 时按消息中的一次性命令接回协调 Run，凭据只用于本次接管。主人的待决定和验收放到 AgentBoat 面板，项目实施交给项目主会话，长期结论记入 AgentBoat 的工作间记忆。收到进展摘要时按需参考。插件收到额度用完的回执时会切换工作间使用的代理。若切换失败或工作间对话停住，等待主人按面板通知处理。'
type Soul = NonNullable<BotBinding['soul']>

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
function edit(original: string, name: string | undefined, receipt: Soul) {
  const bom = original.startsWith('\uFEFF') ? '\uFEFF' : ''
  const text = original.slice(bom.length)
  const nl = text.match(/\r?\n/)?.[0] ?? '\n'
  const body = [start, '', workspaceSoul, '', end].join(nl)
  const from = text.indexOf(start), to = text.indexOf(end)
  if (from !== -1 || to !== -1) {
    if (from < 0 || to <= from || from !== text.lastIndexOf(start) || to !== text.lastIndexOf(end) ||
        ![start, end].every(marker => text.split(/\r?\n/).includes(marker))) {
      throw Error('段落标记不完整或重复，请手动核对开始和结束标记')
    }
    let before = text.slice(0, from)
    const after = text.slice(to + end.length)
    if (name !== undefined) return bom + before + body + after
    before = before.replace(/(^|\n)## AgentBoat 工作间管理员\r?\n$/, '$1')
    if (receipt.padding && digest(before) === receipt.padding.prefix) before = before.slice(0, -receipt.padding.length)
    return bom + before + after
  }
  if (name === undefined) return original
  const section = heading + nl + body
  if (!text || /^# ([^\r\n]+)\n\nDescribe \1 here: what it is for, how it talks, and what it must never do\.\n$/.test(text.replaceAll('\r\n', '\n'))) {
    return bom + '# ' + name + nl + nl + section + nl
  }
  const padding = text.endsWith(nl + nl) ? '' : text.endsWith(nl) ? nl : nl + nl
  if (padding) receipt.padding = { prefix: digest(text + padding), length: padding.length }
  return bom + text + padding + section
}

async function readSoul(file: string) {
  try {
    if (!(await lstat(file)).isFile()) throw Error('请核对文件类型，职责说明必须是普通文件')
    const bytes = await readFile(file)
    const text = bytes.toString('utf8')
    if (!Buffer.from(text).equals(bytes)) throw Error('文件编码不是 UTF-8，请手动核对')
    return text
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

export async function updateBotSoul(id: string, home: string, data: string, name?: string, prior?: Soul): Promise<Soul> {
  const file = path.join(home, 'SOUL.md'), receipt: Soul = { ...prior, home }
  try {
    if (!path.isAbsolute(home)) throw Error('请核对 bot 家目录')
    const folder = await lstat(home).catch(e => {
      if (name !== undefined || e.code !== 'ENOENT') throw e
    })
    if (!folder) return receipt
    if (!folder.isDirectory()) throw Error('请核对 bot 家目录')
    const checkOwner = async () => {
      if (JSON.parse(await readFile(path.join(home, 'bot.json'), 'utf8')).id !== id) throw Error('bot.json 的 ID 与选中的 bot 不符，请核对家目录')
    }
    await checkOwner()
    const original = await readSoul(file)
    const next = edit(original ?? '', name, receipt)
    if (original !== undefined && (original !== next || name !== undefined && !prior)) {
      const dir = path.join(data, 'bot-soul-backups')
      await mkdir(dir, { recursive: true })
      receipt.backup = path.join(dir, randomUUID() + '.md')
      await writeFile(receipt.backup, original, { flag: 'wx', mode: 0o600, flush: true })
    }
    if (next === (original ?? '')) return receipt
    const temp = path.join(home, '.SOUL-' + randomUUID())
    try {
      await writeFile(temp, next, { flag: 'wx', mode: 0o600, flush: true })
      await checkOwner()
      if (await readSoul(file) !== original) throw Error('文件刚被修改，请重新核对')
      if (original === undefined) await link(temp, file)
      else await rename(temp, file)
    } finally { await rm(temp, { force: true }) }
    return receipt
  } catch (e) {
    throw Error(`请检查 bot ${id} 的职责说明 ${file}：${(e as Error).message}`)
  }
}
