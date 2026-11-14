import { atom, read, set, update, plugin, Stack, Row, Heading, Text, Button, Input, Textarea, Switch, Select, Badge, Callout, Collapsible, List, ListItem, EmptyState, Skeleton } from 'orca'
import type { Connection, ConnectionDetail, ConnectionsInput } from './connections'

export const connectionStates = { off: '未启用', connecting: '连接中', connected: '已连接', error: '连接异常', unchecked: '未检查' }
const current = atom<ConnectionDetail | null>(null), working = atom(false), error = atom(''), deleting = atom(false)
let epoch = 0
const draft = atom({ name: '', type: 'a2a' as 'a2a' | 'feishu', enabled: false, url: 'http://127.0.0.1:9900', port: '0', inboundToken: '', outboundToken: '', appId: '', appSecret: '', chatIds: '', senderIds: '' })
export function clearConnectionDraft() { epoch++; update(draft, d => ({ ...d, inboundToken: '', outboundToken: '', appSecret: '' })); set(error, ''); set(deleting, false) }
export async function loadConnection(id: string) {
  clearConnectionDraft()
  const request = epoch
  const s = await plugin.request('workspace.connections', { operation: 'read', connectionId: id }) as ConnectionDetail
  if (request !== epoch) return
  set(current, s)
  set(draft, { name: s.connection.name, type: s.connection.type, enabled: s.connection.enabled, url: s.a2a?.url || 'http://127.0.0.1:9900', port: String(s.a2a?.port ?? 0), inboundToken: '', outboundToken: '', appSecret: '', appId: s.feishu?.feishu.appId || '', chatIds: s.feishu?.feishu.chatIds.join('\n') || '', senderIds: s.feishu?.feishu.senderIds.join('\n') || '' })
}
export function connectionsList(items: Connection[], open: (id: string) => void, add: () => void) {
  return <Stack gap="md"><Heading>外部连接</Heading><Text>外部连接只与主 agent 往来。</Text>
    {items.length ? <List label="外部连接">{items.map(c => <ListItem key={c.id} onPress={() => open(c.id)}><Stack gap="xs"><Text weight="medium">{c.name}</Text><Text muted>{`${c.type === 'a2a' ? 'A2A agent' : '飞书'} · ${connectionStates[c.state]}`}</Text></Stack>{c.state === 'error' ? <Badge tone="warning">要处理</Badge> : null}</ListItem>)}</List> : <EmptyState title="还没有外部连接" />}
    <Button onPress={() => { set(current, null); set(draft, { name: 'Hermes', type: 'a2a', enabled: false, url: 'http://127.0.0.1:9900', port: '0', inboundToken: '', outboundToken: '', appId: '', appSecret: '', chatIds: '', senderIds: '' }); add() }}>添加连接</Button>
  </Stack>
}
export function addConnection(items: Connection[], next: () => void) {
  const d = read(draft)
  return <Stack gap="md"><Heading>添加连接</Heading><Select label="类型" value={d.type} options={[{ value: 'a2a', label: 'A2A agent（Hermes 等）' }, { value: 'feishu', label: items.some(c => c.type === 'feishu') ? '飞书 · 已经有了' : '飞书', disabled: items.some(c => c.type === 'feishu') }, { value: 'wecom', label: '企业微信 · 以后支持', disabled: true }]} onChange={v => update(draft, d => ({ ...d, type: v as typeof d.type, name: v === 'feishu' ? '飞书' : 'Hermes' }))} />
    <Input label="名字" value={d.name} onChange={v => update(draft, d => ({ ...d, name: v }))} /><Button disabled={!d.name.trim()} onPress={next}>下一步：填连接信息</Button></Stack>
}
export function connectionPage(onSaved: (id: string) => void, onDeleted: () => void, expectedId?: string) {
  const s = read(current), d = read(draft), edit = (k: keyof typeof d, v: string | boolean) => update(draft, d => ({ ...d, [k]: v }))
  if (expectedId && s?.connection.id !== expectedId) return <Skeleton label="正在读取连接" lines={3} />
  const split = (s: string) => s.split(/[\n,，]/).map(v => v.trim()).filter(Boolean)
  async function act(operation: ConnectionsInput['operation']) {
    if (read(working)) return
    set(working, true); set(error, '')
    try {
      const input: ConnectionsInput = { operation, ...(s ? { connectionId: s.connection.id } : { type: d.type }), name: d.name, confirm: operation === 'delete' }
      if (operation === 'save') Object.assign(input, d.type === 'a2a' ? { enabled: d.enabled, url: d.url, port: Number(d.port), revision: s?.a2a?.revision ?? 0, inboundToken: d.inboundToken, outboundToken: d.outboundToken } : { revision: s?.feishu?.revision ?? 0, feishu: { enabled: d.enabled, appId: d.appId, chatIds: split(d.chatIds), senderIds: split(d.senderIds) }, appSecret: d.appSecret })
      const result = await plugin.request('workspace.connections', input)
      clearConnectionDraft()
      if (operation === 'delete') { set(current, null); onDeleted() }
      else { set(current, result as ConnectionDetail); onSaved((result as ConnectionDetail).connection.id) }
    } catch (e) { set(error, e instanceof Error ? e.message : '操作未完成，请刷新核对') }
    finally { set(working, false) }
  }
  return <Stack gap="md"><Row justify="between"><Heading>{d.name}</Heading><Badge>{s ? connectionStates[s.connection.state] : '未启用'}</Badge></Row><Text muted>{`类型：${d.type === 'a2a' ? 'A2A agent（Hermes 等）' : '飞书'}`}</Text>
    <Text>{d.type === 'a2a' ? '与主 agent 交换消息和结果。' : '接收消息、提醒和用户反馈。'}</Text>
    {read(error) || s?.connection.message ? <Callout tone="danger" title="连接异常">{read(error) || s?.connection.message}</Callout> : null}
    <Input label="名字" value={d.name} onChange={v => edit('name', v)} /><Switch label="启用这个连接" checked={d.enabled} onChange={v => edit('enabled', v)} />
    {d.enabled ? d.type === 'a2a' ? <Stack gap="md"><Input label="对方的地址" value={d.url} onChange={v => edit('url', v)} />
      <Collapsible title="连接参数"><Input label="对方的令牌" type="password" value={d.outboundToken} placeholder={s?.a2a?.outboundSecretSaved ? '已保存，留空保留' : '至少 32 字符'} onChange={v => edit('outboundToken', v)} /><Input label="主 agent 监听端口" value={d.port} onChange={v => edit('port', v)} /><Input label="主 agent 的令牌" type="password" value={d.inboundToken} placeholder={s?.a2a?.inboundSecretSaved ? '已保存，留空保留' : '至少 32 字符'} onChange={v => edit('inboundToken', v)} />{s?.a2a?.listening ? <Text>{s.a2a.listening}</Text> : null}</Collapsible>
      {s?.connection.id === 'butler' ? <Stack gap="xs"><Heading level={2}>电脑操作的批准</Heading><Text>{s.approvalMode === 'smart' ? '危险命令：smart，拿不准的拒绝' : s.approvalMode && s.approvalMode !== 'unknown' ? `危险命令：${s.approvalMode}` : '当前审批方式未读取成功，请刷新核对'}</Text><Text muted>定时、单次查询、无人值守仍按 Hermes 的独立设置处理。</Text></Stack> : <Text muted>电脑操作的批准由对方管理。</Text>}</Stack>
      : <Stack gap="sm"><Input label="App ID" value={d.appId} onChange={v => edit('appId', v)} /><Input label="App Secret" type="password" value={d.appSecret} placeholder={s?.feishu?.secretSaved ? '已保存，留空保留' : ''} onChange={v => edit('appSecret', v)} /><Textarea label="允许的用户" value={d.senderIds} onChange={v => edit('senderIds', v)} /><Textarea label="允许的会话" value={d.chatIds} onChange={v => edit('chatIds', v)} /></Stack> : null}
    <Row gap="sm"><Button disabled={read(working)} onPress={() => act('save')}>保存</Button>{d.type === 'a2a' ? <Button disabled={read(working) || !s?.connection.enabled} onPress={() => act('check')}>检查连接</Button> : null}</Row>
    <Collapsible title="怎么接入"><Text>{d.type === 'a2a' ? 'Hermes 的 A2A v1 JSONRPC 地址填入对方地址；两个方向各使用独立令牌。主 agent 监听回环地址。' : '在飞书应用启用长连接，订阅 im.message.receive_v1；填写允许的用户和会话。'}</Text></Collapsible>
    {d.type === 'a2a' ? <Collapsible title="最近往来">{s?.a2a?.entries.length ? s.a2a.entries.map(e => <Text key={`${e.direction}:${e.id}`}>{`${e.direction === 'incoming' ? '收到' : '发出'} · ${{ TASK_STATE_SUBMITTED: '已接收', TASK_STATE_WORKING: '处理中', TASK_STATE_COMPLETED: '已完成', TASK_STATE_FAILED: '失败' }[e.task.status.state] || '等待处理'} · ${e.task.status.timestamp}`}</Text>) : <Text>暂无往来</Text>}</Collapsible> : null}
    {s ? read(deleting) ? <Callout tone="warning" title="删除这个连接？"><Text>会删除这个连接的设置、凭据和往来记录，项目不受影响，以后可以重新添加。</Text><Button tone="danger" disabled={read(working)} onPress={() => act('delete')}>确认删除连接</Button><Button onPress={() => set(deleting, false)}>取消</Button></Callout> : <Button tone="danger" onPress={() => set(deleting, true)}>删除这个连接</Button> : null}
  </Stack>
}
