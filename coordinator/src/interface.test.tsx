import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import { refs, sample, longSample, deliverable } from './fixtures'
import { fresh, feedback, overview, submitTask } from './store'
import type { LinksSnapshot } from './links'
import { requestState, type WorkspaceRequest } from './model'

test('butler settings save real state, clear secrets, and show connection failures without screenshots', async () => {
  let s: import('./butler').ButlerSnapshot = { version: 1, revision: 0, enabled: false, port: 9901, url: 'http://127.0.0.1:9900', entries: [], listening: '', connection: '未检查', error: '', inboundSecretSaved: false, outboundSecretSaved: false }
  const saves: any[] = []
  const host = mockHost({ requests: {
    'projects.list': () => ({ projects: [] }),
    'workspace.overview': () => ({ ...overview([], { version: 1, revision: 0, runId: '', requests: [] }), butler: s }),
    'workspace.butler': input => {
      if (input.operation === 'save') { saves.push(input); s = { ...s, enabled: input.enabled!, revision: 1, inboundSecretSaved: true, outboundSecretSaved: true, listening: 'http://127.0.0.1:9901' } }
      if (input.operation === 'check') s = { ...s, connection: '连接失败', error: '模拟 Hermes 尚未启动。'.repeat(40) }
      return s
    }
  } })
  const view = await mount(panel, { host })
  try {
    await view.press({ text: '管家设置' })
    assert.equal(view.valueOf({ label: 'Hermes A2A 地址' }), s.url)
    await view.toggle({ label: '启用管家' })
    await view.type({ label: 'Hermes 令牌' }, 'test-only-Hermes-token-12345678901234567890')
    await view.type({ label: '主 agent 令牌' }, 'test-only-main-token-12345678901234567890')
    await view.press({ text: '保存设置' })
    assert.equal(saves.length, 1); assert.equal(saves[0].port, 9901)
    assert.equal(view.valueOf({ label: 'Hermes 令牌' }), ''); assert.equal(view.valueOf({ label: '主 agent 令牌' }), '')
    await view.press({ text: '检查连接' })
    assert.ok(JSON.stringify(view.tree()).includes('模拟 Hermes 尚未启动'))
    await view.press({ text: '返回' })
    await view.post('project.changed', { projectId: '' }); await view.settled()
    assert.ok(JSON.stringify(view.tree()).includes('连接失败'))
    assert.deepEqual(view.errors, []); assert.deepEqual(view.warnings, []); assert.deepEqual(view.refusals, [])
  } finally { await view.unmount() }
})

test('main agent identity and both switch forms confirm once and wait for the real binding; global entry returns from a project', async () => {
  for (const mode of ['existing', 'new'] as const) {
    const session = { handle: 'orca_session_id:test-main', title: '测试原会话', workspace: 'identity:test', workspaceName: '测试工作区', path: '/test/workspace', agent: 'claude', online: 'online' as const }
    const target = { ...session, handle: 'orca_session_id:test-next', title: '测试接管会话' }
    let binding: import('./model').WorkspaceBinding = { revision: 1, runId: 'run_old', session, boundAt: '2026-11-14T00:00:00Z', projectNames: ['测试项目'], verification: { run: 'plugin', session: 'plugin', runOwnership: 'self-reported' }, securityBoundary: '替换授权来自面板一次性凭据' }
    const switches: any[] = [], host = mockHost({ requests: {
      'projects.list': () => ({ projects: refs }),
      'project.read': () => sample(),
      'workspace.overview': () => ({ ...overview([sample().project!], { version: 1, revision: 1, runId: 'run_old', requests: [] }), workspace: structuredClone(binding) }),
      'workspace.agent.targets': () => ({ sessions: [target], workspaces: [{ workspace: session.workspace, name: session.workspaceName, path: session.path }] }),
      'workspace.agent.switch': input => { switches.push(input); binding = { ...binding, revision: 2, takeover: { id: 'test', state: 'waiting', expiresAt: new Date(Date.now() + 60000).toISOString(), target } }; return structuredClone(binding) }
    } })
    const view = await mount(panel, { host })
    try {
      for (const value of [session.title, session.path, session.workspaceName, 'Claude', 'run_old', '在线', '测试项目']) assert.ok(JSON.stringify(view.tree()).includes(value))
      for (const value of ['Run 归属：会话自报', '插件核实', '替换授权来自面板一次性凭据']) assert.ok(JSON.stringify(view.tree()).includes(value))
      await view.select({ label: '项目' }, 'p1')
      host.respond('storage.get', (params: { key: string }) => ({ value: params.key === 'workspace.navigation' ? { switching: false } : null }))
      await view.post('workspace.open', { switching: false }); await view.settled()
      assert.ok(view.find({ text: '工作间总览' }))
      await view.press({ text: '切换主 agent' })
      if (mode === 'new') {
        await view.select({ label: '切换方式' }, 'new')
        assert.equal(view.valueOf({ label: '主 agent 类型' }), 'claude')
        await view.select({ label: '主 agent 工作区' }, session.workspace)
      } else await view.select({ label: '接管会话' }, target.handle)
      await view.press({ text: '请求接管' }); assert.equal(switches.length, 0)
      await view.press({ text: '确认请求接管' }); assert.equal(switches.length, 1)
      assert.equal(switches[0].mode, mode)
      assert.ok(JSON.stringify(view.tree()).includes('等待 测试接管会话 接管'))
      assert.ok(JSON.stringify(view.tree()).includes('run_old'))
      assert.ok(JSON.stringify(view.tree()).includes('通知不会补发'))
      binding = { ...binding, revision: 3, runId: 'run_new', session: target }; delete binding.takeover
      await view.post('project.changed', { projectId: '' }); await view.settled()
      assert.ok(JSON.stringify(view.tree()).includes('run_new'))
      assert.deepEqual(view.errors, []); assert.deepEqual(view.warnings, []); assert.deepEqual(view.refusals, [])
    } finally { await view.unmount() }
  }
})

test('project settings hide and restore through overview; closed records require confirmation and show the export path', async () => {
  let p = fresh(refs[0]), catalog = refs, removed = false, deletes = 0, reject = false
  const binding = { version: 1 as const, revision: 0, runId: '', requests: [] }
  const host = mockHost({ requests: {
    'projects.list': () => ({ projects: catalog }),
    'workspace.overview': () => overview(removed ? [] : [p], binding),
    'project.read': () => ({ projects: catalog, project: structuredClone(p), secretSaved: false, connection: { state: 'off', message: '' } }),
    'project.visibility': input => { p.hidden = input.hidden; p.revision++; return { projects: catalog, project: structuredClone(p), secretSaved: false, connection: { state: 'off', message: '' } } },
    'project.delete': input => {
      if (reject) throw hostError('invalid_request', '测试导出失败，原记录保留')
      assert.equal(input.confirm, p.ref.id); assert.equal(input.revision, p.revision)
      removed = true; deletes++; return { deleted: p.ref.id, exportPath: 'C:\\test-data\\exports\\record.json' }
    }
  } })
  const view = await mount(panel, { host })
  await view.select({ label: '项目' }, 'p1'); await view.press({ label: '项目设置' })
  assert.equal(view.find({ text: '删除项目记录' }), null)
  await view.press({ text: '隐藏项目' })
  await view.press({ text: '总览' }); assert.ok(view.find({ text: '项目 0' }))
  await view.toggle({ label: '已隐藏 1 个' })
  await view.press({ text: '恢复显示' })
  assert.ok(view.find({ text: '项目 1' })); assert.equal(p.hidden, false)
  catalog = []
  await view.select({ label: '项目' }, 'p1'); await view.press({ label: '项目设置' })
  await view.press({ text: '删除项目记录' })
  assert.equal(deletes, 0); assert.ok(JSON.stringify(view.tree()).includes('确认删除项目记录？'))
  await view.press({ text: '取消' }); assert.equal(deletes, 0)
  await view.press({ text: '删除项目记录' }); reject = true
  await view.press({ text: '确认删除记录' }); assert.equal(deletes, 0)
  assert.ok(JSON.stringify(view.tree()).includes('测试导出失败'))
  reject = false; await view.press({ text: '确认删除记录' })
  assert.equal(deletes, 1); assert.ok(JSON.stringify(view.tree()).includes('项目记录已删除'))
  assert.ok(JSON.stringify(view.tree()).includes('C:\\\\test-data\\\\exports\\\\record.json'))
  assert.deepEqual(view.errors, []); assert.deepEqual(view.warnings, []); assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('overview confirms or rejects external requests, keeps failed notes, and displays returned result links', async () => {
  for (const status of ['accepted', 'rejected'] as const) {
    let reject = true
    const r: WorkspaceRequest = { id: 'test-request', peerId: 'test-peer', workspaceId: 'other', direction: 'incoming', title: '测试外部请求', context: '测试背景', expected: '测试结果', links: ['https://example.com/input'], createdAt: '',
      updates: [{ id: 'update', status: 'confirm', note: '', links: [], at: '' }] }
    const links: LinksSnapshot = { version: 1, revision: 0, workspaceId: 'own', name: '本工作间', enabled: false, host: '127.0.0.1', port: 0, publicUrl: '', tls: false, listening: '', error: '', peers: [], requests: [r] }
    const writes: any[] = [], host = mockHost({ requests: {
      'projects.list': () => ({ projects: [] }),
      'workspace.overview': () => ({ ...overview([], { version: 1, revision: 0, runId: '', requests: [] }), links: structuredClone(links) }),
      'workspace.requests': input => {
        if (reject) throw hostError('invalid_request', '测试保存失败')
        writes.push(input); r.updates.push({ id: 'decision', status: input.status!, note: input.note!, links: [], at: '' }); return structuredClone(links)
      }
    } })
    const view = await mount(panel, { host })
    assert.ok(view.find({ text: '待用户处理 1' }))
    assert.ok(view.find({ text: '待你确认' }))
    await view.type({ label: '处理说明 · 测试外部请求' }, '测试主人说明', { replace: true })
    const button = status === 'accepted' ? '接受请求' : '拒绝请求'
    await view.press({ text: button })
    assert.equal(view.valueOf({ label: '处理说明 · 测试外部请求' }), '测试主人说明')
    assert.ok(JSON.stringify(view.tree()).includes('测试保存失败'))
    reject = false; await view.press({ text: button })
    assert.equal(writes[0].status, status)
    assert.equal(writes[0].note, '测试主人说明')
    assert.equal(requestState(r), status)
    assert.ok(view.find({ text: '待用户处理 0' }))
    assert.equal(view.find({ text: '接受请求' }), null)
    assert.deepEqual(view.errors, []); assert.deepEqual(view.warnings, []); assert.deepEqual(view.refusals, [])
    await view.unmount()
  }
  const links: LinksSnapshot = { version: 1, revision: 0, workspaceId: 'own', name: '本工作间', enabled: false, host: '127.0.0.1', port: 0, publicUrl: '', tls: false, listening: '', error: '', peers: [], requests: [{
    id: 'result', peerId: 'peer', workspaceId: 'other', direction: 'outgoing', title: '测试返回结果', context: '', expected: '返回链接', links: [], createdAt: '',
    updates: [{ id: 'done', status: 'completed', note: '测试已完成', links: ['https://example.com/result'], at: '' }]
  }] }
  const view = await mount(panel, { host: mockHost({ requests: { 'projects.list': () => ({ projects: [] }),
    'workspace.overview': () => ({ ...overview([], { version: 1, revision: 0, runId: '', requests: [] }), links }) } }) })
  assert.ok(view.find({ text: '测试已完成' }))
  assert.ok(view.find({ text: 'https://example.com/result' }))
  assert.deepEqual(view.errors, []); assert.deepEqual(view.warnings, []); assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('workspace links manage scopes, preserve failed drafts, show external reports and clear private input on exit', async () => {
  let reject = false
  const s: LinksSnapshot = { version: 1, revision: 0, workspaceId: 'own', name: '本工作间', enabled: false, host: '127.0.0.1', port: 0, publicUrl: '', tls: false, listening: '', error: '',
    peers: [{ id: 'connection1', workspaceId: 'other', name: '合作工作间', endpoint: '', state: 'active', status: 'connected', scope: 'none', projectIds: [], acceptTasks: 'deny', receivedAt: '2026-11-14T10:00:00Z',
      report: { workspaceId: 'other', name: '合作工作间', scope: 'summary', updatedAt: '2026-11-14T10:00:00Z', projects: [{ id: 'external', name: '共享项目', updatedAt: '', counts: { working: 1 }, pending: 0 }] } }] }
  const writes: any[] = []
  const host = mockHost({ requests: {
    'projects.list': () => ({ projects: refs }),
    'workspace.overview': () => ({ ...overview([fresh(refs[0])], { version: 1, revision: 0, runId: '', requests: [] }), links: structuredClone(s) }),
    'workspace.links': input => {
      if (input.operation === 'configure') {
        if (reject) throw hostError('invalid_request', '保存失败，请重试')
        writes.push(input); s.name = input.name!; s.revision++
      }
      if (input.operation === 'share') { writes.push(input); Object.assign(s.peers[0], { scope: input.scope, projectIds: input.projectIds, acceptTasks: input.acceptTasks }); s.revision++ }
      return structuredClone(s)
    }
  } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: '共享项目 · 待处理 0' }))
  await view.press({ text: '管理连接' })
  assert.ok(view.find({ text: '工作间连接' }))
  await view.type({ label: '工作间名称' }, '工作间新名称', { replace: true })
  reject = true
  await view.press({ text: '保存连接设置' })
  assert.equal(view.valueOf({ label: '工作间名称' }), '工作间新名称')
  assert.ok(JSON.stringify(view.tree()).includes('保存失败，请重试'))
  reject = false
  await view.press({ text: '保存连接设置' })
  await view.select({ label: '向对方开放' }, 'details')
  await view.toggle({ label: `${refs[0].name} · ${refs[0].path}` })
  await view.select({ label: '接受对方派活' }, 'confirm')
  await view.press({ text: '保存开放范围' })
  assert.deepEqual(writes.at(-1).projectIds, ['p1'])
  assert.equal(writes.at(-1).acceptTasks, 'confirm')
  await view.type({ label: '对方的连接码' }, 'temporary-code')
  await view.toggle({ label: '使用 TLS' })
  await view.type({ label: 'TLS 私钥' }, 'private-input')
  await view.press({ text: '返回总览' })
  await view.press({ text: '管理连接' })
  assert.equal(view.valueOf({ label: '对方的连接码' }), '')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('workspace Feishu settings open in overview, preserve drafts on failure and clear secret on success', async () => {
  let reject = true, saved: any
  const host = mockHost({ requests: {
    'projects.list': () => ({ projects: refs }),
    'workspace.overview': () => overview([], { version: 1, revision: 1, runId: 'run_main', requests: [] }),
    'workspace.feishu': input => {
      if (input.operation === 'save') {
        if (reject) throw hostError('invalid_request', '请刷新后重试')
        saved = input
      }
      return { version: 1, revision: input.operation === 'save' ? 1 : 0, feishu: fresh(refs[0]).feishu, inbox: [], deliveries: [], secretSaved: false, connection: { state: 'off', message: '' } }
    }
  } })
  const view = await mount(panel, { host })
  await view.press({ text: '工作间飞书' })
  assert.ok(view.find({ label: '允许的用户 Open ID' }))
  await view.type({ label: 'App ID' }, 'app_demo')
  await view.type({ label: 'App Secret' }, 'mock-password')
  await view.type({ label: '允许的用户 Open ID' }, 'ou_demo')
  await view.type({ label: '允许的会话 Chat ID' }, 'oc_demo')
  await view.press({ text: '保存飞书设置' })
  assert.ok(JSON.stringify(view.tree()).includes('保存飞书设置未成功'))
  assert.equal(view.valueOf({ label: 'App ID' }), 'app_demo')
  reject = false
  await view.press({ text: '保存飞书设置' })
  assert.equal(saved.appSecret, 'mock-password')
  assert.deepEqual(saved.feishu.chatIds, ['oc_demo'])
  assert.ok(view.find({ text: '工作间总览' }))
  await view.press({ text: '工作间飞书' })
  assert.equal(view.valueOf({ label: 'App Secret' }), '')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

function fixture() {
  const s = sample(), two = { ...s, project: fresh(refs[1]) }
  const saved: any[] = []
  let refusal = ''
  const host = mockHost({ requests: {
    'projects.list': () => ({ projects: refs }),
    'workspace.overview': () => overview([s.project!, two.project!], { version: 1, revision: 0, runId: '', requests: [] }),
    'project.read': ({ projectId }) => structuredClone(projectId === 'p1' ? s : two),
    'project.feedback': input => { feedback(s.project!, input); return structuredClone(s) },
    'project.settings': input => {
      if (refusal) throw hostError('invalid_request', refusal)
      saved.push(input)
      return structuredClone({ ...s, secretSaved: true })
    }
  } })
  return { s, host, saved, refuse: (message: string) => { refusal = message } }
}
const clean = (view: Awaited<ReturnType<typeof mount>>) => {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}
const tabLabels = (view: Awaited<ReturnType<typeof mount>>) => view.findAll({ type: 'Tab' }).map(t => t.props.label)
// The first inbox card is the decision of 确定首页风格; its 详情 link opens that task's record.
const openFirst = (view: Awaited<ReturnType<typeof mount>>) => view.press(view.findAll({ type: 'Link', text: '详情' })[0])
const units = (value: string) => [...value].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e7f ? 2 : 1), 0)

test('overview opens first with a saved project; attention opens its exact project and task', async () => {
  const { host } = fixture()
  const view = await mount(panel, { host, persisted: { plugin: { 'project.selection': 'p2', 'project.view': { kind: 'settings' } } } })
  assert.ok(view.find({ text: '工作间总览' }))
  assert.ok(view.find({ text: '待用户处理 3' }))
  assert.equal(view.find({ text: '保存设置' }), null)
  await view.press(view.findAll({ type: 'Button', text: '查看任务' })[0])
  assert.equal(view.valueOf({ label: '项目' }), 'p1')
  assert.ok(view.find({ text: '返回待处理' }))
  assert.ok(view.find({ text: '首页布局' }))
  await view.press({ text: '总览' })
  assert.ok(view.find({ text: '工作间总览' }))
  clean(view)
  await view.unmount()
})

test('inbox answers both queues in place; a change request leaves it; a new version returns for acceptance', async () => {
  const { s, host } = fixture()
  const view = await mount(panel, { host })
  await view.select({ label: '项目' }, 'p1')
  assert.deepEqual(tabLabels(view), ['待处理 2', '任务记录', '消息'])
  assert.ok(view.find({ text: '待决定' }))
  assert.ok(view.find({ text: '待验收' }))
  assert.equal(view.find({ type: 'Textarea' }), null)
  assert.ok(view.find({ text: '提交决定' })!.disabled)
  await view.select({ label: '选项' }, '简洁明亮')
  await view.press({ text: '提交决定' })
  assert.equal(s.project!.tasks[1].decisions[0].answer, '简洁明亮')
  assert.equal(view.find({ text: '待决定' }), null)

  await view.press({ text: '需要修改' })
  await view.type({ label: '修改意见' }, '主按钮请更醒目')
  await view.press({ text: '退回修改' })
  assert.equal(s.project!.tasks[0].acceptance[0].history[0].note, '主按钮请更醒目')
  assert.ok(view.find({ type: 'EmptyState' }))
  assert.deepEqual(tabLabels(view), ['待处理', '任务记录', '消息'])

  await view.select({ label: '视图' }, 'tasks')
  assert.ok(view.find({ text: '修改中' }))
  await view.press({ testId: 'task-1' })
  assert.equal(view.find({ text: '通过验收' }), null)
  assert.ok(view.find({ text: '已退回修改' }))
  await view.toggle({ label: '验收记录' })
  assert.ok(view.find({ text: '主按钮请更醒目' }))

  submitTask(s.project!, { ...deliverable, artifacts: [{ ...deliverable.artifacts[0], id: 'page-v2', version: 'v2' }], acceptance: [{ ...deliverable.acceptance[0], artifactIds: ['page-v2'] }] })
  await view.post('project.changed', { projectId: 'p1' })
  assert.ok(view.find({ text: '首页布局 · 第 2 版' }))
  await view.press({ text: '返回任务记录' })
  await view.select({ label: '视图' }, 'inbox')
  assert.deepEqual(tabLabels(view), ['待处理 1', '任务记录', '消息'])
  assert.ok(view.find({ text: '首页预览 · v2' }))
  assert.equal(view.find({ text: '首页预览 · v1' }), null)
  assert.ok(JSON.stringify(view.tree()).includes('上次修改意见'))
  await view.press({ text: '通过验收' })
  assert.equal(s.project!.tasks[0].acceptance[0].status, 'passed')
  assert.deepEqual(s.project!.tasks[0].acceptance[0].history.map(h => h.note), ['主按钮请更醒目', ''])
  assert.ok(view.find({ type: 'EmptyState' }))
  clean(view)
  await view.unmount()
})

test('a free-text decision is submitted from the task record', async () => {
  const { s, host } = fixture()
  const view = await mount(panel, { host })
  await view.select({ label: '项目' }, 'p1')
  await openFirst(view)
  assert.ok(view.find({ text: '返回待处理' }))
  await view.select({ label: '选项' }, ' other')
  await view.type({ label: '你的决定' }, '明亮，但主色用蓝色')
  await view.press({ text: '提交决定' })
  assert.equal(s.project!.tasks[1].decisions[0].answer, '明亮，但主色用蓝色')
  assert.ok(view.find({ text: '已决定' }))
  assert.equal(view.find({ text: '提交决定' }), null)
  clean(view)
  await view.unmount()
})

test('project switching isolates pages and drafts; a failed save stays in settings; a saved one returns home', async () => {
  const f = fixture()
  const view = await mount(panel, { host: f.host })
  await view.select({ label: '项目' }, 'p1')
  assert.ok(view.find({ text: '主会话已绑定' }))
  assert.ok(view.find({ text: '飞书未启用' }))
  await openFirst(view)
  assert.ok(view.find({ text: '返回待处理' }))
  await view.select({ label: '项目' }, 'p2')
  assert.ok(view.find({ type: 'Tabs' }))
  assert.ok(JSON.stringify(view.tree()).includes('主会话未绑定'))
  assert.equal(view.find({ text: '主会话已绑定' }), null)
  assert.equal(JSON.stringify(view.tree()).includes('首页采用哪种风格'), false)

  await view.select({ label: '项目' }, 'p1')
  await view.select({ label: '视图' }, 'tasks')
  await view.press({ label: '项目设置' })
  await view.select({ label: '审查' }, 'claude')
  await view.type({ label: 'App Secret' }, 'only-in-secret-store')
  await view.post('project.changed', { projectId: 'p1' })
  assert.equal(view.valueOf({ label: '审查' }), 'claude')
  assert.equal(view.valueOf({ label: 'App Secret' }), 'only-in-secret-store')
  f.refuse('启用飞书需要 App ID、App Secret、群聊编号和允许的发送者')
  await view.press({ text: '保存设置' })
  assert.ok(view.find({ text: '保存设置' }))
  assert.ok(view.find({ text: /启用飞书需要/ }))
  assert.equal(view.valueOf({ label: 'App Secret' }), 'only-in-secret-store')
  f.refuse('')
  await view.press({ text: '保存设置' })
  assert.equal(f.saved.length, 1)
  assert.equal(f.saved[0].appSecret, 'only-in-secret-store')
  assert.deepEqual(f.saved[0].roles, { design: 'claude', code: 'codex', review: 'claude' })
  assert.equal(view.find({ text: '保存设置' }), null)
  assert.equal(view.valueOf({ label: '视图' }), 'inbox')
  assert.ok(view.find({ text: '待决定' }))
  assert.equal(JSON.stringify(view.tree()).includes('only-in-secret-store'), false)

  await view.press({ label: '项目设置' })
  assert.equal(view.valueOf({ label: 'App Secret' }), '')
  await view.type({ label: 'App ID' }, 'abandoned')
  await view.press({ text: '返回' })
  await view.press({ label: '项目设置' })
  assert.equal(view.valueOf({ label: 'App ID' }), '')
  clean(view)
  await view.unmount()
})

test('a view stored by an earlier version opens the inbox instead of an empty panel', async () => {
  const { host } = fixture()
  for (const old of ['decision', 'review', 'rework', 'all', 'sources', 'settings']) {
    const view = await mount(panel, { host, persisted: { plugin: { 'project.selection': 'p1', 'project.tab': old, 'project.view': old } } })
    await view.settled()
    await view.press({ text: '单项目' })
    assert.equal(view.valueOf({ label: '视图' }), 'inbox', old)
    assert.ok(view.find({ text: '待决定' }), old)
    await openFirst(view)
    assert.ok(view.find({ text: '返回待处理' }), old)
    await view.press({ text: '返回待处理' })
    await view.select({ label: '视图' }, 'messages')
    assert.equal(view.persisted.plugin['project.tab'], 'messages')
    clean(view)
    await view.unmount()
  }
})

test('long content stays out of the inbox: a summary leads to the task record, which holds the whole text and the choice', async () => {
  const s = longSample(), [review, style] = s.project!.tasks
  const host = mockHost({ requests: {
    'projects.list': () => ({ projects: s.projects }),
    'workspace.overview': () => overview([s.project!], { version: 1, revision: 0, runId: '', requests: [] }),
    'project.read': () => structuredClone(s),
    'project.feedback': input => { feedback(s.project!, input); return structuredClone(s) }
  } })
  const view = await mount(panel, { host })
  await view.select({ label: '项目' }, 'p1')
  // Buttons and control labels do not wrap, so none may be wider than a 300px panel; no card text may run on for a screen.
  for (const button of view.findAll({ type: 'Button' })) assert.ok(units(button.text) <= 27, button.text)
  for (const text of view.findAll({ type: 'Text' })) assert.ok(units(text.text) <= 160, text.text)
  const radios = view.findAll({ type: 'RadioGroup' })
  assert.equal(radios.length, 1)
  assert.deepEqual((radios[0].props.options as { label: string }[]).map(o => o.label), ['选项 1', '选项 2', '其他'])
  assert.ok(view.find({ text: /^顶部导航，参考 https/ }))
  assert.equal(view.find({ text: '通过验收' }), null)

  await view.press({ text: '查看并决定' })
  assert.ok(view.find({ text: style.decisions[0].question }))
  assert.ok(view.find({ text: style.decisions[0].options[0] }))
  await view.select({ label: '选项' }, style.decisions[0].options[0])
  await view.press({ text: '提交决定' })
  assert.equal(style.decisions[0].answer, style.decisions[0].options[0])

  await view.press({ text: '返回待处理' })
  await view.press({ text: '查看并验收' })
  assert.ok(view.find({ text: review.acceptance[0].details }))
  await view.press({ text: '通过验收' })
  assert.equal(review.acceptance[0].status, 'passed')
  clean(view)
  await view.unmount()
})

test('an unconfirmed notification is surfaced on home and leads to messages; a later delivery clears it', async () => {
  const { s, host } = fixture()
  const view = await mount(panel, { host })
  await view.select({ label: '项目' }, 'p1')
  await view.press({ text: '通过验收' })
  const sent = s.project!.deliveries[0]
  Object.assign(sent, { state: 'uncertain', error: '通知结果待核对，请在主会话检查；原消息已保存' })
  await view.post('project.changed', { projectId: 'p1' })
  assert.ok(view.find({ text: '主会话已绑定' }))
  await view.press({ text: '查看消息' })
  assert.equal(view.valueOf({ label: '视图' }), 'messages')
  assert.ok(view.find({ text: '待核对' }))
  assert.equal(view.find({ text: '查看消息' }), null)
  assert.equal(view.find({ text: '通知主会话' }), null)
  s.project!.deliveries.push({ id: 'later', subject: '决定已提交', body: '', state: 'sent' })
  await view.post('project.changed', { projectId: 'p1' })
  await view.select({ label: '视图' }, 'inbox')
  assert.equal(view.find({ text: '查看消息' }), null)
  clean(view)
  await view.unmount()
})

test('home follows the reported Feishu connection state, not the saved switch (stand-in states, no real Feishu)', async () => {
  const f = fixture()
  const view = await mount(panel, { host: f.host })
  await view.select({ label: '项目' }, 'p1')
  const report = async (state: 'off' | 'connecting' | 'connected' | 'error', message = '') => {
    f.s.connection = { state, message }
    await view.post('project.changed', { projectId: 'p1' })
  }
  f.s.project!.feishu.enabled = true
  await report('connecting')
  assert.ok(view.find({ text: '飞书连接中' }))
  assert.equal(view.find({ text: '飞书已连接' }), null)
  await report('error', '飞书连接失败，请检查应用凭据、网络和事件订阅设置')
  assert.equal(view.find({ text: '飞书连接中' }), null)
  assert.ok(view.find({ text: /飞书连接失败/ }))
  await view.press({ text: '飞书设置' })
  assert.ok(view.find({ text: '连接异常' }))
  assert.ok(view.find({ text: '保存设置' }))
  await report('connected')
  await view.press({ text: '返回' })
  assert.ok(view.find({ text: '飞书已连接' }))
  assert.equal(view.find({ text: '飞书设置' }), null)
  clean(view)
  await view.unmount()
})
