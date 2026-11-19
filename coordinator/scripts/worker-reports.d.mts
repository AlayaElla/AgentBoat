import type { Project } from '../src/model.js';

export interface WorkerReport {
  id: string; from: string; body: string; runId?: string; taskId?: string; dispatchId?: string; at?: number;
}
type Execution = Project['tasks'][number]['executions'][number];
interface Submission { at?: number; updatedAt?: number; executions?: Execution[] }
export const reportWait: number;
export const escalationWait: number;
export function workerReport(message: Record<string, unknown>): WorkerReport | undefined;
export function reportSubmitted(report: WorkerReport, submission: Submission): boolean;
export function projectSubmissions(project: Project): Submission[];
