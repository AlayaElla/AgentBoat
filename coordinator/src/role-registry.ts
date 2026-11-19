import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { attention, groupedAttention, labels, projectSummary, type Messaging, type Project, type Workspace } from './model'

type Role = { role: 'workspace-main'; directory: string; summary?: string } | { role: 'project-lead'; projectId: string; summary?: string }
const chat = (value?: string) => /^orca_session_id:claude_[\w-]+$/.test(value ?? '')
const line = (value: string) => value.replace(/\s+/g, ' ').slice(0, 200)

export function roleRegistry(file: string, read: () => Promise<{
  workspace: Workspace; projects: Project[]; current?: Project[]; mailbox?: Messaging
}>) {
  let chain = Promise.resolve()
  return () => {
    const next = chain.then(async () => {
      const { workspace, projects, current, mailbox } = await read()
      const visible = current?.filter(p => !p.hidden)
      const sessions: Record<string, Role> = {}
      const main = workspace.session
      if (workspace.runId && main && chat(main.handle)) {
        const summary = visible && [
          `工作间待处理 ${groupedAttention(visible.flatMap(attention)).length} 组`,
          ...visible.slice(0, 30).map(p => {
            const counts = Object.entries(projectSummary(p).counts).flatMap(([key, count]) => count ? [`${labels[key as keyof typeof labels]} ${count}`] : [])
            return `- ${line(p.ref.name)}：${counts.join('，') || '暂无任务'}`
          }),
          ...(visible.length > 30 ? [`另有 ${visible.length - 30} 个项目，读 overview 查看`] : []),
          ...(mailbox ? [`工作间消息待交付 ${mailbox.inbox.filter(m => m.state === 'pending').length + mailbox.deliveries.filter(m => !m.external && m.state === 'pending').length} 条，送达待核对 ${mailbox.deliveries.filter(m => !m.external && m.state === 'uncertain').length} 条`] : [])
        ].join('\n')
        sessions[main.handle] = { role: 'workspace-main', directory: main.path, ...(summary ? { summary } : {}) }
      }
      for (const p of projects) {
        const handle = p.mainSession?.handle ?? p.mainAgentHandle
        if (!p.runId || !handle || !chat(handle) || sessions[handle]?.role === 'workspace-main') continue
        const active = p.tasks.filter(t => t.phase === 'working'), pending = attention({ ...p, hidden: false }).filter(i => i.kind === 'decision' || i.kind === 'review')
        const summary = [
          `项目 ${line(p.ref.name)}，进行中 ${active.length} 项，待决定 ${pending.filter(i => i.kind === 'decision').length} 项，待验收 ${pending.filter(i => i.kind === 'review').length} 项`,
          ...active.slice(0, 10).map(t => `- 进行中：${line(t.title)}`),
          ...pending.slice(0, 15).map(i => `- ${i.kind === 'decision' ? '待决定' : '待验收'}：${line(i.summary)}`)
        ].join('\n')
        sessions[handle] = { role: 'project-lead', projectId: p.ref.id, summary }
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
    chain = next
    return next
  }
}
