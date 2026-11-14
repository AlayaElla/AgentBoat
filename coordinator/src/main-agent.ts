import { randomBytes, randomUUID } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import type { WorkspaceBinding } from './model'
import type { CoordinatorRuntime } from './runtime'
import { ProjectStore, fail, fingerprint, text } from './store'

const mainSecurityBoundary = 'Run 归属由会话自报；替换授权来自面板一次性凭据。同一系统用户的本机程序可读写插件数据。'

export function mainAgent(orca: OrcaWorkerApi, store: ProjectStore, runtime: CoordinatorRuntime, changed: () => void) {
  const revision = (v: unknown) => { if (!Number.isSafeInteger(v) || (v as number) < 0) fail('请刷新工作间版本'); return v as number }
  async function read(): Promise<WorkspaceBinding> {
    const w = await store.workspace()
    const s = w.session
    const online = s && runtime.targets ? await runtime.targets().then(t => t.sessions.find(x => x.handle === s.handle)?.online ?? 'offline' as const).catch(() => 'unknown' as const) : 'unknown'
    return { revision: w.revision, runId: w.runId,
      securityBoundary: mainSecurityBoundary, ...(w.verification ? { verification: w.verification } : {}),
      ...(s ? { session: { ...s, online } } : {}), ...(w.boundAt ? { boundAt: w.boundAt } : {}),
      ...(w.runId ? { projectNames: (await store.all()).filter(p => p.runId === w.runId).map(p => p.ref.name) } : {}),
      ...(w.retired?.length ? { previousNotice: w.retired.at(-1)!.state } : {}),
      ...(w.takeover ? { takeover: { id: w.takeover.id, target: w.takeover.target, expiresAt: w.takeover.expiresAt, state: w.takeover.state } } : {}) }
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
      if (!runtime.identify) fail('Orca 无法核实调用会话')
      const session = await runtime.identify(caller, runId, input.currentRunId)
      await store.bindWorkspace(revision(input.revision), runId, { id: text(input.requestId, '请求编号', 200), input }, session, input.token, input.checkOnly)
      if (input.checkOnly) return { ...await read(), check: { canTakeOver: true, message: '可以接管；本次只核实，凭据和绑定均未改变', runId, session, verification: { run: 'plugin', session: 'plugin', runOwnership: 'self-reported' } } }
      await flushRetired(); changed()
    } else if (input.operation !== 'read') fail('不支持的工作间操作')
    return read()
  })
  orca.panels.handle('workspace.agent.targets', async () => {
    if (!runtime.targets) fail('当前 Orca 不支持查询会话')
    const t = await runtime.targets()
    return { ...t, sessions: t.sessions.filter(s => s.online === 'online') }
  })
  orca.panels.handle('workspace.agent.switch', async input => {
    if (!runtime.targets) fail('当前 Orca 不支持查询会话')
    const targets = await runtime.targets()
    if (!['existing', 'new'].includes(input.mode)) fail('请选择切换方式')
    const existing = input.mode === 'existing'
    const target = existing ? targets.sessions.find(s => s.handle === input.handle && s.online === 'online') : (() => {
      const w = targets.workspaces.find(w => w.workspace === input.workspace)
      if (!w || !['claude', 'codex', 'opencode'].includes(input.agent ?? '')) return
      return { handle: '', title: `新的 ${input.agent} 会话`, workspace: w.workspace, workspaceName: w.name, path: w.path, agent: input.agent!, online: 'unknown' as const }
    })()
    if (!target) fail('目标会话或工作区已不可用，请刷新后选择')
    if (existing ? !runtime.requestTakeover : !runtime.launchMain) fail('当前 Orca 不支持此切换方式')
    const token = randomBytes(32).toString('base64url'), id = randomUUID(), expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
    await store.mutateWorkspace(w => {
      if (w.session?.handle && w.session.handle === target.handle) fail('该会话已经是主 agent')
      if (w.takeover && Date.parse(w.takeover.expiresAt) > Date.now()) fail('已有接管请求，请等待接管或凭据过期后再发起')
      w.takeover = { id, target, expiresAt, tokenHash: fingerprint(token), state: 'sending' }
    }, revision(input.revision))
    changed()
    const prompt = `开启工作间管理。主人已在项目协作面板发起切换，请由当前会话接管工作间主 agent。先读 $agentboat-workspace；自己创建新的协调 Run，再运行 client.mjs main-read，以最新 revision 和唯一 requestId 调用 main-bind。main-bind 从标准输入接收 JSON；caller 由脚本从当前 Orca 环境取得，不要填写别人的会话或 Run。一次性接管凭据：${token}\n有效至：${expiresAt}\n仅用于本次接管，不保存到文件或记忆，不转发。绑定成功后先读取 overview 补齐之前的待办；已经送达原主 agent 的通知不会补发。`
    try {
      const handle = existing ? (await runtime.requestTakeover!(target.handle, prompt), target.handle) : await runtime.launchMain!(target.workspace, target.agent, prompt)
      await store.mutateWorkspace(w => { if (w.takeover?.id === id) { w.takeover.target.handle = handle; w.takeover.state = 'waiting' } })
    } catch {
      await store.mutateWorkspace(w => { if (w.takeover?.id === id) w.takeover.state = 'uncertain' })
    }
    changed(); return read()
  })
  async function recover() {
    const w = await store.workspace()
    if (w.takeover?.state === 'sending' || w.retired?.some(d => d.state === 'sending')) await store.mutateWorkspace(w => {
      if (w.takeover?.state === 'sending') w.takeover.state = 'uncertain'
      for (const d of w.retired ?? []) if (d.state === 'sending') d.state = 'uncertain'
    })
    await flushRetired()
  }
  return { read, recover }
}
