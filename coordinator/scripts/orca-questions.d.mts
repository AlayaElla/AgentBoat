import type { WorkerReport } from './worker-reports.mjs';

export const inboxLimit: number;
export const questionWait: number;
export const questionMaxAge: number;
export const businessQuestion: RegExp;
export function questionSourceId(runId: string, id: string): string;
export interface OrcaQuestion { id: string; from: string; subject: string; body: string; at: number; read?: boolean }
export interface VerifiedOrcaQuestion extends OrcaQuestion { options: string[]; taskId: string; dispatchId: string }
export interface OrcaWorkerRecord {
  runId: string; dispatchId: string; taskId: string; dispatchStatus: string; workerState?: string | null;
  terminalState?: string; agentTerminalHandle?: string; projection?: { liveness?: { verdict?: string } };
}
interface OrcaTaskRecord { id: string; run_id: string; status: string; completed_at?: string | null; result?: unknown }
interface OrcaDispatchReceipt { id: string; runId: string; taskId: string; status: string; assigneeHandle?: string }
export function openRunMail(messages: Record<string, unknown>[], runId: string, readWork: (ids: Set<string>) =>
  Promise<{ workers: OrcaWorkerRecord[]; tasks: OrcaTaskRecord[]; readDispatch?: (id: string) => Promise<OrcaDispatchReceipt | undefined> }>,
  now?: number, questionId?: string): Promise<{ questions: VerifiedOrcaQuestion[]; reports: WorkerReport[] }>;
