import { activeUserDataPath, executable, linkCurrentRelease, release, stableClientPath } from './orca-cli.mjs';
import { installedRequest } from './cli-bridge.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { writeMainRoleCards } from './main-role-card.mjs';

const [operation, argument, flag, taskId, extra] = process.argv.slice(2);
const brief = operation === 'overview' && argument === '--brief';
const readOptions = operation === 'read' ? parseArgs({ args: process.argv.slice(4), options: { full: { type: 'boolean' }, task: { type: 'string' } } }).values : {};
if (operation === 'overview' && (argument && !brief || flag)) throw new Error('用法：node client.mjs overview [--brief]');
if (operation === 'read' && (!argument || argument.startsWith('--') || readOptions.task === '')) throw new Error('用法：node client.mjs read <projectId> [--task <taskId>] [--full]');
const history = operation === 'lead-history';
const historyArgs = history ? process.argv.slice(3) : [];
const historyProject = historyArgs[0] && historyArgs[0] !== '--end' ? historyArgs.shift() : undefined;
if (historyArgs.length && (historyArgs.length !== 2 || historyArgs[0] !== '--end' || !Number.isSafeInteger(Number(historyArgs[1])) || Number(historyArgs[1]) < 1))
  throw new Error('用法：lead-history [projectId] [--end <上一页的 previousEnd>]');
const leadBind = operation === 'project-lead-bind', leadSwitch = operation === 'project-lead-switch';
const leadActions = ['lead-take', 'lead-ready', 'lead-handoff', 'lead-resume'];
const leadAction = leadActions.includes(operation);
const allowed = [...leadActions, 'lead-history', 'projects', 'overview', 'main-read', 'main-bind', 'project-lead', 'project-lead-switch', 'project-lead-bind', 'message', 'read', 'bind', 'submit', 'feedback', 'feishu-reply', 'links-read', 'links-refresh', 'links-invite', 'links-cancel-invite', 'links-join', 'links-configure', 'links-rename', 'links-share', 'links-relate', 'links-revoke', 'links-send', 'hide', 'restore', 'delete', 'main-targets', 'connections', 'connection-read', 'connection-check', 'connection-send', 'connection-reply'];
if (!allowed.includes(operation)) throw new Error('用法：node client.mjs projects|overview|main-read|main-targets|connections | connection-read|connection-check <名字> | main-bind|project-lead-switch|project-lead-bind|connection-send|connection-reply|links-send < stdin | read|project-lead <projectId> | bind|submit|message|feedback|feishu-reply|hide|restore|delete <input.json>');
const target = fileURLToPath(new URL('../plugin/', import.meta.url));
const caller = process.env.ORCA_AGENT_SESSION_ID ? `orca_session_id:${process.env.ORCA_AGENT_SESSION_ID}` : process.env.ORCA_TERMINAL_HANDLE;
const profileEnv = release ? { ...process.env, ORCA_USER_DATA_PATH: activeUserDataPath() } : process.env;
const currentRun = () => JSON.parse(execFileSync(executable, ['orchestration', 'run-current', '--environment', 'local', '--json', '--full'], { encoding: 'utf8', windowsHide: true, env: profileEnv, timeout: 25000, maxBuffer: 1024 * 1024 }));

let stdin;
function readInput(file) {
  const raw = file === 0 ? (stdin = readFileSync(0, 'utf8')) : readFileSync(file, 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}
const input = history ? { projectId: historyProject, end: historyArgs.length ? Number(historyArgs[1]) : undefined } : leadAction ? { runId: argument, action: operation.slice(5), caller, token: flag, ...(taskId ? { note: taskId } : {}) } : operation === 'connections' ? { operation: 'read' } : operation.startsWith('connection-') ? { ...(['connection-read','connection-check'].includes(operation) ? { name: argument } : readInput(0)), operation: operation.slice(11) } : operation.startsWith('links-') ? { ...(['links-join', 'links-configure', 'links-rename', 'links-share', 'links-relate', 'links-revoke', 'links-send'].includes(operation) ? readInput(0) : {}), operation: operation.slice(6) } : ['projects', 'overview'].includes(operation) ? null : operation === 'main-read' ? { operation: 'read' } : operation === 'read'
  ? { operation, projectId: argument, taskId: readOptions.task }
  : operation === 'project-lead' ? { projectId: argument }
  : operation === 'main-targets' ? null
  : { ...readInput(operation === 'main-bind' || leadBind || leadSwitch ? 0 : argument), ...(['message', 'feedback', 'feishu-reply', 'project-lead-switch'].includes(operation) ? {} : { operation: operation === 'main-bind' || leadBind ? 'bind' : operation }) };
if (operation === 'main-bind' || leadBind || leadSwitch) {
  if (argument && (operation !== 'main-bind' || argument !== '--check')) throw new Error('请从标准输入传入绑定或切换请求');
  if (!caller) throw new Error('请在对应的 Orca 会话中调用该命令');
  // Chat identity is only declarable in the session's own process; never pass --from here.
  let current;
  try {
    current = currentRun();
  } catch { throw new Error('无法读取当前会话的 Run；请在目标 Orca 会话重试 run-current，勿填写其他会话身份'); }
  if (!current.ok || !current.result?.run?.id) throw new Error('当前会话没有协调 Run；请先在本会话运行 orca orchestration run-create');
  if (leadSwitch) input.runId = current.result.run.id;
  else { input.currentRunId = current.result.run.id; input.caller = caller; }
  if (leadBind && !input.token) throw new Error('接管项目主会话需要本次接管凭据');
  if (argument === '--check') input.checkOnly = true;
}
const delegatedFeedback = operation === 'feedback' && Object.hasOwn(input, 'id');
if (!delegatedFeedback && ['bind', 'submit', 'feedback', 'hide', 'restore', 'delete'].includes(operation)) {
  delete input.caller;
  if (caller) {
    input.caller = caller;
    if (!input.runId) try { const current = currentRun(); if (current.ok && current.result?.run?.id) input.runId = current.result.run.id; } catch { /* Optional display identity must not prevent a project write. */ }
  }
}
if (leadAction && (!caller || !argument || !flag || extra || (operation === 'lead-handoff') !== !!taskId)) throw new Error('请在收到通知的 Orca 会话中执行原命令，交接说明用引号括起');
const name = history ? 'lead.history' : leadAction ? 'lead.control' : operation === 'connections' || operation.startsWith('connection-') ? 'workspace.connections' : operation.startsWith('links-') ? 'workspace.links' : operation === 'projects' ? 'projects.list' : operation === 'overview' ? 'workspace.overview'
  : operation === 'feishu-reply' ? 'workspace.reply' : operation.startsWith('main-') ? 'workspace.agent' : operation === 'message' ? 'workspace.message' : delegatedFeedback ? 'workspace.linkFeedback' : operation === 'feedback' ? 'project.feedback' : operation === 'project-lead' ? 'project.lead' : leadSwitch ? 'workspace.projectLead' : 'project.agent';
const maintenance = ['hide', 'restore', 'delete'].includes(operation);
const args = ['plugin', 'dev', 'request', target, operation === 'main-targets' ? 'workspace.agent.targets' : maintenance ? operation === 'delete' ? 'project.delete' : 'project.visibility' : name, '--json'];
if (maintenance) { delete input.operation; if (operation !== 'delete') input.hidden = operation === 'hide'; }
if (operation === 'message') args.push('--environment', 'local');
if (input) args.push('--data', JSON.stringify(input));
try {
  const request = async () => release ? JSON.stringify(await installedRequest(args[4], input)) + '\n'
    : execFileSync(executable, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 40000, maxBuffer: 1024 * 1024 });
  let stdout = await request();
  if (leadAction) {
    const first = JSON.parse(stdout);
    const next = first.result?.result;
    if (first.ok && typeof next?.park === 'string' && operation === 'lead-handoff') {
      const own = currentRun().result?.run;
      const parked = own?.objective === next.park ? own : own?.id === argument ? JSON.parse(execFileSync(executable,
        ['orchestration', 'run-create', '--objective', next.park, '--environment', 'local', '--json', '--full'],
        { encoding: 'utf8', windowsHide: true, env: profileEnv, timeout: 25000 })).result?.run : undefined;
      if (!parked?.id || parked.objective !== next.park) throw new Error('未确认备用会话的待命 Run');
      input.standbyRunId = parked.id;
      args[args.indexOf('--data') + 1] = JSON.stringify(input);
      stdout = await request();
    }
    if (argument && first.ok && (next?.useRun === argument || next?.checkRun === argument)) {
      let used;
      if (next.useRun) {
        const reply = JSON.parse(execFileSync(executable, ['orchestration', 'run-use', '--id', argument, '--environment', 'local', '--json', '--full'], { encoding: 'utf8', windowsHide: true, env: profileEnv, timeout: 25000 }));
        used = reply.result?.run;
        if (!reply.ok || used?.id !== argument) throw new Error('Run 接管回执待核对');
      }
      const current = currentRun(), run = current.result?.run;
      if (!current.ok || run?.id !== argument || !Number.isSafeInteger(run.consumer_generation) ||
        (run.coordinator_handle !== caller && !(process.env.ORCA_AGENT_SESSION_ID && run.coordinator_handle === null)) ||
        (used && (used.consumer_generation !== run.consumer_generation || used.coordinator_handle !== run.coordinator_handle))) throw new Error('当前会话的 Run 接管回执不符');
      input.currentRunId = run.id;
      input.generation = run.consumer_generation;
      input.confirm = true;
      args[args.indexOf('--data') + 1] = JSON.stringify(input);
      stdout = await request();
    }
  }
  const reply = JSON.parse(stdout), view = reply.result?.result;
  if (release && !reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
  const success = reply.ok && reply.result?.ok !== false;
  let submission;
  if (operation === 'submit' && success) {
    const project = view?.project;
    const task = project?.tasks?.find(t => t.id === input.task?.id) ?? view?.submitted ?? view?.task;
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if (!project?.ref || project.ref.id !== input.projectId || !task || task.id !== input.task?.id ||
        !project.requests?.some(r => r.id === input.requestId && r.fingerprint === fingerprint)) {
      process.stderr.write(`提交回执待核对，请用 read ${JSON.stringify(input.projectId)} --task ${JSON.stringify(input.task?.id)} 核对。\n`);
      process.exit(1);
    }
    submission = { projectId: project.ref.id, revision: project.revision, requestId: input.requestId, taskId: task.id, phase: task.phase,
      pendingAcceptance: task.pendingAcceptance ?? task.acceptance?.some(a => a.status === 'pending') ?? false,
      pendingDecision: task.pendingDecision ?? task.decisions?.some(d => d.answer === undefined) ?? false, submittedAt: task.submittedAt };
  }
  if (success && view) {
    const project = view.project;
    if (project && ['submit', 'feedback', 'message', 'bind', 'project-lead-bind', 'hide', 'restore'].includes(operation)) {
      const { ref, revision, runId } = project;
      const receipt = { project: { ref, revision, runId }, projectId: ref.id, revision };
      if (operation === 'message') {
        receipt.queued = view.queued ?? false;
        if (view.queued) {
          try {
            const { autoProjectLead } = await import('../../workspace/workspace.mjs');
            receipt.autoLaunch = autoProjectLead(input.projectId, input.runId);
          } catch (error) {
            receipt.autoLaunch = { status: 'not-confirmed', projectName: ref.name, reason: error.message };
          }
        } else receipt.autoLaunch = { status: 'already-bound', projectName: ref.name, reason: '项目已绑定主 agent' };
      } else if (operation !== 'submit' && operation !== 'feedback') {
        receipt.hidden = !!project.hidden;
        receipt.bound = !!runId;
        receipt.session = view.lead?.session;
      }
      reply.result.result = receipt;
    } else if (operation === 'links-send') {
      const peer = view.peers.find(p => p.id === input.id.trim());
      reply.result.result = { id: input.id, requestId: input.requestId, revision: view.revision, pendingMessages: peer?.pendingMessages ?? null };
    } else if (operation === 'feishu-reply') {
      const delivery = view.deliveries.find(d => d.id === `agent-reply:${input.requestId.trim()}`);
      reply.result.result = { eventId: input.eventId, requestId: input.requestId, revision: view.revision, state: delivery?.state ?? 'uncertain', error: delivery?.error };
    } else if (operation === 'connection-send' || operation === 'connection-reply') {
      const entry = view.a2a.entries.find(e => operation === 'connection-send'
        ? e.direction === 'outgoing' && e.id === input.requestId.trim()
        : e.direction === 'incoming' && e.task.id === input.id.trim() && e.replyId === input.requestId.trim());
      reply.result.result = { requestId: input.requestId, revision: view.a2a.revision, taskId: entry?.task.id, contextId: entry?.task.contextId,
        state: entry?.task.status.state ?? 'uncertain', error: entry?.error };
    } else if (brief) {
      const { attention, questions, reports, projects, error } = view;
      reply.result.result = { attention: attention.map(({ fingerprint, ...item }) => item), questions, reports,
        projects: projects.map(({ ref, counts, revision, bound }) => ({ id: ref.id, name: ref.name, counts, revision, bound })), error };
    } else if (readOptions.task) {
      const task = view.task ?? project?.tasks.find(task => task.id === input.taskId);
      if (!task) {
        process.stderr.write(`项目 ${argument} 中找不到任务 ${input.taskId}。\n`);
        process.exit(1);
      }
      if (!readOptions.full) {
        const recent = 3;
        const { artifactVersions } = await import(release ? '../../src/artifact-versions.mjs' : '../src/artifact-versions.mjs');
        const keep = new Set(task.acceptance.filter(a => a.status !== 'discarded').flatMap(a => a.artifactIds));
        for (const [latest] of artifactVersions([task]).slice(0, recent)) keep.add(latest.artifact.id);
        const artifacts = task.artifacts.filter(a => keep.has(a.id));
        task.omittedArtifacts = task.artifacts.length - artifacts.length;
        task.artifacts = artifacts;
        task.omittedExecutions = Math.max(0, task.executions.length - recent);
        task.executions = task.executions.slice(-recent);
      }
      reply.result.result = { projectId: project.ref.id, revision: project.revision, task, ...(view.archiveStatus ? { archiveStatus: view.archiveStatus } : {}) };
    } else {
      if (operation === 'overview') for (const p of view.projects) p.agents = p.agents.length;
      for (const binding of [view, view.binding, view.workspace, view.lead, project]) {
        const backup = binding?.backup;
        if (Array.isArray(backup?.history)) {
          backup.historyTotal = backup.history.length;
          backup.history = backup.history.slice(-3);
        }
      }
      if (project) {
        delete project.archive;
        for (const task of project.tasks ?? []) {
          for (const item of [...task.acceptance ?? [], ...task.decisions ?? []]) delete item.archivedHistory;
        }
      }
      if (operation === 'read' && !readOptions.full && project) {
        const { taskState } = await import(release ? '../../src/task-state.mjs' : '../src/task-state.mjs');
        const { ref: { id, name, path }, revision, runId, roles } = project;
        const tasks = project.tasks.map(t => ({ id: t.id, title: t.title, state: taskState(t), updatedAt: t.updatedAt,
          pendingAcceptance: t.acceptance.filter(a => a.status === 'pending').map(a => a.id),
          pendingDecisions: t.decisions.filter(d => d.answer === undefined).map(d => d.id) }));
        const events = project.events.filter(e => !e.taskId).map(({ id, source, receivedAt, text }) => ({ id, source, receivedAt, text: text.slice(0, 120) }));
        reply.result.result = { project: { ref: { id, name, path }, revision, runId, roles, tasks, events }, lead: view.lead,
          runtimeError: view.runtimeError, hint: `详情用 read ${id} --task <任务>，全量用 --full。` };
      }
      if (operation === 'main-bind' && !input.checkOnly && view.runId === input.runId && view.session?.handle === caller) {
        try { writeMainRoleCards(view.session.path); }
        catch (error) { view.roleCardWarning = `绑定已成功，角色卡未完整写入：${error.message}。修正后用原请求重试。`; }
      }
    }
    if (operation === 'feedback' && (project || view.state === 'submitted')) {
      const receipt = reply.result.result;
      receipt.projectId = input.projectId;
      receipt.items = input.items.map(({ taskId, kind, itemId, result }) => ({
        taskId, kind, itemId, status: result || (kind === 'decision' ? 'answered' : 'replied')
      }));
    }
  }
  const output = submission ? { submission, ok: true, ...reply } : reply;
  process.stdout.write(JSON.stringify(output, null, operation === 'main-bind' && !input.checkOnly ? 2 : undefined) + '\n');
} catch (e) {
  let error = e;
  for (const output of [e.stdout, e.stderr]) {
    if (!output?.length) continue;
    try { const reply = JSON.parse(output); if (reply.error) { error = reply.error; break; } } catch { /* Keep the CLI diagnostic. */ }
  }
  process.exitCode = 1;
  if (error.code === 'plugin_not_found') {
    const fixed = stableClientPath();
    try {
      if (!release && linkCurrentRelease()) {
        console.error(`请改用固定入口 ${fixed}`);
        const child = spawnSync(process.execPath, [fixed, ...process.argv.slice(2)], {
          input: stdin, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true
        });
        if (child.error) throw child.error;
        process.exitCode = child.status ?? 1;
      } else console.error(`插件可能没有安装或启用。固定入口：${fixed}`);
    } catch (cause) { console.error(`插件可能没有安装或启用。固定入口：${fixed}。${cause.message}`); }
  } else if (['approval_required', 'approval_stale'].includes(error?.code) ||
    ['unavailable', 'consent_required'].includes(error?.data?.requestCode) ||
    error?.code === 'invalid_argument' && /is not approved and enabled, so its worker cannot run/i.test(error.message))
    process.stderr.write('插件正在重载或等待批准，稍后重试。写入结果待核对时，请沿用原请求编号。\n');
  else if (e.stdout || e.stderr) process.stderr.write(e.stdout || e.stderr);
  else process.stderr.write(release ? e.message + '\n' : 'Orca 请求未取得回执，请先读项目记录核对，勿直接重复写入。\n');
}
