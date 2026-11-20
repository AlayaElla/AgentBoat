import { activeUserDataPath, clientPath as client, executable as orca, release } from '../coordinator/scripts/orca-cli.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync, appendFileSync, statSync, unlinkSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { initialize as initializeSkills } from './project-skills.mjs';
import { agentFlags, launchReceipt } from './agent-launch.mjs';
export { launchReceipt } from './agent-launch.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
const home = path.resolve(process.env.AGENTBOAT_HOME || path.join(os.homedir(), '.agentboat'));

const json = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const canonical = directory => {
  const resolved = realpathSync(directory);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const run = (executable, args, cwd = root, env = process.env, input) => execFileSync(executable, args, {
  cwd, env, input, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024,
});
function call(args, cwd) {
  const env = release ? { ...process.env, ORCA_USER_DATA_PATH: activeUserDataPath() } : process.env;
  const reply = JSON.parse(run(orca, [...args, '--environment', 'local', '--json'], cwd, env));
  if (!reply.ok) throw new Error(JSON.stringify(reply.error));
  return reply.result;
}
function bridge(operation, input) {
  let argument = input;
  if (typeof input === 'object') {
    argument = path.join(home, 'requests', `${randomUUID()}.json`);
    save(argument, input);
  }
  // Orca reads ORCA_ENVIRONMENT as a saved remote's name, so drop it to reach this machine's Orca.
  const { ORCA_ENVIRONMENT, ORCA_PAIRING_CODE, ...env } = process.env;
  const reply = JSON.parse(run(process.execPath, [client, operation, ...(argument ? [argument] : []), ...(operation === 'read' ? ['--full'] : [])], root, env));
  if (!reply.ok) throw new Error(JSON.stringify(reply.error));
  return reply.result.result;
}
function plugin(name, input) {
  const reply = JSON.parse(run(process.execPath, [client, '--workspace-request', name], root, process.env, JSON.stringify(input)));
  if (!reply.ok) throw new Error(JSON.stringify(reply.error));
  return reply.result.result;
}
function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少 ${label}`);
  return value;
}
function key(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('编号只允许字母、数字、下划线和连字符');
  return value;
}
export function template(id) {
  const value = json(path.join(home, 'templates', `${key(id)}.json`));
  for (const role of [value.mainAgent, ...Object.values(value.roles || {})]) {
    if (!['claude', 'codex'].includes(role?.agent)) throw new Error('代理应为 claude 或 codex');
    if (role.effort && !role.model) throw new Error('effort 需要 model');
    if (role.surface && !['chat', 'terminal'].includes(role.surface)) throw new Error('surface 应为 chat 或 terminal');
  }
  if (['design', 'code', 'review'].some(k => !value.roles?.[k])) throw new Error('缺少角色 design/code/review');
  if (!value.mainAgent || !['empty', 'existing', 'clone'].includes(value.source?.kind)) throw new Error('模板缺少 mainAgent 或 source.kind');
  text(value.firstMessage, 'firstMessage');
  return value;
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
  const sandbox = path.resolve(process.env.AGENTBOAT_SANDBOX || path.join(os.tmpdir(), 'agentboat-sandbox'));
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
  const catalog = bridge('projects');
  if (catalog.error) throw new Error(catalog.error);
  const refs = catalog.projects.filter(p => p.id === id);
  if (refs.length !== 1 || refs[0].hostId !== 'local') throw new Error('只支持 Orca 本机登记的项目，请核对完整编号和主机');
  testPath(refs[0].path);
  const { project, lead, runtimeError } = bridge('read', id);
  if (runtimeError || !project) throw new Error(runtimeError || '项目已从 Orca 移除');
  return { ...project, ref: refs[0], ...(lead?.takeover ? { pendingLead: lead.takeover } : {}) };
}
function journal(dir, requestId, input, reuse = false) {
  const file = path.join(home, dir, `${key(requestId)}.json`);
  let record = { requestId, at: new Date().toISOString(), input, stage: 'prepared' };
  let fresh = true;
  try { writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (reuse === true) return;
    if (reuse === 'resume-create') {
      fresh = false;
      record = json(file);
      if (!isDeepStrictEqual(record.input, input)) throw new Error('请求编号已用于不同的立项输入');
    } else throw new Error(`请求已执行或结果待核对，先读 ${file}，不要另起 agent`);
  }
  return { record, fresh, update: (stage, data = {}) => { Object.assign(record, data, { stage }); save(file, record); } };
}
function initIfNeeded() {
  if (!existsSync(path.join(home, 'requests')) || !existsSync(path.join(home, 'templates/code.json')) || !existsSync(path.join(home, 'memory/.git/index'))) init();
}
function launchProjectLead(j, t, project, goal) {
  const ref = project.ref;
  if (!ref.workspace) throw new Error('项目当前没有工作区，请先在 Orca 准备项目工作区');
  const context = { projectId: ref.id, repoId: ref.repoId, hostId: ref.hostId, path: ref.path, name: ref.name, roles: project.roles, template: t.id };
  j.update('launching', { context, mainAgent: t.mainAgent });
  const prompt = `${t.firstMessage}\n项目身份与分工：${JSON.stringify(context)}\n只在这个项目开启协作；读取 $orca-project-coordinator 和桥接说明。由你自己的会话创建 Run，再用 client.mjs read 现读版本并用 bind 绑定此 projectId，不能绑定工作间主 agent 或复用别的项目 Run。脚本路径：${client}。首轮完成绑定后简短回复项目编号与 Run；不要自行另起 agent。\n主人本次目标：${goal || '先开启项目协作，等待具体任务。'}`;
  const launched = call(['agent', 'launch', '--worktree', ref.workspace, ...agentFlags(t.mainAgent), '--prompt', prompt], ref.path);
  j.update('launch-returned', { launched });
  if (t.mainAgent.surface === 'chat' && launched.outcome?.kind !== 'structured') {
    throw new Error('Orca 未确认打开聊天会话，请核对启动回执，不要重复启动');
  }
  const handle = launchReceipt(launched);
  j.update('awaiting-project-binding', { handle });
  return handle;
}
function currentWorkspaceMain(runId) {
  const caller = process.env.ORCA_AGENT_SESSION_ID ? `orca_session_id:${process.env.ORCA_AGENT_SESSION_ID}` : process.env.ORCA_TERMINAL_HANDLE;
  const main = bridge('main-read');
  if (main.backup && ['active', 'handoff', 'returning'].includes(main.backup.phase)) main.session = { ...main.session, handle: main.backup.handle };
  if (!caller || !main.runId || main.session?.handle !== caller || (runId !== undefined && runId !== main.runId)) throw new Error('请在已绑定的工作间主 agent 会话中执行');
  return main;
}
const alreadyBound = p => ({ status: 'already-bound', projectName: p.ref.name, reason: '项目已绑定主 agent' });
const pendingSwitch = p => p.pendingLead && p.pendingLead.state !== 'expired' && ({
  status: 'awaiting-project-binding', projectName: p.ref.name, handle: p.pendingLead.target.handle || undefined, reused: true, reason: '项目正在等待主会话接管'
});
const launchSettings = ({ agent, model, effort, surface } = {}) => ({ agent, model, effort, surface });
const bindingWindow = 10 * 60_000;
function startProjectLead(p, templateId, goal, createJournal) {
  const id = p.ref.id, workspaceDirectory = canonical(p.ref.path);
  const dir = path.join('projects', 'auto', key(id)), logDir = path.join(home, dir);
  mkdirSync(logDir, { recursive: true });
  const attempts = readdirSync(logDir).flatMap(f => /^\d+\.json$/.test(f) ? [Number(f.slice(0, -5))] : []);
  const last = Math.max(0, ...attempts);
  if (last) {
    const file = path.join(logDir, `${last}.json`);
    let prior;
    try { prior = json(file); }
    catch { prior = { stage: 'needs-inspection', error: '启动日志未完整写入，请用原请求核对' }; }
    const at = Date.parse(prior.at) || statSync(file).mtimeMs;
    if (prior.stage !== 'delegated-to-takeover' && Date.now() - at < bindingWindow) {
      createJournal?.update(prior.stage, { context: prior.context, launched: prior.launched });
      return { status: prior.stage === 'needs-inspection' ? 'needs-inspection' : 'awaiting-project-binding',
        projectName: p.ref.name, handle: prior.handle, ...launchSettings(prior.mainAgent), reused: true, ...(prior.error ? { reason: prior.error } : {}) };
    }
  }
  const j = journal(dir, String(last + 1), { projectId: id, template: templateId }, true);
  if (!j) return { status: 'awaiting-project-binding', projectName: p.ref.name, reused: true, reason: '启动请求已在进行' };
  try {
    initIfNeeded();
    const latest = project(id);
    if (latest.runId) { j.update('already-bound'); return alreadyBound(latest); }
    const pending = pendingSwitch(latest);
    if (pending) { j.update('delegated-to-takeover', { handle: pending.handle }); return pending; }
    if (latest.ref.repoId !== p.ref.repoId || latest.ref.workspace !== p.ref.workspace || canonical(latest.ref.path) !== workspaceDirectory) throw new Error('项目身份或工作区已变化，请核对后再操作');
    const t = template(templateId), handle = launchProjectLead(j, t, latest, goal);
    createJournal?.update(j.record.stage, { context: j.record.context, launched: j.record.launched });
    return { status: j.record.stage, projectName: latest.ref.name, handle, ...launchSettings(t.mainAgent), reused: false };
  } catch (error) { j.update('needs-inspection', { error: error.message }); throw error; }
}
export function autoProjectLead(id, runId, templateId = 'code') {
  const p = project(id);
  if (p.runId) return alreadyBound(p);
  const pending = pendingSwitch(p);
  if (pending) return pending;
  const main = currentWorkspaceMain(runId);
  if (!main.session.path || !existsSync(main.session.path)) throw new Error('无法核对工作间主 agent 的目录，请核对当前绑定');
  const repos = call(['repo', 'list']).repos.filter(r => (r.executionHostId ?? (r.connectionId ? 'ssh' : 'local')) === 'local');
  const repo = repos.find(r => r.id === p.ref.repoId);
  if (!repo) throw new Error('只支持 Orca 本机登记的项目，请核对完整编号和主机');
  const rootDirectory = canonical(repo.path), workspaceDirectory = canonical(p.ref.path), mainDirectory = canonical(main.session.path);
  if ([rootDirectory, workspaceDirectory].includes(mainDirectory)) throw new Error('这是工作间主 agent 自己的目录，不能自动开项目主会话');
  if (repos.some(r => r.id !== repo.id && existsSync(r.path) && [rootDirectory, workspaceDirectory].includes(canonical(r.path)))) throw new Error('同一路径在 Orca 重复登记，请先在 Orca 删除多余登记');
  if (!p.ref.workspace) throw new Error('项目当前没有工作区，请先在 Orca 准备项目工作区');
  testPath(rootDirectory); testPath(workspaceDirectory);
  return startProjectLead(p, templateId);
}
export function create(input) {
  initIfNeeded();
  const templateId = input.template || 'code', t = template(templateId);
  const destination = path.resolve(text(input.path, '项目完整路径'));
  if (!path.isAbsolute(input.path)) throw new Error('项目路径必须为绝对路径');
  testPath(destination);
  const source = { ...t.source, ...input.source };
  if (!['empty', 'existing', 'clone'].includes(source.kind)) throw new Error('source.kind 应为 empty/existing/clone');
  const name = text(input.name, '项目名');
  if (process.env.AGENTBOAT_TEST_ONLY === '1' && !name.includes('agentboat-demo')) throw new Error('测试项目名必须包含 agentboat-demo');
  const lock = path.join(home, 'projects', `${key(input.requestId)}.lock`);
  try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`立项请求正在处理，请先核对 ${lock}`);
  }
  let j;
  try {
    j = journal('projects', input.requestId, input, 'resume-create');
    if (['already-bound', 'awaiting-project-binding'].includes(j.record.stage)) return j.record;
    const resume = !j.fresh;
    // An interrupted prepared journal cannot prove that repo add never happened.
    if (resume && !j.record.registered?.repo?.id)
      throw new Error('目录登记结果待核对，请查看原立项日志和 Orca 项目列表');
    if (!resume) {
      if (source.kind === 'empty') mkdirSync(destination, { recursive: false });
      if (source.kind === 'clone') run('git', ['clone', '--', text(source.url, '克隆地址'), destination]);
      if (!existsSync(destination)) throw new Error('已有项目目录不存在');
      testPath(realpathSync(destination));
      initializeSkills(destination);
      const kind = existsSync(path.join(destination, '.git')) ? 'git' : 'folder';
      const registered = call(['repo', 'add', '--path', destination, '--kind', kind], destination);
      j.update('registered', { registered });
    }
    testPath(realpathSync(destination));
    const repo = call(['repo', 'show', '--repo', `path:${destination}`], destination).repo;
    if (!repo?.id || repo.id !== j.record.registered.repo.id || canonical(repo.path) !== canonical(destination))
      throw new Error('登记目录或仓库编号与原回执不一致');
    const catalog = bridge('projects');
    if (catalog.error) throw new Error(catalog.error);
    const refs = catalog.projects.filter(p => p.repoId === repo.id && p.hostId === 'local' && path.relative(destination, p.path) === '');
    if (refs.length !== 1) throw new Error('插件未唯一识别登记项目，请核对 Orca 项目与插件列表');
    const ref = refs[0];
    const { project: current, runtimeError } = bridge('read', ref.id);
    if (runtimeError || !current) throw new Error(runtimeError || '项目已从 Orca 移除');
    if (j.record.projectId && j.record.projectId !== ref.id) throw new Error('项目编号与原立项记录不一致');
    const roles = Object.fromEntries(Object.entries(t.roles).map(([k, v]) => [k, v.agent]));
    if (current.runId) {
      if (!resume) throw new Error('已有项目主 agent，不能再次启动或覆盖绑定');
      j.update('already-bound', { ...alreadyBound({ ref }), runId: current.runId, projectId: ref.id,
        rolesMatchTemplate: isDeepStrictEqual(current.roles, roles), error: undefined });
      return j.record;
    }
    const base = repo.kind === 'git' ? path.join(path.dirname(destination), `${path.basename(destination)}-worktrees`) : undefined;
    if (resume) {
      if (ref.name !== name || (!j.record.projectId && base && (!repo.worktreeBasePath || path.relative(base, repo.worktreeBasePath))))
        throw new Error('请在 Orca 核对并完成原请求的项目显示名和工作树目录设置，再用原请求续做');
      const auto = path.join(home, 'projects', 'auto', key(ref.id));
      if (j.record.launchAttempted || j.record.launched || (existsSync(auto) && readdirSync(auto).some(f => /^\d+\.json$/.test(f))))
        throw new Error('已有启动记录，请核对并绑定已有项目主会话，再用原请求收尾');
    } else {
      call(['project', 'setup-update', '--setup', repo.id, '--host', 'local', '--display-name', name,
        ...(base ? ['--worktree-base-path', base] : [])], destination);
    }
    j.update('settings', { projectId: ref.id, error: undefined });
    if (!resume || !isDeepStrictEqual(current.roles, roles)) {
      const settings = resume ? current : bridge('read', ref.id).project;
      if (settings.runId) throw new Error('项目主会话已绑定，请用原请求核对并收尾');
      plugin('project.settings', { projectId: ref.id, revision: settings.revision, roles, feishu: settings.feishu });
    }
    const latest = project(ref.id);
    if (latest.ref.repoId !== repo.id || canonical(latest.ref.path) !== canonical(destination)) throw new Error('项目身份已变化');
    j.update('starting', { launchAttempted: true });
    const lead = startProjectLead(latest, templateId, input.goal, j);
    j.update(lead.status, lead);
    return j.record;
  } catch (error) { j?.update('needs-inspection', { error: error.message }); throw error; }
  finally { unlinkSync(lock); }
}
function submitDispatch(p, requestId, task) {
  const submit = current => bridge('submit', { projectId: p.ref.id, revision: current.revision, requestId, task });
  try { return submit(p); }
  catch (error) {
    let receipt;
    try { receipt = JSON.parse(error.stderr?.toString()).error; } catch { throw error; }
    const code = receipt?.code === 'plugin_request_failed' ? receipt.data?.requestCode : receipt?.code;
    if (code !== 'invalid_request' || !receipt.message?.endsWith('项目已更新，请刷新后再提交')) throw error;
    const latest = project(p.ref.id), target = value => value.tasks.find(t => t.id === task.id);
    if (JSON.stringify(target(latest)) !== JSON.stringify(target(p))) throw error;
    return submit(latest);
  }
}
export function dispatch(input) {
  let p = project(text(input.projectId, 'projectId'));
  const goal = text(input.text, '用户原话 text');
  const source = text(input.source, '来源（会话和消息编号）');
  const main = currentWorkspaceMain(), sender = main.session.handle;
  initIfNeeded();
  const templateId = input.template || 'code', t = template(templateId);
  const role = input.role || 'code';
  if (!t.roles[role]) throw new Error('模板中没有该角色');
  const repo = call(['repo', 'show', '--repo', `id:${p.ref.repoId}`]).repo;
  if (repo.kind === 'folder') throw new Error('独立工作树需要 Git 仓库；请先由主人准备已有提交的仓库');
  run('git', ['rev-parse', '--verify', 'HEAD'], p.ref.path);
  const name = key(input.name);
  testPath(path.join(repo.worktreeBasePath || path.dirname(p.ref.path), name));
  const j = journal('assignments', input.requestId, input);
  try {
    const autoLaunch = p.runId ? alreadyBound(p) : autoProjectLead(p.ref.id, main.runId, templateId);
    if (autoLaunch.status === 'needs-inspection') throw new Error(autoLaunch.reason || '项目主会话启动结果待核对');
    j.update('project-lead', { autoLaunch });
    p = project(p.ref.id);
    const evidenceDir = path.join(p.ref.path, '.agentboat/assignments');
    mkdirSync(evidenceDir, { recursive: true });
    const provenance = path.join(evidenceDir, `${input.requestId}-source.md`);
    writeFileSync(provenance, `# 用户直接派活\n\n日期：${j.record.at}\n来源：${source}\n调用会话：${sender}\n项目：${p.ref.id}\n\n用户原话：\n\n${goal}\n`, { flag: 'wx' });
    const taskId = `direct-${input.requestId}`;
    const artifact = { id: `${taskId}-source`, label: '直接派活来源与用户原话', url: provenance, version: 'v1' };
    submitDispatch(p, `${input.requestId}-record`, {
      id: taskId, title: input.title || name, goal, phase: 'working', progress: '已登记直接派活，尚未确认启动', artifacts: [artifact],
    });
    j.update('launching', { taskId, sourcePath: provenance, sender });
    const prompt = `项目直接任务：${goal}\n来源：${source}；项目编号：${p.ref.id}；任务编号：${taskId}。只做此任务，保留他人改动，不再派子任务。完成后用 node ${JSON.stringify(client)} read ${p.ref.id} 核对项目当前绑定的 runId，再从自己的会话用 orca orchestration send --to run:<runId> 回报成果与验证边界。尚未绑定时先保存回报，等项目主会话绑定后送达。不要改项目或工作间主 Run 的绑定。`;
    const launched = call(['worktree', 'create', '--repo', `id:${p.ref.repoId}`, '--name', name, '--no-parent',
      '--setup', 'skip', ...agentFlags(t.roles[role]), '--prompt', prompt], p.ref.path);
    j.update('launch-returned', { launched });
    const handle = launchReceipt(launched.launch);
    const launchFile = path.join(evidenceDir, `${input.requestId}-launch.json`);
    writeFileSync(launchFile, JSON.stringify(launched, null, 2) + '\n', { flag: 'wx' });
    const fresh = project(p.ref.id);
    submitDispatch(fresh, `${input.requestId}-receipt`, {
      id: taskId, title: input.title || name, goal, phase: 'working',
      progress: `已启动 ${t.roles[role].agent}，提示词已送达；agent ${handle}。来源：${source}。启动回执不等于实际开工或完成。`,
      artifacts: [{ id: `${taskId}-launch`, label: 'Orca 派活回执', url: launchFile, version: 'v1' }],
    });
    j.update('notifying', { handle });
    const requestId = `${input.requestId}-notice`;
    const notified = plugin('workspace.message', { projectId: p.ref.id, requestId, runId: main.runId,
      text: `直接派活「${name}」已启动。请跟进项目任务 ${taskId}。\n执行 agent：${handle}\n任务记录含来源原话与 Orca 启动回执，请以实际成果为准。` });
    j.update('notification-recorded', { notification: { requestId, status: notified.queued ? 'queued' : 'recorded', ...(notified.queued ? { message: notified.queued } : {}) } });
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

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
