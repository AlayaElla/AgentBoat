import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { artifactChunkBytes, artifactPart, LinkFiles, wireChunk, wireFiles, type LinkFile } from './link-files'
import { fail, fingerprint, object, text } from './store'

export type ArtifactRef = { projectId: string; taskId: string; artifactId: string }
type Request = ArtifactRef & { requestId: string; offset: number; bulk?: true }
type Reply = { requestId: string; offset: number; reason?: string; version?: string; files?: LinkFile[]; chunk?: ReturnType<typeof wireChunk> }
type Result = Pick<LinkFile, 'name' | 'size' | 'type'> & { key: string }
type Receipt = { requestId: string; ok: boolean }
export type ArtifactExchange = { request?: Request; reply?: Reply; receipt?: Receipt; deferred?: string }
export type ArtifactProgress = ArtifactRef & { id: string; received: number; size: number }
const idleMs = 20_000, deadlineMs = 110_000
type Pending = {
  request: Request; identity: string; result: Promise<Result>; finish: (file?: Result, reason?: string) => void
  resetTimeout: () => void; files?: LinkFile[]; transfer?: string
}

export function artifactRef(raw: unknown): ArtifactRef {
  const r = object(raw)
  return { projectId: text(r.projectId, '项目编号', 64), taskId: text(r.taskId, '任务编号', 200), artifactId: text(r.artifactId, '成果编号', 200) }
}

export class LinkArtifacts {
  private pending = new Map<string, Pending>()
  private requests = new Map<string, Request>()
  private receipts = new Map<string, Receipt>()
  private serving = new Map<string, { requestId: string; started: number; size?: number; timer?: ReturnType<typeof setTimeout> }>()
  constructor(readonly files: LinkFiles, private log: (message: string) => void, private progress: (value: ArtifactProgress) => void) {}

  private record(direction: string, state: string, requestId: string, started: number, size?: number) {
    this.log(`peer artifact ${direction} ${state} id=${fingerprint(requestId).slice(0, 12)} bytes=${size ?? 'unknown'} ms=${Date.now() - started}`)
  }
  private finishServing(peer: string, state: string) {
    const transfer = this.serving.get(peer)
    if (!transfer) return
    clearTimeout(transfer.timer)
    this.serving.delete(peer)
    this.record('send', state, transfer.requestId, transfer.started, transfer.size)
  }

  start(peer: string, ref: ArtifactRef) {
    const identity = fingerprint(ref), previous = this.pending.get(peer)
    if (previous) return previous.identity === identity ? previous.result : fail('正在接收另一个成果，请稍后再试')
    let resolve!: (file: Result) => void, reject!: (error: Error) => void
    const result = new Promise<Result>((yes, no) => { resolve = yes; reject = no })
    const started = Date.now(), requestId = randomUUID()
    this.record('receive', 'start', requestId, started)
    let timer: ReturnType<typeof setTimeout>
    const finish = (file?: Result, reason = '取文件超时，请检查对方是否在线后重试') => {
      clearTimeout(timer)
      if (this.pending.get(peer)?.result !== result) return
      this.record('receive', file ? 'complete' : 'failed', requestId, started, this.pending.get(peer)?.files?.[0].size)
      this.receipts.set(peer, { requestId, ok: !!file })
      this.pending.delete(peer)
      if (file) resolve(file)
      else reject(new Error(reason))
    }
    const resetTimeout = () => { clearTimeout(timer); timer = setTimeout(finish, Math.min(idleMs, deadlineMs - (Date.now() - started))) }
    this.pending.set(peer, { identity, request: { ...ref, requestId, offset: -1, bulk: true }, result, finish, resetTimeout })
    resetTimeout()
    return result
  }

  stop(peer?: string) {
    for (const [id, pending] of this.pending) if (!peer || peer === id) pending.finish(undefined, '工作间连接已断开')
    for (const id of this.serving.keys()) if (!peer || peer === id) this.finishServing(id, 'disconnected')
    if (peer) { this.requests.delete(peer); this.receipts.delete(peer) }
    else { this.requests.clear(); this.receipts.clear() }
  }

  async receive(peer: string, workspace: string, raw: unknown) {
    if (!raw) return false
    const { request, reply, receipt, deferred } = object(raw)
    if (receipt && typeof receipt.ok === 'boolean' && typeof receipt.requestId === 'string' && this.serving.get(peer)?.requestId === receipt.requestId)
      this.finishServing(peer, receipt.ok ? 'complete' : 'failed')
    if (request) {
      const ref = artifactRef(request), requestId = text(request.requestId, '请求编号', 64)
      if (!Number.isSafeInteger(request.offset) || request.offset < -1) fail('工作间文件分块不正确')
      this.requests.set(peer, { ...ref, requestId, offset: request.offset, ...(request.bulk === true && { bulk: true as const }) })
    }
    const p = this.pending.get(peer)
    if (!reply || !p || reply.requestId !== p.request.requestId || reply.offset !== p.request.offset) return !!request || !!p && deferred === p.request.requestId
    try {
      if (reply.reason) fail(text(reply.reason, '原因', 200))
      if (p.request.offset === -1) {
        p.files = wireFiles(reply.files)
        if (p.files?.length !== 1) fail('对方未提供有效的成果文件')
        const version = text(reply.version, '成果版本', 200)
        // Message IDs stop at 64 characters. Keep artifact transfers in a separate namespace.
        p.transfer = 'artifact:' + fingerprint([p.identity, version, p.files])
      }
      const chunk = wireChunk(reply.chunk, artifactChunkBytes)
      if (p.request.offset >= 0 && (chunk?.offset !== p.request.offset || chunk.index !== 0)) fail('工作间文件分块不正确')
      const result = await this.files.receive(peer, workspace, p.transfer!, fingerprint(p.files), p.files!, chunk)
      if ('error' in result) fail(result.error === 'capacity' ? '接收区空间不足' : '成果校验失败，请重新获取')
      if ('files' in result) {
        const [{ name, size, type }] = result.files
        p.finish({ name, size, type, key: path.basename(path.dirname(result.files[0].path)) })
      } else {
        p.request = { ...p.request, offset: result.offsets[0] }
        const { projectId, taskId, artifactId } = p.request
        this.progress({ id: peer, projectId, taskId, artifactId, received: result.offsets[0], size: p.files![0].size })
        p.resetTimeout()
        return true
      }
    } catch (e) {
      p.finish(undefined, (e as { code?: string }).code === 'invalid_request' ? (e as Error).message : '成果文件接收失败')
    }
    return true // Send the completion receipt, including on a cache hit.
  }

  hasData(peer: string) {
    return (this.pending.get(peer)?.request.offset ?? -1) >= 0 || (this.requests.get(peer)?.offset ?? -1) >= 0
  }

  sent(peer: string, packet?: ArtifactExchange) {
    if (packet?.receipt === this.receipts.get(peer)) this.receipts.delete(peer)
  }

  async packet(peer: string, lookup: (r: ArtifactRef) => Promise<{ root: string; file: string; version: string }>): Promise<ArtifactExchange | undefined> {
    const request = this.pending.get(peer)?.request, inbound = this.requests.get(peer)
    const receipt = this.receipts.get(peer)
    if (!inbound) return request || receipt ? { request, receipt } : undefined
    this.requests.delete(peer)
    const { requestId, offset } = inbound
    let transfer = this.serving.get(peer)
    if (transfer?.requestId !== requestId) {
      this.finishServing(peer, 'interrupted')
      transfer = { requestId, started: Date.now() }
      this.serving.set(peer, transfer)
      this.record('send', 'start', requestId, transfer.started)
    }
    clearTimeout(transfer.timer)
    transfer.timer = setTimeout(() => this.finishServing(peer, 'timeout'), idleMs)
    try {
      if (Date.now() - transfer.started >= deadlineMs) fail('取文件超时，请重试')
      const { root, file, version } = await lookup(inbound)
      const part = await artifactPart(root, file, offset, !!inbound.bulk)
      if (part.files) transfer.size = part.files[0].size
      // Older receivers do not send completion receipts.
      if (!inbound.bulk && (transfer.size === 0 || part.chunk && offset + Buffer.byteLength(part.chunk.data, 'base64') === transfer.size))
        this.finishServing(peer, 'provided')
      return { request, receipt, reply: { requestId, offset, version, ...part } }
    } catch (e) {
      const reason = (e as { code?: string }).code === 'invalid_request' ? (e as Error).message : '成果文件不存在或无法读取'
      this.finishServing(peer, 'failed')
      return { request, receipt, reply: { requestId, offset, reason } }
    }
  }
}
