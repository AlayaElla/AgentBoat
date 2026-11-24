type SetupOptions = { home?: string; env?: NodeJS.ProcessEnv; codexHome?: string };
export function previewSetup(options?: SetupOptions): {
  paths: string[]; backupRoot: string; codexHooks: string; confirmation?: string; error?: string;
};
export function applySetup(confirmation: string, options?: SetupOptions): { completed: string[]; backup?: string };
