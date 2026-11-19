export const executable: string;
export function userDataPath(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, home?: string): string;
export const clientPath: string;
export function installationRoot(): string;
export const release: boolean;
export const pluginKey: string;
export function activeUserDataPath(): string;
export function pluginDataPath(root?: string): string;
export function roleRegistryPath(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, home?: string): string;
