export const inboxLimit: number;
export const questionWait: number;
export interface OrcaQuestion { id: string; from: string; subject: string; body: string; at: number }
export function openQuestions(messages: Record<string, unknown>[], runId: string): OrcaQuestion[];
