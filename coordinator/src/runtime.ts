import { LocalBots, quotaReceipt } from './bot-runtime'
import { LeadContacts } from '../scripts/lead-contact.mjs'
import type { LeadContact, ContactRoutes } from './model'
import { execFile, type ExecFileOptions } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import type { AgentSession, Delivery, InstalledAgent, ProjectRef } from './model'
import { fail, fingerprint, projectKey } from './store'
import { readAgents, type AgentsSnapshot } from './agents'
import type { Project } from './model'
import type { HostApi } from 'orca/host'
import { agentFlags, launchReceipt, validAgentId, type AgentLaunch } from '../../workspace/agent-launch.mjs'
import { inboxLimit, openRunMail, type OrcaQuestion, type VerifiedOrcaQuestion, type OrcaWorkerRecord } from '../scripts/orca-questions.mjs'
import { workerReport, type WorkerReport } from '../scripts/worker-reports.mjs'
import { activeUserDataPath, localOrcaClient, localOrcaRequest, ownerMessages, pluginKey, release } from '../scripts/orca-cli.mjs'

export const readTimeout = 5000
const execute = promisify(execFile)
export async function revealArtifact(file: string, directory: boolean, platform = process.platform,
  run: (command: string, args: string[], options: ExecFileOptions) => Promise<unknown> = execute) {
  try {
    if (platform === 'win32') {
      const explorer = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe')
      // Explorer splits unquoted commas, so quote only the path and leave /select, outside.
      await run(explorer, [directory ? `"${file}"` : `/select,"${file}"`], { shell: false, windowsVerbatimArguments: true })
    } else if (platform === 'darwin') {
      await run('/usr/bin/open', directory ? [file] : ['-R', file], { shell: false })
    } else {
      await run('xdg-open', [directory ? file : path.posix.dirname(file)], { shell: false })
    }
  } catch (e) {
    // Explorer can return 1 after passing the request to the running desktop.
    if (platform !== 'win32' || (e as { code?: unknown } | null)?.code !== 1) throw e
  }
}
export interface TargetInventory {
  sessions: AgentSession[]
  workspaces: { workspace: string; name: string; path: string; botHomeKey?: string }[]
  unidentifiedTerminalWorkspaces?: string[]
  listedTerminalHandles?: string[]
  disconnectedTerminalHandles?: string[]
}
export interface CoordinatorRuntime {
  bots?: Pick<LocalBots, 'list' | 'find' | 'home' | 'choices' | 'hasSideChat' | 'startChat' | 'writeSoul' | 'removeSoul'>
  botMail?(target: string, subject: string, body: string, type: 'handoff' | 'status', home?: string): Promise<{ recipient: string; quota?: ReturnType<typeof quotaReceipt> }>
  projects(host: HostApi<'worker'>): Promise<ProjectRef[]>
  runBinding(id: string): Promise<{ owner: string | null; generation: number; objective?: string }>
  syncContacts(wanted: LeadContact[], workspaces?: string[]): Promise<ContactRoutes>
  installedAgents(workspace: string, fresh?: boolean): Promise<InstalledAgent[]>
  projectLeadQuota?(handle: string, runId: string): Promise<ReturnType<typeof projectLeadQuotaReceipt>>
  verifyRun(id: string, caller?: string): Promise<void>
  targets(mode?: 'sample' | 'display'): Promise<TargetInventory>
  identify(handle: string, runId: string, currentRunId?: string): Promise<AgentSession>
  requestTakeover(handle: string, prompt: string, subject?: string): Promise<void>
  launchMain(workspace: string, agent: string, prompt: string, options?: Omit<AgentLaunch, 'agent'>): Promise<string>
  openOverview(): Promise<void>
  openArtifactPage(workspace: string, file: string): Promise<void>
  openArtifactFile(workspace: string, file: string): Promise<void>
  revealArtifact(file: string, directory: boolean): Promise<void>
  removeProject(ref: ProjectRef, host: HostApi<'worker'>): Promise<void>
  agents(projects: Project[], host: HostApi<'worker'>, main?: AgentSession, targets?: Promise<TargetInventory | undefined>): Promise<AgentsSnapshot>
  mail(runId: string, submitted?: (reports: WorkerReport[]) => Promise<Set<string>>): Promise<{ questions: OrcaQuestion[]; reports: WorkerReport[]; waiting?: { at: number; title: string; read?: boolean; report?: WorkerReport }[] }>
  question(runId: string, id: string): Promise<VerifiedOrcaQuestion | undefined>
  ownerMessage(caller: string, sourceId: string): Promise<{ text: string; receivedAt: string }>
  workerFeedback(caller: string, taskId: string, dispatchId: string, sourceId: string): Promise<{ runId: string; text: string; receivedAt: string }>
  hermesApprovalMode(): Promise<string>
  send(runId: string, delivery: Delivery): Promise<{ requestId?: string }>
}
export function targetOnline(inventory: TargetInventory | undefined, handle: string, workspace?: string): AgentSession['online'] {
  if (!inventory) return 'unknown'
  const session = inventory.sessions.find(s => s.handle === handle)
  if (session) return session.online
  const unidentified = inventory.unidentifiedTerminalWorkspaces
  if (!handle.startsWith('orca_session_id:') && (inventory.listedTerminalHandles?.includes(handle) ||
    unidentified?.some(w => !workspace || w.replace(/^id:/, '') === workspace.replace(/^id:/, '')))) return 'unknown'
  return 'offline'
}

export function projectLeadQuotaReceipt(result: any, sessionId: string, runId: string) {
  const page = result?.page, latest = page?.latestTurn, turn = latest?.turn
  if (result?.ok !== true || page?.sessionId !== sessionId || page.working !== false ||
    !Array.isArray(page.actionablePromptIds) || page.actionablePromptIds.length || !Array.isArray(page.items) ||
    typeof latest?.itemId !== 'string' || turn?.state !== 'completed' || turn.outcome !== 'failure' ||
    !Number.isSafeInteger(turn.completedAt) || turn.completedAt <= 0 || typeof turn.userItemId !== 'string') return
  // Orca 1.4.277 can retain the Antigravity ACP diagnostic in a turn-scoped status row without a failure kind.
  if (!page.items.some((row: any) => row?.turnScope?.kind === 'turn' && row.turnScope.turnItemId === latest.itemId &&
    row.body?.kind === 'status' && (row.body.failure?.kind === 'usageLimitReached' ||
      !row.body.failure && row.body.tone === 'error' && row.body.text === 'Individual quota reached'))) return
  const prompt = page.items.find((item: any) => item?.itemId === turn.userItemId && item.body?.kind === 'message' && item.body.role === 'user')?.body
  const mail = prompt?.from?.orchestration
  if (prompt?.from?.kind !== 'agent' || mail?.message !== 'mail-notice' || mail.mailbox !== `run:${runId}` || !Array.isArray(mail.messages)) return
  const messages = mail.messages.filter((message: any) => message?.runId === runId && typeof message.messageId === 'string')
  if (!messages.length) return
  const promptText = prompt.blocks?.length === 1 && prompt.blocks[0]?.type === 'text' && prompt.blocks[0].text
  const sourceBodyHashes: string[] = typeof promptText === 'string' ? messages.flatMap((message: any) => {
    const span = message.content?.body
    if (message.from !== `plugin:${pluginKey}` || !Array.isArray(span) || span.length !== 2) return []
    const [start, end] = span
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= promptText.length
      ? [fingerprint(promptText.slice(start, end))] : []
  }) : []
  return { completedAt: turn.completedAt as number, sourceBodyHashes }
}

export class OrcaRuntime implements CoordinatorRuntime {
  constructor(private executable: () => Promise<string>, private artifactClient = localOrcaClient) {}
  async openArtifactPage(workspace: string, file: string) {
    const url = /^https?:\/\//i.test(file) ? new URL(file) : pathToFileURL(file)
    if (url.protocol === 'file:' && url.hostname) fail('仅可预览本机磁盘上的成果')
    let client
    try { client = this.artifactClient(await this.executable(), readTimeout) }
    catch { /* The packaged client could not be loaded. No request has been sent. */ }
    let result
    try {
      if (client) {
        const reply = await client.call('browser.tabCreate', { worktree: workspace, url: url.href, activate: true, navigation: 'all' }, { timeoutMs: readTimeout })
        if (!reply.ok) fail(reply.error?.message ?? 'Orca 未打开成果标签')
        result = reply.result as { browserPageId?: string } | undefined
      } else {
        result = await this.call(['tab', 'create', '--worktree', workspace, '--url', url.href, '--focus'], readTimeout)
      }
    } catch (e) {
      const error = e as { code?: string; killed?: boolean } | null
      if (error?.killed || error?.code === 'runtime_timeout' || error?.code === 'runtime_unavailable')
        fail('Orca 未确认成果标签，请查看当前工作区的标签')
      throw e
    }
    if (!result?.browserPageId) fail('Orca 未确认成果标签，请查看当前工作区的标签')
  }
  async openArtifactFile(workspace: string, file: string) {
    await this.call(['file', 'open', file, '--worktree', workspace, '--focus'], readTimeout)
  }
  revealArtifact(file: string, directory: boolean) { return revealArtifact(file, directory) }
  bots = new LocalBots(args => this.call(args, readTimeout))
  async botMail(target: string, subject: string, body: string, type: 'handoff' | 'status', home?: string) {
    const result = await this.call(['orchestration', 'send', '--from', `plugin:${pluginKey}`, '--to', target, '--type', type, '--subject', subject, '--body', body])
    const recipient = result.message?.to_handle
    if (typeof recipient !== 'string' || !recipient || !result.message.id) fail('bot 投递回执待核对')
    if (target.startsWith('orca_session_id:') && recipient !== target) fail('bot 投递收件地址待核对')
    return { recipient, quota: quotaReceipt(result, home ?? recipient) }
  }
  private async call(args: string[], timeout = 25000): Promise<any> {
    let stdout: string
    try {
      ({ stdout } = await execute(await this.executable(), [...args, '--environment', 'local', '--json', ...(args[0] === 'orchestration' ? ['--full'] : [])], {
        timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, ...(release ? { ORCA_USER_DATA_PATH: activeUserDataPath() } : {}), ...(process.platform === 'win32' ? {
          APPDATA: process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
          LOCALAPPDATA: process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
        } : {}) }
      }))
    } catch (e) {
      const output = (e as {stdout?: string}).stdout
      if (!output) throw e
      try { const reply = JSON.parse(output); throw new Error(reply.error?.message ?? 'Orca 请求未成功') }
      catch (parseError) { if (parseError instanceof SyntaxError) throw e; throw parseError }
    }
    const reply = JSON.parse(stdout)
    if (!reply.ok) throw new Error(reply.error?.message ?? 'Orca 请求未成功')
    return reply.result
  }
  async projectLeadQuota(handle: string, runId: string) {
    const sessionId = /^orca_session_id:([\w-]+)$/.exec(handle)?.[1]
    if (!sessionId) return
    // agent read discards turn identity and structured failures. Read the matching local build's journal.
    const reply = await localOrcaRequest(await this.executable(), 'agentSession.history', { sessionId, direction: 'tail' }, readTimeout)
    if (reply.ok) return projectLeadQuotaReceipt(reply.result, sessionId, runId)
  }
  // Display and polling reads may share a recent list. Identity checks and mutations always call Orca directly.
  private lists = new Map<string, { until: number; pending: boolean; result: Promise<any> }>()
  private list(args: string[], ttl = readTimeout, fresh = false) {
    const now = Date.now(), key = JSON.stringify(args)
    for (const [id, item] of this.lists) if (item.until <= now) this.lists.delete(id)
    const saved = this.lists.get(key)
    if (saved && (!fresh || saved.pending)) return saved.result
    const item = { until: now + ttl, pending: true, result: this.call(args, readTimeout).finally(() => { item.pending = false }) }
    this.lists.set(key, item)
    return item.result
  }
  async projects(host: HostApi<'worker'>): Promise<ProjectRef[]> {
    const options = { signal: AbortSignal.timeout(readTimeout) }
    const [list, spaces] = await Promise.all([host.call('project.list', {}, options), host.call('workspace.list', {}, options).catch(() => undefined)])
    if (list.truncated) fail('Orca 项目列表未完整返回，请先缩小工作区范围')
    return list.projects.filter(p => (p.hostId ?? 'local') === 'local').map(p => {
      const candidates = spaces?.workspaces.filter(w => w.projectId === p.id && (w.hostId ?? 'local') === 'local') ?? []
      const w = candidates.find(w => path.resolve(w.path) === path.resolve(p.path)) ?? candidates[0]
      return { id: projectKey('local', p.id), repoId: p.id, hostId: 'local', name: p.name,
        path: w?.path ?? p.path, workspace: w ? w.id.startsWith('identity:') ? w.id : `id:${w.id}` : '' }
    })
  }
  async runBinding(id: string) {
    if (!/^run_[\w-]+$/.test(id)) fail('Run 编号格式不正确')
    const { run } = await this.call(['orchestration', 'run-show', '--id', id], readTimeout)
    if (run?.id !== id) fail('Orca 未返回对应 Run')
    if (run.coordinator_handle !== null && typeof run.coordinator_handle !== 'string') fail('Orca 未返回协调者类型')
    return { owner: run.coordinator_handle as string | null, generation: run.consumer_generation as number, objective: run.objective as string | undefined }
  }
  private contacts = new LeadContacts()
  async syncContacts(wanted: LeadContact[], workspaces?: string[]): Promise<ContactRoutes> {
    return this.contacts.sync(wanted, await this.executable(), (args: string[]) => this.call(args), workspaces)
  }
  async installedAgents(workspace: string, fresh = false): Promise<InstalledAgent[]> {
    if (!workspace) fail('项目当前没有工作区')
    const { agents } = await this.list(['agent', 'installed', '--worktree', workspace], 60_000, fresh)
    if (!Array.isArray(agents) || agents.some(a => !validAgentId(a?.id) || typeof a.name !== 'string' || !a.name || typeof a.default !== 'boolean')) fail('Orca 的可启动 agent 列表无效')
    return agents.map(({ id, name, default: preferred }) => ({ id, name, default: preferred }))
  }
  async verifyRun(id: string, caller?: string): Promise<void> {
    const { owner } = await this.runBinding(id)
    if (caller && owner && owner !== caller) fail('Orca 返回的 Run 协调者与当前会话不符；请在目标会话创建自己的新 Run')
  }
  async targets(mode?: 'sample' | 'display') {
    const read = (args: string[]) => mode ? this.list(args, readTimeout, mode === 'sample') : this.call(args, readTimeout)
    // agents.list has no liveness/parent evidence; takeover still requires these exact CLI identities.
    const [ps, list] = await Promise.all([read(['worktree', 'ps', '--limit', '10000']), read(['terminal', 'list', '--limit', '10000'])])
    if (!Array.isArray(ps.worktrees) || !Array.isArray(list.terminals) || list.hostScope?.omittedHostIds?.includes('local') || ps.truncated || list.truncated || ps.hostScope?.omittedHostIds?.includes('local')) fail('会话列表不完整，请恢复 Orca 后重试')
    if (ps.worktrees.some((w: any) => w.address?.environment === 'local' && !w.isArchived && !Array.isArray(w.agents))) fail('会话列表缺少 agent 状态')
    return mainTargets(ps.worktrees, list.terminals)
  }
  async identify(handle: string, runId: string, currentRunId?: string) {
    if (currentRunId !== runId) fail('当前会话自报的 Run 与申请不一致；请在目标会话创建自己的 Run，再用 client.mjs main-bind 调用')
    const session = (await this.targets()).sessions.find(s => s.handle === handle)
    if (!session || session.online !== 'online') fail('无法核实目标会话在线或身份；请从目标会话调用 main-bind，已关闭时请主人在面板重新选择')
    return session
  }
  async requestTakeover(handle: string, prompt: string, subject = '【项目协作】请接管工作间主 agent') {
    await this.call(['orchestration', 'send', '--from', `plugin:${pluginKey}`, '--to', handle, '--type', 'status', '--subject', subject, '--body', prompt])
  }
  async launchMain(workspace: string, agent: string, prompt: string, options?: Omit<AgentLaunch, 'agent'>) {
    const launch = await this.call(['agent', 'launch', ...agentFlags({ agent, ...options }), '--worktree', workspace, '--prompt', prompt])
    if (options?.surface === 'chat' && launch.outcome?.kind !== 'structured') fail('聊天会话启动回执待核对，不会自动重启')
    return launchReceipt(launch)
  }
  async openOverview() { await this.call(['plugin', 'open', pluginKey, '--panel', 'project-coordinator']) }
  async agents(projects: Project[], host: HostApi<'worker'>, main?: AgentSession, targets?: Promise<TargetInventory | undefined>) {
    return readAgents(host, args => this.list(args, readTimeout, args[0] !== 'orchestration'), projects, main, targets)
  }
  private async runInbox(runId: string) {
    // shortcut: Orca inbox has no pagination; scan the newest bounded window.
    const result = await this.call(['orchestration', 'inbox', '--run', runId, '--limit', String(inboxLimit)], readTimeout)
    if (!Array.isArray(result.messages) || result.messages.some((m: any) => !m || m.run_id !== runId)) fail('Orca 运行邮件无法核对')
    return result.messages as Record<string, any>[]
  }
  private openMail(messages: Record<string, any>[], runId: string, questionId?: string) {
    return openRunMail(messages, runId, async ids => {
      const [taskList, workers] = await Promise.all([
        this.call(['orchestration', 'task-list', '--run', runId], readTimeout),
        this.questionWorkers(runId, ids, questionId !== undefined)
      ])
      if (!Array.isArray(taskList.tasks) || taskList.runId !== runId) fail('Orca 项目任务状态无法核对')
      return { tasks: taskList.tasks, workers }
    }, Date.now(), questionId)
  }
  async question(runId: string, id: string) {
    return (await this.openMail(await this.runInbox(runId), runId, id)).questions[0]
  }
  async mail(runId: string, submitted?: (reports: WorkerReport[]) => Promise<Set<string>>) {
    const messages = await this.runInbox(runId)
    const reports = messages.map(workerReport).filter((r): r is WorkerReport => !!r)
    const done = await submitted?.(reports)
    const pending = done?.size ? messages.filter(m => !done.has(m.id)) : messages
    const actionable = await this.openMail(pending, runId)
    const waiting = pending.flatMap((m: any) => {
      if (m.to_handle !== 'run:' + runId || !Number.isFinite(Date.parse(m.created_at))) return []
      if (m.type === 'worker_done') {
        const report = workerReport(m)
        return report?.taskId && report.dispatchId ? [{ at: report.at!, title: m.subject || '执行者回报', read: !!m.read, report }] : []
      }
      return !m.read && m.type === 'status' ? [{ at: Date.parse(m.created_at), title: m.subject || '待处理通知' }] : []
    })
    return { ...actionable, waiting }
  }
  async workerFeedback(caller: string, taskId: string, dispatchId: string, sourceId: string) {
    const { dispatch } = await this.call(['orchestration', 'worker-show', '--dispatch', dispatchId], readTimeout)
    if (dispatch?.id !== dispatchId || dispatch.taskId !== taskId || !/^run_[\w-]+$/.test(dispatch.runId) ||
      dispatch.status !== 'dispatched' || dispatch.capabilityRevokedAt !== null ||
      dispatch.hostScope?.kind !== 'local' || !caller.startsWith('orca_session_id:') ||
      dispatch.processIncarnation !== `structured:${caller.slice('orca_session_id:'.length)}`)
      fail('当前会话不是这项在途派工的本机执行者')
    const origin = await this.ownerMessage(caller, sourceId)
    const dispatchedAt = Date.parse(dispatch.dispatchedAt?.replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)$/, '$1T$2Z'))
    if (!(Date.parse(origin.receivedAt) >= dispatchedAt)) fail('用户消息早于当前派工，请核对来源')
    return { runId: dispatch.runId, ...origin }
  }
  async ownerMessage(caller: string, sourceId: string) {
    const [message] = await ownerMessages(caller, await this.executable(), sourceId)
      .catch(() => fail('Orca 无法核对用户原消息来源'))
    if (!message) fail('未在 Orca 聊天中核对到完整的用户原话')
    return { text: message.text, receivedAt: message.receivedAt }
  }
  private async questionWorkers(runId: string, ids: Set<string>, fresh = false) {
    const workers: OrcaWorkerRecord[] = [], visited = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await this.list(['orchestration', 'worker-list', '--run', runId, ...(cursor ? ['--cursor', cursor] : [])], readTimeout, fresh)
      if (!Array.isArray(page.workers) || !page.page) fail('Orca 执行者状态无法核对')
      for (const worker of page.workers) if (worker?.runId === runId && ids.delete(worker.dispatchId)) workers.push(worker)
      if (!page.page.hasMore || !ids.size) break
      cursor = page.page.nextCursor
      if (!cursor || visited.has(cursor)) fail('Orca 执行者分页无法核对')
      visited.add(cursor)
    } while (true)
    return workers
  }
  async hermesApprovalMode() {
    const macLauncher = path.join(os.homedir(), '.local', 'bin', 'hermes')
    const command = process.platform === 'win32'
      ? path.join(process.env.HERMES_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes'), 'bin', 'hermes.exe')
      : process.platform === 'darwin' && existsSync(macLauncher) ? macLauncher : 'hermes'
    try {
      const { stdout } = await execute(command, ['config', 'get', 'approvals.mode', '--json'], { timeout: 15000, windowsHide: true, maxBuffer: 65536 })
      const mode = JSON.parse(stdout)
      return ['manual', 'smart', 'off'].includes(mode) ? mode : ''
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }
  async removeProject(ref: ProjectRef, host: HostApi<'worker'>) {
    if (ref.hostId !== 'local') fail('只能移除本机项目')
    const setups = await this.call(['project', 'setups'])
    if (!Array.isArray(setups.setups) || setups.truncated) fail('无法确认项目登记，未移除')
    const found = setups.setups.filter((s: any) => s.repoId === ref.repoId && s.hostId === ref.hostId && path.resolve(s.path) === path.resolve(ref.path))
    if (found.length > 1) fail('项目登记不唯一，未移除')
    if (!found.length) {
      if ((await this.projects(host)).some(p => p.id === ref.id)) fail('无法定位项目登记，未移除')
      return
    }
    // --force also bypasses open-session guards; inspect every worktree and terminal immediately before removal.
    const [ps, terminals] = await Promise.all([this.call(['worktree', 'ps', '--limit', '10000']), this.call(['terminal', 'list', '--limit', '10000'])])
    assertProjectIdle(ref, ps, terminals)
    await this.call(['project', 'setup-delete', '--setup', found[0].id, '--force'])
    if ((await this.projects(host)).some(p => p.id === ref.id)) fail('Orca 尚未确认移除，工作间记录保留')
  }
  async send(runId: string, delivery: Delivery): Promise<{ requestId?: string }> {
    const result = await this.call(['orchestration', 'send', '--from', `plugin:${pluginKey}`, '--to', `run:${runId}`, '--type', 'status',
      '--subject', delivery.subject.startsWith('【项目协作】') ? delivery.subject : `【项目协作】${delivery.subject}`, '--body', delivery.body])
    return result.mutation?.requestId ? { requestId: result.mutation.requestId } : {}
  }
}
export function assertProjectIdle(ref: ProjectRef, ps: any, list: any) {
  if (!Array.isArray(ps.worktrees) || !Array.isArray(list.terminals) || ps.truncated || list.truncated || [ps, list].some(s => s.hostScope?.omittedHostIds?.includes('local'))) fail('终端或会话列表不完整，未移除项目')
  const rows = ps.worktrees.filter((w: any) => w.repoId === ref.repoId && (w.hostId ?? 'local') === ref.hostId)
  if (rows.some((w: any) => (w.agents?.length ?? 0) > 0 || w.liveTerminalCount > 0 || w.unverifiableTerminalCount > 0 || w.hasAttachedPty) || list.terminals.some((t: any) => t.repoId === ref.repoId || rows.some((w: any) => t.worktreeId === w.worktreeId || t.workspaceId === w.worktreeId || t.tabId === w.worktreeId))) fail('这个项目还有打开的终端或会话，先关掉再删')
}
// Only runtime-issued handles and explicit liveness are used; saved activity alone is not online evidence.
export function mainTargets(rows: any[], terminals: any[]): TargetInventory {
  const sessions: AgentSession[] = [], workspaces: TargetInventory['workspaces'] = []
  const unidentifiedTerminalWorkspaces = new Set<string>()
  for (const w of rows) {
    if (w.address?.environment !== 'local' || (w.hostId ?? 'local') !== 'local' || !w.address?.worktree || !w.path || w.isArchived) continue
    const workspace = w.address.worktree, name = w.displayName || w.repo || ''
    workspaces.push({ workspace, name, path: w.path, ...(w.botHome === true ? { botHomeKey: w.worktreeId } : {}) })
    for (const a of w.agents ?? []) {
      if (a.parentPaneKey) continue
      const match = /^structured-agent-session-(.+):[^:]+$/.exec(a.paneKey ?? '')
      const t = terminals.find(t => `${t.tabId}:${t.leafId}` === a.paneKey)
      const address = typeof a.address === 'string' ? a.address : undefined
      const handle = match ? `orca_session_id:${match[1]}` : address || t?.handle
      if (!handle) { unidentifiedTerminalWorkspaces.add(workspace); continue }
      // The worktree row preserves identity when the terminal list misses it. Only the matching terminal can establish liveness.
      const live = match ? a.subagentObservation : t?.handle !== handle ? undefined :
        t.connected === true && t.writable === true && !t.orphaned ? 'live' : t.connected === false ? 'exited' : undefined
      sessions.push({ handle, title: a.conversationName || a.displayName || t?.paneTitle || t?.title || '', workspace, workspaceName: name, path: w.path,
        ...(a.state ? { state: a.state, ...(Number.isFinite(a.stateStartedAt) && { stateStartedAt: a.stateStartedAt }) } : {}),
        agent: a.agentType || t?.agentType || '', online: live === 'live' ? 'online' : live === 'exited' ? 'offline' : 'unknown' })
    }
  }
  return { sessions, workspaces, unidentifiedTerminalWorkspaces: [...unidentifiedTerminalWorkspaces],
    listedTerminalHandles: terminals.filter(t => t.connected !== false && typeof t.handle === 'string').map(t => t.handle),
    disconnectedTerminalHandles: terminals.filter(t => t.connected === false && typeof t.handle === 'string').map(t => t.handle) }
}
export { executable as defaultExecutable } from '../scripts/orca-cli.mjs'
