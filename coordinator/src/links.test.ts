import { assert, test, mockHost, mountWorker } from 'orca/testing'
import { hostname } from 'node:os'
import type { OrcaWorkerApi } from 'orca/worker'
import { WorkspaceLinks, defaultWorkspaceName, endpoint, invitationHost, report } from './links'
import { refs, sample } from './fixtures'
import { fresh } from './store'
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
  const a = await instance('A', false, () => '::1'), b = await instance('B', false)
  const restarted = a.create()
  try {
    const initial = await a.links.snapshot()
    assert.equal(initial.name, defaultWorkspaceName(hostname()))
    assert.equal(defaultWorkspaceName('Studio-Mac-mini.local'), 'Studio-Mac-mini')
    assert.equal(defaultWorkspaceName(''), '我的工作间')
    assert.equal(initial.enabled, false)
    assert.equal(a.storage.has('workspace.links'), false)
    const s = await a.links.invite()
    assert.equal(s.host, '::1')
    assert.ok(s.port > 0)
    assert.equal(s.publicUrl, `http://[::1]:${s.port}`)
    assert.equal(s.listening, s.publicUrl)
    a.links.stop()
    await restarted.start()
    const next = await restarted.invite()
    assert.equal(next.port, s.port)
    assert.equal(next.listening, s.listening)
    const joined = await b.links.join(next.invitation!.code)
    assert.equal(joined.peers[0].status, 'connected')
    assert.equal(joined.enabled, false)
    assert.equal(joined.peers[0].endpoint, s.publicUrl)
    assert.equal(joined.peers[0].scope, 'none')
    assert.equal(joined.peers[0].acceptTasks, 'deny')
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
    const shared = await b.links.share({ revision: related.revision, id: p.id, scope: 'summary', projectIds: ['p1'], acceptTasks: 'confirm' })
    assert.equal(shared.peers[0].sharingSet, true)
    const changed = await b.links.relate({ revision: shared.revision, id: p.id, relation: 'below' })
    assert.equal(changed.peers[0].scope, 'summary'); assert.equal(changed.peers[0].acceptTasks, 'confirm')
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
      return a.links.share({ id, revision: previous.revision, scope: 'summary', acceptTasks: 'confirm', ...settings })
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
      await a.links.share({ id: peer.id, revision: s.revision, scope, projectIds, acceptTasks: 'confirm' })
      return (await b.links.refresh()).peers[0].report!
    }
    let r = await setA('summary')
    assert.equal(r.acceptTasks, 'confirm')
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
    await b.links.share({ id: bc.id, revision: bs.revision, scope: 'details', projectIds: ['p1'], acceptTasks: 'auto' })
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
    await a.links.revoke(peer.id)
    assert.equal(await post(address, '/sync', { id: peer.id }, token), 401)
    assert.equal(a.secrets.has(`workspace-link:${peer.id}`), false)
    await b.links.revoke(bc.id)
    assert.equal((await c.links.snapshot()).peers[0].state, 'revoked')
    assert.equal((await c.links.snapshot()).peers[0].report, undefined)
  } finally { a.links.stop(); b.links.stop(); c.links.stop() }
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
    await assert.rejects(() => a.links.share({ id: p.id, revision: as.revision, scope: 'details', projectIds: ['external-project'], acceptTasks: 'auto' }))
    const token = a.secrets.get(`workspace-link:${p.id}`)!
    const malformed = report([], p, p.workspaceId, 'B')
    const missing = { ...malformed } as any; delete missing.acceptTasks
    assert.equal(await post(s.listening, '/sync', { id: p.id, report: missing }, token), 400)
    assert.equal(await post(s.listening, '/sync', { id: p.id, report: { ...malformed, acceptTasks: 'invalid' } }, token), 400)
    assert.equal(await post(s.listening, '/sync', { id: p.id, report: { ...malformed, workspaceId: 'wrong' } }, token), 400)
    assert.equal(await post(s.listening, '/sync', { id: p.id, report: { ...malformed, scope: 'none', projects: [{ secret: 'ignored' }] } }, token), 400)
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
