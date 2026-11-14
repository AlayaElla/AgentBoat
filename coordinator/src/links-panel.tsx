import { atom, read, set, update, plugin, Stack, Row, Box, Heading, Text, Button, Badge, Input, Textarea, Switch, Select, Callout, Collapsible, EmptyState, Link, type PluginRequests } from 'orca'
import type { LinksSnapshot, Sharing } from './links'
import { requestState, requestStates, type WorkspaceRequest } from './model'
import type { ProjectRef } from './model'

const state = atom<LinksSnapshot | null>(null)
const working = atom(false)
const error = atom('')
const code = atom('')
const invitation = atom('')
const config = atom({ name: '', enabled: false, host: '127.0.0.1', port: '0', publicUrl: '', tls: false, certificate: '', privateKey: '' })
const edits = atom<Record<string, Sharing>>({})
const requestNotes = atom<Record<string, string>>({})
export function pendingRequests(s?: LinksSnapshot) { return s?.requests?.filter(r => r.direction === 'incoming' && requestState(r) === 'confirm') ?? [] }
function requestCard(r: WorkspaceRequest, s: LinksSnapshot, decide = false, onUpdated?: (s: LinksSnapshot) => void) {
  const key = `${r.peerId}:${r.id}`, last = r.updates.at(-1)
  const choose = async (status: 'accepted' | 'rejected') => {
    if (read(working)) return
    set(working, true); set(error, '')
    try { const result = await plugin.request('workspace.requests', { operation: 'decide', peerId: r.peerId, id: r.id, requestId: crypto.randomUUID(), status, note: read(requestNotes)[key] || '' }); onUpdated?.(result) }
    catch (e) { set(error, e instanceof Error ? e.message : '处理未完成，请刷新核对') }
    finally { set(working, false) }
  }
  return <Box key={key} border radius="lg" padding="md" gap="sm">
    <Row gap="sm" wrap><Text weight="semibold">{r.title}</Text><Badge>{decide ? '待你确认' : requestStates[requestState(r)]}</Badge></Row>
    <Text muted>{`${r.direction === 'incoming' ? '来自' : '发往'} ${s.peers.find(p => p.id === r.peerId)?.name || '其他工作间'} · ${r.createdAt}`}</Text>
    {r.context ? <Text>{`背景：${r.context}`}</Text> : null}<Text>{`期望结果：${r.expected}`}</Text>
    {r.links.map(url => <Link key={url} href={url}>{url}</Link>)}
    {last?.note ? <Text>{last.note}</Text> : null}{last?.links.map(url => <Link key={url} href={url}>{url}</Link>)}
    {decide ? <Stack gap="sm"><Textarea label="回复说明（可不填）" value={read(requestNotes)[key] || ''} onChange={v => update(requestNotes, all => ({ ...all, [key]: v }))} />
      <Row gap="sm"><Button disabled={read(working)} onPress={() => choose('accepted')}>接受</Button><Button disabled={read(working)} onPress={() => choose('rejected')}>拒绝</Button></Row>
    </Stack> : null}
  </Box>
}
export function requestPage(s: LinksSnapshot | undefined, id: string, onUpdated: (s: LinksSnapshot) => void) {
  const r = s?.requests?.find(r => `${r.peerId}:${r.id}` === id)
  return <Stack gap="md"><Heading>外部请求</Heading>{s && r ? requestCard(r, s, r.direction === 'incoming' && requestState(r) === 'confirm', onUpdated) : <EmptyState title="请求已不存在，请刷新" />}{read(error) ? <Callout tone="danger" title="请求处理未完成">{read(error)}</Callout> : null}</Stack>
}
const scopes = [{ value: 'none', label: '不开放' }, { value: 'summary', label: '项目摘要' }, { value: 'details', label: '含任务详情' }]
async function act(input: PluginRequests['workspace.links']['input'], reset = false) {
  if (read(working)) return
  set(working, true); set(error, '')
  try {
    const s = await plugin.request('workspace.links', input)
    set(state, s)
    if (s.invitation) set(invitation, s.invitation.code)
    if (input.operation === 'join') { set(code, ''); if (s.peers.some(p => p.state === 'pending')) set(error, '连接结果待核对，请刷新原连接，不要重复连接。') }
    if (reset || input.operation === 'configure') set(config, { name: s.name, enabled: s.enabled, host: s.host, port: String(s.port), publicUrl: s.publicUrl, tls: s.tls, certificate: '', privateKey: '' })
    if (reset || input.operation === 'share' || input.operation === 'revoke') set(edits, Object.fromEntries(s.peers.map(p => [p.id, { scope: p.scope, projectIds: p.projectIds, acceptTasks: p.acceptTasks }])))
    if (input.operation === 'cancel-invite' || input.operation === 'configure') set(invitation, '')
  } catch (e) { set(error, e instanceof Error ? e.message : '操作未完成，请刷新核对') }
  finally { set(working, false) }
}
const names = { connected: '已连接', offline: '离线', pending: '待核对', revoked: '已撤销' }
const phases: Record<string, string> = { working: '进行中', ready: '待验收', completed: '已完成', blocked: '受阻', paused: '已暂停' }
export function linksSection(s: LinksSnapshot | undefined, openRequest: (id: string) => void) {
  return <Stack gap="sm">
    {s?.error ? <Callout tone="danger" title="工作间连接">{s.error}</Callout> : null}
    {!s?.peers.length ? <EmptyState title="尚未连接其他工作间" /> : s.peers.map(p => <Box key={p.id} border radius="lg" padding="md" gap="sm">
      <Row gap="sm" wrap><Text weight="semibold">{p.name}</Text><Badge tone={p.status === 'connected' ? 'success' : 'neutral'}>{names[p.status]}</Badge></Row>
      {p.receivedAt ? <Text muted>{`收到于 ${new Date(p.receivedAt).toLocaleString('zh-CN')}`}</Text> : null}
      {p.report ? <Stack gap="sm"><Text>{`对方向我开放：${scopes.find(s => s.value === p.report!.scope)?.label}`}</Text>
        <Text muted>{`对方更新于 ${p.report.updatedAt}`}</Text>
        {p.report.projects.map(project => <Stack key={project.id} gap="xs"><Text weight="medium">{`${project.name} · 待处理 ${project.pending}`}</Text>
          <Row gap="xs" wrap>{Object.entries(project.counts).map(([phase, count]) => <Badge key={phase}>{`${({ decision: '待决定', review: '待验收', rework: '修改中', ...phases })[phase]} ${count}`}</Badge>)}</Row>
          {project.tasks?.map((t, i) => <Stack key={String(i)} gap="xs"><Text>{`${t.title} · ${phases[t.phase]}`}</Text>
            {t.decisions.map((v, i) => <Text key={`d${i}`}>{`待决定：${v}`}</Text>)}{t.acceptance.map((v, i) => <Text key={`a${i}`}>{`待验收：${v}`}</Text>)}
          </Stack>)}
        </Stack>)}
      </Stack> : p.state === 'active' ? <Text muted>刷新后读取；离线时不展示旧内容。</Text> : null}
    </Box>)}
    <Heading level={2}>往来请求</Heading>{s?.requests?.map(r => <Button key={`${r.peerId}:${r.id}`} onPress={() => openRequest(`${r.peerId}:${r.id}`)}>{`${r.title.slice(0, 18)} · ${requestStates[requestState(r)]}`}</Button>)}<Text muted>要给对方派活，在主 agent 的对话里说就行。</Text>
    <Button disabled={read(working)} onPress={() => { void act({ operation: 'refresh' }).then(() => plugin.request('workspace.overview')) }}>刷新工作间</Button>
  </Stack>
}
export function loadLinks() { return act({ operation: 'read' }, true) }
export function closeLinks() { set(code, ''); set(invitation, ''); set(error, ''); set(requestNotes, {}); update(config, c => ({ ...c, certificate: '', privateKey: '' })) }
export function linksPage(projects: ProjectRef[]) {
  const s = read(state), c = read(config)
  const edit = (k: keyof typeof c, v: string | boolean) => update(config, c => ({ ...c, [k]: v }))
  return <Stack gap="md">
    {read(error) ? <Callout tone="danger" title="操作未完成">{read(error)}</Callout> : null}
    {s?.error ? <Callout tone="danger" title="监听异常">{s.error}</Callout> : null}
    <Collapsible title="本工作间" defaultOpen>
      <Input label="工作间名称" value={c.name} onChange={v => edit('name', v)} />
      <Switch label="启用连接监听" checked={c.enabled} onChange={v => edit('enabled', v)} />
      <Collapsible title="高级"><Input label="监听 IP" value={c.host} onChange={v => edit('host', v)} />
      <Input label="监听端口" value={c.port} onChange={v => edit('port', v)} />
      <Switch label="使用 TLS" checked={c.tls} onChange={v => edit('tls', v)} />
      {c.tls ? <Stack gap="sm"><Textarea label="TLS 证书" value={c.certificate} onChange={v => edit('certificate', v)} />
        <Input label="TLS 私钥" type="password" value={c.privateKey} placeholder="已保存时留空保留" onChange={v => edit('privateKey', v)} /></Stack> : null}
      </Collapsible><Input label="对方访问地址" value={c.publicUrl} placeholder="留空使用监听地址" onChange={v => edit('publicUrl', v)} />
      <Button disabled={read(working) || !s} onPress={() => void act({ ...c, port: Number(c.port), revision: s!.revision, operation: 'configure' })}>保存连接设置</Button>
      {s?.listening ? <Text>{`正在监听 ${s.listening}`}</Text> : null}
    </Collapsible>
    <Row gap="sm" wrap><Button disabled={read(working) || !s?.listening} onPress={() => void act({ operation: 'invite' })}>生成连接码</Button>
      {read(invitation) ? <Button disabled={read(working)} onPress={() => void act({ operation: 'cancel-invite' })}>撤销连接码</Button> : null}</Row>
    {read(invitation) ? <Stack gap="xs"><Text>连接码两分钟内有效，只能使用一次。请私下交给对方。</Text><Textarea label="本次连接码" value={read(invitation)} onChange={() => {}} /></Stack> : null}
    <Textarea label="对方的连接码" value={read(code)} onChange={v => set(code, v)} />
    <Button disabled={read(working) || !read(code).trim()} onPress={() => void act({ operation: 'join', code: read(code).trim() }, true)}>连接工作间</Button>
    {s?.peers.filter(p => p.state !== 'revoked').map(p => {
      const e = read(edits)[p.id] || { scope: p.scope, projectIds: p.projectIds, acceptTasks: p.acceptTasks }
      const change = (patch: Partial<Sharing>) => update(edits, all => ({ ...all, [p.id]: { ...e, ...patch } }))
      return <Box key={p.id} border radius="lg" padding="md" gap="sm"><Row gap="sm" wrap><Text weight="semibold">{p.name}</Text><Badge>{names[p.status]}</Badge></Row>
        <Select label="向对方开放" value={e.scope} options={scopes} onChange={v => change({ scope: v as Sharing['scope'] })} />
        {e.scope !== 'none' ? projects.map(project => <Switch key={project.id} label={project.name.slice(0, 18)} checked={e.projectIds.includes(project.id)} onChange={v => change({ projectIds: v ? [...e.projectIds, project.id] : e.projectIds.filter(id => id !== project.id) })} />) : null}
        <Select label="接受对方派活" value={e.acceptTasks} options={[{ value: 'deny', label: '不接受' }, { value: 'confirm', label: '需我确认' }, { value: 'auto', label: '自动受理' }]} onChange={v => change({ acceptTasks: v as Sharing['acceptTasks'] })} />
        <Row gap="sm" wrap><Button disabled={read(working) || p.state !== 'active'} onPress={() => void act({ operation: 'share', revision: s.revision, id: p.id, ...e })}>保存开放范围</Button>
          <Button disabled={read(working)} onPress={() => void act({ operation: 'revoke', id: p.id })}>断开连接</Button></Row>
      </Box>
    })}
    <Button disabled={read(working)} onPress={() => void act({ operation: 'refresh' }, true)}>刷新连接</Button>
    <Collapsible title="两台机器如何连接"><Text>一方提供对方能访问的 HTTPS 地址，或用已有 SSH 隧道转到回环端口。只需另一方能访问它。生成连接码后由对方填写，双方各自勾选开放项目。配置步骤见 coordinator/LINKS.md。</Text></Collapsible>
  </Stack>
}
