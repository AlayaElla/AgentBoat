import { artifactReason, reasonText } from './artifact-errors'
import type http from 'node:http'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { artifactRef, LinkArtifacts, streamTimeout, transferKey, type ArtifactRef, type StreamOffer } from './link-artifacts'
import { openArtifactStream, maxLinkFileBytes } from './link-files'
import { fail, fingerprint, object, text } from './store'

type Peer = { id: string; workspaceId: string; endpoint: string }
type Source = { root: string; file: string; version: string }
type Connect = (url: string, route: string, headers: http.OutgoingHttpHeaders, signal: AbortSignal) => http.ClientRequest
type Payload = { headers: http.OutgoingHttpHeaders; body: AsyncIterable<Buffer> }

function offer(raw: unknown): StreamOffer {
  const r = object(raw)
  return { ...artifactRef(r), requestId: text(r.requestId, '请求编号', 64),
    ...(typeof r.cached === 'string' && /^artifact:[a-f0-9]{64}$/.test(r.cached) && { cached: r.cached }) }
}
const metadataHeader = 'x-artifact-meta', reasonHeader = 'x-artifact-reason'
function readMeta(msg: http.IncomingMessage) {
  const raw = msg.headers[metadataHeader]
  if (typeof raw !== 'string' || raw.length > 8192) fail(reasonText('invalid'))
  return JSON.parse(Buffer.from(raw, 'base64url').toString())
}

export class ArtifactStream {
  private sending = new Map<string, AbortController>()
  constructor(private artifacts: LinkArtifacts, private connect: Connect,
    private source: (peer: string, ref: ArtifactRef) => Promise<Source>) {}

  stop(peer?: string) {
    for (const [id, controller] of this.sending) if (!peer || id === peer) controller.abort()
  }

  private async request(p: Peer, token: string, route: string, requestId: string, data: Payload | Buffer, signal: AbortSignal) {
    const payload = Buffer.isBuffer(data) ? { headers: { 'content-length': data.length }, body: [data] } : data
    const req = this.connect(p.endpoint, route, { ...payload.headers, authorization: 'Bearer ' + token,
      'x-workspace-link': p.id, 'x-artifact-request': requestId }, signal)
    const response = new Promise<http.IncomingMessage>((yes, no) => {
      req.once('response', yes)
      req.once('error', no)
    })
    const [res] = await Promise.all([response, pipeline(Readable.from(payload.body), req, { signal })])
    return res
  }

  async pull(p: Peer, token: string, wanted: StreamOffer, signal: AbortSignal) {
    const res = await this.request(p, token, '/artifact/get', wanted.requestId, Buffer.from(JSON.stringify(wanted)), signal)
    try {
      if (res.statusCode !== 200) {
        if (res.statusCode === 401 || res.headers[reasonHeader]) {
          this.artifacts.rejectDirect(p.id, wanted.requestId, res.statusCode === 401 ? 'auth' : res.headers[reasonHeader])
          return
        }
        fail(reasonText(res.statusCode === 404 ? 'unsupported' : 'interrupted'))
      }
      await this.artifacts.stream(p.id, p.workspaceId, wanted.requestId, readMeta(res), res, Number(res.headers['content-length']))
    } finally { res.destroy() }
  }

  async push(p: Peer, token: string, raw: unknown) {
    const wanted = offer(raw)
    try {
      await this.send(p, wanted, async (payload, signal) => {
        const res = await this.request(p, token, '/artifact/push', wanted.requestId, payload, signal)
        res.destroy()
        if (res.statusCode !== 200) fail(reasonText('interrupted'))
      })
    } catch (e) {
      const reason = artifactReason(e, 'interrupted')
      if (reason === 'interrupted' || reason === 'timeout') return // The receiver falls back on disconnect or handshake timeout.
      const req = this.connect(p.endpoint, '/artifact/push', { authorization: 'Bearer ' + token, 'x-workspace-link': p.id,
        'x-artifact-request': wanted.requestId, [reasonHeader]: reason, 'content-length': 0 }, AbortSignal.timeout(5000))
      req.on('error', () => {}).on('response', res => res.resume()).end()
    }
  }

  async serve(p: Peer, req: http.IncomingMessage, res: http.ServerResponse, raw?: unknown) {
    const requestId = text(req.headers['x-artifact-request'], '请求编号', 64)
    try {
      if (req.url === '/artifact/push') {
        const length = Number(req.headers['content-length'])
        if (!Number.isSafeInteger(length) || length < 0 || length > maxLinkFileBytes || req.headers[reasonHeader] && length !== 0) {
          res.writeHead(413, { connection: 'close' }).end()
          return
        }
        if (req.headers[reasonHeader]) this.artifacts.rejectDirect(p.id, requestId, req.headers[reasonHeader])
        else {
          await this.artifacts.stream(p.id, p.workspaceId, requestId, readMeta(req), req, length)
        }
        res.writeHead(200).end()
      } else {
        const wanted = offer(raw)
        if (wanted.requestId !== requestId) fail(reasonText('invalid'))
        await this.send(p, wanted, async (payload, signal) => {
          res.writeHead(200, { ...payload.headers, 'cache-control': 'no-store', 'content-type': 'application/octet-stream' })
          await pipeline(Readable.from(payload.body), res, { signal })
        })
      }
    } catch (e) {
      if (!res.headersSent && !res.destroyed) res.writeHead(403, { [reasonHeader]: artifactReason(e, 'invalid') }).end()
      else res.destroy()
    }
  }

  private async send(p: Peer, wanted: StreamOffer, transmit: (payload: Payload, signal: AbortSignal) => Promise<void>) {
    if (this.sending.has(p.id)) fail(reasonText('busy'))
    const controller = new AbortController(), timeout = AbortSignal.timeout(streamTimeout)
    const signal = AbortSignal.any([controller.signal, timeout])
    this.sending.set(p.id, controller)
    const started = Date.now()
    let stage = 'authorize', size: number | undefined
    const log = (state: string, reason?: ReturnType<typeof artifactReason>) =>
      this.artifacts.record('send', state, wanted.requestId, started, size, stage, reason)
    log('start')
    try {
      const source = await this.source(p.id, wanted)
      log('authorized')
      stage = 'open_hash'
      const { input, metadata: file, verify: verifyFile } = await openArtifactStream(source.root, source.file, signal)
      try {
        size = file.size
        log('ready')
        const cached = wanted.cached === transferKey(fingerprint(artifactRef(wanted)), source.version, [file])
        const length = cached ? 0 : size
        const verify = async () => {
          signal.throwIfAborted()
          const [current] = await Promise.all([this.source(p.id, wanted), verifyFile()])
          if (current.file !== source.file || current.root !== source.root || current.version !== source.version) fail(reasonText('changed'))
        }
        async function* bytes() {
          let lastCheck = Date.now(), sent = 0
          if (length) {
            for await (const chunk of input.createReadStream({ start: 0, end: length - 1, autoClose: false, signal })) {
              signal.throwIfAborted()
              sent += chunk.length
              if (sent === length || Date.now() - lastCheck >= 1000) { await verify(); lastCheck = Date.now() }
              yield chunk as Buffer
            }
            if (sent !== length) fail(reasonText('changed'))
          }
        }
        await verify()
        stage = 'stream'
        await transmit({ headers: { [metadataHeader]: Buffer.from(JSON.stringify({ file, version: source.version })).toString('base64url'),
          'content-length': length }, body: bytes() }, signal)
        log('complete')
      } finally { await input.close() }
    } catch (e) {
      const reason = timeout.aborted ? 'timeout' : artifactReason(e, stage === 'open_hash' ? 'missing' : 'interrupted')
      log('failed', reason)
      fail(reasonText(reason))
    } finally { this.sending.delete(p.id) }
  }
}
