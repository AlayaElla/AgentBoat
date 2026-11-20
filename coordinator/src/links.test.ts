import { assert, test, mockHost, mountWorker } from 'orca/testing'
import path from 'node:path'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtemp, mkdir, rm, writeFile, truncate, symlink } from 'node:fs/promises'
import { artifactChunkBytes, fileChunkBytes, maxLinkFileBytes } from './link-files'
import type { OrcaWorkerApi } from 'orca/worker'
import type { ArtifactProgress } from './link-artifacts'
import { WorkspaceLinks, endpoint, invitationHost, report } from './links'
import { refs, sample } from './fixtures'
import { fingerprint, fresh, type FeedbackItem } from './store'
import type { LiveAgent } from './model'
import { testCoordinator as createCoordinator, testFiles } from './test-runtime'

async function instance(name: string, configured = true, chooseHost = () => '127.0.0.1', files = testFiles()) {
  const storage = new Map<string, any>(), secrets = new Map<string, string>()
  const logs: string[] = [], progress: ArtifactProgress[] = []
  const api = { log: (line: string) => logs.push(line), panels: { post: (_: string, value: ArtifactProgress) => { progress.push(value) } },
    storage: { get: async (k: string) => structuredClone(storage.get(k) ?? null), set: async (k: string, v: any) => { storage.set(k, structuredClone(v)) } },
    secrets: { get: async (k: string) => secrets.get(k) ?? null, set: async (k: string, v: string) => { secrets.set(k, v) }, delete: async (k: string) => { secrets.delete(k) } } }
  const projects = structuredClone([sample().project!, fresh(refs[1])])
  projects[0].ref.name = name + ' private project'
  const create = () => new WorkspaceLinks(api as unknown as OrcaWorkerApi, async () => projects, () => {}, chooseHost, undefined, undefined, files)
  const links = create()
  if (configured) {
    const initial = await links.snapshot()
    await links.configure({ revision: initial.revision, name, enabled: true, host: '127.0.0.1', port: 0, publicUrl: '', tls: false })
  }
  return { links, storage, secrets, projects, create, logs, progress }
}
async function post(url: string, route: string, body: any, token = '') {
  const r = await fetch(url + route, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(body) })
  await r.text(); return r.status
}

test('delegated feedback applies once in both directions and rechecks sharing on every request', async () => {
  async function open(name: string) {
    const project = sample().project!
    project.tasks[0].artifacts.push({ id: 'local', label: '本机设计稿', version: 'v1', url: '/private/design.md' })
    project.tasks[0].acceptance[0].artifactIds.push('local')
    const hidden = { ...fresh({ ...refs[1], id: 'hidden' }), hidden: true }
    const host = mockHost({ storage: { 'project:p1': project as any, 'project:hidden': hidden as any,
      workspace: { version: 1, revision: 1, runId: `workspace-${name}`, requests: [] } } })
    const notices: [string, string][] = []
    let c!: ReturnType<typeof createCoordinator>
    const worker = await mountWorker({ default: api => { c = createCoordinator(api, { projects: async () => [...refs, hidden.ref],
      send: async (run, item) => { notices.push([run, item.body]); return {} } }) } }, { host })
    await c.links.rename({ revision: (await c.links.snapshot()).revision, name })
    await c.links.start()
    return { c, worker, notices, project }
  }
  const a = await open('甲工作间'), b = await open('乙工作间')
  const { project } = a, [review, decision] = project.tasks, check = review.acceptance[0], d = decision.decisions[0]
  const items: FeedbackItem[] = [{ taskId: review.id, kind: 'acceptance', itemId: check.id, itemRevision: check.revision, fingerprint: check.fingerprint, result: 'passed' },
    { taskId: decision.id, kind: 'decision', itemId: d.id, fingerprint: fingerprint([d.question, d.options]), answer: d.options[0] },
    { taskId: decision.id, kind: 'blocked', itemId: decision.id, itemRevision: decision.blockedRevision, note: '已经做好了' }]
  try {
    const invitation = await a.c.links.invite(), { id } = (await b.c.links.join(invitation.invitation!.code)).peers[0]
    const share = async (side: typeof a, delegateFeedback: boolean, scope = 'details', projectIds = ['p1', 'hidden']) =>
      side.c.links.share({ id, revision: (await side.c.links.snapshot()).revision, scope, projectIds, delegateFeedback })
    const request = { projectId: 'p1', revision: project.revision, requestId: 'one', items }
    const send = (side: typeof a, input = request) => side.worker.request('workspace.linkFeedback', { id, ...input })
    await share(a, false)
    assert.equal((await b.c.links.refresh()).peers[0].report?.projects[0].feedback, undefined)
    assert.match((await send(b)).reason!, /未允许/)
    await assert.rejects(() => share(a, true, 'summary'), /含任务详情/)
    await share(a, true)
    const outgoing = report([project], { scope: 'details', allProjects: true, projectIds: [], delegateFeedback: true }, 'local', '测试')
    assert.ok(!Object.hasOwn(outgoing.projects[0].feedback!.tasks[1], 'blockedStatus'))
    await b.c.links.refresh()
    const shared = (await b.worker.request('workspace.overview')).links!.peers[0].report!.projects
    assert.deepEqual(shared.map(p => p.id), ['p1'])
    assert.deepEqual(shared[0].feedback?.tasks[1].decisions[0].options, d.options)
    assert.equal(shared[0].feedback?.tasks[1].blockedRevision, decision.blockedRevision)
    assert.ok(!Object.hasOwn(shared[0].feedback!.tasks[1], 'blockedStatus'))
    assert.equal(shared[0].feedback?.tasks[1].progress, decision.goal)
    assert.equal(shared[0].feedback?.tasks[0].acceptance[0].fingerprint, check.fingerprint)
    assert.equal(shared[0].feedback?.tasks[0].acceptance[0].revision, check.revision)
    assert.deepEqual(shared[0].feedback?.tasks[0].artifacts.map(x => [x.label, x.url]), [['首页预览', 'https://example.com/preview'], ['本机设计稿', '']])
    assert.equal(shared[0].feedback?.tasks[0].artifacts[0].registeredAt, review.artifacts[0].registeredAt)
    a.c.links.stop()
    const offline = (await b.c.links.refresh()).peers[0]
    assert.equal(offline.status, 'offline')
    assert.equal(offline.offlineFeedback?.[0].feedback?.tasks.length, 2)
    await assert.rejects(() => send(b), /离线/)
    await a.c.links.start()
    await b.c.links.refresh()
    for (const projectId of ['hidden', 'p2']) assert.match((await send(b, { ...request, projectId })).reason!, /未开放或已隐藏/)
    assert.match((await send(b, { ...request, items: [items[0], { ...items[1], fingerprint: 'stale' }] })).reason!, /问题内容已更新/)
    assert.equal((await a.c.store.get('p1')).tasks[0].acceptance[0].status, 'pending')
    const mutate = a.c.store.mutate.bind(a.c.store)
    a.c.store.mutate = async (...args) => {
      const saved = await mutate(...args)
      a.c.store.mutate = mutate
      throw Error(`lost receipt for revision ${saved.revision}`)
    }
    assert.equal((await send(b)).state, 'uncertain')
    assert.equal((await a.c.store.get('p1')).tasks[0].acceptance[0].status, 'passed')
    const updated = (await b.c.links.refresh()).peers[0].report!.projects[0].feedback!.tasks[0]
    assert.equal(updated.blockedStatus, 'replied')
    const joinerStarted = performance.now()
    const receipt = await send(b)
    assert.deepEqual(receipt, { state:'submitted', requestId: request.requestId, fingerprint: fingerprint(request) })
    const joinerMs = performance.now() - joinerStarted
    assert.equal((await send(b)).state, 'submitted')
    await a.c.flush('p1')
    assert.equal((await a.c.store.get('p1')).tasks[0].acceptance[0].history.length, 1)
    assert.equal((await a.c.store.get('p1')).tasks[1].decisions[0].history[0].source, '主人在工作间 乙工作间 提交')
    const replies = (await a.c.store.get('p1')).events
    assert.deepEqual(replies.map(e => [e.text, e.taskId, e.senderId]), [['已经做好了', decision.id, '主人在工作间 乙工作间 提交']])
    assert.deepEqual(a.notices.map(([run]) => run).sort(), ['run_example', 'workspace-甲工作间'])
    assert.ok(a.notices.every(([, body]) => body.includes('主人在工作间 乙工作间 提交')))
    assert.ok(a.notices.find(([run]) => run === 'run_example')![1].endsWith('提醒：实现交给执行者，成果用 submit 登记待验收。'))
    assert.ok(!a.notices.find(([run]) => run === 'workspace-甲工作间')![1].includes('提醒：'))
    assert.ok((await a.c.store.get('p1')).deliveries.every(d => !d.body.includes('你是工作间管理员') && !d.body.includes('你是项目管理员')))

    // The inviter has no endpoint for the joiner; its request rides the existing long poll.
    await share(b, true)
    assert.equal((await a.c.links.snapshot()).peers[0].endpoint, '')
    const inviterStarted = performance.now()
    const discarded = items.map(({ answer, ...item }) => ({ ...item, result: 'discarded', note: '旧版' }))
    assert.equal((await a.worker.request('workspace.linkFeedback', { id, ...request, requestId: 'reverse', items: discarded })).state, 'submitted')
    console.log('T48 loopback feedback receipt ms', JSON.stringify({ joiner: +joinerMs.toFixed(1), inviter: +(performance.now() - inviterStarted).toFixed(1) }))
    const received = await b.c.store.get('p1')
    assert.equal(received.tasks[1].blockedStatus, 'discarded')
    assert.equal(received.tasks[0].acceptance[0].status, 'discarded')
    assert.equal(received.tasks[1].decisions[0].answer, null)
    assert.equal(received.tasks[1].decisions[0].history[0].source, '主人在工作间 甲工作间 提交')
    assert.equal((await send(a, { ...request, revision: received.revision, requestId: 'older-client' })).state, 'rejected')
    await share(a, false, 'summary')
    assert.match((await send(b)).reason!, /未允许/)
    await share(a, false)
    assert.match((await send(b)).reason!, /未允许/)
    await a.c.links.revoke(id)
    await b.c.links.refresh()
    await assert.rejects(() => send(b), /断开/)
  } finally { a.c.stop(); b.c.stop(); await a.worker.deactivate(); await b.worker.deactivate() }
})

test('peer artifacts use authenticated loopback in both directions, cache complete versions and recheck access', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'peer-artifact-'))
  const received = testFiles(), receive = received.receive.bind(received)
  let chunks = 0, afterChunk: (() => void) | undefined
  received.receive = async (...args) => {
    const result = await receive(...args)
    if (args[5]) { chunks++; afterChunk?.() }
    return result
  }
  const a = await instance('甲'), b = await instance('乙', true, undefined, received)
  await mkdir(path.join(root, 'project'))
  const bytes = Buffer.alloc(fileChunkBytes * 6 + 31, 122)
  const dir = path.join(root, 'project'), file = path.join(dir, 'drawing.md')
  const ref = { projectId: 'p1', taskId: 'task-1', artifactId: 'local' }
  const add = (side: typeof a) => {
    const p = side.projects[0], task = p.tasks[0]
    p.ref.path = dir
    const artifact = { id: 'local', label: '设计图', version: 'v1', url: file, expired: false }
    task.artifacts.push(artifact); task.acceptance[0].artifactIds.push('local')
    return artifact
  }
  const local = add(a); add(b)
  try {
    await writeFile(file, bytes)
    await a.links.start(); await b.links.start()
    const { id } = (await b.links.join((await a.links.invite()).invitation!.code)).peers[0]
    const share = async (s: typeof a, projectIds: string[]) => s.links.share({ revision: (await s.links.snapshot()).revision, id, scope: 'details', projectIds, delegateFeedback: true })
    await share(a, ['p1']); await share(b, ['p1'])
    const get = (s = b) => s.links.openArtifact(id, ref)
    const [first, concurrent] = await Promise.all([get(), get()])
    assert.deepEqual(first, concurrent)
    assert.deepEqual([first.name, first.type, first.size], ['drawing.md', 'text/markdown', bytes.length])
    const parts = []
    for (let offset = 0; offset < bytes.length;) {
      const part = Buffer.from(await b.links.readArtifact(id, first.key, offset), 'base64')
      assert.ok(part.length); parts.push(part); offset += part.length
    }
    assert.deepEqual(Buffer.concat(parts), bytes)
    const sent = Math.ceil(bytes.length / artifactChunkBytes)
    assert.equal(chunks, sent)
    assert.deepEqual(await get(), first)
    assert.equal(chunks, sent)
    local.version = 'v2'
    afterChunk = () => { local.expired = true }
    await assert.rejects(get, /过期/)
    afterChunk = undefined; local.expired = false
    const second = await get()
    assert.notEqual(second.key, first.key)
    assert.equal(chunks, sent * 2)
    await assert.rejects(() => b.links.readArtifact(id, '../drawing.md', 0), /未找到/)
    assert.equal((await get(a)).size, bytes.length)
    assert.equal((await b.links.snapshot(true)).peers[0].recentMessages?.length, 0)
    await assert.rejects(() => b.links.openArtifact(id, { ...ref, taskId: 'task-2' }), /没有登记/)
    local.expired = true; await assert.rejects(get, /过期/)
    local.expired = false; await share(a, []); await assert.rejects(get, /未开放/)
    await share(a, ['p1'])
    a.projects[0].hidden = true; await assert.rejects(get, /未开放/); a.projects[0].hidden = false
    const outside = path.join(root, 'elsewhere.txt')
    await writeFile(outside, 'test')
    local.url = path.join(dir, '..', 'elsewhere.txt'); await assert.rejects(get, /不属于/)
    local.url = dir; await assert.rejects(get, /普通文件/)
    const subdir = path.join(dir, 'folder')
    await mkdir(subdir); await writeFile(path.join(subdir, 'file'), 'test')
    await symlink(subdir, path.join(dir, 'alias'), 'junction')
    local.url = path.join(dir, 'alias', 'file'); await assert.rejects(get, /普通文件/)
    local.url = file; await truncate(file, maxLinkFileBytes + 1)
    await assert.rejects(get, /25 MB/)
    await rm(file); await assert.rejects(get, e => e instanceof Error && /不存在/.test(e.message) && !e.message.includes(dir))
    a.links.stop(); await b.links.refresh(); await assert.rejects(get, /离线/)
  } finally { a.links.stop(); b.links.stop(); await rm(root, { recursive: true, force: true }) }
})

test('3 MiB peer artifact over a single listener with the production watch and refresh timers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-speed-'))
  const a = await instance('listener'), b = await instance('dialer', false)
  const file = path.join(root, 'image.png'), bytes = Buffer.alloc(3 * 1024 ** 2, 73)
  try {
    await writeFile(file, bytes)
    for (const side of [a, b]) {
      const p = side.projects[0], t = p.tasks[0]
      p.ref.path = root
      t.artifacts.push({ id: 'drawing', label: '图', url: file, version: 'v1' })
      t.acceptance[0].artifactIds.push('drawing')
      await side.links.start()
    }
    const { id } = (await b.links.join((await a.links.invite()).invitation!.code)).peers[0]
    for (const side of [a, b]) await side.links.share({ id, revision: (await side.links.snapshot()).revision, scope: 'details', projectIds: ['p1'], delegateFeedback: true })
    assert.equal((await a.links.snapshot()).peers[0].endpoint, '')
    assert.equal((await b.links.snapshot()).enabled, false)
    // Count actual HTTP syncs, including ordinary traffic, with a controlled 30 ms round-trip cost.
    const client = b.links as any, sync = client.syncOne.bind(client)
    let rounds = 0
    client.syncOne = async (...args: unknown[]) => { rounds++; await delay(30); return sync(...args) }
    for (const side of [a, b]) {
      const started = performance.now(), initial = rounds
      const result = await side.links.openArtifact(id, { projectId: 'p1', taskId: 'task-1', artifactId: 'drawing' })
      const parts = []
      for (let offset = 0; offset < bytes.length;) {
        const part = Buffer.from(await side.links.readArtifact(id, result.key, offset), 'base64')
        assert.ok(part.length); parts.push(part); offset += part.length
      }
      const ms = Math.round(performance.now() - started)
      assert.deepEqual(Buffer.concat(parts), bytes)
      assert.ok(rounds - initial < 35, 'expected fewer than 35 syncs for a cold 3 MiB file')
      assert.ok(side.progress.some(p => p.received > 0 && p.received < bytes.length && p.size === bytes.length))
      console.log('T87 loopback 3 MiB', side === a ? 'from dialer' : 'from listener', { ms, syncs: rounds - initial })
    }
    await b.links.refresh() // Flush the final verification receipt before inspecting sender logs.
    for (const side of [a, b]) {
      assert.equal(side.logs.length, 4)
      assert.ok(side.logs.every(line => /^peer artifact (send|receive) (start|complete) id=[a-f0-9]{12} bytes=(unknown|3145728) ms=\d+$/.test(line)))
      for (const direction of ['send', 'receive']) assert.ok(side.logs.some(s => s.includes(direction + ' complete') && s.includes('bytes=3145728')))
    }

    // A message too large to share a frame with a bulk chunk and a feedback reply both pass mid-transfer.
    a.projects[0].tasks[0].artifacts.at(-1)!.version = 'v2'
    b.progress.length = 0
    let complete = false
    const transfer = b.links.openArtifact(id, { projectId: 'p1', taskId: 'task-1', artifactId: 'drawing' }).then(() => { complete = true })
    const until = async (condition: () => Promise<boolean> | boolean) => {
      const end = Date.now() + 5000
      while (!await condition()) { assert.ok(Date.now() < end, 'timed out waiting for concurrent traffic'); await delay(10) }
    }
    await until(() => b.progress.some(p => p.received > 0))
    await a.links.send({ id, requestId: 'during-transfer', text: '图'.repeat(15000) })
    const feedback = await b.links.submitFeedback(id, { projectId: 'p1', revision: 1, requestId: 'feedback-during-transfer', items: [] })
    assert.equal(feedback.state, 'rejected') // This fixture has no feedback handler.
    await until(async () => !!(await b.links.snapshot(true)).peers[0].recentMessages?.some(m => m.requestId === 'during-transfer'))
    assert.equal(complete, false)
    await transfer
  } finally { a.links.stop(); b.links.stop(); await rm(root, { recursive: true, force: true }) }
})

test('unexpected peer fields cannot enter panel snapshots or be rewritten', async () => {
  const { links, storage } = await instance('shape', false)
  const initial = await links.snapshot(), saved = { ...initial, peers: [{ id: 'peer', workspaceId: 'remote', name: 'remote', endpoint: '', state: 'active', scope: 'none', allProjects: false, projectIds: [], unrecognized: 'not a panel field' }] }
  storage.set('workspace.links', saved)
  await assert.rejects(() => links.snapshot(), /工作间连接记录/)
  assert.deepEqual(storage.get('workspace.links'), saved)
})

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
    assert.equal(initial.name, '我的工作间')
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
    const shared = await b.links.share({ revision: related.revision, id: p.id, scope: 'summary', projectIds: ['p1'] })
    assert.equal(shared.peers[0].sharingSet, true)
    const changed = await b.links.relate({ revision: shared.revision, id: p.id, relation: 'below' })
    assert.equal(changed.peers[0].scope, 'summary')
    const wire = report(b.projects, changed.peers[0], 'test', 'test')
    assert.equal('relation' in wire, false); assert.equal('sharingSet' in wire, false)
    a.links.stop(); const offline = await b.links.refresh()
    assert.equal(offline.peers[0].status, 'offline'); assert.ok(offline.peers[0].lastSyncAt)
    const api = { storage: { get: async (k: string) => b.storage.get(k), set: async (k: string, v: any) => { b.storage.set(k, v) } }, secrets: { get: async () => null } }
    const restarted = new WorkspaceLinks(api as any, async () => b.projects, () => {}, undefined, undefined, undefined, testFiles())
    assert.equal((await restarted.snapshot()).peers[0].lastSyncAt, offline.peers[0].lastSyncAt)
    await assert.rejects(() => b.links.relate({ revision: changed.revision, id: p.id, relation: 'invalid' }))
  } finally { a.links.stop(); b.links.stop() }
})

test('all projects uses the current visible projects and preserves the explicit selection when switched off', async () => {
  const a = await instance('A'), b = await instance('B')
  try {
    const joined = await b.links.join((await a.links.invite()).invitation!.code), id = joined.peers[0].id
    const share = async (settings: { allProjects?: unknown; projectIds?: string[]; scope?: string }) => {
      const previous = await a.links.snapshot()
      return a.links.share({ id, revision: previous.revision, scope: 'summary', ...settings })
    }
    const reported = async () => (await b.links.refresh()).peers[0].report!.projects.map(p => p.id)
    await share({ projectIds: ['p1'] })
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
    a.projects[0].archive = { id: 'fixture', start: 0, end: 1, taskCount: 8 }
    let r = await setA('summary')
    assert.deepEqual(r.projects.map(p => p.id), ['p1'])
    assert.equal(r.projects[0].tasks, undefined)
    assert.equal(r.projects[0].pending, 3)
    assert.equal(r.projects[0].counts.completed, 8)
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

test('details sync shares current main and scoped live agents without local identifiers', async () => {
  const b = await instance('B'), p = sample().project!, hidden = { ...fresh({ ...refs[1], id: 'hidden' }), hidden: true }
  const session = { handle: 'private-handle', title: '统筹会话', workspace: 'private-workspace', workspaceName: 'private-machine', path: '/private/path', agent: 'claude', online: 'online' as const }
  const workspace = { version: 1, revision: 1, runId: 'private-run', requests: [], session }
  const host = mockHost({ storage: { 'project:p1': p as any, 'project:hidden': hidden as any, workspace } })
  const now = Date.now()
  const visible: LiveAgent = { id: 'private-live-agent', terminalId: 'private-terminal', workspaceId: 'private-workspace', projectId: 'p1', agent: 'codex', role: 'worker', state: 'work', rawState: 'working', title: '正在检查', taskId: p.tasks[0].id, since: now }
  let live = [visible, { ...visible, id: 'unselected', projectId: 'p2', title: '未选项目 agent' },
    { ...visible, id: 'hidden', projectId: 'hidden', title: '隐藏项目 agent' },
    { ...visible, id: 'old', state: 'done' as const, title: '过期 agent', since: now - 86_400_001 }]
  let reads = 0, online = true, coordinator!: ReturnType<typeof createCoordinator>
  const worker = await mountWorker({ default: api => { coordinator = createCoordinator(api, {
    projects: async () => [...refs, hidden.ref],
    targets: async () => ({ workspaces: [], sessions: online ? [session] : [] }),
    agents: async (_, __, acting) => { reads++; return { ok: true, at: Date.now(), agents: live, main: { handle: acting!.handle, status: online ? {state:'work',since:now} : {state:'offline'} } } }
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
    assert.deepEqual(details.mainAgent, { agent: 'claude', title: '统筹会话', online: 'online', activity: { state: 'work', since: now } })
    assert.deepEqual(details.projects.map(p => p.id), ['p1'])
    assert.deepEqual(details.projects[0].activity, { truncated: false, agents: [
      { agent: 'codex', role: 'worker', state: 'work', title: '正在检查', taskTitle: p.tasks[0].title, since: now }
    ] })
    assert.equal(/handle|runId|terminalId|rawState|taskId|private-|[A-Z]:\\\\|未选项目|隐藏项目|过期 agent/.test(JSON.stringify(details)), false)

    online = false
    live = [{ ...visible, state: 'need', rawState: 'waiting', title: '等你回复' }, ...Array.from({ length: 25 }, (_, i) => ({ ...visible, id: 'copy-' + i }))]
    await worker.emit('agent.status.changed', { workspaceId: 'fake', paneKey: 'fake', state: 'waiting', receivedAt: Date.now() })
    const updated = (await b.links.refresh()).peers[0].report!
    assert.equal(updated.mainAgent?.online, 'offline')
    assert.equal(updated.projects[0].activity?.agents.length, 20)
    assert.equal(updated.projects[0].activity?.agents[0].title, '等你回复')
    assert.equal(updated.projects[0].activity?.truncated, true)

    await coordinator.store.mutateWorkspace(w => { w.backup = { agent: 'codex', primary: session.handle, handle: 'private-spare', phase: 'active', since: now, cycle: 'test', history: [] } })
    online = true
    live = [{ ...visible, title: '保存项目后更新' }]
    await worker.request('project.settings', { projectId: p.ref.id, revision: p.revision, roles: p.roles })
    const active = (await b.links.refresh()).peers[0].report!
    assert.equal(active.projects[0].activity?.agents[0].title, '保存项目后更新')
    assert.deepEqual(active.mainAgent, { agent: 'codex', title: '备用主会话', online: 'online', activity: { state: 'work', since: now } })
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
    assert.equal(await post(s.listening, '/sync', { id: p.id, report: malformed }, token), 400)
    assert.equal(await post(s.listening, '/sync', { id: p.id, report: malformed, exchange }, token), 200)
    assert.equal(await post(s.listening, '/sync', { id: p.id, report: malformed, exchange: { messages: 'invalid', received: [] } }, token), 400)
    assert.equal(await post(s.listening, '/sync', { id: p.id, report: { ...malformed, workspaceId: 'wrong' }, exchange }, token), 400)
    assert.equal(await post(s.listening, '/sync', { id: p.id, report: { ...malformed, scope: 'none', projects: [{ secret: 'ignored' }] }, exchange }, token), 400)
    const valid = report(b.projects, { scope: 'details', allProjects: false, projectIds: ['p1'] }, p.workspaceId, 'B')
    const agent = { agent: 'codex', role: 'session', state: 'work', since: Date.now(), title: '检查' }
    const project = { ...valid.projects[0], activity: { truncated: false, agents: [agent] } }
    const packet = { ...valid, projects: [project] }
    assert.equal(await post(s.listening, '/sync', { id: p.id, report: packet, exchange }, token), 200)
    assert.deepEqual(project.tasks?.map(t => t.state), ['review', 'decision'])
    const legacyTasks = project.tasks!.map(({ state, ...task }) => task)
    assert.equal(await post(s.listening, '/sync', { id: p.id, report: { ...packet, projects: [{ ...project, tasks: legacyTasks }] }, exchange }, token), 200)
    const accepted = (await a.links.snapshot()).peers[0].report
    assert.deepEqual(accepted?.projects[0].tasks, project.tasks)
    for (const changed of [
      { ...packet, mainAgent: undefined }, { ...packet, mainAgent: { agent: [], title: '统筹', online: 'online' } },
      { ...packet, mainAgent: { agent: 'claude', title: '统筹', online: 'somewhere' } },
      { ...packet, projects: [{ ...project, activity: undefined }] },
      { ...packet, projects: [{ ...project, tasks: [{ ...project.tasks![0], state: 'ready' }] }] },
      ...[{ agent: 'invented' }, { role: 'owner' }, { state: 'online' }, { since: String(agent.since) }, { title: '甲'.repeat(201) }, { taskTitle: [{}] }]
        .map(change => ({ ...packet, projects: [{ ...project, activity: { truncated: false, agents: [{ ...agent, ...change }] } }] })),
      { ...packet, projects: [{ ...project, activity: { truncated: true, agents: Array(21).fill(agent) } }] },
      { ...packet, projects: Array.from({ length: 6 }, (_, i) => ({ ...project, id: 'p' + i, activity: { truncated: false, agents: Array(20).fill(agent) } })) },
      { ...packet, scope: 'summary' }
    ]) assert.equal(await post(s.listening, '/sync', { id: p.id, report: changed, exchange }, token), 400)
    assert.deepEqual((await a.links.snapshot()).peers[0].report, accepted)
  } finally { a.links.stop(); b.links.stop() }
})

test('Orca catalog controls project visibility, pending counts, writes, notices and the next peer report', async () => {
  const b = await instance('B'), p = sample().project!
  p.deliveries.push({ id: 'queued', state: 'pending', subject: '待发通知', body: '示例' })
  const closed = { ...refs[1], workspace: '' }, replacement = { ...refs[0], id: 'new-p1', repoId: 'new-repo' }
  let catalog = [p.ref, closed], unavailable = true, sends = 0, coordinator!: ReturnType<typeof createCoordinator>
  const host = mockHost({ storage: { 'project:p1': p as any }, results: { 'workspace.list': { workspaces: [], truncated: false } } })
  const worker = await mountWorker({ default: api => { coordinator = createCoordinator(api, {
    projects: async () => { if (unavailable) throw Error('offline'); return catalog },
    send: async (_, d) => { if (!d.id.startsWith('lead-notice:')) sends++; return {} },
    agents: async () => ({ ok: true, at: Date.now(), agents: [{ id: 'test', projectId: 'p1', agent: 'codex', role: 'session', state: 'need', rawState: 'waiting', title: '待处理', since: Date.now() }] })
  }) } }, { host })
  const overview = () => worker.request('workspace.overview')
  try {
    const first = await overview()
    assert.ok(first.error?.includes('无法读取 Orca 项目')); assert.deepEqual(first.projects.map(p => p.ref.id), ['p1'])
    await coordinator.flush('p1'); assert.equal(sends, 0)
    unavailable = false
    const live = await overview()
    assert.deepEqual(live.projects.map(p => p.ref.id), ['p1', 'p2']); assert.ok(live.attention.length > 0)
    const noWorkspace = await worker.request('project.read', { projectId: closed.id })
    assert.deepEqual(noWorkspace.workspaceTarget, { error: '这个项目当前没有工作区' })
    await assert.rejects(() => worker.request('project.openMain', { projectId: closed.id }), /当前没有工作区/)
    assert.deepEqual(host.callsOf('workspace.open'), [])

    const s = await coordinator.links.snapshot()
    await coordinator.links.configure({ ...s, name: 'A', host: '127.0.0.1', enabled: true })
    const joined = await b.links.join((await coordinator.links.invite()).invitation!.code)
    await coordinator.links.share({ id: joined.peers[0].id, revision: (await coordinator.links.snapshot()).revision, scope: 'details', allProjects: true })
    const received = async () => (await b.links.refresh()).peers[0].report
    assert.deepEqual((await received())?.projects.map(p => p.id), ['p1', 'p2'])

    catalog = [closed]
    const input = { projectId: 'p1', revision: p.revision }
    await assert.rejects(() => worker.request('project.agent', { ...input, operation: 'submit', requestId: 'submit' }), /项目已从 Orca 移除/)
    await assert.rejects(() => worker.request('project.agent', { ...input, operation: 'bind', requestId: 'bind' }), /项目已从 Orca 移除/)
    await assert.rejects(() => worker.request('project.feedback', { ...input, items: [] }), /项目已从 Orca 移除/)
    await assert.rejects(() => worker.request('workspace.message', { ...input, requestId: 'message', runId: 'run_main', text: '测试' }), /项目已从 Orca 移除/)
    await assert.rejects(() => worker.request('project.visibility', { ...input, hidden: true }), /项目已从 Orca 移除/)
    await assert.rejects(() => worker.request('project.deliver', { projectId: 'p1', deliveryId: 'queued' }), /项目已从 Orca 移除/)
    await assert.rejects(() => worker.request('project.read', { projectId: 'p1' }), /项目已从 Orca 移除/)
    await coordinator.flush('p1')
    assert.equal(sends, 0)
    assert.deepEqual(await coordinator.store.get('p1'), p)
    const removed = await overview()
    assert.deepEqual(removed.projects.map(p => p.ref.id), ['p2']); assert.deepEqual(removed.attention, [])
    await coordinator.updateStatus()
    assert.equal((host.callsOf('statusBar.update').at(-1) as any).text, '工作间 · 待处理 0')
    assert.deepEqual((await worker.request('workspace.agents')).agents, [])
    assert.deepEqual((await received())?.projects.map(p => p.id), ['p2'])

    unavailable = true
    const cached = await overview()
    assert.ok(cached.error?.includes('无法读取 Orca 项目')); assert.deepEqual(cached.projects.map(p => p.ref.id), ['p2'])
    assert.equal(await received(), undefined)
    unavailable = false
    catalog = []
    assert.deepEqual((await overview()).projects, [])
    unavailable = true
    assert.deepEqual((await overview()).projects, [])
    unavailable = false
    catalog = [replacement, closed]
    const replaced = await overview()
    assert.deepEqual(replaced.projects.map(p => p.ref.id), ['new-p1', 'p2']); assert.deepEqual(replaced.attention, [])
    catalog = [p.ref, closed]
    assert.deepEqual((await worker.request('project.read', { projectId: p.ref.id })).project, p)
    assert.ok((await overview()).attention.length > 0)
    assert.equal(sends, 0)
  } finally { coordinator.stop(); b.links.stop(); await worker.deactivate() }
})

test('the bound main directory leaves the project list, inbox, agents, notices and shared report without losing records', async () => {
  const peer = await instance('B'), p = sample().project!
  p.ref.path = path.resolve('main-folder')
  const other = { ...refs[1], workspace: '', path: path.resolve('other-folder') }
  const nested = { ...other, id: 'nested', path: path.join(p.ref.path, 'separate-project') }
  p.deliveries.push({ id: 'queued', state: 'pending', subject: '待发通知', body: '测试' })
  const session = { handle: 'main', title: '工作间主会话', workspace: 'identity:main', workspaceName: '工作间',
    path: `${process.platform === 'win32' ? p.ref.path.toUpperCase() : p.ref.path}${path.sep}`, agent: 'codex', online: 'online' as const }
  const host = mockHost({ storage: { 'project:p1': p as any } })
  let c!: ReturnType<typeof createCoordinator>, sends = 0
  const worker = await mountWorker({ default: api => { c = createCoordinator(api, {
    projects: async () => [p.ref, other, nested],
    targets: async () => ({ workspaces: [], sessions: [session] }),
    identify: async () => session,
    send: async (_, d) => { if (!d.id.startsWith('lead-notice:')) sends++; return {} },
    agents: async projects => ({ ok: true, at: Date.now(), agents: projects.filter(pr => pr.ref.id === p.ref.id).map(pr => ({ id: 'main', projectId: pr.ref.id,
      agent: 'codex', role: 'session', state: 'need', rawState: 'waiting', title: session.title, since: Date.now() })) })
  }) } }, { host })
  const view = () => worker.request('workspace.overview')
  const ids = async () => (await view()).projects.map(pr => pr.ref.id)
  try {
    assert.deepEqual(await ids(), ['p1', 'p2', 'nested'])
    assert.ok((await view()).attention.some(i => i.projectId === 'p1'))
    const { id } = (await peer.links.join((await c.links.invite()).invitation!.code)).peers[0]
    await c.links.share({ id, revision: (await c.links.snapshot()).revision, scope: 'details', allProjects: true })
    const shared = async () => (await peer.links.refresh()).peers[0].report?.projects.map(p => p.id)
    assert.deepEqual(await shared(), ['p1', 'p2', 'nested'])

    const bound = await worker.request('workspace.agent', { operation: 'bind', revision: 0, runId: 'run_main', currentRunId: 'run_main', caller: session.handle, requestId: 'bind-main' })
    assert.equal(bound.session?.title, session.title)
    assert.deepEqual(await ids(), ['p2', 'nested'])
    assert.equal((await view()).workspace.session?.title, session.title)
    assert.deepEqual((await view()).attention, [])
    assert.deepEqual((await worker.request('projects.list')).projects.map(p => p.id), ['p2', 'nested'])
    await assert.rejects(() => worker.request('project.read', { projectId: 'p1' }), /工作间项目列表/)
    assert.deepEqual((await worker.request('workspace.agents', { refresh: true })).agents, [])
    assert.deepEqual(await shared(), ['p2', 'nested'])
    await c.updateStatus()
    assert.equal((host.callsOf('statusBar.update').at(-1) as any).text, '工作间 · 待处理 0')
    await c.flush('p1')
    assert.equal(sends, 0)
    assert.deepEqual(await c.store.get('p1'), p)

    // Simulate the saved state after takeover; its old-session notice is covered by the takeover tests.
    await c.store.mutateWorkspace(w => { w.session = { ...session, path: other.path } })
    assert.deepEqual(await ids(), ['p1', 'nested'])
    assert.deepEqual(await shared(), ['p1', 'nested'])
    await c.store.mutateWorkspace(w => { w.runId = '' })
    assert.deepEqual(await ids(), ['p1', 'p2', 'nested'])
    assert.deepEqual(await shared(), ['p1', 'p2', 'nested'])
    assert.deepEqual(await c.store.get('p1'), p)
    assert.equal(sends, 0)
  } finally { c.stop(); peer.links.stop(); await worker.deactivate() }
})

test('refresh does not broadcast changes when there is no outbound peer to sync', async () => {
  let changed = 0
  const api = { storage: { get: async (key: string) => key !== 'workspace.links' ? null : ({ version: 1, revision: 0, workspaceId: 'own', name: 'own', enabled: false, host: '127.0.0.1', port: 0, publicUrl: '', tls: false, peers: [] }) } }
  const links = new WorkspaceLinks(api as unknown as OrcaWorkerApi, async () => [], () => { changed++ }, undefined, undefined, undefined, testFiles())
  await links.refresh(); assert.equal(changed, 0); links.stop()
})
