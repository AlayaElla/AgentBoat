import { defineCheck } from 'orca/testing'
import { sample, longSample, refs, deliverable } from './fixtures'
import { fresh, receiveEvent, submitTask } from './store'
import type { Snapshot } from './model'

const pending = sample()
const unbound: Snapshot = { ...sample(), project: fresh(refs[0]) }

const modifying = sample()
modifying.project!.tasks[0].acceptance[0].status = 'changes_requested'
modifying.project!.tasks[0].acceptance[0].history.push({ at: '2026-11-11T02:30:00.000Z', revision: 1, result: 'changes_requested', note: '主按钮请更醒目一些' })

const secondVersion = structuredClone(modifying)
submitTask(secondVersion.project!, { ...deliverable, artifacts: [{ ...deliverable.artifacts[0], id: 'page-v2', version: 'v2' }], acceptance: [{ ...deliverable.acceptance[0], artifactIds: ['page-v2'] }] })

const withMessages = sample()
receiveEvent(withMessages.project!, { id: 'feishu:1', source: 'feishu', sourceId: 'app/m1', threadId: 'app/m1', chatId: 'chat', senderId: 'ou_example', text: '首页再加一个联系入口\n放在页脚即可', receivedAt: '2026-11-11T03:00:00.000Z' })
submitTask(withMessages.project!, { ...deliverable, sourceIds: ['feishu:1'] })
withMessages.project!.deliveries[0] = { ...withMessages.project!.deliveries[0], state: 'uncertain', error: '通知结果待核对，请在主会话检查；原消息已保存' }

const enabled = sample()
enabled.project!.feishu = { enabled: true, appId: 'cli_example', chatIds: ['oc_example'], senderIds: ['ou_example'] }

const long = longSample()

const state = (s: Snapshot, tab = 'inbox', view: unknown = null, list = refs) => ({
  requests: { 'projects.list': () => ({ projects: list }), 'project.read': () => s },
  persisted: { plugin: { 'project.selection': 'p1', 'project.tab': tab, 'project.view': view } }
})
export default defineCheck({
  fresh: { requests: { 'projects.list': () => ({ projects: refs }) } },
  noProjects: { requests: { 'projects.list': () => ({ projects: [] }) } },
  listError: { requests: { 'projects.list': () => ({ projects: [], error: '无法读取 Orca 项目：请检查 Orca 与 CLI 路径' }) } },
  unbound: state(unbound),
  inbox: state(pending),
  legacyTab: state(pending, 'decision', 'history'),
  rereview: state(secondVersion),
  tasks: state(modifying, 'tasks'),
  taskRecord: state(modifying, 'tasks', { kind: 'task', id: 'task-1' }),
  messages: state(withMessages, 'messages'),
  unconfirmed: state(withMessages),
  settings: state(pending, 'inbox', { kind: 'settings' }),
  connecting: state({ ...enabled, connection: { state: 'connecting', message: '' } }),
  connected: state({ ...enabled, secretSaved: true, connection: { state: 'connected', message: '' } }),
  connectionError: state({ ...enabled, connection: { state: 'error', message: '飞书连接失败，请检查应用凭据、网络和事件订阅设置' } }),
  connectionErrorSettings: state({ ...enabled, connection: { state: 'error', message: '飞书连接失败，请检查应用凭据、网络和事件订阅设置' } }, 'inbox', { kind: 'settings' }),
  long: state(long, 'inbox', null, long.projects),
  longTask: state(long, 'tasks', { kind: 'task', id: 'task-1' }, long.projects),
  longDecision: state(long, 'inbox', { kind: 'task', id: 'task-2' }, long.projects)
})
