export function taskState(task) {
  if (task.phase === 'paused') return 'paused'
  if (task.decisions.some(x => x.answer === undefined)) return 'decision'
  if (task.acceptance.some(x => x.status === 'changes_requested')) return 'rework'
  if (task.phase === 'ready' && task.acceptance.some(x => x.status === 'pending')) return 'review'
  if (task.phase === 'ready') return 'completed'
  return task.phase
}
