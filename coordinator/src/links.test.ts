import { assert, test, mockHost, mountWorker } from 'orca/testing'
import { hostname } from 'node:os'
import type { OrcaWorkerApi } from 'orca/worker'
import { WorkspaceLinks, defaultWorkspaceName, endpoint, invitationHost, report } from './links'
import { refs, sample } from './fixtures'
import { fresh } from './store'
import type { LiveAgent } from './model'
import { testCoordinator as createCoordinator } from './test-runtime'

async function instance(name: string, configured = true, chooseHost = () => '127.0.0.1') {
  const storage = new Map<string, any>(), secrets = new Map<string, string>()
  const api = { storage: { get: async (k: string) => structuredClone(storage.get(k) ?? null), set: async (k: string, v: any) => { storage.set(k, structuredClone(v)) } },
    secrets: { get: async (k: string) => secrets.get(k) ?? null, set: async (k: string, v: string) => { secrets.set(k, v) }, delete: async (k: string) => { secrets.delete(k) } } }
  const projects = structuredClone([sample().project!, fresh(refs[1])])
  projects[0].ref.name = name + ' private project'
  const create = () => new WorkspaceLinks(api as OrcaWorkerApi, async () => projects, () => {}, chooseHost)
  const links = create()
  if (configured) {
    const initial = await links.snapshot()
    await links.configure({ revision: initial.revision, name, enabled: true, host: '127.0.0.1', port: 0, publicUrl: '', tls: false })
  }
  return { links, storage, secrets, projects, create }
}
async function post(url: string, route: string, body: any, token = '') {
  const r = await fetch(url + route, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(body) })
  await r.text(); return r.status
}

test('HTTP addresses and automatic interface choice use the same Tailscale boundaries', () => {
  for (const host of ['127.0.0.1', '[::1]', 'localhost', '100.64.0.0', '100.127.255.255', '[fd7a:115c:a1e0::1]', '[FD7A:115C:A1E0:FFFF:FFFF:FFFF:FFFF:FFFF]', 'host.example.ts.net']) {
    assert.equal(endpoint(`http://${host}:8765`), new URL(`http://${host}:8765`).origin)
  }
  for (const host of ['100.63.255.255', '100.128.0.0', '[fd7a:115c:a1df::1]', '[fd7a:115c:a1e1::1]', '192.168.0.2', '203.0.113.1', 'ts.net', 'host.ts.net.example', 'notts.net']) {
    assert.throws(() => endpoint(`http://${host}:8765`))
    assert.equal(endpoint(`https://${host}:8765`), `https://${host}:8765`)
  }
  const v4 = (address: string) => ({ address, family: 'IPv4' as const, internal: false, netmask: '', mac: '', cidr: null })
  const v6 = { ...v4('fd7a:115c:a1e0::a'), family: 'IPv6' as const, scopeid: 0 }
  const regular = { ethernet: ['100.63.255.255', '100.128.0.0', '192.168.0.2'].map(v4) }
  assert.equal(invitationHost(regular), '127.0.0.1')
  assert.equal(invitationHost({ ...regular, vpn: [v6] }), v6.address)
  assert.equal(invitationHost({ ...regular, vpn: [v6, v4('100.64.0.1')] }), '100.64.0.1')
})

test('one-click invite binds the selected address and keeps the assigned port after restart; joining needs only the code', async () => {
  let chosen = 0
  const a = await instance('A', false, () => { chosen++; return '127.0.0.1' }), b = await instance('B', false)
  const restarted = a.create()
  try {
    const initial = await a.links.snapshot()
    assert.equal(initial.name, defaultWorkspaceName(hostname()))
    assert.equal(defaultWorkspaceName('Studio-Mac-mini.local'), 'Studio-Mac-mini')
    assert.equal(defaultWorkspaceName(''), '我的工作间')
    assert.equal(initial.enabled, false)
    assert.equal(a.storage.has('workspace.links'), false)
    const s = await a.links.invite()
    assert.equal(s.host, '127.0.0.1')
    assert.ok(s.port > 0)
    assert.equal(s.publicUrl, `http://127.0.0.1:${s.port}`)
    assert.equal(s.listening, s.publicUrl)
    a.links.stop()
    await restarted.start()
    const next = await restarted.invite()
    assert.equal(chosen, 1)
    assert.equal(next.port, s.port)
    assert.equal(next.listening, s.listening)
    const joined = await b.links.join(next.invitation!.code)
    assert.equal(joined.peers[0].status, 'connected')
    assert.equal(joined.enabled, false)
    assert.equal(joined.peers[0].endpoint, s.publicUrl)
    assert.equal(joined.peers[0].scope, 'none')
    assert.equal(Buffer.from(b.secrets.get(`workspace-link:${joined.peers[0].id}`)!, 'base64url').length, 32)
  } finally { a.links.stop(); b.links.stop(); restarted.stop() }
})

test('relations remain local, saved sharing is sticky, offline time survives a new instance', async () => {
  const a = await instance('relation A'), b = await instance('relation B')
  try {
    const s = await b.links.join((await a.links.invite()).invitation!.code), p = s.peers[0]
    assert.equal((await b.links.relate({ revision: s.revision, id: p.id, relation: null })).revision, s.revision)
    const related = await b.links.relate({ revision: s.revision, id: p.id, relation: 'above' })
    assert.equal(related.peers[0].relation, 'above'); assert.equal(related.peers[0].scope, 'none')
    assert.equal((await a.links.snapshot()).peers[0].relation, undefined)
    const legacy = b.storage.get('workspace.links').peers[0]
    legacy.acceptTasks = 'auto'
    assert.equal('acceptTasks' in (await b.links.snapshot()).peers[0], false)
    const shared = await b.links.share({ revision: related.revision, id: p.id, scope: 'summary', projectIds: ['p1'] })
    assert.equal(shared.peers[0].sharingSet, true)
    const changed = await b.links.relate({ revision: shared.revision, id: p.id, relation: 'below' })
    assert.equal(changed.peers[0].scope, 'summary')
    const wire = report(b.projects, changed.peers[0], 'test', 'test')
    assert.equal('relation' in wire, false); assert.equal('sharingSet' in wire, false)
    a.links.stop(); const offline = await b.links.refresh()
    assert.equal(offline.peers[0].status, 'offline'); assert.ok(offline.peers[0].lastSyncAt)
    const api = { storage: { get: async (k: string) => b.storage.get(k), set: async (k: string, v: any) => { b.storage.set(k, v) } }, secrets: { get: async () => null } }
    const restarted = new WorkspaceLinks(api as any, async () => b.projects, () => {})
    assert.equal((await restarted.snapshot()).peers[0].lastSyncAt, offline.peers[0].lastSyncAt)
    await assert.rejects(() => b.links.relate({ revision: changed.revision, id: p.id, relation: 'invalid' }))
  } finally { a.links.stop(); b.links.stop() }
})

test('all projects uses the current visible projects and preserves the legacy selection when switched off', async () => {
  const a = await instance('A'), b = await instance('B')
  try {
    const joined = await b.links.join((await a.links.invite()).invitation!.code), id = joined.peers[0].id
    const share = async (settings: { allProjects?: unknown; projectIds?: string[]; scope?: string }) => {
      const previous = await a.links.snapshot()
      return a.links.share({ id, revision: previous.revision, scope: 'summary', ...settings })
    }
    const reported = async () => (await b.links.refresh()).peers[0].report!.projects.map(p => p.id)
    await share({ projectIds: ['p1'] })
    delete a.storage.get('workspace.links').peers[0].allProjects
    assert.equal((await a.links.snapshot()).peers[0].allProjects, false)
    assert.deepEqual(await reported(), ['p1'])
    await assert.rejects(() => share({ allProjects: 'true' }), /全部项目设置不正确/)
    const all = await share({ allProjects: true })
    assert.deepEqual(all.peers[0].projectIds, ['p1'])
    assert.deepEqual(await reported(), ['p1', 'p2'])
    a.projects[1].hidden = true
    a.projects.push(fresh({ ...refs[1], id: 'added', name: '新项目' }))
    assert.deepEqual(await reported(), ['p1', 'added'])
    await share({ allProjects: true, scope: 'none' })
    assert.deepEqual(await reported(), [])
    await share({ allProjects: false })
    assert.deepEqual(await reported(), ['p1'])
  } finally { a.links.stop(); b.links.stop() }
})

test('renaming preserves the listener and the next sync persists new names in both directions', async () => {
  const a = await instance('A'), b = await instance('B')
  try {
    const invite = await a.links.invite(), before = structuredClone(a.storage.get('workspace.links'))
    const renamed = await a.links.rename({ revision: invite.revision, name: ' A renamed ', host: 'invalid', port: -1, tls: true })
    assert.equal(renamed.listening, invite.listening)
    assert.deepEqual(a.storage.get('workspace.links'), { ...before, revision: before.revision + 1, name: 'A renamed' })
    // The existing invitation still works and initially advertises A's old name.
    const joined = await b.links.join(invite.invitation!.code)
    assert.equal(joined.peers[0].name, 'A renamed')
    const next = await a.links.rename({ revision: (await a.links.snapshot()).revision, name: 'A again' })
    await b.links.rename({ revision: joined.revision, name: 'B renamed' })
    assert.equal((await a.links.snapshot()).peers[0].name, 'B')
    assert.equal((await b.links.snapshot()).peers[0].name, 'A renamed')
    assert.equal((await b.links.refresh()).peers[0].name, next.name)
    assert.equal((await a.links.snapshot()).peers[0].name, 'B renamed')
    assert.equal((await a.create().snapshot()).peers[0].name, 'B renamed')
    assert.equal((await b.create().snapshot()).peers[0].name, 'A again')
  } finally { a.links.stop(); b.links.stop() }
})

test('two loopback workspaces pair once, share only selected local projects, change scopes, reject credentials, revoke immediately', async () => {
  const a = await instance('A'), b = await instance('B'), c = await instance('C')
  try {
    const invitation = await a.links.invite(), code = invitation.invitation!.code
    const joined = await b.links.join(code), peer = joined.peers[0]
    assert.equal(peer.status, 'connected')
    assert.equal((await a.links.snapshot()).peers.length, 1)
    assert.deepEqual(peer.report!.projects, [])
    const token = b.secrets.get(`workspace-link:${peer.id}`)!
    assert.ok(token)
    assert.equal(JSON.stringify([...a.storage, ...b.storage]).includes(token), false)
    const decoded = JSON.parse(Buffer.from(code.slice(4), 'base64url').toString())
    assert.equal(JSON.stringify([...a.storage, ...b.storage]).includes(decoded.token), false)
    assert.equal(await post(invitation.listening, '/pair', { invite: decoded.token }), 401)
    const setA = async (scope: string, projectIds = ['p1']) => {
      const s = await a.links.snapshot()
      await a.links.share({ id: peer.id, revision: s.revision, scope, projectIds })
      return (await b.links.refresh()).peers[0].report!
    }
    let r = await setA('summary')
    assert.equal('acceptTasks' in r, false)
    assert.deepEqual(r.projects.map(p => p.id), ['p1'])
    assert.equal(r.projects[0].tasks, undefined)
    assert.equal(r.projects[0].pending, 2)
    assert.equal(JSON.stringify(r).includes('D:\\'), false)
    r = await setA('details')
    assert.equal(r.projects[0].tasks![0].acceptance[0], '首页布局')
    assert.equal(r.projects[0].tasks![1].decisions[0], '首页采用哪种风格？')
    assert.equal((await setA('summary', ['p2'])).projects[0].id, 'p2')
    assert.deepEqual((await setA('none')).projects, [])
    await setA('details')
    // B sees A, then connects to C and opens only B's project. A's report never enters B's own projection.
    await b.links.join((await c.links.invite()).invitation!.code)
    let bs = await b.links.snapshot()
    const bc = bs.peers.find(p => p.workspaceId !== invitation.workspaceId)!
    await b.links.share({ id: bc.id, revision: bs.revision, scope: 'details', projectIds: ['p1'] })
    const thirdParty = (await c.links.snapshot()).peers[0].report!
    assert.equal(thirdParty.projects[0].name, 'B private project')
    assert.equal(JSON.stringify(thirdParty).includes('A private project'), false)
    assert.equal(await post(invitation.listening, '/sync', { id: peer.id }, 'incorrect'), 401)
    assert.equal(await post(invitation.listening, '/dispatch', {}), 404)
    const beforeRestart = [...a.storage]
    a.links.stop(); await a.links.start()
    assert.deepEqual([...a.storage], beforeRestart)
    const address = (await a.links.snapshot()).listening
    assert.equal(address, invitation.listening)
    const otherConnection = structuredClone(b.storage.get('workspace.links').peers.find((p: { id: string }) => p.id === bc.id))
    assert.deepEqual((await a.links.revoke(peer.id)).peers, [])
    assert.deepEqual(a.storage.get('workspace.links').peers, [])
    assert.equal(await post(address, '/sync', { id: peer.id }, token), 401)
    assert.equal(a.secrets.has(`workspace-link:${peer.id}`), false)
    assert.deepEqual((await b.links.refresh()).peers.map(p => p.id), [bc.id])
    assert.deepEqual(b.storage.get('workspace.links').peers, [otherConnection])
    assert.equal(b.secrets.has(`workspace-link:${peer.id}`), false)

    assert.deepEqual((await b.links.revoke(bc.id)).peers, [])
    assert.deepEqual((await c.links.snapshot()).peers, [])
    assert.deepEqual(c.storage.get('workspace.links').peers, [])
    assert.equal(b.secrets.has(`workspace-link:${bc.id}`), false)
    assert.equal(c.secrets.has(`workspace-link:${bc.id}`), false)

    const rejoined = (await b.links.join((await a.links.invite()).invitation!.code)).peers
    assert.equal(rejoined.length, 1)
    assert.notEqual(rejoined[0].id, peer.id)
    assert.equal(rejoined[0].status, 'connected')
    assert.equal((await a.links.snapshot()).peers[0].id, rejoined[0].id)
    assert.equal(await post(address, '/sync', { id: rejoined[0].id }, token), 401)
  } finally { a.links.stop(); b.links.stop(); c.links.stop() }
})

test('legacy revoked links disappear on read and the next save keeps only existing connections', async () => {
  const a = await instance('A'), b = await instance('B')
  try {
    await b.links.join((await a.links.invite()).invitation!.code)
    const raw = a.storage.get('workspace.links'), active = structuredClone(raw.peers[0])
    raw.peers.unshift({ ...active, id: 'legacy-link', workspaceId: 'legacy-peer', state: 'revoked' })
    const before = structuredClone(raw)
    const snapshot = await a.links.snapshot()
    assert.deepEqual(snapshot.peers.map(p => p.id), [active.id])
    assert.deepEqual(a.storage.get('workspace.links'), before)
    await a.links.rename({ revision: snapshot.revision, name: 'A renamed' })
    assert.deepEqual(a.storage.get('workspace.links').peers, [active])
  } finally { a.links.stop(); b.links.stop() }
})

test('details sync shares current main and scoped live agents without local identifiers', async () => {
  const b = await instance('B'), p = sample().project!, hidden = { ...fresh({ ...refs[1], id: 'hidden' }), hidden: true }
  const session = { handle: 'private-handle', title: '统筹会话', workspace: 'private-workspace', workspaceName: 'private-machine', path: '/private/path', agent: 'claude', online: 'online' as const }
  const workspace = { version: 1, revision: 1, runId: 'private-run', requests: [], session }
  const host = mockHost({ storage: { 'project:p1': p as any, 'project:hidden': hidden as any, workspace } })
  const now = Date.now()
  const visible: LiveAgent = { id: 'private-terminal', projectId: 'p1', agent: 'codex', role: 'worker', state: 'work', rawState: 'working', title: '正在检查', taskId: p.tasks[0].id, since: now }
  let live = [visible, { ...visible, id: 'unselected', projectId: 'p2', title: '未选项目 agent' },
    { ...visible, id: 'hidden', projectId: 'hidden', title: '隐藏项目 agent' },
    { ...visible, id: 'old', state: 'done' as const, title: '过期 agent', since: now - 86_400_001 }]
  let reads = 0, online = true, coordinator!: ReturnType<typeof createCoordinator>
  const worker = await mountWorker({ default: api => { coordinator = createCoordinator(api, {
    projects: async () => refs,
    targets: async () => ({ workspaces: [], sessions: online ? [session] : [] }),
    agents: async () => { reads++; return { ok: true, at: Date.now(), agents: live } }
  }) } }, { host })
  try {
    const before = await coordinator.links.snapshot()
    await coordinator.links.configure({ ...before, name: 'A', host: '127.0.0.1', enabled: true })
    const invitation = await coordinator.links.invite(), joined = await b.links.join(invitation.invitation!.code), id = joined.peers[0].id
    const share = async (scope: string, projectIds: string[]) => {
      await coordinator.links.share({ id, revision: (await coordinator.links.snapshot()).revision, scope, projectIds })
      return (await b.links.refresh()).peers[0].report!
    }
    const summary = await share('summary', ['p1', 'hidden'])
    assert.equal('mainAgent' in summary, false)
    assert.equal('activity' in summary.projects[0], false)
    assert.equal(reads, 0)

    const details = await share('details', ['p1', 'hidden'])
    assert.deepEqual(details.mainAgent, { agent: 'claude', title: '统筹会话', online: 'online' })
    assert.deepEqual(details.projects.map(p => p.id), ['p1'])
    assert.deepEqual(details.projects[0].activity, { truncated: false, agents: [
      { agent: 'codex', role: 'worker', state: 'work', title: '正在检查', taskTitle: p.tasks[0].title, since: now }
    ] })
    assert.equal(/handle|runId|rawState|taskId|private-|[A-Z]:\\\\|未选项目|隐藏项目|过期 agent/.test(JSON.stringify(details)), false)

    online = false
    live = [{ ...visible, state: 'need', rawState: 'waiting', title: '等你回复' }, ...Array.from({ length: 25 }, (_, i) => ({ ...visible, id: 'copy-' + i }))]
    await worker.emit('agent.status.changed', { workspaceId: 'fake', paneKey: 'fake', state: 'waiting', receivedAt: Date.now() })
    const updated = (await b.links.refresh()).peers[0].report!
    assert.equal(updated.mainAgent?.online, 'offline')
    assert.equal(updated.projects[0].activity?.agents.length, 20)
    assert.equal(updated.projects[0].activity?.agents[0].title, '等你回复')
    assert.equal(updated.projects[0].activity?.truncated, true)

    live = [{ ...visible, title: '保存项目后更新' }]
    await worker.request('project.settings', { projectId: p.ref.id, revision: p.revision, roles: p.roles })
    assert.equal((await b.links.refresh()).peers[0].report?.projects[0].activity?.agents[0].title, '保存项目后更新')
  } finally { coordinator.stop(); b.links.stop(); await worker.deactivate() }
})

test('invites expire/cancel, malformed and oversized requests fail closed, explicit binding and scope validation', async () => {
  const a = await instance('A'), b = await instance('B')
  try {
    assert.throws(() => endpoint('http://192.0.2.1:1000'))
    assert.throws(() => endpoint('https://user:secret@example.com'))
    assert.throws(() => endpoint('https://example.com/path'))
    const s = await a.links.snapshot()
    await assert.rejects(() => a.links.configure({ ...s, host: '0.0.0.0' }))
    await assert.rejects(() => a.links.configure({ ...s, host: '0:0:0:0:0:0:0:0' }))
    await assert.rejects(() => a.links.configure({ ...s, host: '192.0.2.1', tls: false }))
    await assert.rejects(() => a.links.configure({ ...s, revision: s.revision + 1 }))
    const invitation = await a.links.invite(), decoded = JSON.parse(Buffer.from(invitation.invitation!.code.slice(4), 'base64url').toString())
    const now = Date.now
    Date.now = () => now() + 120_001
    try { assert.equal(await post(s.listening, '/pair', { invite: decoded.token }), 401) } finally { Date.now = now }
    const cancelled = await a.links.invite(), decodedCancelled = JSON.parse(Buffer.from(cancelled.invitation!.code.slice(4), 'base64url').toString())
    await a.links.cancelInvite()
    assert.equal(await post(s.listening, '/pair', { invite: decodedCancelled.token }), 401)
    assert.equal(await post(s.listening, '/pair', { junk: 'x'.repeat(181000) }), 400)
    await b.links.join((await a.links.invite()).invitation!.code)
    const as = await a.links.snapshot(), p = as.peers[0]
    await assert.rejects(() => a.links.share({ id: p.id, revision: as.revision, scope: 'details', projectIds: ['external-project'] }))
    const token = a.secrets.get(`workspace-link:${p.id}`)!
    const malformed = report([], p, p.workspaceId, 'B')
    const exchange = { messages: [], received: [] }
    assert.equal(await post(s.listening, '/sync', { id: p.id, report: malformed, exchange }, token), 200)
    assert.equal(await post(s.listening, '/sync', { id: p.id, report: malformed, exchange: { messages: 'invalid', received: [] } }, token), 400)
    assert.equal(await post(s.listening, '/sync', { id: p.id, report: { ...malformed, workspaceId: 'wrong' }, exchange }, token), 400)
    assert.equal(await post(s.listening, '/sync', { id: p.id, report: { ...malformed, scope: 'none', projects: [{ secret: 'ignored' }] }, exchange }, token), 400)
    const valid = report(b.projects, { scope: 'details', allProjects: false, projectIds: ['p1'] }, p.workspaceId, 'B')
    const agent = { agent: 'codex', role: 'session', state: 'work', since: Date.now(), title: '检查' }
    const project = { ...valid.projects[0], activity: { truncated: false, agents: [agent] } }
    const packet = { ...valid, projects: [project] }
    assert.equal(await post(s.listening, '/sync', { id: p.id, report: packet, exchange }, token), 200)
    const accepted = (await a.links.snapshot()).peers[0].report
    for (const changed of [
      { ...packet, mainAgent: undefined }, { ...packet, mainAgent: { agent: [], title: '统筹', online: 'online' } },
      { ...packet, mainAgent: { agent: 'claude', title: '统筹', online: 'somewhere' } },
      { ...packet, projects: [{ ...project, activity: undefined }] },
      ...[{ agent: 'invented' }, { role: 'owner' }, { state: 'online' }, { since: String(agent.since) }, { title: '甲'.repeat(201) }, { taskTitle: [{}] }]
        .map(change => ({ ...packet, projects: [{ ...project, activity: { truncated: false, agents: [{ ...agent, ...change }] } }] })),
      { ...packet, projects: [{ ...project, activity: { truncated: true, agents: Array(21).fill(agent) } }] },
      { ...packet, projects: Array.from({ length: 6 }, (_, i) => ({ ...project, id: 'p' + i, activity: { truncated: false, agents: Array(20).fill(agent) } })) },
      { ...packet, scope: 'summary' }
    ]) assert.equal(await post(s.listening, '/sync', { id: p.id, report: changed, exchange }, token), 400)
    assert.deepEqual((await a.links.snapshot()).peers[0].report, accepted)
  } finally { a.links.stop(); b.links.stop() }
})

test('plugin request/overview integration preserves all legacy project and workspace records', async () => {
  const project = sample().project!, storage = { 'project:p1': project as any, workspace: { version: 1, revision: 2, runId: 'run_main', requests: [] } }
  const host = mockHost({ storage })
  let coordinator!: ReturnType<typeof createCoordinator>
  const worker = await mountWorker({ default: (orca: OrcaWorkerApi) => { coordinator = createCoordinator(orca, { projects: async () => refs, verifyRun: async () => {}, send: async () => ({}) }) } }, { host })
  try {
    const s = await worker.request('workspace.links', { operation: 'read' })
    assert.equal(s.enabled, false)
    assert.equal(s.host, '127.0.0.1')
    const named = await worker.request('workspace.links', { operation: 'rename', revision: s.revision, name: '本机名称' })
    assert.equal(named.name, '本机名称')
    const all = await worker.request('workspace.overview')
    assert.equal(all.links!.workspaceId, s.workspaceId)
    assert.deepEqual(host.data().storage['project:p1'], storage['project:p1'])
    assert.deepEqual(host.data().storage.workspace, storage.workspace)
    assert.deepEqual(worker.refusals, [])
  } finally { coordinator.stop(); await worker.deactivate() }
})

test('refresh does not broadcast changes when there is no outbound peer to sync', async () => {
  let changed = 0
  const api = { storage: { get: async (key: string) => key !== 'workspace.links' ? null : ({ version: 1, revision: 0, workspaceId: 'own', name: 'own', enabled: false, host: '127.0.0.1', port: 0, publicUrl: '', tls: false, peers: [] }) } }
  const links = new WorkspaceLinks(api as unknown as OrcaWorkerApi, async () => [], () => { changed++ })
  await links.refresh(); assert.equal(changed, 0); links.stop()
})
