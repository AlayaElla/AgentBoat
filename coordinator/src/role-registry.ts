import { botHomeHandle } from './bot-runtime'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { actingMain, backupInCharge, workspaceBackupInFlight, attention, groupedAttention, labels, projectCounts, type Messaging, type Project, type Workspace } from './model'

export const roleReminder = {
  workspace: '你是工作间管理员。先读 $agentboat-workspace 的角色卡。核对项目身份后，用 client.mjs message 把用户原话转给项目主会话并跟进，由项目主会话组织执行。项目主会话和执行者禁用 Computer Use 和其他真实桌面、窗口或键鼠操控工具。插话或恢复后核对当前 Run 收件和聊天记录，按原任务和版本单独回报尚未交付的成果。项目业务决定和验收沿用「等你处理」的原项。',
  project: '绑定成功后，普通项目请求和工作间转话都主动使用 $orca-project-coordinator 开启项目协作，无需触发词。先核对项目和当前 Run，读项目记录并关联原消息，沿用已有任务，按请求拆解并派给实际执行者。项目主会话和执行者禁用 Computer Use，也不得用其他工具操控真实桌面、窗口或键鼠。派工正文带上这条规则，用 CLI、API、编辑器专用 MCP、隔离自动化或只读结果验证；需主人操作时交工作间转达范围和最少步骤。验证按实际差异归并，共用状态只查一次，先复用有效证据，对结果不同的受影响状态各补一个代表例。原执行者按影响范围自查。主人明确提出的需求有可核对成果时，用 submit 在原任务登记验收，小改动、简表和返修也适用。成果迭代沿用原验收编号，内部步骤和草稿只记进展。收到明确返修意见时，核对用户原话、关联任务、验收编号和原版本，先用 feedback 代录需要修改，再沿用验收编号交新版。尚未送审的更新原任务范围，独立要求开后续任务。项目业务问题用 submit 在原任务登记一张待决定卡，聊天提示原项，等已有验收或决定时沿用原项，后续任务可用 paused 记录原任务和事项编号。反馈入账后回复原问题。独立受阻和待验收成果用 submit 登记。'
}

export const projectDeliveryBody = (body: string) => `${body}\n\n${roleReminder.project}`

type Role = { bot?: boolean; standby?: boolean; role: 'workspace-main'; directory: string; summary?: string } | { standby?: boolean; role: 'project-lead'; projectId: string; runId: string; agent?: string; summary?: string }
const uuid = /^orca_session_id:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const chat = (value?: string, agent?: string) => /^orca_session_id:(?:claude|codex)_[\w-]+$/.test(value ?? '') ||
  agent === 'codex' && uuid.test(value ?? '')
const projectChat = (value: string, agent?: string) => chat(value, agent) || agent === 'antigravity' && uuid.test(value)
const line = (value: string) => value.replace(/\s+/g, ' ').slice(0, 200)

export function roleRegistry(file: string, read: () => Promise<{
  workspace: Workspace; projects: Project[]; current?: Project[]; mailbox?: Messaging
}>) {
  let chain = Promise.resolve()
  return () => {
    chain = chain.then(async () => {
      const { workspace, projects, current, mailbox } = await read()
      const visible = current?.filter(p => !p.hidden)
      const sessions: Record<string, Role> = {}
      const spare = !workspace.bot && workspaceBackupInFlight(workspace.backup) && workspace.backup
      if (spare && spare.handle && workspace.session && chat(spare.handle, spare.agent)) sessions[spare.handle] = { role: 'workspace-main', directory: workspace.session.path, standby: true }
      const main = actingMain(workspace)
      const botHome = workspace.bot && botHomeHandle(workspace.session?.handle) ? workspace.session : undefined
      if (workspace.runId && main && (chat(main.handle, main.agent) || botHome?.handle === main.handle)) {
        const summary = visible && [
          `工作间待处理 ${groupedAttention(visible.flatMap(attention)).length} 组`,
          ...visible.slice(0, 30).map(p => {
            const counts = Object.entries(projectCounts(p)).flatMap(([key, count]) => count && key !== 'completed' ? [`${labels[key as keyof typeof labels]} ${count}`] : [])
            return `- ${line(p.ref.name)}：${counts.join('，') || '暂无待办'}`
          }),
          ...(visible.length > 30 ? [`另有 ${visible.length - 30} 个项目，读 overview 查看`] : []),
          ...(mailbox ? [`工作间消息待交付 ${mailbox.inbox.filter(m => m.state === 'pending').length + mailbox.deliveries.filter(m => !m.external && m.state === 'pending').length} 条，送达待核对 ${mailbox.deliveries.filter(m => !m.external && m.state === 'uncertain').length} 条`] : [])
        ].join('\n')
        if (!botHome && workspace.session && workspace.session.handle !== main.handle) sessions[workspace.session.handle] = { role: 'workspace-main', directory: main.path, standby: true }
        sessions[main.handle] = { role: 'workspace-main', directory: main.path, ...(botHome?.handle === main.handle ? { bot: true } : {}), ...(summary ? { summary } : {}) }
      }
      for (const p of projects) {
        if (!p.runId) continue
        const primary = p.mainSession?.handle ?? p.mainAgentHandle, taken = backupInCharge(p.backup)
        const standby = taken ? primary : p.backup?.handle, handle = taken ? p.backup?.handle : primary
        const standbyAgent = taken ? p.mainSession?.agent : p.backup?.agent, agent = taken ? p.backup?.agent : p.mainSession?.agent
        const role = { role: 'project-lead' as const, projectId: p.ref.id, runId: p.runId }
        if (standby && projectChat(standby, standbyAgent) && !sessions[standby]) sessions[standby] = { ...role, agent: standbyAgent, standby: true }
        if (!handle || !projectChat(handle, agent) || sessions[handle]?.role === 'workspace-main') continue
        const active = p.tasks.filter(t => t.phase === 'working'), pending = attention({ ...p, hidden: false }).filter(i => i.kind === 'decision' || i.kind === 'review')
        const summary = [
          `项目 ${line(p.ref.name)}，进行中 ${active.length} 项，待决定 ${pending.filter(i => i.kind === 'decision').length} 项，待验收 ${pending.filter(i => i.kind === 'review').length} 项`,
          ...active.slice(0, 10).map(t => `- 进行中：${line(t.title)}`),
          ...pending.slice(0, 15).map(i => `- ${i.kind === 'decision' ? '待决定' : '待验收'}：${line(i.summary)}`)
        ].join('\n')
        sessions[handle] = { ...role, agent, summary }
      }
      const json = JSON.stringify({ version: 1, sessions }) + '\n'
      if (json === await readFile(file, 'utf8').catch(e => { if (e.code !== 'ENOENT') throw e })) return
      await mkdir(path.dirname(file), { recursive: true })
      const temporary = path.join(path.dirname(file), '.roles-' + randomUUID())
      try {
        await writeFile(temporary, json, { flag: 'wx', mode: 0o600, flush: true })
        await rename(temporary, file)
      } finally { await rm(temporary, { force: true }) }
    }).catch(async () => {
      // A failed refresh must not leave an obsolete role enforcing policy.
      await rm(file, { force: true }).catch(() => {})
      console.error('AgentBoat: 角色表刷新失败')
    })
    return chain
  }
}
