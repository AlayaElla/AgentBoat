import type { OrcaFrameApi } from 'orca/frame'
import type { Overview, Project, Snapshot } from './model'
import type { LinksSnapshot, Sharing } from './links'
import { bindingRows, takeoverText } from './main-agent-view'

export const scopes = { none: '不开放', summary: '项目摘要', details: '含任务详情' }
export const rules = { deny: '不接受', confirm: '需我确认', auto: '自动受理' }
export const statuses = { connected: '已连接', offline: '离线', pending: '待核对', revoked: '已断开' }
export const agents = { claude: 'Claude', codex: 'Codex' }
export const roles = { design: '设计', code: '编码', review: '审查' }
export type Layer = 'links' | 'projects'
export type Point = { x: number; y: number }
export type Node = Point & { id: string; title: string; detail: string; lines?: string[]; projectId?: string; peerId?: string }
export type Edge = { id: string; from: string; to: string; lines: string[]; projectId?: string; peerId?: string }
export type Layout = { version: 1; positions: Record<string, Point> }
export const layoutKey = 'org.canvas.layout'
export function layout(raw: unknown): Layout {
  if (raw === null) return { version: 1, positions: {} }
  const v = raw as Layout
  if (!v || v.version !== 1 || !v.positions || typeof v.positions !== 'object' || Array.isArray(v.positions) || Object.keys(v.positions).length > 1000) throw Error('画布位置记录不兼容，请保留数据并检查插件版本。')
  for (const [id, p] of Object.entries(v.positions)) {
    if (id.length > 600 || !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x > 20000 || p.y > 20000) throw Error('画布位置记录不正确，请保留数据并检查插件版本。')
  }
  return v
}
export const activateKey = (key: string) => key === 'Enter' || key === ' '
export function moved(p: Point, key: string): Point | undefined {
  const delta: Record<string, Point> = { ArrowLeft: { x: -20, y: 0 }, ArrowRight: { x: 20, y: 0 }, ArrowUp: { x: 0, y: -20 }, ArrowDown: { x: 0, y: 20 } }
  const d = delta[key]
  return d ? { x: Math.max(0, Math.min(20000, p.x + d.x)), y: Math.max(0, Math.min(20000, p.y + d.y)) } : undefined
}

// The canvas stores only coordinates; all organization edits use the existing worker requests.
export class OrgCanvas {
  overview!: Overview
  links!: LinksSnapshot
  projects: (Project & Pick<Snapshot, 'mainAgent'>)[] = []
  positions: Layout = { version: 1, positions: {} }
  private writes: Promise<void> = Promise.resolve()
  constructor(readonly api: Pick<OrcaFrameApi, 'plugin' | 'storage'>) {}
  async load() {
    await this.writes
    const [all, links, positions] = await Promise.all([this.api.plugin.request('workspace.overview'), this.api.plugin.request('workspace.links', { operation: 'read' }), this.api.storage.get(layoutKey)])
    const snapshots = await Promise.all(all.projects.map(p => this.api.plugin.request('project.read', { projectId: p.ref.id })))
    this.overview = all; this.links = links; this.positions = layout(positions)
    this.projects = snapshots.flatMap(s => s.project && !s.project.hidden ? [{ ...s.project, mainAgent: s.mainAgent }] : [])
  }
  graph(layer: Layer): { nodes: Node[]; edges: Edge[] } {
    const nodes: Node[] = [], edges: Edge[] = []
    const add = (node: Node) => { nodes.push({ ...node, ...this.positions.positions[`${layer}:${node.id}`] }) }
    if (layer === 'links') {
      const peers = this.links.peers.filter(p => p.state !== 'revoked'), radius = Math.max(480, peers.length * 55)
      const center = { x: radius + 40, y: peers.length < 3 ? 160 : radius + 40 }
      add({ id: 'own', title: this.links.name, detail: '本工作间 · 主 agent', ...center })
      peers.forEach((p, i) => {
        const angle = i * 2 * Math.PI / peers.length
        add({ id: `peer:${p.id}`, title: p.name, detail: statuses[p.status], peerId: p.id, x: Math.round(center.x + Math.cos(angle) * radius), y: Math.round(center.y + Math.sin(angle) * radius) })
        edges.push({ id: `link:${p.id}`, from: 'own', to: `peer:${p.id}`, peerId: p.id, lines: [
          `我 → 对方：${scopes[p.scope]} · ${rules[p.acceptTasks]}`,
          `对方 → 我：${p.report ? scopes[p.report.scope] : '未知'} · ${p.report?.acceptTasks ? rules[p.report.acceptTasks] : '未知'}`,
          statuses[p.status]
        ] })
      })
    } else {
      const w = this.overview.workspace, info = w.runId ? bindingRows(w).map(r => `${r.label}：${r.value}`) : ['未绑定 · 点击设置主 agent']
      if (takeoverText(w)) info.push(takeoverText(w))
      const lines = info.flatMap(s => s.match(/.{1,22}/gu) ?? [])
      add({ id: 'main', title: '工作间主 agent', detail: info.join('\n'), lines, x: 40, y: 100 })
      for (const [i, c] of (this.overview.connections ?? []).entries()) {
        add({ id: c.id, title: `${c.name} · ${c.type === 'a2a' ? 'A2A' : '飞书'}`, detail: { off: '未启用', connecting: '连接中', connected: '已连接', error: '连接异常', unchecked: '未检查' }[c.state], x: 40, y: 430 + i * 100 })
        edges.push({ id: `${c.id}-main`, from: c.id, to: 'main', lines: [] })
      }
      this.projects.forEach((p, i) => {
        add({ id: `project:${p.ref.id}`, title: p.ref.name, detail: p.runId ? `主 agent：${p.mainAgent ? agents[p.mainAgent] : '种类未知'}` : '主 agent：未绑定', projectId: p.ref.id, x: 450, y: 40 + i * 300 })
        edges.push({ id: `main:${p.ref.id}`, from: 'main', to: `project:${p.ref.id}`, projectId: p.ref.id, lines: [] })
        Object.entries(roles).forEach(([role, title], j) => {
          const id = `role:${p.ref.id}:${role}`
          add({ id, title, detail: agents[p.roles[role as keyof typeof roles]], projectId: p.ref.id, x: 760, y: 20 + i * 300 + j * 90 })
          edges.push({ id, from: `project:${p.ref.id}`, to: id, projectId: p.ref.id, lines: [] })
        })
      })
    }
    return { nodes, edges }
  }
  savePosition(layer: Layer, id: string, point: Point) {
    const key = `${layer}:${id}`, value = { x: Math.max(0, Math.min(20000, point.x)), y: Math.max(0, Math.min(20000, point.y)) }
    this.positions.positions[key] = value
    const save = this.writes.then(async () => {
      const latest = layout(await this.api.storage.get(layoutKey))
      latest.positions[key] = value
      layout(latest)
      await this.api.storage.set(layoutKey, latest)
    })
    this.writes = save.catch(() => {})
    return save
  }
  async share(id: string, value: Sharing, revision: number) {
    this.links = await this.api.plugin.request('workspace.links', { operation: 'share', revision, id, ...value })
  }
  async project(id: string) {
    const s = await this.api.plugin.request('project.read', { projectId: id })
    if (!s.project || s.project.hidden) throw Error('项目已隐藏或不可用，请刷新画布。')
    return { ...s.project, mainAgent: s.mainAgent }
  }
  async saveRoles(p: Project, value: Project['roles']) {
    const s = await this.api.plugin.request('project.settings', { projectId: p.ref.id, revision: p.revision, roles: value, feishu: p.feishu })
    this.projects = this.projects.map(p => p.ref.id === s.project?.ref.id ? { ...s.project, mainAgent: s.mainAgent } : p)
  }
}
