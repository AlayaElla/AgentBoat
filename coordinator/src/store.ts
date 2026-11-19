import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { pluginDataPath } from '../scripts/orca-cli.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import type { StorageApi } from 'orca'
import { ProjectArchive } from './project-archive'
import { blockedRevision, attention, projectSummary, taskState, type Acceptance, type Artifact, type Project, type ProjectRef, type SourceEvent, type Task, type Workspace, type Overview, type Messaging, type AgentSession, type StoredTakeover } from './model'

export const maxMessageLength = 16000
export function fail(message: string): never { throw Object.assign(new Error(message), { code: 'invalid_request' }) }
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('请求必须是对象')
  return value as Record<string, any>
}
export function text(value: unknown, label: string, max = 8000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label}不能为空，且不能超过 ${max} 字符`)
  return value.trim()
}
export function strings(value: unknown, label: string, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max) fail(`${label}格式不正确`)
  return [...new Set(value.map(x => text(x, label, 512)))]
}
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
export const takeoverActive = (t?: StoredTakeover) => !!t && Date.parse(t.expiresAt) > Date.now()
export function verifyTakeover(t: StoredTakeover | undefined, token: unknown, session: AgentSession, oldRun: string, newRun: string): StoredTakeover {
  if (!t || !takeoverActive(t) || typeof token !== 'string' || !token || t.tokenHash !== fingerprint(token)) fail('替换主会话需要有效的一次性接管凭据；请让主人重新发起切换')
  if (!t.target.handle) fail('启动回执尚未确认目标会话；请稍后重读绑定状态再试')
  if (t.target.handle !== session.handle) fail('接管凭据不属于当前会话；请在选中的目标会话调用')
  if (t.target.workspace !== session.workspace || t.target.agent !== session.agent) fail('目标会话的工作区或 agent 已变化；请重新发起切换')
  if (oldRun === newRun) fail('接管会话必须创建自己的新 Run')
  return t
}
export const projectKey = (hostId: string, repoId: string) => fingerprint([hostId, repoId]).slice(0, 24)
export function resetBackup(p: Project | Workspace, primary: string) {
  const history = p.backup?.history
  if (history?.length) p.backup = { primary, agent: '', phase: 'unavailable', cycle: randomUUID(), since: Date.now(), history }
  else delete p.backup
}
export function fresh(ref: ProjectRef): Project {
  return { version: 1, ref, revision: 0, runId: '', roles: { design: 'claude', code: 'codex', review: 'codex' },
    tasks: [], events: [], deliveries: [], requests: [] }
}
export function artifactUrl(value: unknown, root: string): string {
  const url = text(value, '成果路径', 4096)
  if (/^https?:\/\//i.test(url)) { new URL(url); return url }
  if (!path.isAbsolute(url)) fail('成果应为项目内绝对路径或 HTTP(S) 链接')
  const relative = path.relative(root, url)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('成果路径不属于当前项目')
  return path.resolve(url)
}


export function overview(projects: Project[], workspace: Workspace, error = ''): Overview {
  const hidden = projects.filter(p => p.hidden).map(p => p.ref)
  projects = projects.filter(p => !p.hidden)
  return { workspace: { revision: workspace.revision, runId: workspace.runId }, attention: projects.flatMap(attention),
    hidden,
    projects: projects.map(projectSummary), ...(error ? { error } : {}) }
}

// Transition keys include acceptance revisions; reads never create notifications.
export const workspaceNotices = (p: Project) => (p.hidden ? [] : p.tasks).flatMap(t => [
    ...t.decisions.filter(d => d.answer === undefined).map(d => ({ key: [t.id, 'decision', d.id], task: t, action: `请向用户确认：${d.question}` })),
    ...t.acceptance.filter(a => t.phase === 'ready' && a.status === 'pending').map(a => ({ key: [t.id, 'review', a.id, a.revision], task: t, action: `请用户验收：${a.title}` })),
    ...((blockedRevision(t) !== undefined || taskState(t) === 'completed') ? [{ key: [t.id, t.phase === 'blocked' ? 'blocked' : 'completed'], task: t, action: t.phase === 'blocked' ? `请协调解除受阻：${t.progress || t.goal}` : '任务已完成，请汇总告知用户' }] : [])
  ])
export function notifyWorkspace(before: Project, after: Project, runId: string): void {
  if (!runId) return
  const prior = new Set(workspaceNotices(before).map(n => fingerprint(n.key)))
  const notices = workspaceNotices(after).filter(n => !prior.has(fingerprint(n.key)) && !after.deliveries.some(d => d.noticeKeys?.includes(fingerprint(n.key))))
  if (!notices.length) return
  after.deliveries.push({ id: randomUUID(), noticeKeys: notices.map(n => fingerprint(n.key)), targetRunId: runId, subject: `${after.ref.name} · ${notices.map(n => n.task.title).filter((v, i, all) => all.indexOf(v) === i).join('、')}`.slice(0, 200),
    body: notices.map(n => `[项目 ${after.ref.id} / 任务 ${n.task.id}]\n${n.action.replace(/\s+/g, ' ').slice(0, 500)}`).join('\n\n') + '\n请读取工作间总览和项目记录后处理，决定与验收由用户作出。', state: 'pending' })
}

export class ProjectStore {
  private chain: Promise<unknown> = Promise.resolve()
  readonly archive: ProjectArchive
  constructor(private storage: Pick<StorageApi, 'get' | 'set' | 'keys' | 'delete'>,
    private exportDirectory = path.join(pluginDataPath(), 'exports'),
    private updateRoles?: () => Promise<void>) { this.archive = new ProjectArchive(exportDirectory) }
  async remove(id: string, expected: number, absent: () => Promise<void>): Promise<string> {
    return this.serial(async () => {
      const project = await this.get(id)
      if (project.revision !== expected) fail('项目已更新，请刷新后再删除')
      await mkdir(this.exportDirectory, { recursive: true })
      // The filename never contains input; an exclusive, flushed export must succeed before deletion.
      const exportPath = path.join(this.exportDirectory, `project-${fingerprint(id).slice(0, 24)}-${randomUUID()}.json`)
      await writeFile(exportPath, JSON.stringify(project, null, 2) + '\n', { flag: 'wx', flush: true })
      await absent()
      await this.storage.delete(`project:${id}`)
      this.archive.forget(project)
      await this.updateRoles?.()
      return exportPath
    })
  }
  async messaging(): Promise<Messaging> {
    const value = await this.storage.get('workspace.messaging')
    const m = value ? structuredClone(object(value)) as Messaging : { version: 1 as const, revision: 0, feishu: { appId: '', chatIds: [], senderIds: [], enabled: false }, inbox: [], deliveries: [] }
    if (m.version !== 1 || !Number.isSafeInteger(m.revision) || !Array.isArray(m.inbox) || !Array.isArray(m.deliveries) || !m.feishu) fail('工作间消息记录不兼容，请保留数据并检查版本')
    return m
  }
  async mutateMessaging(fn: (m: Messaging) => void | Promise<void>, expected?: number): Promise<Messaging> {
    return this.serial(async () => {
      const m = await this.messaging()
      if (expected !== undefined && expected !== m.revision) fail('工作间消息已更新，请刷新后再保存')
      await fn(m); m.revision++
      for (const d of m.deliveries) if (d.state === 'pending') d.createdAt ??= Date.now()
      for (const entry of m.inbox) {
        if (Buffer.byteLength(JSON.stringify(m)) < 150000) break
        if (entry.state !== 'done' || !m.deliveries.some(d => d.id === `response:${entry.event.id}` && d.state === 'sent' || d.id.startsWith('agent-reply:') && d.state === 'sent' && d.external?.replyTo === entry.event.sourceId.slice(entry.appId.length + 1))) continue
        entry.event.text = ''
      }
      for (const d of m.deliveries) {
        if (Buffer.byteLength(JSON.stringify(m)) < 150000) break
        if (d.state !== 'sent' || !d.body) continue
        d.receiptHash = fingerprint([d.body, d.external?.replyTo, d.external?.appId])
        d.body = ''; d.subject = ''; delete d.error
      }
      if (Buffer.byteLength(JSON.stringify(m)) > 200_000) fail('工作间消息记录已达容量上限；原记录已保留')
      await this.storage.set('workspace.messaging', m as any)
      await this.updateRoles?.()
      return m
    })
  }
  async workspace(): Promise<Workspace> {
    const value = await this.storage.get('workspace')
    if (value == null) return { version: 1, revision: 0, runId: '', requests: [] }
    const w = structuredClone(object(value)) as Workspace
    if (w.version !== 1 || !Number.isSafeInteger(w.revision) || w.revision < 0 || typeof w.runId !== 'string' || !Array.isArray(w.requests)) fail('工作间记录格式不兼容，请保留数据并检查插件版本')
    return w
  }
  async mutateWorkspace(fn: (w: Workspace) => void, expected?: number): Promise<Workspace> {
    return this.serial(async () => {
      const w = await this.workspace()
      if (expected !== undefined && w.revision !== expected) fail('工作间已更新，请刷新后再提交')
      fn(w); w.revision++
      await this.archive.compactLead(w)
      await this.storage.set('workspace', w as any)
      await this.updateRoles?.()
      return w
    })
  }
  async bindWorkspace(expected: number, runId: string, request: { id: string; input: unknown }, session: AgentSession, token = '', checkOnly = false): Promise<Workspace> {
    return this.serial(async () => {
      const w = await this.workspace(), hash = fingerprint(request.input), prior = w.requests.find(r => r.id === request.id)
      if (prior && !checkOnly) { if (prior.fingerprint !== hash) fail('同一个请求编号不能用于不同内容'); return w }
      if (prior) fail('检查请求编号已用于绑定；请换一个新的请求编号')
      if (w.revision !== expected) fail('工作间已更新，请刷新后再提交')
      if ((await this.all()).some(p => p.runId === runId)) fail('该 Run 已绑定项目；请在当前会话创建独立的工作间主 agent Run')
      if (w.runId || w.takeover || token) {
        const t = verifyTakeover(w.takeover, token, session, w.runId, runId)
        if (checkOnly) return w
        w.retired ??= []
        if (w.runId) w.retired.push({ id: `retired:${t.id}`, targetRunId: w.runId, subject: '工作间主 agent 已切换',
          body: `你已不再是工作间主 agent。新的主 agent：${session.title || session.handle}\n工作区：${session.workspaceName || session.workspace}\n目录：${session.path}\nAgent：${session.agent}\nRun：${runId}\n请停止承担工作间主 agent。已发送的通知不会补发；新的主 agent 会读取总览补齐事项。`, state: 'pending' })
      }
      if (checkOnly) return w
      resetBackup(w, session.handle)
      await this.archive.compactLead(w)
      w.session = session; w.boundAt = new Date().toISOString(); delete w.takeover
      w.runId = runId; w.revision++; w.requests.push({ id: request.id, fingerprint: hash })
      await this.storage.set('workspace', w as any)
      await this.updateRoles?.()
      return w
    })
  }
  async get(id: string): Promise<Project> {
    const value = await this.storage.get(`project:${id}`)
    if (!value) fail('项目尚未绑定，请先在项目列表选择项目')
    const project = object(value) as Project
    if (project.version !== 1 || !Array.isArray(project.tasks) || project.ref?.id !== id) fail('项目记录格式不兼容，请保留数据并检查插件版本')
    return structuredClone(project)
  }
  async all(): Promise<Project[]> {
    return Promise.all((await this.storage.keys()).filter(key => key.startsWith('project:')).map(key => this.get(key.slice(8))))
  }
  async register(ref: ProjectRef): Promise<Project> {
    return this.serial(async () => {
      const existing = await this.storage.get(`project:${ref.id}`)
      if (existing) return this.get(ref.id)
      const project = fresh(ref)
      await this.storage.set(`project:${ref.id}`, project as any)
      return project
    })
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn)
    this.chain = result.catch(() => {})
    return result
  }
  async mutate(id: string, expected: number | undefined, fn: (project: Project) => void | Promise<void>, request?: { id: string; input: unknown; authorize?: (project: Project) => void }, backgroundRoles = false): Promise<Project> {
    return this.serial(async () => {
      const project = await this.get(id)
      request?.authorize?.(project)
      const hash = request && fingerprint(request.input)
      const recent = request && project.requests.find(x => x.id === request.id)
      const prior = recent ?? (request && await this.archive.receipt(project, request.id))
      if (prior) {
        if (prior.fingerprint !== hash) fail('同一个请求编号不能用于不同内容')
        if (!recent) project.requests.push(prior) // Return the proof to this caller only.
        return project
      }
      if (expected !== undefined && expected !== project.revision) fail('项目已更新，请刷新后再提交')
      const previous = new Set(project.deliveries.map(d => d.id))
      await fn(project)
      for (const d of project.deliveries) if (d.state === 'pending' && !previous.has(d.id)) d.createdAt ??= Date.now()
      project.revision++
      project.updatedAt = new Date().toISOString()
      if (request) project.requests.push({ id: request.id, fingerprint: hash! })
      await this.archive.compactLead(project)
      await this.archive.compact(project)
      await this.storage.set(`project:${id}`, project as any)
      if (backgroundRoles) setImmediate(() => { void this.updateRoles?.().catch(() => {}) })
      else await this.updateRoles?.()
      return project
    })
  }
}

function list(value: unknown, label: string, max = 100): Record<string, any>[] {
  if (!Array.isArray(value) || value.length > max) fail(`${label}格式不正确`)
  return value.map(object)
}

export function submitTask(project: Project, raw: unknown): void {
  const input = object(raw)
  const id = text(input.id, '任务编号', 200)
  const old = project.tasks.find(x => x.id === id)
  const phase = input.phase
  if (!['working', 'ready', 'completed', 'blocked', 'paused'].includes(phase)) fail('任务阶段不正确')
  const task: Task = old ? structuredClone(old) : { id, title: '', goal: '', progress: '', phase, executions: [], artifacts: [], acceptance: [], decisions: [], sourceIds: [], updatedAt: '' }
  task.title = text(input.title, '任务标题', 200)
  task.goal = text(input.goal, '任务目标', 16000)
  task.progress = typeof input.progress === 'string' ? input.progress.slice(0, 16000) : task.progress
  task.phase = phase
  delete task.blockedStatus
  if (phase === 'blocked') task.blockedRevision = project.revision + 1
  else delete task.blockedRevision
  for (const a of list(input.artifacts ?? [], '成果')) {
    const artifact: Artifact = { id: text(a.id, '成果编号', 200), label: text(a.label, '成果名称', 200), url: artifactUrl(a.url, project.ref.path), version: text(a.version, '成果版本', 200) }
    const previous = task.artifacts.find(x => x.id === artifact.id)
    if (previous && fingerprint(previous) !== fingerprint(artifact)) fail('成果编号已存在；新版本请登记新的成果编号')
    if (!previous) task.artifacts.push(artifact)
  }
  const withdrawals: FeedbackItem[] = []
  function submittedItems(kind: 'decision' | 'acceptance', entries: Record<string, any>[]) {
    for (const entry of entries) {
      if (entry.discarded !== undefined && typeof entry.discarded !== 'boolean') fail('discarded 必须是布尔值')
      if (!entry.discarded) continue
      const itemId = text(entry.id, '撤下事项编号', 200)
      if (entries.filter(x => text(x.id, '事项编号', 200) === itemId).length !== 1) fail('同一次提交不能重复撤下或更新同一事项')
      const previous = (kind === 'decision' ? task.decisions : task.acceptance).find(x => x.id === itemId)
      if (!previous) fail('要撤下的事项不存在')
      const note = text(entry.reason, '撤下原因')
      if ('status' in previous ? previous.status === 'discarded' : previous.answer === null) continue
      withdrawals.push({ taskId: id, kind, itemId, itemRevision: 'revision' in previous ? previous.revision : undefined, result: 'discarded', note })
    }
    return entries.filter(entry => !entry.discarded)
  }
  for (const a of submittedItems('acceptance', list(input.acceptance ?? [], '验收项', 50))) {
    const artifactIds = strings(a.artifactIds, '关联成果')
    if (!artifactIds.length || artifactIds.some(id => !task.artifacts.some(x => x.id === id))) fail('验收项必须关联本任务已交付的成果')
    const fields = { title: text(a.title, '验收标题', 200), details: text(a.details, '核对方式与预期', 8000), artifactIds }
    const af = fingerprint(fields)
    const aid = text(a.id, '验收编号', 200)
    const previous = task.acceptance.find(x => x.id === aid)
    if (previous?.fingerprint === af) continue
    const item: Acceptance = { ...previous, id: aid, ...fields, revision: (previous?.revision ?? 0) + 1, status: 'pending', history: previous?.history ?? [], fingerprint: af }
    if (previous) task.acceptance[task.acceptance.indexOf(previous)] = item
    else task.acceptance.push(item)
  }
  for (const d of submittedItems('decision', list(input.decisions ?? [], '待决定事项', 30))) {
    const did = text(d.id, '决定编号', 200)
    const previous = task.decisions.find(x => x.id === did)
    const question = text(d.question, '问题', 4000)
    if (previous) { if (previous.question !== question) fail('新问题请使用新的决定编号'); continue }
    task.decisions.push({ id: did, question, options: strings(d.options ?? [], '选项', 10).map(x => text(x, '选项', 200)), history: [] })
  }
  for (const e of list(input.executions ?? [], '执行记录')) {
    if (!['codex', 'claude'].includes(e.agent)) fail('执行代理应为 Codex 或 Claude')
    const execution = { runId: text(e.runId, 'Run 编号', 200), taskId: text(e.taskId, 'Orca 任务编号', 200), dispatchId: text(e.dispatchId, '派工编号', 200), agent: e.agent as 'codex' | 'claude' }
    if (!task.executions.some(x => x.dispatchId === execution.dispatchId)) task.executions.push(execution)
  }
  for (const sourceId of strings(input.sourceIds ?? [], '来源编号')) {
    const event = project.events.find(x => x.id === sourceId)
    if (!event) fail('来源消息不属于当前项目')
    if (event.taskId && event.taskId !== task.id) fail('来源消息已关联其他任务')
    event.taskId = task.id
    if (!task.sourceIds.includes(sourceId)) task.sourceIds.push(sourceId)
  }
  // The lead withdrew these itself, so its own notice is not queued back to it.
  if (withdrawals.length) applyFeedback(project, [task], withdrawals, '项目主会话', true)
  if (phase === 'completed' && taskState({ ...task, phase: 'ready' }) !== 'completed') fail('仍有待决定、待验收或需修改的事项，不能标记为完成')
  task.updatedAt = new Date().toISOString()
  task.submittedAt = task.updatedAt
  if (old) project.tasks[project.tasks.indexOf(old)] = task
  else project.tasks.push(task)
}

export interface FeedbackItem { taskId: string; kind: 'acceptance' | 'decision' | 'blocked'; itemId: string; itemRevision?: number; reviewTotal?: number; fingerprint?: string; result?: string; answer?: string; note?: string }
export function feedback(project: Project, raw: unknown, source?: string): void {
  applyFeedback(project, project.tasks, object(raw).items, source)
}
function applyFeedback(project: Project, tasks: Task[], items: unknown, source?: string, withdrawal = false): void {
  if (!Array.isArray(items) || items.length > 100) fail('反馈条目格式不正确')
  if (!items.length) fail('请至少提交一条反馈')
  const seen = new Set<string>()
  const validated = items.map((rawItem, index) => {
    let input: Record<string, any> = {}
    try {
      input = object(rawItem)
      const key = fingerprint([input.taskId, input.kind, input.itemId])
      if (seen.has(key)) fail('同一事项不能重复提交')
      seen.add(key)
      const task = tasks.find(x => x.id === input.taskId)
      if (!task) fail('任务不属于当前项目')
      if (!withdrawal && task.phase === 'paused') fail('任务已暂停')
      const note = typeof input.note === 'string' ? input.note.trim().slice(0, 8000) : ''
      const discarded = input.result === 'discarded'
      if (input.kind === 'blocked') {
        const current = blockedRevision(task)
        if (current === undefined || input.itemId !== task.id || input.itemRevision !== current) fail('受阻项已更新，请刷新后确认')
        if (input.answer !== undefined || (input.result !== undefined && !discarded)) fail('受阻项只接受备注或丢弃')
        if (!discarded || input.note !== undefined && input.note !== '') text(input.note, '受阻备注')
        return { task, note: (input.note ?? '') as string, discarded, title: discarded ? '主人丢弃了这项受阻' : '主人答复了这项受阻' }
      }
      if (input.kind === 'acceptance') {
        const item = task.acceptance.find(x => x.id === input.itemId)
        if (!item || item.revision !== input.itemRevision || (!withdrawal && task.phase !== 'ready') || item.status !== 'pending') fail('验收项已更新或不在待验收状态，请刷新后确认')
        if (input.reviewTotal !== undefined && input.reviewTotal !== task.acceptance.filter(a => a.status === 'pending').length) fail('待验收项已更新，请刷新后确认')
        if (input.fingerprint !== undefined && input.fingerprint !== item.fingerprint) fail('验收内容已更新')
        if (!['passed', 'changes_requested', 'discarded'].includes(input.result)) fail('验收结论不正确')
        if (input.result === 'changes_requested' && !note) fail('请填写需要修改的内容')
        return { task, item, note, discarded, result: input.result as string, subject: input.result === 'passed' ? '验收通过' : '需要修改', title: `${item.title} · 第 ${item.revision} 版`, revision: item.revision }
      }
      if (input.kind !== 'decision') fail('反馈类型不正确')
      const item = task.decisions.find(x => x.id === input.itemId)
      if (!item || item.answer !== undefined) fail('问题已回答、已丢弃或不存在，请刷新')
      if (input.fingerprint !== undefined && input.fingerprint !== fingerprint([item.question, item.options])) fail('问题内容已更新')
      if (discarded && input.answer !== undefined) fail('丢弃的决定不能同时填写答案')
      if (input.result && !discarded) fail('决定结论不正确')
      return { task, item, note, discarded, result: discarded ? 'discarded' : text(input.answer, '决定', 8000), subject: '决定已提交', title: item.question, revision: 1 }
    } catch (e) { return fail(`第 ${index + 1} 条（${input.taskId || '?'} / ${input.itemId || '?'}）：${e instanceof Error ? e.message : '反馈不正确'}`) }
  })
  const at = new Date().toISOString()
  for (const v of validated) {
    v.task.updatedAt = at
    if (!v.item) {
      v.task.blockedStatus = v.discarded ? 'discarded' : 'replied'
      if (!v.note) continue
      const id = randomUUID()
      recordSource(project, { id, source: 'owner-feedback', sourceId: id, threadId: id, taskId: v.task.id,
        senderId: source ?? '主人', text: v.note, receivedAt: at, chatId: '' })
      continue
    }
    if ('status' in v.item) v.item.status = v.result as Acceptance['status']
    else v.item.answer = v.discarded ? null : v.result
    const actor = source ?? (v.discarded ? '主人' : undefined)
    v.item.history.push({ at, revision: v.revision, result: v.result, note: v.note, ...(actor ? { source: actor } : {}) })
  }
  if (withdrawal) return
  const body = validated.map(v => `[项目 ${project.ref.id} / 任务 ${v.task.id}]\n${v.task.title}\n${v.title}\n${v.item ? (v.discarded ? '已丢弃' : v.subject + '：' + v.result) + '\n' : ''}${v.note}`).join('\n\n')
  project.deliveries.push({ id: randomUUID(), subject: `用户反馈 · ${validated.length} 条`, body: source ? `${source}\n\n${body}` : body, state: 'pending' })
}

function recordSource(project: Project, event: SourceEvent) {
  if (project.events.some(x => x.source === event.source && x.sourceId === event.sourceId)) return false
  const earlier = !event.taskId && project.events.find(x => x.threadId === event.threadId && x.taskId)
  if (earlier) event.taskId = earlier.taskId
  if (event.taskId) {
    const task = project.tasks.find(x => x.id === event.taskId)
    if (task && !task.sourceIds.includes(event.id)) task.sourceIds.push(event.id)
  }
  project.events.push(event)
  return true
}

export function receiveEvent(project: Project, event: SourceEvent): void {
  if (!recordSource(project, event)) return
  project.deliveries.push({ id: event.id, subject: event.taskId ? '主 agent任务补充' : '主 agent项目消息',
    body: `[工作间主 agent 转来]\n项目：${project.ref.id}\n来源编号：${event.id}\n关联任务：${event.taskId ?? '待判断'}\n发送者：${event.senderId}\n${event.text}`, state: 'pending' })
}

export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail('请先读取当前版本')
  return value as number
}
export function mergeProjects(saved: Project[], refs: ProjectRef[]): Project[] {
  const byId = new Map(saved.map(p => [p.ref.id, p]))
  return refs.map(ref => ({ ...(byId.get(ref.id) ?? fresh(ref)), ref }))
}
export function feishuConfig(raw: unknown): import('./model').FeishuConfig {
  const f = object(raw)
  if (typeof f.enabled !== 'boolean') fail('飞书启用状态不正确')
  return { enabled: f.enabled, appId: typeof f.appId === 'string' ? f.appId.trim().slice(0, 200) : '', chatIds: strings(f.chatIds, '允许的会话'), senderIds: strings(f.senderIds, '允许的用户') }
}
