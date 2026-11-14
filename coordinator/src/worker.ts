import type { OrcaWorkerApi } from 'orca/worker'
import type { Project, ProjectRef, Snapshot, SourceEvent } from './model'
import { FeishuSources } from './feishu'
import { OrcaRuntime, defaultExecutable, type CoordinatorRuntime } from './runtime'
import { ProjectStore, artifactUrl, fail, feedback, fingerprint, fresh, notifyWorkspace, object, overview, receiveEvent, strings, submitTask, text } from './store'

const revision = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail('请先读取项目当前版本')
  return value as number
}

export function createCoordinator(orca: OrcaWorkerApi, runtime: CoordinatorRuntime) {
  const store = new ProjectStore(orca.storage)
  let catalog: ProjectRef[] = []
  let runtimeError = ''
  const busy = new Map<string, Promise<void>>()
  const changed = (projectId = '') => orca.panels.post('project.changed', { projectId })
  const secret = (id: string) => orca.secrets.get(`feishu:${id}`)
  const sources = new FeishuSources(ingest, () => changed())

  async function projects() {
    try { catalog = await runtime.projects(); runtimeError = '' }
    catch (e) { runtimeError = `无法读取 Orca 项目：${e instanceof Error ? e.message.slice(0, 2000) : '请检查 Orca 与 CLI 路径'}` }
    return { projects: catalog, ...(runtimeError ? { error: runtimeError } : {}) }
  }
  async function ensure(id: string): Promise<Project> {
    if (!catalog.length) await projects()
    const ref = catalog.find(p => p.id === id)
    if (!ref) fail('项目不在当前 Orca 本机项目列表中，请刷新后选择')
    return store.register(ref)
  }
  async function snapshot(id: string): Promise<Snapshot> {
    if (!catalog.length) await projects()
    const project = catalog.some(p => p.id === id) ? await ensure(id) : (await store.all()).find(p => p.ref.id === id) ?? await ensure(id)
    return { projects: catalog, project, secretSaved: !!await secret(id),
      connection: project.feishu.enabled ? sources.state(project.feishu.appId) : { state: 'off', message: '' },
      ...(runtimeError ? { runtimeError } : {}) }
  }
  async function ingest(appId: string, event: SourceEvent): Promise<void> {
    const matches = (await store.all()).filter(p => p.feishu.enabled && p.feishu.appId === appId &&
      p.feishu.chatIds.includes(event.chatId) && p.feishu.senderIds.includes(event.senderId))
    if (matches.length !== 1) return
    const id = matches[0].ref.id
    if (matches[0].events.some(x => x.sourceId === event.sourceId && x.source === event.source)) return
    await store.mutate(id, undefined, p => { receiveEvent(p, event) })
    changed(id)
    setImmediate(() => { void flush(id).catch(() => {}) })
  }
  async function flush(id: string): Promise<void> {
    const running = busy.get(id)
    if (running) return running
    const work = (async () => {
      try {
        while (true) {
          const p = await store.get(id)
          const delivery = p.deliveries.find(x => x.state === 'pending' && (x.targetRunId || p.runId))
          if (!delivery) break
          await store.mutate(id, undefined, p => { p.deliveries.find(x => x.id === delivery.id)!.state = 'sending' })
          try {
            const receipt = await runtime.send(delivery.targetRunId || p.runId, delivery)
            await store.mutate(id, undefined, p => {
              const d = p.deliveries.find(x => x.id === delivery.id)!
              d.state = 'sent'; if (receipt.requestId) d.requestId = receipt.requestId
            })
          } catch {
            await store.mutate(id, undefined, p => {
              const d = p.deliveries.find(x => x.id === delivery.id)!
              d.state = 'uncertain'; d.error = '通知结果待核对，请在主会话检查；原消息已保存'
            })
            break
          }
        }
      } finally { busy.delete(id); changed(id) }
    })()
    busy.set(id, work)
    return work
  }
  const defer = (id: string) => setImmediate(() => { void flush(id).catch(() => {}) })
  orca.panels.handle('workspace.overview', async () => {
    await projects()
    const saved = await store.all()
    // Include stored projects even when their worktree is currently closed; overview never registers or rewrites them.
    return overview([...saved, ...catalog.filter(ref => !saved.some(p => p.ref.id === ref.id)).map(fresh)], await store.workspace(), runtimeError)
  })
  orca.panels.handle('workspace.agent', async input => {
    if (input.operation === 'bind') {
      const runId = text(input.runId, 'Run 编号', 200)
      await runtime.verifyRun(runId)
      await store.bindWorkspace(revision(input.revision), runId, { id: text(input.requestId, '请求编号', 200), input })
      changed()
    } else if (input.operation !== 'read') fail('不支持的工作间操作')
    const w = await store.workspace()
    return { revision: w.revision, runId: w.runId }
  })
  orca.panels.handle('workspace.message', async input => {
    const id = text(input.projectId, '项目编号', 200)
    await ensure(id)
    const requestId = text(input.requestId, '请求编号', 200), message = text(input.text, '消息', 16000)
    await store.mutate(id, revision(input.revision), async p => {
      const w = await store.workspace()
      if (!w.runId || input.runId !== w.runId) fail('请使用已绑定的工作间主 agent Run')
      if (!p.runId) fail('请先绑定项目主 agent')
      const eventId = `workspace-agent:${fingerprint([id, requestId])}`
      receiveEvent(p, { id: eventId, source: 'workspace-agent', sourceId: requestId, threadId: eventId,
        chatId: '', senderId: w.runId, text: message, receivedAt: new Date().toISOString() })
    }, { id: requestId, input })
    changed(id); defer(id)
    return snapshot(id)
  })
  orca.panels.handle('projects.list', projects)
  orca.panels.handle('project.read', input => snapshot(text(input.projectId, '项目编号', 200)))
  orca.panels.handle('project.settings', async input => {
    const id = text(input.projectId, '项目编号', 200)
    await ensure(id)
    const roles = object(input.roles)
    if (['design', 'code', 'review'].some(k => !['codex', 'claude'].includes(roles[k]))) fail('请选择 Codex 或 Claude')
    const f = object(input.feishu)
    if (typeof f.enabled !== 'boolean') fail('飞书启用状态不正确')
    const config: Project['feishu'] = { appId: typeof f.appId === 'string' ? f.appId.trim().slice(0, 200) : '',
      chatIds: strings(f.chatIds, '群聊编号'), senderIds: strings(f.senderIds, '允许的发送者'), enabled: f.enabled }
    const newSecret = input.appSecret ? text(input.appSecret, 'App Secret', 1000) : ''
    await store.mutate(id, revision(input.revision), async p => {
      const value = newSecret || (p.feishu.appId === config.appId ? await secret(id) : '')
      if (config.enabled && (!config.appId || !value || !config.chatIds.length || !config.senderIds.length)) fail('启用飞书需要 App ID、App Secret、群聊编号和允许的发送者')
      for (const other of await store.all()) {
        if (other.ref.id === id || other.feishu.appId !== config.appId) continue
        if (config.chatIds.some(chat => other.feishu.chatIds.includes(chat))) fail('同一飞书应用的群聊已绑定其他项目')
        const otherSecret = await secret(other.ref.id)
        if (value && otherSecret && otherSecret !== value) fail('共用飞书应用的项目必须使用相同凭据')
      }
      if (newSecret) await orca.secrets.set(`feishu:${id}`, newSecret)
      else if (p.feishu.appId !== config.appId) await orca.secrets.delete(`feishu:${id}`)
      p.roles = roles as Project['roles']; p.feishu = config
    })
    await sources.sync(await store.all(), secret)
    changed(id)
    return snapshot(id)
  })
  orca.panels.handle('project.feedback', async input => {
    await ensure(input.projectId)
    await store.mutate(input.projectId, revision(input.revision), async p => {
      const before = structuredClone(p)
      feedback(p, input)
      notifyWorkspace(before, p, (await store.workspace()).runId)
    })
    changed(input.projectId); defer(input.projectId)
    return snapshot(input.projectId)
  })
  orca.panels.handle('project.agent', async input => {
    const id = text(input.projectId, '项目编号', 200)
    if (input.operation === 'read') return snapshot(id)
    await ensure(id)
    if (!['bind', 'submit'].includes(input.operation)) fail('不支持的协作操作')
    const request = { id: text(input.requestId, '请求编号', 200), input }
    if (input.operation === 'bind') await runtime.verifyRun(text(input.runId, 'Run 编号', 200))
    await store.mutate(id, revision(input.revision), async p => {
      if (input.operation === 'bind') {
        if ((await store.all()).some(x => x.ref.id !== id && x.runId === input.runId)) fail('该主会话 Run 已绑定其他项目')
        p.runId = input.runId!
      } else {
        const before = structuredClone(p)
        submitTask(p, input.task)
        notifyWorkspace(before, p, (await store.workspace()).runId)
      }
    }, request)
    changed(id)
    defer(id)
    return snapshot(id)
  })
  orca.panels.handle('project.deliver', async input => {
    await ensure(input.projectId)
    const p = await store.get(input.projectId)
    const d = p.deliveries.find(x => x.id === input.deliveryId)
    if (!d || d.state !== 'pending') fail('仅可发送尚未发送的通知；结果待核对的通知不会重复发送')
    await flush(input.projectId)
    return snapshot(input.projectId)
  })
  orca.panels.handle('project.openArtifact', async input => {
    const p = await ensure(input.projectId)
    const a = p.tasks.find(x => x.id === input.taskId)?.artifacts.find(x => x.id === input.artifactId)
    if (!a || /^https?:/i.test(a.url)) fail('请选择本项目的本机成果')
    const url = artifactUrl(a.url, p.ref.path)
    await orca.host.call('editor.open', { workspaceId: p.ref.workspace.replace(/^id:/, ''), path: url })
    return { opened: true }
  })

  return { store, ingest, flush, stop: () => sources.stop(), async start() {
    for (const p of await store.all()) {
      if (p.deliveries.some(x => x.state === 'sending')) await store.mutate(p.ref.id, undefined, p => {
        for (const d of p.deliveries.filter(x => x.state === 'sending')) { d.state = 'uncertain'; d.error = '插件重启前通知结果待核对' }
      })
      defer(p.ref.id)
    }
    await sources.sync(await store.all(), secret)
  } }
}

let coordinator: ReturnType<typeof createCoordinator> | undefined
export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const runtime = new OrcaRuntime(async () => {
    const configured = await orca.settings.get('cliPath')
    return typeof configured === 'string' && configured.trim() ? configured.trim() : defaultExecutable()
  })
  coordinator = createCoordinator(orca, runtime)
  await coordinator.start()
}
export function deactivate(): void { coordinator?.stop() }
