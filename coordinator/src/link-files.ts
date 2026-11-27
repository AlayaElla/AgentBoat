import { reasonText } from './artifact-errors'
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pluginDataPath } from '../scripts/orca-cli.mjs'
import { artifactUrl, fail, fingerprint, object } from './store'
import { feedbackFileBytes, feedbackFileCount, feedbackPartBytes, type FeedbackAttachment, type FeedbackTarget } from './feedback-drafts'

export const maxLinkFileBytes = feedbackFileBytes, maxLinkFiles = feedbackFileCount
const maxOutgoingFiles = 100 * 1024 ** 2, maxReceivedFiles = 1024 ** 3
export const fileChunkBytes = feedbackPartBytes
// 160 KB of base64 leaves room for control fields in the 180 KB sync envelope.
export const artifactChunkBytes = 120_000
const manifestName = '.agentboat-transfer.json'
export type LinkFile = { name: string; size: number; sha256: string; type: string }
export type FileChunk = { index: number; offset: number; data: string }
type Manifest = { key: string; requestId: string; hash: string; at: string; files: LinkFile[] }
export type ReceivedFile = LinkFile & { path: string }
const mime = new Map(Object.entries({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.md': 'text/markdown', '.markdown': 'text/markdown', '.zip': 'application/zip' }))
export const fileType = (name: string) => mime.get(path.extname(name).toLowerCase()) ?? 'application/octet-stream'
const hashPattern = /^[a-f0-9]{64}$/
const segment = (value: string) => /^[\w-]{1,64}$/.test(value) ? value : fail('工作间文件目录编号不正确')
const isArtifactTransfer = (id: string) => /^artifact:[0-9a-f]{64}$/.test(id)
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'
const stat = (file: string) => lstat(file).catch(e => { if (!missing(e)) throw e })
const sha256 = async (file: string) => {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  return hash.digest('hex')
}

export function safeNames(values: string[]) {
  const used = new Set([manifestName])
  return values.map(value => {
    const base = (value.split(/[/\\]/).at(-1) ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim().replace(/[. ]+$/g, '')
    const extension = path.extname(base).slice(0, 12)
    let name = [...base.slice(0, base.length - path.extname(base).length)].slice(0, 44 - extension.length).join('') + extension
    if (!name) name = '附件'
    if (/^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(name)) name = '_' + name
    const ext = path.extname(name), stem = name.slice(0, name.length - ext.length)
    let candidate = name
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = stem + '-' + n + ext
    used.add(candidate.toLowerCase())
    return candidate
  })
}

export function safeFiles(files: LinkFile[]) {
  const names = safeNames(files.map(f => f.name))
  return files.map((f, i) => ({ ...f, name: names[i], type: fileType(names[i]) }))
}

export function wireFiles(raw: unknown): LinkFile[] | undefined {
  if (raw === undefined) return
  if (!Array.isArray(raw) || !raw.length || raw.length > maxLinkFiles) fail('工作间附件列表不正确')
  return raw.map(value => {
    const f = object(value)
    if (typeof f.name !== 'string' || !f.name || f.name.length > 240 || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > maxLinkFileBytes ||
      typeof f.sha256 !== 'string' || !hashPattern.test(f.sha256)) fail('工作间附件规格不正确')
    return { name: f.name as string, size: f.size as number, sha256: f.sha256 as string, type: fileType(f.name) }
  })
}

export function feedbackAttachment(raw: unknown): FeedbackAttachment {
  const value = object(raw), { id, name, size, sha256 } = value
  if (typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) ||
      typeof name !== 'string' || !name.trim() || name.length > 240 || /[/\\\u0000-\u001f\u007f]/.test(name)) fail('验收附件名称或编号不正确')
  wireFiles([value])
  return { id, name, size, sha256 }
}

export function feedbackBytes(data: unknown, limit: number) {
  if (typeof data !== 'string' || data.length > Math.ceil(limit / 3) * 4) fail('验收附件数据超过大小限制')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > limit || bytes.toString('base64') !== data) fail('验收附件数据不完整')
  return bytes
}

function checkFeedbackBytes(file: FeedbackAttachment, bytes: Buffer) {
  if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256)
    fail(`附件「${file.name}」不完整，请重新添加`)
}

export function wireChunk(raw: unknown, limit = fileChunkBytes): FileChunk | undefined {
  if (raw === undefined) return
  const c = object(raw)
  if (!Number.isSafeInteger(c.index) || c.index < 0 || c.index >= maxLinkFiles || !Number.isSafeInteger(c.offset) || c.offset < 0 || c.offset >= maxLinkFileBytes ||
    typeof c.data !== 'string' || !c.data || c.data.length > Math.ceil(limit / 3) * 4) fail('工作间文件分块不正确')
  return { index: c.index, offset: c.offset, data: c.data }
}

async function readChunk(input: Awaited<ReturnType<typeof open>>, size: number, index: number, offset: number, limit = fileChunkBytes) {
  const data = Buffer.alloc(Math.min(limit, size - offset))
  const { bytesRead } = await input.read(data, 0, data.length, offset)
  if (bytesRead !== data.length) fail(reasonText('changed'))
  return { index, offset, data: data.toString('base64') }
}

// Check the registered name, its resolved location and the opened file before reading any bytes.
async function openContained(root: string, file: string, canonicalRoot = false) {
  const base = await realpath(root)
  if (canonicalRoot && path.relative(root, base)) fail(reasonText('outside'))
  // macOS can register a canonical filename while the project uses a root alias such as /var.
  let anchor = root, target: string
  try { target = artifactUrl(file, anchor) }
  catch (e) {
    if (root === base) throw e
    anchor = base
    target = artifactUrl(file, anchor)
  }
  if (!path.isAbsolute(target) || process.platform === 'win32' && (!/^[a-z]:[/\\]/i.test(target) || target.slice(2).includes(':'))) fail(reasonText('outside'))
  const actual = await realpath(target)
  artifactUrl(actual, base)
  const info = await lstat(target)
  if (!info.isFile() || path.relative(actual, path.resolve(base, path.relative(anchor, target)))) fail(reasonText('special'))
  if (info.size > maxLinkFileBytes) fail(reasonText('too_large'))
  const input = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  try {
    const [pinned, current] = await Promise.all([input.stat(), lstat(target)])
    if (!pinned.isFile() || pinned.ino !== info.ino || pinned.dev !== info.dev || pinned.size !== info.size || !current.isFile() || current.ino !== pinned.ino || current.dev !== pinned.dev ||
      path.relative(actual, await realpath(target))) fail(reasonText('changed'))
    return { input, size: pinned.size }
  } catch (e) { await input.close(); throw e }
}

export async function readContainedArtifact(root: string, file: string, limit: number) {
  const { input, size } = await openContained(root, file, true)
  try {
    if (size > limit) fail('成果预览超过大小限制')
    const data = Buffer.alloc(size)
    const { bytesRead } = await input.read(data, 0, size, 0)
    if (bytesRead !== size) fail(reasonText('changed'))
    return data
  } finally { await input.close() }
}

async function artifactMetadata(input: Awaited<ReturnType<typeof open>>, file: string, size: number, signal?: AbortSignal) {
  const hash = createHash('sha256')
  if (size) for await (const bytes of input.createReadStream({ start: 0, end: size - 1, autoClose: false, signal })) hash.update(bytes)
  const [name] = safeNames([path.basename(file)])
  return { name, size, type: fileType(name), sha256: hash.digest('hex') }
}

export async function openArtifactStream(root: string, file: string, signal: AbortSignal) {
  const { input, size } = await openContained(root, file)
  try {
    const before = await input.stat()
    const metadata = await artifactMetadata(input, file, size, signal)
    const verify = async () => {
      const current = await openContained(root, file)
      try {
        const after = await current.input.stat()
        if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.ctimeMs !== after.ctimeMs) fail(reasonText('changed'))
      } finally { await current.input.close() }
    }
    return { input, metadata, verify }
  } catch (e) { await input.close(); throw e }
}

export async function artifactPart(root: string, file: string, offset: number) {
  const { input, size } = await openContained(root, file)
  try {
    if (offset === -1) {
      return { files: [await artifactMetadata(input, file, size)] }
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size) fail('工作间文件分块不正确')
    return { chunk: await readChunk(input, size, 0, offset, artifactChunkBytes) }
  } finally { await input.close() }
}

export class LinkFiles {
  constructor(private root = pluginDataPath(),
    private limits = { outgoing: maxOutgoingFiles, received: maxReceivedFiles }) {}

  private async folder(...parts: string[]) {
    let result = this.root
    await mkdir(result, { recursive: true, mode: 0o700 })
    for (const name of ['', ...parts]) {
      if (name) { result = path.join(result, name); await mkdir(result, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e }) }
      if (!(await lstat(result)).isDirectory()) fail('工作间文件目录不安全')
    }
    return result
  }

  private async existingFolder(...parts: string[]) {
    let result = this.root
    for (const name of ['', ...parts]) {
      if (name) result = path.join(result, name)
      const info = await stat(result)
      if (!info) return
      if (!info.isDirectory()) fail('工作间文件目录不安全')
    }
    return result
  }

  private feedbackKey(target: FeedbackTarget, file: FeedbackAttachment) {
    return fingerprint([target.projectId, target.taskId, target.itemId, target.itemRevision, file.id, file.sha256, file.size])
  }

  async uploadFeedbackPart(target: FeedbackTarget, file: FeedbackAttachment, offset: number, data: string) {
    const bytes = feedbackBytes(data, feedbackPartBytes), end = offset + bytes.length
    if (!Number.isSafeInteger(offset) || offset < 0 || end > file.size || !bytes.length && file.size !== 0) fail('验收附件分块不正确')
    const folder = await this.folder('feedback-drafts'), dest = path.join(folder, this.feedbackKey(target, file))
    const flags = offset === 0 ? 'wx' : constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW || 0)
    if (offset && !(await stat(dest))?.isFile()) fail('找不到上传中的附件，请重新添加')
    const output = await open(dest, flags, 0o600)
    try {
      const info = await output.stat()
      if (!info.isFile() || info.size !== offset) fail('验收附件分块位置不一致，请重新添加')
      await output.writeFile(bytes)
      if (end === file.size) await output.sync()
    } finally { await output.close() }
    if (end === file.size) await this.stagedFeedback(target, file)
  }

  async discardFeedbackPart(target: FeedbackTarget, file: FeedbackAttachment) {
    const folder = await this.existingFolder('feedback-drafts')
    if (folder) await rm(path.join(folder, this.feedbackKey(target, file)), { force: true })
  }

  async stagedFeedback(target: FeedbackTarget, file: FeedbackAttachment) {
    const folder = await this.existingFolder('feedback-drafts'), location = folder && path.join(folder, this.feedbackKey(target, file))
    if (!location || !(await stat(location))?.isFile()) fail(`附件「${file.name}」已找不到，请重新添加`)
    const root = await realpath(folder!)
    const bytes = await readContainedArtifact(root, path.join(root, path.basename(location)), file.size)
    checkFeedbackBytes(file, bytes)
    return bytes
  }

  async saveFeedback(target: FeedbackTarget, file: FeedbackAttachment, bytes: Buffer) {
    checkFeedbackBytes(file, bytes)
    const folder = await this.folder('feedback', this.feedbackKey(target, file)), dest = path.join(folder, safeNames([file.name])[0])
    const temporary = path.join(folder, '.feedback-' + randomUUID())
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true })
      await rename(temporary, dest)
    } finally { await rm(temporary, { force: true }) }
  }

  async feedbackFile(target: FeedbackTarget, file: FeedbackAttachment, offset?: number) {
    const folder = await this.existingFolder('feedback', this.feedbackKey(target, file)), name = safeNames([file.name])[0]
    if (!folder) fail(`附件「${file.name}」已找不到，请检查工作间备份`)
    const root = await realpath(folder), dest = path.join(root, name)
    if (offset === undefined) {
      checkFeedbackBytes(file, await readContainedArtifact(root, dest, file.size))
      return { path: dest, name }
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= file.size) fail('验收附件读取位置不正确')
    const { input, size } = await openContained(root, dest, true)
    try {
      if (size !== file.size) fail(`附件「${file.name}」不完整，请检查工作间备份`)
      return { data: (await readChunk(input, size, 0, offset)).data }
    } finally { await input.close() }
  }

  async messageJournal() {
    const folder = await this.existingFolder()
    if (!folder) return
    const file = path.join(folder, 'link-messages.json'), info = await stat(file)
    if (info && !info.isFile()) fail('工作间消息记录目录不安全')
    if (info) return JSON.parse(await readFile(file, 'utf8')) as unknown
  }

  async saveMessageJournal(records: unknown[]) {
    const folder = await this.folder(), target = path.join(folder, 'link-messages.json')
    const temporary = path.join(folder, '.link-messages-' + randomUUID())
    try {
      await writeFile(temporary, JSON.stringify(records), { flag: 'wx', mode: 0o600, flush: true })
      await rename(temporary, target)
    } finally { await rm(temporary, { force: true }) }
  }

  async stage(peer: string, raw: unknown, pendingBytes: number) {
    if (!Array.isArray(raw) || !raw.length || raw.length > maxLinkFiles) fail('一条消息须包含 1 到 10 个文件')
    const sources = []
    let total = 0
    for (const value of raw) {
      if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value) ||
        (process.platform === 'win32' && !/^[a-z]:[/\\]/i.test(value))) fail('请填写本机文件的绝对路径')
      const source = await realpath(value), info = await stat(source)
      if (!info?.isFile() || (process.platform === 'win32' && !/^[a-z]:[/\\]/i.test(source))) fail('仅可发送本机普通文件')
      if (info.size > maxLinkFileBytes) fail(reasonText('too_large'))
      total += info.size
      if (total > this.limits.outgoing || total + pendingBytes > this.limits.outgoing) fail('此连接待发附件已达 100 MB 上限，原记录已保留')
      sources.push({ source, size: info.size, name: path.basename(value) })
    }
    const spool = randomUUID(), folder = await this.folder('outgoing', segment(peer), spool)
    try {
      const files: LinkFile[] = [], names = safeNames(sources.map(f => f.name))
      for (const [index, { source, size }] of sources.entries()) {
        const input = await open(source, 'r')
        try {
          const info = await input.stat()
          if (!info.isFile() || info.size !== size) fail('读取过程中附件已变化，请重新选择')
          const output = await open(path.join(folder, String(index)), 'wx', 0o600)
          const buffer = Buffer.alloc(Math.min(65_536, size)), hash = createHash('sha256')
          try {
            let offset = 0
            while (offset < size) {
              const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, size - offset), offset)
              if (!bytesRead) fail('读取过程中附件已变化，请重新选择')
              const bytes = buffer.subarray(0, bytesRead)
              hash.update(bytes)
              await output.writeFile(bytes)
              offset += bytesRead
            }
            if ((await input.stat()).mtimeMs !== info.mtimeMs) fail('读取过程中附件已变化，请重新选择')
            await output.sync()
          } finally { await output.close() }
          files.push({ name: names[index], size, sha256: hash.digest('hex'), type: fileType(names[index]) })
        } finally { await input.close() }
      }
      return { spool, files }
    } catch (e) { await this.discard(peer, spool); throw e }
  }

  async chunk(peer: string, spool: string, files: LinkFile[], offsets: number[]) {
    const index = files.findIndex((f, i) => offsets[i] < f.size)
    if (index < 0) return
    const offset = offsets[index], folder = await this.existingFolder('outgoing', segment(peer), segment(spool))
    if (!folder) fail('待发附件未找到')
    const file = path.join(folder, String(index))
    if (!(await stat(file))?.isFile()) fail('待发附件未找到')
    const input = await open(file, 'r')
    try { return await readChunk(input, files[index].size, index, offset) } finally { await input.close() }
  }

  async discard(peer: string, spool?: string) {
    const folder = await this.existingFolder('outgoing', segment(peer), ...(spool ? [segment(spool)] : []))
    if (folder) await rm(folder, { recursive: true, force: true })
  }
  async revoke(peer: string) {
    await this.discard(peer)
    const folder = await this.existingFolder('receiving', segment(peer))
    if (folder) await rm(folder, { recursive: true, force: true })
  }

  private async manifests(folder: string) {
    const rows: { folder: string; record: Manifest }[] = []
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(e => { if (!missing(e)) throw e; return [] })) {
      if (!entry.isDirectory()) continue
      const directory = path.join(folder, entry.name), file = path.join(directory, manifestName)
      if (!(await stat(file))?.isFile()) continue
      rows.push({ folder: directory, record: JSON.parse(await readFile(file, 'utf8')) as Manifest })
    }
    return rows
  }

  private async offsets(directory: string, files: LinkFile[]) {
    const names = safeNames(files.map(f => f.name))
    return Promise.all(names.map(async (name, index) => {
      const info = await stat(path.join(directory, name))
      if (info && (!info.isFile() || info.size > files[index].size)) fail('工作间附件临时文件不安全')
      return info?.size ?? 0
    }))
  }

  private async receivedArtifact(peer: string, workspace: string, key: string) {
    if (typeof key !== 'string' || !/^[\w-]{1,100}$/.test(key)) fail('未找到已接收的成果')
    const folder = await this.existingFolder('received', segment(workspace), key)
    if (!folder) fail('未找到已接收的成果')
    const manifest = path.join(folder, manifestName)
    if (!(await stat(manifest))?.isFile()) fail('未找到已接收的成果')
    const record: Manifest = JSON.parse(await readFile(manifest, 'utf8'))
    if (!isArtifactTransfer(record.requestId) || record.key !== fingerprint([peer, record.requestId])) fail('此文件不属于本次成果传输')
    const [f] = safeFiles(record.files)
    return { file: path.join(folder, f.name), expectedSize: f.size }
  }

  async artifactPath(peer: string, workspace: string, key: string) {
    const { file, expectedSize } = await this.receivedArtifact(peer, workspace, key)
    const { input, size } = await openContained(this.root, file)
    await input.close()
    if (size !== expectedSize) fail('接收的成果已变化，请重新获取')
    return file
  }

  async readArtifact(peer: string, workspace: string, key: string, offset: number) {
    if (!Number.isSafeInteger(offset) || offset < 0) fail('未找到已接收的成果')
    const { file, expectedSize } = await this.receivedArtifact(peer, workspace, key)
    const { input, size } = await openContained(this.root, file)
    try {
      if (size !== expectedSize || offset > size) fail('接收的成果已变化，请重新获取')
      // Orca limits each JSON panel response to 1 MiB, including base64 encoding.
      const bytes = Buffer.alloc(Math.min(256 * 1024, size - offset))
      const { bytesRead } = await input.read(bytes, 0, bytes.length, offset)
      if (bytesRead !== bytes.length) fail('接收的成果已变化，请重新获取')
      return bytes.toString('base64')
    } finally { await input.close() }
  }

  async incomplete(peer: string) {
    const folder = await this.existingFolder('receiving', segment(peer))
    if (!folder) return []
    const rows = await this.manifests(folder)
    return Promise.all(rows.filter(({ record }) => !isArtifactTransfer(record.requestId)).map(async ({ folder, record }) => ({
      requestId: record.requestId, at: record.at, files: safeFiles(record.files), offsets: await this.offsets(folder, record.files)
    })))
  }

  async receiveStream(peer: string, workspace: string, transfer: string, file: LinkFile, body: AsyncIterable<Buffer>,
    length: number, progress: (n: number) => void, signal: AbortSignal) {
    const files = [file], hash = fingerprint(files)
    const reserve = () => this.receive(peer, workspace, transfer, hash, files)
    const initial = await reserve()
    if ('error' in initial) fail(reasonText(initial.error))
    if ('offsets' in initial && length !== file.size) fail('成果缓存不可用')
    const key = fingerprint([peer, transfer])
    const folder = 'offsets' in initial && await this.existingFolder('receiving', segment(peer), key)
    // Reuse the reservation's partial file so a broken stream can resume through the chunk protocol.
    const output = folder ? await open(path.join(folder, safeFiles(files)[0].name),
      constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW || 0), 0o600) : undefined
    try {
      let count = 0
      for await (const bytes of body) {
        signal.throwIfAborted()
        count += bytes.length
        if (count > length) fail('成果大小与声明不符')
        await output?.writeFile(bytes)
        progress(count)
      }
      if (count !== length) fail('成果读取不完整，请重试')
      await output?.sync()
    } finally { await output?.close() }
    signal.throwIfAborted()
    if ('files' in initial) return initial.files[0]
    const result = await reserve()
    if (!('files' in result)) fail(reasonText('checksum'))
    return result.files[0]
  }

  private writes = Promise.resolve()
  receive(...args: Parameters<LinkFiles['receivePart']>) {
    const result = this.writes.then(() => this.receivePart(...args))
    this.writes = result.then(() => {}, () => {})
    return result
  }

  private async receivePart(peer: string, workspace: string, requestId: string, hash: string, files: LinkFile[], chunk?: FileChunk):
    Promise<{ offsets: number[] } | { files: ReceivedFile[] } | { error: 'capacity' | 'checksum' }> {
    const key = fingerprint([peer, requestId]), finalRoot = await this.folder('received', segment(workspace))
    const incoming = await this.folder('receiving', segment(peer)), directory = path.join(incoming, key)
    const cleanFiles = safeFiles(files), names = cleanFiles.map(f => f.name)
    const attach = (folder: string) => ({ files: cleanFiles.map(f => ({ ...f, path: path.join(folder, f.name) })) })
    const journal = path.join(directory, manifestName)
    const existingDirectory = await stat(directory)
    if (existingDirectory && !existingDirectory.isDirectory()) fail('工作间文件目录不安全')
    let record: Manifest
    if ((await stat(journal))?.isFile()) {
      record = JSON.parse(await readFile(journal, 'utf8'))
      if (record.hash !== hash) fail('对端消息编号重复且正文不同')
    } else {
      const done = await this.manifests(finalRoot), existing = done.find(row => row.record.key === key)
      if (existing) {
        if (existing.record.hash !== hash) fail('对端消息编号重复且正文不同')
        return attach(existing.folder)
      }
      const amount = (items: LinkFile[]) => items.reduce((n, f) => n + f.size, 0)
      const partial = []
      for (const row of await this.manifests(incoming)) {
        // One artifact pull per peer. Release abandoned reservations when another version starts.
        if (isArtifactTransfer(requestId) && isArtifactTransfer(row.record.requestId)) await rm(row.folder, { recursive: true, force: true })
        else partial.push(row)
      }
      if (partial.length >= 10) fail('此连接正在接收的消息已达上限')
      let excess = [...done, ...partial].reduce((n, row) => n + amount(row.record.files), amount(files)) - this.limits.received
      if (excess > 0) {
        const copies = done.filter(({ record }) => isArtifactTransfer(record.requestId) && record.key === fingerprint([peer, record.requestId]))
          .sort((a, b) => a.record.at.localeCompare(b.record.at))
        const evict = []
        for (const { folder, record } of copies) {
          const [file] = safeFiles(record.files)
          const names = await readdir(folder)
          if (names.length !== 2 || !names.includes(file.name)) continue
          evict.push({ folder, file })
          excess -= file.size
          if (excess <= 0) break
        }
        if (excess > 0) return { error: 'capacity' }
        for (const { folder, file } of evict) {
          await rm(path.join(folder, file.name))
          await rm(path.join(folder, manifestName))
          await rmdir(folder)
        }
      }
      record = { key, requestId, hash, at: new Date().toISOString(), files }
      await this.folder('receiving', peer, key)
      const temporary = path.join(directory, '.agentboat-manifest-' + randomUUID())
      try {
        await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600, flush: true })
        await rename(temporary, journal)
      } finally { await rm(temporary, { force: true }) }
    }
    const offsets = await this.offsets(directory, files)
    if (chunk) {
      const { index, offset, data } = chunk, f = files[index], bytes = Buffer.from(data, 'base64')
      if (!f || !bytes.length || bytes.length > (isArtifactTransfer(requestId) ? artifactChunkBytes : fileChunkBytes) || bytes.toString('base64') !== data || offset + bytes.length > f.size) fail('工作间文件分块不正确')
      if (offset === offsets[index]) {
        const file = path.join(directory, names[index])
        await writeFile(file, bytes, { flag: 'a', mode: 0o600, flush: true })
        offsets[index] += bytes.length
      }
    }
    if (files.some((f, i) => offsets[i] !== f.size)) return { offsets }
    for (const [i, f] of files.entries()) {
      const file = path.join(directory, names[i])
      if (f.size === 0 && !await stat(file)) await writeFile(file, '', { flag: 'wx', mode: 0o600, flush: true })
      if (await sha256(file) !== f.sha256) {
        await rm(directory, { recursive: true, force: true })
        return { error: 'checksum' }
      }
    }
    const destination = path.join(finalRoot, record.at.slice(0, 10) + '-' + safeNames([requestId])[0] + '-' + key.slice(0, 12))
    await rename(directory, destination)
    return attach(destination)
  }
}
