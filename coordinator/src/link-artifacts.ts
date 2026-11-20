import { artifactReason, reasonText, type ArtifactReason } from './artifact-errors'
import path from 'node:path'
import { addAbortSignal } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'
import { artifactChunkBytes, artifactPart, LinkFiles, type ReceivedFile, wireChunk, wireFiles, type LinkFile } from './link-files'
import { fail, fingerprint, object, text } from './store'

export type ArtifactRef = { projectId: string; taskId: string; artifactId: string }
export type StreamOffer = ArtifactRef & { requestId: string; cached?: string }
export type StreamMethod = 'direct' | 'chunks'
export const streamTimeout = 35_000
export const transferKey = (identity: string, version: string, files: LinkFile[]) => 'artifact:' + fingerprint([identity, version, files])
function artifactResult({ path: file, name, size, type }: ReceivedFile, method: StreamMethod) {
  return { key: path.basename(path.dirname(file)), name, size, type, method }
}
type Request = ArtifactRef & { requestId: string; offset: number }
type Reply = { requestId: string; offset: number; reason?: string; version?: string; files?: LinkFile[]; chunk?: ReturnType<typeof wireChunk> }
type Result = ReturnType<typeof artifactResult>
type Receipt = { requestId: string; ok: boolean }
export type ArtifactExchange = { request?: Request; reply?: Reply; receipt?: Receipt; deferred?: string }
export type ArtifactProgress = ArtifactRef & { id: string; received: number; size: number; method: StreamMethod }
const idleMs = 20_000, deadlineMs = 110_000
type Pending = {
  request: Request; identity: string; result: Promise<Result>; finish: (file?: Result, reason?: string) => void
  started: number; direct?: AbortController; offer?: StreamOffer; receiving?: Promise<void>; fallback: (reason?: ArtifactReason) => void
  resetTimeout: () => void; files?: LinkFile[]; transfer?: string
}

export function artifactRef(raw: unknown): ArtifactRef {
  const r = object(raw)
  return { projectId: text(r.projectId, '项目编号', 64), taskId: text(r.taskId, '任务编号', 200), artifactId: text(r.artifactId, '成果编号', 200) }
}

export class LinkArtifacts {
  private cached = new Map<string, string>()
  private pending = new Map<string, Pending>()
  private requests = new Map<string, Request>()
  private receipts = new Map<string, Receipt>()
  private serving = new Map<string, { requestId: string; started: number; size?: number; timer?: ReturnType<typeof setTimeout> }>()
  constructor(readonly files: LinkFiles, private log: (message: string) => void, private progress: (value: ArtifactProgress) => void) {}

  record(direction: string, state: string, requestId: string, started: number, size?: number, stage = 'chunks', reason?: ArtifactReason) {
    this.log(`peer artifact ${direction} ${state} id=${fingerprint(requestId).slice(0, 12)} bytes=${size ?? 'unknown'} ms=${Date.now() - started} stage=${stage}${reason ? ' reason=' + reason : ''}`)
  }
  private finishServing(peer: string, state: string, stage = 'chunks', reason?: ArtifactReason) {
    const transfer = this.serving.get(peer)
    if (!transfer) return
    clearTimeout(transfer.timer)
    this.serving.delete(peer)
    this.record('send', state, transfer.requestId, transfer.started, transfer.size, stage, reason)
  }

  start(peer: string, ref: ArtifactRef, pull: ((offer: StreamOffer, signal: AbortSignal) => Promise<void>) | undefined, wake: () => void) {
    const identity = fingerprint(ref), previous = this.pending.get(peer)
    if (previous) return previous.identity === identity ? previous.result : fail('正在接收另一个成果，请稍后再试')
    let resolve!: (file: Result) => void, reject!: (error: Error) => void
    const result = new Promise<Result>((yes, no) => { resolve = yes; reject = no })
    const started = Date.now(), requestId = randomUUID()
    const direct = new AbortController()
    this.record('receive', 'start', requestId, started, undefined, pull ? 'pull' : 'wait_push')
    let timer: ReturnType<typeof setTimeout>
    const finish = (file?: Result, reason = reasonText('timeout')) => {
      clearTimeout(timer)
      if (this.pending.get(peer)?.result !== result) return
      if (!file) direct.abort()
      this.record('receive', file ? 'complete' : 'failed', requestId, started, file?.size ?? p.files?.[0].size,
        p.direct ? 'direct' : p.files ? 'chunks' : 'metadata', file ? undefined : artifactReason(new Error(reason), 'invalid'))
      if (!p.direct) this.receipts.set(peer, { requestId, ok: !!file })
      this.pending.delete(peer)
      if (file) resolve(file)
      else reject(new Error(reason))
    }
    const resetTimeout = () => {
      clearTimeout(timer)
      timer = p.direct ? setTimeout(() => direct.abort(), streamTimeout - (Date.now() - started)) : setTimeout(finish, Math.min(idleMs, deadlineMs - (Date.now() - started)))
    }
    const offer = { ...ref, requestId, cached: this.cached.get(peer) }
    const fallback = (code: ArtifactReason = 'interrupted') => {
      if (!p.direct || this.pending.get(peer) !== p) return
      direct.abort()
      p.direct = undefined
      p.offer = undefined
      this.record('receive', 'fallback', requestId, started, undefined, 'direct', code)
      this.progress({ ...ref, id: peer, method: 'chunks', received: 0, size: 0 })
      resetTimeout()
      wake()
    }
    const p: Pending = { identity, started, direct, offer: pull ? undefined : offer, fallback,
      request: { ...ref, requestId, offset: -1 }, result, finish, resetTimeout }
    this.pending.set(peer, p)
    this.progress({ ...ref, id: peer, method: 'direct', received: 0, size: 0 })
    if (pull) {
      resetTimeout()
      void pull(offer, direct.signal).catch(e => fallback(artifactReason(e, direct.signal.aborted ? 'timeout' : 'interrupted')))
    } else {
      timer = setTimeout(() => fallback('timeout'), 5000)
      wake()
    }
    return result
  }

  offer(peer: string) { return this.pending.get(peer)?.offer }

  takeOffer(peer: string) {
    const p = this.pending.get(peer)
    const offer = p?.offer
    if (p && offer) {
      this.record('receive', 'dispatched', offer.requestId, p.started, undefined, 'wait_push')
      p.offer = undefined
    }
    return offer
  }

  async stream(peer: string, workspace: string, requestId: string, metadata: unknown, body: IncomingMessage, length: number) {
    const p = this.pending.get(peer)
    if (!p?.direct || p.request.requestId !== requestId || p.receiving) fail('没有对应的成果请求')
    let done!: () => void
    p.receiving = new Promise(resolve => { done = resolve })
    p.offer = undefined
    p.resetTimeout()
    const signal = p.direct.signal
    try {
      const meta = object(metadata)
      const files = wireFiles([meta.file])!, version = text(meta.version, '成果版本', 200)
      const transfer = transferKey(p.identity, version, files)
      const file = files[0]
      if (length !== file.size && !(length === 0 && this.cached.get(peer) === transfer)) fail('成果大小与声明不符')
      p.files = files
      this.record('receive', 'headers', requestId, p.started, file.size, 'direct')
      let last = 0
      const saved = await this.files.receiveStream(peer, workspace, transfer, file, addAbortSignal(signal, body), length, n => {
        if (Date.now() - last < 100 && n !== length) return
        last = Date.now()
        this.progress({ ...artifactRef(p.request), id: peer, received: n, size: file.size, method: 'direct' })
        if (n === length) this.record('receive', 'body', requestId, p.started, n, 'verify')
      }, signal)
      signal.throwIfAborted()
      this.cached.set(peer, transfer)
      p.finish(artifactResult(saved, 'direct'))
    } catch (e) {
      p.fallback(signal.aborted ? 'timeout' : artifactReason(e, 'interrupted'))
      throw e
    } finally { done() }
  }

  rejectDirect(peer: string, requestId: string, code: unknown) {
    const p = this.pending.get(peer)
    if (!p?.direct || p.receiving || p.request.requestId !== requestId) return
    if (code === 'interrupted' || code === 'timeout' || code === 'busy') p.fallback(code)
    else p.finish(undefined, reasonText(code))
  }

  stop(peer?: string) {
    const writing = peer ? this.pending.get(peer)?.receiving : undefined
    for (const [id, pending] of this.pending) if (!peer || peer === id) pending.finish(undefined, '工作间连接已断开')
    for (const id of this.serving.keys()) if (!peer || peer === id) this.finishServing(id, 'disconnected')
    if (peer) { this.cached.delete(peer); this.requests.delete(peer); this.receipts.delete(peer) }
    else { this.cached.clear(); this.requests.clear(); this.receipts.clear() }
    return writing
  }

  async receive(peer: string, workspace: string, raw: unknown) {
    if (!raw) return false
    const { request, reply, receipt, deferred } = object(raw)
    if (receipt && typeof receipt.ok === 'boolean' && typeof receipt.requestId === 'string' && this.serving.get(peer)?.requestId === receipt.requestId)
      this.finishServing(peer, receipt.ok ? 'complete' : 'failed', 'receipt', receipt.ok ? undefined : 'interrupted')
    if (request) {
      const ref = artifactRef(request), requestId = text(request.requestId, '请求编号', 64)
      if (!Number.isSafeInteger(request.offset) || request.offset < -1) fail('工作间文件分块不正确')
      this.requests.set(peer, { ...ref, requestId, offset: request.offset })
    }
    const p = this.pending.get(peer)
    if (!reply || !p || p.direct || reply.requestId !== p.request.requestId || reply.offset !== p.request.offset) return !!request || !!p && deferred === p.request.requestId
    try {
      if (reply.reason) fail(text(reply.reason, '原因', 200))
      if (p.request.offset === -1) {
        p.files = wireFiles(reply.files)
        if (p.files?.length !== 1) fail('对方未提供有效的成果文件')
        const version = text(reply.version, '成果版本', 200)
        // Message IDs stop at 64 characters. Keep artifact transfers in a separate namespace.
        p.transfer = transferKey(p.identity, version, p.files)
      }
      const chunk = wireChunk(reply.chunk, artifactChunkBytes)
      if (p.request.offset >= 0 && (chunk?.offset !== p.request.offset || chunk.index !== 0)) fail('工作间文件分块不正确')
      const result = await this.files.receive(peer, workspace, p.transfer!, fingerprint(p.files), p.files!, chunk)
      if ('error' in result) fail(reasonText(result.error))
      if ('files' in result) {
        this.cached.set(peer, p.transfer!)
        p.finish(artifactResult(result.files[0], 'chunks'))
      } else {
        p.request = { ...p.request, offset: result.offsets[0] }
        const { projectId, taskId, artifactId } = p.request
        this.progress({ method: 'chunks', id: peer, projectId, taskId, artifactId, received: result.offsets[0], size: p.files![0].size })
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
    const p = this.pending.get(peer), request = p?.direct ? undefined : p?.request, inbound = this.requests.get(peer)
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
      const part = await artifactPart(root, file, offset)
      if (part.files) transfer.size = part.files[0].size
      return { request, receipt, reply: { requestId, offset, version, ...part } }
    } catch (e) {
      const reason = (e as { code?: string }).code === 'invalid_request' ? (e as Error).message : reasonText(artifactReason(e, 'missing'))
      this.finishServing(peer, 'failed', offset === -1 ? 'metadata' : 'chunk', artifactReason(e, 'missing'))
      return { request, receipt, reply: { requestId, offset, reason } }
    }
  }
}
