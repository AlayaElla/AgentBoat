import type {} from 'orca/frame'
import './protocol'
import { agentName, groupedAttention, labels, taskState, requestState, requestStates, scopes, rules, statuses, connectionStates, roles, mainAgentStates } from './model'
import type { Overview, Project, Task } from './model'
import type { AgentsSnapshot, LiveAgent } from './model'
import type { LinksSnapshot } from './links'

type Page = { kind: string; projectId?: string; id?: string; pid?: string }
type Draft = { taskId: string; kind: 'acceptance' | 'decision'; itemId: string; itemRevision?: number; fingerprint?: string; signature: string; title: string; result?: string; answer?: string; note?: string }
const root = document.getElementById('panel')!
const req = (name: string, input?: any): Promise<any> => input === undefined
  ? orca.plugin.request(name as any)
  : orca.plugin.request(name as any, JSON.parse(JSON.stringify(input)))
let all: Overview, live: AgentsSnapshot = { ok: false, at: 0, agents: [] }, current: Project | null = null, projectLead = ''
let page: Page = { kind: 'home' }, stack: { page: Page; y: number }[] = [], opened: Record<string, boolean> = { self: true }
let drafts: Record<string, Record<string, Draft>> = {}, form: Record<string, any> = {}, detail: any, targets: any
let error = '', notice = '', busy = false, more = false, tab = 'inbox', epoch = 0
let persistChain: Promise<unknown> = Promise.resolve()
const persist = (key: string, value: any) => {
  const copy = structuredClone(value)
  persistChain = persistChain.catch(() => {}).then(() => orca.storage.set(key, copy)).catch(e => { error = `草稿保存失败：${e.message}`; render() })
}
const remember = () => persist('panel.home', { page, stack, opened, y: root.scrollTop })
const key = (t: string, k: string, id: string) => JSON.stringify([t, k, id])
const choices = () => drafts[page.projectId || ''] ?? {}
const peers = () => all.links?.peers ?? []
const peer = () => peers().find(p => p.id === page.id)
const pending = (p?: string) => groupedAttention(all.attention).filter(a => !p || a.projectId === p)
const needs = () => live.ok ? live.agents.filter(a => a.state === 'need') : []
const requests = () => all.links?.requests ?? []
const incoming = () => requests().filter(r => r.direction === 'incoming' && requestState(r) === 'confirm')
const total = () => pending().length + needs().length + incoming().length
const projectCount = (id: string) => pending(id).length + needs().filter(a => a.projectId === id).length
const projectAgents = (id?: string) => live.ok ? live.agents.filter(a => !id || a.projectId === id) : []
const relative = (at?: number | string) => {
  if (!at) return '未知'
  const n = Date.now() - (typeof at === 'number' ? at : Date.parse(at))
  return !Number.isFinite(n) ? '未知' : n < 60000 ? '刚刚' : n < 3600000 ? `${Math.floor(n / 60000)} 分钟前` : n < 86400000 ? `${Math.floor(n / 3600000)} 小时前` : new Date(at).toLocaleString()
}
function el(tag: string, attrs: Record<string, any> = {}, ...children: any[]): HTMLElement {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else if (['value', 'checked', 'disabled', 'open'].includes(k)) (e as any)[k] = v
    else e.setAttribute(k, String(v))
  }
  e.append(...children.flat(12).filter(v => v !== undefined && v !== null && v !== false).map(v => v instanceof Node ? v : document.createTextNode(String(v))))
  return e
}
const row = (...c: any[]) => el('div', { class: 'row g2 wrap' }, c)
const section = (title: string, ...c: any[]) => {
  const action = c[0] instanceof HTMLElement && (c[0].matches('button') || c[0].tagName === 'SPAN' && c[0].firstElementChild?.matches('button')) ? c.shift() : null
  return el('section', { class: 'sec', 'aria-label': title }, el('div', { class: 'sec-h between' }, el('h2', { class: 'h2' }, title), action), c)
}
const small = (s: string) => el('span', { class: 'muted xs any' }, s)
const card = (...c: any[]) => el('div', { class: 'card' }, c)
const dot = (cls = '', label = '') => el('span', { class: `dot ${cls}`, role: label ? 'img' : undefined, 'aria-label': label || undefined, 'aria-hidden': label ? undefined : 'true' })
const pill = (n: number) => n ? el('span', { class: 'pill' }, n) : null
const tag = (t: string, tone = '') => el('span', { class: `tag ${tone}` }, t)
const callout = (text: string, tone = '') => el('div', { class: `callout ${tone}`, role: tone === 'danger' ? 'alert' : 'status' }, text)
function button(text: string, action: () => any, cls = '', disabled = false, title = '') {
  return el('button', { type: 'button', class: `btn ${cls}`, disabled: disabled || busy, title: title || text, 'aria-label': cls.includes('icon') ? title || text : undefined, onclick: () => { void action() } }, text)
}
const item = (title: string, summary: string, action: () => any, extra?: any) => el('button', { type: 'button', class: 'item', 'aria-label': title, 'aria-description': summary, onclick: () => { void action() }, title }, extra?.classList?.contains('dot') ? extra : null, el('span', { class: 'body' }, el('span', { class: 'trunc' }, title), small(summary)), !extra?.classList?.contains('dot') ? extra : null, '›')
function input(label: string, initial: any = '', type = 'text', change?: (value: string) => void, placeholder?: string) {
  const name = label
  if (!(name in form)) form[name] = initial
  const e = el(type === 'textarea' ? 'textarea' : 'input', { class: 'in', type: type === 'textarea' ? undefined : type, value: form[name], placeholder, 'data-focus': name, maxlength: type === 'password' ? 4096 : 8000,
    oninput: (e: Event) => { const value = (e.target as HTMLInputElement).value; form[name] = value; change?.(value) } })
  return el('label', { class: 'field' }, el('span', { class: 'lb' }, label.startsWith('修改意见 ') ? '修改意见' : label.startsWith('决定 ') ? '你的决定' : label), e)
}
function select(label: string, options: Record<string, string>, initial: string, change?: (v: string) => void) {
  if (!(label in form)) form[label] = initial
  const s = el('select', { class: 'in', 'aria-label': label, 'data-focus': label, onchange: (e: Event) => { form[label] = (e.target as HTMLSelectElement).value; change?.(form[label]) } }, Object.entries(options).map(([v, t]) => el('option', { value: v }, t))) as HTMLSelectElement
  s.value = form[label]
  return el('label', { class: 'field' }, el('span', { class: 'lb' }, label), el('span', { class: 'sel' }, s))
}
function check(label: string, checked: boolean, change: (v: boolean) => void, type = 'checkbox', name?: string, value?: string) {
  return el('label', { class: 'opt' }, el('input', { type, checked, name, value, onchange: (e: Event) => change((e.target as HTMLInputElement).checked) }), el('span', { class: 'any' }, label))
}
function tabs() {
  return el('div', { class: 'tabs', role: 'tablist', 'aria-label': '项目页面', onkeydown: (e: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    e.preventDefault(); const buttons = Array.from(root.querySelectorAll<HTMLElement>('[role=tab]')), at = buttons.indexOf(document.activeElement as HTMLElement)
    buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]?.click()
    root.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus()
  } }, [['inbox', '待处理'], ['tasks', '任务'], ['agents', 'Agent'], ['messages', '消息']].map(([v, text]) => el('button', { type: 'button', role: 'tab', class: 'tab', tabindex: tab === v ? 0 : -1, 'aria-selected': String(tab === v), onclick: () => { tab = v; render() } }, text)))
}
async function act(work: () => Promise<void>) {
  if (busy) return
  busy = true; error = ''; render()
  try { await work() } catch (e) { error = e instanceof Error ? e.message : '未完成，请刷新核对；不要重复发送' }
  finally { busy = false; render() }
}
async function loadPage() {
  const n = epoch, p = page
  const [snapshot, connection, sessions] = await Promise.all([
    p.projectId ? req('project.read', { projectId: p.projectId }) : null,
    p.kind === 'connection' && p.id ? req('workspace.connections', { operation: 'read', connectionId: p.id }) : null,
    p.kind === 'main' ? req('workspace.agent.targets') : null
  ])
  if (n !== epoch) return
  current = snapshot?.project ?? null; projectLead = snapshot?.mainAgent ?? ''; detail = connection; targets = sessions
  if (current) reconcile(current)
}
async function go(next: Page, reset = false) {
  stack = reset ? [] : [...stack, { page, y: root.scrollTop }]; page = next; form = {}; detail = null; current = null; epoch++; error = ''; notice = ''; tab = 'inbox'
  remember(); render(0)
  try { await loadPage() } catch (e) { error = (e as Error).message }
  render(0); root.querySelector<HTMLElement>('[data-heading]')?.focus()
}
async function back() {
  const prev = stack.pop() ?? { page: { kind: 'home' }, y: 0 }; page = prev.page; form = {}; current = null; epoch++; error = ''; notice = ''
  remember(); await loadPage().catch(e => { error = e.message }); render(prev.y); root.querySelector<HTMLElement>('[data-heading]')?.focus()
}
async function refresh(forceAgents = false) {
  const n = epoch
  try {
    const [overview, agents] = await Promise.all([req('workspace.overview'), req('workspace.agents', { refresh: forceAgents })])
    if (n !== epoch) return
    all = overview; live = agents
    opened = Object.fromEntries(Object.entries(opened).filter(([id]) => id === 'self' || peers().some(p => p.id === id && p.status !== 'revoked')))
    for (const id of Object.keys(drafts)) if (![...all.projects.map(p => p.ref.id), ...(all.hidden ?? []).map(p => p.id)].includes(id)) delete drafts[id]
    await loadPage(); render()
  } catch (e) { error = `读取失败：${(e as Error).message}`; render() }
}
function reconcile(p: Project) {
  let stale = 0
  for (const [k, d] of Object.entries(drafts[p.ref.id] ?? {})) {
    const t = p.tasks.find(t => t.id === d.taskId), a = d.kind === 'acceptance' ? t?.acceptance.find(a => a.id === d.itemId) : t?.decisions.find(a => a.id === d.itemId)
    const valid = t && t.phase !== 'paused' && a && (d.kind === 'acceptance' ? t.phase === 'ready' && 'status' in a && a.status === 'pending' && a.revision === d.itemRevision && a.fingerprint === d.fingerprint : 'answer' in a ? a.answer === undefined && JSON.stringify([a.question, a.options]) === d.signature : 'question' in a && JSON.stringify([a.question, a.options]) === d.signature)
    if (!valid) { delete drafts[p.ref.id][k]; stale++ }
  }
  if (stale) { notice = `${stale} 条已更新或已处理，原选择已作废；其余选择保留，请重新查看后提交。`; persist('panel.drafts', drafts) }
}
function choose(d: Draft) {
  delete form.feedbackRequestId
  drafts[page.projectId!] ??= {}; drafts[page.projectId!][key(d.taskId, d.kind, d.itemId)] = d
  persist('panel.drafts', drafts)
}
function agentRow(a: LiveAgent, full = false) {
  const duration = a.state === 'done' ? `${relative(a.since)}完成` : `${a.state === 'need' ? '等你' : '工作中'} · ${relative(a.since)}开始`
  const line = el('div', { class: 'arow' }, dot(a.state === 'need' ? 'need' : a.state === 'work' ? 'work' : 'ok'), el('span', { class: 'none' }, agentName(a.agent)), el('span', { class: 'grow trunc' }, a.title), small(duration))
  return full ? el('article', { class: 'aitem', 'data-st': a.state }, line, small(`${a.role === 'worker' ? 'worker' : '会话'} · ${all.projects.find(p => p.ref.id === a.projectId)?.ref.name || '其他项目'}`)) : line
}
function agentsPage(id?: string) {
  if (!live.ok) return null
  const list = projectAgents(id)
  return el('div', { class: 'cols3' }, ['need', 'work', 'done'].map(state => {
    const selected = list.filter(a => a.state === state).sort((a, b) => b.since - a.since), visible = state === 'done' ? selected.slice(0, 20) : selected
    return el('section', { class: 'acol', 'aria-label': ({ need: '需要你', work: '工作中', done: '已完成' } as any)[state] }, row(el('h2', { class: 'h2' }, ({ need: '需要你', work: '工作中', done: '已完成' } as any)[state]), tag(String(selected.length))), visible.map(a => agentRow(a, true)), !selected.length ? small('暂无') : null, selected.length > visible.length ? small(`另有 ${selected.length - visible.length} 条未列出`) : null)
  }))
}
function ownProjects() {
  const projects = all.projects.filter(p => !form['找项目'] || p.ref.name.toLowerCase().includes(form['找项目'].toLowerCase()))
  const projectCard = (p: Overview['projects'][number]) => {
    const agents = projectAgents(p.ref.id), unfinished = agents.filter(a => a.state !== 'done').slice(0, 3), done = agents.filter(a => a.state === 'done').length
    return el('article', { class: 'pcard', 'data-project': p.ref.id },
      el('button', { type: 'button', class: 'pcard-h', title: p.ref.name, onclick: () => { void go({ kind: 'project', projectId: p.ref.id }) } }, el('span', { class: 'name grow trunc' }, p.ref.name), pill(projectCount(p.ref.id)), '›'),
      agents.length ? el('div', { class: 'pcard-b' }, unfinished.map(a => agentRow(a)), done ? small(`✓ 已完成 ${done} 个`) : null) : null)
  }
  return [all.projects.length > 12 ? input('找项目', '', 'search', () => render(), '输入项目名') : null, ...(all.machines ?? [{ id: 'local', name: '', role: 'host' }]).map(m => {
    const list = projects.filter(p => p.ref.hostId === m.id), active = list.filter(p => Object.values(p.counts).some(Boolean) || projectAgents(p.ref.id).some(a => a.state !== 'done')), idle = list.filter(p => !active.includes(p))
    return el('div', { class: 'stack g2' }, (all.machines?.length ?? 0) > 1 ? small(`${m.role === 'host' ? '主机' : '电脑'} · ${m.name}`) : null, el('div', { class: 'cards' }, active.sort((a, b) => projectCount(b.ref.id) - projectCount(a.ref.id)).map(projectCard)), idle.length ? el('details', { class: 'fold', open: !!form['找项目'] }, el('summary', {}, `还没有任务的项目 ${idle.length} 个`), el('div', { class: 'cards' }, idle.map(projectCard))) : null)
  }), !all.projects.length ? small('还没有项目，在 Orca 中添加项目后会显示在这里。') : null]
}
function dispatchReason(p: LinksSnapshot['peers'][number]) {
  return !all.workspace.runId ? '先设置主 agent，再派活' : p.status === 'pending' || p.status === 'revoked' ? '先核对有效连接' : p.report?.acceptTasks === 'deny' ? '对方不接受派活；关系不改变权限' : ''
}
function dispatchButton(p: LinksSnapshot['peers'][number]) {
  const reason = dispatchReason(p)
  return el('span', { title: reason }, button('派活', () => go({ kind: 'dispatch', id: p.id }), 'sm', !!reason, reason))
}
function workspaceNode(p?: LinksSnapshot['peers'][number]) {
  const id = p?.id ?? 'self', open = opened[id] ?? false, active = !p || p.status === 'connected', report = active ? p?.report : null
  const unfinished = requests().filter(r => r.peerId === id && !['rejected', 'completed', 'failed', 'disconnected'].includes(requestState(r)))
  const flagged = p?.relation === 'below' && report?.scope === 'details' && report.projects.some(pr => pr.tasks?.some(t => t.phase === 'blocked'))
  const body = !p ? [row(small(`你的工作间${all.machines?.[0] ? ` · ${all.machines[0].name}` : ''}`), button('全部 agent', () => go({ kind: 'agents' }), 'text sm')),
    el('button', { type: 'button', class: 'lead', onclick: () => { void go({ kind: 'main' }) } }, dot(all.workspace.session?.online === 'online' ? 'ok' : ''), el('span', { class: 't' }, '主 agent'), el('span', { class: 'grow trunc xs muted' }, all.workspace.runId ? `${agentName(all.workspace.session?.agent)} · ${all.workspace.session?.title || ''} · ${all.workspace.session ? mainAgentStates[all.workspace.session.online].label : '未知'}` : '还没有主 agent'), '›'),
    el('div', { class: 'under' }, row(small('外部连接'), all.connections?.map(c => button(c.name, () => go({ kind: 'connection', id: c.id }), 'text sm')), button('＋', () => go({ kind: 'add-connection' }), 'text sm')), ownProjects())]
    : [row(small(active ? `已连接 · ${relative(p.receivedAt)}同步` : `离线 · 最后同步 ${relative(p.lastSyncAt)}`), button('连接设置', () => go({ kind: 'peer', id }), 'text sm')),
      section('项目', !active ? small('未知') : !report?.projects.length ? small('对方没有向你开放项目') : el('div', { class: 'cards' }, report.projects.map(pr => el('div', { class: 'pcard' }, item(pr.name, pr.counts.working ? `在做 ${pr.counts.working}` : pr.counts.review ? '等对方验收' : '项目进展', () => go({ kind: 'peer-project', id, pid: pr.id })))))),
      section('请求', dispatchButton(p), unfinished.map(r => el('div', { class: 'pcard' }, item(r.title, requestStates[requestState(r)], () => go({ kind: 'request', id: r.id })))), !unfinished.length ? small('暂无请求') : null)]
  return el('article', { class: `wsr ${p ? '' : 'me'}`, 'data-workspace': id }, el('div', { class: 'wsr-top' },
    el('button', { type: 'button', class: 'wsr-h', 'aria-expanded': String(open), 'aria-controls': `workspace-${id}`, title: p ? `${p.name} · ${p.relation ? { above: '你标的上级', below: '你标的下级', peer: '你标的平级' }[p.relation] : '还没标关系'}` : '我的工作间', onclick: () => { opened[id] = !open; remember(); render() } },
      dot(active ? 'ok' : '', active ? '已连接' : '离线'), flagged ? dot('bad flag', '有受阻的任务') : null, el('span', { class: 'name trunc' }, p?.name ?? all.links?.name ?? '我的工作间'), !p ? tag('我', 'solid') : null,
      el('span', { class: 'sum trunc xs muted' }, p ? !active ? `离线 · 最后同步 ${relative(p.lastSyncAt)}` : [report?.projects.length ? `${report.projects.length} 个项目` : '', unfinished.length ? `${unfinished.length} 个请求` : ''].filter(Boolean).join(' · ') : `${all.projects.length} 个项目`), pill(p ? incoming().filter(r => r.peerId === id).length : pending().length + needs().length), '›'),
    p && !p.relation ? button('标关系', () => go({ kind: 'relation', id }), 'sm') : null), open ? el('div', { class: 'wsr-b', id: `workspace-${id}` }, body) : null)
}
function home() {
  const entries = [...needs().map(a => item(a.title, `agent 等你 · ${agentName(a.agent)}`, () => go({ kind: 'agents' }), dot('need'))), ...pending().map(a => item(a.title, `${a.kind === 'review' ? `${a.count} 项成果等你验收` : a.kind === 'decision' ? '待决定' : '受阻'} · ${all.projects.find(p => p.ref.id === a.projectId)?.ref.name || ''}`, () => go({ kind: 'task', projectId: a.projectId, id: a.taskId }), dot(a.kind === 'blocked' ? 'bad' : 'need'))), ...incoming().map(r => item(r.title, `来自 ${peers().find(p => p.id === r.peerId)?.name || ''} · 待你确认`, () => go({ kind: 'request', id: r.id }), dot('need')))]
  const direct = peers().filter(p => ['connected', 'offline'].includes(p.status)), up = direct.filter(p => p.relation === 'above'), down = direct.filter(p => p.relation === 'below').sort((a, b) => Number(incoming().some(r => r.peerId === b.id)) - Number(incoming().some(r => r.peerId === a.id)) || Number(a.status === 'offline') - Number(b.status === 'offline')), side = direct.filter(p => p.relation === 'peer'), free = direct.filter(p => !p.relation)
  return [!all.workspace.runId ? callout('还没有主 agent，请在设置中绑定。') : null, peers().some(p => p.status === 'pending') ? button('有工作间连接待核对', () => go({ kind: 'links' }), 'text') : null,
    all.error ? callout(all.error, 'danger') : null, all.links?.error ? callout(all.links.error, 'danger') : null,
    all.connections?.filter(c => c.enabled && c.state === 'error').map(c => button(`外部连接「${c.name}」异常`, () => go({ kind: 'connection', id: c.id }), 'text')),
    Object.entries(drafts).filter(([, d]) => Object.keys(d).length).map(([id, d]) => button(`${all.projects.find(p => p.ref.id === id)?.ref.name || '项目'} 有 ${Object.keys(d).length} 条选好了还没提交`, () => go({ kind: 'project', projectId: id }), 'text')),
    el('div', { class: 'home' }, el('section', { class: `inbox ${entries.length ? '' : 'none'}`, 'aria-label': '等你处理' }, el('div', { class: 'sec-h' }, el('h2', { class: 'h2' }, '等你处理'), pill(total())), entries.slice(0, more ? undefined : 3), entries.length > 3 && !more ? button(`再看 ${entries.length - 3} 条`, () => { more = true; render() }, 'text sm') : null, !entries.length ? small('没有要你处理的事') : null),
    section('组织', button('＋ 连接', () => go({ kind: 'links' }), 'text sm'), el('div', { class: 'org' }, up.length ? el('div', { class: 'org-up', role: 'group', 'aria-label': '上级' }, up.map(p => workspaceNode(p))) : null,
      el('div', { class: `org-in ${up.length || side.length ? 'l1' : ''} ${up.length ? 'up' : ''}` }, el('div', { class: `org-self ${side.length ? 'sib' : ''}` }, workspaceNode(), down.length ? el('div', { class: 'org-kids', role: 'group', 'aria-label': '下级' }, down.length > 8 ? el('div', { class: 'org-tools' }, input('找工作间', '', 'search', () => render())) : null, down.filter(p => !form['找工作间'] || p.name.includes(form['找工作间'])).map(p => workspaceNode(p))) : null), side.length ? el('div', { class: 'org-side', role: 'group', 'aria-label': '平级' }, side.map(p => workspaceNode(p))) : null), free.length ? el('div', { class: 'org-free', role: 'group', 'aria-label': '还没标关系' }, free.map(p => workspaceNode(p))) : null)))]
}
function feedbackCards(tasks: Task[]) {
  return tasks.map(t => {
    const acceptance = t.phase === 'ready' ? t.acceptance.filter(a => a.status === 'pending') : []
    return section(t.title, acceptance.length > 1 ? button(`这 ${acceptance.length} 项全部通过`, () => { for (const a of acceptance) choose({ taskId: t.id, kind: 'acceptance', itemId: a.id, itemRevision: a.revision, fingerprint: a.fingerprint, signature: a.fingerprint, title: a.title, result: 'passed' }); render() }, 'sm') : null,
      t.decisions.filter(d => d.answer === undefined).map(d => {
        const k = key(t.id, 'decision', d.id), draft = choices()[k], base: Draft = { taskId: t.id, kind: 'decision', itemId: d.id, title: d.question, signature: JSON.stringify([d.question, d.options]) }
        return card(el('h3', { class: 'h2 any' }, d.question), ...[...d.options, '其他'].map(option => check(option, draft?.answer === option || option === '其他' && !!draft?.answer && !d.options.includes(draft.answer), () => { choose({ ...base, answer: option === '其他' ? '' : option }); form[`决定 ${k}`] = ''; render() }, 'radio', k, option)), draft && !d.options.includes(draft.answer ?? '') ? input(`决定 ${k}`, draft.answer ?? '', 'textarea', value => { choose({ ...base, answer: value }); renderSheet() }) : null, draft ? button('撤销', () => { delete choices()[k]; persist('panel.drafts', drafts); render() }, 'text sm') : null)
      }), acceptance.map(a => {
        const k = key(t.id, 'acceptance', a.id), draft = choices()[k], base: Draft = { taskId: t.id, kind: 'acceptance', itemId: a.id, itemRevision: a.revision, fingerprint: a.fingerprint, signature: a.fingerprint, title: a.title }
        return card(row(el('h3', { class: 'h2 any grow' }, a.title), tag(`第 ${a.revision} 版`)), el('p', { class: 'any' }, a.details), t.artifacts.filter(ar => a.artifactIds.includes(ar.id)).map(ar => button(`打开成果 · ${ar.label}`, () => /^https?:/i.test(ar.url) ? orca.shell?.openExternal(ar.url) : req('project.openArtifact', { projectId: page.projectId, taskId: t.id, artifactId: ar.id }), 'sm')),
          row(...['passed', 'changes_requested'].map(result => { const b = button(result === 'passed' ? '通过' : '需要修改', () => { choose({ ...base, result, note: draft?.note ?? '' }); render() }, 'sm'); b.setAttribute('aria-pressed', String(draft?.result === result)); return b }), draft ? button('撤销', () => { delete choices()[k]; persist('panel.drafts', drafts); render() }, 'text sm') : null), draft?.result === 'changes_requested' ? input(`修改意见 ${k}`, draft.note ?? '', 'textarea', note => { choose({ ...draft, note }); renderSheet() }) : null)
      }), t.phase === 'blocked' ? callout(t.progress || t.goal, 'danger') : null)
  })
}
function renderSheet() {
  root.querySelector('[data-sheet]')?.remove()
  if (!['project', 'task'].includes(page.kind)) return
  const selected = Object.values(choices())
  if (!selected.length) return
  const invalid = selected.some(d => d.kind === 'decision' ? !d.answer?.trim() : d.result === 'changes_requested' && !d.note?.trim())
  root.append(el('section', { class: 'sheet', 'data-sheet': '', 'aria-label': '批量提交' }, small(invalid ? '有条目还没写内容' : `已选 ${selected.length} 条`), row(button(`提交 ${selected.length} 条`, submitFeedback, 'primary', invalid), button('清空', () => { drafts[page.projectId!] = {}; persist('panel.drafts', drafts); render() }))))
}
async function submitFeedback() {
  await act(async () => {
    const id = page.projectId!, before = Object.keys(choices()).length, s = await req('project.read', { projectId: id }); current = s.project; reconcile(current!)
    if (Object.keys(choices()).length !== before) { notice = `这次一条都没有提交。${notice}`; return }
    const items = await Promise.all(Object.values(choices()).map(async d => {
      let fingerprint = d.fingerprint
      if (d.kind === 'decision') fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(d.signature)))].map(v => v.toString(16).padStart(2, '0')).join('')
      return { taskId: d.taskId, kind: d.kind, itemId: d.itemId, itemRevision: d.itemRevision, result: d.result, note: d.note, answer: d.answer, fingerprint }
    }))
    form.feedbackRequestId ??= crypto.randomUUID()
    try {
      const result = await req('project.feedback', { projectId: id, requestId: form.feedbackRequestId, items })
      current = result.project; drafts[id] = {}; persist('panel.drafts', drafts); notice = `已提交 ${items.length} 条，已记录一条汇总通知。`; delete form.feedbackRequestId
      await refresh()
    } catch (e) {
      const latest = await req('project.read', { projectId: id }); current = latest.project; reconcile(current!)
      error = `这次未确认提交，请核对记录。${notice || (e as Error).message}`
    }
  })
}
function projectPage() {
  if (!current) return callout('正在读取项目…')
  const p = current
  if (page.kind === 'project-settings') return [section('分工', small(`项目主 agent：${p.runId ? agentName(projectLead) : '未绑定'}`), ...Object.entries(roles).map(([k, title]) => select(title, { claude: 'Claude', codex: 'Codex' }, p.roles[k as keyof typeof roles])), button('保存', () => act(async () => { const s = await req('project.settings', { projectId: p.ref.id, revision: p.revision, roles: { design: form['设计'], code: form['代码'], review: form['审查'] } }); current = s.project; notice = '已保存' }), 'primary')),
    section('开放给了谁', peers().filter(peer => peer.scope !== 'none' && peer.projectIds.includes(p.ref.id)).map(peer => small(peer.name))), small(`目录：${p.ref.path}`), button('导出记录', () => orca.files?.saveAs({ suggestedName: 'project-record.json', mimeType: 'application/json', data: JSON.stringify(p, null, 2) })),
    button(p.hidden ? '恢复显示' : '隐藏项目', () => act(async () => { await req('project.visibility', { projectId: p.ref.id, revision: p.revision, hidden: !p.hidden }); delete drafts[p.ref.id]; persist('panel.drafts', drafts); await go({ kind: 'home' }, true); await refresh() })),
    section('删除项目', callout('先导出记录，再从 Orca 移除项目并删除工作间记录，磁盘文件保留。有打开的会话时会拒绝。'), check('确认删除这个项目的全部工作间记录', !!form.delete, v => { form.delete = v; render() }), button('删除项目', () => act(async () => { const result = await req('project.delete', { projectId: p.ref.id, revision: p.revision, confirm: p.ref.id }); delete drafts[p.ref.id]; persist('panel.drafts', drafts); await go({ kind: 'home' }, true); await refresh(); notice = `已删除，记录已导出：${result.exportPath}` }), 'danger', !form.delete))]
  if (page.kind === 'task') {
    const t = p.tasks.find(t => t.id === page.id)
    if (!t) return callout('任务已不存在，请返回项目。')
    return [el('h2', { class: 'h1 any' }, t.title), tag(labels[taskState(t)]), small(`记录里派给了 ${t.executions.map(e => agentName(e.agent)).join('、') || '尚未分派'}`), section('目标', el('p', { class: 'any' }, t.goal)), section('进展', el('p', { class: 'any' }, t.progress)), section('现在谁在做', !live.ok ? null : projectAgents(p.ref.id).filter(a => a.taskId === t.id && a.state !== 'done').length ? projectAgents(p.ref.id).filter(a => a.taskId === t.id && a.state !== 'done').map(a => agentRow(a, true)) : small('没有看到 agent 在做这个任务')), feedbackCards([t]), section('成果', t.artifacts.map(a => button(a.label + ' · ' + a.version, () => /^https?:/i.test(a.url) ? orca.shell?.openExternal(a.url) : req('project.openArtifact', { projectId: p.ref.id, taskId: t.id, artifactId: a.id }), 'sm'))), section('来源消息', p.events.filter(e => t.sourceIds.includes(e.id) || e.taskId === t.id).map(e => card(e.text))), section('记录', ...t.decisions.filter(d => d.answer !== undefined).map(d => small(`${d.question}：${d.answer}`)), ...t.acceptance.filter(a => a.status !== 'pending').map(a => small(`${a.title}：${a.status === 'passed' ? '已通过' : '需要修改'} · ${a.history.at(-1)?.note || ''}`)))]
  }
  return [row(el('h2', { class: 'h1 grow trunc' }, p.ref.name), button('项目设置', () => go({ kind: 'project-settings', projectId: p.ref.id }), 'text sm')), !p.runId ? callout('还没有项目主 agent，请在项目会话中按协作 skill 绑定。') : null, tabs(), el('div', { role: 'tabpanel', class: 'stack g3' }, tab === 'agents' ? agentsPage(p.ref.id) : tab === 'tasks' ? p.tasks.map(t => item(t.title, `${labels[taskState(t)]} · ${relative(t.updatedAt)}`, () => go({ kind: 'task', projectId: p.ref.id, id: t.id }))) : tab === 'messages' ? [section('通知', p.deliveries.map(d => card(d.subject, small(`${d.state === 'uncertain' ? '待核对，不会自动重发' : d.state === 'sent' ? '已通知' : '待通知'}`), small(d.error || ''), d.state === 'pending' ? button('发送通知', () => act(async () => { await req('project.deliver', { projectId: p.ref.id, deliveryId: d.id }); await refresh() })) : null))), section('来源消息', p.events.map(e => card(e.text)))] : feedbackCards(p.tasks.filter(t => t.phase === 'blocked' || t.decisions.some(d => d.answer === undefined) || t.phase === 'ready' && t.acceptance.some(a => a.status === 'pending'))))]
}
function sharingFields(p: LinksSnapshot['peers'][number], defaults?: any) {
  if (!('scope' in form)) Object.assign(form, { scope: p.scope, accept: p.acceptTasks, projectIds: [...p.projectIds] }, defaults)
  const scope = select('开放范围', scopes, form.scope, v => { form.scope = v; form.touched = true; render() }); form['开放范围'] ??= form.scope
  const accept = select('对方给你派活', rules, form.accept, v => { form.accept = v; form.touched = true })
  return [scope, form.scope !== 'none' ? section('开放哪些项目', all.projects.map(pr => check(pr.ref.name, form.projectIds.includes(pr.ref.id), v => { form.touched = true; form.projectIds = v ? [...form.projectIds, pr.ref.id] : form.projectIds.filter((id: string) => id !== pr.ref.id) }))) : null, accept]
}
function peerPage() {
  const p = peer()
  if (!p) return callout('连接不存在，请返回。')
  if (page.kind === 'peer-project') {
    const pr = p.status === 'connected' ? p.report?.projects.find(pr => pr.id === page.pid) : undefined
    return !pr ? callout('现在看不到这个项目') : [el('h2', { class: 'h1 any' }, pr.name), callout(`「${p.name}」开放给你的项目，只读。对方开放的是${scopes[p.report!.scope]}。`), small(`${relative(pr.updatedAt)}更新 · 对方待处理 ${pr.pending}`), row(Object.entries(pr.counts).map(([k, n]) => tag(`${(labels as any)[k] || k} ${n}`))), p.report?.scope === 'details' ? pr.tasks?.map(t => card(t.title, small((labels as any)[t.phase] || t.phase), ...t.decisions.map(q => small(`待决定：${q}`)), ...t.acceptance.map(a => small(`待验收：${a}`)))) : null, dispatchButton(p)]
  }
  if (page.kind === 'dispatch') return [callout(`发给「${p.name}」的主 agent。${p.report ? `对方${rules[p.report.acceptTasks]}派活。` : '离线，连上后才送达；对方接不接受也要到时才知道。'}`), input('要做什么'), input('背景', '', 'textarea'), input('期望结果', '', 'textarea'), input('参考链接（一行一个）', '', 'textarea'), small('只传文字和链接。'), dispatchReason(p) ? callout(dispatchReason(p)) : null, row(button('发出', () => act(async () => {
    const links = String(form['参考链接（一行一个）'] || '').split('\n').map(s => s.trim()).filter(Boolean)
    for (const link of links) { let u: URL; try { u = new URL(link) } catch { throw Error(`链接格式不正确：${link}`) }; if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw Error(`只支持无凭据的 HTTP(S) 链接：${link}`) }
    form.requestId ??= crypto.randomUUID()
    await req('workspace.requests', { operation: 'send', peerId: p.id, requestId: form.requestId, title: form['要做什么'], context: form['背景'], expected: form['期望结果'], links }); await back(); await refresh(); notice = '已记录派活请求'
  }), 'primary', !!dispatchReason(p)), button('取消', back))]
  if (page.kind === 'relation') {
    form.relation ??= p.relation ?? 'none'
    const suggest = (relation: string) => ({ scope: relation === 'above' ? 'summary' : 'none', accept: relation === 'none' ? p.acceptTasks : 'confirm', projectIds: relation === 'above' ? all.projects.map(p => p.ref.id) : [] })
    const proposed = !p.sharingSet && form.relation !== 'none'
    return [callout('关系只保存在你这边，不发给对方，不改变权限。'), ...Object.entries({ above: '上级 · 画在你上面', below: '下级 · 画在你下面', peer: '平级 · 虚线相连', none: '不标 · 不连线' }).map(([value, title]) => check(title, form.relation === value, () => { form.relation = value; if (!form.touched && !p.sharingSet) { const values = suggest(value); Object.assign(form, values, { '开放范围': values.scope, '对方给你派活': values.accept }) }; render() }, 'radio', 'relation', value)), proposed ? section('你这边对它的设置', sharingFields(p, suggest(form.relation))) : p.sharingSet ? callout(`开放设置保持：${scopes[p.scope]} · ${rules[p.acceptTasks]}。新关系建议：${form.relation === 'above' ? '项目摘要 · 全部项目 · 需我确认' : form.relation === 'none' ? '保持设置' : '不开放 · 需我确认'}。`) : null,
      row(button('保存', () => act(async () => { let result = await req('workspace.links', { operation: 'relate', revision: all.links!.revision, id: p.id, relation: form.relation === 'none' ? null : form.relation }); all.links = result; if (proposed) { result = await req('workspace.links', { operation: 'share', revision: result.revision, id: p.id, scope: form.scope, projectIds: form.projectIds, acceptTasks: form.accept }); all.links = result }; await back(); await refresh() }), 'primary', p.state !== 'active'), button('取消', back))]
  }
  return [el('h2', { class: 'h1 any' }, p.name), small(`${statuses[p.status]} · 最后同步 ${relative(p.lastSyncAt)}`), section('关系', small(p.relation ? { above: '上级', below: '下级', peer: '平级' }[p.relation] : '未标'), button('改关系', () => go({ kind: 'relation', id: p.id }), '', p.state !== 'active')), section('对方向你开放', small(p.report ? scopes[p.report.scope] : '未知'), small(p.report ? `你给对方派活：${rules[p.report.acceptTasks]}` : '派活规则未知'), dispatchButton(p)), section('往来请求', requests().filter(r => r.peerId === p.id).map(r => item(r.title, requestStates[requestState(r)], () => go({ kind: 'request', id: r.id })))), section('你向对方开放', sharingFields(p), button('保存', () => act(async () => { all.links = await req('workspace.links', { operation: 'share', revision: all.links!.revision, id: p.id, scope: form.scope, projectIds: form.projectIds, acceptTasks: form.accept }); notice = '已保存' }), 'primary', p.state !== 'active')),
    check('确认断开这个工作间', !!form.revoke, v => { form.revoke = v; render() }), button('断开连接', () => act(async () => { all.links = await req('workspace.links', { operation: 'revoke', id: p.id }); await go({ kind: 'links' }); await refresh() }), 'danger', !form.revoke)]
}
function linksPage() {
  const s = all.links!
  return [input('工作间名称', s.name), check('启用工作间连接', form.enabled ?? s.enabled, v => { form.enabled = v }), input('监听 IP', s.host), input('端口', String(s.port), 'number'), input('访问地址', s.publicUrl), check('TLS', form.tls ?? s.tls, v => { form.tls = v }), input('TLS 证书', '', 'textarea'), input('TLS 私钥', '', 'password'), button('保存连接设置', () => act(async () => { all.links = await req('workspace.links', { operation: 'configure', revision: s.revision, name: form['工作间名称'], enabled: form.enabled ?? s.enabled, host: form['监听 IP'], port: Number(form['端口']), publicUrl: form['访问地址'], tls: form.tls ?? s.tls, certificate: form['TLS 证书'], privateKey: form['TLS 私钥'] }); form['TLS 私钥'] = ''; form['TLS 证书'] = ''; notice = '已保存' }), 'primary'), small(s.listening || '未监听'),
    section('连接工作间', button('生成连接码', () => act(async () => { const result = await req('workspace.links', { operation: 'invite' }); form.invitation = result.invitation; render() })), form.invitation ? card(small(`有效至 ${form.invitation.expiresAt}`), el('code', { class: 'any' }, form.invitation.code), button('取消连接码', () => act(async () => { await req('workspace.links', { operation: 'cancel-invite' }); delete form.invitation }))) : null, input('对方的连接码', '', 'textarea'), button('连接', () => act(async () => { all.links = await req('workspace.links', { operation: 'join', code: form['对方的连接码'] }); form['对方的连接码'] = ''; await refresh() }))),
    section('工作间', peers().map(p => item(p.name, statuses[p.status], () => go({ kind: 'peer', id: p.id }))), peers().some(p => p.status === 'pending') ? button('核对连接', () => act(async () => { all.links = await req('workspace.links', { operation: 'refresh' }); await refresh() })) : null)]
}
function connectionPage() {
  const c = detail?.connection, a = detail?.a2a, f = detail?.feishu, type = c?.type ?? form['类型'] ?? 'a2a'
  if (page.kind === 'connection' && !c) return callout('正在读取连接…')
  return [!c ? select('类型', { a2a: 'A2A agent（Hermes 等）', feishu: '飞书' }, 'a2a', () => render()) : small(type === 'a2a' ? 'A2A agent' : '飞书'), input('名字', c?.name || ''), check('启用这个连接', form.enabled ?? c?.enabled ?? false, v => { form.enabled = v; render() }),
    type === 'a2a' ? [input('对方的地址', a?.url || ''), input('对方的令牌', '', 'password'), input('主 agent 监听端口', String(a?.port ?? 0), 'number'), input('主 agent 的令牌', '', 'password'), a?.listening ? small(a.listening) : null, detail?.approvalMode ? small(`电脑操作的批准：${detail.approvalMode}`) : null, small('令牌已保存时，留空保留。')] : [input('App ID', f?.feishu.appId || ''), input('App Secret', '', 'password'), input('允许的用户', f?.feishu.senderIds.join('\n') || '', 'textarea'), input('允许的会话', f?.feishu.chatIds.join('\n') || '', 'textarea')],
    c ? small(connectionStates[c.state as keyof typeof connectionStates]) : null, c?.message ? callout(c.message, 'danger') : null,
    button('保存', () => act(async () => { const split = (s: string) => s.split(/[\n,，]/).map(s => s.trim()).filter(Boolean); const result = await req('workspace.connections', { operation: 'save', ...(c ? { connectionId: c.id } : { type }), name: form['名字'], ...(type === 'a2a' ? { revision: a?.revision ?? 0, enabled: form.enabled ?? c?.enabled ?? false, url: form['对方的地址'], port: Number(form['主 agent 监听端口']), inboundToken: form['主 agent 的令牌'], outboundToken: form['对方的令牌'] } : { revision: f?.revision ?? 0, feishu: { enabled: form.enabled ?? c?.enabled ?? false, appId: form['App ID'], senderIds: split(form['允许的用户']), chatIds: split(form['允许的会话']) }, appSecret: form['App Secret'] }) }); form = {}; detail = result; page = { kind: 'connection', id: result.connection.id }; await refresh(); notice = '已保存' }), 'primary'),
    c?.type === 'a2a' ? button('检查连接', () => act(async () => { detail = await req('workspace.connections', { operation: 'check', connectionId: c.id }); notice = '检查完成' }), '', !c.enabled) : null,
    a ? section('最近往来', a.entries.map((e: any) => card(`${e.direction === 'incoming' ? '收到' : '发出'} · ${e.task.status.state}`, small(e.task.status.timestamp)))) : null,
    c ? [check('确认删除这个连接的设置、凭据和往来记录', !!form.delete, v => { form.delete = v; render() }), button('删除连接', () => act(async () => { await req('workspace.connections', { operation: 'delete', connectionId: c.id, confirm: true }); await go({ kind: 'connections' }); await refresh() }), 'danger', !form.delete)] : null]
}
function mainPage() {
  const w = all.workspace, t = w.takeover, workspaces = targets?.workspaces ?? []
  const minutes = t ? Math.max(0, Math.ceil((Date.parse(t.expiresAt) - Date.now()) / 60000)) : 0
  const switchMain = async (input: any) => {
    error = ''
    try { await req('workspace.agent.switch', { revision: all.workspace.revision, ...input }) }
    catch (e) { error = (e as Error).message }
    await refresh()
  }
  return [el('p', {}, w.session ? `${agentName(w.session.agent)} · ${w.session.title} · ${mainAgentStates[w.session.online].label}` : w.runId ? '已绑定主 agent' : '还没有主 agent'),
    t ? card(callout(minutes ? t.error || `正在等 ${t.target.title} 接管，还剩 ${minutes} 分钟` : '对方没在有效期内完成绑定', !minutes || t.error ? 'danger' : ''), button('取消', () => switchMain({ mode: 'cancel' }))) : null,
    section('在线会话', (targets?.sessions ?? []).map((s: any) => card(row(el('span', { class: 'grow any' }, s.title), w.session?.handle === s.handle ? tag('当前主 agent') : button(w.runId ? '换成它' : '设为主 agent', () => switchMain({ mode: 'existing', handle: s.handle }), 'primary')), small(`${agentName(s.agent)} · ${s.workspaceName} · ${s.path}`))), !targets?.sessions?.length ? small('没有可接管的在线会话') : null),
    section('新会话', select('工作区', Object.fromEntries(workspaces.map((s: any) => [s.workspace, `${s.name} · ${s.path}`])), workspaces[0]?.workspace ?? ''), select('Agent', { claude: 'Claude', codex: 'Codex' }, 'claude'), button('新开一个主 agent', () => switchMain({ mode: 'new', workspace: form['工作区'], agent: form.Agent }), 'primary', !workspaces.length)),
    el('details', { class: 'fold' }, el('summary', {}, '绑定详情'), el('dl', { class: 'kv' }, Object.entries({ Run: w.runId || '未绑定', 会话: w.session?.handle || '未知', 目录: w.session?.path || '未知', 绑定时间: w.boundAt || '未知', 授权边界: w.securityBoundary || '未知' }).map(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])))]
}
function content(): any {
  if (page.projectId) return projectPage()
  if (['peer', 'relation', 'dispatch', 'peer-project'].includes(page.kind)) return peerPage()
  if (page.kind === 'links') return linksPage()
  if (page.kind === 'connection' || page.kind === 'add-connection') return connectionPage()
  if (page.kind === 'agents') return [agentsPage(), small('只列本机实时状态；已完成保留 24 小时。其他工作间没有上报 agent 状态。')]
  if (page.kind === 'settings') return ['main', 'connections', 'links', 'machines', 'hidden'].map(kind => item(({ main: '主 agent', connections: '外部连接', links: '工作间连接', machines: '机器', hidden: '隐藏的项目' } as any)[kind], kind === 'main' ? all.workspace.session?.title || '未绑定' : '', () => go({ kind })))
  if (page.kind === 'main') return mainPage()
  if (page.kind === 'connections') return [all.connections?.map(c => item(c.name, `${c.type === 'a2a' ? 'A2A agent' : '飞书'} · ${connectionStates[c.state]}`, () => go({ kind: 'connection', id: c.id }))), button('添加连接', () => go({ kind: 'add-connection' }), 'primary')]
  if (page.kind === 'machines') return [all.machines?.map(m => card(m.name, small(m.role === 'host' ? '主机' : '附属机器'))), select('我在哪台电脑上', Object.fromEntries((all.machines ?? []).map(m => [m.id, m.name])), 'local', v => persist('panel.machine', v))]
  if (page.kind === 'hidden') return all.hidden?.length ? all.hidden.map(p => item(p.name, p.path, () => go({ kind: 'project-settings', projectId: p.id }))) : small('没有隐藏的项目')
  if (page.kind === 'request') {
    const r = requests().find(r => r.id === page.id)
    return !r ? callout('请求不存在') : [el('h2', { class: 'h1 any' }, r.title), tag(requestStates[requestState(r)]), small(`来自 ${peers().find(p => p.id === r.peerId)?.name || r.workspaceId}`), section('背景', el('p', { class: 'any' }, r.context)), section('期望结果', el('p', { class: 'any' }, r.expected)), ...r.links.map(url => button(url, () => orca.shell?.openExternal(url), 'text')), ...r.updates.map(u => card(requestStates[u.status], small(u.note))), r.direction === 'outgoing' && requestState(r) === 'sent' && peers().find(p => p.id === r.peerId)?.status !== 'connected' ? callout('对方离线，连上后才会送达。') : null, r.direction === 'incoming' && requestState(r) === 'confirm' ? [input('说明', '', 'textarea'), row(...['accepted', 'rejected'].map(status => button(status === 'accepted' ? '接受' : '拒绝', () => act(async () => { await req('workspace.requests', { operation: 'decide', peerId: r.peerId, id: r.id, requestId: crypto.randomUUID(), status, note: form['说明'] }); await refresh() }), status === 'accepted' ? 'primary' : '')))] : null]
  }
  return home()
}
function render(y = root.scrollTop) {
  const focused = document.activeElement as HTMLInputElement | null, focusKey = focused?.dataset.focus, selection = focused && ['text', 'search', 'password'].includes(focused.type) || focused?.tagName === 'TEXTAREA' ? [focused?.selectionStart, focused?.selectionEnd] : null
  root.setAttribute('aria-busy', String(busy))
  root.inert = busy
  const title = ({ home: '工作间', settings: '设置', main: '主 agent', connections: '外部连接', connection: '连接', 'add-connection': '添加连接', links: '工作间连接', machines: '机器', hidden: '隐藏的项目', relation: '标关系', dispatch: '派活', agents: 'Agent', request: '请求', peer: '工作间', 'peer-project': '项目', project: '项目', task: '任务', 'project-settings': '项目设置' } as any)[page.kind] || '工作间'
  root.replaceChildren(el('header', { class: 'top' }, page.kind !== 'home' ? button('‹ 返回', back, 'text back') : null, el('h1', { class: 'h1 grow trunc', tabindex: '-1', 'data-heading': '' }, title), page.kind !== 'home' && all ? button(`待处理 ${total()}`, () => go({ kind: 'home' }, true), 'text sm') : null, button('↻', () => refresh(true), 'text icon', false, '刷新'), button('⚙', () => go({ kind: 'settings' }), 'text icon', false, '设置')))
  if (error) root.append(callout(error, 'danger'))
  if (notice) root.append(callout(notice))
  if (all && !live.ok) root.append(callout('agent 状态读不到', 'danger'))
  else if (live.truncated) root.append(callout('agent 状态未全部读取，数量仅含已读取的工作区'))
  if (all) root.append(...[content()].flat(12).filter(Boolean))
  else root.append(callout('正在读取工作间…'))
  renderSheet(); root.scrollTop = y
  if (focusKey) { const target = Array.from(root.querySelectorAll<HTMLInputElement>('[data-focus]')).find(e => e.dataset.focus === focusKey); target?.focus({ preventScroll: true }); if (target && selection) try { target.setSelectionRange(selection[0] ?? 0, selection[1] ?? 0) } catch {} }
}
root.addEventListener('keydown', e => { if (e.key === 'Escape' && page.kind !== 'home') { e.preventDefault(); void back() } })
async function start() {
  try {
    await orca.storage.delete('org.canvas.layout')
    const [saved, savedDrafts] = await Promise.all([orca.storage.get('panel.home'), orca.storage.get('panel.drafts')]) as any[]
    if (saved?.page) { page = saved.page; stack = saved.stack ?? []; opened = saved.opened ?? opened }
    drafts = savedDrafts ?? {}
    orca.plugin.on('project.changed', () => { void refresh() })
    orca.plugin.on('workspace.open', e => { void go({ kind: e.switching ? 'main' : 'home' }, true).then(() => refresh()) })
    const nav = await orca.storage.get('workspace.navigation') as any
    if (nav?.switching) { page = { kind: 'main' }; await orca.storage.set('workspace.navigation', { switching: false }) }
    await refresh(); root.scrollTop = saved?.y ?? 0
  } catch (e) { error = (e as Error).message; render() }
}
void start()
setInterval(() => { if (page.kind === 'main' && all?.workspace.takeover) render() }, 30000)
