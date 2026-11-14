import { assert, test, mockHost, mountWorker } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { OrgCanvas, layout, layoutKey, moved, activateKey } from './org-canvas'
import { createCoordinator } from './worker'
import { fresh } from './store'
import { refs, sample } from './fixtures'

test('canvas edits reach existing connection and project settings; layout reopens and hidden projects stay excluded', async () => {
  const p = sample().project!, hidden = fresh(refs[1]); hidden.hidden = true
  const links = { version: 1, revision: 0, workspaceId: 'own', name: '本工作间', enabled: false, host: '127.0.0.1', port: 0, publicUrl: '', tls: false,
    peers: [{ id: 'peer', workspaceId: 'other', name: '其他工作间', endpoint: '', state: 'active', scope: 'none', projectIds: [], acceptTasks: 'deny' }] }
  const binding = { version: 1, revision: 0, runId: 'run_main', requests: [] }
  const host = mockHost({ storage: { 'project:p1': p as any, 'project:p2': hidden as any, workspace: binding, 'workspace.links': links } })
  let c!: ReturnType<typeof createCoordinator>, storage!: OrcaWorkerApi['storage'], kind: 'claude' | undefined = 'claude'
  const worker = await mountWorker({ default: (api: OrcaWorkerApi) => {
    storage = api.storage; c = createCoordinator(api, { projects: async () => refs, verifyRun: async () => {}, mainAgent: async () => kind, send: async () => ({}) })
  } }, { host })
  const api = { storage, plugin: { request: (name: string, input: any) => worker.request(name, input) } } as unknown as ConstructorParameters<typeof OrgCanvas>[0]
  try {
    const model = new OrgCanvas(api); await model.load()
    assert.equal(model.projects.length, 1)
    assert.equal(model.projects[0].mainAgent, 'claude')
    assert.equal(model.graph('projects').nodes.some(n => n.id.includes('p2')), false)
    assert.ok(model.graph('projects').nodes.find(n => n.id === 'project:p1')!.detail.includes('Claude'))
    assert.ok(model.graph('links').edges[0].lines[1].includes('未知'))
    await model.share('peer', { scope: 'details', projectIds: ['p1'], acceptTasks: 'confirm' }, model.links.revision)
    await assert.rejects(() => model.share('peer', { scope: 'none', projectIds: [], acceptTasks: 'deny' }, 0))
    const savedLinks = await worker.request('workspace.links', { operation: 'read' })
    assert.equal(savedLinks.peers[0].acceptTasks, 'confirm'); assert.equal(savedLinks.peers[0].scope, 'details')
    assert.deepEqual(savedLinks.peers[0].projectIds, ['p1'])
    const project = await model.project('p1')
    await model.saveRoles(project, { design: 'codex', code: 'claude', review: 'codex' })
    const saved = (await worker.request('project.read', { projectId: 'p1' })).project!
    assert.deepEqual(saved.roles, { design: 'codex', code: 'claude', review: 'codex' })
    assert.deepEqual(saved.feishu, p.feishu); assert.deepEqual(saved.tasks, p.tasks)
    assert.equal('mainAgent' in saved, false)
    await assert.rejects(() => model.saveRoles(project, project.roles))
    await assert.rejects(() => model.project('p2'))
    await Promise.all([model.savePosition('links', 'own', { x: 55, y: 100 }), model.savePosition('projects', 'project:p1', { x: 500, y: 60 })])
    const reopened = new OrgCanvas(api); await reopened.load()
    assert.equal(reopened.graph('links').nodes[0].x, 55)
    assert.equal(reopened.graph('projects').nodes.find(n => n.id === 'project:p1')!.x, 500)
    kind = undefined
    const legacy = await worker.request('project.read', { projectId: 'p1' })
    assert.equal('mainAgent' in legacy, false)
    assert.deepEqual(legacy, JSON.parse(JSON.stringify(legacy)))
    await reopened.load()
    assert.ok(reopened.graph('projects').nodes.find(n => n.id === 'project:p1')!.detail.includes('种类未知'))
    assert.deepEqual(await storage.get(layoutKey), { version: 1, positions: { 'links:own': { x: 55, y: 100 }, 'projects:project:p1': { x: 500, y: 60 } } })
    assert.deepEqual(host.data().storage['project:p2'], hidden)
    assert.deepEqual(host.data().storage.workspace, binding)
    assert.deepEqual(worker.refusals, [])
  } finally { c.stop(); await worker.deactivate() }
})

test('keyboard activation and movement, layout validation and persistence failure', async () => {
  assert.equal(activateKey('Enter'), true); assert.equal(activateKey(' '), true); assert.equal(activateKey('Tab'), false)
  assert.deepEqual(moved({ x: 10, y: 20 }, 'ArrowLeft'), { x: 0, y: 20 })
  assert.deepEqual(moved({ x: 10, y: 20 }, 'ArrowDown'), { x: 10, y: 40 })
  assert.equal(moved({ x: 0, y: 0 }, 'Escape'), undefined)
  assert.deepEqual(layout(null), { version: 1, positions: {} })
  for (const invalid of [{ version: 2, positions: {} }, { version: 1, positions: { n: { x: Infinity, y: 0 } } }, { version: 1, positions: [] }]) assert.throws(() => layout(invalid))
  let fail = true, raw: any = null
  const api = { storage: { get: async () => raw, set: async (_: string, value: any) => { if (fail) throw Error('磁盘写入失败'); raw = value } } } as unknown as ConstructorParameters<typeof OrgCanvas>[0]
  const model = new OrgCanvas(api)
  await assert.rejects(() => model.savePosition('links', 'own', { x: 10, y: 10 }))
  fail = false; await model.savePosition('links', 'own', { x: 20, y: 20 })
  assert.equal(raw.positions['links:own'].x, 20)
})
