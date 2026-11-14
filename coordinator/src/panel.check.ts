import { defineCheck } from 'orca/testing'
import { sample, longSample, refs, deliverable } from './fixtures'
import { fresh, overview, receiveEvent, submitTask } from './store'
import type { Snapshot } from './model'
import type { LinksSnapshot } from './links'

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

const long = longSample()
const links: LinksSnapshot = { version: 1, revision: 0, workspaceId: 'preview-own', name: '我的工作间', enabled: false, host: '127.0.0.1', port: 0, publicUrl: '', tls: false, listening: '', error: '',
  peers: [{ id: 'preview-connection', workspaceId: 'preview-other', name: '设计工作间', endpoint: '', state: 'active', status: 'connected', scope: 'none', projectIds: [], acceptTasks: 'deny', receivedAt: '2026-11-14T10:00:00Z',
    report: { workspaceId: 'preview-other', name: '设计工作间', scope: 'details', acceptTasks: 'confirm', updatedAt: '2026-11-14T10:00:00Z', projects: [{ id: 'shared-project', name: '展览网页', updatedAt: '', counts: { working: 1, review: 1 }, pending: 1,
      tasks: [{ title: '首页设计', phase: 'ready', decisions: [], acceptance: ['核对首页布局'] }, { title: '移动端适配', phase: 'working', decisions: [], acceptance: [] }] }] } }] }

const state = (s: Snapshot, view: unknown = null, list = refs) => ({
  requests: { 'projects.list': () => ({ projects: list }), 'project.read': () => s,
    'workspace.overview': () => overview([s.project!], { version: 1, revision: 0, runId: '', requests: [] }) },
  persisted: { plugin: { 'workspace.page': { page: { kind: view && typeof view === 'object' ? (view as any).kind === 'settings' ? 'project-settings' : 'task' : 'project', projectId: 'p1', ...(view && typeof view === 'object' ? { id: (view as any).id } : {}) }, stack: [{ kind: 'home' }] } } }
})
export default defineCheck({
  otherWorkspaces: { requests: { 'projects.list': () => ({ projects: [] }), 'workspace.overview': () => ({ ...overview([], { version: 1, revision: 0, runId: '', requests: [] }), links }) } },
  fresh: { requests: { 'projects.list': () => ({ projects: refs }), 'workspace.overview': () => overview([pending.project!, fresh(refs[1])], { version: 1, revision: 0, runId: '', requests: [] }) } },
  noProjects: { requests: { 'projects.list': () => ({ projects: [] }), 'workspace.overview': () => overview([], { version: 1, revision: 0, runId: '', requests: [] }) } },
  listError: { requests: { 'workspace.overview': () => overview([], { version: 1, revision: 0, runId: '', requests: [] }, '无法读取 Orca 项目：请检查 Orca 与 CLI 路径') } },
  unbound: state(unbound),
  inbox: state(pending),
  rereview: state(secondVersion),
  tasks: state(modifying),
  taskRecord: state(modifying, { kind: 'task', id: 'task-1' }),
  messages: state(withMessages),
  unconfirmed: state(withMessages),
  settings: state(pending, { kind: 'settings' }),
  long: state(long, null, long.projects),
  longTask: state(long, { kind: 'task', id: 'task-1' }, long.projects),
  longDecision: state(long, { kind: 'task', id: 'task-2' }, long.projects)
})
