import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileContact } from './lead-contact.mjs';
import { openRunMail } from './orca-questions.mjs';

const job = { id: 'fixture', primary: 'orca_session_id:main' };
function fixture(interrupt) {
  const calls = [];
  let run, task, dispatch;
  const call = (op, ...args) => {
    calls.push(op);
    switch (op) {
      case 'run-create': run = { id: 'run_contact', objective: args[1] }; break;
      case 'run-list': return { runs: run ? [run] : [] };
      case 'run-show': case 'run-use': assert.equal(args[1], run.id); return { run };
      case 'task-list': return { tasks: task ? [task] : [] };
      case 'task-create': task = { id: 'task_contact', run_id: run.id, spec: args[3], status: 'ready' }; break;
      case 'dispatch-show': return { dispatch };
      case 'dispatch': dispatch = { id: 'ctx_contact', task_id: task.id, run_id: run.id, assignee_handle: args[5], status: 'dispatched' }; task.status = 'dispatched'; break;
      case 'worker-abandon': assert.equal(args[1], dispatch.id); dispatch.status = 'failed'; task.status = 'blocked'; return {};
      case 'task-update': assert.equal(args[1], task.id); task.status = args[5]; break;
      default: assert.fail(op);
    }
    if (op === interrupt) { interrupt = ''; throw Error('receipt lost'); }
    return { run, task, dispatch };
  };
  return { call, calls, result: () => ({ run, task, dispatch }) };
}
for (const loss of ['run-create', 'task-create', 'dispatch']) test('contact recovers a lost ' + loss + ' receipt and closes the exact assignment', () => {
  const f = fixture(loss);
  let stored = {};
  const sync = closing => reconcileContact(job, structuredClone(stored), closing, f.call, s => { stored = structuredClone(s); });
  assert.throws(() => sync(false), /receipt lost/);
  sync(false); sync(false);
  assert.equal(stored.dispatch, 'ctx_contact');
  assert.equal(stored.ready, true);
  for (const op of ['run-create', 'task-create', 'dispatch']) assert.equal(f.calls.filter(x => x === op).length, 1);
  sync(true); sync(true);
  assert.equal(stored.closed, true);
  assert.equal(f.result().task.status, 'completed');
  assert.equal(f.result().dispatch.status, 'failed');
  assert.equal(f.calls.filter(x => x === 'worker-abandon').length, 1);
});
test('cancellation before or during open leaves no active contact task', () => {
  for (const partial of [false, true]) {
    const f = fixture('task-create'), s = {};
    if (partial) assert.throws(() => reconcileContact(job, s, false, f.call, () => {}), /receipt lost/);
    reconcileContact(job, s, true, f.call, () => {});
    assert.equal(s.closed, true);
    assert.equal(f.result().task?.status, partial ? 'completed' : undefined);
    assert.equal(f.calls.includes('dispatch'), false);
  }
});
test('contact questions and completion are outside the business Run scanned by T54 and T56', async () => {
  const messages = ['question', 'worker_done'].map((type, i) => ({ id: 'msg_' + i, type, run_id: 'run_contact',
    to_handle: 'run:run_contact', from_handle: 'dispatch:ctx_contact', created_at: new Date().toISOString(), body: '联络' }));
  const result = await openRunMail(messages, 'run_business', () => assert.fail('must not query business workers'));
  assert.deepEqual(result, { questions: [], reports: [] });
});
