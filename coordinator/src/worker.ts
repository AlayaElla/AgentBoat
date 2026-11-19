import os from 'node:os'
import path from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { Connections } from './connections'
import type { OrcaWorkerApi } from 'orca/worker'
import { agents, type AgentSession, type LeadSwitch, type Project, type ProjectLead, type ProjectRef, type Snapshot, type SourceEvent, type Delivery, type MessagingSnapshot } from './model'
import { FeishuSources, notifyFeishu, type MessageTransport } from './feishu'
import { OrcaRuntime, defaultExecutable, type CoordinatorRuntime } from './runtime'
import { ProjectStore, artifactUrl, fail, feedback, fingerprint, fresh, maxMessageLength, notifyWorkspace, object, overview, receiveEvent, submitTask, strings, text, revision, mergeProjects, feishuConfig, takeoverActive, verifyTakeover } from './store'
import { WorkspaceLinks } from './links'
import { fileErrorText, incomingHash, linkMessageHistory } from './link-messages'
import { LinkFiles } from './link-files'
import { groupedAttention, isProjectShared, isRunNotice, type OwnerQuestion } from './model'
import { mainAgent, roleReminder, switchLead, takeoverView, recoverTakeover } from './main-agent'
import { projectLeadDefaults } from '../../workspace/agent-launch.mjs'
import { clientPath, installationRoot, release, roleRegistryPath } from '../scripts/orca-cli.mjs'
import { cliBridge } from '../scripts/cli-bridge.mjs'
import { applyDelta, type Sheets } from './feedback-drafts'
import { roleRegistry } from './role-registry'
import { escalationWait, projectSubmissions, reportSubmitted } from '../scripts/worker-reports.mjs'

const activityInterval = 60_000

export function createCoordinator(orca: OrcaWorkerApi, runtime: CoordinatorRuntime, transport?: MessageTransport, exportDirectory?: string, linkFiles?: LinkFiles, roleFile?: string) {
  const refreshRoles: (() => Promise<void>) | undefined = roleFile ? roleRegistry(roleFile, async () => {
    const [workspace, projects, mailbox] = await Promise.all([store.workspace(), store.all(), store.messaging().catch(() => undefined)])
    const registered = catalog && mergeProjects(projects, projectRefs(catalog, workspace))
    return { workspace, projects: registered ?? projects, mailbox, current: catalogUnavailable ? undefined : registered }
  }) : undefined
  const store: ProjectStore = new ProjectStore(orca.storage, exportDirectory, refreshRoles)
  let draftWrites = Promise.resolve()
  orca.panels.handle('panel.feedbackState', ({ change }) => {
    const operation = draftWrites.then(async () => {
      const sheets = (await orca.storage.get('panel.feedbackState') ?? {}) as unknown as Sheets
      if (change) {
        applyDelta(sheets, change)
        await orca.storage.set('panel.feedbackState', sheets as any)
        orca.panels.post('panel.draftsChanged', {})
      }
      return sheets
    })
    draftWrites = operation.then(() => {}, () => {})
    return operation
  })
  let catalog: ProjectRef[] | undefined
  let catalogUnavailable = false
  let readingCatalog: Promise<{ refs?: ProjectRef[]; error?: string }> | undefined
  const busy = new Map<string, Promise<void>>()
  const changed = (projectId = '') => { agentsDirty = true; links.localChanged(); orca.panels.post('project.changed', { projectId }); void updateStatus().catch(() => {}) }
  const main = mainAgent(orca, store, runtime, changed, deferMailbox, async () => (await availableProjectRecords()).list)
  let statusUpdates: Promise<unknown> = Promise.resolve()
  let live: import('./agents').AgentsSnapshot = { ok: false, at: 0, agents: [] }
  let agentsDirty = true, refreshingAgents: Promise<typeof live> | undefined
  function refreshAgents(force = false): Promise<typeof live> {
    if (force) agentsDirty = true
    if (refreshingAgents) return refreshingAgents
    if (!agentsDirty && live.ok && Date.now() - live.at < activityInterval) return Promise.resolve(live)
    refreshingAgents = (async () => {
      do {
        const { list } = await availableProjectRecords()
        agentsDirty = false
        try { live = await runtime.agents(list, orca.host, (await store.workspace()).session) }
        catch { live = { ok: false, at: Date.now(), agents: [], error: 'agent 状态读不到' } }
        await updateStatus()
      } while (agentsDirty)
      return live
    })().finally(() => { refreshingAgents = undefined })
    return refreshingAgents
  }
  orca.panels.handle('workspace.agents', async input => {
    const { list } = await availableProjectRecords(), snapshot = await refreshAgents(input?.refresh === true)
    const visible = new Set(list.filter(p => !p.hidden).map(p => p.ref.id))
    return { ...snapshot, agents: snapshot.agents.filter(a => visible.has(a.projectId)) }
  })
  orca.panels.handle('workspace.agent.open', async input => {
    const id = text(input.id, 'Agent 编号', 2049), snapshot = await refreshAgents(true)
    if (!snapshot.ok) fail('Agent 状态读不到，请刷新后重试')
    const agent = snapshot.agents.find(a => a.id === id)
    if (!agent && snapshot.truncated) fail('未能确认这个 Agent 的状态，请刷新后重试')
    if (!agent || agent.state !== 'need') fail('已不需要你处理')
    await requireProject(agent.projectId)
    if (agent.terminalId) {
      const { focused } = await orca.host.call('terminal.focus', { terminalId: agent.terminalId })
      if (!focused) fail('Orca 未切换到这个会话，请刷新后重试')
      return { opened: true, focusedTerminal: true }
    }
    if (!agent.workspaceId) fail('找不到这个会话的工作区，请刷新后重试')
    const { opened } = await orca.host.call('workspace.open', { workspaceId: agent.workspaceId })
    return { opened, focusedTerminal: false }
  })
  const refreshActivity = async () => { await refreshAgents(true); links.localChanged(); orca.panels.post('project.changed', { projectId: '' }) }
  const activityEvent = orca.events.on('agent.status.changed', refreshActivity)
  let questions: OwnerQuestion[] = [], pollingQuestions: Promise<void> | undefined
  let actionableRunMail = new Set<string>()
  const mailKey = (item: OwnerQuestion) => fingerprint([item.runId, item.id])
  const unsubmitted = async (items: OwnerQuestion[], list: Project[]) => {
    const projects = new Map(list.filter(p => !p.hidden).map(p => [p.ref.id, p]))
    const proofs = new Map<string, ReturnType<typeof projectSubmissions>>()
    const remaining = items.filter(item => {
      const project = projects.get(item.projectId)
      if (!project || project.runId !== item.runId) return false
      if (!item.report) return true
      if (!proofs.has(item.projectId)) proofs.set(item.projectId, projectSubmissions(project))
      return !proofs.get(item.projectId)!.some(proof => reportSubmitted(item.report!, proof))
    })
    const archived = new Set<OwnerQuestion>()
    for (const id of proofs.keys()) {
      const rows = remaining.filter(q => q.projectId === id && q.report)
      const submitted = await store.archive.submittedReports(projects.get(id)!, rows.map(q => q.report!))
      for (const q of rows) if (submitted.has(q.report!.id)) archived.add(q)
    }
    return remaining.filter(q => !archived.has(q))
  }
  const visibleQuestions = (list: Project[]) => unsubmitted(questions, list)
  function refreshQuestions() {
    pollingQuestions ??= (async () => {
      const { list, error } = await availableProjectRecords()
      if (error) return
      const bound = list.filter(p => !p.hidden && p.runId)
      const now = Date.now()
      const updated = new Map<string, { runId: string; questions: OwnerQuestion[] }>()
      for (let i = 0; i < bound.length; i += 4) await Promise.all(bound.slice(i, i + 4).map(async p => {
        const inbox = await runtime.mail(p.runId).catch(() => undefined)
        if (!inbox) return
        const row = (q: { id: string; from: string; body: string; at: number }): OwnerQuestion => ({
          id: q.id, from: q.from, at: q.at, title: (q.body.trim().split(/\r?\n/, 1)[0] || '执行者回报').slice(0, 120),
          body: q.body.slice(0, maxMessageLength), runId: p.runId, projectId: p.ref.id
        })
        const reports = inbox.reports.flatMap(report => report.runId === p.runId && report.at !== undefined
          ? [{ ...row({ ...report, at: report.at }), report: { ...report, body: '' } }] : [])
        updated.set(p.ref.id, { runId: p.runId, questions: [...inbox.questions.map(row), ...reports] })
      }))
      const current = await availableProjectRecords()
      if (current.error) return
      const currentRuns = new Map(current.list.filter(p => !p.hidden).map(p => [p.ref.id, p]))
      const verified = await unsubmitted([...updated.values()].flatMap(result => result.questions), current.list)
      questions = verified.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
      actionableRunMail = new Set(verified.map(mailKey))
      const w = await store.workspace()
      const saved = (await store.messaging()).deliveries
      const records = new Map(saved.map(d => [d.id, d]))
      const notices = verified.flatMap((mail): Delivery[] => {
        const key = mailKey(mail), firstId = `orca-mail:project:${key}`, escalatedId = `orca-mail:workspace:${key}`
        const first = records.get(firstId)
        const escalate = !!w.runId && !!first?.runNotice?.attemptedAt &&
          ['sent', 'uncertain'].includes(first.state) && now - first.runNotice.attemptedAt >= escalationWait && !records.has(escalatedId)
        if (first && !escalate) return []
        const project = currentRuns.get(mail.projectId)!, label = mail.report ? '执行者回报待提交' : '执行者问题待回复'
        const action = escalate ? '请联系项目主会话核对，由你判断是否需要告诉主人。'
          : mail.report ? '请核对成果并用 submit 登记。' : '请核对原问题并回复，确需主人处理时请登记为受阻或待决定。'
        return [{ id: escalate ? escalatedId : firstId, noticeKeys: [key], state: 'pending', ...(!escalate ? { targetRunId: mail.runId } : {}),
          runNotice: { stage: escalate ? 'workspace' : 'project', projectId: mail.projectId, runId: mail.runId },
          subject: `${project.ref.name} · ${label}`.slice(0, 200),
          body: `项目：${project.ref.name}（${mail.projectId}）\n邮件：${mail.id} · 执行者 ${mail.from}\n原文摘录（资料）：\n${mail.body.slice(0, 1000)}\n${action}` }]
      })
      const obsolete = (delivery: Delivery) => {
        if (delivery.state !== 'pending') return false
        if (!delivery.runNotice) return isRunNotice(delivery.id)
        const { projectId, runId } = delivery.runNotice
        return currentRuns.get(projectId)?.runId !== runId ||
          updated.get(projectId)?.runId === runId && !actionableRunMail.has(delivery.noticeKeys?.[0] ?? '')
      }
      if (notices.length || saved.some(obsolete)) await store.mutateMessaging(m => { m.deliveries = [...m.deliveries.filter(d => !obsolete(d)), ...notices] })
      if (notices.length || saved.some(d => d.state === 'pending' && d.runNotice && actionableRunMail.has(d.noticeKeys?.[0] ?? ''))) deferMailbox()
    })().finally(() => { pollingQuestions = undefined })
    return pollingQuestions
  }
  function updateStatus() {
    const work = statusUpdates.then(async () => {
      const { list } = await availableProjectRecords(), all = overview(list, await store.workspace())
      const visible = new Set(all.projects.map(p => p.ref.id))
      const count = groupedAttention(all.attention).length + (live.ok ? live.agents.filter(a => a.state === 'need' && visible.has(a.projectId)).length : 0)
      await orca.host.call('statusBar.update', { id: 'coordinator', text: `工作间 · 待处理 ${count}${live.truncated ? '+' : ''}`, tooltip: `${!live.ok ? 'agent 状态读不到 · ' : live.truncated ? 'agent 状态未全部读取 · ' : ''}打开工作间总览 · Mod+Alt+Shift+J` })
    })
    statusUpdates = work.catch(() => {}); return work
  }
  async function openOverview(switching = false) {
    await orca.storage.set('workspace.navigation', { switching })
    await runtime.openOverview()
    orca.panels.post('workspace.open', { switching })
    return { opened: true }
  }
  orca.commands.register('workspace.overview', () => openOverview())
  orca.panels.handle('workspace.entry', () => openOverview(true))
  const links = new WorkspaceLinks(orca, async () => {
    const { list, error } = await availableProjectRecords()
    if (error) fail('本机项目列表不可用，请恢复后再上报')
    return list
  }, () => orca.panels.post('project.changed', { projectId: '' }), undefined, async (peer, messages) => {
    await store.mutateMessaging(m => {
      const sent = m.deliveries.filter(d => d.linkMessageHash && d.state === 'sent')
      const expired = new Set(sent.slice(0, Math.max(0, sent.length - linkMessageHistory)))
      if (expired.size) m.deliveries = m.deliveries.filter(d => !expired.has(d))
      for (const message of messages) {
        const id = 'link-message:' + fingerprint([peer.id, message.requestId]), linkMessageHash = incomingHash(message)
        const prior = m.deliveries.find(d => d.id === id)
        if (prior) {
          if (prior.linkMessageHash !== linkMessageHash) fail('对端消息编号重复且正文不同')
          continue
        }
        const subject = `来自工作间「${peer.name}」的主 agent`
        const files = message.attachments?.map(f => `- ${f.name} · ${f.size} 字节 · ${f.type}\n  ${f.path}`).join('\n')
        const attachmentNotice = files ? `\n\n附件（不执行、不自动打开）：\n${files}` : message.fileError ? `\n\n${fileErrorText[message.fileError]}。` : ''
        const body = `回复用 links-send，id 填 ${peer.id}。\n\n${message.text}${attachmentNotice}`
        m.deliveries.push({ id, linkMessageHash, subject, body, state: 'pending' })
      }
    })
    deferMailbox()
  }, async () => {
    const [workspace, live] = await Promise.all([main.read(), refreshAgents()])
    return { workspace, live }
  }, linkFiles, readCatalog, async (peer, input) => {
    const { list, error } = await availableProjectRecords()
    if (error) fail(error)
    const ref = list.find(p => p.ref.id === input.projectId)
    if (!ref || !isProjectShared(ref, peer)) fail('项目未开放或已隐藏')
    const source = `主人在工作间 ${peer.name.replace(/\s+/g, ' ')} 提交`
    const project = await recordFeedback(input, revision(input.revision), { source, connectionId: peer.id, authorize: p => {
      if (!isProjectShared(p, peer)) fail('项目未开放或已隐藏')
    } })
    return project.requests.find(r => r.id === `link-feedback:${fingerprint([peer.id, input.requestId])}`)?.fingerprint
  })
  orca.panels.handle('workspace.links', async input => {
    switch (input.operation) {
      case 'read': return links.snapshot(true)
      case 'send': {
        const { runId } = await store.workspace()
        if (!runId || input.runId !== runId) fail('请使用已绑定的工作间主 agent Run')
        return links.send(input)
      }
      case 'configure': return links.configure(input)
      case 'rename': return links.rename(input)
      case 'invite': return links.invite()
      case 'cancel-invite': return links.cancelInvite()
      case 'join': return links.join(text(input.code, '连接码', 6000))
      case 'share': return links.share(input)
      case 'relate': return links.relate(input)
      case 'revoke': return links.revoke(text(input.id, '连接编号', 64))
      case 'refresh': return links.refresh()
      default: return fail('不支持的工作间连接操作')
    }
  })
  orca.panels.handle('workspace.linkFeedback', input => links.submitFeedback(text(input.id, '连接编号', 64), input))
  const secret = (id: string) => orca.secrets.get(`feishu:${id}`)
  const sources = transport ?? new FeishuSources(ingest, () => changed())
  const mailbox = '@workspace'
  let inbound: Promise<unknown> = Promise.resolve()
  async function syncSources() {
    const m = await store.messaging()
    await sources.sync(m.feishu, await secret(mailbox))
  }
  async function messagingSnapshot(): Promise<MessagingSnapshot> {
    const m = await store.messaging()
    return { ...m, deliveries: m.deliveries.filter(d => !d.linkMessageHash), secretSaved: !!await secret(mailbox), connection: m.feishu.enabled ? sources.state(m.feishu.appId) : { state: 'off', message: '' } }
  }
  async function notify(before: Project, after: Project) {
    const [workspace, messaging] = await Promise.all([store.workspace(), store.messaging()])
    notifyWorkspace(before, after, workspace.runId)
    notifyFeishu(before, after, messaging.feishu)
  }

  function readCatalog() {
    return readingCatalog ??= (async () => {
      try {
        const refs = await runtime.projects(orca.host)
        const changed = !catalog || catalog.length !== refs.length || catalog.some((p, i) => {
          const next = refs[i]
          return p.id !== next.id || p.name !== next.name || p.workspace !== next.workspace || p.path !== next.path
        })
        const refreshRegistry = catalogUnavailable || changed && catalog !== undefined
        if (changed) {
          agentsDirty = true
          if (catalog) links.localChanged()
        }
        catalog = refs
        catalogUnavailable = false
        if (refreshRegistry) void refreshRoles?.()
        return { refs }
      } catch (e) {
        if (!catalogUnavailable) { catalogUnavailable = true; void refreshRoles?.() }
        return { refs: catalog, error: `无法读取 Orca 项目：${e instanceof Error ? e.message.slice(0, 2000) : '请检查 Orca 与 CLI 路径'}` }
      }
    })().finally(() => { readingCatalog = undefined })
  }
  function projectRefs(refs: ProjectRef[], { runId, session }: import('./model').WorkspaceBinding) {
    const directory = runId && session?.path
    return directory ? refs.filter(p => path.relative(directory, p.path) !== '') : refs
  }
  async function availableProjects() {
    const [{ refs, error }, workspace] = await Promise.all([readCatalog(), store.workspace()])
    return { refs: projectRefs(refs ?? (await store.all()).map(p => p.ref), workspace), error }
  }
  async function availableProjectRecords() {
    const [{ refs, error }, saved] = await Promise.all([availableProjects(), store.all()])
    return { list: mergeProjects(saved, refs), error }
  }
  async function projectEntry(id: string) {
    await readingCatalog
    const { refs, error } = await availableProjects()
    if (error) fail(error)
    const ref = refs?.find(p => p.id === id)
    if (!ref) fail('项目已从 Orca 移除或不在工作间项目列表')
    return { ref, refs }
  }
  async function requireProject(id: string) { return (await projectEntry(id)).ref }
  async function ensure(id: string): Promise<Project> { return store.register(await requireProject(id)) }
  async function snapshot(id: string, written?: Project): Promise<Snapshot> {
    const { refs, error: runtimeError } = await availableProjects(), ref = refs.find(p => p.id === id)
    if (!ref) fail(runtimeError ?? '项目已从 Orca 移除或不在工作间项目列表')
    const project = written ?? (!runtimeError ? await store.register(ref)
      : (await store.all()).find(p => p.ref.id === id) ?? fresh(ref))
    const sessions = project.mainAgentHandle && !runtimeError ? await runtime.targets().then(t => t.sessions).catch(() => undefined) : undefined
    const lead = projectBinding(project, sessions), agent = projectAgentKind(project)
    const { takeover, ...visible } = project
    return { projects: refs, project: visible, lead,
      ...(agent && Object.hasOwn(agents, agent) ? { mainAgent: agent as Snapshot['mainAgent'] } : {}), workspaceTarget: runtimeError ? { error: runtimeError } : await projectWorkspace(ref, lead.session),
      ...(runtimeError ? { runtimeError } : {}) }
  }
  const workspaceId = (selector: string) => selector.replace(/^id:/, '')
  const projectAgentKind = (p: Project) => p.mainSession && p.mainSession.handle === p.mainAgentHandle ? p.mainSession.agent
    : /^orca_session_id:(claude|codex|opencode)_/.exec(p.mainAgentHandle ?? '')?.[1]
  function projectBinding(p: Project, sessions?: AgentSession[]): import('./model').WorkspaceBinding {
    const handle = p.mainAgentHandle, takeover = takeoverView(p.takeover)
    const saved = p.mainSession?.handle === handle ? p.mainSession : undefined
    const live = sessions?.find(s => s.handle === handle)
    return { revision: p.revision, runId: p.runId, ...(p.runId && handle ? { session: live ?? {
      handle, title: saved?.title ?? '', workspace: saved?.workspace ?? p.ref.workspace, workspaceName: saved?.workspaceName ?? p.ref.name,
      path: saved?.path ?? p.ref.path, agent: projectAgentKind(p) ?? '', online: sessions ? 'offline' as const : 'unknown' as const
    } } : {}), ...(takeover ? { takeover } : {}) }
  }
  async function projectWorkspace(ref: ProjectRef, session?: AgentSession): Promise<import('./model').ProjectWorkspace> {
    try {
      const list = await orca.host.call('workspace.list', {})
      const candidates = list.workspaces.filter(w => w.projectId === ref.repoId && (w.hostId ?? 'local') === ref.hostId)
      const workspace = (session && candidates.find(w => w.id === workspaceId(session.workspace)))
        || candidates.find(w => w.id === workspaceId(ref.workspace))
      if (!workspace) fail(list.truncated ? '工作区列表未完整返回，请刷新后重试' : ref.workspace ? '项目工作区已被移除或不可用' : '这个项目当前没有工作区')
      const conversations = await orca.host.call('agents.list', { workspaceId: workspace.id }).catch(() => undefined)
      return { workspaceId: workspace.id, ...(conversations ? { multipleConversations: conversations.agents.length > 1 } : {}) }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }
  async function projectLeadTargets(ref: ProjectRef, p: Project) {
    const inventory = await runtime.targets()
    const session = inventory.sessions.find(s => s.handle === p.mainAgentHandle)
    const target = await projectWorkspace(ref, session)
    const workspaces = 'workspaceId' in target ? inventory.workspaces.filter(w => workspaceId(w.workspace) === target.workspaceId) : []
    const workspace = workspaces[0]
    const sessions = workspace ? inventory.sessions.filter(s => workspaceId(s.workspace) === workspaceId(workspace.workspace) &&
      s.online === 'online' && Object.hasOwn(agents, s.agent)) : []
    const error = 'error' in target ? target.error : workspace ? undefined : '项目工作区暂不可用，请刷新后重试'
    return { workspace, workspaces, sessions, inventory, error }
  }
  async function readProjectLead(id: string): Promise<ProjectLead> {
    const ref = await requireProject(id), p = await store.register(ref)
    const targets = await projectLeadTargets(ref, p).catch(() => ({ sessions: [], inventory: undefined, error: '会话列表暂不可用，请刷新后重试' }))
    return { binding: projectBinding(p, targets.inventory?.sessions), defaultAgent: projectLeadDefaults.agent, sessions: targets.sessions,
      ...(targets.error ? { workspaceError: targets.error } : {}) }
  }
  async function switchProjectLead(id: string, input: LeadSwitch, ownerRun?: string) {
    const ref = await requireProject(id), p = await store.register(ref)
    const scoped = input.mode === 'cancel' ? undefined : await projectLeadTargets(ref, p)
    if (scoped?.error) fail(scoped.error)
    const { agent, ...defaults } = projectLeadDefaults
    const selectedAgent = input.agent ?? agent
    await switchLead(runtime, { ...input, agent: selectedAgent, workspace: scoped?.workspace?.workspace }, {
      role: 'project',
      targets: async () => ({ sessions: scoped?.sessions ?? [], workspaces: scoped?.workspaces ?? [] }),
      mutate: (update, expected) => store.mutate(id, expected, async project => {
        if (ownerRun !== undefined && (!ownerRun || (await store.workspace()).runId !== ownerRun)) fail('请使用已绑定的工作间主 agent Run')
        update(project)
      }),
      changed: () => changed(id),
      launch: selectedAgent === agent ? defaults : { surface: defaults.surface },
      subject: '【项目协作】请接管项目主会话',
      prompt: (token, expiresAt) => `主人请当前会话接管项目「${ref.name}」（projectId: ${id}）。开启项目协作，先读 $orca-project-coordinator 和桥接说明，自己创建新的协调 Run。接管脚本绝对路径：${JSON.stringify(clientPath)}\n用 node 调用此脚本的 read ${id} 取得最新 revision，再调用 project-lead-bind，从标准输入传入 {projectId,revision,requestId,runId,token}。启动回执未确认时稍后重读再试。一次性接管凭据：${token}\n有效至：${expiresAt}\n凭据仅用于本次接管，不保存或转发。绑定成功后读该项目记录，接手任务、执行记录和待处理项；保留已有分工和用户决定。`
    })
    return readProjectLead(id)
  }
  function rememberProjectCaller(project: Project, input: { runId?: string; caller?: string }) {
    // Self-reported identity is display/navigation metadata, never authorization evidence.
    if (project.runId && input.runId === project.runId && input.caller) project.mainAgentHandle = text(input.caller, '调用会话', 500)
  }
  async function ingest(appId: string, event: SourceEvent): Promise<void> {
    const work = inbound.then(() => ingestOne(appId, event))
    inbound = work.catch(() => {})
    return work
  }
  async function ingestOne(appId: string, event: SourceEvent): Promise<void> {
    const m = await store.messaging(), f = m.feishu
    if (f.enabled && f.appId === appId && f.chatIds.includes(event.chatId)) {
      if (!f.senderIds.includes(event.senderId)) return
      if (!m.inbox.some(x => x.event.id === event.id)) await store.mutateMessaging(m => { m.inbox.push({ appId, event, state: 'pending' }) })
      await processMessage(event.id)
      changed(); setImmediate(() => { void flushMailbox().catch(() => {}) })
      return
    }
  }

  const response = (appId: string, event: SourceEvent, body: string): Delivery => ({ id: `response:${event.id}`, subject: '工作间', body, state: 'pending',
    external: { channel: 'feishu', appId, chatId: event.chatId, replyTo: event.sourceId.slice(appId.length + 1) } })
  async function processMessage(id: string) {
    const m = await store.messaging(), entry = m.inbox.find(x => x.event.id === id)
    if (!entry || entry.state === 'done') return
    const { appId, event } = entry, f = m.feishu
    if (!f.enabled || f.appId !== appId || !f.chatIds.includes(event.chatId) || !f.senderIds.includes(event.senderId)) return
    const all = await store.all()
    const sent = [...all.flatMap(p => p.deliveries), ...m.deliveries].filter(d => d.external?.appId === appId && d.external.chatId === event.chatId)
    // Prefer the immediate quoted message; a thread root may refer to a different reminder.
    const quoted = sent.filter(d => d.external?.messageId && d.external.messageId === event.replyToIds?.[0])
    const target = quoted.length === 1 ? quoted[0].external?.target : undefined
    const value = event.text.trim().replace(/^(?:@_user_\d+\s*)+/, '')
    let reply = ''
    if (target) {
      try {
        const p = await ensure(target.projectId), task = p.tasks.find(t => t.id === target.taskId)
        const d = task?.decisions.find(d => d.id === target.itemId)
        const requestId = `feishu-feedback:${event.id}`
        if (value.length > 7000) fail('反馈过长，请将决定或修改意见控制在 7000 字以内')
        let answer = '', result = ''
        if (target.kind === 'decision') {
          answer = /^\d+$/.test(value) ? d?.options[Number(value) - 1] ?? '' : d?.options.includes(value) ? value : /^决定[：:]/.test(value) ? value.replace(/^决定[：:]\s*/, '') : ''
          if (!answer) fail('请回复选项编号、完整选项，或「决定：你的决定」')
        } else {
          result = /^(通过|验收通过)$/.test(value) ? 'passed' : /^修改[：:]\s*\S/.test(value) ? 'changes_requested' : ''
          if (!result) fail('请回复「通过」或「修改：具体意见」')
        }
        await store.mutate(p.ref.id, undefined, async p => {
          const before = structuredClone(p)
          feedback(p, { items: [{ ...target, answer, result, note: `[飞书 ${event.sourceId} / ${event.senderId} / ${event.receivedAt}]\n${event.text}` }] })
          await notify(before, p)
        }, { id: requestId, input: { target, event } })
        defer(p.ref.id)
        reply = `已记录${target.kind === 'decision' ? '决定' : result === 'passed' ? '验收通过' : '修改意见'}：${p.ref.name} / ${target.taskId} / ${target.itemId} · 第 ${target.itemRevision} 版`
      } catch (e) { reply = e instanceof Error && (e as any).code === 'invalid_request' ? e.message : '记录未完成，请在 App 中核对后再处理' }
    } else if (quoted.length > 1 || (event.replyToIds?.length && !quoted.length) || /^(通过|验收通过|可以|好了|\d+|修改[：:].*|决定[：:].*)$/.test(value)) {
      reply = '请直接回复对应的待决定或待验收提醒，以确定唯一项目、事项和版本；不确定时请在 App 中查看。'
    }
    const w = await store.workspace()
    if (!reply && !w.runId) reply = '工作间尚未绑定主 agent，请先在 App 中绑定。'
    await store.mutateMessaging(m => {
      if (reply) {
        const d = response(appId, event, reply)
        if (!m.deliveries.some(saved => saved.id === d.id)) m.deliveries.push(d)
      } else if (!m.deliveries.some(d => d.id === event.id)) m.deliveries.push({ id: event.id, targetRunId: w.runId, subject: '飞书工作间消息', state: 'pending',
        body: `[工作间飞书来源资料]\n来源编号：${event.id}\n用户：${event.senderId}\n${event.text}\n回复用 feishu-reply，eventId 填来源编号。` })
      m.inbox.find(x => x.event.id === id)!.state = 'done'
    })
  }
  async function sendDelivery(d: Delivery, role: keyof typeof roleReminder, fallbackRunId = '') {
    if (d.external) return { messageId: await sources.send(d) }
    const body = role === 'project' && !d.id.startsWith('retired:') ? `${d.body}\n\n${roleReminder.project}` : d.body
    return runtime.send(d.targetRunId || fallbackRunId, { ...d, body })
  }
  function deferMailbox() { setImmediate(() => { void flushMailbox().catch(() => {}) }) }
  async function flushMailbox(): Promise<void> {
    const running = busy.get(mailbox)
    if (running) { await running; return flushMailbox() }
    const work = (async () => {
      try {
        while (true) {
          const { runId } = await store.workspace(), m = await store.messaging()
          const d = m.deliveries.find(x => x.state === 'pending' &&
            (x.runNotice ? actionableRunMail.has(x.noticeKeys?.[0] ?? '') : !isRunNotice(x.id)) &&
            (x.targetRunId || !(x.linkMessageHash || isRunNotice(x.id)) || runId) &&
            (!x.external || m.feishu.enabled && x.external.appId === m.feishu.appId && m.feishu.chatIds.includes(x.external.chatId)))
          if (!d) break
          let claimed = false
          await store.mutateMessaging(m => {
            const saved = m.deliveries.find(x => x.id === d.id)
            if (!saved || saved.state !== 'pending') return
            saved.state = 'sending'
            if (saved.runNotice) saved.runNotice.attemptedAt = Date.now()
            claimed = true
          })
          if (!claimed) continue
          try {
            const receipt = await sendDelivery(d, d.runNotice?.stage === 'project' ? 'project' : 'workspace', d.linkMessageHash || isRunNotice(d.id) ? runId : undefined)
            await store.mutateMessaging(m => {
              const saved = m.deliveries.find(x => x.id === d.id)!
              saved.state = 'sent'
              if ('messageId' in receipt && saved.external) saved.external.messageId = receipt.messageId
              if ('requestId' in receipt) saved.requestId = receipt.requestId
            })
          } catch {
            await store.mutateMessaging(m => { const saved = m.deliveries.find(x => x.id === d.id)!; saved.state = 'uncertain'; saved.error = '发送结果待核对，不会自动重发' })
            if (!d.linkMessageHash) break
          }
        }
      } finally { busy.delete(mailbox); changed() }
    })()
    busy.set(mailbox, work); return work
  }
  async function flush(id: string): Promise<void> {
    const running = busy.get(id)
    if (running) { await running; return flush(id) }
    const work = (async () => {
      let attempted = false
      try {
        while (true) {
          const p = await store.get(id)
          const f = (await store.messaging()).feishu
          const allowed = (d: Delivery, p: Project) => (!p.hidden || !d.external && (!d.targetRunId || d.id.startsWith('retired:'))) &&
            (d.external ? f.enabled && d.external.appId === f.appId && f.chatIds.includes(d.external.chatId) : d.targetRunId || p.runId)
          const delivery = p.deliveries.find(x => x.state === 'pending' && allowed(x, p))
          if (!delivery) break
          const { refs, error } = await availableProjects()
          if (error || !refs.some(ref => ref.id === id)) break
          let claimed = false, runId = ''
          await store.mutate(id, undefined, p => {
            if (!allowed(delivery, p)) return
            runId = p.runId
            p.deliveries.find(x => x.id === delivery.id)!.state = 'sending'; claimed = true
          })
          if (!claimed) continue
          attempted = true
          try {
            const receipt = await sendDelivery(delivery, delivery.targetRunId ? 'workspace' : 'project', runId)
            await store.mutate(id, undefined, p => {
              const d = p.deliveries.find(x => x.id === delivery.id)!
              d.state = 'sent'; if ('requestId' in receipt && receipt.requestId) d.requestId = receipt.requestId
              if ('messageId' in receipt && d.external) d.external.messageId = receipt.messageId
            })
          } catch {
            await store.mutate(id, undefined, p => {
              const d = p.deliveries.find(x => x.id === delivery.id)!
              d.state = 'uncertain'; d.error = '通知结果待核对，请在主会话检查；原消息已保存'
            })
            break
          }
        }
      } finally { busy.delete(id); if (attempted) changed(id) }
    })()
    busy.set(id, work)
    return work
  }
  const defer = (id: string) => setImmediate(() => { void flush(id).catch(() => {}) })
  async function validateFeishu(config: import('./model').FeishuConfig, newSecret: string) {
    const previous = (await store.messaging()).feishu
    const saved = newSecret || (previous.appId === config.appId ? await secret(mailbox) : '')
    if (config.enabled && (!config.appId || !saved || !config.chatIds.length || !config.senderIds.length)) fail('请填写应用、凭据、允许的会话和用户')
    return previous.appId !== config.appId
  }
  async function saveSecret(id: string, value: string, remove: boolean) {
    if (value) await orca.secrets.set(`feishu:${id}`, value)
    else if (remove) await orca.secrets.delete(`feishu:${id}`)
  }
  async function feishuSettings(input: import('./connections').ConnectionsInput) {
    const f = feishuConfig(input.feishu), value = input.appSecret ? text(input.appSecret, 'App Secret', 1000) : ''
    let remove = false
    await store.mutateMessaging(async m => { remove = await validateFeishu(f, value); m.feishu = f }, revision(input.revision))
    await saveSecret(mailbox, value, remove)
    await syncSources(); changed()
    return messagingSnapshot()
  }
  const connections = new Connections(orca, async () => (await store.workspace()).runId,
    (run, id, body, name) => sendDelivery({ id, targetRunId: run, subject: `来自外部连接「${name}」`, body, state: 'pending' }, 'workspace'), () => changed(), messagingSnapshot, feishuSettings, async () => {
      await store.mutateMessaging(m => { m.feishu = { enabled: false, appId: '', chatIds: [], senderIds: [] }; m.inbox = []; m.deliveries = m.deliveries.filter(d => !d.external) })
      await orca.secrets.delete(`feishu:${mailbox}`); await syncSources()
    })
  orca.panels.handle('workspace.connections', async input => {
    const result = await connections.handle(input)
    if (!Array.isArray(result) && result.connection.type === 'a2a') {
      try { const mode = await runtime.hermesApprovalMode(); if (mode) result.approvalMode = mode } catch { /* A peer need not expose local approval settings. */ }
    }
    return result
  })
  orca.panels.handle('workspace.reply', async input => {
    const w = await store.workspace()
    if (!w.runId || w.runId !== input.runId) fail('请使用已绑定的工作间主 agent Run')
    const id = text(input.eventId, '来源编号', 200), requestId = text(input.requestId, '请求编号', 200), body = text(input.text, '回复', maxMessageLength)
    await store.mutateMessaging(m => {
      const entry = m.inbox.find(x => x.event.id === id)
      if (!entry || !m.deliveries.some(d => d.id === id && !d.external)) fail('请选择已送入主 agent 的工作间飞书消息')
      const d = { ...response(entry.appId, entry.event, body), id: `agent-reply:${requestId}` }
      const prior = m.deliveries.find(x => x.id === d.id)
      if (prior) { if ((prior.receiptHash || fingerprint([prior.body, prior.external?.replyTo, prior.external?.appId])) !== fingerprint([d.body, d.external?.replyTo, d.external?.appId])) fail('请求编号已用于其他回复'); return }
      if (!m.feishu.enabled || m.feishu.appId !== entry.appId || !m.feishu.chatIds.includes(entry.event.chatId) || !m.feishu.senderIds.includes(entry.event.senderId)) fail('来源已不在工作间飞书允许范围内')
      m.deliveries.push(d)
    })
    await flushMailbox(); return messagingSnapshot()
  })
  orca.panels.handle('workspace.overview', async () => {
    const { list, error } = await availableProjectRecords()
    // Orca registration defines membership. A project can be registered without a workspace.
    const inbox = await visibleQuestions(list)
    return { ...overview(list, await store.workspace(), error), questions: inbox.filter(item => !item.report), reports: inbox.filter(item => item.report), workspace: await main.read(live), links: await links.snapshot(), connections: await connections.list(), machines: [{ id: 'local', name: os.hostname(), role: 'host' as const, online: true }] }
  })
  orca.panels.handle('workspace.message', async input => {
    const id = text(input.projectId, '项目编号', 200)
    await ensure(id)
    const requestId = text(input.requestId, '请求编号', 200), message = text(input.text, '消息', maxMessageLength)
    const written = await store.mutate(id, input.revision === undefined ? undefined : revision(input.revision), async p => {
      const w = await store.workspace()
      if (!w.runId || input.runId !== w.runId) fail('请使用已绑定的工作间主 agent Run')
      const eventId = `workspace-agent:${fingerprint([id, requestId])}`
      receiveEvent(p, { id: eventId, source: 'workspace-agent', sourceId: requestId, threadId: eventId,
        chatId: '', senderId: w.runId, text: message, receivedAt: new Date().toISOString() })
    }, { id: requestId, input })
    changed(id); defer(id)
    const result = await snapshot(id, written)
    return { ...result, ...(!result.project?.runId ? { queued: '项目还没有主会话，已排队' } : {}) }
  })
  orca.panels.handle('projects.list', async () => {
    const { refs, error } = await availableProjects()
    return { projects: refs, ...(error ? { error } : {}) }
  })
  orca.panels.handle('project.visibility', async input => {
    const id = text(input.projectId, '项目编号', 200)
    if (typeof input.hidden !== 'boolean') fail('隐藏状态不正确')
    await ensure(id)
    await store.mutate(id, revision(input.revision), p => { p.hidden = input.hidden; rememberProjectCaller(p, input) })
    changed(id); if (!input.hidden) defer(id)
    return snapshot(id)
  })
  orca.panels.handle('project.delete', async input => {
    const id = text(input.projectId, '项目编号', 200)
    if (input.confirm !== id) fail('删除前请确认项目编号；会删除任务、成果、决定、验收、来源、通知及项目设置记录，并先导出 JSON')
    await busy.get(id)
    await requireProject(id)
    const exportPath = await store.remove(id, revision(input.revision), async () => {
      await runtime.removeProject(await requireProject(id), orca.host)
      const { refs, error } = await readCatalog()
      if (error || refs?.some(p => p.id === id)) fail('Orca 未确认移除，工作间记录保留')
    })
    changed(id)
    await syncSources()
    return { deleted: id, exportPath }
  })
  orca.panels.handle('project.read', input => snapshot(text(input.projectId, '项目编号', 200)))
  orca.panels.handle('project.task', async input => {
    const id = text(input.projectId, '项目编号', 200), taskId = text(input.taskId, '任务编号', 200)
    await requireProject(id)
    const project = await store.get(id)
    return project.hidden ? null : project.tasks.find(t => t.id === taskId) ?? null
  })
  orca.panels.handle('project.archive', async input => {
    const p = await ensure(input.projectId)
    const { batch } = await store.archive.page(p, input.end)
    return { end: input.end ?? p.archive!.end, ...(batch.previous && { previousEnd: batch.previous.end }), tasks: batch.tasks ?? [],
      deliveries: batch.deliveries.length, events: batch.events?.length ?? 0, requests: batch.requests.length,
      history: batch.history?.reduce((count, part) => count + part.rows.length, 0) ?? 0 }
  })
  orca.panels.handle('project.lead', input => {
    const id = text(input.projectId, '项目编号', 200)
    return 'mode' in input ? switchProjectLead(id, input) : readProjectLead(id)
  })
  orca.panels.handle('workspace.projectLead', input => switchProjectLead(text(input.projectId, '项目编号', 200), input, text(input.runId, 'Run 编号', 200)))
  orca.panels.handle('project.openMain', async input => {
    const { workspaceTarget } = await snapshot(text(input.projectId, '项目编号', 200))
    if (!workspaceTarget || 'error' in workspaceTarget) fail(workspaceTarget?.error || '项目工作区不可用')
    const opened = await orca.host.call('workspace.open', { workspaceId: workspaceTarget.workspaceId })
    return { ...opened, ...(workspaceTarget.multipleConversations === undefined ? {} : { multipleConversations: workspaceTarget.multipleConversations }) }
  })
  orca.panels.handle('project.settings', async input => {
    const id = text(input.projectId, '项目编号', 200)
    await ensure(id)
    const roles = object(input.roles)
    if (['design', 'code', 'review'].some(k => !['codex', 'claude'].includes(roles[k]))) fail('请选择 Codex 或 Claude')
    await store.mutate(id, revision(input.revision), p => { p.roles = roles as Project['roles']; rememberProjectCaller(p, input) })
    changed(id)
    return snapshot(id)
  })
  async function recordFeedback(input: Record<string, any>, expected: number | undefined, remote?: { source: string; connectionId: string; authorize: (p: Project) => void }) {
    const request = input.requestId ? text(input.requestId, '请求编号', 200) : undefined
    const project = await store.mutate(input.projectId, expected, async p => {
      const before = remote ? undefined : structuredClone(p)
      if (p.hidden) fail('项目已隐藏，请先恢复显示')
      feedback(p, input, remote?.source)
      if (before) {
        rememberProjectCaller(p, input)
        await notify(before, p)
      } else {
        const workspaceRun = (await store.workspace()).runId
        if (workspaceRun && workspaceRun !== p.runId) {
          const summary = p.deliveries.at(-1)!
          p.deliveries.push({ ...summary, id: `${summary.id}:workspace`, targetRunId: workspaceRun })
        }
      }
    }, request ? { id: remote ? `link-feedback:${fingerprint([remote.connectionId, request])}` : request, input, authorize: remote?.authorize } : undefined, !input.caller)
    changed(input.projectId); defer(input.projectId)
    return project
  }
  orca.panels.handle('project.feedback', async input => {
    const expected = input.revision === undefined ? undefined : revision(input.revision)
    const { refs } = await projectEntry(input.projectId)
    const { takeover, ...project } = await recordFeedback(input, expected)
    return { projects: refs, project }
  })
  orca.panels.handle('project.agent', async input => {
    const id = text(input.projectId, '项目编号', 200)
    if (input.operation === 'read') {
      const result = await snapshot(id)
      if (input.taskId === undefined || !result.project) return result
      const taskId = text(input.taskId, '任务编号', 200)
      const task = await store.archive.task(result.project, taskId)
      return { ...result, task, ...(task && !result.project.tasks.some(t => t.id === taskId) ? { archiveStatus: '已归档' as const } : {}) }
    }
    await ensure(id)
    if (!['bind', 'submit'].includes(input.operation)) fail('不支持的协作操作')
    const request = { id: text(input.requestId, '请求编号', 200), input }
    let takeoverSession: AgentSession | undefined
    if (input.operation === 'bind') {
      const runId = text(input.runId, 'Run 编号', 200)
      const caller = input.token === undefined ? undefined : text(input.caller, '调用会话', 500)
      await runtime.verifyRun(runId, caller)
      if (caller) takeoverSession = await runtime.identify(caller, runId, input.currentRunId)
    }
    const written = await store.mutate(id, revision(input.revision), async p => {
      if (input.operation === 'bind') {
        if ((await store.workspace()).runId === input.runId) fail('请在目标会话创建独立的项目 Run')
        if ((await store.all()).some(x => x.ref.id !== id && x.runId === input.runId)) fail('该主会话 Run 已绑定其他项目')
        if (takeoverSession) {
          const t = verifyTakeover(p.takeover, input.token, takeoverSession, p.runId, input.runId!)
          const ref = await requireProject(id)
          const workspace = await projectWorkspace(ref, takeoverSession)
          if (!('workspaceId' in workspace) || workspace.workspaceId !== workspaceId(takeoverSession.workspace)) fail('目标会话已经离开项目工作区')
          if (p.runId) p.deliveries.push({ id: `retired:${t.id}`, targetRunId: p.runId, subject: '项目主会话已切换',
            body: `项目「${p.ref.name}」的主会话已换成「${takeoverSession.title || takeoverSession.handle}」。你不再是主会话。请停止派活，把进行中的情况交给新主会话。`, state: 'pending' })
          p.mainSession = takeoverSession
          delete p.takeover
        } else if (p.runId !== input.runId) {
          if (takeoverActive(p.takeover)) fail('项目正在等待接管，请使用本次接管凭据')
          delete p.mainAgentHandle
          delete p.mainSession
          delete p.takeover
        }
        p.runId = input.runId!
      } else {
        const task = object(input.task)
        await store.archive.restore(p, text(task.id, '任务编号', 200), strings(task.sourceIds ?? [], '来源编号'))
        const before = structuredClone(p)
        submitTask(p, input.task)
        await notify(before, p)
      }
      rememberProjectCaller(p, input)
    }, request)
    changed(id)
    defer(id)
    const result = await snapshot(id, written)
    if (input.operation === 'submit') {
      const taskId = text(object(input.task).id, '任务编号', 200)
      if (!written.tasks.some(t => t.id === taskId)) return { ...result, task: await store.archive.task(written, taskId), archiveStatus: '已归档' as const }
    }
    return result
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
    const ref = await requireProject(input.projectId), p = await store.register(ref)
    const tasks = input.archiveEnd === undefined ? p.tasks : (await store.archive.page(p, input.archiveEnd)).batch.tasks
    const a = tasks?.find(x => x.id === input.taskId)?.artifacts.find(x => x.id === input.artifactId)
    if (!a || /^https?:/i.test(a.url)) fail('请选择本项目的本机成果')
    if (!ref.workspace) fail('这个项目当前没有工作区')
    const url = artifactUrl(a.url, ref.path)
    const [root, file] = await Promise.all([realpath(ref.path), realpath(url)]).catch(() => fail('成果文件不存在或无法访问'))
    artifactUrl(file, root)
    if (!(await stat(file).catch(() => undefined))?.isFile()) fail('成果文件不存在或无法访问')
    const target = workspaceId(ref.workspace)
    // The host opens a tab in the target workspace without showing that workspace.
    await orca.host.call('editor.open', { workspaceId: target, path: path.relative(ref.path, url).split(path.sep).join('/') })
    return orca.host.call('workspace.open', { workspaceId: target })
  })

  let refreshMain: ReturnType<typeof setInterval> | undefined
  return { store, links, connections, ingest, flush, flushMailbox, updateStatus, refreshQuestions, stop: () => { clearInterval(refreshMain); activityEvent.dispose(); connections.stop(); links.stop(); sources.stop() }, async start() {
    if (refreshRoles) { await readCatalog(); await refreshRoles() }
    await links.start()
    await connections.start()
    await main.recover()
    clearInterval(refreshMain)
    refreshMain = setInterval(() => { void refreshActivity().catch(() => {}); void refreshQuestions().catch(() => {}) }, activityInterval)
    refreshMain.unref()
    await refreshAgents(true)
    const { refs, error } = await availableProjects(), current = error ? [] : (await store.all()).filter(p => refs.some(ref => ref.id === p.ref.id))
    for (const p of current) {
      if (p.takeover?.state === 'sending' || p.deliveries.some(x => x.state === 'sending')) await store.mutate(p.ref.id, undefined, p => {
        recoverTakeover(p.takeover)
        for (const d of p.deliveries.filter(x => x.state === 'sending')) { d.state = 'uncertain'; d.error = '插件重启前通知结果待核对' }
      })
    }
    if ((await store.messaging()).deliveries.some(d => d.state === 'sending')) await store.mutateMessaging(m => { for (const d of m.deliveries) if (d.state === 'sending') { d.state = 'uncertain'; d.error = '重启前发送结果待核对' } })
    await syncSources()
    for (const entry of (await store.messaging()).inbox.filter(x => x.state === 'pending')) await processMessage(entry.event.id)
    for (const p of current) defer(p.ref.id)
    await flushMailbox()
  } }
}

let coordinator: ReturnType<typeof createCoordinator> | undefined
let cli: ReturnType<typeof cliBridge> | undefined
export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  // A broken stable link must not stop the plugin; the versioned paths keep working.
  if (release) try { installationRoot() } catch (error) { console.error(`AgentBoat 固定入口未更新：${error instanceof Error ? error.message : error}`) }
  const runtime = new OrcaRuntime(async () => {
    const configured = await orca.settings.get('cliPath')
    return typeof configured === 'string' && configured.trim() ? configured.trim() : defaultExecutable
  })
  cli = release ? cliBridge(orca) : undefined
  coordinator = createCoordinator(cli?.api ?? orca, runtime, undefined, undefined, undefined, roleRegistryPath())
  await coordinator.start()
  await cli?.start()
}
export function deactivate(): void { cli?.stop(); coordinator?.stop() }
