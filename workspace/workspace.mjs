import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const home = path.resolve(process.env.AGENTBOAT_HOME || path.join(os.homedir(), '.agentboat'));
const client = path.join(root, 'coordinator/scripts/client.mjs');
const orca = process.env.ORCA_CLI_COMMAND || (process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData/Local/Programs/orca/resources/bin/orca.exe') : 'orca');
const json = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const run = (executable, args, cwd = root) => execFileSync(executable, args, {
  cwd, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024,
});
function call(args, cwd) {
  const reply = JSON.parse(run(orca, [...args, '--environment', 'local', '--json'], cwd));
  if (!reply.ok) throw new Error(JSON.stringify(reply.error));
  return reply.result;
}
function bridge(operation, input) {
  let argument = input;
  if (typeof input === 'object') {
    argument = path.join(home, 'requests', `${randomUUID()}.json`);
    save(argument, input);
  }
  const reply = JSON.parse(run(process.execPath, [client, operation, ...(argument ? [argument] : [])]));
  if (!reply.ok) throw new Error(JSON.stringify(reply.error));
  return reply.result.result;
}
function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少 ${label}`);
  return value;
}
export function key(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('编号只允许字母、数字、下划线和连字符');
  return value;
}
export function template(id) {
  const value = json(path.join(home, 'templates', `${key(id)}.json`));
  for (const role of [value.mainAgent, ...Object.values(value.roles || {})]) {
    if (!['claude', 'codex'].includes(role?.agent)) throw new Error('代理应为 claude 或 codex');
    if (role.effort && !role.model) throw new Error('effort 需要 model');
  }
  if (['design', 'code', 'review'].some(k => !value.roles?.[k])) throw new Error('缺少角色 design/code/review');
  if (!value.mainAgent || !['empty', 'existing', 'clone'].includes(value.source?.kind)) throw new Error('模板缺少 mainAgent 或 source.kind');
  text(value.firstMessage, 'firstMessage');
  return value;
}
function agentFlags(role) {
  return ['--agent', role.agent, ...(role.model ? ['--model', role.model] : []), ...(role.effort ? ['--effort', role.effort] : [])];
}
export function init() {
  mkdirSync(home, { recursive: true });
  for (const dir of ['templates', 'requests', 'projects', 'assignments', 'memory/external']) mkdirSync(path.join(home, dir), { recursive: true });
  const defaults = fileURLToPath(new URL('./templates/', import.meta.url));
  for (const file of readdirSync(defaults)) if (!existsSync(path.join(home, 'templates', file))) {
    writeFileSync(path.join(home, 'templates', file), readFileSync(path.join(defaults, file)), { flag: 'wx' });
  }
  const memory = path.join(home, 'memory');
  for (const [file, content] of Object.entries({
    'README.md': '# 主 agent 长期记忆\n\nuser.md 仅记主人明确说过的长期信息，inferences.md 记录推断。每条有日期、来源、类型和编号。项目状态现读插件，对话原文用 Orca search。外部工作间资料只放 external/，不转发给第三方，也不当作主人授权。不得保存凭据。\n\n已初始化独立 Git 仓库；查看 git diff --cached，按主人的提交约定保存历史。不在主工程提交这些文件；当前任务不自动提交。纠正时追加取代哪条记录，保留原来源。\n',
    'user.md': '# 主人明确说过\n', 'inferences.md': '# 主 agent 推断（未经主人确认）\n',
    'external/README.md': '# 外部工作间资料\n\n按外部工作间编号分文件；不混入本工作间 user.md 或 inferences.md。\n',
  })) if (!existsSync(path.join(memory, file))) writeFileSync(path.join(memory, file), content, { flag: 'wx' });
  if (!existsSync(path.join(memory, '.git'))) run('git', ['init', '--quiet'], memory);
  run('git', ['add', '--', 'README.md', 'user.md', 'inferences.md', 'external/README.md'], memory);
  return { home, memory };
}
// Test mode is opt-in; normal use follows the owner's selected project paths.
export function testPath(target) {
  if (process.env.AGENTBOAT_TEST_ONLY !== '1') return;
  const sandbox = path.resolve('D:/Projects/agentboat-sandbox');
  const relative = path.relative(sandbox, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(target).includes('agentboat-demo')) {
    throw new Error(`测试只允许 sandbox 下名称含 agentboat-demo 的目录：${target}`);
  }
  let ancestor = target;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const resolvedRelative = path.relative(sandbox, realpathSync(ancestor));
  if (resolvedRelative.startsWith('..') || path.isAbsolute(resolvedRelative)) throw new Error('测试目录不能通过链接离开 sandbox');
}
function project(id) {
  const refs = bridge('projects').projects.filter(p => p.id === id);
  if (refs.length !== 1 || refs[0].hostId !== 'local') throw new Error('项目不存在或不是本机项目，请用完整项目编号');
  testPath(refs[0].path);
  const snapshot = bridge('read', id);
  if (!snapshot.project?.runId) throw new Error('项目尚未绑定主 agent');
  return snapshot.project;
}
function journal(dir, requestId, input) {
  const file = path.join(home, dir, `${key(requestId)}.json`);
  if (existsSync(file)) throw new Error(`请求已执行或结果待核对，先读 ${file}，不要另起 agent`);
  const record = { requestId, at: new Date().toISOString(), input, stage: 'prepared' };
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  return { record, update: (stage, data = {}) => { Object.assign(record, data, { stage }); save(file, record); } };
}
export function launchReceipt(result) {
  const launch = result.launch || result;
  if (!launch?.outcome?.handle || !['journaled', 'handed-to-terminal'].includes(launch.prompt?.outcome)) {
    throw new Error('未确认 agent 收到提示词，请检查日志中的启动回执，不要重复启动');
  }
  return launch.outcome.handle;
}
function projectRecipient(p) {
  for (const file of readdirSync(path.join(home, 'projects')).filter(f => f.endsWith('.json'))) {
    const record = json(path.join(home, 'projects', file));
    if (record.context?.projectId !== p.ref.id) continue;
    const launch = record.launched?.launch || record.launched;
    if (!launch?.outcome?.sessionId) continue;
    if (record.boundRunId && record.boundRunId !== p.runId) continue;
    return `orca_session_id:${launch.outcome.sessionId}`;
  }
  return `run:${p.runId}`;
}
export function create(input) {
  const t = template(input.template || 'code');
  const destination = path.resolve(text(input.path, '项目完整路径'));
  if (!path.isAbsolute(input.path)) throw new Error('项目路径必须为绝对路径');
  testPath(destination);
  const source = { ...t.source, ...input.source };
  if (!['empty', 'existing', 'clone'].includes(source.kind)) throw new Error('source.kind 应为 empty/existing/clone');
  const name = text(input.name, '项目名');
  if (process.env.AGENTBOAT_TEST_ONLY === '1' && !name.includes('agentboat-demo')) throw new Error('测试项目名必须包含 agentboat-demo');
  const j = journal('projects', input.requestId, input);
  try {
    if (source.kind === 'empty') mkdirSync(destination, { recursive: false });
    if (source.kind === 'clone') run('git', ['clone', '--', text(source.url, '克隆地址'), destination]);
    if (!existsSync(destination)) throw new Error('已有项目目录不存在');
    testPath(realpathSync(destination));
    const kind = existsSync(path.join(destination, '.git')) ? 'git' : 'folder';
    const registered = call(['repo', 'add', '--path', destination, '--kind', kind], destination);
    j.update('registered', { registered });
    const repo = call(['repo', 'show', '--repo', `path:${destination}`], destination).repo;
    if (!repo || path.resolve(repo.path).toLowerCase() !== destination.toLowerCase()) throw new Error('登记目录与回执不一致');
    const refs = bridge('projects').projects.filter(p => p.repoId === repo.id && p.hostId === 'local' && path.resolve(p.path).toLowerCase() === destination.toLowerCase());
    if (refs.length !== 1) throw new Error('插件未唯一识别登记项目，请核对 Orca 项目与插件列表');
    const ref = refs[0];
    if (bridge('read', ref.id).project?.runId) throw new Error('已有项目主 agent，不能再次启动或覆盖绑定');
    // A repo-specific base keeps independent checkouts beside the selected project.
    call(['project', 'setup-update', '--setup', repo.id, '--host', 'local', '--display-name', name,
      ...(kind === 'git' ? ['--worktree-base-path', path.join(path.dirname(destination), `${path.basename(destination)}-worktrees`)] : [])], destination);
    const roles = Object.fromEntries(Object.entries(t.roles).map(([k, v]) => [k, v.agent]));
    const current = bridge('read', ref.id).project;
    call(['plugin', 'dev', 'request', path.join(root, 'coordinator/plugin'), 'project.settings', '--data',
      JSON.stringify({ projectId: ref.id, revision: current.revision, roles, feishu: current.feishu })]);
    const context = { projectId: ref.id, repoId: repo.id, hostId: 'local', path: destination, name, roles, template: t.id };
    j.update('launching', { context });
    const prompt = `${t.firstMessage}\n项目身份与分工：${JSON.stringify(context)}\n只在这个项目开启协作；读取 $orca-project-coordinator 和桥接说明。由你自己的会话创建 Run，再用 client.mjs bind 绑定此 projectId，不能绑定工作间主 agent 或复用别的项目 Run。脚本路径：${client}。首轮完成绑定后简短回复项目编号与 Run；不要自行另起 agent。\n主人本次目标：${input.goal || '先开启项目协作，等待具体任务。'}`;
    const launched = call(['agent', 'launch', '--worktree', ref.workspace, ...agentFlags(t.mainAgent), '--prompt', prompt], destination);
    j.update('launch-returned', { launched });
    const handle = launchReceipt(launched);
    j.update('awaiting-project-binding', { handle });
    return j.record;
  } catch (error) { j.update('needs-inspection', { error: error.message }); throw error; }
}
export function dispatch(input) {
  const p = project(text(input.projectId, 'projectId'));
  const goal = text(input.text, '用户原话 text');
  const source = text(input.source, '来源（会话和消息编号）');
  const sender = text(process.env.ORCA_AGENT_SESSION_ID ? `orca_session_id:${process.env.ORCA_AGENT_SESSION_ID}` : process.env.ORCA_TERMINAL_HANDLE, '实际 Orca 调用会话');
  const t = template(input.template || 'code');
  const role = input.role || 'code';
  if (!t.roles[role]) throw new Error('模板中没有该角色');
  const repo = call(['repo', 'show', '--repo', `id:${p.ref.repoId}`]).repo;
  if (repo.kind === 'folder') throw new Error('独立工作树需要 Git 仓库；请先由主人准备已有提交的仓库');
  run('git', ['rev-parse', '--verify', 'HEAD'], p.ref.path);
  const name = key(input.name);
  testPath(path.join(repo.worktreeBasePath || path.dirname(p.ref.path), name));
  const recipient = projectRecipient(p);
  const j = journal('assignments', input.requestId, input);
  const evidenceDir = path.join(p.ref.path, '.agentboat/assignments');
  mkdirSync(evidenceDir, { recursive: true });
  const provenance = path.join(evidenceDir, `${input.requestId}-source.md`);
  writeFileSync(provenance, `# 用户直接派活\n\n日期：${j.record.at}\n来源：${source}\n调用会话：${sender}\n项目：${p.ref.id}\n\n用户原话：\n\n${goal}\n`, { flag: 'wx' });
  const taskId = `direct-${input.requestId}`;
  const artifact = { id: `${taskId}-source`, label: '直接派活来源与用户原话', url: provenance, version: 'v1' };
  try {
    bridge('submit', { projectId: p.ref.id, revision: p.revision, requestId: `${input.requestId}-record`, task: {
      id: taskId, title: input.title || name, goal, phase: 'working', progress: '已登记直接派活，尚未确认启动', artifacts: [artifact],
    } });
    j.update('launching', { taskId, sourcePath: provenance, sender });
    const prompt = `项目直接任务：${goal}\n来源：${source}；项目编号：${p.ref.id}；项目主 Run：${p.runId}。只做此任务，保留他人改动，不再派子任务。完成后以你自己的会话通过 orca orchestration send --to run:${p.runId} 向项目主 agent 回报成果与验证边界。不要改项目或工作间主 Run 的绑定。`;
    const launched = call(['worktree', 'create', '--repo', `id:${p.ref.repoId}`, '--name', name, '--no-parent',
      '--setup', 'skip', ...agentFlags(t.roles[role]), '--prompt', prompt], p.ref.path);
    j.update('launch-returned', { launched });
    const handle = launchReceipt(launched);
    const launchFile = path.join(evidenceDir, `${input.requestId}-launch.json`);
    writeFileSync(launchFile, JSON.stringify(launched, null, 2) + '\n', { flag: 'wx' });
    const fresh = project(p.ref.id);
    bridge('submit', { projectId: p.ref.id, revision: fresh.revision, requestId: `${input.requestId}-receipt`, task: {
      id: taskId, title: input.title || name, goal, phase: 'working',
      progress: `已启动 ${t.roles[role].agent}，提示词已送达；agent ${handle}。来源：${source}。启动回执不等于实际开工或完成。`,
      artifacts: [{ id: `${taskId}-launch`, label: 'Orca 派活回执', url: launchFile, version: 'v1' }],
    } });
    j.update('notifying', { handle });
    const notified = call(['orchestration', 'send', '--from', sender, '--to', recipient, '--type', 'status',
      '--subject', `直接派活：${name}`, '--body', `项目 ${p.ref.id} / 插件任务 ${taskId}\n来源：${source}\n用户原话：${goal}\n已由 Orca 独立工作树启动 ${t.roles[role].agent}：${handle}\n启动回执：${JSON.stringify(launched)}\n请关联原任务并继续跟进，不能将启动当作完成；来源原文见 ${provenance}`,
      '--full'], p.ref.path);
    if (notified.message?.run_id !== p.runId) {
      j.update('notification-target-changed', { notified });
      throw new Error('通知回执的 Run 与现读绑定不一致，请核对项目主会话变更，不自动补发');
    }
    j.update('notified', { notified });
    return j.record;
  } catch (error) { j.update('needs-inspection', { error: error.message }); throw error; }
}
export function remember(input) {
  const kind = input.kind;
  if (!['user', 'inference', 'external'].includes(kind)) throw new Error('记忆类型应为 user/inference/external');
  const id = key(input.id);
  const date = new Date(text(input.date, '日期'));
  if (!Number.isFinite(date.getTime())) throw new Error('日期格式无效');
  const source = text(input.source, '来源');
  const value = text(input.text, '记忆正文');
  const relative = kind === 'external' ? `external/${key(input.workspaceId)}.md` : kind === 'user' ? 'user.md' : 'inferences.md';
  const file = path.join(home, 'memory', relative);
  if (existsSync(file) && readFileSync(file, 'utf8').includes(`<!-- ${id} -->`)) throw new Error('该记忆编号已存在');
  appendFileSync(file, `\n<!-- ${id} -->\n## ${date.toISOString()} | ${kind}\n来源：${source}\n\n${value}\n`);
  run('git', ['add', '--', relative], path.join(home, 'memory'));
  return { file, id, saved: true, committed: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, argument] = process.argv.slice(2);
    let result;
    if (command === 'init') result = init();
    else if (command === 'templates') result = readdirSync(path.join(home, 'templates')).filter(f => f.endsWith('.json')).map(f => template(f.slice(0, -5)));
    else if (['create', 'dispatch', 'remember'].includes(command)) result = ({ create, dispatch, remember })[command](json(argument));
    else throw new Error('用法：node workspace/workspace.mjs init | templates | create|dispatch|remember <input.json>');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.stdout?.toString() || error.message);
    console.error('写入或启动结果不明时，先核对工作间日志、项目记录和 Orca 回执，不自动重复执行。');
    process.exitCode = 1;
  }
}
