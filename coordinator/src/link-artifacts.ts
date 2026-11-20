import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { artifactPart, LinkFiles, wireChunk, wireFiles, type LinkFile } from './link-files'
import { fail, fingerprint, object, text } from './store'

export type ArtifactRef = { projectId: string; taskId: string; artifactId: string }
type Request = ArtifactRef & { requestId: string; offset: number }
type Reply = { requestId: string; offset: number; reason?: string; version?: string; files?: LinkFile[]; chunk?: ReturnType<typeof wireChunk> }
type Result = Pick<LinkFile, 'name' | 'size' | 'type'> & { key: string }
export type ArtifactExchange = { request?: Request; reply?: Reply }
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
  constructor(readonly files: LinkFiles) {}

  start(peer: string, ref: ArtifactRef) {
    const identity = fingerprint(ref), previous = this.pending.get(peer)
    if (previous) return previous.identity === identity ? previous.result : fail('正在接收另一个成果，请稍后再试')
    let resolve!: (file: Result) => void, reject!: (error: Error) => void
    const result = new Promise<Result>((yes, no) => { resolve = yes; reject = no })
    let timer: ReturnType<typeof setTimeout>
    const finish = (file?: Result, reason = '对方离线或暂不支持查看成果') => {
      clearTimeout(timer)
      if (this.pending.get(peer)?.result !== result) return
      this.pending.delete(peer)
      if (file) resolve(file)
      else reject(new Error(reason))
    }
    const resetTimeout = () => { clearTimeout(timer); timer = setTimeout(finish, 20_000) }
    this.pending.set(peer, { identity, request: { ...ref, requestId: randomUUID(), offset: -1 }, result, finish, resetTimeout })
    resetTimeout()
    return result
  }

  stop(peer?: string) {
    for (const [id, pending] of this.pending) if (!peer || peer === id) pending.finish(undefined, '工作间连接已断开')
    if (peer) this.requests.delete(peer)
    else this.requests.clear()
  }

  async receive(peer: string, workspace: string, raw: unknown) {
    if (!raw) return false
    const { request, reply } = object(raw)
    if (request) {
      const ref = artifactRef(request), requestId = text(request.requestId, '请求编号', 64)
      if (!Number.isSafeInteger(request.offset) || request.offset < -1) fail('工作间文件分块不正确')
      this.requests.set(peer, { ...ref, requestId, offset: request.offset })
    }
    const p = this.pending.get(peer)
    if (!reply || !p || reply.requestId !== p.request.requestId || reply.offset !== p.request.offset) return !!request
    try {
      if (reply.reason) fail(text(reply.reason, '原因', 200))
      if (p.request.offset === -1) {
        p.files = wireFiles(reply.files)
        if (p.files?.length !== 1) fail('对方未提供有效的成果文件')
        const version = text(reply.version, '成果版本', 200)
        // Message IDs stop at 64 characters. Keep artifact transfers in a separate namespace.
        p.transfer = 'artifact:' + fingerprint([p.identity, version, p.files])
      }
      const chunk = wireChunk(reply.chunk)
      if (p.request.offset >= 0 && (chunk?.offset !== p.request.offset || chunk.index !== 0)) fail('工作间文件分块不正确')
      const result = await this.files.receive(peer, workspace, p.transfer!, fingerprint(p.files), p.files!, chunk)
      if ('error' in result) fail(result.error === 'capacity' ? '接收区空间不足' : '成果校验失败，请重新获取')
      if ('files' in result) {
        const [{ name, size, type }] = result.files
        p.finish({ name, size, type, key: path.basename(path.dirname(result.files[0].path)) })
      } else {
        p.request = { ...p.request, offset: result.offsets[0] }
        p.resetTimeout()
        return true
      }
    } catch (e) {
      p.finish(undefined, (e as { code?: string }).code === 'invalid_request' ? (e as Error).message : '成果文件接收失败')
    }
    return !!request
  }

  async packet(peer: string, lookup: (r: ArtifactRef) => Promise<{ root: string; file: string; version: string }>): Promise<ArtifactExchange | undefined> {
    const request = this.pending.get(peer)?.request, inbound = this.requests.get(peer)
    if (!inbound) return request && { request }
    this.requests.delete(peer)
    const { requestId, offset } = inbound
    try {
      const { root, file, version } = await lookup(inbound)
      return { request, reply: { requestId, offset, version, ...await artifactPart(root, file, offset) } }
    } catch (e) {
      const reason = (e as { code?: string }).code === 'invalid_request' ? (e as Error).message : '成果文件不存在或无法读取'
      return { request, reply: { requestId, offset, reason } }
    }
  }
}
