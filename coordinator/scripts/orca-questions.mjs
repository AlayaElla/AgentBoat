import { reportWait, workerReport } from './worker-reports.mjs';

export const inboxLimit = 2400;
export const questionWait = 10 * 60_000;
export const questionMaxAge = 24 * 60 * 60_000;
const settledWorker = new Set(['succeeded', 'failed', 'stopped', 'abandoned']);
export const businessQuestion = /^\[业务决定\]\s*\S/;
export const questionSourceId = (runId, id) => `orca-question:${runId}:${id}`;

function completedReport(task, mail) {
  if (!task) return false;
  let receipt = task.result;
  if (typeof receipt === 'string') {
    try { receipt = JSON.parse(receipt); } catch { return false; }
  }
  return receipt?.provenance === 'worker_report' && receipt.outcome === 'succeeded' &&
    receipt.messageId === mail.id && receipt.reportedBy === mail.from;
}

// Orca reply inserts status mail with the original thread and a Re: subject.
// Reading or consuming mail changes read, which does not mean a reply was sent.
export async function openRunMail(messages, runId, readWork, now = Date.now(), questionId) {
  const replies = new Map();
  const key = (thread, subject, recipient) => JSON.stringify([thread, subject, recipient]);
  for (const m of messages) {
    if (m.type !== 'status' || m.run_id !== runId || !m.thread_id || typeof m.subject !== 'string' || !m.subject.startsWith('Re: ') ||
      !m.to_handle || !Number.isSafeInteger(m.sequence)) continue;
    const id = key(m.thread_id, m.subject, m.to_handle);
    replies.set(id, Math.max(replies.get(id) ?? -1, m.sequence));
  }
  const candidates = messages.flatMap(m => {
    const at = Date.parse(typeof m.created_at === 'string' ? m.created_at.replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)$/, '$1T$2Z') : ''), age = now - at;
    if (m.run_id !== runId || m.to_handle !== 'run:' + runId ||
      (questionId ? m.id !== questionId || m.type !== 'question' || !(age >= 0) :
        !(age > (m.type === 'worker_done' ? reportWait : questionWait) && age <= questionMaxAge)) ||
      (m.type !== 'question' && m.type !== 'worker_done')) return [];
    if (m.type === 'worker_done') {
      const report = workerReport(m);
      return report?.outcome === 'succeeded' && report.dispatchId && report.taskId && report.from
        ? [{ mail: report, report: true, dispatchId: report.dispatchId, taskId: report.taskId }] : [];
    }
    if (
      typeof m.id !== 'string' || !m.id || typeof m.from_handle !== 'string' || !m.from_handle ||
      typeof m.subject !== 'string' || typeof m.body !== 'string' || !m.body.trim() || !Number.isSafeInteger(m.sequence) ||
      (replies.get(key(m.thread_id || m.id, 'Re: ' + m.subject, m.from_handle)) ?? -1) > m.sequence) return [];
    let payload;
    if (typeof m.payload === 'string') try { payload = JSON.parse(m.payload); } catch { /* A dispatch address identifies a modern sender. */ }
    const dispatchId = m.from_handle.startsWith('dispatch:') ? m.from_handle.slice('dispatch:'.length) : payload?.dispatchId;
    const taskId = payload?.taskId;
    if (typeof dispatchId !== 'string' || !dispatchId) return [];
    if (questionId && (m.thread_id !== m.id || payload?.question !== m.body || payload.dispatchId !== dispatchId || typeof taskId !== 'string')) return [];
    const options = Array.isArray(payload?.options) && payload.options.every(option => typeof option === 'string') ? payload.options : [];
    return [{ dispatchId, taskId, mail: { id: m.id, from: m.from_handle, subject: m.subject, body: m.body, at, read: !!m.read, options } }];
  });
  const result = { questions: [], reports: [] };
  if (!candidates.length) return result;
  const { workers, tasks, readDispatch } = await readWork(new Set(candidates.map(q => q.dispatchId)));
  const activeTasks = new Set(tasks.filter(t => t.run_id === runId && !t.completed_at &&
    (t.status === 'dispatched' || t.status === 'blocked')).map(t => t.id));
  const completedTasks = new Map(tasks.filter(t => t.run_id === runId && t.status === 'completed' && t.completed_at).map(t => [t.id, t]));
  const completedWorkers = new Map(workers.filter(w => w.runId === runId && w.dispatchStatus === 'completed' &&
    w.workerState === 'succeeded').map(w => [w.dispatchId, w]));
  const senders = new Map(workers.filter(w => w.runId === runId && w.dispatchStatus === 'dispatched' &&
    !settledWorker.has(w.workerState) && (!!w.agentTerminalHandle || w.workerState && w.workerState !== 'unsupervised') &&
    !['released', 'release_pending', 'release_unknown', 'reclaimable'].includes(w.terminalState) &&
    w.projection?.liveness?.verdict !== 'exited' && activeTasks.has(w.taskId)).map(w => [w.dispatchId, w]));
  for (const { dispatchId, taskId, mail, report } of candidates) {
    if (report) {
      const worker = completedWorkers.get(dispatchId);
      if (worker?.taskId !== taskId || !completedReport(completedTasks.get(taskId), mail)) continue;
      if (mail.from !== 'dispatch:' + dispatchId && mail.from !== worker.agentTerminalHandle) {
        // Orca can omit the terminal handle for historical workers.
        const dispatch = await readDispatch?.(dispatchId);
        if (dispatch?.id !== dispatchId || dispatch.runId !== runId || dispatch.taskId !== taskId ||
          dispatch.status !== 'completed' || dispatch.assigneeHandle !== mail.from) continue;
      }
      result.reports.push(mail);
      continue;
    }
    const worker = senders.get(dispatchId);
    if (!worker || taskId && taskId !== worker.taskId ||
      mail.from !== 'dispatch:' + dispatchId && !(mail.from === worker.agentTerminalHandle && taskId === worker.taskId)) continue;
    result.questions.push({ ...mail, taskId: worker.taskId, dispatchId });
  }
  return result;
}
