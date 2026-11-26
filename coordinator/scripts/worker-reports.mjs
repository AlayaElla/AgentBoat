export const reportWait = 30 * 60_000;
export const escalationWait = 2 * 60 * 60_000;

export function workerReport(message) {
  if (message.type !== 'worker_done' || typeof message.id !== 'string' || !message.id) return;
  let payload = message.payload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { payload = undefined; }
  }
  if (payload?._orcaLifecycleRejection) return;
  const sender = message.from_handle ?? message.from;
  const from = typeof sender === 'string' ? sender : '';
  const at = Date.parse(message.created_at);
  return {
    id: message.id, from, body: message.body || message.subject || '', runId: message.run_id,
    taskId: typeof payload?.taskId === 'string' ? payload.taskId : undefined,
    dispatchId: typeof payload?.dispatchId === 'string' ? payload.dispatchId : from.startsWith('dispatch:') ? from.slice(9) : undefined,
    at: Number.isFinite(at) ? at : undefined
  };
}

function reportExecution(report, execution) {
  if (report.runId && report.runId !== execution.runId) return false;
  return report.taskId ? report.taskId === execution.taskId : !!report.dispatchId && report.dispatchId === execution.dispatchId;
}

export function reportSubmitted(report, submission) {
  return report.at === undefined || submission.at >= report.at ||
    submission.updatedAt > report.at && !!submission.executions?.some(e => reportExecution(report, e));
}

export function projectSubmissions(project) {
  return project.tasks.map(task => {
    const legacyFeedback = task.submittedAt == null && [...task.acceptance, ...task.decisions].some(item => item.history.some(entry => entry.at === task.updatedAt));
    const time = Date.parse(task.submittedAt ?? (legacyFeedback ? '' : task.updatedAt));
    return { at: Number.isFinite(time) ? time : undefined, updatedAt: Date.parse(task.updatedAt), executions: task.executions };
  });
}
