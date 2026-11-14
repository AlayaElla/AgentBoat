import { fresh, submitTask } from './store'
import type { ProjectRef, Snapshot } from './model'

export const refs: ProjectRef[] = [
  { id: 'p1', name: '示例项目', repoId: 'repo1', hostId: 'local', path: 'D:\\Example\\one', workspace: 'id:repo1::D:\\Example\\one' },
  { id: 'p2', name: '示例项目', repoId: 'repo2', hostId: 'local', path: 'D:\\Example\\two', workspace: 'id:repo2::D:\\Example\\two' }
]
export const deliverable = { id: 'task-1', title: '项目首页', goal: '完成可打开的项目首页', phase: 'ready', progress: '本地预览已核对',
  artifacts: [{ id: 'page-v1', label: '首页预览', version: 'v1', url: 'https://example.com/preview' }],
  acceptance: [{ id: 'page-check', title: '首页布局', details: '打开预览，核对标题、主按钮和窄窗口布局。', artifactIds: ['page-v1'] }] }
export function sample(): Snapshot {
  const p = fresh(refs[0]); p.runId = 'run_example'
  submitTask(p, deliverable)
  submitTask(p, { id: 'task-2', title: '确定首页风格', goal: '选择希望采用的视觉方向', phase: 'blocked', decisions: [{ id: 'style', question: '首页采用哪种风格？', options: ['简洁明亮', '深色科技'] }] })
  return { project: p, projects: refs, secretSaved: false, connection: { state: 'off', message: '' } }
}
// Long names and long content: what a narrow panel has to wrap, cut or hand over to the task record.
export function longSample(): Snapshot {
  const ref = { ...refs[0], name: '名称特别长的示例项目-用于检查窄面板中的项目选择与标题换行', path: 'D:\\Workspace\\Clients\\2026\\Very-Long-Client-Name\\Products\\Example-Application\\repositories\\main' }
  const p = fresh(ref); p.runId = 'run_example'
  submitTask(p, { ...deliverable, title: '重新设计整个项目首页并补齐窄窗口、深色主题与无障碍核对的交付说明'.repeat(2), progress: '第一行进展\n第二行进展'.repeat(40),
    artifacts: [{ ...deliverable.artifacts[0], label: '首页预览'.repeat(20) }], acceptance: [{ ...deliverable.acceptance[0], details: '核对步骤。'.repeat(300) }] })
  submitTask(p, { id: 'task-2', title: '确定首页风格', goal: '选择希望采用的视觉方向', phase: 'blocked',
    decisions: [{ id: 'style', question: '首页采用哪种风格？'.repeat(120), options: ['选项说明很长'.repeat(30), '深色科技'] }] })
  submitTask(p, { id: 'task-3', title: '确定导航结构', goal: '选择导航方案', phase: 'blocked',
    decisions: [{ id: 'nav', question: '导航采用哪个方案？', options: ['顶部导航，参考 https://example.com/design/navigation/top-bar-with-search', '侧边导航'] }] })
  return { project: p, projects: [ref, refs[1]], secretSaved: false, connection: { state: 'off', message: '' } }
}
