import type { WorkerReport } from './worker-reports.mjs';

export const inboxLimit: number;
export const questionWait: number;
export const questionMaxAge: number;
export interface OrcaQuestion { id: string; from: string; subject: string; body: string; at: number }
export interface OrcaWorkerRecord {
  runId: string; dispatchId: string; taskId: string; dispatchStatus: string; workerState?: string | null;
  terminalState?: string; agentTerminalHandle?: string; projection?: { liveness?: { verdict?: string } };
}
interface OrcaTaskRecord { id: string; run_id: string; status: string; completed_at?: string | null }
export function openRunMail(messages: Record<string, unknown>[], runId: string, readWork: (ids: Set<string>) =>
  Promise<{ workers: OrcaWorkerRecord[]; tasks: OrcaTaskRecord[] }>, now?: number): Promise<{ questions: OrcaQuestion[]; reports: WorkerReport[] }>;
