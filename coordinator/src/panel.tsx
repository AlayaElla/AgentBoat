import { atom, read, set, update, plugin, shell, files, Stack, Row, Box, Heading, Text, Button, IconButton, Badge, List, ListItem, Link,
  Select, Input, Textarea, Switch, RadioGroup, Field, Tabs, Tab, Collapsible, EmptyState, Callout, Skeleton, KeyValue, type PanelContext, type Tone } from 'orca'
import { taskState, type Acceptance, type Decision, type Project, type ProjectRef, type Snapshot, type Task } from './model'

type View = { kind: 'task'; id: string } | { kind: 'settings' } | null
const OTHER = ' other' // options are stored trimmed, so a leading space cannot collide with one
const projects = atom<ProjectRef[] | null>(null)
const selected = atom('project.selection', '', { persist: 'plugin' })
const snapshot = atom<Snapshot | null>(null)
const tab = atom('project.tab', 'inbox', { persist: 'plugin' })
const view = atom<View>('project.view', null, { persist: 'plugin' })
const failure = atom<{ at: string; title: string; text: string } | null>(null)
const busy = atom(false)
const notes = atom<Record<string, string>>({})
const picks = atom<Record<string, string>>({})
const editing = atom('')
const config = atom({ design: 'claude', code: 'codex', review: 'codex', appId: '', appSecret: '', chatIds: '', senderIds: '', enabled: false })
const configOwner = atom('')
let epoch = 0

function showConfig(p: Project) {
  set(configOwner, p.ref.id)
  set(config, { ...p.roles, appId: p.feishu.appId, appSecret: '', chatIds: p.feishu.chatIds.join('\n'), senderIds: p.feishu.senderIds.join('\n'), enabled: p.feishu.enabled })
}
function fail(at: string, title: string, e: unknown) { set(failure, { at, title, text: e instanceof Error && e.message ? e.message : '请刷新后重试' }) }
async function load(id: string, reset = false) {
  const request = ++epoch
  try {
    const s = await plugin.request('project.read', { projectId: id })
    if (request !== epoch || read(selected) !== id) return
    set(snapshot, s)
    if (s.project && (reset || read(configOwner) !== id)) showConfig(s.project)
  } catch (e) { if (request === epoch) fail('', '读取未成功', e) }
}
async function choose(id: string) {
  set(selected, id); set(snapshot, null); set(notes, {}); set(picks, {}); set(failure, null); set(view, null); set(editing, '')
  set(configOwner, ''); update(config, c => ({ ...c, appSecret: '' }))
  if (id) await load(id, true)
}
async function list() {
  try {
    const answer = await plugin.request('projects.list')
    set(projects, answer.projects); set(failure, answer.error ? { at: '', title: '读取未成功', text: answer.error } : null)
    const id = read(selected)
    if (id && answer.projects.some(p => p.id === id)) await load(id, !read(snapshot))
    else if (id && !answer.error) { set(selected, ''); set(snapshot, null); set(view, null) }
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
function show(next: View) { set(view, next); set(failure, null); set(editing, '') }
function openSettings() {
  const p = read(snapshot)?.project
  if (p) { showConfig(p); show({ kind: 'settings' }) }
}
function respond(task: Task, kind: 'decision' | 'acceptance', id: string, value: string, result?: 'passed' | 'changes_requested') {
  const p = read(snapshot)?.project, key = `${task.id}/${kind}/${id}`
  if (!p) return
  return act(key, '提交未成功', async () => {
    const answer = await plugin.request('project.feedback', { projectId: p.ref.id, revision: p.revision, taskId: task.id, kind, itemId: id,
      ...(kind === 'decision' ? { answer: value } : { result, note: value, itemRevision: task.acceptance.find(x => x.id === id)!.revision }) })
    if (read(selected) === p.ref.id) { set(snapshot, answer); write(key, ''); set(editing, '') }
  })
}

const labels = { working: '进行中', decision: '待决定', review: '待验收', rework: '修改中', completed: '已完成', blocked: '受阻', paused: '已暂停' }
const tones: Record<keyof typeof labels, Tone> = { working: 'neutral', decision: 'accent', review: 'accent', rework: 'warning', completed: 'success', blocked: 'danger', paused: 'neutral' }
const results: Record<string, string> = { passed: '已通过', changes_requested: '已退回修改', pending: '待验收' }
const resultTones: Record<string, Tone> = { passed: 'success', changes_requested: 'warning', pending: 'accent' }
const tabs: Record<string, string> = { inbox: '待处理', tasks: '任务记录', messages: '消息' }
// Earlier versions stored other values under project.tab; anything that is not a current tab opens the inbox.
const currentTab = () => Object.hasOwn(tabs, read(tab)) ? read(tab) : 'inbox'
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
function feishu(s: Snapshot): { label: string; tone: Tone; message?: string } {
  if (!s.project!.feishu.enabled) return { label: '未启用', tone: 'neutral' }
  if (s.connection.state === 'connected') return { label: '已连接', tone: 'success' }
  if (s.connection.state === 'connecting') return { label: '连接中', tone: 'neutral' }
  if (s.connection.state === 'error') return { label: '连接异常', tone: 'danger', message: s.connection.message || '请检查应用凭据、网络和事件订阅设置。' }
  return { label: '未连接', tone: 'warning', message: '已启用，但没有建立连接。请检查设置并重新保存。' }
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
  if (!decisions.length && !checks.length) return <EmptyState icon="check" title="没有待决定或待验收的事项" />
  return <Stack gap="lg">
    {decisions.length ? <Stack gap="sm"><Heading level={2}>待决定</Heading>{decisions.map(([t, d]) => decision(t, d, true))}</Stack> : null}
    {checks.length ? <Stack gap="sm"><Heading level={2}>待验收</Heading>{checks.map(([t, a]) => check(p, t, a, true))}</Stack> : null}
  </Stack>
}
function tasks(p: Project) {
  return <Stack gap="sm">
    {p.tasks.length ? <List label="任务记录">{[...p.tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(t => {
      const state = taskState(t)
      return <ListItem key={t.id} onPress={() => open(t)}>
        <Row justify="between" gap="sm"><Text truncate>{t.title}</Text><Badge tone={tones[state]}>{labels[state]}</Badge></Row>
      </ListItem>
    })}</List> : <EmptyState icon="book" title="还没有任务记录" />}
    {p.tasks.length || p.events.length ? <Button variant="ghost" icon="download" disabled={read(busy)} onPress={() => act('export', '导出未成功', () =>
      files.saveAs({ suggestedName: `${p.ref.name}-协作记录.json`, mimeType: 'application/json', data: JSON.stringify(p, null, 2) }))}>导出项目记录</Button> : null}
    {problem('export')}
  </Stack>
}
function messages(p: Project) {
  const waiting = p.deliveries.filter(d => d.state !== 'sent')
  const states = { pending: '待通知', sending: '正在通知', sent: '已通知', failed: '通知失败', uncertain: '待核对' }
  if (!p.events.length && !waiting.length) return <EmptyState icon="bell" title="还没有消息" />
  return <Stack gap="lg">
    {waiting.length ? <Stack gap="sm"><Heading level={2}>未送达主会话</Heading>{waiting.map(d => <Box key={d.id} border radius="lg" padding="md" gap="sm" background="card">
      <Row justify="between" gap="sm" align="start"><Text weight="medium">{d.subject}</Text><Badge tone={d.state === 'pending' || d.state === 'sending' ? 'neutral' : 'warning'}>{states[d.state]}</Badge></Row>
      {summary(d.error ?? d.body)}
      {d.state === 'pending' && p.runId ? <Button disabled={read(busy)} onPress={() => act(d.id, '通知未成功', async () => {
        const answer = await plugin.request('project.deliver', { projectId: p.ref.id, deliveryId: d.id })
        if (read(selected) === p.ref.id) set(snapshot, answer)
      })}>通知主会话</Button> : null}
      {problem(d.id)}
    </Box>)}</Stack> : null}
    {p.events.length ? <Stack gap="sm">
      {waiting.length ? <Heading level={2}>飞书消息</Heading> : null}
      {[...p.events].reverse().map(e => {
        const linked = p.tasks.find(t => t.id === e.taskId)
        return <Collapsible key={e.id} title={clip(e.text.trim().split('\n')[0], 60)} description={linked ? `关联任务：${clip(linked.title, 40)}` : '未关联任务'}>
          {paragraphs(e.text)}
          <Text muted size="xs">{`${clip(e.senderId, 80)} · ${when(e.receivedAt)}`}</Text>
          {linked ? <Button variant="ghost" onPress={() => open(linked)}>查看任务</Button> : null}
        </Collapsible>
      })}
    </Stack> : null}
  </Stack>
}
function home(s: Snapshot, p: Project) {
  const f = feishu(s), { decisions, checks } = pending(p), count = decisions.length + checks.length
  // Binding is not liveness: the latest settled notification is the only evidence that the bound session still receives feedback.
  const latest = [...p.deliveries].reverse().find(d => d.state !== 'pending' && d.state !== 'sending')
  return <Stack gap="md">
    <Stack gap="sm">
      {p.runId ? null : <Callout tone="warning" title="主会话未绑定">在本项目会话中说“开启项目协作”即可绑定。</Callout>}
      {p.runId || !f.message ? <Row gap="sm" wrap>
        {p.runId ? <Badge tone="success">主会话已绑定</Badge> : null}
        {f.message ? null : <Badge tone={f.tone}>{`飞书${f.label}`}</Badge>}
      </Row> : null}
      {p.runId && latest && latest.state !== 'sent' && currentTab() !== 'messages' ? <Callout tone="warning" title="主会话可能未收到最近的通知">
        {paragraphs(latest.error ?? '请在主会话核对。')}
        <Button onPress={() => set(tab, 'messages')}>查看消息</Button>
      </Callout> : null}
      {f.message ? <Callout tone={f.tone} title={`飞书${f.label}`}>{paragraphs(f.message)}<Button onPress={openSettings}>飞书设置</Button></Callout> : null}
    </Stack>
    <Tabs label="视图" value={currentTab()} onChange={v => { set(tab, v); set(failure, null); set(editing, '') }}>
      <Tab value="inbox" label={count ? `待处理 ${count}` : '待处理'}>{inbox(p)}</Tab>
      <Tab value="tasks" label="任务记录">{tasks(p)}</Tab>
      <Tab value="messages" label="消息">{messages(p)}</Tab>
    </Tabs>
  </Stack>
}
function taskPage(p: Project, task: Task) {
  const state = taskState(task), sources = p.events.filter(e => task.sourceIds.includes(e.id))
  // Acceptance cards already show the artifacts they check; list only the rest (earlier versions, unreviewed results) here.
  const shown = task.acceptance.flatMap(a => a.artifactIds), rest = task.artifacts.filter(a => !shown.includes(a.id)).map(a => a.id)
  return <Stack gap="md">
    <Button variant="ghost" onPress={() => show(null)}>{`返回${tabs[currentTab()]}`}</Button>
    <Stack gap="xs">
      <Heading>{task.title}</Heading>
      <Row gap="sm"><Badge tone={tones[state]}>{labels[state]}</Badge><Text muted size="xs">{`更新于 ${when(task.updatedAt)}`}</Text></Row>
    </Stack>
    <Field label="目标">{paragraphs(task.goal)}</Field>
    {task.progress ? <Field label="进展">{paragraphs(task.progress)}</Field> : null}
    {task.decisions.length ? <Stack gap="sm"><Heading level={2}>决定</Heading>{task.decisions.map(d => decision(task, d))}</Stack> : null}
    {task.acceptance.length ? <Stack gap="sm"><Heading level={2}>验收</Heading>{task.acceptance.map(a => check(p, task, a))}</Stack> : null}
    {rest.length ? <Stack gap="sm"><Heading level={2}>{shown.length ? '其他成果' : '成果'}</Heading>{artifacts(p, task, rest, task.id)}{problem(task.id)}</Stack> : null}
    {sources.length ? <Collapsible title="来源消息">{sources.map(e => <Stack key={e.id} gap="xs">
      <Text muted size="xs">{`${clip(e.senderId, 80)} · ${when(e.receivedAt)}`}</Text>
      {paragraphs(e.text)}
    </Stack>)}</Collapsible> : null}
    <Collapsible title="任务信息">
      <KeyValue items={[{ label: '任务编号', value: task.id, code: true }]} />
      {task.executions.map(e => <Text key={e.dispatchId} size="xs">{`${e.agent} · ${e.taskId} · ${e.dispatchId}`}</Text>)}
    </Collapsible>
  </Stack>
}
function settingsPage(s: Snapshot, p: Project) {
  const c = read(config), f = feishu(s)
  const agents = [{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }]
  const edit = (key: keyof typeof c, value: string | boolean) => update(config, c => ({ ...c, [key]: value }))
  const split = (value: string) => value.split(/[\n,，]/).map(x => x.trim()).filter(Boolean)
  return <Stack gap="lg">
    <Stack gap="xs"><Button variant="ghost" onPress={() => show(null)}>返回</Button><Heading>项目设置</Heading></Stack>
    <Stack gap="sm"><Heading level={2}>代理分工</Heading>
      {([['design', '设计'], ['code', '代码'], ['review', '审查']] as const).map(([key, label]) => <Row key={key} justify="between" gap="sm">
        <Text weight="medium">{label}</Text>
        <Box width={128} shrink={false}><Select label={label} labelHidden value={c[key]} options={agents} onChange={v => edit(key, v)} /></Box>
      </Row>)}
    </Stack>
    <Stack gap="sm">
      <Row justify="between" gap="sm"><Heading level={2}>飞书</Heading><Badge tone={f.tone}>{f.label}</Badge></Row>
      {f.message ? <Text tone={f.tone}>{f.message}</Text> : null}
      <Switch label="接收飞书消息" checked={c.enabled} onChange={v => edit('enabled', v)} />
      <Input label="App ID" value={c.appId} onChange={v => edit('appId', v)} />
      <Input label="App Secret" type="password" value={c.appSecret} placeholder={s.secretSaved ? '已保存，留空保留' : ''} onChange={v => edit('appSecret', v)} />
      <Textarea label="群聊 Chat ID" value={c.chatIds} placeholder="每行一个" rows={2} onChange={v => edit('chatIds', v)} />
      <Textarea label="允许的发送者 Open ID" value={c.senderIds} placeholder="每行一个" rows={2} onChange={v => edit('senderIds', v)} />
      <Collapsible title="接入说明"><Text>在飞书自建应用中启用长连接，订阅 im.message.receive_v1，并将应用加入绑定群聊。</Text></Collapsible>
    </Stack>
    <Stack gap="sm">
      {problem('settings')}
      <Button variant="solid" tone="accent" disabled={read(busy)} onPress={() => act('settings', '保存未成功', async () => {
        const answer = await plugin.request('project.settings', { projectId: p.ref.id, revision: p.revision,
          roles: { design: c.design, code: c.code, review: c.review } as Project['roles'],
          feishu: { appId: c.appId, chatIds: split(c.chatIds), senderIds: split(c.senderIds), enabled: c.enabled },
          ...(c.appSecret ? { appSecret: c.appSecret } : {}) })
        if (read(selected) === p.ref.id) { set(snapshot, answer); showConfig(answer.project!); set(tab, 'inbox'); show(null) }
      })}>{read(busy) ? '正在保存…' : '保存设置'}</Button>
    </Stack>
    <Collapsible title="项目信息">
      <KeyValue items={[{ label: '路径', value: p.ref.path }, { label: '项目编号', value: p.ref.id, code: true }, ...(p.runId ? [{ label: '主会话 Run', value: p.runId, code: true }] : [])]} />
    </Collapsible>
  </Stack>
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('project.changed', e => {
    const id = read(selected)
    if (id && (!e.projectId || e.projectId === id)) void load(id)
  }))
  void list()
}
export default function Panel() {
  const all = read(projects), s = read(snapshot), p = s?.project, v = read(view), f = read(failure)
  const task = v?.kind === 'task' ? p?.tasks.find(t => t.id === v.id) : undefined
  return <Stack gap="md">
    <Box direction="row" gap="xs" align="center">
      <Box grow><Select label="项目" labelHidden value={read(selected)} placeholder="选择项目" options={(all ?? []).map(x => ({ value: x.id, label: `${x.name} · ${x.path}` }))} onChange={choose} /></Box>
      <IconButton icon="refresh" label="刷新" onPress={list} />
      {p && v?.kind !== 'settings' ? <IconButton icon="settings" label="项目设置" onPress={openSettings} /> : null}
    </Box>
    {f?.at === '' ? <Callout tone="danger" title={f.title}>{paragraphs(f.text)}<Button onPress={list}>重试</Button></Callout> : null}
    {s && p ? v?.kind === 'settings' ? settingsPage(s, p) : task ? taskPage(p, task) : home(s, p)
      : f?.at === '' ? null
      : !all || read(selected) ? <Skeleton lines={3} label="正在读取项目" />
      : <EmptyState icon="folder" title={all.length ? '选择一个项目' : 'Orca 中还没有项目'} />}
  </Stack>
}
