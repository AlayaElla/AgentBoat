import { activeUserDataPath, executable, linkCurrentRelease, release, stableClientPath } from './orca-cli.mjs';
import { installedRequest } from './cli-bridge.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { writeMainRoleCards } from './main-role-card.mjs';

const [operation, argument, flag, taskId, extra] = process.argv.slice(2);
const brief = operation === 'overview' && argument === '--brief';
const singleTask = operation === 'read' && flag === '--task';
if (operation === 'overview' && (argument && !brief || flag)) throw new Error('用法：node client.mjs overview [--brief]');
if (operation === 'read' && (!argument || flag && (!singleTask || !taskId || extra))) throw new Error('用法：node client.mjs read <projectId> [--task <taskId>]');
const leadBind = operation === 'project-lead-bind', leadSwitch = operation === 'project-lead-switch';
const leadActions = ['lead-take', 'lead-ready', 'lead-handoff', 'lead-resume'];
const leadAction = leadActions.includes(operation);
const allowed = [...leadActions, 'projects', 'overview', 'main-read', 'main-bind', 'project-lead', 'project-lead-switch', 'project-lead-bind', 'message', 'read', 'bind', 'submit', 'feedback', 'feishu-reply', 'links-read', 'links-refresh', 'links-invite', 'links-cancel-invite', 'links-join', 'links-configure', 'links-rename', 'links-share', 'links-relate', 'links-revoke', 'links-send', 'hide', 'restore', 'delete', 'main-targets', 'connections', 'connection-read', 'connection-check', 'connection-send', 'connection-reply'];
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
const input = leadAction ? { runId: argument, action: operation.slice(5), caller, token: flag, ...(taskId ? { note: taskId } : {}) } : operation === 'connections' ? { operation: 'read' } : operation.startsWith('connection-') ? { ...(['connection-read','connection-check'].includes(operation) ? { name: argument } : readInput(0)), operation: operation.slice(11) } : operation.startsWith('links-') ? { ...(['links-join', 'links-configure', 'links-rename', 'links-share', 'links-relate', 'links-revoke', 'links-send'].includes(operation) ? readInput(0) : {}), operation: operation.slice(6) } : ['projects', 'overview'].includes(operation) ? null : operation === 'main-read' ? { operation: 'read' } : operation === 'read'
  ? { operation, projectId: argument, ...(singleTask ? { taskId } : {}) }
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
const name = leadAction ? 'lead.control' : operation === 'connections' || operation.startsWith('connection-') ? 'workspace.connections' : operation.startsWith('links-') ? 'workspace.links' : operation === 'projects' ? 'projects.list' : operation === 'overview' ? 'workspace.overview'
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
  if (release) {
    const reply = JSON.parse(stdout);
    if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
  }
  if (operation === 'main-bind' && !input.checkOnly) {
    const reply = JSON.parse(stdout), binding = reply.result?.result;
    if (reply.ok && binding?.runId === input.runId && binding.session?.handle === caller) {
      try { writeMainRoleCards(binding.session.path); }
      catch (error) { binding.roleCardWarning = `绑定已成功，角色卡未完整写入：${error.message}。修正后用原请求重试。`; }
    }
    process.stdout.write(JSON.stringify(reply, null, 2) + '\n');
  } else if (operation === 'submit') {
    const reply = JSON.parse(stdout), result = reply.result?.result, project = result?.project;
    const task = project?.tasks?.find(t => t.id === input.task?.id) ?? (result?.task?.id === input.task?.id ? result?.task : undefined);
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if (reply.ok && project?.ref?.id === input.projectId && task && project.requests?.some(r => r.id === input.requestId && r.fingerprint === fingerprint)) {
      const archived = project.archive?.last;
      const submission = { projectId: project.ref.id, requestId: input.requestId, taskId: task.id, phase: task.phase, pendingAcceptance: task.acceptance?.some(a => a.status === 'pending') ?? false, pendingDecision: task.decisions?.some(d => d.answer === undefined) ?? false,
        submittedAt: task.submittedAt, ...(archived && archived.revision === input.revision + 1 && archived.revision === project.revision ? { archived } : {}) };
      process.stdout.write(JSON.stringify({ submission, ...reply }) + '\n');
    } else {
      process.stdout.write(stdout);
    }
  } else if (brief || singleTask) {
    const reply = JSON.parse(stdout), result = reply.result?.result;
    if (reply.ok && reply.result?.ok !== false && result) {
      if (brief) {
        const { attention, questions, reports, projects, error } = result;
        reply.result.result = { attention, questions, reports, projects: projects.map(({ ref, counts }) => ({ id: ref.id, name: ref.name, counts })), error };
      } else {
        const { project } = result, task = result.task ?? project.tasks.find(task => task.id === taskId);
        if (!task) {
          process.stderr.write(`项目 ${project.ref.id} 中找不到任务 ${taskId}。\n`);
          process.exit(1);
        }
        reply.result.result = { projectId: project.ref.id, revision: project.revision, task, ...(result.archiveStatus ? { archiveStatus: result.archiveStatus } : {}) };
      }
    }
    process.stdout.write(JSON.stringify(reply) + '\n');
  } else if (operation !== 'message') process.stdout.write(stdout);
  else {
    const reply = JSON.parse(stdout), result = reply.result?.result;
    if (reply.ok && result?.project) {
      if (result.queued) {
        try {
          const { autoProjectLead } = await import('../../workspace/workspace.mjs');
          result.autoLaunch = autoProjectLead(input.projectId, input.runId);
        } catch (error) {
          result.autoLaunch = { status: 'not-confirmed', projectName: result.project.ref.name, reason: error.message };
        }
      } else result.autoLaunch = { status: 'already-bound', projectName: result.project.ref.name, reason: '项目已绑定主 agent' };
    }
    process.stdout.write(JSON.stringify(reply, null, 2) + '\n');
  }
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
