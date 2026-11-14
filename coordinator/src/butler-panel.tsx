import { atom, read, set, update, plugin, Stack, Row, Box, Heading, Text, Button, Input, Switch, Badge, Callout, Collapsible } from 'orca'
import type { ButlerSnapshot } from './butler'

const opened = atom(false), saving = atom(false), error = atom('')
const current = atom<ButlerSnapshot | null>(null)
const draft = atom({ enabled: false, port: '9901', url: 'http://127.0.0.1:9900', inboundToken: '', outboundToken: '' })
const states: Record<string, string> = { TASK_STATE_SUBMITTED: '已接收', TASK_STATE_WORKING: '处理中', TASK_STATE_COMPLETED: '已完成', TASK_STATE_FAILED: '失败', TASK_STATE_REJECTED: '已拒绝', TASK_STATE_CANCELED: '已取消', TASK_STATE_INPUT_REQUIRED: '等待回复', TASK_STATE_AUTH_REQUIRED: '等待授权' }
export const butlerOpened = () => read(opened)
export const closeButler = () => { set(opened, false); update(draft, d => ({ ...d, inboundToken: '', outboundToken: '' })) }
export async function openButler() {
  set(error, '')
  try {
    const s = await plugin.request('workspace.butler', { operation: 'read' })
    set(current, s); set(draft, { enabled: s.enabled, port: String(s.port), url: s.url, inboundToken: '', outboundToken: '' }); set(opened, true)
  } catch (e) { set(error, e instanceof Error ? e.message : '读取管家设置失败') }
}
export function butlerSection(s?: ButlerSnapshot) {
  return <Box border radius="lg" padding="md" gap="sm" background="card">
    <Row justify="between"><Heading level={2}>管家</Heading><Badge tone={s?.enabled && s.connection === '已连接' ? 'success' : 'neutral'}>{s?.enabled ? s.connection : '未启用'}</Badge></Row>
    {s?.error ? <Text tone="danger">{s.error}</Text> : null}
    <Button onPress={openButler}>管家设置</Button>
    {read(error) && !read(opened) ? <Text tone="danger">{read(error)}</Text> : null}
  </Box>
}
export function butlerPage() {
  const s = read(current)!, d = read(draft)
  const edit = (k: keyof typeof d, v: string | boolean) => update(draft, d => ({ ...d, [k]: v }))
  async function act(operation: 'save' | 'check') {
    if (read(saving)) return
    set(saving, true); set(error, '')
    try {
      const next = await plugin.request('workspace.butler', operation === 'check' ? { operation } : { operation, revision: s.revision, ...d, port: Number(d.port) })
      set(current, next); update(draft, d => ({ ...d, inboundToken: '', outboundToken: '' }))
    } catch (e) { set(error, e instanceof Error ? e.message : '操作失败') }
    finally { set(saving, false) }
  }
  return <Stack gap="lg">
    <Button variant="ghost" onPress={closeButler}>返回</Button><Heading>管家设置</Heading>
    <Text>{s.enabled ? s.connection : '未启用'}</Text>
    <Switch label="启用管家" checked={d.enabled} onChange={v => edit('enabled', v)} />
    <Input label="Hermes A2A 地址" value={d.url} onChange={v => edit('url', v)} />
    <Input label="Hermes 令牌" type="password" value={d.outboundToken} placeholder={s.outboundSecretSaved ? '已保存，留空保留' : '至少 32 字符'} onChange={v => edit('outboundToken', v)} />
    <Input label="主 agent 监听端口" value={d.port} onChange={v => edit('port', v)} />
    <Input label="主 agent 令牌" type="password" value={d.inboundToken} placeholder={s.inboundSecretSaved ? '已保存，留空保留' : '至少 32 字符'} onChange={v => edit('inboundToken', v)} />
    {s.listening ? <Text>{s.listening}</Text> : null}
    {read(error) || s.error ? <Callout tone="danger" title="管家连接">{read(error) || s.error}</Callout> : null}
    <Row gap="sm"><Button variant="solid" disabled={read(saving)} onPress={() => act('save')}>保存设置</Button><Button disabled={read(saving) || !s.enabled} onPress={() => act('check')}>检查连接</Button></Row>
    <Collapsible title="消息记录">
      {s.entries.length ? s.entries.map(e => <Stack key={`${e.direction}:${e.id}`} gap="xs"><Text>{`${e.direction === 'incoming' ? '来自管家' : '交给管家'} · ${states[e.task.status.state] || '未知'}`}</Text><Text>{e.id}</Text>{e.error ? <Text tone="danger">{e.error}</Text> : null}</Stack>) : <Text>暂无消息</Text>}
    </Collapsible>
    <Collapsible title="安装和登录"><Text>运行 workspace/install-hermes.ps1 准备 Hermes。订阅登录请在本机终端运行 hermes model，选择 ChatGPT or Codex Subscription，按提示自行在浏览器完成设备码登录。详见 coordinator/BUTLER.md。</Text></Collapsible>
  </Stack>
}
