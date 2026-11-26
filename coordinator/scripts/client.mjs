import { activeUserDataPath, executable, ownerMessages, release } from './orca-cli.mjs';
import { installedRequest } from './cli-bridge.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { writeMainRoleCards } from './main-role-card.mjs';

const [operation, argument, flag, taskId, extra] = process.argv.slice(2);
const sourceList = operation === 'owner-messages';
if (sourceList && argument) throw new Error('用法：owner-messages');
const replyDecision = operation === 'reply-decision';
if (replyDecision && (!argument || !flag || !taskId || extra)) throw new Error('用法：reply-decision <项目编号> <任务编号> <决定编号>');
// Internal callers pass handler data on stdin. The workspace hook excludes option-prefixed commands.
const internal = operation === '--workspace-request' && ['project.settings', 'project.lead', 'workspace.message', 'workspace.connections'].includes(argument) && !flag;
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
const allowed = [...leadActions, 'lead-history', 'projects', 'overview', 'main-read', 'main-bind', 'project-lead', 'project-lead-switch', 'project-lead-bind', 'message', 'read', 'bind', 'submit', 'feedback', 'reply-decision', 'owner-messages', 'worker-feedback', 'feishu-reply', 'links-read', 'links-refresh', 'links-invite', 'links-cancel-invite', 'links-join', 'links-configure', 'links-rename', 'links-share', 'links-relate', 'links-revoke', 'links-send', 'hide', 'restore', 'delete', 'main-targets', 'connections', 'connection-read', 'connection-check', 'connection-send', 'connection-reply'];
if (!internal && !allowed.includes(operation)) throw new Error('用法：node client.mjs projects|overview|main-read|main-targets|connections | connection-read|connection-check <名字> | main-bind|project-lead-switch|project-lead-bind|connection-send|connection-reply|links-send < stdin | read|project-lead <projectId> | bind|submit|message|feedback|feishu-reply|hide|restore|delete <input.json>');
const caller = process.env.ORCA_AGENT_SESSION_ID ? `orca_session_id:${process.env.ORCA_AGENT_SESSION_ID}` : process.env.ORCA_TERMINAL_HANDLE;
const profileEnv = release ? { ...process.env, ORCA_USER_DATA_PATH: activeUserDataPath() } : process.env;
const currentRun = () => JSON.parse(execFileSync(executable, ['orchestration', 'run-current', '--environment', 'local', '--json', '--full'], { encoding: 'utf8', windowsHide: true, env: profileEnv, timeout: 25000, maxBuffer: 1024 * 1024 }));

function readInput(file) {
  const raw = readFileSync(file, 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}
const input = internal ? readInput(0) : history ? { projectId: historyProject, end: historyArgs.length ? Number(historyArgs[1]) : undefined } : leadAction ? { runId: argument, action: operation.slice(5), caller, token: flag, ...(taskId ? { note: taskId } : {}) } : operation === 'connections' ? { operation: 'read' } : operation.startsWith('connection-') ? { ...(['connection-read','connection-check'].includes(operation) ? { name: argument } : readInput(0)), operation: operation.slice(11) } : operation.startsWith('links-') ? { ...(['links-join', 'links-configure', 'links-rename', 'links-share', 'links-relate', 'links-revoke', 'links-send'].includes(operation) ? readInput(0) : {}), operation: operation.slice(6) } : ['projects', 'overview'].includes(operation) ? null : operation === 'main-read' ? { operation: 'read' } : operation === 'read'
  ? { operation, projectId: argument, taskId: readOptions.task }
  : replyDecision ? { operation: 'read', projectId: argument, taskId: flag }
  : operation === 'project-lead' ? { projectId: argument }
  : operation === 'main-targets' || sourceList ? null
  : { ...readInput(operation === 'main-bind' || leadBind || leadSwitch ? 0 : argument), ...(['message', 'feedback', 'worker-feedback', 'feishu-reply', 'project-lead-switch'].includes(operation) ? {} : { operation: operation === 'main-bind' || leadBind ? 'bind' : operation }) };
if (internal && argument === 'project.lead' && (input.mode !== 'new' || input.startOnly !== true)) throw new Error('此入口仅用于自动启动未绑定的项目主会话');
if (leadSwitch && !['existing', 'new', 'promote', 'cancel'].includes(input.mode)) throw new Error('请选择 existing、new、promote 或 cancel');
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
const ownerFeedback = !delegatedFeedback && operation === 'feedback' && Object.hasOwn(input, 'ownerSource');
const ownerRelay = operation === 'message' && Object.hasOwn(input, 'ownerDecision');
const workerQuestion = operation === 'submit' && Array.isArray(input.task?.decisions) && input.task.decisions.some(d => d?.orcaQuestionId !== undefined);
if (ownerFeedback || ownerRelay || workerQuestion || operation === 'worker-feedback') {
  if (!caller) throw new Error('请在收到反馈的 Orca 会话中执行此命令');
  input.caller = caller;
  if (ownerFeedback || ownerRelay || workerQuestion) {
    const current = currentRun();
    if (!current.ok || !current.result?.run?.id) throw new Error('未确认当前主会话的 Run');
    input.runId = current.result.run.id;
  }
} else if (!delegatedFeedback && ['bind', 'submit', 'feedback', 'hide', 'restore', 'delete'].includes(operation)) {
  delete input.caller;
  if (caller) {
    input.caller = caller;
    if (!input.runId) try { const current = currentRun(); if (current.ok && current.result?.run?.id) input.runId = current.result.run.id; } catch { /* Optional display identity must not prevent a project write. */ }
  }
}
if (leadAction && (!caller || !argument || !flag || extra || (operation === 'lead-handoff') !== !!taskId)) throw new Error('请在收到通知的 Orca 会话中执行原命令，交接说明用引号括起');
const name = internal ? argument : history ? 'lead.history' : leadAction ? 'lead.control' : operation === 'connections' || operation.startsWith('connection-') ? 'workspace.connections' : operation.startsWith('links-') ? 'workspace.links' : operation === 'projects' ? 'projects.list' : operation === 'overview' ? 'workspace.overview'
  : operation === 'feishu-reply' ? 'workspace.reply' : operation.startsWith('main-') ? 'workspace.agent' : operation === 'message' ? 'workspace.message' : delegatedFeedback ? 'workspace.linkFeedback' : operation === 'feedback' ? 'project.feedback' : operation === 'worker-feedback' ? 'project.workerFeedback' : operation === 'project-lead' ? 'project.lead' : leadSwitch ? 'workspace.projectLead' : 'project.agent';
const maintenance = ['hide', 'restore', 'delete'].includes(operation);
const handler = operation === 'main-targets' ? 'workspace.agent.targets' : maintenance ? operation === 'delete' ? 'project.delete' : 'project.visibility' : name;
if (maintenance) { delete input.operation; if (operation !== 'delete') input.hidden = operation === 'hide'; }
try {
  const request = () => installedRequest(handler, input);
  let reply = sourceList ? { ok: true, result: { messages: (await ownerMessages(caller, executable)).slice(-10) } } : await request();
  if (leadAction) {
    const first = reply;
    const next = first.result?.result;
    if (first.ok && typeof next?.park === 'string' && operation === 'lead-handoff') {
      const own = currentRun().result?.run;
      const parked = own?.objective === next.park ? own : own?.id === argument ? JSON.parse(execFileSync(executable,
        ['orchestration', 'run-create', '--objective', next.park, '--environment', 'local', '--json', '--full'],
        { encoding: 'utf8', windowsHide: true, env: profileEnv, timeout: 25000 })).result?.run : undefined;
      if (!parked?.id || parked.objective !== next.park) throw new Error('未确认备用会话的待命 Run');
      input.standbyRunId = parked.id;
      reply = await request();
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
      reply = await request();
    }
  }
  const view = reply.result?.result;
  // Dispatch checks the handler's rejection before retrying a conflicting submission.
  if (reply.error?.code === 'invalid_request' && operation === 'submit') {
    process.stderr.write(JSON.stringify(reply) + '\n');
    process.exit(1);
  }
  if (!reply.ok) throw Object.assign(new Error(reply.error.message), reply.error);
  const success = reply.ok && reply.result?.ok !== false;
  if (replyDecision) {
    const project = view?.project, decision = view?.task?.decisions?.find(d => d.id === taskId);
    const run = caller && currentRun().result?.run;
    if (!success || !run?.id || run.id !== project?.runId || view.lead?.session?.handle !== caller && view.lead?.backup?.handle !== caller)
      throw new Error('请在当前项目主会话的 Run 中回送决定');
    if (decision?.answer === undefined || !decision.orcaQuestions?.length) throw new Error('没有可回送的已入账决定');
    const feedback = decision.history.at(-1), note = feedback?.note;
    const body = (decision.answer === null ? '此决定已撤下，请结束等待并与项目主会话核对。' : decision.answer) + (note ? `\n\n备注\n${note}` : '');
    const replies = decision.orcaQuestions.map(q => {
      if (q.runId !== run.id) return { questionId: q.id, runId: q.runId, error: '原问题在其他 Run，请由该 Run 当前协调者核对并回复' };
      try {
        const raw = execFileSync(executable, ['orchestration', 'reply', '--run', q.runId, '--id', q.id, '--body-file', '-', '--environment', 'local', '--json', '--full'],
          { input: body, encoding: 'utf8', windowsHide: true, env: profileEnv, timeout: 25000, maxBuffer: 1024 * 1024 });
        const receipt = JSON.parse(raw), answer = receipt.result?.message;
        if (!receipt.ok || answer?.thread_id !== q.id || answer.run_id !== q.runId || answer.to_handle !== q.from ||
            answer.from_handle !== `run:${q.runId}` || answer.body !== body || !/^msg_[\w-]+$/.test(answer.id))
          throw Error('原问题答复回执待核对');
        return { questionId: q.id, replyId: answer.id, duplicate: !!receipt.result.duplicate };
      } catch (error) {
        let detail;
        try { detail = JSON.parse(error.stdout).error; } catch { /* A transport failure does not prove a send. */ }
        return { questionId: q.id, runId: q.runId, error: detail?.message ?? '原问题答复结果待核对', ...(detail?.code && { code: detail.code }), ...(detail?.data && { recovery: detail.data }) };
      }
    });
    const ok = replies.every(r => r.replyId);
    reply = { ok, result: { projectId: argument, taskId: flag, decisionId: taskId, replies } };
    if (!ok) process.exitCode = 1;
  }
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
    if (workerQuestion) {
      const registered = new Set(task.decisionQuestionIds ?? task.decisions?.filter(d => d.answer === undefined).flatMap(d => d.orcaQuestions?.filter(q => q.runId === project.runId).map(q => q.id) ?? []));
      submission.runId = project.runId;
      submission.decisionQuestionIds = input.task.decisions.map(d => d.orcaQuestionId).filter(id => registered.has(id));
    }
  }
  if (!internal && success && view) {
    const project = view.project;
    if (project && ['submit', 'feedback', 'message', 'bind', 'project-lead-bind', 'hide', 'restore'].includes(operation)) {
      const { ref, revision, runId } = project;
      const receipt = { project: { ref, revision, runId }, projectId: ref.id, revision };
      if (operation === 'message') {
        if (ownerRelay) receipt.sourceId = `workspace-agent:${createHash('sha256').update(JSON.stringify([ref.id, input.requestId.trim()])).digest('hex')}`;
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
      for (const item of task.decisions) item.fingerprint = createHash('sha256').update(JSON.stringify([item.question, item.options])).digest('hex');
      if (!readOptions.full) {
        const recent = 3;
        const { latestArtifacts } = await import(release ? '../../src/artifact-versions.mjs' : '../src/artifact-versions.mjs');
        const keep = new Set(task.acceptance.filter(a => a.status !== 'discarded').flatMap(a => a.artifactIds));
        for (const decision of task.decisions) if (decision.answer !== null) for (const id of decision.artifactIds ?? []) keep.add(id);
        for (const { artifact } of latestArtifacts([task]).slice(0, recent)) keep.add(artifact.id);
        const artifacts = task.artifacts.filter(a => !a.expired && keep.has(a.id));
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
        const events = project.events.filter(e => !e.taskId).map(({ id, source, receivedAt, text, worker }) => ({ id, source, receivedAt, text: text.slice(0, 120), ...(worker && { worker }) }));
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
      if (ownerFeedback) receipt.requestId = input.requestId;
      receipt.items = input.items.map(({ taskId, kind, itemId, itemRevision, result }) => ({
        taskId, kind, itemId, ...(ownerFeedback && { itemRevision }), status: result || (kind === 'decision' ? 'answered' : 'replied')
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
  if (['approval_required', 'approval_stale'].includes(error?.code) ||
    ['unavailable', 'consent_required'].includes(error?.data?.requestCode) ||
    error?.code === 'invalid_argument' && /is not approved and enabled, so its worker cannot run/i.test(error.message))
    process.stderr.write('插件正在重载或等待批准，稍后重试。写入结果待核对时，请沿用原请求编号。\n');
  else if (e.stdout || e.stderr) process.stderr.write(e.stdout || e.stderr);
  else process.stderr.write(e.message + '\n');
}
