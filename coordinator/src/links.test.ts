import { assert, test, mockHost, mountWorker } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { WorkspaceLinks, endpoint, report } from './links'
import { refs, sample } from './fixtures'
import { fresh } from './store'
import { testCoordinator as createCoordinator } from './test-runtime'

async function instance(name: string) {
  const storage = new Map<string, any>(), secrets = new Map<string, string>()
  const api = { storage: { get: async (k: string) => structuredClone(storage.get(k) ?? null), set: async (k: string, v: any) => { storage.set(k, structuredClone(v)) } },
    secrets: { get: async (k: string) => secrets.get(k) ?? null, set: async (k: string, v: string) => { secrets.set(k, v) }, delete: async (k: string) => { secrets.delete(k) } } }
  const projects = structuredClone([sample().project!, fresh(refs[1])])
  projects[0].ref.name = name + ' private project'
  const links = new WorkspaceLinks(api as OrcaWorkerApi, async () => projects, () => {})
  const initial = await links.snapshot()
  await links.configure({ revision: initial.revision, name, enabled: true, host: '127.0.0.1', port: 0, publicUrl: '', tls: false })
  return { links, storage, secrets, projects }
}
async function post(url: string, route: string, body: any, token = '') {
  const r = await fetch(url + route, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  await r.text(); return r.status
}

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
    // Listener port 0 may change after restart: use the new listening address for authorization checks.
    const address = (await a.links.snapshot()).listening
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
