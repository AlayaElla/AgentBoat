export const inboxLimit = 2400;
export const questionWait = 10 * 60_000;

// Orca reply inserts status mail with the original thread and a Re: subject.
// Reading or consuming mail changes read, which does not mean a reply was sent.
export function openQuestions(messages, runId) {
  const replies = new Map();
  const key = (thread, subject, recipient) => JSON.stringify([thread, subject, recipient]);
  for (const m of messages) {
    if (m.run_id !== runId || !m.thread_id || typeof m.subject !== 'string' || !m.subject.startsWith('Re: ') ||
      !m.to_handle || !Number.isSafeInteger(m.sequence)) continue;
    const id = key(m.thread_id, m.subject, m.to_handle);
    replies.set(id, Math.max(replies.get(id) ?? -1, m.sequence));
  }
  return messages.filter(m => m.run_id === runId && m.type === 'question' && m.to_handle === 'run:' + runId &&
    typeof m.id === 'string' && m.id && typeof m.from_handle === 'string' && m.from_handle &&
    typeof m.subject === 'string' && typeof m.body === 'string' && m.body.trim() &&
    Number.isFinite(Date.parse(m.created_at)) && Number.isSafeInteger(m.sequence) &&
    (replies.get(key(m.thread_id || m.id, 'Re: ' + m.subject, m.from_handle)) ?? -1) <= m.sequence)
    .map(m => ({ id: m.id, from: m.from_handle, subject: m.subject, body: m.body, at: Date.parse(m.created_at) }));
}
