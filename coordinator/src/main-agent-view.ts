import type { WorkspaceBinding } from './model'

export const agentName = (v = '') => ({ claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' }[v] || v || '未知')
export function bindingRows(w: WorkspaceBinding) {
  const s = w.session
  return [
    { label: '会话', value: s?.title || '未知' }, { label: '会话编号', value: s?.handle || '未知' },
    { label: '工作区', value: s?.workspaceName || '未知' }, { label: '工作区编号', value: s?.workspace || '未知' },
    { label: '目录', value: s?.path || '未知' }, { label: 'Agent', value: agentName(s?.agent) },
    { label: 'Run', value: w.runId || '未绑定' }, { label: '绑定时间', value: w.boundAt || '未知' },
    { label: '在线状态', value: s?.online === 'online' ? '在线' : s?.online === 'offline' ? '离线' : '未知' },
    { label: '同时担任项目主 agent', value: w.projectNames?.length ? w.projectNames.join('、') : w.projectNames ? '无' : '未知' },
    ...(w.previousNotice ? [{ label: '原主 agent 通知', value: w.previousNotice === 'sent' ? '已发送' : w.previousNotice === 'uncertain' ? '结果待核对，不会自动重发' : '待发送' }] : [])
  ]
}
export function takeoverText(w: WorkspaceBinding) {
  const t = w.takeover
  if (!t) return ''
  const target = t.target.title || t.target.handle || t.target.workspaceName || '目标会话'
  if (Date.parse(t.expiresAt) <= Date.now()) return `接管凭据已过期 · ${target}，可重新发起`
  return `${t.state === 'uncertain' ? '接管消息或启动结果待核对，不会自动重试' : t.state === 'sending' ? '正在请求接管' : `等待 ${target} 接管`} · 有效至 ${t.expiresAt}`
}
