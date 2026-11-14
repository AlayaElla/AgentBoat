import { OrgCanvas, activateKey, moved, scopes, rules, agents, roles, statuses, type Layer, type Node, type Edge, type Point } from './org-canvas'
import type { Project } from './model'
import type { Sharing } from './links'
import type { OrcaFrameApi } from 'orca/frame'
import { bindingRows, takeoverText } from './main-agent-view'

export function startCanvas(root: HTMLElement, api: Pick<OrcaFrameApi, 'plugin' | 'storage'>) {
  const model = new OrgCanvas(api)
  let layer: Layer = 'links', busy = false, loading = false, reload = false, closed = false
  let graph: ReturnType<OrgCanvas['graph']>, centered: Layer | undefined
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = document.createElement(tag); node.textContent = text; return node
  }
  const button = (text: string, action: () => unknown) => { const b = el('button', text); b.type = 'button'; b.onclick = () => { void action() }; return b }
  const header = el('header'), nav = el('nav'), error = el('div'), notice = el('div'), workspace = el('div'), viewport = el('div'), editor = el('aside')
  header.append(el('h1', '组织画布'), nav); error.id = 'error'; error.setAttribute('role', 'alert'); notice.id = 'notice'; notice.setAttribute('role', 'status')
  workspace.className = 'workspace'; viewport.className = 'viewport'; editor.hidden = true; editor.setAttribute('aria-label', '编辑组织关系')
  const tabs = (['links', 'projects'] as const).map((value, i) => {
    const b = button(['工作间连接', '工作间内部'][i], () => { layer = value; dismiss(); draw(); }); nav.append(b); return b
  })
  nav.append(button('刷新', () => run(async () => { await api.plugin.request('workspace.links', { operation: 'refresh' }); await refresh() })), button('添加连接', () => connect()))
  const help = el('details'), tip = el('summary', '操作帮助')
  help.append(tip, el('p', '拖动节点调整位置。Tab 选择节点或连线，Enter 编辑；选中节点后用方向键移动。连线表示组织关系。'))
  header.append(help)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('aria-label', '组织关系画布'); svg.setAttribute('role', 'group')
  viewport.append(svg); workspace.append(viewport, editor); root.replaceChildren(header, error, notice, workspace)
  function report(e: unknown) { error.textContent = e instanceof Error ? e.message : '操作未完成，请刷新核对。' }
  async function run(work: () => Promise<unknown>) {
    if (busy) return
    busy = true; error.textContent = ''; root.setAttribute('aria-busy', 'true')
    const controls = Array.from(root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button,input,select,textarea'))
    const enabled = controls.filter(c => !c.disabled); enabled.forEach(c => { c.disabled = true })
    try { await work() } catch (e) { report(e) }
    finally { busy = false; root.removeAttribute('aria-busy'); enabled.forEach(c => { c.disabled = false }); if (reload) { reload = false; void refresh() } }
  }
  async function refresh() {
    if (loading) { reload = true; return }
    loading = true
    try { await model.load(); if (!closed) { draw(); notice.textContent = model.overview.error || model.links.error || (layer === 'projects' && model.overview.hidden?.length ? `已隐藏 ${model.overview.hidden.length} 个项目` : '') } }
    catch (e) { report(e) }
    finally { loading = false; if (reload && !busy) { reload = false; void refresh() } }
  }
  function dismiss() { editor.hidden = true; editor.replaceChildren() }
  function form(title: string) {
    editor.replaceChildren(); editor.hidden = false
    const f = el('form'), h = el('h2', title), close = button('关闭', () => { dismiss(); viewport.focus() })
    f.append(h, close); editor.append(f); h.tabIndex = -1; h.focus(); return f
  }
  function field<T extends HTMLElement>(f: HTMLElement, title: string, control: T): T { const label = el('label', title); label.append(control); f.append(label); return control }
  function select(f: HTMLElement, title: string, values: Record<string, string>, value: string) {
    const s = el('select'); Object.entries(values).forEach(([value, text]) => { const o = el('option', text); o.value = value; s.append(o) }); s.value = value; return field(f, title, s)
  }
  function submit(f: HTMLFormElement, work: () => Promise<unknown>) { const b = el('button', '保存'); b.className = 'primary'; b.type = 'submit'; f.append(b); f.onsubmit = e => { e.preventDefault(); void run(work) } }
  async function openProject(id: string) {
    await run(async () => {
      const p = await model.project(id), f = form(p.ref.name)
      const info = el('p', `${p.ref.path}\n${p.ref.id}\n主 Run：${p.runId || '未绑定'}\n主 agent：${p.mainAgent ? agents[p.mainAgent] : p.runId ? '种类未知' : '未绑定'}`); info.className = 'identity'; f.append(info)
      const controls = Object.entries(roles).map(([key, label]) => [key, select(f, label, agents, p.roles[key as keyof typeof roles])] as const)
      submit(f, async () => { await model.saveRoles(p, Object.fromEntries(controls.map(([key, s]) => [key, s.value])) as Project['roles']); dismiss(); draw(); notice.textContent = '角色分工已保存' })
    })
  }
  function openPeer(id: string) {
    if (busy || !model.links) return
    const p = model.links.peers.find(p => p.id === id)
    if (!p) return
    const revision = model.links.revision
    const f = form(p.name), state = el('p', `${statuses[p.status]}\n对方开放：${p.report ? scopes[p.report.scope] : '未知'}\n对方接受派活：${p.report?.acceptTasks ? rules[p.report.acceptTasks] : '未知'}`)
    state.className = 'identity'; f.append(state)
    if (p.receivedAt) f.append(el('p', `最近收到：${new Date(p.receivedAt).toLocaleString('zh-CN')}`))
    const scope = select(f, '向对方开放', scopes, p.scope), rule = select(f, '接受对方派活', rules, p.acceptTasks), projects = el('fieldset')
    projects.append(el('legend', '开放的项目'))
    const selected = new Set(p.projectIds), checks: HTMLInputElement[] = []
    for (const project of model.projects) {
      const check = el('input'); check.type = 'checkbox'; check.value = project.ref.id; check.checked = selected.has(project.ref.id); checks.push(check)
      const label = el('label'); label.className = 'check'; label.append(check, el('span', `${project.ref.name} · ${project.ref.path}`)); projects.append(label)
    }
    f.append(projects)
    if (p.state === 'active') submit(f, async () => {
      // Hidden or temporarily unavailable projects are kept unless explicitly changed in the original settings.
      const projectIds = [...p.projectIds.filter(id => !checks.some(c => c.value === id)), ...checks.filter(c => c.checked).map(c => c.value)]
      await model.share(id, { scope: scope.value as Sharing['scope'], acceptTasks: rule.value as Sharing['acceptTasks'], projectIds }, revision); dismiss(); draw(); notice.textContent = '连接规则已保存'
    })
    else f.append(el('p', '连接结果待核对，请刷新原连接。'))
    let confirm = false
    const revoke = button('断开连接', () => {
      if (!confirm) { confirm = true; revoke.textContent = '确认断开'; f.append(el('p', '将停止共享，并把未完成的跨工作间请求标为连接已断开。')); return }
      void run(async () => { model.links = await api.plugin.request('workspace.links', { operation: 'revoke', id }); dismiss(); draw(); notice.textContent = '连接已断开' })
    }); f.append(revoke)
  }
  function connect() {
    if (!model.links) return
    const f = form('添加连接')
    f.append(el('p', model.links.listening ? `正在监听 ${model.links.listening}` : '生成连接码前，请在工作间 → 设置 → 其他工作间 → 连接设置中启用监听。'))
    const invite = button('生成连接码', () => run(async () => {
      const s = await api.plugin.request('workspace.links', { operation: 'invite' })
      const code = el('textarea'); code.readOnly = true; code.value = s.invitation!.code
      invite.remove(); field(f, '连接码（两分钟内、仅用一次，请私下交给对方）', code)
      f.append(button('撤销连接码', () => run(async () => { await api.plugin.request('workspace.links', { operation: 'cancel-invite' }); connect() })))
    })); invite.disabled = !model.links.listening; f.append(invite)
    const code = field(f, '对方的连接码', el('textarea'))
    f.append(button('连接工作间', () => run(async () => {
      model.links = await api.plugin.request('workspace.links', { operation: 'join', code: code.value.trim() })
      const pending = model.links.peers.some(p => p.state === 'pending')
      dismiss(); draw(); notice.textContent = pending ? '连接结果待核对，请刷新原连接。不要重复配对。' : '已连接'
    })))
    f.onsubmit = e => e.preventDefault()
  }
  function open(item: Node | Edge) {
    if (busy) return
    const connection = model.overview.connections?.find(c => item.id === c.id || item.id === `${c.id}-main`)
    if (connection) {
      const f = form(connection.name)
      f.append(el('p', connection.enabled ? connection.message || '已启用' : '未启用'))
      f.append(el('p', '在工作间 → 设置 → 外部连接中查看和修改这个连接。')); return
    }
    if (item.projectId) { void openProject(item.projectId); return }
    if (item.peerId) { openPeer(item.peerId); return }
    const f = form('工作间主 agent'), w = model.overview.workspace
    const info = el('p', w.runId ? bindingRows(w).map(r => `${r.label}：${r.value}`).join('\n') : '未绑定'); info.className = 'identity'; f.append(info)
    if (takeoverText(w)) f.append(el('p', takeoverText(w)))
    f.append(button(w.runId ? '切换主 agent' : '设置主 agent', () => run(() => api.plugin.request('workspace.entry'))))
  }
  const ns = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = '') => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); e.textContent = text; return e
  }
  function draw() {
    if (!model.links) return
    const focus = document.activeElement?.getAttribute('data-id')
    graph = model.graph(layer); svg.replaceChildren()
    tabs.forEach((tab, i) => tab.setAttribute('aria-pressed', String((i === 0 ? 'links' : 'projects') === layer)))
    notice.textContent = layer === 'projects' && model.overview.hidden?.length ? `已隐藏 ${model.overview.hidden.length} 个项目` : ''
    for (const edge of graph.edges) {
      const group = ns('g', { class: 'edge', tabindex: '0', role: 'button', 'aria-label': edge.lines.length ? `${model.links.peers.find(p => p.id === edge.peerId)?.name} · ${edge.lines.join('；')}` : '编辑项目分工', 'data-id': edge.id })
      group.append(ns('path', { class: 'hit' }), ns('path', { class: 'line' }))
      if (edge.lines.length) { group.append(ns('rect', { width: '370', height: '78', rx: '6' })); edge.lines.forEach((line, i) => group.append(ns('text', { 'data-row': String(i) }, line))) }
      group.onclick = () => open(edge); group.onkeydown = e => { if (activateKey(e.key)) { e.preventDefault(); open(edge) } }; svg.append(group)
    }
    for (const node of graph.nodes) {
      const group = ns('g', { class: 'node', tabindex: '0', role: 'button', 'aria-label': `${node.title} · ${node.detail}`, 'data-id': node.id, 'data-node': node.id })
      const short = (s: string) => [...s].length > 14 ? [...s].slice(0, 13).join('') + '…' : s
      group.append(ns('title', {}, `${node.title}\n${node.detail}`), ns('rect', { width: node.lines ? '370' : '220', height: String(node.lines ? 48 + node.lines.length * 22 : 72), rx: '10' }), ns('text', { x: '14', y: '28' }, short(node.title)))
      if (node.lines) node.lines.forEach((line, i) => group.append(ns('text', { x: '14', y: String(54 + i * 22), class: 'detail' }, line)))
      else group.append(ns('text', { x: '14', y: '52', class: 'detail' }, short(node.detail)))
      group.onclick = () => { if (!dragged) open(node) }
      group.onkeydown = e => {
        if (busy) return
        if (activateKey(e.key)) { e.preventDefault(); open(node) }
        const next = moved(node, e.key)
        if (next) { e.preventDefault(); Object.assign(node, next); place(); void model.savePosition(layer, node.id, next).catch(report) }
      }; svg.append(group)
    }
    if (!graph.edges.length && layer === 'links') notice.textContent = '尚未连接其他工作间'
    place()
    if (centered !== layer) {
      centered = layer
      const home = graph.nodes[0]
      viewport.scrollLeft = Math.max(0, home.x + 110 - viewport.clientWidth / 2)
      viewport.scrollTop = Math.max(0, home.y - 100)
    }
    if (focus) Array.from(svg.querySelectorAll<SVGElement>('[data-id]')).find(e => e.getAttribute('data-id') === focus)?.focus()
  }
  function place() {
    const nodes = new Map(graph.nodes.map(n => [n.id, n]))
    svg.setAttribute('width', String(Math.max(1100, ...graph.nodes.map(n => n.x + (n.lines ? 410 : 260)))))
    svg.setAttribute('height', String(Math.max(500, ...graph.nodes.map(n => n.y + (n.lines ? 80 + n.lines.length * 22 : 120)))))
    for (const g of Array.from(svg.querySelectorAll<SVGGElement>('.node'))) { const n = nodes.get(g.getAttribute('data-id')!)!; g.setAttribute('transform', `translate(${n.x},${n.y})`) }
    for (const g of Array.from(svg.querySelectorAll<SVGGElement>('.edge'))) {
      const edge = graph.edges.find(e => e.id === g.getAttribute('data-id'))!, a = nodes.get(edge.from)!, b = nodes.get(edge.to)!
      const x = b.x >= a.x ? a.x + (a.lines ? 370 : 220) : a.x, endX = b.x >= a.x ? b.x : b.x + (b.lines ? 370 : 220), y = a.y + 36, endY = b.y + 36, mid = (x + endX) / 2
      g.querySelectorAll('path').forEach(p => p.setAttribute('d', `M ${x} ${y} C ${mid} ${y}, ${mid} ${endY}, ${endX} ${endY}`))
      g.querySelector('rect')?.setAttribute('transform', `translate(${mid - 185},${(y + endY) / 2 - 42})`)
      g.querySelectorAll('text').forEach(t => { t.setAttribute('x', String(mid - 175)); t.setAttribute('y', String((y + endY) / 2 - 22 + Number(t.getAttribute('data-row')) * 23)) })
    }
  }
  let drag: { node: Node; origin: Point; start: Point; layer: Layer } | undefined, dragged = false
  svg.onpointerdown = e => {
    if (busy || e.button !== 0) return
    const target = (e.target as Element).closest('[data-node]'), node = graph?.nodes.find(n => n.id === target?.getAttribute('data-node'))
    if (!node) return
    dragged = false; (target as SVGElement).focus(); drag = { node, origin: { x: node.x, y: node.y }, start: { x: e.clientX, y: e.clientY }, layer }
    svg.setPointerCapture(e.pointerId); e.preventDefault()
  }
  svg.onpointermove = e => {
    if (!drag) return
    const dx = e.clientX - drag.start.x, dy = e.clientY - drag.start.y
    if (Math.abs(dx) + Math.abs(dy) > 4) dragged = true
    if (dragged) { drag.node.x = Math.max(0, Math.min(20000, drag.origin.x + dx)); drag.node.y = Math.max(0, Math.min(20000, drag.origin.y + dy)); place() }
  }
  svg.onpointerup = e => {
    const finished = drag; drag = undefined
    if (finished && dragged) void model.savePosition(finished.layer, finished.node.id, finished.node).catch(report)
    if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId)
    if (finished && !dragged) open(finished.node)
    if (reload && !busy) { reload = false; void refresh() }
  }
  svg.onpointercancel = () => { if (drag) { Object.assign(drag.node, drag.origin); place() }; drag = undefined }
  const subscription = api.plugin.on('project.changed', () => { if (busy || loading || drag) reload = true; else void refresh() })
  void refresh()
  return { model, refresh, dispose() { closed = true; subscription.dispose() } }
}

if (typeof document !== 'undefined' && document.getElementById('app')) startCanvas(document.getElementById('app')!, orca)
