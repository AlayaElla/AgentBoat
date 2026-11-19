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
  return { project: p, projects: refs }
}
