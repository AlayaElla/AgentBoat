import { needsLeadCompaction } from './project-archive'
import { BackupLeads, backupView, projectBackupBusy, projectBackupCanRecover } from './backup-lead'
import { isDeepStrictEqual } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { Connections } from './connections'
import { checkedPanels } from './panel-result'
import type { OrcaWorkerApi } from 'orca/worker'
import { takeoverActive, waitingForProjectLead, actingMain, workspaceBackupInFlight, type AgentSession, type Project, type ProjectLead, type ProjectRef, type Snapshot, type SourceEvent, type Delivery, type MessagingSnapshot } from './model'
import type { ProjectLeadRequest } from './protocol'
import { FeishuSources, notifyFeishu, type MessageTransport } from './feishu'
import { OrcaRuntime, defaultExecutable, readTimeout, targetOnline, type CoordinatorRuntime, type TargetInventory } from './runtime'
import { ProjectStore, artifactUrl, expireArtifact, fail, feedback, fingerprint, fresh, maxMessageLength, notifyWorkspace, object, overview, resetBackup, retainRecent, receiveEvent, submitTask, strings, text, revision, mergeProjects, feishuConfig, verifyTakeover } from './store'
import { WorkspaceLinks } from './links'
import { fileErrorText, incomingHash, linkMessageHistory } from './link-messages'
import { LinkFiles } from './link-files'
import { groupedAttention, isProjectShared, type OwnerQuestion } from './model'
import { mainAgent, roleReminder, switchLead, takeoverView, recoverTakeover, type WorkspaceSetup } from './main-agent'
import { applySetup, previewSetup, validateCodexHome } from '../../workspace/install.mjs'
import { projectAgentLaunch, projectLeadAgents, projectTemplate, templateLeadPreferences, type ProjectLeadAgents } from '../../workspace/agent-launch.mjs'
import { promptClientPath, refreshReleaseSetup, pluginVersionLabel, release, roleRegistryPath } from '../scripts/orca-cli.mjs'
import { cliBridge } from '../scripts/cli-bridge.mjs'
import { applyDelta, type Sheets } from './feedback-drafts'
import { roleRegistry } from './role-registry'
import { escalationWait } from '../scripts/worker-reports.mjs'
import type { ProjectArtifactRef } from './protocol'

const activityInterval = 60_000
const activityDebounce = 150

export function createCoordinator(api: OrcaWorkerApi, runtime: CoordinatorRuntime, transport?: MessageTransport, exportDirectory?: string, linkFiles?: LinkFiles, roleFile?: string, setup?: WorkspaceSetup) {
  const orca = { ...api, panels: checkedPanels(api) }
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
  const backups = new BackupLeads(store, runtime, requireProject, id => {
    changed(id)
    if (id) defer(id)
    else void main.flushRetired().catch(() => {})
  })
  orca.panels.handle('lead.retry', async input => {
    await backups.retry(input.projectId ?? '', input.revision, input.confirm)
    deferBackupCheck()
    return { accepted: true }
  })
  orca.panels.handle('lead.control', async input => {
    const result = await backups.command(input)
    if (result.done && (input.action === 'take' || input.action === 'resume')) deferBackupCheck()
    return result
  })
  const main = mainAgent(orca, store, runtime, changed, () => { deferMailbox(); deferBackupCheck() }, async () => (await availableProjectRecords()).list, backups, () => live, setup)
  let statusUpdates: Promise<void> | undefined, statusDirty = false
  let live: import('./agents').AgentsSnapshot = { ok: false, at: 0, agents: [] }
  let agentsDirty = true, refreshingAgents: Promise<typeof live> | undefined
  let activitySequence = 0, sampledSequence = 0
  let nextActivityAt = 0
  function refreshAgents(force = false, bindings?: ReturnType<typeof sampleBindings>): Promise<typeof live> {
    if (force) agentsDirty = true
    if (refreshingAgents) return refreshingAgents
    if (!force && (Date.now() < nextActivityAt || !agentsDirty && sampledSequence === activitySequence && Date.now() - live.at < activityInterval)) return Promise.resolve(live)
    refreshingAgents = (async () => {
      for (let sample = 0; sample < 2; sample++) {
        const started = Date.now()
        const observed = sample === 0 && bindings ? await bindings : undefined
        const { list } = observed?.records ?? await availableProjectRecords()
        const sequence = observed?.inventory ? observed.sequence : activitySequence
        agentsDirty = false
        try { live = await runtime.agents(list, orca.host, actingMain(observed?.workspace ?? await store.workspace()), observed?.inventory) }
        catch { live = { ok: false, at: Date.now(), agents: [], error: 'agent 状态读不到' } }
        sampledSequence = sequence
        const elapsed = Date.now() - started
        nextActivityAt = elapsed >= readTimeout ? Date.now() + activityInterval : 0
        if (sampledSequence === activitySequence && (!agentsDirty || nextActivityAt)) break
      }
      return live
    })().finally(() => { refreshingAgents = undefined })
    return refreshingAgents
  }
  orca.panels.handle('workspace.agents', async input => {
    const snapshot = await refreshAgents(input?.refresh === true), { list } = await availableProjectRecords()
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
      const { focused } = await orca.host.call('terminal.focus', { terminalId: agent.terminalId }, { signal: AbortSignal.timeout(readTimeout) })
      if (!focused) fail('Orca 未切换到这个会话，请刷新后重试')
      return { opened: true, focusedTerminal: true }
    }
    if (!agent.workspaceId) fail('找不到这个会话的工作区，请刷新后重试')
    const { opened } = await orca.host.call('workspace.open', { workspaceId: agent.workspaceId }, { signal: AbortSignal.timeout(readTimeout) })
    return { opened, focusedTerminal: false }
  })
  let publishedActivity: unknown
  async function publishActivity(panelChanged = false) {
    if (stoppedChecks) return
    const { at, agents, ...status } = live
    const visible = agents.map(({ id, projectId, agent, role, state, title, taskId, taskTitle, since }) =>
      ({ id, projectId, agent, role, state, title, taskId, taskTitle, since })).sort((a, b) => a.id.localeCompare(b.id))
    const next = { ...status, agents: visible }
    if (!isDeepStrictEqual(next, publishedActivity)) {
      publishedActivity = next
      links.localChanged()
      panelChanged = true
    }
    if (panelChanged) {
      orca.panels.post('project.changed', { projectId: '' })
      await updateStatus()
    }
  }
  const activityEvents = new AbortController()
  let publishingActivity: Promise<void> | undefined
  function scheduleActivity() {
    if (stoppedChecks) return
    return publishingActivity ??= delay(Math.max(activityDebounce, nextActivityAt - Date.now()), undefined, { signal: activityEvents.signal }).then(async () => {
      if (Date.now() >= nextActivityAt) {
        await refreshAgents()
        await publishActivity().catch(() => {})
      }
    }).finally(() => {
      publishingActivity = undefined
    }).then(() => {
      if (sampledSequence !== activitySequence) void scheduleActivity()
    }).catch(() => {})
  }
  const activityEvent = orca.events.on('agent.status.changed', () => {
    activitySequence++
    return scheduleActivity()
  })
  let questions: OwnerQuestion[] = [], pollingQuestions: Promise<Awaited<ReturnType<typeof availableProjectRecords>> | undefined> | undefined
  let actionableRunMail = new Set<string>()
  const mailKey = (item: OwnerQuestion) => fingerprint([item.runId, item.id])
  const unsubmitted = async (items: OwnerQuestion[], list: Project[]) => {
    if (!items.length) return []
    const pending = new Set<OwnerQuestion>()
    for (const p of list) {
      if (p.hidden) continue
      const rows = items.filter(q => q.projectId === p.ref.id && q.runId === p.runId)
      const submitted = await store.archive.submittedReports(p, rows.flatMap(q => q.report ? [q.report] : []))
      for (const q of rows) if (!q.report || !submitted.has(q.report.id)) pending.add(q)
    }
    return items.filter(q => pending.has(q))
  }
  type Waiting = NonNullable<Awaited<ReturnType<CoordinatorRuntime['mail']>>['waiting']>
  let waitingByRun = new Map<string, Waiting | null>()
  function refreshQuestions() {
    pollingQuestions ??= (async () => {
      const { list, error } = await availableProjectRecords()
      if (error) return
      const bound = list.filter(p => !p.hidden && p.runId)
      const now = Date.now()
      const waiting = new Map<string, Waiting | null>()
      const updated = new Map<string, { runId: string; questions: OwnerQuestion[] }>()
      for (let i = 0; i < bound.length; i += 2) await Promise.all(bound.slice(i, i + 2).map(async p => {
        const inbox = await runtime.mail(p.runId, reports => store.archive.submittedReports(p, reports)).catch(() => undefined)
        if (!inbox) { waiting.set(p.runId, null); return }
        waiting.set(p.runId, inbox.waiting ?? [])
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
      waitingByRun = waiting
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
        const action = escalate ? '请联系项目主会话核对。已有同一验收或决定时沿用原项，请项目主会话回复执行者。由你判断是否需要告诉主人。'
          : mail.report ? '请核对成果并用 submit 登记。' : '请核对待处理事项并回复原问题。已有同一验收或决定时，回复原任务和事项编号。确需主人另做操作时，再登记对应事项。'
        return [{ id: escalate ? escalatedId : firstId, noticeKeys: [key], state: 'pending', ...(!escalate ? { targetRunId: mail.runId } : {}),
          runNotice: { stage: escalate ? 'workspace' : 'project', projectId: mail.projectId, runId: mail.runId },
          subject: `${project.ref.name} · ${label}`.slice(0, 200),
          body: `项目：${project.ref.name}（${mail.projectId}）\n邮件：${mail.id} · 执行者 ${mail.from}\n原文摘录（资料）：\n${mail.body.slice(0, 1000)}\n${action}` }]
      })
      const obsolete = (delivery: Delivery) => {
        if (delivery.state !== 'pending' || !delivery.runNotice) return false
        const { projectId, runId } = delivery.runNotice
        return currentRuns.get(projectId)?.runId !== runId ||
          updated.get(projectId)?.runId === runId && !actionableRunMail.has(delivery.noticeKeys?.[0] ?? '')
      }
      if (notices.length || saved.some(obsolete)) await store.mutateMessaging(m => { m.deliveries = [...m.deliveries.filter(d => !obsolete(d)), ...notices] })
      if (notices.length || saved.some(d => d.state === 'pending' && d.runNotice && actionableRunMail.has(d.noticeKeys?.[0] ?? ''))) deferMailbox()
      return current
    })().finally(() => { pollingQuestions = undefined })
    return pollingQuestions
  }
  function updateStatus() {
    statusDirty = true
    return statusUpdates ??= (async () => {
      do {
        statusDirty = false
        const { list } = await availableProjectRecords(), all = overview(list, await store.workspace())
        const visible = new Set(all.projects.map(p => p.ref.id))
        const count = groupedAttention(all.attention).length + (live.ok ? live.agents.filter(a => a.state === 'need' && visible.has(a.projectId)).length : 0)
        await orca.host.call('statusBar.update', { id: 'coordinator', text: `工作间 · 待处理 ${count}${live.truncated ? '+' : ''}`, tooltip: `${!live.ok ? 'agent 状态读不到 · ' : live.truncated ? 'agent 状态未全部读取 · ' : ''}打开工作间总览 · Mod+Alt+Shift+J` }, { signal: AbortSignal.timeout(readTimeout) })
      } while (statusDirty && !stoppedChecks)
    })().finally(() => { statusUpdates = undefined })
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
      m.deliveries = retainRecent(m.deliveries, sent, linkMessageHistory)
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
    const sample = await refreshAgents()
    return { workspace: await main.read(sample), live: sample }
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
  orca.panels.handle('workspace.linkArtifact', input => links.openArtifact(text(input.id, '连接编号', 64), input))
  orca.panels.handle('workspace.readLinkArtifact', input => links.readArtifact(text(input.id, '连接编号', 64), input.key, input.offset))
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
  function projectView({ takeover, backup, ...project }: Project): Project {
    return backup ? { ...project, backup: backupView(backup) } : project
  }
  async function snapshot(id: string, written?: Project): Promise<Snapshot> {
    const { refs, error: runtimeError } = await availableProjects(), ref = refs.find(p => p.id === id)
    if (!ref) fail(runtimeError ?? '项目已从 Orca 移除或不在工作间项目列表')
    const project = written ?? (!runtimeError ? await store.register(ref)
      : (await store.all()).find(p => p.ref.id === id) ?? fresh(ref))
    const inventory = !runtimeError && lastInventory && Date.now() - lastInventory.at < activityInterval * 2 ? lastInventory.inventory : undefined
    const lead = await projectLeadView(project, inventory), agent = lead.session?.agent || projectAgentKind(project)
    return { projects: refs, project: projectView(project), lead,
      ...(agent ? { mainAgent: agent } : {}), workspaceTarget: runtimeError ? { error: runtimeError } : await projectWorkspace(ref, lead.session),
      ...(runtimeError ? { runtimeError } : {}) }
  }
  const workspaceId = (selector: string) => selector.replace(/^id:/, '')
  // Legacy Orca sessions encode the agent before an underscore-separated UUID.
  const projectAgentKind = (p: Project) => p.mainSession && p.mainSession.handle === p.mainAgentHandle ? p.mainSession.agent
    : /^orca_session_id:([a-z0-9][a-z0-9_-]{0,99})_[a-f0-9]{8}(?:_[a-f0-9]{4}){3}_[a-f0-9]{12}$/i.exec(p.mainAgentHandle ?? '')?.[1]
  function projectBinding(p: Project, inventory?: TargetInventory): import('./model').WorkspaceBinding {
    const handle = p.mainAgentHandle, takeover = takeoverView(p.takeover)
    const saved = p.mainSession?.handle === handle ? p.mainSession : undefined
    const live = inventory?.sessions.find(s => s.handle === handle)
    return { revision: p.revision, runId: p.runId, ...(p.backup ? { backup: backupView(p.backup) } : {}), ...(p.runId && handle ? { session: live ?? {
      handle, title: saved?.title ?? '', workspace: saved?.workspace ?? p.ref.workspace, workspaceName: saved?.workspaceName ?? p.ref.name,
      path: saved?.path ?? p.ref.path, agent: projectAgentKind(p) ?? '', online: targetOnline(inventory, handle, saved?.workspace ?? p.backup?.contact?.workspace)
    } } : {}), ...(takeover ? { takeover } : {}) }
  }
  async function projectLeadView(p: Project, inventory?: TargetInventory) {
    const binding = projectBinding(p, inventory), waiting = waitingForProjectLead(binding)
    if (waiting) {
      let backup
      try { backup = projectLeadAgents(p.leadAgents, waiting.target.agent).backup } catch { return binding }
      if (backup && backup.agent !== waiting.target.agent && await runtime.installedAgents(waiting.target.workspace)
        .then(list => list.some(a => a.id === backup.agent)).catch(() => false)) waiting.backupAgent = backup.agent
    }
    return binding
  }
  async function projectWorkspace(ref: ProjectRef, session?: AgentSession): Promise<import('./model').ProjectWorkspace> {
    try {
      const list = await orca.host.call('workspace.list', {}, { signal: AbortSignal.timeout(readTimeout) })
      const candidates = list.workspaces.filter(w => w.projectId === ref.repoId && (w.hostId ?? 'local') === ref.hostId)
      const workspace = (session && candidates.find(w => w.id === workspaceId(session.workspace)))
        || candidates.find(w => w.id === workspaceId(ref.workspace))
      if (!workspace) fail(list.truncated ? '工作区列表未完整返回，请刷新后重试' : ref.workspace ? '项目工作区已被移除或不可用' : '这个项目当前没有工作区')
      return { workspaceId: workspace.id }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }
  async function projectLeadTargets(ref: ProjectRef, p: Project) {
    const inventory = await runtime.targets()
    const session = projectBinding(p, inventory).session
    const target = await projectWorkspace(ref, session)
    const workspaces = 'workspaceId' in target ? inventory.workspaces.filter(w => workspaceId(w.workspace) === target.workspaceId) : []
    const workspace = workspaces[0]
    const sessions = workspace ? inventory.sessions.filter(s => workspaceId(s.workspace) === workspaceId(workspace.workspace) &&
      s.online === 'online' && !!s.agent) : []
    const error = 'error' in target ? target.error : workspace ? undefined : '项目工作区暂不可用，请刷新后重试'
    return { workspace, workspaces, sessions, inventory, error }
  }
  async function readProjectLead(id: string): Promise<ProjectLead> {
    const ref = await requireProject(id), p = await store.register(ref)
    const targets = await projectLeadTargets(ref, p).catch(() => ({ workspace: undefined, sessions: [], inventory: undefined, error: '会话列表暂不可用，请刷新后重试' }))
    const catalog = (workspace?: string) => workspace ? runtime.installedAgents(workspace, true).catch(() => null) : Promise.resolve([])
    const launchList = catalog(targets.workspace?.workspace)
    const [availableAgents, roleAgents, binding] = await Promise.all([launchList,
      targets.workspace?.workspace === ref.workspace ? launchList : catalog(ref.workspace), projectLeadView(p, targets.inventory)])
    const primaryUnavailable = !p.hidden && !!p.runId && !!targets.inventory && backups.projectPrimaryUnavailable(p, targets.inventory)
    const effectiveAgent = primaryUnavailable ? targets.inventory?.sessions.find(s => s.handle === p.backup?.handle)?.agent || p.backup?.agent : binding.session?.agent
    return { binding, leadAgents: projectLeadAgents(p.leadAgents, effectiveAgent), availableAgents, roleAgents, sessions: targets.sessions,
      ...(primaryUnavailable ? { backupPrimaryUnavailable: true } : {}),
      ...(targets.error ? { workspaceError: targets.error } : {}) }
  }
  async function checkProjectLeadTarget(id: string, handle: string) {
    const workspace = await store.workspace()
    const pending = (t?: Project['takeover']) => takeoverActive(t) && t?.target.handle === handle
    if (workspace.session?.handle === handle || workspace.backup?.handle === handle || pending(workspace.takeover) ||
      (await store.all()).some(p => p.ref.id !== id && (p.mainAgentHandle === handle || p.backup?.handle === handle || pending(p.takeover)))) {
      fail('该会话已用于其他主会话或备用')
    }
  }
  async function confirmProjectRecovery(project: Project, initial?: TargetInventory, target?: AgentSession) {
    const backup = project.backup
    if (!project.runId || !projectBackupCanRecover(backup) || !backups.projectPrimaryUnavailable(project, initial ?? await runtime.targets())) return
    // Re-read Orca in the write transaction. A single missing row is insufficient to retire a binding.
    const inventory = await runtime.targets()
    if (!backups.projectPrimaryUnavailable(project, inventory)) return
    const workspace = target?.workspace || project.mainSession?.workspace || backup.contact?.workspace || project.ref.workspace
    const session = inventory.sessions.find(s => s.handle === backup.handle && s.handle !== backup.primary && s.online === 'online' &&
      s.agent === (target?.agent ?? backup.agent) && workspaceId(s.workspace) === workspaceId(workspace))
    if (!session) fail('当前代管备用不在项目工作区内在线，请刷新后重试')
    await backups.verifyProjectPromotion(project.runId, backup, session)
    return session
  }
  async function switchProjectLead(id: string, input: ProjectLeadRequest, ownerRun?: string) {
    const ref = await requireProject(id), p = await store.register(ref)
    if (input.startOnly && input.mode !== 'new') fail('自动启动需要新会话')
    if (input.startOnly && input.workspace !== ref.workspace) fail('项目工作区已变化，请核对后再操作')
    const scoped = input.mode === 'cancel' ? undefined : await projectLeadTargets(ref, p)
    if (scoped?.error) fail(scoped.error)
    const authorize = async () => {
      if (ownerRun !== undefined && (!ownerRun || (await store.workspace()).runId !== ownerRun)) fail('请使用已绑定的工作间主 agent Run')
    }
    const primaryUnavailable = (project: Project) => !!scoped && backups.projectPrimaryUnavailable(project, scoped.inventory)
    const mode = input.mode === 'existing' && input.handle && input.handle === p.backup?.handle && primaryUnavailable(p) ? 'promote' : input.mode
    if (mode === 'promote') {
      await store.mutate(id, revision(input.revision), async project => {
        await authorize()
        if (project.hidden) fail('项目已隐藏，请先恢复显示')
        const backup = project.backup
        if (!project.runId || !projectBackupCanRecover(backup)) fail('只有正在代管项目 Run 的备用可以转正')
        if (!primaryUnavailable(project)) fail('原主会话仍可能接回 Run，请等主用接回')
        if (project.takeover?.state === 'sending') fail('正在启动项目主会话，请等启动回执')
        const target = scoped?.sessions.find(s => s.handle === backup.handle && s.handle !== backup.primary)
        if (!target) fail('当前代管备用不在项目工作区内在线，请刷新后重试')
        await checkProjectLeadTarget(id, target.handle)
        const session = await confirmProjectRecovery(project, scoped?.inventory, target)
        if (!session) fail('原主会话仍可能接回 Run，请等主用接回')
        project.mainAgentHandle = session.handle
        project.mainSession = session
        if (project.leadAgents?.backup?.agent === session.agent) delete project.leadAgents.backup
        delete project.takeover
        const name = session.title ? `${session.title}（${session.handle}）` : session.handle
        backup.history.push({ at: Date.now(), text: `原主会话已不可用，已将代管备用 ${name} 转正为主会话` })
        resetBackup(project, session.handle)
      })
      changed(id)
      defer(id); deferBackupCheck()
      return readProjectLead(id)
    }
    const template = input.startOnly === true && input.template !== undefined && !p.leadAgents
      ? templateLeadPreferences(projectTemplate(input.template)) : undefined
    const launch = input.mode === 'new' ? projectLeadAgents(p.leadAgents ?? template).primary : undefined
    const goal = input.goal === undefined ? '' : text(input.goal, '项目目标', maxMessageLength)
    const introduction = input.introduction === undefined ? '' : text(input.introduction, '项目模板开场语', maxMessageLength)
    await switchLead(runtime, { ...input, mode, revision: input.startOnly ? p.revision : input.revision, workspace: scoped?.workspace?.workspace,
      agent: input.startOnly ? undefined : input.agent }, {
      role: 'project',
      launch, startOnly: input.startOnly,
      targets: async () => ({ sessions: scoped?.sessions ?? [], workspaces: scoped?.workspaces ?? [] }),
      mutate: (update, expected) => store.mutate(id, expected, async project => {
        await authorize()
        if (expected !== undefined && input.mode !== 'cancel') {
          if (project.hidden) fail('项目已隐藏，请先恢复显示')
          if (input.startOnly && project.runId) fail('项目已绑定主会话')
          const existing = input.mode === 'existing' && input.handle
          if (existing && existing !== project.backup?.handle) await checkProjectLeadTarget(id, existing)
          if (projectBackupBusy(project.backup) && !await confirmProjectRecovery(project, scoped?.inventory)) fail('备用正在启动或处理，请等主用接回后再切换')
          if (existing && existing === project.backup?.handle) fail('该会话已是当前项目的备用')
        }
        await update(project)
        if (expected !== undefined && template) project.leadAgents = template
      }),
      changed: () => changed(id),
      subject: '【项目协作】请接管项目主会话',
      prompt: (token, expiresAt) => `主人请当前会话接管项目「${ref.name}」（projectId: ${id}）。开启项目协作，先读 $orca-project-coordinator 和桥接说明，自己创建新的协调 Run。接管脚本绝对路径：${JSON.stringify(promptClientPath())}\n用 node 调用此脚本的 read ${id} 取得最新 revision，再调用 project-lead-bind，从标准输入传入 {projectId,revision,requestId,runId,token}。启动回执未确认时稍后重读再试。一次性接管凭据：${token}\n有效至：${expiresAt}\n凭据仅用于本次接管，不保存或转发。绑定成功后读该项目记录，接手任务、执行记录和待处理项；保留已有分工和用户决定。${introduction ? '\n' + introduction : ''}${goal ? '\n主人本次目标：' + goal : ''}`
    })
    defer(id)
    return readProjectLead(id)
  }
  function rememberProjectCaller(project: Project, input: { runId?: string; caller?: string }) {
    // Self-reported identity is display/navigation metadata, never authorization evidence.
    if (project.runId && input.runId === project.runId && input.caller && !project.mainAgentHandle && !project.backup?.primary) project.mainAgentHandle = text(input.caller, '调用会话', 500)
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
    const run = d.targetRunId || fallbackRunId
    return role === 'workspace' ? main.deliver(run, { ...d, body }) : runtime.send(run, { ...d, body })
  }
  function deferMailbox() { setImmediate(() => { void flushMailbox().catch(() => {}) }) }
  const needsWorkspaceRun = (d: Delivery) => d.linkMessageHash || d.runNotice || d.id.startsWith('setup-hooks:')
  async function flushMailbox(): Promise<void> {
    const running = busy.get(mailbox)
    if (running) { await running; return flushMailbox() }
    const work = (async () => {
      try {
        while (true) {
          const { runId } = await store.workspace(), m = await store.messaging()
          const d = m.deliveries.find(x => x.state === 'pending' &&
            (!x.runNotice || actionableRunMail.has(x.noticeKeys?.[0] ?? '')) &&
            (x.targetRunId || !needsWorkspaceRun(x) || runId) &&
            (!x.external || m.feishu.enabled && x.external.appId === m.feishu.appId && m.feishu.chatIds.includes(x.external.chatId)))
          if (!d) break
          const fallbackRun = needsWorkspaceRun(d) ? runId : undefined
          let claimed = false
          await store.mutateMessaging(m => {
            const saved = m.deliveries.find(x => x.id === d.id)
            if (!saved || saved.state !== 'pending') return
            saved.state = 'sending'
            if (!saved.external && fallbackRun) saved.targetRunId ??= fallbackRun
            if (saved.runNotice) saved.runNotice.attemptedAt = Date.now()
            claimed = true
          })
          if (!claimed) continue
          try {
            const receipt = await sendDelivery(d, d.runNotice?.stage === 'project' ? 'project' : 'workspace', fallbackRun)
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
          const allowed = (d: Delivery, p: Project) => backups.canSend(p, d) &&
            (!p.hidden || !d.control && !d.external && (!d.targetRunId || d.id.startsWith('retired:'))) &&
            (d.external ? f.enabled && d.external.appId === f.appId && f.chatIds.includes(d.external.chatId) : d.targetRunId || p.runId)
          const delivery = p.deliveries.find(x => x.state === 'pending' && allowed(x, p))
          if (!delivery) break
          const { refs, error } = await availableProjects()
          if (error || !refs.some(ref => ref.id === id)) break
          let claimed: Delivery | undefined, role: 'workspace' | 'project' = 'project'
          await store.mutate(id, undefined, p => {
            const saved = p.deliveries.find(d => d.id === delivery.id)
            if (!saved || saved.state !== 'pending' || !allowed(saved, p)) return
            if (saved.targetRunId) role = 'workspace'
            if (!saved.external) saved.targetRunId ??= p.runId
            saved.state = 'sending'; claimed = saved
          })
          if (!claimed) continue
          attempted = true
          try {
            const receipt = claimed.control ? await backups.send(id, claimed) : await sendDelivery(claimed, role)
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
  orca.panels.handle('workspace.hermesApprovalMode', () => runtime.hermesApprovalMode())
  orca.panels.handle('workspace.connections', async input => {
    const result = await connections.handle(input)
    if (input.includeApprovalMode !== false && !Array.isArray(result) && result.connection.type === 'a2a') {
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
  const versionLabel = pluginVersionLabel()
  orca.panels.handle('workspace.overview', async () => {
    const { list, error } = await availableProjectRecords()
    // Orca registration defines membership. A project can be registered without a workspace.
    const inbox = await unsubmitted(questions, list)
    return { ...overview(list, await store.workspace(), error), versionLabel, questions: inbox.filter(item => !item.report), reports: inbox.filter(item => item.report), workspace: await main.read(live, list), links: await links.snapshot(), connections: await connections.list(), machines: [{ id: 'local', name: os.hostname(), role: 'host' as const, online: true }] }
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
    await store.mutate(id, revision(input.revision), p => { p.hidden = input.hidden; if (p.hidden && p.backup) delete p.backup.contact; rememberProjectCaller(p, input) })
    changed(id); deferBackupCheck(); if (!input.hidden) defer(id)
    return snapshot(id)
  })
  orca.panels.handle('project.delete', async input => {
    const id = text(input.projectId, '项目编号', 200)
    if (input.confirm !== id) fail('删除前请确认项目编号；会删除任务、成果、决定、验收、来源、通知及项目设置记录，并先导出 JSON')
    await busy.get(id)
    await requireProject(id)
    const exportPath = await store.remove(id, revision(input.revision), async () => {
      const wanted = [await store.workspace(), ...(await store.all()).filter(row => row.ref.id !== id)]
      const until = Date.now() + 25_000
      while (Object.values(await backups.syncContacts(wanted)).some(r => r.projectId === id && r.closing)) {
        if (Date.now() >= until) fail('正在结束主会话联络任务，请稍后重试删除')
        await new Promise(resolve => setTimeout(resolve, 250))
      }
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
  orca.panels.handle('lead.history', async input => {
    const owner = input.projectId === undefined ? await store.workspace() : await ensure(text(input.projectId, '项目编号', 200))
    return store.archive.leadHistory(owner, input.end)
  })
  orca.panels.handle('project.archive', async input => {
    const p = await ensure(input.projectId)
    const batch = await store.archive.page(p, input.end)
    return { end: input.end ?? p.archive!.end, ...(batch.previous && { previousEnd: batch.previous.end }), tasks: batch.tasks ?? [],
      deliveries: batch.deliveries.length, events: batch.events?.length ?? 0, requests: batch.requests.length,
      history: (batch.history?.reduce((count, part) => count + part.rows.length, 0) ?? 0) + (batch.leadHistory?.length ?? 0) }
  })
  orca.panels.handle('project.lead', input => {
    const id = text(input.projectId, '项目编号', 200)
    return 'mode' in input ? switchProjectLead(id, input) : readProjectLead(id)
  })
  orca.panels.handle('workspace.projectLead', input => switchProjectLead(text(input.projectId, '项目编号', 200), input, text(input.runId, 'Run 编号', 200)))
  orca.panels.handle('project.openMain', async input => {
    const id = text(input.projectId, '项目编号', 200), ref = await requireProject(id), p = await store.register(ref)
    const inventory = p.mainAgentHandle ? await runtime.targets().catch(() => undefined) : undefined
    const workspaceTarget = await projectWorkspace(ref, projectBinding(p, inventory).session)
    if ('error' in workspaceTarget) fail(workspaceTarget.error)
    const { workspaceId } = workspaceTarget
    const options = { signal: AbortSignal.timeout(readTimeout) }
    const [opened, conversations] = await Promise.all([orca.host.call('workspace.open', { workspaceId }, options),
      orca.host.call('agents.list', { workspaceId }, options).catch(() => undefined)])
    return { ...opened, ...(conversations && { multipleConversations: conversations.agents.length > 1 }) }
  })
  orca.panels.handle('project.settings', async input => {
    const id = text(input.projectId, '项目编号', 200)
    const project = await ensure(id)
    const roles = input.roles === undefined ? undefined : object(input.roles)
    const raw = input.leadAgents === undefined ? undefined : object(input.leadAgents)
    if (raw && input.template !== undefined) fail('请选择项目代理设置或模板')
    if (input.template !== undefined && project.runId) fail('只在立项时应用项目模板')
    if (!roles && !raw) fail('没有可保存的项目设置')
    if (roles) {
      const installed = await runtime.installedAgents(project.ref.workspace, true)
      if (['design', 'code', 'review'].some(k => !installed.some(a => a.id === roles[k]))) fail('分工中有当前工作区不可用的代理，请刷新后选择')
    }
    const template = input.template === undefined ? undefined : templateLeadPreferences(projectTemplate(input.template))
    const choices: Partial<ProjectLeadAgents> = {}
    let scoped: Awaited<ReturnType<typeof projectLeadTargets>> | undefined
    if (raw) {
      try {
        if ('primary' in raw) choices.primary = projectAgentLaunch(raw.primary)
        if ('backup' in raw) choices.backup = raw.backup === null ? null : projectAgentLaunch(raw.backup)
      } catch (e) { fail((e as Error).message) }
      if (!Object.keys(choices).length) fail('请选择要保存的主用或备用代理')
      scoped = await projectLeadTargets(project.ref, project)
      if (!scoped.workspace) fail(scoped.error || '找不到项目工作区')
      const installed = await runtime.installedAgents(scoped.workspace.workspace, true)
      for (const choice of [choices.primary, choices.backup]) {
        if (choice && !installed.some(a => a.id === choice.agent)) fail(`代理 ${choice.agent} 在当前工作区不可用，请刷新后选择`)
      }
    }
    await store.mutate(id, revision(input.revision), async p => {
      if (roles) p.roles = { design: roles.design, code: roles.code, review: roles.review }
      const inventory = scoped?.inventory
      let actingBackup: AgentSession | undefined
      if (inventory && 'backup' in choices && !isDeepStrictEqual(choices.backup, p.leadAgents?.backup) && projectBackupBusy(p.backup)) {
        actingBackup = await confirmProjectRecovery(p, inventory)
        if (!actingBackup) fail('备用正在启动或处理，请稍后再更改')
      }
      if (template && !p.leadAgents) p.leadAgents = template
      if (inventory) {
        const primaryUnavailable = !!actingBackup || backups.projectPrimaryUnavailable(p, inventory)
        const primary = actingBackup?.agent ?? (primaryUnavailable ? inventory.sessions.find(s => s.handle === p.backup?.handle)?.agent || p.backup?.agent
          : projectBinding(p, inventory).session?.agent)
        const next = projectLeadAgents({ ...p.leadAgents, ...choices })
        if (next.backup?.agent === next.primary.agent) fail('默认主用与备用需要选择不同的代理')
        if (choices.backup && choices.backup.agent === primary) fail('备用代理与当前主用相同')
        const changingBackup = 'backup' in choices && !isDeepStrictEqual(choices.backup, projectLeadAgents(p.leadAgents, primary).backup)
        if (changingBackup && !primaryUnavailable && p.backup?.phase !== 'failed') resetBackup(p, p.mainAgentHandle ?? '')
        p.leadAgents = { ...p.leadAgents, ...choices }
      }
      rememberProjectCaller(p, input)
    })
    changed(id); deferBackupCheck()
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
    return { projects: refs, project: projectView(await recordFeedback(input, expected)) }
  })
  orca.panels.handle('project.agent', async input => {
    const id = text(input.projectId, '项目编号', 200)
    if (input.operation === 'read') {
      const result = await snapshot(id)
      if (input.taskId === undefined || !result.project) return result
      const taskId = text(input.taskId, '任务编号', 200)
      const task = await store.archive.task(result.project, taskId)
      if (!task) return result
      return { ...result, task, ...(!result.project.tasks.some(t => t.id === taskId) ? { archiveStatus: '已归档' as const } : {}) }
    }
    await ensure(id)
    if (!['bind', 'submit'].includes(input.operation)) fail('不支持的协作操作')
    const request = { id: text(input.requestId, '请求编号', 200), input }
    let takeoverSession: AgentSession | undefined
    if (input.operation === 'bind') {
      const runId = text(input.runId, 'Run 编号', 200)
      const caller = input.caller === undefined && input.token === undefined ? undefined : text(input.caller, '调用会话', 500)
      await runtime.verifyRun(runId, caller)
      if (caller && input.token !== undefined) takeoverSession = await runtime.identify(caller, runId, input.currentRunId)
    }
    const written = await store.mutate(id, revision(input.revision), async p => {
      if (input.operation === 'bind') {
        if ((await store.workspace()).runId === input.runId) fail('请在目标会话创建独立的项目 Run')
        if ((await store.all()).some(x => x.ref.id !== id && x.runId === input.runId)) fail('该主会话 Run 已绑定其他项目')
        if (takeoverSession) {
          const t = verifyTakeover(p.takeover, input.token, takeoverSession, p.runId, input.runId!)
          await checkProjectLeadTarget(id, takeoverSession.handle)
          const ref = await requireProject(id)
          const workspace = await projectWorkspace(ref, takeoverSession)
          if (!('workspaceId' in workspace) || workspace.workspaceId !== workspaceId(takeoverSession.workspace)) fail('目标会话已经离开项目工作区')
          if (projectBackupBusy(p.backup) && !await confirmProjectRecovery(p)) fail('原主会话仍可能接回 Run，请先核对项目主会话')
          if (p.runId) p.deliveries.push({ id: `retired:${t.id}`, targetRunId: p.runId, subject: '项目主会话已切换',
            body: `项目「${p.ref.name}」的主会话已换成「${takeoverSession.title || takeoverSession.handle}」。你不再是主会话。请停止派活，把进行中的情况交给新主会话。`, state: 'pending' })
          resetBackup(p, takeoverSession.handle)
          p.mainSession = takeoverSession
          p.mainAgentHandle = takeoverSession.handle
          delete p.takeover
        } else if (p.runId !== input.runId) {
          if (p.runId || takeoverActive(p.takeover) || p.takeover?.state === 'uncertain' || p.takeover?.state === 'sending') fail('请通过项目设置发起主会话切换，并使用本次接管凭据')
          if (input.caller) await checkProjectLeadTarget(id, text(input.caller, '调用会话', 500))
          resetBackup(p, '')
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
    if (input.operation === 'bind') deferBackupCheck()
    if (input.operation === 'submit') {
      const taskId = text(object(input.task).id, '任务编号', 200)
      if (!written.tasks.some(t => t.id === taskId)) {
        const task = await store.archive.storedTask(written, taskId)
        if (task) return { ...result, submitted: { id: task.id, phase: task.phase, ...(task.submittedAt !== undefined && { submittedAt: task.submittedAt }),
          pendingAcceptance: task.acceptance.some(a => a.status === 'pending'), pendingDecision: task.decisions.some(d => d.answer === undefined) } }
      }
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
  orca.panels.handle('project.expireArtifact', async input => {
    const { ref, refs } = await projectEntry(input.projectId)
    if (ref.hostId !== 'local') fail('只能将本机项目的成果标为过期')
    const project = await store.mutate(ref.id, revision(input.revision), p => {
      const task = p.tasks.find(t => t.id === input.taskId)
      if (!task) fail('任务不属于当前项目')
      expireArtifact(task, text(input.artifactId, '成果编号', 200))
    })
    changed(ref.id)
    return { projects: refs, project: projectView(project) }
  })
  async function localArtifact(input: ProjectArtifactRef, needsWorkspace: boolean) {
    const ref = await requireProject(input.projectId)
    if (ref.hostId !== 'local') fail('请选择本项目的本机成果')
    const p = await store.register(ref)
    const tasks = input.archiveEnd === undefined ? p.tasks : (await store.archive.page(p, input.archiveEnd)).tasks
    const a = tasks?.find(x => x.id === input.taskId)?.artifacts.find(x => x.id === input.artifactId)
    if (!a || /^https?:/i.test(a.url)) fail('请选择本项目的本机成果')
    if (needsWorkspace && !ref.workspace) fail('这个项目当前没有工作区')
    const url = artifactUrl(a.url, ref.path)
    const [root, file] = await Promise.all([realpath(ref.path), realpath(url)]).catch(() => fail('成果文件不存在或无法访问'))
    const relative = path.relative(root, file)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('成果路径不属于当前项目')
    const info = await stat(file).catch(() => fail('成果文件不存在或无法访问'))
    return { ref, url, file, info }
  }
  orca.panels.handle('project.openArtifact', async input => {
    const { ref, url, file, info } = await localArtifact(input, true)
    if (!info.isFile()) fail('成果文件不存在或无法访问')
    const target = workspaceId(ref.workspace)
    if (/^\.html?$/i.test(path.extname(url))) {
      if (!/^\.html?$/i.test(path.extname(file))) fail('成果实际文件的扩展名不是 HTML')
      await runtime.openArtifactPage(ref.workspace, file)
    } else {
      await orca.host.call('editor.open', { workspaceId: target, path: path.relative(ref.path, url).split(path.sep).join('/') }, { signal: AbortSignal.timeout(readTimeout) })
    }
    return orca.host.call('workspace.open', { workspaceId: target }, { signal: AbortSignal.timeout(readTimeout) })
  })
  orca.panels.handle('project.openArtifactFolder', async input => {
    const { file, info } = await localArtifact(input, false)
    const directory = info.isDirectory()
    if (!directory && !info.isFile()) fail('成果文件不存在或无法访问')
    await runtime.revealArtifact(file, directory)
    return { opened: true }
  })

  let lastInventory: { at: number; inventory: TargetInventory } | undefined
  type ProjectRecords = Awaited<ReturnType<typeof availableProjectRecords>>
  let checking: { sample: ReturnType<typeof sampleBindings>; done: Promise<void> } | undefined, stoppedChecks = false
  function deferBackupCheck() { setImmediate(() => { if (!stoppedChecks) void checkBackups().catch(() => {}) }) }
  async function sampleBindings(records?: ProjectRecords) {
    records ??= await availableProjectRecords()
    const workspace = await store.workspace()
    const projects = records.list.filter(p => !p.hidden && p.runId && p.ref.hostId === 'local')
    const sequence = activitySequence
    const inventory = !stoppedChecks && (workspace.runId || projects.length) && !records.error ? runtime.targets('sample').catch(() => undefined) : undefined
    return { records, workspace, projects, inventory, sequence }
  }
  function checkBackups(records?: ProjectRecords) {
    if (!checking) {
      const sample = sampleBindings(records)
      checking = { sample, done: sample.then(inspectBindings).finally(() => { checking = undefined }) }
    }
    return checking.done
  }
  async function inspectBindings({ records: { list, error }, workspace: w, projects, inventory: reading }: Awaited<ReturnType<typeof sampleBindings>>) {
    if (stoppedChecks) return
    const inventory = await reading
    let reviewed: Promise<TargetInventory | undefined> | undefined
    const recheck = () => reviewed ??= runtime.targets().catch(() => undefined)
    lastInventory = inventory ? { at: Date.now(), inventory } : undefined
    if (await backups.inventoryStatus(w, !!inventory)) w = await store.workspace()
    const known = error ? await store.all() : list
    await backups.syncContacts([w, ...known], inventory?.sessions, inventory?.workspaces.map(s => s.workspace) ?? list.map(p => p.ref.workspace).filter(Boolean))
    if (w.retired?.some(d => !d.control && d.state === 'pending')) void main.flushRetired().catch(() => {})
    if (error || (!w.runId && !projects.length)) return
    const mailbox = await store.messaging()
    for (const r of [w, ...projects]) {
      if (stoppedChecks || !r.runId || takeoverActive(r.takeover)) continue
      const project = 'ref' in r ? r : undefined
      if (!project && !w.bot && !workspaceBackupInFlight(w.backup)) continue
      if (!inventory) {
        await backups.missing(r, '无法读取 Orca 工作区和会话列表', w.runId).catch(() => {})
        continue
      }
      const handle = (project ? project.mainAgentHandle : w.session?.handle) || await runtime.runBinding(r.runId).then(run => run.owner).catch(() => undefined)
      if (!handle) {
        await backups.missing(r, '找不到已绑定 Run 的主会话', w.runId).catch(() => {})
        continue
      }
      const session = inventory.sessions.find(s => s.handle === handle) ?? (project ? projectBinding({ ...project, mainAgentHandle: handle }).session : w.session)
      if (!session || (!w.bot || project) && !inventory.workspaces.some(w => w.workspace === session.workspace)) {
        await backups.missing(r, '找不到已绑定主会话的工作区', w.runId).catch(() => {})
        continue
      }
      const bot = !project && w.bot
      const monitorPending = r.backup?.handle || bot
      const mail = !monitorPending ? [] : project ? waitingByRun.get(r.runId) : await runtime.mail(r.runId)
        .then(m => [...m.waiting ?? [], ...m.questions.filter(q => !bot || !q.read).map(q => ({ at: q.at, title: q.subject }))] as Waiting).catch(() => null)
      const pending: { at: number; title: string }[] | undefined = mail ? [] : undefined
      if (monitorPending && mail && pending) {
        const reports = mail.flatMap(m => m.report ? [m.report] : [])
        const submitted = project && await store.archive.submittedReports(project, reports)
        pending.push(...mail.filter(m => !m.report || (submitted ? !submitted.has(m.report.id) : !m.read)))
        const sourceTimes = new Map<string, number>()
        if (project) {
          pending.push(...questions.filter(q => q.runId === r.runId))
          const submitted = new Map(project.tasks.map(t => [t.id, Date.parse(t.submittedAt ?? t.updatedAt)]))
          for (const e of project.events) {
            const at = Date.parse(e.receivedAt)
            sourceTimes.set(e.id, at)
            // Unlinked sources must still be queued or appear as unread mail for this Run.
            if (e.taskId && (submitted.get(e.taskId) ?? Infinity) < at) pending.push({ at, title: e.text.slice(0, 120) })
          }
        } else if (!bot) {
          for (const entry of mailbox.inbox) {
            if (mailbox.deliveries.some(d => d.id === entry.event.id && d.targetRunId === w.runId) &&
              !mailbox.deliveries.some(d => d.external?.appId === entry.appId && d.external.replyTo === entry.event.sourceId.slice(entry.appId.length + 1) && d.state === 'sent'))
              pending.push({ at: Date.parse(entry.event.receivedAt), title: entry.event.text.slice(0, 120) })
          }
        }
        const deliveries = project ? project.deliveries : [...mailbox.deliveries, ...projects.flatMap(p => p.deliveries.filter(d => d.targetRunId === w.runId))]
        for (const d of deliveries) if (!d.control && !d.external && !d.id.startsWith('retired:') && (!d.targetRunId || d.targetRunId === r.runId) &&
          (d.state === 'pending' || !bot && d.state === 'uncertain' && d.targetRunId === r.runId)) pending.push({ at: d.createdAt ?? sourceTimes.get(d.id) ?? r.backup?.confirmedAt ?? r.backup?.since ?? Date.parse(w.boundAt ?? ''), title: d.subject })
      }
      const context = (project ? [project] : projects).flatMap(p => p.tasks.filter(t => t.phase === 'working').map(t =>
        [t.title, ...t.executions.slice(-3).map(e => e.agent + ' ' + e.dispatchId)].join(' · ').slice(0, 300))).slice(0, 12).join('；')
      if (r.backup && ('ref' in r ? r.deliveries : r.retired)?.some(d => d.control && d.state === 'pending')) {
        if (project) defer(project.ref.id)
        else void main.flushRetired().catch(() => {})
      }
      await backups.inspect(r, session, inventory, pending?.filter(p => Number.isFinite(p.at)), context, w.runId, Date.now(), recheck).catch(() => {
        // Binding revisions can change during a sample. Re-read this role on the next tick.
      })
    }
  }

  let refreshMain: ReturnType<typeof setTimeout> | undefined
  async function refreshLeads(records?: ProjectRecords) {
    agentsDirty = true
    const inspected = checkBackups(records), observed = checking!.sample
    await Promise.all([inspected, refreshAgents(false, observed)])
    // Inbox and peer expiry also rely on the periodic refresh.
    await publishActivity(true)
  }
  function schedulePoll(delay: number) {
    refreshMain = setTimeout(async () => {
      const started = Date.now()
      try {
        const records = await refreshQuestions()
        if (!stoppedChecks) await refreshLeads(records)
      } catch { /* Retry on the next poll. */ }
      const elapsed = Date.now() - started
      if (!stoppedChecks) schedulePoll(elapsed < readTimeout ? activityInterval : Math.min(5 * activityInterval, activityInterval + 4 * elapsed))
    }, delay)
    refreshMain.unref()
  }
  return { store, links, connections, ingest, flush, flushMailbox, updateStatus, refreshQuestions, checkBackups, stop: () => { stoppedChecks = true; clearTimeout(refreshMain); activityEvents.abort(); activityEvent.dispose(); connections.stop(); links.stop(); sources.stop() }, async start(hooksChangedVersion?: string) {
    if (hooksChangedVersion) try {
      const id = 'setup-hooks:' + hooksChangedVersion
      if (!(await store.messaging()).deliveries.some(d => d.id === id)) await store.mutateMessaging(m => {
        if (!m.deliveries.some(d => d.id === id)) m.deliveries.push({ id, state: 'pending', subject: 'AgentBoat hooks 需要更新',
          body: `AgentBoat ${hooksChangedVersion} 的 hooks 登记有变化，请主人打开「工作间 → 设置 → 主 agent」，核对路径后修复。` })
      })
    } catch (error) { console.error('AgentBoat 无法登记 hooks 提醒', error) }
    if (refreshRoles) { await readCatalog(); await refreshRoles() }
    await links.start()
    await connections.start()
    await main.recover()
    clearTimeout(refreshMain)
    schedulePoll(activityInterval)
    const { refs, error } = await availableProjects(), current = error ? [] : (await store.all()).filter(p => refs.some(ref => ref.id === p.ref.id))
    for (const p of current) {
      if (needsLeadCompaction(p) || p.takeover?.state === 'sending' || p.deliveries.some(x => x.state === 'sending')) await store.mutate(p.ref.id, undefined, p => {
        recoverTakeover(p.takeover)
        for (const d of p.deliveries.filter(x => x.state === 'sending')) { d.state = 'uncertain'; d.error = '插件重启前通知结果待核对' }
      })
    }
    if ((await store.messaging()).deliveries.some(d => d.state === 'sending')) await store.mutateMessaging(m => { for (const d of m.deliveries) if (d.state === 'sending') { d.state = 'uncertain'; d.error = '重启前发送结果待核对' } })
    await syncSources()
    for (const entry of (await store.messaging()).inbox.filter(x => x.state === 'pending')) await processMessage(entry.event.id)
    for (const p of current) defer(p.ref.id)
    deferMailbox()
    setImmediate(() => { if (!stoppedChecks) void refreshLeads().catch(() => {}) })
  } }
}

let coordinator: ReturnType<typeof createCoordinator> | undefined
let cli: ReturnType<typeof cliBridge> | undefined
export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  if (!release) throw new Error('请在 Orca 中安装 AgentBoat 正式版')
  // Orca can omit CODEX_HOME from the trusted worker environment.
  const codexHomeKey = 'workspace.setup.codexHome'
  const codexHome = async () => {
    const configured = await orca.storage.get(codexHomeKey)
    return typeof configured === 'string' ? configured : ''
  }
  // A broken stable link must not stop the plugin; the versioned paths keep working.
  let hooksChangedVersion: string | undefined
  try {
    const configured = await codexHome()
    hooksChangedVersion = await refreshReleaseSetup(validateCodexHome(configured) || undefined)
  }
  catch (error) { console.error('AgentBoat 启动时检查固定入口和 skill 失败', error) }
  const runtime = new OrcaRuntime(async () => {
    const configured = await orca.settings.get('cliPath')
    return typeof configured === 'string' && configured.trim() ? configured.trim() : defaultExecutable
  })
  cli = cliBridge(orca)
  coordinator = createCoordinator(cli.api, runtime, undefined, undefined, undefined, roleRegistryPath(), {
    preview: async () => {
      const saved = await codexHome()
      return { ...previewSetup({ codexHome: saved }), codexHome: saved }
    },
    apply: async confirmation => applySetup(confirmation, { codexHome: await codexHome() }),
    saveCodexHome: async value => {
      const validated = validateCodexHome(value)
      await orca.storage.set(codexHomeKey, validated)
      return validated
    }
  })
  await coordinator.start(hooksChangedVersion)
  await cli.start()
}
export function deactivate(): void { cli?.stop(); coordinator?.stop() }
