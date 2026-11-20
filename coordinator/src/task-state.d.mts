import type { Task, labels } from './model'

export function taskState(task: {
  phase: Task['phase']
  decisions: Pick<Task['decisions'][number], 'answer'>[]
  acceptance: Pick<Task['acceptance'][number], 'status'>[]
}): keyof typeof labels
