import type { OrcaWorkerApi } from 'orca/worker';

export function cliBridge(orca: OrcaWorkerApi): { api: OrcaWorkerApi; start(): Promise<void>; stop(): void };
