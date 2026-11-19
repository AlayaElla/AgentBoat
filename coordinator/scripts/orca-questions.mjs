export const inboxLimit = 2400;
export const questionWait = 10 * 60_000;
export const questionMaxAge = 24 * 60 * 60_000;
const settledWorker = new Set(['succeeded', 'failed', 'stopped', 'abandoned']);

// Orca reply inserts status mail with the original thread and a Re: subject.
// Reading or consuming mail changes read, which does not mean a reply was sent.
export async function openQuestions(messages, runId, readWork, now = Date.now()) {
  const replies = new Map();
  const key = (thread, subject, recipient) => JSON.stringify([thread, subject, recipient]);
  for (const m of messages) {
    if (m.type !== 'status' || m.run_id !== runId || !m.thread_id || typeof m.subject !== 'string' || !m.subject.startsWith('Re: ') ||
      !m.to_handle || !Number.isSafeInteger(m.sequence)) continue;
    const id = key(m.thread_id, m.subject, m.to_handle);
    replies.set(id, Math.max(replies.get(id) ?? -1, m.sequence));
  }
  const candidates = messages.flatMap(m => {
    const at = Date.parse(m.created_at), age = now - at;
    if (m.run_id !== runId || m.type !== 'question' || m.to_handle !== 'run:' + runId ||
      typeof m.id !== 'string' || !m.id || typeof m.from_handle !== 'string' || !m.from_handle ||
      typeof m.subject !== 'string' || typeof m.body !== 'string' || !m.body.trim() || !Number.isSafeInteger(m.sequence) ||
      !(age > questionWait && age <= questionMaxAge) ||
      (replies.get(key(m.thread_id || m.id, 'Re: ' + m.subject, m.from_handle)) ?? -1) > m.sequence) return [];
    let dispatchId = m.from_handle.startsWith('dispatch:') ? m.from_handle.slice('dispatch:'.length) : undefined;
    let taskId;
    if (!dispatchId && typeof m.payload === 'string') {
      try { ({ dispatchId, taskId } = JSON.parse(m.payload) ?? {}); } catch { return []; }
      if (typeof taskId !== 'string' || !taskId) return [];
    }
    if (typeof dispatchId !== 'string' || !dispatchId) return [];
    return [{ dispatchId, taskId, question: { id: m.id, from: m.from_handle, subject: m.subject, body: m.body, at } }];
  });
  if (!candidates.length) return [];
  const { workers, tasks } = await readWork(new Set(candidates.map(q => q.dispatchId)));
  const activeTasks = new Set(tasks.filter(t => t.run_id === runId && !t.completed_at &&
    (t.status === 'dispatched' || t.status === 'blocked')).map(t => t.id));
  const senders = new Map(workers.filter(w => w.runId === runId && w.dispatchStatus === 'dispatched' &&
    !settledWorker.has(w.workerState) && (!!w.agentTerminalHandle || w.workerState && w.workerState !== 'unsupervised') &&
    !['released', 'release_pending', 'release_unknown', 'reclaimable'].includes(w.terminalState) &&
    w.projection?.liveness?.verdict !== 'exited' && activeTasks.has(w.taskId)).map(w => [w.dispatchId, w]));
  return candidates.flatMap(({ dispatchId, taskId, question }) => {
    const worker = senders.get(dispatchId);
    return worker && (question.from === 'dispatch:' + dispatchId ||
      question.from === worker.agentTerminalHandle && taskId === worker.taskId) ? [question] : [];
  });
}
