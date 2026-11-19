import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { clientPath } from '../scripts/orca-cli.mjs'
import type { OrcaWorkerApi } from 'orca/worker'
import { agents, type AgentSession, type LeadSwitch, type MainTakeover, type Project, type StoredTakeover, type WorkspaceBinding } from './model'
import type { CoordinatorRuntime } from './runtime'
import type { AgentLaunch } from '../../workspace/agent-launch.mjs'
import { ProjectStore, fail, fingerprint, takeoverActive, text, revision } from './store'

const mainSecurityBoundary = 'Run 归属由会话自报；替换授权来自面板一次性凭据。同一系统用户的本机程序可读写插件数据。'
export const roleReminder = {
  workspace: '提醒：你是工作间管理员，项目里的活交给项目主会话。',
  project: '提醒：实现交给执行者，成果用 submit 登记待验收。'
}

export function takeoverView(t?: StoredTakeover): MainTakeover | undefined {
  if (!t) return
  const { id, target, expiresAt, state, error } = t
  return takeoverActive(t) ? { id, target, expiresAt, state, ...(error ? { error } : {}) }
    : { id, target, expiresAt, state: 'expired', error: '对方没在有效期内完成绑定' }
}
export function recoverTakeover(t?: StoredTakeover) {
  if (t?.state === 'sending') {
    t.state = 'uncertain'
    t.error = '插件重启，接管请求是否送达未知，请核对目标会话'
  }
}
type Inventory = Awaited<ReturnType<CoordinatorRuntime['targets']>>
type Binding = { takeover?: StoredTakeover; session?: AgentSession; mainAgentHandle?: string }
export async function switchLead(runtime: CoordinatorRuntime, input: LeadSwitch, options: {
  targets: () => Promise<Inventory>
  mutate: (update: (binding: Binding) => void, expected?: number) => Promise<unknown>
  changed: () => void
  role: keyof typeof roleReminder
  prompt: (token: string, expiresAt: string) => string
  subject?: string
  launch?: Omit<AgentLaunch, 'agent'>
}) {
  const expected = revision(input.revision), { mutate, changed } = options
  if (input.mode === 'cancel') {
    await mutate(w => { delete w.takeover }, expected)
    changed()
    return
  }
  if (input.mode !== 'existing' && input.mode !== 'new') fail('请选择切换方式')
  const targets = await options.targets()
  const existing = input.mode === 'existing', agent = input.agent ?? ''
  const target = existing ? targets.sessions.find(s => s.handle === input.handle && s.online === 'online') : (() => {
    const w = targets.workspaces.find(w => w.workspace === input.workspace)
    if (!w || !Object.hasOwn(agents, agent)) return
    return { handle: '', title: `新的 ${agents[agent as keyof typeof agents]} 会话`, workspace: w.workspace, workspaceName: w.name, path: w.path, agent, online: 'unknown' as const }
  })()
  if (!target) fail('目标会话或工作区已不可用，请刷新后选择')
  if (!existsSync(clientPath)) fail('找不到接管脚本，请从 AgentBoat 仓库构建并加载插件')
  const token = randomBytes(32).toString('base64url'), id = randomUUID(), expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
  await mutate(w => {
    if (target.handle && (w.session?.handle ?? w.mainAgentHandle) === target.handle) fail('该会话已经是主会话')
    const prior = w.takeover
    if (prior && takeoverActive(prior) &&
      (existing ? prior.target.handle === target.handle : prior.mode === input.mode && prior.target.workspace === target.workspace && prior.target.agent === target.agent)) fail('该会话的接管请求已发起')
    w.takeover = { id, target, expiresAt, tokenHash: fingerprint(token), state: 'sending', mode: existing ? 'existing' : 'new' }
  }, expected)
  changed()
  const prompt = `${options.prompt(token, expiresAt)}\n\n${roleReminder[options.role]}`
  let handle: string
  try {
    handle = existing ? (await runtime.requestTakeover(target.handle, prompt, options.subject), target.handle)
      : await runtime.launchMain(target.workspace, target.agent, prompt, options.launch)
  } catch {
    await mutate(w => {
      if (w.takeover?.id !== id) return
      w.takeover.state = 'uncertain'
      w.takeover.error = '接管请求未能确认送达，请核对目标会话后重试'
    })
    changed()
    return
  }
  await mutate(w => {
    if (w.takeover?.id !== id) return
    w.takeover.target.handle = handle
    w.takeover.state = 'waiting'
  })
  changed()
}

export function mainAgent(orca: OrcaWorkerApi, store: ProjectStore, runtime: CoordinatorRuntime, changed: () => void, bound: () => void, projects: () => Promise<Project[]>) {
  async function read(sample?: import('./model').AgentsSnapshot): Promise<WorkspaceBinding> {
    const w = await store.workspace()
    const takeover = takeoverView(w.takeover)
    const s = w.session
    const activity = sample?.ok && sample.main?.handle === s?.handle ? sample.main?.status : undefined
    const online = sample ? activity?.state === 'offline' ? 'offline' : activity && activity.state !== 'unknown' ? 'online' : 'unknown' : s ? await runtime.targets().then(t => t.sessions.find(x => x.handle === s.handle)?.online ?? 'offline' as const).catch(() => 'unknown' as const) : 'unknown'
    return { revision: w.revision, runId: w.runId,
      securityBoundary: mainSecurityBoundary,
      ...(s ? { session: { ...s, online } } : {}), ...(w.boundAt ? { boundAt: w.boundAt } : {}),
      ...(w.runId ? { projectNames: (await projects()).filter(p => !p.hidden && p.runId === w.runId).map(p => p.ref.name) } : {}),
      ...(w.retired?.length ? { previousNotice: w.retired.at(-1)!.state } : {}),
      ...(takeover ? { takeover } : {}) }
  }
  let flushing: Promise<void> | undefined
  function flushRetired(): Promise<void> {
    if (flushing) return flushing
    flushing = (async () => {
      while (true) {
        const d = (await store.workspace()).retired?.find(d => d.state === 'pending')
        if (!d) break
        await store.mutateWorkspace(w => { w.retired!.find(x => x.id === d.id)!.state = 'sending' })
        let state: 'sent' | 'uncertain' = 'sent'
        try { await runtime.send(d.targetRunId!, d) } catch { state = 'uncertain' }
        await store.mutateWorkspace(w => { w.retired!.find(x => x.id === d.id)!.state = state })
      }
    })().finally(() => { flushing = undefined })
    return flushing
  }
  orca.panels.handle('workspace.agent', async (input): Promise<WorkspaceBinding> => {
    if (input.operation === 'bind') {
      const runId = text(input.runId, 'Run 编号', 200), caller = text(input.caller, '调用会话', 500)
      if (input.checkOnly !== undefined && typeof input.checkOnly !== 'boolean') fail('checkOnly 必须是布尔值；检查请用 main-bind --check')
      await runtime.verifyRun(runId, caller)
      const session = await runtime.identify(caller, runId, input.currentRunId)
      await store.bindWorkspace(revision(input.revision), runId, { id: text(input.requestId, '请求编号', 200), input }, session, input.token, input.checkOnly)
      if (input.checkOnly) return { ...await read(), check: { canTakeOver: true, message: '可以接管；本次只核实，凭据和绑定均未改变', runId, session } }
      bound()
      await flushRetired(); changed()
    } else if (input.operation !== 'read') fail('不支持的工作间操作')
    return read()
  })
  orca.panels.handle('workspace.agent.targets', async () => {
    const t = await runtime.targets()
    return { ...t, sessions: t.sessions.filter(s => s.online === 'online') }
  })
  orca.panels.handle('workspace.agent.switch', async input => {
    await switchLead(runtime, input, {
      role: 'workspace',
      targets: () => runtime.targets(), mutate: (update, expected) => store.mutateWorkspace(update, expected), changed,
      prompt: (token, expiresAt) => `开启工作间管理。主人已在项目协作面板发起切换，请由当前会话接管工作间主 agent。先读 $agentboat-workspace；自己创建新的协调 Run。接管脚本绝对路径：${JSON.stringify(clientPath)}\n用 node 调用此路径的 main-read，再以最新 revision 和唯一 requestId 调用 main-bind --check；检查通过后重读 main-read，以最新 revision 和新的 requestId 正式 main-bind。main-bind 从标准输入接收 JSON；caller 由脚本从当前 Orca 环境取得，不要填写别人的会话或 Run。一次性接管凭据：${token}\n有效至：${expiresAt}\n仅用于本次接管，不保存到文件或记忆，不转发。绑定成功后先读取 overview 补齐之前的待办；已经送达原主 agent 的通知不会补发。`
    })
    return read()
  })
  async function recover() {
    const w = await store.workspace()
    if (w.takeover?.state === 'sending' || w.retired?.some(d => d.state === 'sending')) await store.mutateWorkspace(w => {
      recoverTakeover(w.takeover)
      for (const d of w.retired ?? []) if (d.state === 'sending') d.state = 'uncertain'
    })
    await flushRetired()
  }
  return { read, recover }
}
