import { labels, mainAgentStates, results, deliveryStates, agentName, sourceName, roles, agents, connectionStates } from './model'
import { atom, read, set, update, plugin, shell, files, Stack, Row, Box, Heading, Text, Button, IconButton, Badge, List, ListItem, Link,
  Select, Textarea, RadioGroup, Field, Tabs, Tab, Collapsible, EmptyState, Callout, Skeleton, KeyValue, Checkbox, RelativeTime, type PanelContext, type Tone } from 'orca'
import { taskState, type Acceptance, type Decision, type Project, type ProjectRef, type Snapshot, type Task, type Overview } from './model'
import { storage } from 'orca'
import { linksSection, linksPage, closeLinks, loadLinks, pendingRequests, requestPage } from './links-panel'
import { groupedAttention } from './model'
import { connectionsList, addConnection, connectionPage, loadConnection, clearConnectionDraft } from './connections-panel'
import { bindingRows, takeoverText } from './main-agent-view'


type Page = { kind: 'home' | 'project' | 'task' | 'project-settings' | 'settings' | 'main' | 'connections' | 'connection' | 'add-connection' | 'new-connection' | 'machines' | 'links' | 'request'; projectId?: string; id?: string }
const navigation = atom<{ page: Page; stack: Page[] }>('workspace.page', { page: { kind: 'home' }, stack: [] }, { persist: 'plugin' })
const page = () => read(navigation).page
const selectedId = () => page().projectId || ''
const filter = atom(''), expanded = atom(false), deleteConfirmed = atom(false), linksTab = atom('activity')
function clearDrafts() { set(notes, {}); set(picks, {}); set(editing, ''); clearConnectionDraft(); closeLinks(); set(deleting, ''); set(deleteConfirmed, false); set(mainSwitch, false); set(mainChoice, { mode: 'existing', handle: '', workspace: '', agent: 'claude', confirm: false }); set(failure, null) }
function go(next: Page, reset = false) { clearDrafts(); update(navigation, n => ({ page: next, stack: reset ? [] : [...n.stack, n.page] })) }
function back() { clearDrafts(); update(navigation, n => ({ page: n.stack.at(-1) || { kind: 'home' }, stack: n.stack.slice(0, -1) })); void restorePage() }
async function restorePage(project = true) { try { if (project && selectedId()) await load(selectedId(), page().kind === 'project-settings'); if (page().kind === 'links') await loadLinks(); if (page().kind === 'connection' && page().id) await loadConnection(page().id!) } catch (e) { fail('', '读取未成功', e) } }

const OTHER = ' other' // options are stored trimmed, so a leading space cannot collide with one
const projects = atom<ProjectRef[] | null>(null)
const workspace = atom<Overview | null>(null)
const snapshot = atom<Snapshot | null>(null)
const tab = atom('inbox')
const failure = atom<{ at: string; title: string; text: string } | null>(null)
const busy = atom(false)
const notes = atom<Record<string, string>>({})
const picks = atom<Record<string, string>>({})
const editing = atom('')
const config = atom({ design: 'claude', code: 'codex', review: 'codex' })
const configOwner = atom('')
const deleting = atom('')
const deletedExport = atom('')
const mainSwitch = atom(false)
const mainTargets = atom<import('orca').PluginRequests['workspace.agent.targets']['output'] | null>(null)
const mainChoice = atom({ mode: 'existing' as 'existing' | 'new', handle: '', workspace: '', agent: 'claude', confirm: false })
let epoch = 0

function showConfig(p: Project) {
  set(configOwner, p.ref.id)
  set(config, { ...p.roles })
}
function fail(at: string, title: string, e: unknown) { set(failure, { at, title, text: e instanceof Error && e.message ? e.message : '请刷新后重试' }) }
async function load(id: string, reset = false) {
  const request = ++epoch
  try {
    const s = await plugin.request('project.read', { projectId: id })
    if (request !== epoch || selectedId() !== id) return
    set(snapshot, s)
    if (s.project && (reset || read(configOwner) !== id)) showConfig(s.project)
  } catch (e) { if (request === epoch && selectedId() === id) fail('', '读取未成功', e) }
}
async function choose(id: string) {
  if (id === '@home') id = ''
  set(tab, 'inbox')
  go({ kind: id ? 'project' : 'home', ...(id ? { projectId: id } : {}) }, true); set(snapshot, null)
  set(configOwner, '')
  if (id) await load(id, true)
}
async function list() {
  try {
    const all = await plugin.request('workspace.overview')
    set(workspace, all)
    const refs = [...all.projects.map(p => p.ref), ...(all.hidden ?? [])]
    set(projects, refs); set(failure, null)
    const id = selectedId()
    if (id && refs.some(p => p.id === id)) await load(id, !read(snapshot))
    else if (id && !all.error) { go({ kind: 'home' }, true); set(snapshot, null) }
  } catch (e) { fail('', '读取未成功', e) }
}
async function act(at: string, title: string, work: () => Promise<unknown>) {
  if (read(busy)) return
  set(busy, true); set(failure, null)
  try { await work() } catch (e) { fail(at, title, e) }
  finally { set(busy, false) }
}
const note = (key: string) => read(notes)[key] ?? ''
const write = (key: string, value: string) => update(notes, n => ({ ...n, [key]: value }))
function show(next: { kind: 'task'; id: string } | { kind: 'settings' } | null) { if (!next) { back(); return }; go({ kind: next.kind === 'settings' ? 'project-settings' : 'task', projectId: selectedId(), ...(next.kind === 'task' ? { id: next.id } : {}) }); set(editing, '') }
async function visibility(id: string, hidden: boolean) {
  const s = await plugin.request('project.read', { projectId: id })
  const answer = await plugin.request('project.visibility', { projectId: id, revision: s.project!.revision, hidden })
  if (selectedId() === id) set(snapshot, answer)
  await list()
}
function openSettings() {
  const p = read(snapshot)?.project
  if (p) { showConfig(p); show({ kind: 'settings' }) }
}
function respond(task: Task, kind: 'decision' | 'acceptance', id: string, value: string, result?: 'passed' | 'changes_requested') {
  const p = read(snapshot)?.project, key = `${task.id}/${kind}/${id}`
  if (!p) return
  return act(key, '提交未成功', async () => {
    const answer = await plugin.request('project.feedback', { projectId: p.ref.id, revision: p.revision, items: [{ taskId: task.id, kind, itemId: id,
      ...(kind === 'decision' ? { answer: value } : { result, note: value, itemRevision: task.acceptance.find(x => x.id === id)!.revision }) }] })
    if (selectedId() === p.ref.id) { set(snapshot, answer); write(key, ''); set(editing, '') }
  })
}

const tones: Record<keyof typeof labels, Tone> = { working: 'neutral', decision: 'accent', review: 'accent', rework: 'warning', completed: 'success', blocked: 'danger', paused: 'neutral' }
const resultTones: Record<string, Tone> = { passed: 'success', changes_requested: 'warning', pending: 'accent' }
const currentTab = () => read(tab)
const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max)}…` : value
// Display width in half-width units: CJK and other wide characters count as two. Orca buttons and control labels never wrap or
// break a long word, so their text has to be cut to a width that still fits a 300px panel.
const wide = (ch: string) => ch.charCodeAt(0) > 0x2e7f ? 2 : 1
const units = (value: string) => [...value].reduce((n, ch) => n + wide(ch), 0)
function fit(value: string, max: number) {
  if (units(value) <= max) return value
  let used = 2, out = ''
  for (const ch of value) { used += wide(ch); if (used > max) break; out += ch }
  return `${out}…`
}
// What an inbox card may spend on its own text, about 14 lines at 300px. Past that it shows a summary and sends the reader to
// the task record, where nothing is cut, instead of offering a choice next to text they cannot fully read.
const roomy = (...texts: string[]) => texts.reduce((n, text) => n + units(text) + 16 * (text.split('\n').length - 1), 0) <= 480
const summary = (value: string) => <Text>{fit(value.replace(/\s+/g, ' ').trim(), 160)}</Text>
function when(at: string) {
  const time = Date.parse(at)
  return Number.isNaN(time) ? at : new Date(time).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
}
function paragraphs(text: string) {
  const lines = text.split(/\n+/).filter(line => line.trim())
  // Orca refuses a text node past 16 KiB and a render past 5000 nodes, so very long input falls back to plain chunks.
  const blocks = lines.length <= 200 && lines.every(line => line.length <= 4000) ? lines : text.match(/[^]{1,4000}/g) ?? []
  return <Stack gap="xs">{blocks.map((block, i) => <Text key={`${i}`}>{block}</Text>)}</Stack>
}
function problem(at: string) {
  const f = read(failure)
  return f?.at === at ? <Callout tone="danger" title={f.title}>{paragraphs(f.text)}</Callout> : null
}
function pending(p: Project) {
  return {
    decisions: p.tasks.filter(t => t.phase !== 'paused').flatMap(t => t.decisions.filter(d => d.answer === undefined).map(d => [t, d] as const)),
    checks: p.tasks.filter(t => t.phase === 'ready').flatMap(t => t.acceptance.filter(a => a.status === 'pending').map(a => [t, a] as const))
  }
}

const open = (task: Task) => show({ kind: 'task', id: task.id })
// A card that offers the action shows every text in full; a brief one cuts them and only leads to the task record.
const heading = (task: Task, brief: boolean) => <Row justify="between" gap="sm" align="start">
  <Text weight="semibold">{brief ? fit(task.title, 60) : task.title}</Text>
  {brief ? null : <Box shrink={false}><Text><Link onPress={() => open(task)}>详情</Link></Text></Box>}
</Row>
function artifacts(p: Project, task: Task, ids: string[], at: string) {
  const items = task.artifacts.filter(a => ids.includes(a.id))
  return items.length ? <Row gap="xs" wrap>{items.map(a => <Button key={a.id} icon="open-external" tooltip={clip(`${a.label} · ${a.version} · ${a.url}`, 300)} disabled={read(busy)} onPress={() => act(at, '打开未成功', async () => {
    if (/^https?:/i.test(a.url)) await shell.openExternal(a.url)
    else await plugin.request('project.openArtifact', { projectId: p.ref.id, taskId: task.id, artifactId: a.id })
  })}>{`${fit(a.label, 16)} · ${fit(a.version, 6)}`}</Button>)}</Row> : null
}
function decision(task: Task, d: Decision, inbox = false) {
  const key = `${task.id}/decision/${d.id}`, pick = read(picks)[key] ?? '', free = !d.options.length || pick === OTHER
  const answer = (free ? note(key) : pick).trim(), brief = inbox && !roomy(task.title, d.question, ...d.options)
  // A radio label cannot break a long word and reads badly past a few lines, so long options are shown as text and picked by number.
  const numbered = d.options.some(o => units(o) > 80 || /[!-~]{25,}/.test(o))
  return <Box key={key} border radius="lg" padding="md" gap="sm" background="card">
    {inbox ? heading(task, brief) : null}
    {brief ? summary(d.question) : paragraphs(d.question)}
    {d.answer !== undefined ? <Stack gap="xs">
      <Row gap="sm"><Badge tone="success">已决定</Badge>{d.history[0] ? <Text muted size="xs">{when(d.history[0].at)}</Text> : null}</Row>
      {paragraphs(d.answer)}
    </Stack> : brief ? <Button variant="solid" tone="accent" onPress={() => open(task)}>查看并决定</Button> : <Stack gap="sm">
      {numbered ? d.options.map((o, i) => <Field key={`${i}`} label={`选项 ${i + 1}`}>{paragraphs(o)}</Field>) : null}
      {d.options.length ? <RadioGroup label="选项" labelHidden value={pick} options={[...d.options.map((o, i) => ({ value: o, label: numbered ? `选项 ${i + 1}` : o })), { value: OTHER, label: '其他' }]}
        onChange={v => update(picks, x => ({ ...x, [key]: v }))} /> : null}
      {free ? <Textarea label="你的决定" labelHidden={!!d.options.length} value={note(key)} rows={3} maxLength={8000} onChange={v => write(key, v)} /> : null}
      {problem(key)}
      <Button variant="solid" tone="accent" disabled={read(busy) || !answer} onPress={() => respond(task, 'decision', d.id, answer)}>提交决定</Button>
    </Stack>}
  </Box>
}
function check(p: Project, task: Task, a: Acceptance, inbox = false) {
  const key = `${task.id}/acceptance/${a.id}`, due = task.phase === 'ready' && a.status === 'pending', last = a.history.at(-1)
  const feedback = due && last?.result === 'changes_requested' ? last.note : '', brief = inbox && !roomy(task.title, a.title, a.details, feedback), title = brief ? fit(a.title, 60) : a.title
  return <Box key={key} border radius="lg" padding="md" gap="sm" background="card">
    {inbox ? heading(task, brief) : null}
    <Row justify="between" gap="sm" align="start">
      <Text weight="medium">{a.revision > 1 ? `${title} · 第 ${a.revision} 版` : title}</Text>
      {inbox || a.status === 'pending' && !due ? null : <Badge tone={resultTones[a.status]}>{results[a.status]}</Badge>}
    </Row>
    {brief ? summary(a.details) : paragraphs(a.details)}
    {artifacts(p, task, a.artifactIds, key)}
    {feedback && !brief ? <Callout title="上次修改意见">{paragraphs(feedback)}</Callout> : null}
    {!due ? null : brief ? <Button variant="solid" tone="accent" onPress={() => open(task)}>查看并验收</Button> : read(editing) === key ? <Stack gap="sm">
      <Textarea label="修改意见" value={note(key)} rows={3} maxLength={8000} onChange={v => write(key, v)} />
      <Row gap="sm">
        <Button variant="solid" tone="accent" disabled={read(busy) || !note(key).trim()} onPress={() => respond(task, 'acceptance', a.id, note(key), 'changes_requested')}>退回修改</Button>
        <Button variant="ghost" onPress={() => set(editing, '')}>取消</Button>
      </Row>
    </Stack> : <Row gap="sm">
      <Button variant="solid" tone="accent" disabled={read(busy)} onPress={() => respond(task, 'acceptance', a.id, '', 'passed')}>通过验收</Button>
      <Button disabled={read(busy)} onPress={() => set(editing, key)}>需要修改</Button>
    </Row>}
    {problem(key)}
    {!inbox && a.history.length ? <Collapsible title="验收记录">{a.history.map((entry, i) => <Stack key={`${i}`} gap="xs">
      <Text muted size="xs">{`${when(entry.at)} · 第 ${entry.revision} 版 · ${results[entry.result] ?? entry.result}`}</Text>
      {entry.note ? paragraphs(entry.note) : null}
    </Stack>)}</Collapsible> : null}
  </Box>
}

function inbox(p: Project) {
  const { decisions, checks } = pending(p)
  const blocked = p.tasks.filter(t => t.phase === 'blocked')
  if (!decisions.length && !checks.length && !blocked.length) return <EmptyState icon="check" title="没有待决定或待验收的事项" />
  return <Stack gap="lg">
    {decisions.length ? <Stack gap="sm"><Heading level={2}>待决定</Heading>{decisions.map(([t, d]) => decision(t, d, true))}</Stack> : null}
    {blocked.length ? <Stack gap="sm"><Heading level={2}>卡住了</Heading>{blocked.map(t => <Callout key={t.id} tone="danger" title={t.title}>{paragraphs(t.progress || '需要你帮一把')}<Button onPress={() => open(t)}>查看任务</Button></Callout>)}</Stack> : null}
    {checks.length ? <Stack gap="sm"><Heading level={2}>待验收</Heading>{checks.map(([t, a]) => check(p, t, a, true))}</Stack> : null}
  </Stack>
}
function tasks(p: Project) {
  return <Stack gap="sm">
    {p.tasks.length ? <List label="任务记录">{[...p.tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(t => {
      const state = taskState(t)
      return <ListItem key={t.id} onPress={() => open(t)}>
        <Row justify="between" gap="sm"><Stack gap="xs"><Text truncate>{t.title}</Text><Text muted size="xs"><RelativeTime at={Date.parse(t.updatedAt)} /></Text></Stack><Badge tone={tones[state]}>{labels[state]}</Badge></Row>
      </ListItem>
    })}</List> : <EmptyState icon="book" title="还没有任务记录" />}

  </Stack>
}
function messages(p: Project) {
  const waiting = p.deliveries.filter(d => d.state !== 'sent')
  if (!p.events.length && !waiting.length) return <EmptyState icon="bell" title="还没有消息" />
  return <Stack gap="lg">
    {waiting.length ? <Stack gap="sm"><Heading level={2}>未送达通知</Heading>{waiting.map(d => <Box key={d.id} border radius="lg" padding="md" gap="sm" background="card">
      <Row justify="between" gap="sm" align="start"><Text weight="medium">{d.subject}</Text><Badge tone={d.state === 'pending' || d.state === 'sending' ? 'neutral' : 'warning'}>{deliveryStates[d.state]}</Badge></Row>
      {d.external ? <Text muted>发往飞书</Text> : d.targetRunId ? <Text muted>发往工作间主 agent</Text> : null}
      {summary(d.error ?? d.body)}
      {d.state === 'pending' && (d.external || p.runId) ? <Button disabled={read(busy)} onPress={() => act(d.id, '通知未成功', async () => {
        const answer = await plugin.request('project.deliver', { projectId: p.ref.id, deliveryId: d.id })
        if (selectedId() === p.ref.id) set(snapshot, answer)
      })}>{d.external ? '发送飞书提醒' : '通知主会话'}</Button> : null}
      {problem(d.id)}
    </Box>)}</Stack> : null}
    {p.events.length ? <Stack gap="sm">
      {waiting.length ? <Heading level={2}>来源消息</Heading> : null}
      {[...p.events].reverse().map(e => {
        const linked = p.tasks.find(t => t.id === e.taskId)
        return <Collapsible key={e.id} title={clip(e.text.trim().split('\n')[0], 60)} description={linked ? `关联任务：${clip(linked.title, 40)}` : '未关联任务'}>
          {paragraphs(e.text)}
          <Text muted size="xs">{`${sourceName(e.source)} · ${when(e.receivedAt)}`}</Text>
          {linked ? <Button variant="ghost" onPress={() => open(linked)}>查看任务</Button> : null}
        </Collapsible>
      })}
    </Stack> : null}
  </Stack>
}
function home(p: Project) {
  const { decisions, checks } = pending(p), count = decisions.length + checks.length + p.tasks.filter(t => t.phase === 'blocked').length
  // Binding is not liveness: the latest settled notification is the only evidence that the bound session still receives feedback.
  const latest = [...p.deliveries].reverse().find(d => !d.targetRunId && d.state !== 'pending' && d.state !== 'sending')
  return <Stack gap="md">
    <Stack gap="sm">
      {p.runId ? null : <Callout tone="warning" title="主会话未绑定">在本项目会话中说“开启项目协作”即可绑定。</Callout>}
      {p.runId && latest && latest.state !== 'sent' && currentTab() !== 'messages' ? <Callout tone="warning" title="主会话可能未收到最近的通知">
        {paragraphs(latest.error ?? '请在主会话核对。')}
        <Button onPress={() => set(tab, 'messages')}>查看消息</Button>
      </Callout> : null}
    </Stack>
    <Tabs label="视图" value={currentTab()} onChange={v => { set(tab, v); set(failure, null); set(editing, '') }}>
      <Tab value="inbox" label={count ? `待处理 ${count}` : '待处理'}>{inbox(p)}</Tab>
      <Tab value="tasks" label={`任务 ${p.tasks.length}`}>{tasks(p)}</Tab>
      <Tab value="messages" label="消息">{messages(p)}</Tab>
    </Tabs>
  </Stack>
}
function taskPage(p: Project, task: Task) {
  const state = taskState(task), sources = p.events.filter(e => task.sourceIds.includes(e.id))
  // Acceptance cards already show the artifacts they check; list only the rest (earlier versions, unreviewed results) here.
  const shown = task.acceptance.flatMap(a => a.artifactIds), rest = task.artifacts.filter(a => !shown.includes(a.id)).map(a => a.id)
  return <Stack gap="md">

    <Stack gap="xs">
      <Heading>{task.title}</Heading>
      <Row gap="sm"><Badge tone={tones[state]}>{labels[state]}</Badge><Text muted size="xs">{`${when(task.updatedAt)}${task.executions.length ? ` · ${agentName(task.executions.at(-1)!.agent)} 在做` : ''}`}</Text></Row>
    </Stack>
    <Field label="目标">{paragraphs(task.goal)}</Field>
    {task.progress ? task.phase === 'blocked' ? <Callout tone="danger" title="卡住了">{paragraphs(task.progress)}</Callout> : <Field label="进展">{paragraphs(task.progress)}</Field> : null}
    {task.decisions.length ? <Stack gap="sm"><Heading level={2}>决定</Heading>{task.decisions.map(d => decision(task, d))}</Stack> : null}
    {task.acceptance.length ? <Stack gap="sm"><Heading level={2}>验收</Heading>{task.acceptance.map(a => check(p, task, a))}</Stack> : null}
    {rest.length ? <Stack gap="sm"><Heading level={2}>{shown.length ? '其他成果' : '成果'}</Heading>{artifacts(p, task, rest, task.id)}{problem(task.id)}</Stack> : null}
    {sources.length ? <Collapsible title="来源消息">{sources.map(e => <Stack key={e.id} gap="xs">
      <Text muted size="xs">{`${sourceName(e.source)} · ${when(e.receivedAt)}`}</Text>
      {paragraphs(e.text)}
    </Stack>)}</Collapsible> : null}

  </Stack>
}
function settingsPage(s: Snapshot, p: Project) {
  const c = read(config)
  const choices = Object.entries(agents).filter(([key]) => key !== 'opencode').map(([value, label]) => ({ value, label }))
  const edit = (key: keyof typeof c, value: string | boolean) => update(config, c => ({ ...c, [key]: value }))
  return <Stack gap="lg">
    <Heading>项目设置</Heading>
    <Stack gap="sm"><Heading level={2}>代理分工</Heading>
      {Object.entries(roles).map(([key, label]) => <Row key={key} justify="between" gap="sm">
        <Text weight="medium">{label}</Text>
        <Box width={128} shrink={false}><Select label={label} labelHidden value={c[key as keyof typeof c]} options={choices} onChange={v => edit(key as keyof typeof c, v)} /></Box>
      </Row>)}
    </Stack>
    <Stack gap="sm">
      {problem('settings')}
      <Button variant="solid" tone="accent" disabled={read(busy)} onPress={() => act('settings', '保存未成功', async () => {
        const answer = await plugin.request('project.settings', { projectId: p.ref.id, revision: p.revision,
          roles: { design: c.design, code: c.code, review: c.review } as Project['roles'] })
        if (selectedId() === p.ref.id) { set(snapshot, answer); showConfig(answer.project!); set(tab, 'inbox'); show(null) }
      })}>{read(busy) ? '正在保存…' : '保存设置'}</Button>
    </Stack>
    <Stack gap="sm"><Heading level={2}>项目记录</Heading>
      <Text muted>{`${machineName(p.ref.hostId)} · ${p.ref.path}`}</Text>
      <Button disabled={read(busy)} onPress={() => act('project-record', '导出未成功', () => files.saveAs({ suggestedName: `${p.ref.name}-协作记录.json`, mimeType: 'application/json', data: JSON.stringify(p, null, 2) }))}>导出记录</Button>
      <Button disabled={read(busy)} onPress={() => act('project-record', '显示状态未保存', async () => { await visibility(p.ref.id, !p.hidden); if (!p.hidden) go({ kind: 'home' }, true) })}>{p.hidden ? '恢复显示' : '隐藏项目'}</Button>
      <Text muted>隐藏后不再显示、提醒和对外上报，记录保留，可在设置里恢复。</Text>
      {read(deleting) === p.ref.id ? <Callout tone="warning" title="从工作间删除？"><Text>{p.ref.name}</Text>
        <Text>会删除任务、成果、决定、验收、来源消息、通知、项目设置和主会话绑定，并从 Orca 项目列表移除。磁盘文件和 Git 仓库不动。会先导出记录，删除后不能恢复。</Text>
        {p.tasks.some(t => taskState(t) !== 'completed') ? <Text tone="danger">{`还有 ${p.tasks.filter(t => taskState(t) !== 'completed').length} 个任务没做完`}</Text> : null}
        <Checkbox label="我确认删除，知道不能恢复" checked={read(deleteConfirmed)} onChange={v => set(deleteConfirmed, v)} />
        <Row gap="sm" wrap><Button tone="danger" disabled={read(busy) || !read(deleteConfirmed) || !!s.runtimeError} onPress={() => act('project-record', '删除未成功', async () => {
          const answer = await plugin.request('project.delete', { projectId: p.ref.id, revision: p.revision, confirm: p.ref.id })
          set(deletedExport, `已删除${p.ref.name}。磁盘上的文件没有动。记录已导出到：${answer.exportPath}`); set(snapshot, null); go({ kind: 'home' }, true); await list()
        })}>确认删除</Button><Button onPress={() => { set(deleting, ''); set(deleteConfirmed, false) }}>取消</Button></Row>
      </Callout> : <Button tone="danger" disabled={read(busy) || !!s.runtimeError} onPress={() => { set(deleting, p.ref.id); set(deleteConfirmed, false) }}>从工作间删除</Button>}
      {problem('project-record')}
    </Stack>
  </Stack>
}

async function openOverviewTask(projectId: string, taskId: string) {
  go({ kind: 'task', projectId, id: taskId }); set(snapshot, null)
  await load(projectId, true)
}
function machineName(id: string) { const m = read(workspace)?.machines?.find(m => m.id === id); return m ? `${m.role === 'host' ? '主机' : '电脑'} · ${m.name}` : `电脑 · ${id}` }
function workspacePage(all: Overview) {
  const groups = groupedAttention(all.attention), external = pendingRequests(all.links)
  const items = [...groups.filter(i => i.kind !== 'review'), ...external.map(r => ({ projectId: '@external', taskId: r.id, kind: 'external' as const, title: r.title, count: 1, peerId: r.peerId })), ...groups.filter(i => i.kind === 'review')]
  const scoped = items.filter(i => !read(filter) || i.projectId === read(filter)), sources = [...new Set(items.map(i => i.projectId))]
  const count = (id: string) => groups.filter(i => i.projectId === id).length
  function projectRow(p: Overview['projects'][number]) {
    const active = p.counts.working + p.counts.rework + p.counts.decision + p.counts.blocked
    return <ListItem key={p.ref.id} onPress={() => choose(p.ref.id)}><Stack gap="xs"><Text weight="medium">{fit(p.ref.name, 44)}</Text><Text muted>{active ? `${active} 个任务在做` : p.counts.review ? '等你验收' : '都做完了'}{p.updatedAt ? ' · ' : ''}{p.updatedAt ? <RelativeTime at={Date.parse(p.updatedAt)} /> : null}</Text></Stack>{count(p.ref.id) ? <Badge tone="accent">{`${count(p.ref.id)} 件待处理`}</Badge> : null}</ListItem>
  }
  const online = all.workspace.session?.online ?? 'offline', status = mainAgentStates[online]
  return <Stack gap="lg"><Row justify="between"><Heading>工作间</Heading><Badge tone={status.tone}>{`主 agent ${status.label}`}</Badge></Row>
    {!all.workspace.runId || online === 'offline' || all.workspace.takeover ? <Callout tone="warning" title={!all.workspace.runId ? '主 agent 未绑定' : all.workspace.takeover ? '等待主 agent 接管' : '主 agent 不在线'}><Button onPress={() => go({ kind: 'main' })}>查看主 agent</Button></Callout> : null}
    {all.connections?.filter(c => c.enabled && c.state === 'error').map(c => <Callout key={c.id} tone="warning" title={`外部连接「${c.name}」连不上`}><Button onPress={() => openConnection(c.id)}>查看连接</Button></Callout>)}
    {all.links?.error ? <Callout tone="danger" title="工作间连接异常"><Text>{all.links.error}</Text><Button onPress={() => openLinks('settings')}>连接设置</Button></Callout> : null}
    {all.error ? <Callout tone="danger" title="项目列表读取失败"><Text>{all.error}</Text><Button onPress={list}>重试</Button></Callout> : null}
    <Stack gap="sm"><Heading level={2}>{`等你处理 ${items.length}`}</Heading>
      {sources.length > 1 ? <Select label="按项目筛选" value={read(filter) || '@all'} options={[{ value: '@all', label: `全部项目 (${items.length})` }, ...sources.map(id => ({ value: id, label: `${id === '@external' ? '其他工作间' : fit(all.projects.find(p => p.ref.id === id)?.ref.name || '', 30)} (${items.filter(i => i.projectId === id).length})` }))]} onChange={v => { set(filter, v === '@all' ? '' : v); set(expanded, false) }} /> : null}
      {scoped.length ? <List label="等你处理">{scoped.slice(0, read(expanded) ? undefined : 5).map(i => <ListItem key={`${i.projectId}/${i.taskId}/${i.kind}`} onPress={() => i.kind === 'external' ? go({ kind: 'request', id: `${i.peerId}:${i.taskId}` }) : openOverviewTask(i.projectId, i.taskId)}><Stack gap="xs"><Row gap="xs"><Badge>{i.kind === 'external' ? '外部请求' : i.kind === 'blocked' ? '卡住了' : labels[i.kind]}</Badge><Text truncate>{fit(i.title, 40)}</Text></Row><Text muted>{`${i.kind === 'external' ? '其他工作间' : fit(all.projects.find(p => p.ref.id === i.projectId)?.ref.name || '', 30)} · ${i.kind === 'decision' ? '等你拿主意' : i.kind === 'blocked' ? '需要你帮一把' : i.kind === 'external' ? '要不要接这个活' : `${i.count} 项成果等你验收`}`}</Text></Stack></ListItem>)}</List> : <EmptyState title="没有要你处理的事" />}
      {!read(expanded) && scoped.length > 5 ? <Button variant="ghost" onPress={() => set(expanded, true)}>{`再看 ${scoped.length - 5} 条`}</Button> : null}
    </Stack><Stack gap="sm"><Heading level={2}>项目</Heading>
      {[...new Set(all.projects.map(p => p.ref.hostId))].map(id => { const group = all.projects.filter(p => p.ref.hostId === id).sort((a, b) => count(b.ref.id) - count(a.ref.id)), active = group.filter(p => Object.values(p.counts).some(Boolean)), empty = group.filter(p => !Object.values(p.counts).some(Boolean)); return <Stack key={id} gap="sm"><Text muted>{machineName(id)}</Text>{active.length ? <List label="项目列表">{active.map(projectRow)}</List> : null}{empty.length ? <Collapsible title={`还没有任务的项目 ${empty.length} 个`}><List label="还没有任务的项目">{empty.map(projectRow)}</List></Collapsible> : null}</Stack> })}
    </Stack>{all.links?.peers.some(p => p.state === 'active') ? <List><ListItem onPress={() => openLinks('activity')}><Text>其他工作间</Text><Text muted>{all.links.peers.filter(p => p.state === 'active').map(p => `${p.name} · ${p.status === 'connected' ? '在线' : '离线'}`).join(' · ')}</Text></ListItem></List> : null}
  </Stack>
}
async function openConnection(id: string) { return act('', '读取连接未成功', async () => { go({ kind: 'connection', id }); await loadConnection(id) }) }
async function openLinks(tab: string) { return act('', '读取工作间未成功', async () => { go({ kind: 'links' }); await loadLinks(); set(linksTab, tab) }) }
function workspaceSettings(all: Overview) {
  return <Stack gap="lg"><Heading>设置</Heading><List label="工作间设置">
    <ListItem onPress={() => go({ kind: 'main' })}><Text>主 agent</Text><Text muted>{`${agentName(all.workspace.session?.agent)} · ${mainAgentStates[all.workspace.session?.online ?? 'offline'].label}`}</Text></ListItem>
    <ListItem onPress={() => go({ kind: 'connections' })}><Text>外部连接</Text><Text muted>{all.connections?.map(c => `${c.name} ${connectionStates[c.state]}`).join(' · ') || '还没有'}</Text>{all.connections?.some(c => c.state === 'error') ? <Badge tone="warning">要处理</Badge> : null}</ListItem>
    <ListItem onPress={() => openLinks('activity')}><Text>其他工作间</Text><Text muted>{`已连接 ${all.links?.peers.filter(p => p.state === 'active').length || 0} 个`}</Text></ListItem>
    <ListItem onPress={() => go({ kind: 'machines' })}><Text>机器</Text><Text muted>{all.machines?.map(m => m.name).join(' · ') || '主机'}</Text></ListItem>
    <ListItem onPress={() => act('', '打开画布未成功', () => plugin.request('workspace.canvas'))}><Text>组织画布</Text><Text muted>查看和调整分工</Text></ListItem>
  </List>{all.hidden?.length ? <Collapsible title={`隐藏的项目 ${all.hidden.length} 个`}>{all.hidden.map(ref => <Stack key={ref.id}><Button onPress={() => choose(ref.id)}>{fit(ref.name, 40)}</Button><Button onPress={() => act('', '恢复未成功', () => visibility(ref.id, false))}>恢复显示</Button></Stack>)}</Collapsible> : null}</Stack>
}
function mainPage(all: Overview) {
  const w = all.workspace, rows = bindingRows(w), online = w.session?.online ?? 'offline', status = mainAgentStates[online]
  return <Stack gap="md"><Row justify="between"><Heading>主 agent</Heading><Badge tone={status.tone}>{status.label}</Badge></Row><Text>统筹工作间，转达项目消息与用户反馈。</Text>
    {!w.runId || online === 'offline' ? <Callout tone="warning" title={w.runId ? '主 agent 不在线' : '主 agent 未绑定'}>选择一个在线会话，或新开主 agent。</Callout> : null}
    {takeoverText(w) ? <Callout tone="warning" title="主 agent 接管">{takeoverText(w)}</Callout> : null}
    {w.previousNotice && w.previousNotice !== 'sent' ? <Callout tone="warning" title="原主 agent 通知待核对" /> : null}
    <KeyValue items={rows.filter(r => ['会话', 'Agent', '目录', '同时担任项目主 agent'].includes(r.label))} />
    <Button onPress={openMainSwitch}>换一个主 agent</Button>{read(mainSwitch) ? mainSwitchPage(all) : null}
    <Collapsible title="技术信息"><KeyValue items={rows.filter(r => ['Run', '会话编号', '绑定时间', '身份资料', '授权边界'].includes(r.label))} /></Collapsible>{problem('main-agent')}
  </Stack>
}
function openMainSwitch() {
  return act('main-agent', '读取可接管会话未成功', async () => {
    set(mainTargets, await plugin.request('workspace.agent.targets'))
    set(mainChoice, { mode: 'existing', handle: '', workspace: '', agent: 'claude', confirm: false })
    set(mainSwitch, true)
  })
}
function mainSwitchPage(all: Overview) {
  const t = read(mainTargets), c = read(mainChoice), w = all.workspace
  const edit = (value: Partial<typeof c>) => set(mainChoice, { ...c, ...value, confirm: false })
  const target = c.mode === 'existing' ? t?.sessions.find(s => s.handle === c.handle) : t?.workspaces.find(w => w.workspace === c.workspace)
  const waiting = !!w.takeover && Date.parse(w.takeover.expiresAt) > Date.now()
  return <Stack gap="md">


    <Text>已发给原主 agent 的通知不会补发。接管后会先读总览，补齐之前的事项。</Text>
    {takeoverText(w) ? <Callout tone="warning" title="主 agent 接管">{takeoverText(w)}</Callout> : null}
    <RadioGroup label="切换方式" value={c.mode} options={[{ value: 'existing', label: '已开的会话' }, { value: 'new', label: '新开主 agent' }]} onChange={v => edit({ mode: v as typeof c.mode })} />
    {c.mode === 'existing' ? <Select label="接管会话" value={c.handle} placeholder="选择在线的 agent 会话" options={(t?.sessions ?? []).filter(s => s.handle !== w.session?.handle).map(s => ({ value: s.handle, label: `${s.title || s.handle} · ${s.workspaceName} · ${agentName(s.agent)} · ${s.path}` }))} onChange={v => edit({ handle: v })} />
      : <Stack gap="sm"><Select label="主 agent 工作区" value={c.workspace} placeholder="选择工作区" options={(t?.workspaces ?? []).map(w => ({ value: w.workspace, label: `${w.name} · ${w.path}` }))} onChange={v => edit({ workspace: v })} />
        <Select label="主 agent 类型" value={c.agent} options={[{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }, { value: 'opencode', label: 'OpenCode' }]} onChange={v => edit({ agent: v })} />
        <Text>默认 Claude，可关闭主机本地工具；Codex 的本地工具约束见需求文档。</Text></Stack>}
    {c.confirm && target ? <Callout tone="warning" title="确认请求接管？"><Text>{c.mode === 'existing' ? `${'title' in target ? target.title : ''} · ${c.handle}` : `新开 ${agentName(c.agent)}`}</Text><Text>{target.path}</Text><Text>当前绑定保留到目标会话自行完成接管。</Text></Callout> : null}
    {problem('main-agent')}
    <Row gap="sm" wrap><Button disabled={read(busy) || waiting || !target} variant="solid" onPress={() => {
      if (!c.confirm) { set(mainChoice, { ...c, confirm: true }); return }
      return act('main-agent', '请求接管未成功', async () => {
        const binding = await plugin.request('workspace.agent.switch', { revision: w.revision, mode: c.mode, ...(c.mode === 'existing' ? { handle: c.handle } : { workspace: c.workspace, agent: c.agent }) })
        set(workspace, { ...all, workspace: binding }); set(mainChoice, { ...c, confirm: false })
      })
    }}>{read(busy) ? '正在请求…' : c.confirm ? '确认请求接管' : '请求接管'}</Button>
      <Button disabled={read(busy)} onPress={openMainSwitch}>刷新会话</Button></Row>
  </Stack>
}
export function setup(ctx: PanelContext): void {
  async function navigate() {
    const next = await storage.get('workspace.navigation') as { switching?: boolean } | null
    if (!next) return
    await storage.delete('workspace.navigation')
    go({ kind: next.switching ? 'main' : 'home' }, true); void list()
    if (next.switching) void openMainSwitch()
  }
  ctx.subscriptions.push(plugin.on('workspace.open', () => { void navigate() }))
  void navigate()
  ctx.subscriptions.push(plugin.on('project.changed', e => {
    void plugin.request('workspace.overview').then(all => set(workspace, all)).catch(e => fail('', '读取总览未成功', e))
    const id = selectedId(); if (id && (!e.projectId || e.projectId === id)) void load(id)
  }))
  void list().then(() => restorePage(false))
}
export default function Panel() {
  const refs = read(projects), all = read(workspace), s = read(snapshot), p = s?.project, v = page(), f = read(failure)
  const names: Record<Page['kind'], string> = { home: '工作间首页', project: p?.ref.name || '项目', task: '任务', 'project-settings': '项目设置', settings: '设置', main: '主 agent', connections: '外部连接', connection: '连接', 'add-connection': '添加连接', 'new-connection': '连接信息', machines: '机器', links: '其他工作间', request: '外部请求' }
  const previous = read(navigation).stack.at(-1), task = p?.tasks.find(t => t.id === v.id)
  let content
  if (selectedId()) content = s && p ? v.kind === 'project-settings' ? settingsPage(s, p) : v.kind === 'task' && task ? taskPage(p, task) : <Stack gap="md"><Row justify="between"><Heading>{p.ref.name}</Heading><IconButton icon="settings" label="项目设置" onPress={openSettings} /></Row><Text muted>{machineName(p.ref.hostId)}</Text>{home(p)}</Stack> : <Skeleton lines={3} label="正在读取项目" />
  else if (!all) content = <Skeleton lines={3} label="正在读取工作间" />
  else switch (v.kind) {
    case 'settings': content = workspaceSettings(all); break
    case 'main': content = mainPage(all); break
    case 'connections': content = connectionsList(all.connections || [], openConnection, () => go({ kind: 'add-connection' })); break
    case 'add-connection': content = addConnection(all.connections || [], () => go({ kind: 'new-connection' })); break
    case 'new-connection': case 'connection': content = connectionPage(id => { if (v.kind === 'new-connection' && page().kind === 'new-connection') update(navigation, n => ({ stack: n.stack.filter(p => p.kind !== 'add-connection'), page: { kind: 'connection' as const, id } })); void list() }, () => { go({ kind: 'connections' }, true); void list() }, v.kind === 'connection' ? v.id : undefined); break
    case 'machines': content = <Stack gap="md"><Heading>机器</Heading>{all.machines?.map(m => <Stack key={m.id}><Text>{machineName(m.id)}</Text><Text muted>{`${m.online === false ? '离线' : '在线'} · ${all.projects.filter(p => p.ref.hostId === m.id).length} 个项目`}</Text></Stack>)}<EmptyState title="还没有接入其他电脑" /></Stack>; break
    case 'links': content = <Stack gap="md"><Heading>其他工作间</Heading><Tabs label="其他工作间" value={read(linksTab)} onChange={v => set(linksTab, v)}><Tab value="activity" label="动态">{linksSection(all.links, id => go({ kind: 'request', id }))}</Tab><Tab value="settings" label="连接设置">{linksPage(all.projects.map(p => p.ref))}</Tab></Tabs></Stack>; break
    case 'request': content = requestPage(all.links, v.id || '', links => set(workspace, { ...all, links })); break
    default: content = workspacePage(all)
  }
  return <Stack gap="md"><Box direction="row" gap="xs" align="center"><Box grow><Select label="项目" labelHidden value={selectedId() || '@home'} options={[{ value: '@home', label: '工作间首页' }, ...(refs || []).map(x => ({ value: x.id, label: fit(`${x.name}${refs!.filter(r => r.name === x.name).length > 1 ? ` · ${x.path.split(/[\\/]/).filter(Boolean).at(-1)}` : ''}`, 36) }))]} onChange={choose} /></Box><IconButton icon="refresh" label="刷新" onPress={() => list().then(() => restorePage(false))} /><IconButton icon="settings" label="设置" onPress={() => go({ kind: 'settings' })} /></Box>
    {v.kind !== 'home' ? <Button variant="ghost" onPress={back}>{`‹ ${fit(previous ? names[previous.kind] : '工作间首页', 32)}`}</Button> : null}
    {read(deletedExport) ? <Callout tone="success" title="项目已删除"><Text>{read(deletedExport)}</Text><Button onPress={() => set(deletedExport, '')}>关闭</Button></Callout> : null}
    {f?.at === '' ? <Callout tone="danger" title={f.title}><Text>{f.text}</Text><Button onPress={list}>重试</Button></Callout> : null}{content}
  </Stack>
}
