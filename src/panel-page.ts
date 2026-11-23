import type {} from 'orca/frame'
import type { ArchivePage } from './protocol'
import { previewArtifact } from './artifact-preview'
import { artifactTitle, latestArtifacts } from './artifact-versions.mjs'
import { actingMain, backupInCharge, blockedRevision, attention, projectSummary, defaultAgent, agentName, compareAgentActivity, groupedAttention, isProjectShared, isRecentAgent, labels, taskState, scopes, statuses, connectionStates, roles, mainStatus, mainAgentStates, waitingForProjectLead, type InstalledAgent } from './model'
import type { Acceptance, AgentSession, Artifact, Attention, LeadSwitch, MainTakeover, Overview, Project, ProjectLead, ProjectWorkspace, WorkspaceBinding } from './model'
import type { FeedbackItem } from './store'
import type { AgentActivity, AgentsSnapshot, MainAgentActivity } from './model'
import type { DelegatedFeedback, FeedbackTask, LinksSnapshot, SharedReport, Sharing } from './links'

type Page = { kind: string; projectId?: string; id?: string; pid?: string; inboxRow?: string; end?: number }
import { applyDelta, emptySheet, feedbackFailure, versionOf, type Attempt, type Delta, type Draft, type InboxRow, type Sheets } from './feedback-drafts'
const root = document.getElementById('panel')!
const req = (name: string, input?: any, timeoutMs?: number): Promise<any> => input === undefined
  ? orca.plugin.request(name as any)
  : orca.plugin.request(name as any, JSON.parse(JSON.stringify(input)), timeoutMs ? { timeoutMs } : undefined)
type PageData = { current: Project | null; task?: FeedbackTask | null; lead?: WorkspaceBinding; leadPanel?: ProjectLead; workspace?: ProjectWorkspace; connection?: any; targets?: any; archive?: ArchivePage }
type Frame = { key: string; page: Page; form: Record<string, any>; data?: PageData; error?: string; load?: number; opener?: HTMLElement; dirty?: boolean; mounted?: boolean; approvalMode?: string | null }
let frameId = 0
const frameFor = (page: Page): Frame => ({ key: 'page-' + ++frameId, page, form: {} })
const homeFrame = frameFor({ kind: 'home' })
let stack = [homeFrame], active = homeFrame
let page = active.page, form = active.form
let all: Overview, live: AgentsSnapshot = { ok: false, at: 0, agents: [] }, current: Project | null = null
let projectLead: WorkspaceBinding | undefined, projectLeadPanel: ProjectLead | undefined, workspaceTarget: ProjectWorkspace | undefined
let detail: any, targets: any
let opened: Record<string, boolean> = { self: true }, wideInbox = false
const tabsOf: Record<string, string> = {}
let drafts: Record<string, Record<string, Draft>> = {}
let feedbackRequests: Record<string, Attempt> = {}
let sheets: Sheets = {}, sheetRead = 0, draftGeneration = 0, pendingEdits = 0, draftFailure = ''
let edits: Promise<void> = Promise.resolve()
function useSheets(next: Sheets) {
  sheets = next
  drafts = Object.fromEntries(Object.entries(next).map(([id, sheet]) => [id, sheet.entries]))
  feedbackRequests = Object.fromEntries(Object.entries(next).flatMap(([id, sheet]) => sheet.attempt ? [[id, sheet.attempt]] : []))
}
async function readSheets() {
  const read = ++sheetRead, generation = draftGeneration, next = await req('panel.feedbackState', {})
  if (read === sheetRead && !pendingEdits && !busy && generation === draftGeneration) useSheets(next)
}
function changeFor(id: string, values: [string, Draft | null | undefined][], attempt?: Attempt | null): Delta {
  const sheet = sheets[id] ?? emptySheet()
  return { projectId: id, items: values.map(([key, value]) => ({ key, version: versionOf(sheet, key), value })),
    ...(attempt !== undefined ? { attempt: { version: versionOf(sheet, 'attempt'), value: attempt } } : {}) }
}
function editChoices(id: string, values: [string, Draft | null][]) {
  if (!values.length) return
  const previous = feedbackRequests[id]
  if (previous?.input && !previous.rejected) { error = '上次提交还没确认，请先重试核对'; render(); return }
  const change = changeFor(id, values, previous ? null : undefined), generation = ++draftGeneration
  applyDelta(sheets, change); useSheets(sheets); pendingEdits++
  edits = edits.then(async () => {
    const next = await req('panel.feedbackState', { change })
    if (generation === draftGeneration) useSheets(next)
  }).catch(e => { draftFailure = error = '草稿保存失败：' + e.message; render() }).finally(() => { pendingEdits-- })
}
async function saveSubmission(change: Delta) {
  ++draftGeneration
  const next = await req('panel.feedbackState', { change })
  useSheets({ ...sheets, [change.projectId]: next[change.projectId] })
}
function clearChoices(id: string) { editChoices(id, Object.keys(choices(id)).map(key => [key, null])) }
const inlineRows = new Map<string, Frame>()
const expandedRows = new Set<string>(), folded = new Map<string, boolean>()
let error = '', notice = '', busy = false, more = false, nav = 0, refreshing = false, refreshSeq = 0
let overviewIssue = ''
let direction = '', leaving: Frame | undefined, lastInline = '', organizationScroll = 0, trayOpen = false
let toastAction: { label: string; run: () => void } | undefined, toastTimer = 0, toastText = ''
let actionIds: Record<string, number> = {}, clickedAction = '', busyAction = ''
let persistChain: Promise<unknown> = Promise.resolve()
const persist = (key: string, value: any) => {
  const copy = structuredClone(value)
  persistChain = persistChain.catch(() => {}).then(() => orca.storage.set(key, copy)).catch(e => {
    if (!error.startsWith('草稿保存失败')) { error = `草稿保存失败：${e.message}`; render() }
  })
}
const remember = () => persist('panel.home', { at: Date.now(), pages: stack.map(f => f.page), opened, tabs: tabsOf, more })
document.addEventListener('visibilitychange', () => { if (document.hidden && all) remember() })
const key = (t: string, k: string, id: string) => JSON.stringify([t, k, id])
const choices = (id: string) => drafts[id] ?? {}
const peers = () => all.links?.peers ?? []
const peer = () => peers().find(p => p.id === page.id)
const remoteKey = (peerId: string, projectId: string) => JSON.stringify([peerId, projectId])
const isRemote = (projectId?: string) => projectId?.startsWith('[') === true
const remoteProjects = () => peers().flatMap(peer => (peer.report?.projects ?? peer.offlineFeedback ?? [])
  .flatMap(project => project.feedback ? [{ ...project, feedback: project.feedback, peer, key: remoteKey(peer.id, project.id) }] : []))
function remoteSource(key: string, sources = peers()) {
  const [peerId, projectId] = JSON.parse(key), peer = sources.find(p => p.id === peerId)
  const project = (peer?.report?.projects ?? peer?.offlineFeedback)?.find(p => p.id === projectId)
  return { peer, project }
}
const remoteFeedback = (key: string) => remoteSource(key).project?.feedback
function remoteUnavailable(key: string) {
  const { peer, project } = remoteSource(key)
  if (!peer) return '连接已断开'
  if (peer.status !== 'connected') return `「${peer.name}」离线，暂不能提交`
  return project?.feedback ? '' : '对方未开放此项目的待处理项'
}
const sharesAllProjects = (p: LinksSnapshot['peers'][number]) => p.state === 'active' && p.scope !== 'none' && p.allProjects
const pending = (p?: string) => groupedAttention(all.attention).filter(a => !p || a.projectId === p)
const needs = () => live.ok ? live.agents.filter(a => a.state === 'need') : []
const agentInboxKey = (id: string) => JSON.stringify(['agent', id])
const total = () => inboxRows().length
const projectCount = (id: string) => pending(id).length + needs().filter(a => a.projectId === id).length
const projectAgents = (id?: string) => live.ok ? live.agents.filter(a => (!id || a.projectId === id) && isRecentAgent(a)) : []
const relative = (at?: number | string) => {
  if (!at) return '未知'
  const n = Date.now() - (typeof at === 'number' ? at : Date.parse(at))
  return !Number.isFinite(n) ? '未知' : n < 60000 ? '刚刚' : n < 3600000 ? `${Math.floor(n / 60000)} 分钟前` : n < 86400000 ? `${Math.floor(n / 3600000)} 小时前` : new Date(at).toLocaleString()
}
function el(tag: string, attrs: Record<string, any> = {}, ...children: any[]): HTMLElement {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('on')) (e as any)[k] = v
    else if (['value', 'checked', 'indeterminate', 'disabled', 'inert'].includes(k)) (e as any)[k] = v
    else e.setAttribute(k, String(v))
  }
  e.append(...children.flat(12).filter(v => v !== undefined && v !== null && v !== false).map(v => v instanceof Node ? v : document.createTextNode(String(v))))
  return e
}
const keyed = (node: HTMLElement, key: string) => { node.dataset.key = key; return node }
const nodeKey = (n: Node) => n instanceof HTMLElement ? n.dataset.key ?? n.dataset.action ?? (n.id || undefined) : undefined
function updateChildren(parent: HTMLElement, next: HTMLElement) {
  const old = Array.from(parent.childNodes)
  const move = (parent as HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void }).moveBefore
  const keyed = new Map(old.flatMap(n => !(n instanceof HTMLElement && n.dataset.leaving !== undefined) && nodeKey(n) ? [[nodeKey(n), n] as const] : []))
  const loose = old.filter(n => !nodeKey(n))
  const remaining = new Set(old.filter(n => !(n instanceof HTMLElement && n.dataset.leaving !== undefined)))
  let cursor = parent.firstChild
  for (const incoming of Array.from(next.childNodes)) {
    const k = nodeKey(incoming)
    const match = k ? keyed.get(k) : loose.find(n => remaining.has(n) && n.nodeName === incoming.nodeName)
    const existing = match && remaining.has(match) ? match : undefined
    let n = incoming
    if (existing && existing.nodeName === incoming.nodeName) {
      remaining.delete(existing)
      updateNode(existing, incoming)
      n = existing
    }
    if (n === cursor) cursor = n.nextSibling
    else if (n.parentNode === parent && move) move.call(parent, n, cursor)
    else parent.insertBefore(n, cursor)
    if (!existing && parent.dataset.animate === 'row' && n instanceof HTMLElement && parent.isConnected) animateRemoval(n, true, 'row')
  }
  for (const n of remaining) {
    if (parent.dataset.animate !== undefined && !(parent.dataset.animate === 'fade' && next.childElementCount) && n instanceof HTMLElement && parent.isConnected) animateRemoval(n, false, parent.dataset.animate)
    else n.parentNode?.removeChild(n)
  }
}
function animateRemoval(node: HTMLElement, entering: boolean, kind: string) {
  if (!entering) { node.dataset.leaving = ''; node.inert = true; node.setAttribute('aria-hidden', 'true') }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { if (!entering) node.remove(); return }
  const fade = kind === 'fade'
  const full = fade ? { opacity: 1 } : { height: `${node.offsetHeight}px`, opacity: 1 }
  const empty = fade ? { opacity: 0 } : { height: '0', opacity: 0 }
  const animation = node.animate(entering ? [empty, full] : [full, empty], { duration: fade ? 150 : entering ? 200 : 180, easing: fade ? 'ease-in' : 'cubic-bezier(0,0,.2,1)' })
  if (!entering) animation.onfinish = () => node.remove()
}
function updateNode(old: Node, next: Node) {
  if (!(old instanceof HTMLElement) || !(next instanceof HTMLElement)) {
    if (!old.isEqualNode(next)) old.nodeValue = next.nodeValue
    return
  }
  for (const { name } of Array.from(old.attributes)) if (name !== 'data-navigating' && !next.hasAttribute(name)) old.removeAttribute(name)
  for (const { name, value } of Array.from(next.attributes)) if (old.getAttribute(name) !== value) old.setAttribute(name, value)
  for (const event of ['onclick', 'onchange', 'oninput', 'onkeydown'] as const) (old as any)[event] = next[event]
  if (next.dataset.skip !== undefined) return
  updateChildren(old, next)
  if (old instanceof HTMLInputElement && next instanceof HTMLInputElement) {
    if (old.checked !== next.checked) old.checked = next.checked
    if (old.indeterminate !== next.indeterminate) old.indeterminate = next.indeterminate
  }
  if ('value' in old && 'value' in next && old.value !== next.value && old !== document.activeElement) old.value = next.value
}
const row = (...c: any[]) => el('div', { class: 'row g2 wrap' }, c)
const section = (title: string, ...c: any[]) => {
  const action = c[0] instanceof HTMLElement && (c[0].matches('button') || c[0].tagName === 'SPAN' && c[0].firstElementChild?.matches('button')) ? c.shift() : null
  return el('section', { class: 'sec', 'aria-label': title, 'data-key': title }, el('div', { class: 'sec-h between' }, el('h2', { class: 'h2' }, title), action), c)
}
const small = (s: string) => el('span', { class: 'muted xs any' }, s)
const card = (...c: any[]) => el('div', { class: 'card' }, c)
const dot = (cls = '', label = '') => el('span', { class: `dot ${cls}`, role: label ? 'img' : undefined, 'aria-label': label || undefined, 'aria-hidden': label ? undefined : 'true' })
const pill = (n: number) => n ? el('span', { class: 'pill' }, n) : null
const tag = (t: string, tone = '') => el('span', { class: `tag ${tone}` }, t)
const callout = (text: string, tone = '') => el('div', { class: `callout ${tone}`, role: tone === 'danger' ? 'alert' : 'status' }, text)
const paths = {
  chevron: 'M9 18l6-6-6-6', back: 'M15 18l-6-6 6-6', close: 'm18 6-12 12M6 6l12 12',
  // Lucide paths used by Orca for settings and refresh-cw.
  refresh: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16 M8 16H3v5',
  settings: 'M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915Z M15 12a3 3 0 1 0-6 0 3 3 0 1 0 6 0Z',
  home: 'm3 10 9-7 9 7v10h-6v-6H9v6H3z'
}
function icon(name: keyof typeof paths, cls = '') {
  const holder = el('span', { class: `i ${name === 'chevron' ? 'chev ' : ''}${cls}`, 'aria-hidden': 'true', 'data-key': `icon-${name}` })
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), path = document.createElementNS(ns, 'path')
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round')
  path.setAttribute('d', paths[name]); svg.append(path); holder.append(svg)
  return holder
}
function button(text: string, action: () => any, cls = '', disabled = false, title = '', glyph?: keyof typeof paths) {
  const label = text || title
  const id = `${label}:${actionIds[label] = (actionIds[label] ?? 0) + 1}`, waiting = busy && (id === busyAction || action === submitFeedback && busyAction.startsWith('提交'))
  return el('button', { type: 'button', class: `btn ${cls}`, disabled: disabled || busy, title: title || text, 'data-action': id, 'aria-busy': waiting ? 'true' : undefined,
    'aria-label': !text || cls.includes('icon') || waiting ? label : undefined, onclick: () => { clickedAction = id; void action() } },
  waiting ? [el('span', { class: 'spinner', 'aria-hidden': 'true' }), action === submitFeedback ? text : '处理中…'] : [glyph ? icon(glyph) : null, text ? el('span', { class: 't trunc' }, text) : null])
}
const item = (title: string, summary: string, action?: () => any, extra?: any) => el(action ? 'button' : 'div', { type: action ? 'button' : undefined, class: 'item', 'aria-label': title, 'aria-description': summary, onclick: action, title }, extra?.classList?.contains('dot') ? extra : null, el('span', { class: 'body' }, el('span', { class: 'trunc' }, title), small(summary)), !extra?.classList?.contains('dot') ? extra : null, action ? icon('chevron') : null)
function input(label: string, initial: any = '', type = 'text', change?: (value: string) => void, placeholder?: string, fields = form, feedback = false) {
  const name = label
  if (!(name in fields)) fields[name] = initial
  const e = el(type === 'textarea' ? 'textarea' : 'input', { class: 'in', type: type === 'textarea' ? undefined : type, value: fields[name], placeholder, 'data-focus': name, maxlength: type === 'password' ? 4096 : 8000,
    oninput: (e: Event) => { const value = (e.target as HTMLInputElement).value; fields[name] = value; if (fields === active.form && !feedback) markDirty(); change?.(value) } })
  const caption = label.startsWith('决定 ') ? '你的决定' : feedback ? label.split(' ')[0] : label
  return el('label', { class: 'field' }, el('span', { class: 'lb' }, caption), e)
}
function select(label: string, options: Record<string, string>, initial: string, change?: (v: string) => void, placeholder?: string) {
  if (!(label in form)) form[label] = initial
  const fields = form
  const s = el('select', { class: 'in', 'aria-label': label, 'data-focus': label, onchange: (e: Event) => { fields[label] = (e.target as HTMLSelectElement).value; if (fields === active.form) markDirty(); change?.(fields[label]) } }, placeholder ? el('option', { value: '', disabled: true }, placeholder) : null, Object.entries(options).map(([v, t]) => el('option', { value: v }, t))) as HTMLSelectElement
  s.value = form[label]
  return el('label', { class: 'field' }, el('span', { class: 'lb' }, label), el('span', { class: 'sel' }, s))
}
function agentSelect(list: InstalledAgent[], label = 'Agent', saved?: string) {
  const options = Object.fromEntries(list.map(a => [a.id, a.name]))
  if (!Object.hasOwn(options, form[label])) form[label] = saved === undefined ? defaultAgent(list) : Object.hasOwn(options, saved) ? saved : ''
  return select(label, options, form[label], saved === undefined ? undefined : () => render(),
    !form[label] && saved ? `${agentName(saved)} 已不可用，请选择` : undefined)
}
const catalogIssue = (list?: InstalledAgent[] | null) => list === null ? '无法读取 Orca 代理列表，请刷新重试' : '当前工作区没有可用代理'
function check(label: string, checked: boolean, change: (v: boolean) => void, options: { type?: string; name?: string; value?: string; disabled?: boolean; 'data-focus'?: string } = {}) {
  return el('label', { class: 'opt' }, el('input', { type: 'checkbox', ...options, checked, onchange: (e: Event) => change((e.target as HTMLInputElement).checked) }), el('span', { class: 'any' }, label))
}
const tabOf = (id: string) => tabsOf[id] ?? 'inbox'
type ProjectTab = { count: number; body: () => any }
function projectTabs(projectId: string, views: Partial<Record<'inbox' | 'tasks' | 'artifacts' | 'agents' | 'messages', ProjectTab>>) {
  const names = { inbox: '待处理', tasks: '任务', artifacts: '成果', agents: 'Agent', messages: '消息' }
  const entries = Object.entries(views) as [keyof typeof names, ProjectTab][]
  const [selected, view] = entries.find(([id]) => id === tabOf(projectId)) ?? entries[0]
  return [tabButtons('项目页面', entries.map(([id, { count }]) => ({ id, name: names[id], count })), selected, id => { tabsOf[projectId] = id; remember(); render() }),
    el('div', { role: 'tabpanel', id: active.key + '-tab', class: 'stack g3 fade', 'data-key': selected }, view.body())]
}
function tabButtons(label: string, entries: { id: string; name: string; count?: number }[], selected: string, choose: (id: string) => void) {
  return el('div', { class: 'tabs', role: 'tablist', 'aria-label': label, style: `--n:${entries.length};--i:${entries.findIndex(({ id }) => id === selected)}`, onkeydown: (e: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    const tablist = e.currentTarget as HTMLElement
    const buttons = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role=tab]')), at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    e.preventDefault()
    const next = buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]
    next?.click(); next?.focus()
  } }, el('span', { class: 'ind', 'aria-hidden': 'true' }), entries.map(({ id, name, count }) => el('button', {
    type: 'button', role: 'tab', class: 'tab', tabindex: selected === id ? 0 : -1, 'aria-selected': String(selected === id), 'aria-controls': active.key + '-tab',
    onclick: () => choose(id)
  }, name, count ? el('span', { class: 'n', 'aria-hidden': 'true' }, count) : null)))
}
function dismiss() {
  clearTimeout(toastTimer)
  error = ''; notice = ''; toastText = ''; toastAction = undefined; render()
}
async function act(work: () => Promise<void>, completionNotice = true) {
  if (busy) return
  busy = true; busyAction = clickedAction; dismiss()
  try {
    await work()
    if (completionNotice && !notice && !error) notice = '已完成'
  } catch (e) { error = e instanceof Error ? e.message : '未完成，请刷新核对；不要重复发送' }
  finally {
    busy = false; busyAction = ''; render()
  }
}
function useFrame(f: Frame) {
  active = f; page = f.page; form = f.form
  current = f.data?.current ?? null; projectLead = f.data?.lead; projectLeadPanel = f.data?.leadPanel
  workspaceTarget = f.data?.workspace; detail = f.data?.connection; targets = f.data?.targets
}
async function loadPage(f = active, taskReads?: Map<string, Promise<FeedbackTask | null>>) {
  const p = f.page, request = (f.load ?? 0) + 1
  f.load = request
  try {
    const local = p.projectId && !isRemote(p.projectId)
    let taskRead
    if (local && p.kind === 'task' && p.inboxRow) {
      const key = JSON.stringify([p.projectId, p.id])
      taskRead = taskReads?.get(key) ?? req('project.task', { projectId: p.projectId, taskId: p.id })
      taskReads?.set(key, taskRead)
    }
    const [task, snapshot, connection, sessions, leadPanel, archive] = await Promise.all([
      taskRead, local && !taskRead ? req('project.read', { projectId: p.projectId }) : null,
      p.kind === 'connection' && p.id ? req('workspace.connections', { operation: 'read', connectionId: p.id, includeApprovalMode: false }) : null,
      p.kind === 'main' ? req('workspace.agent.targets', { workspace: f.form['工作区'] }) : null,
      p.kind === 'project-settings' && p.projectId ? req('project.lead', { projectId: p.projectId }) : undefined,
      p.kind === 'archive' || (p.kind === 'task' && p.end !== undefined) ? req('project.archive', { projectId: p.projectId, end: p.end }) : undefined
    ])
    if (request !== f.load) return
    if (sessions) f.form['工作区'] = sessions.agentWorkspace
    f.data = { current: snapshot?.project ?? null, task, lead: snapshot?.lead, workspace: snapshot?.workspaceTarget, connection, targets: sessions, leadPanel, archive }
    f.error = undefined
    if (connection?.a2a && f.approvalMode === undefined) {
      f.approvalMode = null
      void req('workspace.hermesApprovalMode').then(mode => { f.approvalMode = mode }, () => { f.approvalMode = '暂时无法读取' })
        .finally(() => { if (f === active) render() })
    }
    if (f === active) useFrame(f)
  } catch (e) {
    if (request !== f.load) return
    f.error = (e as Error).message
  }
}
function animatePage(dir: string, prior?: Frame) {
  direction = dir; leaving = prior
  render()
  setTimeout(() => {
    if (leaving === prior && direction === dir) { leaving = undefined; direction = ''; render() }
  }, 180)
}
function focusHeading() {
  root.querySelector<HTMLElement>(wideInbox && active !== homeFrame ? '.pane-top [data-heading]' : '.top [data-heading]')?.focus({ preventScroll: true })
}
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function go(next: Page, reset = false, keyboard = false) {
  const n = ++nav
  if (!reset && JSON.stringify(page) === JSON.stringify(next)) return
  const prior = active, opener = document.activeElement as HTMLElement | null
  const f = reset && next.kind === 'home' ? homeFrame : frameFor(next)
  f.opener = opener ?? undefined
  const ready = loadPage(f)
  if (next.kind === 'project' && Date.now() - live.at >= 60_000) loadAgents(false)
  opener?.setAttribute('data-navigating', '')
  if (!next.inboxRow && !settingsDetail(next)) await Promise.race([ready, wait(150)])
  opener?.removeAttribute('data-navigating')
  if (n !== nav) return
  const fromHome = Boolean(opener?.closest('.home-layer')) || prior === homeFrame
  if (prior === homeFrame) organizationScroll = root.querySelector<HTMLElement>('.home-layer')?.scrollTop ?? 0
  if (reset || fromHome) stack = [homeFrame]
  if (f !== homeFrame) stack.push(f)
  useFrame(f); remember()
  animatePage(f === homeFrame && wideInbox ? 'fade' : wideInbox && fromHome ? 'up' : 'fwd', prior !== f ? prior : undefined)
  if (!keyboard) focusHeading()
  await ready
  if (n === nav) render()
}
function markDirty() { active.dirty = true }
function markSaved() { active.dirty = false }
function back(toHome = false, preserveToast = false) {
  ++nav
  if (active === homeFrame) return
  const previous = active, keep = toHome ? 1 : stack.length - 1
  const removed = stack.splice(keep)
  useFrame(stack.at(-1)!)
  if (!preserveToast) dismiss()
  remember(); animatePage(wideInbox && active === homeFrame ? 'fade' : 'back', previous)
  if (wideInbox && active === homeFrame) {
    const layer = root.querySelector<HTMLElement>('.home-layer')
    if (layer) layer.scrollTop = organizationScroll
  }
  const opener = removed[0]?.opener
  if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true })
  else focusHeading()
  const restored = active
  if (previous.dirty && !preserveToast) {
    notice = `「${titleOf(previous)}」的改动还没保存`
    toastAction = { label: '继续编辑', run: () => {
      if (active !== restored) return
      dismiss(); stack.push(...removed); useFrame(previous); remember(); animatePage('fwd', restored); focusHeading()
    } }
    render()
  }
  void loadPage(restored).then(() => { if (active === restored) render() })
}
async function readOverview(seq: number, manual = false) {
  for (const delay of [0, 400, 1200]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay))
    if (seq !== refreshSeq) return false
    try {
      const next = await req('workspace.overview')
      if (seq !== refreshSeq) return false
      all = next
      overviewIssue = ''
      return true
    } catch (e) {
      if (seq !== refreshSeq) return false
      if (manual) { overviewIssue = `总览刷新失败：${(e as Error).message}`; return false }
    }
  }
  overviewIssue = all ? '总览暂时无法更新，当前显示上次的内容' : '总览暂时无法读取'
  return false
}
async function refreshOverview() {
  const seq = ++refreshSeq
  const updated = await readOverview(seq)
  if (seq === refreshSeq) { refreshing = false; render(); if (updated) void reconcileFeedback() }
}
let readingAgents: Promise<void> | undefined
function loadAgents(force: boolean) {
  if (readingAgents) return
  readingAgents = req('workspace.agents', { refresh: force }, 15_000)
    .then(agents => { live = agents }, () => { live = { ok: false, at: Date.now(), agents: [] } })
    .finally(() => { readingAgents = undefined; if (all) render() })
}
async function refresh(forceAgents = false) {
  const n = ++refreshSeq
  if (forceAgents) {
    refreshing = true
    if (active.approvalMode !== null) active.approvalMode = undefined
    render()
  }
  try {
    if (forceAgents && !pendingEdits && !busy) { await readSheets(); draftFailure = '' }
    loadAgents(forceAgents)
    if (!await readOverview(n, forceAgents) || n !== refreshSeq) return
    opened = Object.fromEntries(Object.entries(opened).filter(([id]) => id === 'self' || peers().some(p => p.id === id)))
    if (settingsDetail(page)) render()
    const shown = new Set(inboxRows().map(r => r.id))
    for (const [id, f] of inlineRows) if (f !== active && !shown.has(f.page.inboxRow!)) {
      inlineRows.delete(id); expandedRows.delete(id); if (lastInline === id) lastInline = ''
    }
    const visible = active === homeFrame && !wideInbox
    const read = new Map<string, Promise<FeedbackTask | null>>()
    const details = visible ? [...inlineRows].filter(([id, f]) => id.startsWith(active.key + '[') && expandedRows.has(id) && f.page.projectId && !isRemote(f.page.projectId)) : []
    await Promise.all([loadPage(active, read), ...details.map(([, f]) => loadPage(f, read))])
  } catch (e) { if (n === refreshSeq) error = `读取失败：${(e as Error).message}` }
  finally {
    if (n === refreshSeq) { refreshing = false; render(); void reconcileFeedback() }
  }
}
function validDraft(task: FeedbackTask | undefined, draft: Draft) {
  if (!task || task.phase === 'paused') return false
  if (draft.kind === 'blocked') return draft.itemRevision !== undefined && draft.itemRevision === blockedRevision(task)
  if (draft.kind === 'acceptance') {
    const item = task.acceptance.find(a => a.id === draft.itemId)
    return task.phase === 'ready' && item?.status === 'pending' && item.revision === draft.itemRevision && item.fingerprint === draft.fingerprint
  }
  const item = task.decisions.find(d => d.id === draft.itemId)
  return !!item && item.answer === undefined && JSON.stringify([item.question, item.options]) === draft.signature
}
const pendingAcceptances = (task?: FeedbackTask) => task?.phase === 'ready' ? task.acceptance.filter(a => a.status === 'pending') : []
function validFeedbackDrafts(tasks: FeedbackTask[], entries: Draft[]) {
  return entries.every(d => {
    const task = tasks.find(t => t.id === d.taskId)
    return validDraft(task, d) && (d.reviewTotal === undefined || d.reviewTotal === pendingAcceptances(task).length)
  })
}
const acceptanceDraft = (taskId: string, a: Pick<Acceptance, 'id' | 'revision' | 'fingerprint' | 'title'>): Draft =>
  ({ taskId, kind: 'acceptance', itemId: a.id, itemRevision: a.revision, fingerprint: a.fingerprint, signature: a.fingerprint, title: a.title })
async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}
function feedbackItems(drafts: Draft[]): Promise<FeedbackItem[]> {
  return Promise.all(drafts.map(async d => ({
    taskId: d.taskId, kind: d.kind, itemId: d.itemId, itemRevision: d.itemRevision, reviewTotal: d.reviewTotal, result: d.result, note: d.note, answer: d.answer,
    fingerprint: d.kind === 'decision' ? await digest(d.signature) : d.fingerprint
  })))
}
function choose(projectId: string, ...items: Draft[]) {
  editChoices(projectId, items.map(item => [key(item.taskId, item.kind, item.itemId), item]))
}
function removeChoice(projectId: string, itemKey: string) {
  editChoices(projectId, [[itemKey, null]]); render()
}
function activityStyle(activity: { state: string; since?: number }) {
  const state = activity.state
  if (state === 'need' || state === 'work') return { label: (state === 'need' ? '等你' : '工作中') + ' · ' + relative(activity.since) + '开始', tone: state }
  if (state === 'done') return { label: relative(activity.since) + '完成', tone: 'ok' }
  return { label: state === 'offline' ? '离线' : state === 'idle' ? '待命' : '未知', tone: state === 'offline' ? 'bad' : '' }
}
function agentRow(a: AgentActivity, projectName?: string, expanded = false) {
  const { label: duration, tone } = activityStyle(a)
  const line = el('div', { class: 'arow' }, dot(tone), el('span', { class: 'none' }, agentName(a.agent)), el('span', { class: expanded ? 'grow any' : 'grow trunc' }, a.title), small(duration))
  const task = expanded ? small(`关联任务 · ${a.taskTitle || '未关联'}`) : a.taskTitle && a.taskTitle !== a.title ? small(a.taskTitle) : null
  return projectName ? el('article', { class: 'aitem', 'data-st': a.state }, line, small(`${a.role === 'worker' ? 'worker' : '会话'} · ${projectName}`), task) : line
}
function agentColumns<T extends AgentActivity>(list: T[], projectName: (a: T) => string) {
  return el('div', { class: 'cols3' }, ['need', 'work', 'done'].map(state => {
    const selected = list.filter(a => a.state === state).sort(compareAgentActivity), visible = state === 'done' ? selected.slice(0, 20) : selected
    return el('section', { class: 'acol', 'aria-label': ({ need: '需要你', work: '工作中', done: '已完成' } as any)[state] }, row(el('h2', { class: 'h2' }, ({ need: '需要你', work: '工作中', done: '已完成' } as any)[state]), tag(String(selected.length))), visible.map(a => agentRow(a, projectName(a))), !selected.length ? small('暂无') : null, selected.length > visible.length ? small(`另有 ${selected.length - visible.length} 条未列出`) : null)
  }))
}
const agentStatusText = () => live.at || !readingAgents ? 'agent 状态暂时读不到' : '正在读取 agent 状态…'
const agentsPage = (id?: string) => live.ok ? [agentColumns(projectAgents(id), a => all.projects.find(p => p.ref.id === a.projectId)?.ref.name || '其他项目'), live.truncated ? small('agent 状态未全部读取') : null] : small(agentStatusText())
const agentContent = () => [agentsPage(), small('已完成的 agent 保留 24 小时。')]
function agentNeedContent(id?: string) {
  if (!live.ok) return small(agentStatusText())
  const agent = live.agents.find(a => agentInboxKey(a.id) === id)
  if (agent?.state !== 'need') return callout(!agent && live.truncated ? '请刷新后核对这个 Agent' : '已不需要你处理')
  return [agentRow(agent, all.projects.find(p => p.ref.id === agent.projectId)?.ref.name || '其他项目', true),
    small('这里暂不能查看或回答聊天问题，请在打开的会话里回答。'),
    row(button('打开会话去回答', () => openAgent(agent), 'primary'), button('全部 agent', () => go({ kind: 'agents' }), 'text sm'))]
}
function openAgent(agent: AgentsSnapshot['agents'][number]) {
  return act(async () => {
    try {
      const result = await req('workspace.agent.open', { id: agent.id })
      notice = result.focusedTerminal ? '已打开会话' : '已打开工作区，请选择会话后回答'
    } catch (e) { await refresh(true); throw e }
  })
}
function projectCard(p: { id: string; name: string; count: number; agents?: AgentActivity[]; note?: string; summary?: string }, open: () => void) {
  const agents = p.agents ?? [], unfinished = agents.filter(a => a.state !== 'done').sort(compareAgentActivity).slice(0, 3), done = agents.filter(a => a.state === 'done').length
  return el('article', { class: 'pcard', 'data-project': p.id, 'data-key': p.id },
    el('button', { type: 'button', class: 'pcard-h', title: p.name, 'aria-label': p.name, 'aria-description': p.summary ?? (p.count ? `待处理 ${p.count}` : undefined), onclick: open }, el('span', { class: 'name grow trunc' }, p.name), pill(p.count), p.summary ? small(p.summary) : null, icon('chevron')),
    agents.length || p.note ? el('div', { class: 'pcard-b' }, unfinished.map(a => agentRow(a)), done ? small(`✓ 已完成 ${done} 个`) : null, p.note ? small(p.note) : null) : null)
}
function localMainStyle(session: AgentSession | undefined) {
  const status = mainStatus(session, live)
  if (status.state !== 'unknown') return activityStyle(status)
  const online = session?.online
  return { label: online && online !== 'unknown' ? mainAgentStates[online] : live.at ? '状态暂时无法读取' : '正在获取状态', tone: online === 'offline' ? 'bad' : '' }
}
function mainAgentInfo(agent: MainAgentActivity | null | undefined, bound = !!agent, style?: ReturnType<typeof activityStyle>) {
  const { label, tone } = style ?? activityStyle(agent?.activity ?? { state: agent?.online === 'offline' ? 'offline' : 'unknown' })
  const title = agent ? [agentName(agent.agent), agent.title, label].filter(Boolean).join(' · ') : bound ? '已绑定' : '未绑定'
  return { title, tone }
}
function botStatus(bot: WorkspaceBinding['bot']) {
  if (!bot) return ''
  return [bot.name || bot.id, bot.agent ? agentName(bot.agent) : 'bot 状态未知', bot.paused && '已暂停', bot.reason,
    bot.recoveryAt ? '预计恢复 ' + new Date(bot.recoveryAt).toLocaleString() : bot.reason?.includes('额度') ? '恢复时间未知' : '', bot.result].filter(Boolean).join(' · ')
}
function mainAgentLine(agent: MainAgentActivity | null | undefined, open?: () => void, bound = !!agent, showLabel = true) {
  const active = open ? actingMain(all.workspace) : undefined
  const { title: primary, tone } = mainAgentInfo(active ?? agent, bound, open ? localMainStyle(active) : undefined)
  const title = [primary, open && all.workspace.backup && backupDescription(all.workspace), open && botStatus(all.workspace.bot)].filter(Boolean).join(' · ')
  return el(open ? 'button' : 'div', { class: 'lead', type: open ? 'button' : undefined, 'aria-label': open ? showLabel ? '主 agent' : '管理主 agent' : undefined, onclick: open }, dot(tone), showLabel ? el('span', { class: 't' }, '主 agent') : null, el('span', { class: 'grow trunc xs muted', title }, title), open ? icon('chevron') : null)
}
const activityNote = (activity: SharedReport['projects'][number]['activity']) => activity === null ? 'agent 状态读不到' : activity?.truncated ? 'agent 未全部列出' : undefined
function ownProjects() {
  const projects = all.projects.filter(p => !homeFrame.form['找项目'] || p.ref.name.toLowerCase().includes(homeFrame.form['找项目'].toLowerCase()))
  const cardFor = (p: Overview['projects'][number]) => projectCard({ ...p.ref, count: projectCount(p.ref.id), agents: projectAgents(p.ref.id) }, () => { void go({ kind: 'project', projectId: p.ref.id }) })
  return [all.projects.length > 12 ? input('找项目', '', 'search', () => render(), '输入项目名', homeFrame.form) : null, ...(all.machines ?? [{ id: 'local', name: '', role: 'host' }]).map(m => {
    const list = projects.filter(p => p.ref.hostId === m.id), active = list.filter(p => Object.values(p.counts).some(Boolean) || projectAgents(p.ref.id).some(a => a.state !== 'done')), idle = list.filter(p => !active.includes(p))
    return el('div', { class: 'stack g2' }, (all.machines?.length ?? 0) > 1 ? small(`${m.role === 'host' ? '主机' : '电脑'} · ${m.name}`) : null, el('div', { class: 'cards' }, active.sort((a, b) => projectCount(b.ref.id) - projectCount(a.ref.id)).map(cardFor)), idle.length ? fold('idle-' + m.id, `还没有任务的项目 ${idle.length} 个`, () => el('div', { class: 'cards' }, idle.map(cardFor)), undefined, !!homeFrame.form['找项目']) : null)
  }), !all.projects.length ? small('还没有项目，在 Orca 中添加项目后会显示在这里。') : null]
}
function workspaceNode(p?: LinksSnapshot['peers'][number]) {
  const id = p?.id ?? 'self', open = opened[id] ?? false, active = !p || p.status === 'connected', report = active ? p?.report : null
  const flagged = p?.relation === 'below' && report?.scope === 'details' && report.projects.some(pr => pr.tasks?.some(t => t.phase === 'blocked'))
  const body = !p ? [row(small(`你的工作间${all.machines?.[0] ? ` · ${all.machines[0].name}` : ''}`), button('全部 agent', () => go({ kind: 'agents' }), 'text sm')),
    mainAgentLine(all.workspace.session, () => { void go({ kind: 'main' }) }, !!all.workspace.runId),
    el('div', { class: 'under' }, row(small('外部连接'), all.connections?.map(c => button(c.name, () => go({ kind: 'connection', id: c.id }), 'text sm')), button('＋', () => go({ kind: 'add-connection' }), 'text sm')), ownProjects())]
    : [row(small(active ? `已连接 · ${relative(p.receivedAt)}同步` : `离线 · 最后同步 ${relative(p.lastSyncAt)}`), button('连接设置', () => go({ kind: 'peer', id }), 'text sm')),
      report?.scope === 'details' ? mainAgentLine(report.mainAgent) : report?.scope === 'summary' ? small('对方只开放了项目摘要，看不到 agent') : null,
      section('项目', !active ? small('未知') : !report?.projects.length ? small('对方没有向你开放项目') : el('div', { class: 'cards' }, report.projects.map(pr => {
        const agents = pr.activity?.agents.filter(a => isRecentAgent(a))
        const count = report.scope === 'details' ? pr.pending + (agents?.filter(a => a.state === 'need').length ?? 0) : 0
        const summary = report.scope === 'summary' ? pr.counts.working ? `在做 ${pr.counts.working}` : pr.counts.review ? '等对方验收' : '项目进展' : undefined
        return projectCard({ id: pr.id, name: pr.name, count, agents, note: activityNote(pr.activity), summary }, () => { void go({ kind: 'peer-project', id, pid: pr.id }) })
      })))]
  return el('article', { class: `wsr ${p ? '' : 'me'}`, 'data-workspace': id, 'data-key': id }, el('div', { class: 'wsr-top' },
    el('button', { type: 'button', class: 'wsr-h', 'aria-expanded': String(open), 'aria-controls': `workspace-${id}`, title: p ? `${p.name} · ${p.relation ? { above: '你标的上级', below: '你标的下级', peer: '你标的平级' }[p.relation] : '还没标关系'}` : '我的工作间', onclick: () => { opened[id] = !open; remember(); render() } },
      dot(active ? 'ok' : '', active ? '已连接' : '离线'), flagged ? dot('bad flag', '有受阻的任务') : null, el('span', { class: 'name trunc' }, p?.name ?? all.links?.name ?? '我的工作间'), !p ? tag('我', 'solid') : null,
      el('span', { class: 'sum trunc xs muted' }, p ? !active ? `离线 · 最后同步 ${relative(p.lastSyncAt)}` : report?.projects.length ? `${report.projects.length} 个项目` : '' : `${all.projects.length} 个项目`), p ? null : pill(total()), icon('chevron', 'turn')),
    p && !p.relation ? button('标关系', () => go({ kind: 'relation', id }), 'sm') : null), expansion(open, open || id in opened ? el('div', { class: 'wsr-b', id: `workspace-${id}`, 'data-skip': open ? undefined : '' }, open ? body : null) : null))
}

const inboxProjectName = (id: string) => {
  if (isRemote(id)) {
    const { peer, project } = remoteSource(id)
    return [project?.name ?? '对方项目', peer?.name].filter(Boolean).join(' · ')
  }
  return all.projects.find(p => p.ref.id === id)?.ref.name ?? all.hidden?.find(p => p.id === id)?.name ?? id
}
const inboxKey = (projectId: string | undefined, taskId: string | undefined, kind: string) => JSON.stringify([projectId, taskId, kind])
const finishing = new Map<string, InboxRow>()
function matchesRow(d: Draft, row: InboxRow) {
  return d.taskId === row.taskId && d.kind === (row.kind === 'review' ? 'acceptance' : row.kind)
}
function inboxRows(projectId?: string): InboxRow[] {
  const entries: InboxRow[] = [
    ...needs().filter(a => !projectId || a.projectId === projectId).map(a => ({ id: agentInboxKey(a.id), kind: 'agent' as const, title: a.title, agent: a, projectId: a.projectId })),
    ...pending(projectId).map(a => ({ ...a, id: inboxKey(a.projectId, a.taskId, a.kind) }))
  ]
  for (const p of remoteProjects().filter(p => !projectId || p.key === projectId)) for (const t of p.feedback.tasks) for (const [kind, count] of [
    ['decision', t.decisions.length], ['review', t.acceptance.length], ['blocked', Number(t.blockedRevision !== undefined)]
  ] as const) if (count) entries.push({ id: inboxKey(p.key, t.id, kind), title: t.title, projectId: p.key, taskId: t.id, kind, count, replied: kind === 'blocked' && t.blockedStatus === 'replied' })
  for (const [id, receipt] of Object.entries(feedbackRequests)) if (!projectId || id === projectId) for (const row of receipt.rows ?? []) {
    if (!entries.some(r => r.id === row.id) && Object.values(choices(id)).some(d => matchesRow(d, row))) entries.push(row)
  }
  for (const [id, row] of finishing) if ((!projectId || row.projectId === projectId) && !entries.some(x => x.id === id)) entries.push(row)
  return entries
}
function reviewDrafts(r: InboxRow) {
  if (r.projectId && isRemote(r.projectId)) return pendingAcceptances(remoteFeedback(r.projectId)?.tasks.find(t => t.id === r.taskId))
    .map(a => ({ ...acceptanceDraft(r.taskId!, a), result: 'passed', reviewTotal: r.count }))
  return all.attention.flatMap(i => i.kind === 'review' && i.projectId === r.projectId && i.taskId === r.taskId
    ? [{ ...acceptanceDraft(i.taskId, { id: i.itemId, revision: i.itemRevision, fingerprint: i.fingerprint, title: i.summary }), result: 'passed', reviewTotal: r.count }] : [])
}
function selectReview(r: InboxRow, checked: boolean) {
  if (checked) choose(r.projectId!, ...reviewDrafts(r))
  else {
    const group = choices(r.projectId!)
    editChoices(r.projectId!, Object.entries(group).filter(([, item]) => item.taskId === r.taskId && item.kind === 'acceptance').map(([key]) => [key, null]))
  }
}
function rowPage(r: InboxRow): Page {
  return r.kind === 'agent' ? { kind: 'agents', inboxRow: r.id } : { kind: 'task', projectId: r.projectId, id: r.taskId, inboxRow: r.id }
}
function openInbox(r: InboxRow, scope: string, keyboard = false) {
  if (wideInbox && scope === homeFrame.key) { void go(rowPage(r), false, keyboard); return }
  const k = scope + r.id
  if (expandedRows.delete(k)) { if (k === lastInline) lastInline = ''; render(); return }
  expandedRows.add(k)
  if (scope === homeFrame.key) lastInline = k
  const f = inlineRows.get(k) ?? frameFor(rowPage(r))
  inlineRows.set(k, f)
  if (active.page.projectId && active.page.projectId === r.projectId && active.data) f.data = active.data
  else { f.data = undefined; f.error = undefined; void loadPage(f).then(render) }
  render()
  requestAnimationFrame(() => root.querySelector<HTMLElement>(`[data-expansion="${CSS.escape(k)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'instant' }))
}
function expansion(open: boolean, content: any, id?: string) {
  return el('div', { class: open ? 'xp open' : 'xp', 'data-key': 'expansion', 'data-expansion': id },
    el('div', { class: 'xp-in', inert: !open, 'aria-hidden': !open ? 'true' : undefined }, content))
}
function fold(id: string, title: string, body: () => any, count?: number, defaultOpen = false) {
  const open = folded.get(id) ?? defaultOpen
  return el('div', { 'data-key': id }, el('button', { type: 'button', class: 'fold-h', 'aria-expanded': String(open), onclick: () => { folded.set(id, !open); render() } },
    icon('chevron', 'turn'), title, count === undefined ? null : small(String(count))),
  expansion(open, open || folded.has(id) ? el('div', { class: 'fold-b', 'data-skip': open ? undefined : '' }, open ? body() : null) : null))
}
function inboxBody(f: Frame) {
  const p = f.page
  if (p.kind === 'agents') return agentNeedContent(p.inboxRow)
  const rowKind = JSON.parse(p.inboxRow!)[2] as Attention['kind']
  if (p.projectId && isRemote(p.projectId)) {
    const task = remoteFeedback(p.projectId)?.tasks.find(t => t.id === p.id), reason = remoteUnavailable(p.projectId)
    if (reason) return [page.kind !== 'peer-project' ? callout(reason) : null,
      rowKind === 'blocked' ? small(task?.progress ?? '任务受阻') : rowKind === 'review' ? task?.acceptance.map(a => small(a.title)) : task?.decisions.map(d => small(d.question))]
    return task ? feedbackCards(p.projectId, [task], '要你处理', rowKind) : small(feedbackRequests[p.projectId]?.input && !feedbackRequests[p.projectId]?.rejected ? '待核对' : '这项已不在待处理清单')
  }
  const currentProject = active.data?.current
  const project = currentProject && currentProject.ref.id === p.projectId ? currentProject : f.data?.current
  const task = project ? project.tasks.find(t => t.id === p.id) : f.data?.task
  if (f.error) return loadIssue(f)
  if (!project && !f.data) return section('要你处理',
    all.attention.filter(a => a.projectId === p.projectId && a.taskId === p.id && a.kind === rowKind).map(a => small(a.summary)),
    el('span', { class: 'xs muted', role: 'status' }, '正在读取详情…'))
  if (!task) return small('这项已不在待处理清单')
  return [feedbackCards(p.projectId!, [task], '要你处理', rowKind), button('任务详情', () => go({ kind: 'task', projectId: p.projectId, id: p.id }), 'text sm task-details', false, '任务详情', 'chevron')]
}
type DisplayRow = InboxRow & { details?: string[] }
function renderInboxRow(r: DisplayRow, scope: string) {
  const k = scope + r.id, review = r.kind === 'review', inRail = scope === homeFrame.key && wideInbox
  const picked = inRail && page.inboxRow === r.id, open = !inRail && expandedRows.has(k)
  if (finishing.has(r.id)) return el('article', { class: 'irow submitted', 'data-key': k }, small(`${r.title} · ✓ 已提交`))
  const selected = Object.values(choices(r.projectId ?? '')).filter(d => matchesRow(d, r))
  const passed = selected.filter(d => d.result === 'passed').length
  const unavailable = !r.details && r.projectId && isRemote(r.projectId) ? remoteUnavailable(r.projectId) : ''
  const checks = review && !r.details ? reviewDrafts(r) : []
  const awaiting = r.projectId && isRemote(r.projectId) && feedbackRequests[r.projectId]?.input && !feedbackRequests[r.projectId].rejected && selected.length
  const checked = checks.length ? checks.every(d => {
    const saved = choices(r.projectId!)[key(d.taskId, d.kind, d.itemId)]
    return saved?.result === 'passed' && saved.fingerprint === d.fingerprint && saved.itemRevision === d.itemRevision
  }) : !!awaiting && passed === r.count
  const summary = r.kind === 'agent' && r.details ? 'Agent · 需要你' : r.agent ? `${agentName(r.agent.agent)} · ${relative(r.agent.since)}开始等待`
    : `${review ? `${r.count} 项成果` : r.kind === 'decision' ? '待决定' : r.replied ? '已答复，等项目处理' : '受阻'} · ${inboxProjectName(r.projectId!)}${unavailable && scope === homeFrame.key ? ' · 暂不可提交' : ''}`
  const action = item(r.title, summary, () => {
    if (!r.details) return openInbox(r, scope)
    if (open) expandedRows.delete(k)
    else expandedRows.add(k)
    render()
  }, review ? null : dot(r.kind === 'blocked' ? 'bad' : 'need'))
  action.dataset.inboxRow = r.id
  action.setAttribute('aria-expanded', String(open || picked))
  action.setAttribute('aria-controls', inRail ? 'detail-pane' : `detail-${k}`)
  if (selected.length) action.querySelector('.body')?.append(
    small(awaiting ? '待核对' : review ? '已选 ' + Object.entries(feedbackActions).flatMap(([result, label]) => {
      const count = selected.filter(d => d.result === result).length
      return count ? [`${label} ${count}`] : []
    }).join(' · ') : '已选'))
  return el('article', { class: `irow${open ? ' open' : ''}${picked ? ' picked' : ''}`, 'data-key': k },
    el('div', { class: 'irow-h' }, review ? el('input', { type: 'checkbox', 'aria-label': `选择验收 · ${r.title} · ${inboxProjectName(r.projectId!)}`,
      checked, indeterminate: !checked && selected.length > 0, disabled: busy || !!r.details || !!unavailable,
      onchange: (e: Event) => { selectReview(r, (e.target as HTMLInputElement).checked); render() } }) : null,
    action, r.agent ? button('去回答', () => openAgent(r.agent!), 'sm') : null),
    inRail ? null : expansion(open, r.details ? el('div', { id: `detail-${k}`, class: 'irow-b' }, open ? r.details.map(small) : null) : inlineRows.has(k) ? el('div', { id: `detail-${k}`, class: 'irow-b', 'data-skip': !open ? '' : undefined },
      open ? inboxBody(inlineRows.get(k)!) : null) : null, k))
}
function inbox(projectId?: string, entries: DisplayRow[] = inboxRows(projectId)) {
  const scope = projectId ? active.key : homeFrame.key
  const reviews = entries.filter(r => r.kind === 'review' && !r.details && !finishing.has(r.id) && !(r.projectId && isRemote(r.projectId) && remoteUnavailable(r.projectId)))
  const limit = projectId || wideInbox || more ? entries.length : 3
  const visible = entries.filter((r, i) => i < limit || expandedRows.has(scope + r.id))
  const move = (e: KeyboardEvent) => {
    if (!['ArrowUp', 'ArrowDown'].includes(e.key)) return
    const host = e.currentTarget as HTMLElement, buttons = Array.from(host.querySelectorAll<HTMLElement>('[data-inbox-row]:not([disabled])'))
    const at = buttons.indexOf(e.target as HTMLElement), next = buttons[at + (e.key === 'ArrowUp' ? -1 : 1)]
    if (at < 0 || !next) return
    e.preventDefault(); next.focus({ preventScroll: true }); next.scrollIntoView({ block: 'nearest' })
    if (wideInbox && page.inboxRow && !projectId) {
      const r = entries.find(r => r.id === next.dataset.inboxRow)
      if (r) openInbox(r, scope, true)
    }
  }
  return el('section', { class: `inbox${entries.length ? '' : ' none'}`, 'aria-label': '等你处理', 'data-key': 'inbox', onkeydown: move },
    el('div', { class: 'sec-h between' }, row(el('h2', { class: 'h2' }, '等你处理'), pill(entries.length)),
      reviews.length >= 2 ? button('全选验收', () => { for (const r of reviews) selectReview(r, true); render() }, 'text sm') : null),
    !projectId ? peers().filter(p => p.report?.feedbackTruncated).map(p => small(`「${p.name}」开放的待处理内容超过同步上限，部分项目暂未列出`)) : null,
    el('div', { class: 'irows', 'data-animate': 'row' }, visible.map(r => renderInboxRow(r, scope))),
    !wideInbox && !projectId && entries.length > 3 && (more || visible.length < entries.length) ? button(more ? '收起' : `再看 ${entries.length - visible.length} 条`, () => { more = !more; remember(); render() }, 'text sm inbox-more') : null,
    !entries.length ? small('没有要你处理的事') : null)
}
function home() {
  const note = (text: string, label: string, action: () => any, danger = false) => el('button', { type: 'button', class: `note${danger ? ' danger' : ''}`, onclick: action }, dot(danger ? 'bad' : 'need'), el('span', { class: 'grow any' }, text), el('span', { class: 'go' }, label, icon('chevron')))
  return [el('div', { class: 'notes', 'data-key': 'notes' },
    !all.workspace.runId ? note('还没有主 agent', '去绑定', () => go({ kind: 'main' })) : null,
    peers().some(p => p.status === 'pending') ? note('有工作间连接待核对', '去核对', () => go({ kind: 'settings' })) : null,
    all.error ? note(all.error, '重试', () => refresh(true), true) : null,
    all.links?.error ? note(all.links.error, '去核对', () => go({ kind: 'links' }), true) : null,
    all.connections?.filter(c => c.enabled && c.state === 'error').map(c => note(`外部连接「${c.name}」异常`, '去核对', () => go({ kind: 'connection', id: c.id }), true)),
    !live.ok ? note(agentStatusText(), '重试', () => refresh(true)) : live.truncated ? note('agent 状态未全部读取，数量仅含已读取的工作区', '重试', () => refresh(true)) : null),
    el('div', { class: wideInbox ? 'home wide' : 'home', 'data-key': 'home' }, inbox(),
      el('div', { class: 'organization', inert: wideInbox && active !== homeFrame, 'aria-hidden': wideInbox && active !== homeFrame ? 'true' : undefined }, organization()))]
}
function organization() {
  const direct = peers().filter(p => ['connected', 'offline'].includes(p.status)), up = direct.filter(p => p.relation === 'above'), down = direct.filter(p => p.relation === 'below').sort((a, b) => Number(a.status === 'offline') - Number(b.status === 'offline')), side = direct.filter(p => p.relation === 'peer'), free = direct.filter(p => !p.relation)
  return section('组织', button('＋ 连接', () => go({ kind: 'links' }), 'text sm'), el('div', { class: 'org' }, up.length ? el('div', { class: 'org-up', role: 'group', 'aria-label': '上级' }, up.map(p => workspaceNode(p))) : null,
    el('div', { class: `org-in ${up.length || side.length ? 'l1' : ''} ${up.length ? 'up' : ''}` }, el('div', { class: `org-self ${side.length ? 'sib' : ''}` }, workspaceNode(), down.length ? el('div', { class: 'org-kids', role: 'group', 'aria-label': '下级' }, down.length > 8 ? el('div', { class: 'org-tools' }, input('找工作间', '', 'search', () => render(), undefined, homeFrame.form)) : null, down.filter(p => !homeFrame.form['找工作间'] || p.name.includes(homeFrame.form['找工作间'])).map(p => workspaceNode(p))) : null), side.length ? el('div', { class: 'org-side', role: 'group', 'aria-label': '平级' }, side.map(p => workspaceNode(p))) : null), free.length ? el('div', { class: 'org-free', role: 'group', 'aria-label': '还没标关系' }, free.map(p => workspaceNode(p))) : null))
}
function openArtifact(projectId: string, taskId: string, artifact: Artifact, archiveEnd?: number) {
  if (!artifact.url && isRemote(projectId)) {
    const [id, remoteProject] = JSON.parse(projectId)
    const ref = { id, projectId: remoteProject, taskId, artifactId: artifact.id }
    return previewArtifact(artifactTitle(artifact), ref,
      () => req('workspace.linkArtifact', ref, 120_000),
      (key, offset) => req('workspace.readLinkArtifact', { id, key, offset }))
  }
  return act(async () => {
    try {
      if (/^https?:\/\//i.test(artifact.url)) {
        if (!orca.shell) throw Error('请在 Orca 桌面应用中打开链接')
        const result = await orca.shell.openExternal(artifact.url)
        if (!result.opened && result.reason !== 'cancelled') throw Error('请在 Orca 窗口可见时重试')
      } else if (!(await req('project.openArtifact', { projectId, taskId, artifactId: artifact.id, archiveEnd })).opened) {
        throw Error('Orca 未打开文件')
      }
    } catch (e) {
      toastAction = { label: '重试', run: () => openArtifact(projectId, taskId, artifact, archiveEnd) }
      throw Error(`打不开「${artifact.label}」：${e instanceof Error ? e.message : '请在 Orca 桌面应用中重试'}`)
    }
  }, false)
}
const feedbackActions: Record<string, string> = { passed: '通过', changes_requested: '需要修改', discarded: '丢弃' }
const acceptanceStatuses: Record<string, string> = { pending: '待验收', passed: '已通过', changes_requested: '需要修改', discarded: '已丢弃' }
function feedbackCards(projectId: string, tasks: FeedbackTask[], title = '要你处理', only?: Attention['kind']) {
  function resultButton(base: Draft, draft: Draft | undefined, result: string) {
    const b = button(feedbackActions[result], () => {
      choose(projectId, { ...base, result, note: draft?.result === result ? draft.note : '' }); render()
    }, 'sm')
    b.setAttribute('aria-pressed', String(draft?.result === result))
    return b
  }
  function noteField(k: string, draft?: Draft) {
    if (draft?.result !== 'changes_requested' && draft?.result !== 'discarded') return null
    const label = draft.result === 'discarded' ? '丢弃原因（选填）' : '修改意见'
    return input(`${label} ${k}`, draft.note ?? '', 'textarea', note => { choose(projectId, { ...draft, note }); render() }, undefined, {}, true)
  }
  return tasks.map(t => {
    const acceptance = !only || only === 'review' ? pendingAcceptances(t) : []
    const decisions = !only || only === 'decision' ? t.decisions.filter(d => d.answer === undefined) : []
    const version = isRemote(projectId) ? t.blockedRevision : blockedRevision(t)
    const blocked = (!only || only === 'blocked') && version !== undefined
    if (!acceptance.length && !decisions.length && !blocked) return null
    const k = key(t.id, 'blocked', t.id), draft = choices(projectId)[k]
    const base: Draft = { taskId: t.id, kind: 'blocked', itemId: t.id, itemRevision: version, title: t.title, signature: String(version) }
    return section(title, acceptance.length > 1 ? button(`这 ${acceptance.length} 项全部通过`, () => {
      choose(projectId, ...acceptance.map(a => ({ ...acceptanceDraft(t.id, a), result: 'passed', reviewTotal: acceptance.length }))); render()
    }, 'sm') : null, decisions.map(d => {
      const k = key(t.id, 'decision', d.id), draft = choices(projectId)[k]
      const base: Draft = { taskId: t.id, kind: 'decision', itemId: d.id, title: d.question, signature: JSON.stringify([d.question, d.options]) }
      const field = `决定 ${k}`
      // Controls can also be mounted in an inline row of the same task.
      const group = `${active.key}-${projectId}-${k}-${only ?? 'full'}`
      return keyed(card(el('h3', { class: 'h2 any' }, d.question),
        [...d.options, '其他'].map(option => check(option, option === '其他' ? draft?.answer !== undefined && !d.options.includes(draft.answer) : draft?.answer === option, () => {
          choose(projectId, { ...base, answer: option === '其他' ? '' : option }); render()
        }, { type: 'radio', name: group, value: option })),
        draft?.answer !== undefined && !d.options.includes(draft.answer) ? input(field, draft.answer, 'textarea', value => {
          choose(projectId, { ...base, answer: value }); render()
        }, undefined, {}, true) : null, row(resultButton(base, draft, 'discarded'), draft ? button('撤销', () => removeChoice(projectId, k), 'text sm') : null), noteField(k, draft)), k)
    }), acceptance.map(a => {
      const k = key(t.id, 'acceptance', a.id), draft = choices(projectId)[k], base = acceptanceDraft(t.id, a)
      return keyed(card(row(el('h3', { class: 'h2 any grow' }, a.title), tag(`第 ${a.revision} 版`)), el('p', { class: 'any' }, a.details),
        t.artifacts.filter(ar => a.artifactIds.includes(ar.id)).map(ar => button(`打开成果 · ${ar.label}`, () => openArtifact(projectId, t.id, ar), 'sm')),
        row(...Object.keys(feedbackActions).map(result => resultButton(base, draft, result)),
          draft ? button('撤销', () => removeChoice(projectId, k), 'text sm') : null), noteField(k, draft)), k)
    }), blocked ? keyed(card(callout(t.progress || t.goal || '任务受阻', 'danger'),
      draft?.result === 'discarded' ? noteField(k, draft) : input(`受阻备注 ${k}`, draft?.note ?? '', 'textarea', note => {
        choose(projectId, { ...base, note }); render()
      }, undefined, {}, true), row(resultButton(base, draft, 'discarded'), draft ? button('撤销', () => removeChoice(projectId, k), 'text sm') : null)), k) : null)
  })
}
const invalidDraft = (d: Draft) => d.result === 'discarded' ? false : d.kind === 'decision' ? !d.answer?.trim() : (d.kind === 'blocked' || d.result === 'changes_requested') && !d.note?.trim()
function dock() {
  const groups = Object.entries(drafts).filter(([, group]) => Object.keys(group).length)
  const items = groups.flatMap(([projectId, group]) => Object.entries(group).map(([id, d]) => ({ projectId, id, d })))
  const count = items.length, incomplete = items.filter(({ d }) => invalidDraft(d)).length
  const offline = groups.map(([id]) => isRemote(id) ? remoteUnavailable(id) : '').find(Boolean)
  const checking = groups.some(([id]) => (feedbackRequests[id]?.checkingUntil ?? 0) > Date.now())
  const label = incomplete ? `有 ${incomplete} 条还没写内容` : `已选 ${count} 条 · ${groups.length} 个项目`
  const failures = Object.entries(feedbackRequests).filter(([id, record]) => record.reason && feedbackFailure(record) !== sheets[id].dismissed && Object.keys(choices(id)).length)
  const savedError = failures.map(([id, record]) => '「' + inboxProjectName(id) + '」未确认提交：' + record.reason).join('。')
  const message = error || (!busy && [savedError, notice].filter(Boolean).join('。')) || notice
  async function closeToast() {
    try {
      if (!error && !busy) for (const [id, record] of failures) await saveSubmission({ projectId: id, items: [], dismiss: feedbackFailure(record) })
      dismiss()
    } catch (e) { error = (e as Error).message; render() }
  }
  if (message !== toastText) {
    clearTimeout(toastTimer); toastText = message
    if (message && !error && !savedError) toastTimer = window.setTimeout(dismiss, toastAction?.label === '继续编辑' ? 6000 : 3200)
  }
  const action = toastAction ?? (error || savedError ? { label: error ? '重试' : '去核对', run: () => { dismiss(); void refresh(true) } } : undefined)
  return el('footer', { class: 'dock', 'data-key': 'dock' },
    el('div', { class: 'toasts', 'aria-live': 'polite', 'data-animate': 'fade' }, message ? el('div', { class: `toast${error || savedError ? ' danger' : ''}`, 'data-key': message, role: error || savedError ? 'alert' : 'status' },
      el('span', { class: 'grow any' }, message), action ? button(action.label, action.run, 'sm') : null,
      button('', closeToast, 'text sm icon', false, '关闭提示', 'close')) : overviewIssue ? el('div', { class: 'toast', role: 'status' },
        el('span', { class: 'grow any' }, overviewIssue), button('重试', () => refresh(true), 'sm')) : null),
    expansion(count > 0, el('section', { class: 'sheet', 'aria-label': '待提交', 'data-sheet': '' },
      expansion(trayOpen && count > 0, el('div', { class: 'tray-list' }, items.map(({ projectId, id, d }) => keyed(el('div', { class: 'tray-row' },
        tag(d.result ? feedbackActions[d.result] : d.kind === 'blocked' ? '受阻答复' : '决定'), el('span', { class: 'grow any' }, `${d.title} · ${inboxProjectName(projectId)}`), invalidDraft(d) ? small('还没写内容') : null,
        button('', () => removeChoice(projectId, id), 'text icon sm', false, `移除 ${d.title}`, 'close')), projectId + id)))),
      offline ? small(offline) : null,
      el('div', { class: 'row g2' }, el('button', { class: 'btn text grow trunc tray-toggle', type: 'button', disabled: busy, 'aria-expanded': String(trayOpen), onclick: () => { trayOpen = !trayOpen; render() } }, label),
        button('清空', () => { for (const [id] of groups) clearChoices(id); trayOpen = false; render() }, 'sm'),
        button(`提交 ${count} 条`, submitFeedback, 'primary', !!incomplete || !!offline || checking, offline || (checking ? '正在核对提交' : ''))))))
}
function updateSubmittedProject(project: Project) {
  ++refreshSeq; refreshing = false
  for (const frame of [...stack, ...inlineRows.values()]) {
    if (frame.page.inboxRow && frame.page.projectId === project.ref.id) frame.data = { current: project }
    else if (frame.data?.current?.ref.id === project.ref.id) frame.data.current = project
    else continue
    frame.load = (frame.load ?? 0) + 1
  }
  if (current?.ref.id === project.ref.id) current = project
  all.projects = all.projects.map(p => p.ref.id === project.ref.id ? projectSummary(project) : p)
  all.attention = [...all.attention.filter(item => item.projectId !== project.ref.id), ...attention(project)]
}
async function submitGroup(projectId: string, entries: Draft[], rows: InboxRow[], automatic = false) {
  const remote = isRemote(projectId), previous = feedbackRequests[projectId]
  if ((previous?.checkingUntil ?? 0) > Date.now()) throw Error('正在核对上次提交')
  const items = entries.map(d => key(d.taskId, d.kind, d.itemId))
  if (!entries.every((entry, index) => JSON.stringify(choices(projectId)[items[index]]) === JSON.stringify(entry))) throw Error('选择已更新，请核对')
  const prepare = { ...changeFor(projectId, items.map(key => [key, undefined]), null), exact: true }
  const version = prepare.attempt!.version
  const signature = await digest(JSON.stringify(entries))
  let input = previous?.input
  let rejected = false
  const finish = (value: Attempt | null) => saveSubmission({ ...prepare, items: prepare.items.map(item => ({ ...item, value: value ? undefined : null })),
    attempt: { version: version + 1, value } })
  if (input && previous?.signature !== signature) throw Error('上次提交的选择与当前不同，请刷新后核对')
  if (!input) {
    const source = remote ? remoteSource(projectId, (await req('workspace.links', { operation: 'read' }) as LinksSnapshot).peers) : undefined
    const project = source ? source.peer?.status === 'connected' && source.project?.feedback : all.projects.find(p => p.ref.id === projectId)
    if (!project) throw Error('项目已隐藏或读不到')
    if ('tasks' in project && !validFeedbackDrafts(project.tasks, entries)) throw Error('待处理项已更新，请核对原选择')
    input = JSON.parse(JSON.stringify({ projectId: remote ? JSON.parse(projectId)[1] : projectId, revision: project.revision, requestId: crypto.randomUUID(), items: await feedbackItems(entries) })) as DelegatedFeedback
  }
  const attempt = { signature, input, ...(remote ? { rows } : {}), reason: previous?.reason || '上次提交尚未核实' }
  // The persisted claim lets another panel recover if the submitting frame disappears.
  await saveSubmission({ ...prepare, attempt: { version, value: remote ? { ...attempt, checkingUntil: Date.now() + 60_000 } : attempt } })
  let updated: Project | undefined
  try {
    const expected = await digest(JSON.stringify(input))
    let proof: string | undefined
    if (remote) {
      const reply = await req('workspace.linkFeedback', { id: JSON.parse(projectId)[0], ...input }, 30_000)
      if (reply.requestId !== input.requestId) throw Error('待核对：回执编号不匹配')
      if (reply.state !== 'submitted') { rejected = reply.state === 'rejected'; throw Error(reply.reason || '对端未确认提交') }
      proof = reply.fingerprint
    } else {
      const local: Project | undefined = previous?.input ? (await req('project.read', { projectId })).project : undefined
      const prior = local?.requests.find(record => record.id === input!.requestId)
      if (prior) { proof = prior.fingerprint; rejected = proof !== expected; updated = local }
      else {
        if (local && !local.archive && (local.revision !== input.revision || !validFeedbackDrafts(local.tasks, entries))) { rejected = true; throw Error('项目已更新，请核对原选择') }
        const reply = await req('project.feedback', input)
        proof = reply?.project?.ref?.id === projectId ? reply.project.requests?.find((record: {id: string}) => record.id === input!.requestId)?.fingerprint : undefined
        if (proof === expected) updated = reply.project
      }
    }
    if (proof !== expected) throw Error('待核对：缺少匹配的写入凭证')
  } catch (exception) {
    const reason = exception instanceof Error ? exception.message : '提交未确认'
    await finish({ ...attempt, reason, rejected: rejected || (!remote && (exception as any)?.code === 'invalid_request'), ...(automatic ? { autoChecked: true } : {}) })
    throw Error(reason)
  }
  await finish(null)
  if (updated) updateSubmittedProject(updated)
}
let reconciling = false, reclaimTimer = 0
async function reconcileFeedback() {
  if (!all?.links || busy || pendingEdits || reconciling) return
  reconciling = true
  let earliestClaim = Infinity
  try {
    for (const id of Object.keys(feedbackRequests)) {
      const a = feedbackRequests[id]
      if (busy || !isRemote(id) || !a?.input || a.rejected) continue
      if (a.checkingUntil && a.checkingUntil > Date.now()) {
        earliestClaim = Math.min(earliestClaim, a.checkingUntil)
        continue
      }
      const { peer, project } = remoteSource(id), entries = Object.values(choices(id))
      if (!entries.length || peer && peer.status !== 'connected') continue
      try {
        if (!peer) {
          await saveSubmission(changeFor(id, [], { ...a, rejected: true, reason: '连接已断开，请在对方工作间核对' }))
          continue
        }
        const feedback = peer.report && project?.feedback
        if (feedback && feedback.revision > a.input.revision && a.input.items.every(i => {
          const t = feedback.tasks.find(t => t.id === i.taskId)
          // A newer report cannot prove which reply reached a repeatable blocked item.
          if (i.kind === 'blocked') return false
          return i.kind === 'decision' ? !t?.decisions.some(d => d.id === i.itemId && d.answer === undefined) : !t?.acceptance.some(v => v.id === i.itemId && v.status === 'pending')
        })) {
          await saveSubmission({ ...changeFor(id, Object.keys(choices(id)).map(key => [key, null]), null), exact: true })
          notice = '「' + inboxProjectName(id) + '」对方已处理'
        } else if (!a.autoChecked) {
          await submitGroup(id, entries, a.rows ?? [], true)
          notice = '已提交 ' + entries.length + ' 条'
        }
      } catch { await readSheets() } // Another panel may already own or have resolved the attempt.
    }
  } catch (e) { error = (e as Error).message }
  finally {
    clearTimeout(reclaimTimer)
    if (Number.isFinite(earliestClaim)) reclaimTimer = window.setTimeout(() => void refresh(true), earliestClaim - Date.now())
    reconciling = false; render()
  }
}
async function submitFeedback() {
  const groups = Object.entries(drafts).filter(([, group]) => Object.keys(group).length)
  if (!groups.length || groups.some(([, group]) => Object.values(group).some(invalidDraft))) return
  const origin = active
  await act(async () => {
    await edits
    if (draftFailure) throw Error(draftFailure)
    const before = inboxRows()
    const results = await Promise.all(groups.map(async ([projectId, group]) => {
      const entries = Object.values(group)
      try {
        const rows = before.filter(r => r.projectId === projectId && entries.some(d => matchesRow(d, r)))
        await submitGroup(projectId, entries, rows)
        for (const r of rows) finishing.set(r.id, r)
        return { sent: entries.length }
      } catch (e) { return { sent: 0, rejected: { projectId, reason: (e as Error).message } } }
    }))
    const sent = results.reduce((count, result) => count + result.sent, 0), rejected = results.flatMap(r => r.rejected ? [r.rejected] : [])
    trayOpen = false
    if (rejected.length) {
      error = rejected.filter(r => feedbackRequests[r.projectId]?.reason !== r.reason).map(r => `「${inboxProjectName(r.projectId)}」未确认提交：${r.reason}`).join('。')
      if (sent) notice = `其余已提交 ${sent} 条`
      const id = rejected[0].projectId
      if (!isRemote(id)) toastAction = { label: '去看看', run: () => { void go({ kind: 'project', projectId: id }) } }
    } else notice = `已提交 ${sent} 条`
    if (finishing.size) setTimeout(() => {
      const closed = origin === active && !!page.inboxRow && finishing.has(page.inboxRow)
      const finished = [...finishing.keys()]
      finishing.clear()
      const stillPending = new Set(inboxRows().map(r => r.id))
      for (const k of expandedRows) if (finished.some(id => !stillPending.has(id) && k.endsWith(id))) expandedRows.delete(k)
      if (closed && !stillPending.has(page.inboxRow!)) back(false, true)
      else render()
    }, 700)
  }, false)
  if (groups.some(([id]) => isRemote(id))) void refreshOverview()
  void readSheets().then(render).catch(() => {})
}
function taskList(tasks: { id?: string; title: string; state: keyof typeof labels; updatedAt?: string; open?: () => any }[]) {
  return tasks.length ? tasks.map((t, i) => keyed(item(t.title, [labels[t.state], t.updatedAt && relative(t.updatedAt)].filter(Boolean).join(' · '), t.open), t.id ?? String(i))) : small('还没有任务')
}
function artifactTab(projectId: string, tasks: { id: string; title: string; artifacts: Artifact[]; updatedAt?: string }[], projectUpdatedAt?: string, revision?: number): ProjectTab {
  const latest = latestArtifacts(tasks)
  return { count: latest.length, body: () => {
    if (!latest.length) return small('还没有成果')
    return latest.map(({ artifact, tasks: owners }) => {
      const [task] = owners
      const source = artifact.registeredAt ? '登记' : task.updatedAt ? '任务更新' : '项目更新'
      const summary = Array.from(owners, t => t.title).join('、') + ' · ' + source + ' ' + relative(artifact.registeredAt || task.updatedAt || projectUpdatedAt)
      const key = JSON.stringify([projectId, task.id, artifact.id])
      const confirm = form.expiring === key
      const controls = revision === undefined ? null : confirm ? row(button('确认标为过期', () => act(async () => {
        const result = await req('project.expireArtifact', { projectId, revision, taskId: task.id, artifactId: artifact.id })
        updateSubmittedProject(result.project)
        delete form.expiring
      }), 'danger sm'), button('取消', () => { delete form.expiring; render() }, 'sm'))
        : button('标为过期', () => { form.expiring = key; render() }, 'text sm')
      return keyed(card(item(artifactTitle(artifact), summary, artifact.url || isRemote(projectId) ? () => openArtifact(projectId, task.id, artifact) : undefined), controls), key)
    })
  } }
}
function projectLeadRow(label: string, tone: string, description?: string, controls?: HTMLElement) {
  return el('div', { class: 'project-lead row g2 wrap' }, dot(tone), el('span', {}, label),
    description ? el('span', { class: 'grow any muted xs' }, description) : null, controls)
}
function projectPage() {
  if (!current) return callout('正在读取项目…')
  const p = current
  const listTasks = (tasks: Project['tasks'], end?: number) => taskList(tasks.map(t => ({ ...t, state: taskState(t),
    open: () => go({ kind: 'task', projectId: p.ref.id, id: t.id, ...(end !== undefined && { end }) }) })))
  if (page.kind === 'archive') {
    const archive = active.data?.archive
    if (!archive) return small('正在读取归档…')
    return [archive.tasks.length ? listTasks(archive.tasks, archive.end) : small('这批没有归档任务'),
      small(`通知 ${archive.deliveries} 条 · 来源消息 ${archive.events} 条 · 请求凭证 ${archive.requests} 条 · 历史 ${archive.history} 条`),
      archive.previousEnd ? button('更早一批', () => go({ kind: 'archive', projectId: p.ref.id, end: archive.previousEnd })) : null]
  }
  const reason = workspaceTarget && 'error' in workspaceTarget ? workspaceTarget.error : !workspaceTarget ? '正在查找项目工作区…' : ''
  const roleAgents = projectLeadPanel?.roleAgents
  if (page.kind === 'project-settings') return [projectLeadSettings(p.ref.id), section('分工', ...(roleAgents?.length ? Object.entries(roles).map(([k, title]) => agentSelect(roleAgents, title, p.roles[k as keyof typeof roles])) : [small(catalogIssue(roleAgents))]), button('保存', () => act(async () => { const s = await req('project.settings', { projectId: p.ref.id, revision: p.revision, roles: { design: form['设计'], code: form['代码'], review: form['审查'] } }); current = s.project; if (projectLeadPanel) projectLeadPanel.binding.revision = s.project.revision; markSaved(); notice = '已保存' }), 'primary', !roleAgents?.length || Object.values(roles).some(label => !form[label]))),
    section('开放给了谁', peers().filter(peer => peer.state === 'active' && isProjectShared(p, peer)).map(peer => small(peer.name))), small(`目录：${p.ref.path}`), button('导出记录', () => orca.files?.saveAs({ suggestedName: 'project-record.json', mimeType: 'application/json', data: JSON.stringify(p, null, 2) })),
    button(p.hidden ? '恢复显示' : '隐藏项目', () => act(async () => { await req('project.visibility', { projectId: p.ref.id, revision: p.revision, hidden: !p.hidden }); clearChoices(p.ref.id); await go({ kind: 'home' }, true); await refresh() })),
    section('删除项目', callout('先导出记录，再从 Orca 移除项目并删除工作间记录，磁盘文件保留。有打开的会话时会拒绝。'), check('确认删除这个项目的全部工作间记录', !!form.delete, v => { form.delete = v; render() }), button('删除项目', () => act(async () => { const result = await req('project.delete', { projectId: p.ref.id, revision: p.revision, confirm: p.ref.id }); clearChoices(p.ref.id); await go({ kind: 'home' }, true); await refresh(); notice = `已删除，记录已导出：${result.exportPath}` }), 'danger', !form.delete))]
  if (page.kind === 'task') {
    const archive = active.data?.archive
    const t = (archive?.tasks ?? p.tasks).find(t => t.id === page.id)
    if (!t) return callout('任务已不存在，请返回项目。')
    const latest = new Map(latestArtifacts(archive?.tasks ?? p.tasks, true).map(({ artifact }) => [artifact.url || artifact, artifact.version]))
    const artifacts = t.artifacts.map(a => {
      const title = [artifactTitle(a), latest.get(a.url || a) !== a.version && '旧版本', a.expired && '已过期'].filter(Boolean).join(' · ')
      return button(title, () => openArtifact(p.ref.id, t.id, a, archive?.end), 'sm')
    })
    const workers = projectAgents(p.ref.id).filter(a => a.taskId === t.id && a.state !== 'done')
    const messages = archive ? [] : p.events.filter(e => t.sourceIds.includes(e.id) || e.taskId === t.id)
    const historyRow = (title: string, h: Acceptance['history'][number], result: string) =>
      small([title, result, h.source, h.at && new Date(h.at).toLocaleString(), h.note].filter(Boolean).join(' · '))
    const records = [...t.decisions.flatMap(d => d.history.map(h => historyRow(d.question, h, d.answer === null ? '已丢弃' : h.result))),
      ...t.acceptance.flatMap(a => a.history.map(h => historyRow(`${a.title} · 第 ${h.revision} 版`, h, acceptanceStatuses[h.result])))]
    return [row(tag(labels[taskState(t)]), small(`${p.ref.name} · ${relative(t.updatedAt)}更新`)),
      archive ? null : feedbackCards(p.ref.id, [t]),
      section('进展', el('p', { class: 'any' }, t.progress), archive ? null : [small('现在谁在做'),
        !live.ok ? small(agentStatusText()) : workers.length ? workers.map(a => agentRow(a, p.ref.name)) : small('没有看到 agent 在做这个任务'), live.ok && live.truncated ? small('agent 状态未全部读取') : null]),
      fold(active.key + '-goal', '目标', () => el('p', { class: 'any' }, t.goal), undefined, true),
      artifacts.length ? fold(active.key + '-artifacts', '成果', () => artifacts, artifacts.length) : null,
      messages.length ? fold(active.key + '-sources', '来源消息', () => messages.map(e => card(e.text)), messages.length) : null,
      archive && t.acceptance.length ? section('验收', t.acceptance.map(a => card(a.title, small(acceptanceStatuses[a.status]), small(a.details)))) : null,
      archive && t.decisions.length ? section('决定', t.decisions.map(d => card(d.question, small(d.answer === null ? '已丢弃' : d.answer ?? '待决定')))) : null,
      records.length ? fold(active.key + '-records', '记录', () => records, records.length) : null]
  }
  const manage = (sectionName: '在线会话' | '新会话') => async () => {
    await go({ kind: 'project-settings', projectId: p.ref.id })
    const target = root.querySelector<HTMLElement>(`.layer:not([inert]) section[aria-label="${sectionName}"]`)
    target?.scrollIntoView({ block: 'nearest' })
    target?.querySelector<HTMLElement>('select, button:not(:disabled)')?.focus({ preventScroll: true })
  }
  const unboundActions = () => row(button('新建主会话', manage('新会话'), 'primary sm', !!reason, reason),
    button('绑定已有会话', manage('在线会话'), 'sm', !!reason, reason))
  const empty = !inboxRows(p.ref.id).length, emptyUnbound = !p.runId && empty
  const waiting = waitingProjectCard(p.ref.id, projectLead)
  const openMain = button('打开会话', () => act(async () => {
    notice = ''
    try {
      const result = await req('project.openMain', { projectId: p.ref.id })
      notice = result.multipleConversations ? '已打开项目所在的工作区；如果有多个对话，点一下主会话的标签' : '已打开项目所在的工作区'
    } catch (e) { await loadPage(); throw e }
  }), 'text sm', !!reason, reason)
  return [waiting ?? projectLeadRow('主会话', projectLead?.session?.online === 'online' ? 'ok' : '', p.runId ? leadDescription(projectLead, '主会话') : undefined,
      p.runId ? openMain : unboundActions()),
    waiting ? null : pendingLead(projectLead?.takeover), reason ? callout(reason) : null,
    !live.ok && tabOf(p.ref.id) !== 'agents' ? small(agentStatusText()) : null,
    projectTabs(p.ref.id, {
      inbox: { count: projectCount(p.ref.id), body: () => {
        if (emptyUnbound) return waiting ? null : card(el('p', {}, '这个项目还没有主会话'), unboundActions())
        return empty && !p.tasks.length ? small('还没有任务。跟主 agent 说要做什么，它会在这里立项。') : inbox(p.ref.id)
      } },
      tasks: { count: p.tasks.length, body: () => [listTasks(p.tasks), p.archive?.taskCount ?
        button(`更早的 ${p.archive.taskCount} 项已归档`, () => go({ kind: 'archive', projectId: p.ref.id, end: p.archive?.end }), 'text sm') : null] },
      agents: { count: projectAgents(p.ref.id).length, body: () => agentsPage(p.ref.id) },
      artifacts: artifactTab(p.ref.id, p.tasks, p.updatedAt, p.ref.hostId === 'local' ? p.revision : undefined),
      messages: { count: p.deliveries.length + p.events.length, body: () => [
          p.deliveries.length ? section('通知', p.deliveries.map(d => card(d.subject, small(d.state === 'uncertain' ? '待核对，不会自动重发' : d.state === 'sent' ? '已通知' : '待通知'), small(d.error || ''),
            d.state === 'pending' ? button('发送通知', () => act(async () => { await req('project.deliver', { projectId: p.ref.id, deliveryId: d.id }); await refresh() })) : null))) : null,
          p.events.length ? section('来源消息', p.events.map(e => card(e.text))) : null,
          !p.deliveries.length && !p.events.length ? small('没有消息') : null] }
    })]
}
function sharingFields(p: LinksSnapshot['peers'][number], suggestion?: Sharing) {
  if (!form.sharing) form.sharingRevision = all.links!.revision
  const draft: Sharing = form.sharing ??= suggestion ?? { scope: p.scope, allProjects: p.allProjects === true, projectIds: [...p.projectIds], delegateFeedback: p.delegateFeedback === true }
  const scope = select('开放范围', scopes, draft.scope, v => { draft.scope = v as Sharing['scope']; if (v !== 'details') draft.delegateFeedback = false; markDirty(); form.touched = true; render() })
  return [scope, check('允许对方代为处理', draft.delegateFeedback === true, v => { draft.delegateFeedback = v; markDirty(); form.touched = true; render() }, { disabled: p.state !== 'active' || draft.scope !== 'details' }),
    draft.delegateFeedback ? small('对方能替你决定、验收和答复受阻项，提交后立即在本机生效。') : null,
    draft.scope !== 'none' ? section('开放哪些项目',
    row(check('全部项目', draft.allProjects, v => { markDirty(); form.touched = true; draft.allProjects = v; render() }, { 'data-focus': 'all-projects' }), small('以后新加的项目也会自动开放给对方')),
    all.projects.map(pr => check(pr.ref.name, isProjectShared(pr, draft), v => {
      markDirty(); form.touched = true; draft.projectIds = v ? [...draft.projectIds, pr.ref.id] : draft.projectIds.filter(id => id !== pr.ref.id)
    }, { disabled: draft.allProjects }))) : null]
}
async function saveSharing(id: string, revision = form.sharingRevision) {
  all.links = await req('workspace.links', { operation: 'share', revision, id, ...form.sharing })
  form.sharingRevision = all.links!.revision
}
function peerPage() {
  const p = peer()
  if (!p) return callout('连接不存在，请返回。')
  if (page.kind === 'peer-project') {
    const key = remoteKey(p.id, page.pid!), report = p.status === 'connected' ? p.report : undefined
    const pr = report?.projects.find(pr => pr.id === page.pid)
    if (p.status !== 'connected') {
      const rows = inboxRows(key)
      return [callout(remoteUnavailable(key)), rows.length ? projectTabs(key, { inbox: { count: rows.length, body: () => inbox(key, rows) } }) : null]
    }
    if (!report || !pr) return callout('现在看不到这个项目')
    if (report.scope !== 'details') return [small(`来自「${p.name}」，只读`), small(`对方只开放了项目摘要 · ${Object.values(pr.counts).reduce((sum, n) => sum + n, 0)} 个任务 · 待处理 ${pr.pending} 项`)]
    const rows: DisplayRow[] = inboxRows(key), agents = pr.activity?.agents.filter(a => isRecentAgent(a)) ?? []
    const addReadOnly = (kind: DisplayRow['kind'], index: number, title: string, details: string[]) => {
      rows.push({ id: JSON.stringify(['readonly', key, kind, index, title]), projectId: key, kind, title, details, count: details.length })
    }
    agents.forEach((agent, i) => {
      if (agent.state === 'need') addReadOnly('agent', i, agent.title, [agentName(agent.agent), agent.taskTitle || '未关联任务'])
    })
    pr.tasks?.forEach((t, i) => {
      if (t.phase === 'blocked' && t.blockedPending && !pr.feedback) addReadOnly('blocked', i, t.title, ['任务受阻'])
      if (!pr.feedback || t.phase === 'paused') {
        if (t.decisions.length) addReadOnly('decision', i, t.title, t.decisions)
        if (t.acceptance.length) addReadOnly('review', i, t.title, t.acceptance)
      }
    })
    const note = activityNote(pr.activity)
    const readOnly = !pr.feedback && (report.feedbackTruncated ? '待处理内容超过同步上限，本项目暂时只读' : '对方未开放代为处理')
    const lead = mainAgentInfo(report.mainAgent)
    return [projectLeadRow('主 agent', lead.tone, lead.title), small(`来自「${p.name}」，${pr.feedback ? '可代为处理' : '只读'}`),
      projectTabs(key, {
        inbox: { count: rows.length, body: () => [readOnly ? small(readOnly) : null, inbox(key, rows)] },
        tasks: { count: pr.tasks?.length ?? 0, body: () => taskList(pr.tasks ?? []) },
        agents: { count: agents.length, body: () => [pr.activity ? agentColumns(agents, () => pr.name) : null, note ? small(note) : null] },
        ...(pr.feedback?.tasks.some(t => t.artifacts.length) && { artifacts: artifactTab(key, pr.feedback.tasks, pr.updatedAt) })
      })]
  }
  if (page.kind === 'relation') {
    form.relation ??= p.relation ?? 'none'
    const suggest = (relation: string): Sharing => ({ scope: relation === 'above' ? 'summary' : 'none', allProjects: relation === 'above', projectIds: [...p.projectIds] })
    const first = !p.relation && !p.sharingSet, proposed = first && form.relation !== 'none'
    return [callout('关系只保存在你这边，不发给对方，不改变权限。'), ...Object.entries({ above: '上级 · 画在你上面', below: '下级 · 画在你下面', peer: '平级 · 虚线相连', none: '不标 · 不连线' }).map(([value, title]) => check(title, form.relation === value, () => {
      markDirty(); form.relation = value
      if (first && !form.touched) {
        const draft = form.sharing = suggest(value); form.sharingRevision ??= all.links!.revision
        form['开放范围'] = draft.scope
      }
      render()
    }, { type: 'radio', name: active.key + '-relation', value })), proposed ? section('你这边对它的设置', sharingFields(p, suggest(form.relation))) : !first ? callout(`当前开放设置：${scopes[p.scope]}${sharesAllProjects(p) ? ' · 全部项目' : ''}`) : null,
      row(button('保存', () => act(async () => { all.links = await req('workspace.links', { operation: 'relate', revision: all.links!.revision, id: p.id, relation: form.relation === 'none' ? null : form.relation }); if (proposed) await saveSharing(p.id, all.links!.revision); markSaved(); back(false, true); await refresh() }), 'primary', p.state !== 'active'), button('取消', () => back()))]
  }
  const sharing = sharesAllProjects(p) && !form.editingSharing
    ? row(el('span', {}, '全部项目'), small(scopes[p.scope]), p.delegateFeedback ? small('允许对方代为处理') : null, button('编辑开放设置', () => { form.editingSharing = true; render(); root.querySelector<HTMLElement>('[data-focus="开放范围"]')?.focus() }, 'text sm'))
    : [sharingFields(p), button('保存', () => act(async () => { await saveSharing(p.id); form.editingSharing = false; markSaved(); notice = '已保存' }), 'primary', p.state !== 'active')]
  return [small(`${statuses[p.status]} · 最后同步 ${relative(p.lastSyncAt)}`), section('关系', small(p.relation ? { above: '上级', below: '下级', peer: '平级' }[p.relation] : '未标'), button('改关系', () => go({ kind: 'relation', id: p.id }), '', p.state !== 'active')), section('对方向你开放'), section('你向对方开放', sharing),
    check('确认断开这个工作间', !!form.revoke, v => { form.revoke = v; render() }), button('断开连接', () => act(async () => { all.links = await req('workspace.links', { operation: 'revoke', id: p.id }); back(false, true); await refresh() }), 'danger', !form.revoke)]
}
function linksPage() {
  const s = all.links!
  const name = input('工作间名称', s.name, 'text', () => render())
  const invitation: LinksSnapshot['invitation'] = form.invitation
  const code = invitation ? el('textarea', { class: 'in', rows: 2, readonly: true, 'aria-label': '邀请连接码', 'data-focus': '邀请连接码', value: invitation.code }) as HTMLTextAreaElement : null
  return [
    name, button('保存名称', () => act(async () => {
      all.links = await req('workspace.links', { operation: 'rename', revision: s.revision, name: form['工作间名称'] })
      form['工作间名称'] = all.links!.name
      notice = '名称已保存'
    }), '', !form['工作间名称'].trim() || form['工作间名称'].trim() === s.name),
    button('邀请', () => act(async () => {
      const { invitation, ...links } = await req('workspace.links', { operation: 'invite' })
      all.links = links
      for (const key of ['监听 IP', '端口', '访问地址', 'enabled']) delete form[key]
      form.invitation = invitation
      notice = '已生成连接码'
    }), 'primary'),
    invitation && code && Date.parse(invitation.expiresAt) > Date.now() ? card(
      small(`有效至 ${new Date(invitation.expiresAt).toLocaleTimeString()}`), code,
      row(button('复制连接码', async () => {
        error = ''; notice = ''
        if (Date.parse(invitation.expiresAt) <= Date.now()) {
          delete form.invitation; error = '连接码已过期，请重新邀请'
        } else {
          try {
            await navigator.clipboard.writeText(invitation.code)
            notice = '已复制连接码'
          } catch {
            root.querySelector<HTMLTextAreaElement>('[aria-label="邀请连接码"]')?.select()
            if (document.execCommand('copy')) notice = '已复制连接码'
            else error = '无法自动复制，请复制选中的连接码'
          }
        }
        render()
      }), button('取消连接码', () => act(async () => {
        all.links = await req('workspace.links', { operation: 'cancel-invite' })
        delete form.invitation
        notice = '已取消连接码'
      })))) : null,
    input('对方的连接码', '', 'textarea', () => render()),
    button('加入', () => act(async () => {
      const previous = new Set(peers().map(p => p.id))
      all.links = await req('workspace.links', { operation: 'join', code: form['对方的连接码'].trim() })
      notice = peers().some(p => !previous.has(p.id) && p.status === 'pending') ? '连接结果待核对，请刷新原连接' : '已加入工作间'
      form['对方的连接码'] = ''
    }), 'primary', !form['对方的连接码'].trim()),
    fold(active.key + '-advanced', '高级', () => [
      check('启用工作间连接', form.enabled ?? s.enabled, v => { markDirty(); form.enabled = v }),
      input('监听 IP', s.host), input('端口', String(s.port), 'number'), input('访问地址', s.publicUrl),
      check('TLS', form.tls ?? s.tls, v => { markDirty(); form.tls = v }),
      input('TLS 证书', '', 'textarea'), input('TLS 私钥', '', 'password'),
      button('保存连接设置', () => act(async () => {
        all.links = await req('workspace.links', { operation: 'configure', revision: s.revision, enabled: form.enabled ?? s.enabled, host: form['监听 IP'], port: Number(form['端口']), publicUrl: form['访问地址'], tls: form.tls ?? s.tls, certificate: form['TLS 证书'], privateKey: form['TLS 私钥'] })
        form['TLS 私钥'] = ''; form['TLS 证书'] = ''; delete form.invitation
        if (all.links?.error) throw new Error(all.links.error)
        markSaved()
        notice = '已保存'
      })),
      small(s.listening || '未监听')]),
    peers().some(p => p.status === 'pending') ? button('核对连接', () => act(async () => { all.links = await req('workspace.links', { operation: 'refresh' }); await refresh() })) : null]
}
function connectionPage() {
  const c = detail?.connection, a = detail?.a2a, f = detail?.feishu, type = c?.type ?? form['类型'] ?? 'a2a'
  if (page.kind === 'connection' && !c) {
    const saved = all.connections?.find(c => c.id === page.id)
    return [saved ? row(small(saved.type === 'a2a' ? 'A2A agent' : '飞书'), small(connectionStates[saved.state])) : null,
      detailReadState('连接设置')]
  }
  const approval = detail?.approvalMode || active.approvalMode
  return [active.error ? detailReadState('连接设置') : null, !c ? select('类型', { a2a: 'A2A agent（Hermes 等）', feishu: '飞书' }, 'a2a', () => render()) : small(type === 'a2a' ? 'A2A agent' : '飞书'), input('名字', c?.name || ''), check('启用这个连接', form.enabled ?? c?.enabled ?? false, v => { markDirty(); form.enabled = v; render() }),
    type === 'a2a' ? [input('对方的地址', a?.url || ''), input('对方的令牌', '', 'password'), input('主 agent 监听端口', String(a?.port ?? 0), 'number'), input('主 agent 的令牌', '', 'password'), a?.listening ? small(a.listening) : null, approval === null ? small('正在读取审批方式…') : approval ? small(`电脑操作的批准：${approval}`) : null, small('令牌已保存时，留空保留。')] : [input('App ID', f?.feishu.appId || ''), input('App Secret', '', 'password'), input('允许的用户', f?.feishu.senderIds.join('\n') || '', 'textarea'), input('允许的会话', f?.feishu.chatIds.join('\n') || '', 'textarea')],
    c ? small(connectionStates[c.state as keyof typeof connectionStates]) : null, c?.message ? callout(c.message, 'danger') : null,
    button('保存', () => act(async () => { const split = (s: string) => s.split(/[\n,，]/).map(s => s.trim()).filter(Boolean); const result = await req('workspace.connections', { operation: 'save', ...(c ? { connectionId: c.id } : { type }), name: form['名字'], ...(type === 'a2a' ? { revision: a?.revision ?? 0, enabled: form.enabled ?? c?.enabled ?? false, url: form['对方的地址'], port: Number(form['主 agent 监听端口']), inboundToken: form['主 agent 的令牌'], outboundToken: form['对方的令牌'] } : { revision: f?.revision ?? 0, feishu: { enabled: form.enabled ?? c?.enabled ?? false, appId: form['App ID'], senderIds: split(form['允许的用户']), chatIds: split(form['允许的会话']) }, appSecret: form['App Secret'] }) }); markSaved(); active.form = {}; form = active.form; detail = result; active.page = { kind: 'connection', id: result.connection.id }; page = active.page; remember(); await refresh(); notice = '已保存' }), 'primary'),
    c?.type === 'a2a' ? button('检查连接', () => act(async () => { detail = await req('workspace.connections', { operation: 'check', connectionId: c.id }); notice = '检查完成' }), '', !c.enabled) : null,
    a ? section('最近往来', a.entries.map((e: any) => card(`${e.direction === 'incoming' ? '收到' : '发出'} · ${e.task.status.state}`, small(e.task.status.timestamp)))) : null,
    c ? [check('确认删除这个连接的设置、凭据和往来记录', !!form.delete, v => { form.delete = v; render() }), button('删除连接', () => act(async () => { await req('workspace.connections', { operation: 'delete', connectionId: c.id, confirm: true }); back(false, true); await refresh() }), 'danger', !form.delete)] : null]
}
function backupDescription(binding: WorkspaceBinding) {
  const b = binding.backup
  if (!b || b.phase === 'opening' || (b.phase === 'unavailable' && !b.problem)) return '备用正在启动'
  if (b.phase === 'single') return '只有一种 agent，不配备用'
  if (b.phase === 'unavailable' || b.phase === 'failed') return '没有备用' + (b.problem ? '：' + b.problem : '')
  const phase = { standby: '待命', probing: '等待主用确认', taking: '正在接管', active: '处理中', handoff: '正在交接', returning: '等待主用接回' }[b.phase]
  return `备用 ${agentName(b.agent)} · ${phase} · 当前${backupInCharge(b) ? '备用' : '主用'}负责`
}
function backupHistory(w: WorkspaceBinding, projectId?: string) {
  const b = w.backup
  if (!b) return null
  const retry = b.phase === 'failed' ? [
    check('已核对工作区会话，确认重新开备用', !!form['retry-' + b.cycle], v => { form['retry-' + b.cycle] = v; render() }),
    button('重新开备用', () => act(async () => {
      await req('lead.retry', { projectId, revision: w.revision, confirm: true })
      delete form['retry-' + b.cycle]; await refresh(); await loadPage()
    }, false), '', !form['retry-' + b.cycle])
  ] : null
  return [retry, b.problem && b.phase !== 'unavailable' && b.phase !== 'failed' ? callout(b.problem, 'danger') : null, b.handle ? small('备用会话 ' + b.handle) : null,
    b.history.length ? fold(active.key + '-lead-history', '接管记录', () => b.history.slice().reverse().map(e => card(new Date(e.at).toLocaleString(), e.text))) : null]
}
function leadDescription(binding: WorkspaceBinding | undefined, label: string) {
  const s = binding?.session
  const backup = binding && (binding.backup || (binding.runId && label === '主会话')) ? backupDescription(binding) : ''
  if (!s) return binding?.runId ? ['已绑定' + label, backup].filter(Boolean).join(' · ') : `还没有${label}`
  const status = label === '主 agent' ? localMainStyle(s).label
    : s.online !== 'unknown' ? mainAgentStates[s.online] : live.ok || page.kind === 'project-settings' ? agentStatusText() : ''
  return [binding?.backup ? '主用 ' + agentName(s.agent) : agentName(s.agent), s.title, status, backup].filter(Boolean).join(' · ')
}
type SwitchChoice = Omit<LeadSwitch, 'revision'>
function pendingLead(t: MainTakeover | undefined, cancel?: () => unknown) {
  if (!t) return null
  const minutes = t.state === 'expired' ? 0 : Math.max(0, Math.ceil((Date.parse(t.expiresAt) - Date.now()) / 60000))
  const status = t.error || `正在等 ${t.target.title || agentName(t.target.agent)} 接管`
  return card(callout(minutes ? `${status}，还剩 ${minutes} 分钟` : '对方没在有效期内完成绑定', !minutes || t.error ? 'danger' : ''),
    minutes && t.backupAgent ? small(`接管后会自动配一个 ${agentName(t.backupAgent)} 备用`) : null, cancel ? button('取消', cancel) : null)
}
function leadChoices(w: WorkspaceBinding, sessions: AgentSession[] | undefined, choose: (input: SwitchChoice) => unknown, project = false) {
  const label = project ? '主会话' : '主 agent'
  return [pendingLead(w.takeover, () => choose({ mode: 'cancel' })),
    section('在线会话', sessions?.map(s => card(row(el('span', { class: 'grow any' }, s.title || agentName(s.agent)),
      w.session?.handle === s.handle ? tag(`当前${label}`) : button(project || w.runId ? '换成它' : '设为主 agent', () => choose({ mode: 'existing', handle: s.handle }), 'primary')),
    small(project ? agentName(s.agent) : `${agentName(s.agent)} · ${s.workspaceName} · ${s.path}`))),
    !sessions ? detailReadState('在线会话') : !sessions.length ? small('没有可接管的在线会话') : null)]
}
function chooseProjectLead(id: string, revision: number, input: SwitchChoice) {
  return act(async () => {
    const { binding }: ProjectLead = await req('project.lead', { projectId: id, revision, ...input })
    for (const f of stack) {
      if (f.page.kind === 'project' && f.page.projectId === id && f.data?.current?.runId === binding.runId) f.data.lead = binding
    }
    markSaved(); await loadPage()
  }, false)
}
function waitingProjectCard(id: string, binding?: WorkspaceBinding) {
  const t = waitingForProjectLead(binding)
  return binding && t ? pendingLead(t, () => chooseProjectLead(id, binding.revision, { mode: 'cancel' })) : null
}
function projectLeadSettings(id: string) {
  const data = projectLeadPanel
  if (!data) return section('主会话', callout('正在读取主会话…'))
  const w = data.binding
  const waiting = waitingProjectCard(id, w)
  if (waiting) return section('主会话', waiting)
  const choose = (input: SwitchChoice) => chooseProjectLead(id, w.revision, input)
  return section('主会话', el('p', { class: 'any' }, leadDescription(w, '主会话')), backupHistory(w, id), leadChoices(w, data.sessions, choose, true),
    section('新会话', data.availableAgents?.length ? agentSelect(data.availableAgents) : callout(data.workspaceError || catalogIssue(data.availableAgents)),
      button('新开一个主会话', () => choose({ mode: 'new', agent: form.Agent }), 'primary', !data.availableAgents?.length)))
}
function detailReadState(label: string) {
  if (!active.error) return callout(`正在读取${label}…`)
  return row(callout(`${label}暂时无法读取`), button('重试', () => { active.error = undefined; render(); void loadPage().then(render) }, 'sm'))
}
function mainPage() {
  const w = all.workspace, workspaces = targets?.workspaces ?? []
  const switchMain = async (input: SwitchChoice) => {
    error = ''
    try { await req('workspace.agent.switch', { revision: all.workspace.revision, ...input }); markSaved() }
    catch (e) { error = (e as Error).message }
    await refresh()
  }
  const bots = (targets?.bots ?? []).filter((b: import('./model').BotTarget) => !b.paused && ['codex','claude'].includes(b.agent))
  const mode = bots.length ? form.mainMode ?? (w.bot ? 'bot' : 'new') : 'new'
  const loadingAgents = targets?.agentWorkspace !== form['工作区']
  const availableAgents = loadingAgents ? null : targets?.availableAgents
  return [el('p', { class: 'any' }, leadDescription(w, '主 agent')), w.bot ? el('p', {}, botStatus(w.bot)) : null,
    w.bot?.soul ? el('p', { class: 'any' }, '已写入职责说明', el('br'), w.bot.soul.backup ? '备份位置：' + w.bot.soul.backup : '原文件不存在，无需备份') : null,
    backupHistory(w), leadChoices(w, targets?.sessions, switchMain),
    active.error && targets ? detailReadState('在线会话') : null,
    bots.length ? tabButtons('切换方式', [{ id: 'bot', name: 'bot' }, { id: 'new', name: '新会话' }], mode, id => { form.mainMode = id; render() }) : null,
    targets ? el('div', { class: 'sec', role: bots.length ? 'tabpanel' : undefined, id: active.key + '-tab' }, mode === 'bot'
      ? [select('Bot', Object.fromEntries(bots.map((b: import('./model').BotTarget) => [b.id, b.name])), bots[0].id),
        button('设为主 bot', () => switchMain({ mode: 'bot', botId: form.Bot }), 'primary')]
      : [bots.length ? null : el('h2', { class: 'h2' }, '新会话'),
        select('工作区', Object.fromEntries(workspaces.map((s: any) => [s.workspace, s.name + ' · ' + s.path])), targets.agentWorkspace, () => { delete form.Agent; render(); void loadPage().then(render) }),
        availableAgents?.length ? agentSelect(availableAgents) : small(loadingAgents ? '正在读取可用代理…' : catalogIssue(availableAgents)),
        button('新开一个主 agent', () => switchMain({ mode: 'new', workspace: form['工作区'], agent: form.Agent }), 'primary', !availableAgents?.length)]) : null,
    fold(active.key + '-binding', '绑定详情', () => el('dl', { class: 'kv' }, Object.entries({ Run: w.runId || '未绑定', 会话: w.session?.handle || '未知', 目录: w.session?.path || '未知', 绑定时间: w.boundAt || '未知', 授权边界: w.securityBoundary || '未知' }).map(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])))]
}
function settingsPage() {
  return [
    all.versionLabel ? small(all.versionLabel) : null,
    section('主 agent', el('div', {}, mainAgentLine(all.workspace.session, () => go({ kind: 'main' }), !!all.workspace.runId, false))),
    section('外部连接', button('添加连接', () => go({ kind: 'add-connection' }), 'sm'), (all.connections ?? []).map(c => keyed(
      item(c.name, `${c.type === 'a2a' ? 'A2A agent' : '飞书'} · ${connectionStates[c.state]}`, () => go({ kind: 'connection', id: c.id })), c.id)), !all.connections?.length ? small('没有外部连接') : null),
    section('工作间连接', button('邀请或加入', () => go({ kind: 'links' }), 'sm'), peers().map(p => keyed(item(p.name, statuses[p.status], () => go({ kind: 'peer', id: p.id })), p.id)), !peers().length ? small('没有工作间连接') : null),
    section('机器', all.machines?.map(m => row(el('span', { class: 'grow any' }, m.name), small(m.role === 'host' ? '主机' : '附属机器'))),
      select('我在哪台电脑上', Object.fromEntries((all.machines ?? []).map(m => [m.id, m.name])), 'local', v => { active.dirty = false; persist('panel.machine', v) })),
    section('隐藏的项目', all.hidden?.length ? all.hidden.map(p => keyed(item(p.name, p.path, () => go({ kind: 'project-settings', projectId: p.id })), p.id)) : small('没有隐藏的项目'))]
}
function titleOf(f: Frame) {
  const p = f.page, project = f.data?.current, peer = all?.links?.peers.find(x => x.id === p.id)
  switch (p.kind) {
    case 'archive': return '项目归档'
    case 'project': return project?.ref.name ?? all?.projects.find(x => x.ref.id === p.projectId)?.ref.name ?? '项目'
    case 'task': return (p.projectId && isRemote(p.projectId) ? remoteFeedback(p.projectId)?.tasks.find(t => t.id === p.id)?.title : undefined) ?? f.data?.task?.title ?? (f.data?.archive?.tasks ?? project?.tasks)?.find(x => x.id === p.id)?.title ?? all?.attention.find(x => x.projectId === p.projectId && x.taskId === p.id)?.title ?? '任务'
    case 'peer': return peer?.name ?? '工作间连接'
    case 'peer-project': return (peer?.report?.projects ?? peer?.offlineFeedback)?.find(x => x.id === p.pid)?.name ?? '项目'
    case 'connection': return f.data?.connection?.connection?.name ?? all?.connections?.find(c => c.id === p.id)?.name ?? '连接'
    default: return ({ home: '工作间', settings: '设置', main: '主 agent', 'add-connection': '添加连接', links: '邀请或加入', relation: '标关系', agents: 'Agent', 'project-settings': '项目设置' } as Record<string, string>)[p.kind] ?? '工作间'
  }
}
const skeleton = () => el('div', { class: 'skeleton', role: 'status', 'aria-label': '正在读取' }, [1, 2, 3].map(i => el('div', { class: `sk sk-${i}`, 'aria-hidden': 'true' })))
const loadIssue = (f: Frame) => el('div', { class: 'card', role: 'alert' }, el('h2', { class: 'h2' }, '这一页没读出来'), el('p', { class: 'any' }, f.error),
  button('重试', () => { f.error = undefined; const ready = f === homeFrame ? refresh(true) : loadPage(f); render(); void ready.then(render) }, 'sm'))
const settingsDetail = (p: Page) => p.kind === 'connection' || p.kind === 'main'
function content(): any {
  if (page.kind === 'main') return mainPage()
  if (page.kind === 'connection') return connectionPage()
  if (active.error) return loadIssue(active)
  if (page.inboxRow) return inboxBody(active)
  if (!active.data) return skeleton()
  if (page.projectId) return current ? projectPage() : callout('项目已被移除或不可用')
  if (['peer', 'relation', 'peer-project'].includes(page.kind)) return peerPage()
  if (page.kind === 'links') return all.links ? linksPage() : callout('没有可用的工作间连接设置')
  if (page.kind === 'add-connection') return connectionPage()
  if (page.kind === 'agents') return agentContent()
  if (page.kind === 'settings') return settingsPage()
  return null
}
function heading(tag: string, f: Frame) {
  return el(tag, { class: 'h1 grow trunc', tabindex: '-1', 'data-heading': '', 'data-key': 'heading-' + f.key }, titleOf(f))
}
function backButton() {
  const parent = stack.at(-2)!, title = wideInbox && parent === homeFrame ? '组织' : titleOf(parent)
  const control = button(title, () => back(), 'sm back', false, `返回「${title}」`, 'back')
  control.setAttribute('aria-label', `返回「${title}」`)
  if (!wideInbox && parent === homeFrame && all && total()) control.append(pill(total())!)
  return control
}
const projectSettingsButton = () => page.kind === 'project' ? button('项目设置', () => go({ kind: 'project-settings', projectId: page.projectId }), 'text sm') : null
function layer(f: Frame, isTop: boolean) {
  const cover = !isTop && f !== leaving, skip = !isTop && f.mounted
  const contents = skip ? null : isTop ? content() : null
  if (isTop) f.mounted = true
  return el('section', { class: `layer${cover ? ' covered' : f === leaving && !isTop ? ' out' : direction ? ' in-' + direction : ''}`,
    'data-key': f.key, 'data-skip': skip ? '' : undefined, inert: !isTop, 'aria-hidden': !isTop ? 'true' : undefined, 'aria-label': titleOf(f) }, contents)
}
function render() {
  if (!all) {
    updateChildren(root, el('div', {}, el('header', { class: 'top' }, heading('h1', homeFrame)),
      el('div', { class: 'initial' }, error || overviewIssue ? card(el('p', {}, error || overviewIssue), button('重试', () => refresh(true), 'sm')) : skeleton())))
    return
  }
  actionIds = {}
  const atHome = active === homeFrame, depth = stack.length - 1, masked = !wideInbox && !atHome
  const refreshButton = button('', () => refresh(true), `text icon${refreshing ? ' spin' : ''}`, refreshing, '刷新', 'refresh')
  const homeButton = !wideInbox && depth > 1 ? button('', () => back(true), 'text sm', false, '回首页', 'home') : null
  if (homeButton && total()) homeButton.append(pill(total())!)
  const header = el('header', { class: 'top', 'data-key': 'header', inert: busy },
    masked ? backButton() : null, heading('h1', masked ? active : homeFrame),
    masked ? projectSettingsButton() : null, homeButton, refreshButton,
    !masked ? button('', () => go({ kind: 'settings' }, true), 'text icon', false, '设置', 'settings') : null)
  const skipHome = masked && homeFrame.mounted
  const homeLayer = el('section', { class: `layer home-layer${masked ? leaving === homeFrame ? ' out' : ' covered' : atHome && direction ? ' in-' + direction : ''}`,
    'data-key': homeFrame.key, 'data-skip': skipHome ? '' : undefined, inert: masked, 'aria-hidden': masked ? 'true' : undefined, 'aria-label': '组织首页' }, skipHome ? null : home())
  if (!masked) homeFrame.mounted = true
  const frames = stack.slice(1)
  if (leaving && leaving !== homeFrame && !frames.includes(leaving)) frames.push(leaving)
  const pane = frames.length ? el('section', { class: `pane${wideInbox ? ' wide-pane' : ''}${atHome ? ' closing' : ''}`, id: 'detail-pane',
    inert: atHome, 'aria-hidden': atHome ? 'true' : undefined, 'aria-label': '详情' },
    !atHome ? el('div', { class: 'pane-top', inert: !wideInbox }, backButton(), heading('h2', active), projectSettingsButton(),
      depth > 1 ? button('', () => back(true), 'text sm icon', false, '关闭，回到组织', 'close') : null) : null,
    el('div', { class: 'pane-layers' }, frames.map(f => layer(f, f === active)))) : null
  root.setAttribute('aria-busy', String(busy))
  updateChildren(root, el('div', {}, header, el('div', { class: `layers${wideInbox && !atHome ? ' has-pane' : ''}`, 'data-key': 'layers', inert: busy }, homeLayer, pane), dock()))
}
document.addEventListener('keydown', e => {
  if (e.isComposing || e.keyCode === 229 || !(e.key === 'Escape' || e.altKey && e.key === 'ArrowLeft') || busy) return
  if (trayOpen) { trayOpen = false; render() }
  else if (active !== homeFrame) back()
  else if (e.key === 'Escape' && expandedRows.size && !wideInbox) { expandedRows.clear(); render() }
  else return
  e.preventDefault()
})
new ResizeObserver(([entry]) => {
  const wide = entry.contentRect.width >= 620
  if (wide === wideInbox) return
  wideInbox = wide
  if (wide && active === homeFrame && lastInline && expandedRows.has(lastInline)) {
    const detail = inlineRows.get(lastInline)
    if (detail) {
      detail.opener = Array.from(root.querySelectorAll<HTMLElement>('[data-inbox-row]')).find(e => e.dataset.inboxRow === detail.page.inboxRow)
      organizationScroll = root.querySelector<HTMLElement>('.home-layer')?.scrollTop ?? 0
      stack.push(detail); useFrame(detail); remember()
    }
  }
  if (all) render()
}).observe(root)
async function start() {
  try {
    const [saved, opening] = await Promise.all([orca.storage.get('panel.home'), orca.storage.get('workspace.navigation'), readSheets()]) as any[]
    if (saved?.at && Date.now() - saved.at < 30 * 60_000) {
      opened = saved.opened ?? opened; Object.assign(tabsOf, saved.tabs); more = !!saved.more
      stack.push(...saved.pages.slice(1).filter((p: Page) => p.kind !== 'question').map((p: Page) => frameFor(p))); useFrame(stack.at(-1)!)
    }
    orca.plugin.on('panel.draftsChanged', () => { if (!busy && !pendingEdits) void readSheets().then(render).catch(e => { error = e.message; render() }) })
    orca.plugin.on('project.changed', () => { if (!(busy && busyAction.startsWith('提交'))) void refresh() })
    orca.plugin.on('workspace.open', e => { void go({ kind: e.switching ? 'main' : 'home' }, true).then(() => refresh()) })
    if (opening?.switching) {
      const f = frameFor({ kind: 'main' }); stack = [homeFrame, f]; useFrame(f)
      await orca.storage.set('workspace.navigation', { switching: false })
    }
    await refresh()
  } catch (e) { error = (e as Error).message; render() }
}
void start()
setInterval(() => {
  if (page.kind === 'main' && all?.workspace.takeover ||
    page.kind === 'project-settings' && projectLeadPanel?.binding.takeover ||
    page.kind === 'project' && projectLead?.takeover) render()
}, 30000)
