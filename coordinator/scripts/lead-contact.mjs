import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { activeUserDataPath, clientPath, pluginDataPath, release } from './orca-cli.mjs';

const read = file => JSON.parse(readFileSync(file, 'utf8'));
function save(file, value) {
  const tmp = file + '.' + randomUUID();
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flush: true });
  renameSync(tmp, file);
}
const phaseEnded = status => ['completed', 'failed'].includes(status);

// The controller owns only this contact's Run. Never bind a business Run in its terminal.
export function reconcileContact(job, state, closing, call, persist) {
  const objective = 'AgentBoat 主会话联络 ' + job.id;
  const saveState = updates => { Object.assign(state, updates); persist(state); };
  if (!state.run && closing) return saveState({ closed: true });
  if (!state.run) {
    let run;
    if (state.creating) {
      // A controller may stop after Orca created the Run but before its ID reached disk.
      let cursor;
      const matches = [];
      const pages = new Set();
      do {
        const page = call('run-list', '--limit', '100', ...(cursor ? ['--cursor', cursor] : []));
        matches.push(...page.runs.filter(r => r.objective === objective));
        cursor = page.nextCursor;
        if (cursor && pages.has(cursor)) throw Error('联络 Run 分页未前进');
        pages.add(cursor);
      } while (cursor);
      if (matches.length !== 1) return saveState({ unresolved: true, error: '联络 Run 创建回执不唯一或缺失，请核对 ' + objective });
      [run] = matches;
    } else {
      saveState({ creating: true });
      run = call('run-create', '--objective', objective).run;
    }
    if (run?.objective !== objective || !/^run_[\w-]+$/.test(run.id)) throw Error('联络 Run 回执不符');
    saveState({ run: run.id, creating: false });
  }
  if (call('run-show', '--id', state.run).run?.objective !== objective) throw Error('联络 Run 归属不符');
  call('run-use', '--id', state.run);
  const tasks = call('task-list', '--run', state.run).tasks;
  if (!Array.isArray(tasks) || tasks.length > 1 || tasks.some(t => t.run_id !== state.run || t.spec !== objective)) throw Error('联络任务不唯一或归属不符');
  let task = tasks[0];
  if (!task && !closing) task = call('task-create', '--run', state.run, '--spec', objective).task;
  if (!task && !state.task && closing) return saveState({ closed: true });
  if (!task?.id || task.run_id !== state.run || (state.task && task.id !== state.task)) throw Error('联络任务回执不符');
  if (!state.task) saveState({ task: task.id });
  let dispatch;
  try { dispatch = call('dispatch-show', '--task', task.id).dispatch; }
  catch (e) { if (e.code !== 'dispatch_not_found') throw e; }
  if (!dispatch && !closing && !state.dispatch && task.status === 'ready') {
    dispatch = call('dispatch', '--run', state.run, '--task', task.id, '--to', job.primary).dispatch;
  }
  if (dispatch && (dispatch.task_id !== task.id || dispatch.run_id !== state.run || dispatch.assignee_handle !== job.primary ||
    (state.dispatch && dispatch.id !== state.dispatch))) throw Error('联络 Dispatch 归属不符');
  if (dispatch && !state.dispatch) saveState({ dispatch: dispatch.id });
  if (!closing) {
    if (!dispatch || !['pending', 'dispatched'].includes(dispatch.status)) throw Error('联络 Dispatch 已失效');
    return saveState({ ready: true, error: '' });
  }
  if (dispatch && ['pending', 'dispatched'].includes(dispatch.status)) call('worker-abandon', '--dispatch', dispatch.id);
  if (!phaseEnded(task.status)) {
    const updated = call('task-update', '--id', task.id, '--run', state.run, '--status', 'completed', '--result', '联络已结束').task;
    if (!phaseEnded(updated?.status)) throw Error('联络任务结束回执不符');
  }
  saveState({ closed: true, ready: false, error: '' });
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

// This agentless terminal supplies Orca's required coordinator identity, independently of both chats.
export async function serve(dir) {
  const lock = path.join(dir, 'controller');
  try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); } catch (e) { if (e.code === 'EEXIST') return; throw e; }
  try {
    const job = read(path.join(dir, 'job.json')), file = path.join(dir, 'state.json');
    const state = existsSync(file) ? read(file) : {};
    const put = s => save(file, s);
    const call = (...args) => {
      let out;
      try { out = execFileSync(job.executable, ['orchestration', ...args, '--environment', 'local', '--json', '--full'], { encoding: 'utf8', windowsHide: true, timeout: 25000,
        ...(release && { env: { ...process.env, ORCA_USER_DATA_PATH: activeUserDataPath() } }) }); }
      catch (e) { if (!e.stdout) throw e; out = e.stdout; }
      const reply = JSON.parse(out);
      if (!reply.ok) throw Object.assign(Error(reply.error?.message || 'Orca 联络失败'), { code: reply.error?.code });
      return reply.result;
    };
    try {
      reconcileContact(job, state, existsSync(path.join(dir, 'close')), call, put);
      if (state.ready && existsSync(path.join(dir, 'close'))) reconcileContact(job, state, true, call, put);
    } catch (e) { state.error = String(e.message).slice(0, 300); put(state); }
  } finally { unlinkSync(lock); }
}

export class LeadContacts {
  constructor(root = path.join(pluginDataPath(), 'lead-contacts'), script = path.join(path.dirname(clientPath), 'lead-contact.mjs')) {
    this.root = root;
    this.script = script;
    this.started = new Map();
  }
  async sync(wanted, executable, launch, workspaces = []) {
    if (!wanted.length && !existsSync(this.root)) return {};
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const wantedById = new Map(wanted.map(j => [j.id, j]));
    for (const job of wanted) {
      if (!/^[\da-f-]{36}$/i.test(job.id)) throw Error('联络编号无效');
      const dir = path.join(this.root, job.id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, 'job.json');
      if (!existsSync(file)) save(file, { ...job, executable });
    }
    const routes = {};
    for (const id of readdirSync(this.root)) {
      if (!/^[\da-f-]{36}$/i.test(id)) continue;
      const dir = path.join(this.root, id), jobFile = path.join(dir, 'job.json');
      if (!existsSync(jobFile)) continue;
      const job = read(jobFile), stateFile = path.join(dir, 'state.json'), state = existsSync(stateFile) ? read(stateFile) : {};
      if (state.closed) {
        this.started.delete(id + ':true'); this.started.delete(id + ':false');
        if (wantedById.has(id)) routes[id] = { closed: true };
        else if (!existsSync(path.join(dir, 'controller'))) {
          for (const name of ['close', 'state.json', 'job.json']) if (existsSync(path.join(dir, name))) unlinkSync(path.join(dir, name));
          if (!readdirSync(dir).length) rmdirSync(dir);
        }
        continue;
      }
      const closing = !wantedById.has(id);
      if (closing) routes[id] = { closing: true, projectId: job.projectId, error: state.error || undefined };
      if (closing && !existsSync(path.join(dir, 'close'))) writeFileSync(path.join(dir, 'close'), '');
      if (!closing && !existsSync(path.join(dir, 'close'))) routes[id] = state.error ? { error: state.error } : { dispatch: state.ready ? state.dispatch : undefined };
      const lock = path.join(dir, 'controller');
      if (existsSync(lock)) {
        if (alive(Number(readFileSync(lock, 'utf8')))) continue;
        unlinkSync(lock);
      }
      if (!closing && (state.ready || state.unresolved || (state.task && wantedById.get(id)?.online === false))) continue;
      const attempt = id + ':' + closing;
      if ((this.started.get(attempt) ?? 0) + 60_000 > Date.now()) continue;
      this.started.set(attempt, Date.now());
      const encoded = v => Buffer.from(v).toString('base64url');
      const scriptUrl = encoded(pathToFileURL(this.script).href), directory = encoded(dir);
      const command = `node -e "const d=s=>Buffer.from(s,'base64url').toString();import(d('${scriptUrl}')).then(m=>m.serve(d('${directory}')))"`;
      // The shell exits after the job; no agent is launched and no user terminal is reused.
      const workspace = closing && workspaces.length && !workspaces.includes(job.workspace) ? workspaces[0] : job.workspace;
      await launch(['terminal', 'create', '--worktree', workspace, '--title', 'AgentBoat 联络 ' + id,
        ...(process.platform === 'win32' ? ['--shell', 'powershell.exe'] : []), '--command', command + '; exit']).catch(e => { routes[id] = { ...routes[id], error: e.message }; });
    }
    return routes;
  }
}
