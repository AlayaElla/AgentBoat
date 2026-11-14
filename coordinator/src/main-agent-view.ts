import type { WorkspaceBinding } from './model'

export const agentName = (v = '') => ({ claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' }[v] || v || '未知')
export const mainAgentStates = {
  online: { label: '在线', tone: 'success' },
  unknown: { label: '待命', tone: 'neutral' },
  offline: { label: '离线', tone: 'warning' }
} as const
export function bindingRows(w: WorkspaceBinding) {
  const s = w.session
  return [
    { label: '会话', value: s?.title || '未知' }, { label: '会话编号', value: s?.handle || '未知' },
    { label: '工作区', value: s?.workspaceName || '未知' }, { label: '工作区编号', value: s?.workspace || '未知' },
    { label: '目录', value: s?.path || '未知' }, { label: 'Agent', value: agentName(s?.agent) },
    { label: 'Run', value: w.runId || '未绑定' }, { label: '绑定时间', value: w.boundAt || '未知' },
    { label: '身份资料', value: w.verification ? 'Run 存在、会话资料：插件核实；Run 归属：会话自报' : '旧记录核实来源未知' },
    ...(w.securityBoundary ? [{ label: '授权边界', value: w.securityBoundary }] : []),
    { label: '在线状态', value: s ? mainAgentStates[s.online].label : '未知' },
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
