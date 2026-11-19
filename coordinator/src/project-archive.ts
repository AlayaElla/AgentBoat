import { randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import type { Project } from './model'

type Cursor = NonNullable<Project['archive']>
type Batch = { projectId: string; previous?: Cursor; deliveries: Project['deliveries']; requests: Project['requests'] }

function archiveFile(directory: string, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw Error('项目归档编号无效')
  return path.join(directory, `project-${id}.jsonl`)
}

export class ProjectArchive {
  private indexes = new Map<string, { end: number; proofs: Map<string, string> }>()
  constructor(private directory: string) {}

  // Only committed cursors are followed. A failed storage write may leave an unused batch at EOF.
  async receipt(p: Project, id: string) {
    if (!p.archive) return
    const head = p.archive
    const index = this.indexes.get(head.id) ?? { end: 0, proofs: new Map<string, string>() }
    if (index.end !== head.end) {
      const file = await open(archiveFile(this.directory, head.id), 'r')
      try {
        const { size } = await file.stat()
        let cursor: Cursor | undefined = head
        while (cursor && cursor.end !== index.end) {
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
          for (const r of batch.requests) index.proofs.set(r.id, r.fingerprint)
          cursor = batch.previous
        }
        index.end = head.end
        this.indexes.set(head.id, index)
      } finally { await file.close() }
    }
    const fingerprint = index.proofs.get(id)
    return fingerprint && { id, fingerprint }
  }

  async compact(p: Project) {
    const finished = p.deliveries.filter(d => {
      if (d.state !== 'sent') return false
      const target = d.external?.target
      if (!target) return true
      // A sent Feishu reminder can still receive a quoted decision or review.
      const task = p.tasks.find(t => t.id === target.taskId)
      return target.kind === 'decision'
        ? !task?.decisions.some(i => i.id === target.itemId && i.answer === undefined)
        : !task?.acceptance.some(i => i.id === target.itemId && i.revision === target.itemRevision && i.status === 'pending')
    })
    const deliveries = finished.slice(0, -24), requests = p.requests.slice(0, -128)
    if (!deliveries.length && !requests.length) return
    const previous = p.archive
    const batch: Batch = { projectId: p.ref.id, previous, deliveries, requests }
    const id = previous?.id ?? randomUUID()
    let cursor: Cursor
    try {
      await mkdir(this.directory, { recursive: true })
      const file = await open(archiveFile(this.directory, id), previous ? 'a' : 'ax')
      try {
        const { size } = await file.stat()
        if (size < (previous?.end ?? 0)) throw Error('项目归档不完整，请恢复备份')
        const gap = size > (previous?.end ?? 0) ? '\n' : ''
        const data = Buffer.from(gap + JSON.stringify(batch) + '\n')
        await file.appendFile(data)
        await file.sync()
        cursor = { id, start: size + gap.length, end: size + data.length }
      } finally { await file.close() }
    } catch (error) { return error instanceof Error ? error.message : String(error) }
    p.archive = cursor
    const removed = new Set(deliveries)
    p.deliveries = p.deliveries.filter(d => !removed.has(d))
    p.requests = p.requests.slice(requests.length)
  }
}
