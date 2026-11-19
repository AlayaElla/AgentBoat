import { randomUUID } from 'node:crypto'
import { mkdir, open, stat } from 'node:fs/promises'
import path from 'node:path'
import { taskState, type Project, type Task, type SourceEvent } from './model'
import { projectSubmissions, reportSubmitted, type WorkerReport } from '../scripts/worker-reports.mjs'

type Cursor = NonNullable<Project['archive']>
type Position = Pick<Cursor, 'id' | 'start' | 'end'>
type History = { taskId: string; kind: 'acceptance' | 'decisions'; itemId: string; start: number; rows: Task['acceptance'][number]['history'] }
type Batch = { projectId: string; previous?: Position; deliveries: Project['deliveries']; requests: Project['requests']; tasks?: Task[]; events?: SourceEvent[]; history?: History[] }
const limit = 200_000
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
function requireFit(p: Project, error?: unknown) {
  if (bytes(p) <= limit) return
  const parts = `任务 ${bytes(p.tasks)}、来源消息 ${bytes(p.events)}、通知 ${bytes(p.deliveries)}、请求凭证 ${bytes(p.requests)} 字节`
  const advice = error ? `归档失败（${String(error)}），请检查归档目录权限和磁盘空间后重试`
    : '剩余记录用于当前工作或最近一次核对，请先处理待办或确认通知状态，缩短本次任务正文并将长文放在成果文件中'
  throw Object.assign(Error(`项目记录 ${bytes(p)} 字节，超过 ${limit} 字节上限（${parts}）。${advice}。原记录已保留`), { code: 'invalid_request' })
}
function fileName(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw Error('项目归档编号无效')
  return `project-${id}.jsonl`
}

export class ProjectArchive {
  private indexes = new Map<string, { end: number; proofs: Map<string, string>; taskIds: Set<string>; sourceOwners: Set<string> }>()
  constructor(private directory: string) {}

  // Only committed cursors are followed. Failed writes may leave unused bytes at EOF.
  private async *batches(p: Project, stop = 0) {
    if (!p.archive) return
    const head = p.archive
    const file = await open(path.join(this.directory, fileName(head.id)), 'r')
    try {
      const { size } = await file.stat()
      let cursor: Position | undefined = head
      while (cursor && cursor.end !== stop) {
        const { start, end } = cursor
        if (cursor.id !== head.id || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > size) throw Error('项目归档位置无效')
        const data = Buffer.alloc(end - start)
        let offset = 0
        while (offset < data.length) {
          const { bytesRead } = await file.read(data, offset, data.length - offset, start + offset)
          if (!bytesRead) throw Error('项目归档不完整，请恢复备份后重试')
          offset += bytesRead
        }
        const batch: Batch = JSON.parse(data.toString())
        if (batch.projectId !== p.ref.id || (batch.previous && batch.previous.end > start)) throw Error('项目归档记录不匹配')
        yield { end, batch }
        cursor = batch.previous
      }
    } finally { await file.close() }
  }

  async page(p: Project, end?: number) {
    for await (const row of this.batches(p)) {
      if (end === undefined || row.end === end) return { name: fileName(p.archive!.id), batch: row.batch }
    }
    throw Error('归档批次不存在，请重新打开归档')
  }

  async receipt(p: Project, id: string) {
    if (!p.archive) return
    const head = p.archive
    const index = this.indexes.get(head.id) ?? { end: 0, proofs: new Map<string, string>(), taskIds: new Set<string>(), sourceOwners: new Set<string>() }
    if (index.end !== head.end) {
      for await (const { batch } of this.batches(p, index.end)) {
        for (const r of batch.requests) index.proofs.set(r.id, r.fingerprint)
        for (const t of batch.tasks ?? []) index.taskIds.add(t.id)
        for (const e of batch.events ?? []) if (e.taskId) index.sourceOwners.add(e.taskId)
      }
      index.end = head.end
      this.indexes.set(head.id, index)
    }
    const fingerprint = index.proofs.get(id)
    return fingerprint && { id, fingerprint }
  }

  async submittedReports(p: Project, reports: WorkerReport[]) {
    const submitted = new Set<string>()
    if (!reports.length || !p.archive?.taskCount) return submitted
    const seen = new Set(p.tasks.map(t => t.id))
    for await (const { batch } of this.batches(p)) {
      const tasks = (batch.tasks ?? []).filter(t => !seen.has(t.id))
      for (const t of tasks) seen.add(t.id)
      const proofs = projectSubmissions({ ...p, tasks })
      for (const report of reports) if (proofs.some(proof => reportSubmitted(report, proof))) submitted.add(report.id)
      if (submitted.size === reports.length) break
    }
    return submitted
  }

  async task(p: Project, id: string) {
    let task = p.tasks.find(t => t.id === id)
    if (!task && p.archive?.taskCount) {
      for await (const { batch } of this.batches(p)) {
        task = batch.tasks?.find(t => t.id === id)
        if (task) break
      }
    }
    if (!task) return
    if (![...task.acceptance, ...task.decisions].some(item => item.archivedHistory)) return task
    task = structuredClone(task)
    for await (const { batch } of this.batches(p)) {
      for (const part of batch.history ?? []) {
        if (part.taskId !== id) continue
        const item = task[part.kind].find(i => i.id === part.itemId)
        if (!item?.archivedHistory || item.archivedHistory !== part.start + part.rows.length) continue
        item.history = [...part.rows, ...item.history]
        if (part.start) item.archivedHistory = part.start
        else delete item.archivedHistory
      }
      if (![...task.acceptance, ...task.decisions].some(item => item.archivedHistory)) return task
    }
    throw Error('任务反馈归档不完整，请恢复备份后重试')
  }

  async restore(p: Project, id: string, sources: string[]) {
    if (!p.archive) return
    const cached = this.indexes.get(p.archive.id)
    const index = cached?.end === p.archive.end ? cached : undefined
    let task = p.tasks.find(t => t.id === id)
    const archived = !task && (!index || index.taskIds.has(id)) && await this.task(p, id)
    if (archived) {
      task = archived
      p.tasks.push(archived)
      p.archive.taskCount = (p.archive.taskCount ?? 1) - 1
    }
    const present = new Set(p.events.map(e => e.id))
    const wanted = new Set([...sources, ...(task?.sourceIds ?? [])].filter(key => !present.has(key)))
    const byOwner = task && taskState(task) === 'completed' && (!index || index.sourceOwners.has(id))
    if (!wanted.size && !byOwner) return
    for await (const { batch } of this.batches(p)) {
      for (const e of batch.events ?? []) {
        if (present.has(e.id) || !(wanted.has(e.id) || byOwner && e.taskId === id)) continue
        p.events.push(e)
        present.add(e.id)
        wanted.delete(e.id)
      }
      if (!byOwner && !wanted.size) break
    }
  }

  async compact(p: Project) {
    const finished = p.deliveries.filter(d => {
      if (d.state !== 'sent') return false
      const target = d.external?.target
      if (!target) return true
      const task = p.tasks.find(t => t.id === target.taskId)
      return target.kind === 'decision'
        ? !task?.decisions.some(i => i.id === target.itemId && i.answer === undefined)
        : !task?.acceptance.some(i => i.id === target.itemId && i.revision === target.itemRevision && i.status === 'pending')
    })
    const completed = p.tasks.filter(t => taskState(t) === 'completed').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    const previous = p.archive
    const id = previous?.id ?? randomUUID()
    const filename = path.join(this.directory, fileName(id))
    const batch: Required<Omit<Batch, 'previous'>> & Pick<Batch, 'previous'> = { projectId: p.ref.id,
      previous: previous && { id, start: previous.start, end: previous.end }, deliveries: [], requests: [], tasks: [], events: [], history: [] }
    const next = { ...p }
    const collectTasks = (keep: number, pressure: boolean) => {
      batch.tasks = completed.slice(keep)
      const removed = new Set(batch.tasks)
      next.tasks = p.tasks.filter(t => !removed.has(t))
      const active = next.tasks.filter(t => taskState(t) !== 'completed')
      const activeIds = new Set(active.map(t => t.id))
      const owners = new Set(next.tasks.map(t => t.id))
      const pinned = new Set(active.flatMap(t => t.sourceIds))
      const retained = new Set(next.tasks.flatMap(t => t.sourceIds))
      const movedSources = new Set(batch.tasks.flatMap(t => t.sourceIds))
      const eligible = p.events.filter(e => !pinned.has(e.id) && !activeIds.has(e.taskId ?? ''))
      const unassigned = eligible.filter(e => !e.taskId && !retained.has(e.id) && !movedSources.has(e.id))
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || a.id.localeCompare(b.id))
      const recent = new Set(unassigned.slice(0, 24))
      const cutoff = Date.now() - 30 * 86_400_000
      batch.events = eligible.filter(e => pressure || Date.parse(e.receivedAt) < cutoff ||
        !(retained.has(e.id) || owners.has(e.taskId ?? '') || recent.has(e)))
      const events = new Set(batch.events)
      next.events = p.events.filter(e => !events.has(e))
    }
    const collectDeliveries = (keep: number) => {
      batch.deliveries = finished.slice(0, Math.max(0, finished.length - keep))
      const removed = new Set(batch.deliveries)
      next.deliveries = p.deliveries.filter(d => !removed.has(d))
    }
    const collectRequests = (keep: number) => {
      batch.requests = p.requests.slice(0, -keep)
      next.requests = p.requests.slice(batch.requests.length)
    }
    collectDeliveries(24)
    collectRequests(128)
    collectTasks(20, false)
    const summary = () => ({ revision: p.revision, tasks: batch.tasks.length, events: batch.events.length,
      deliveries: batch.deliveries.length, requests: batch.requests.length, history: batch.history.reduce((sum, h) => sum + h.rows.length, 0) })
    if (!batch.tasks.length && !batch.events.length && !batch.deliveries.length && !batch.requests.length && bytes(p) <= limit) return

    let size = 0
    try {
      if (previous) size = (await stat(filename)).size
      if (size < (previous?.end ?? 0)) throw Error('项目归档不完整，请恢复备份')
    } catch (error) { requireFit(p, error); return }
    const gap = size > (previous?.end ?? 0) ? '\n' : ''
    const measure = () => {
      const start = size + gap.length
      next.archive = { id, start, end: start + bytes(batch) + 1, taskCount: (previous?.taskCount ?? 0) + batch.tasks.length, last: summary() }
      return bytes(next)
    }
    const collectHistory = () => {
      next.tasks = structuredClone(next.tasks)
      for (const task of next.tasks) for (const kind of ['acceptance', 'decisions'] as const) for (const item of task[kind]) {
        if (item.history.length < 2) continue
        const rows = item.history.splice(0, item.history.length - 1)
        batch.history.push({ taskId: task.id, kind, itemId: item.id, start: item.archivedHistory ?? 0, rows })
        item.archivedHistory = (item.archivedHistory ?? 0) + rows.length
      }
    }
    let remaining = measure()
    for (const stage of [() => collectDeliveries(0), () => collectRequests(1), () => collectTasks(0, true), collectHistory]) {
      if (remaining <= limit) break
      stage()
      remaining = measure()
    }
    if (remaining > limit) {
      if (bytes(p) <= limit) return
      requireFit(next)
    }
    try {
      await mkdir(this.directory, { recursive: true })
      const file = await open(filename, previous ? 'a' : 'ax')
      try {
        if ((await file.stat()).size !== size) throw Error('项目归档已变化，请重试')
        await file.appendFile(gap + JSON.stringify(batch) + '\n')
        await file.sync()
      } finally { await file.close() }
    } catch (error) { requireFit(p, error); return }
    Object.assign(p, next)
  }
}
