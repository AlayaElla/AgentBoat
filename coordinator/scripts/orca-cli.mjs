import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const executable = process.env.ORCA_CLI_COMMAND || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'orca', 'resources', 'bin', 'orca.exe') : 'orca');

// Matches Orca CLI runtime/profile/metadata.ts, including custom profiles.
export function userDataPath(platform = process.platform, env = process.env, home = os.homedir()) {
  return env.ORCA_USER_DATA_PATH || (platform === 'win32'
    ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'orca')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'orca')
    : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'orca'));
}

// Source scripts, bundled plugin and isolated tests all sit one level below coordinator.
export const clientPath = fileURLToPath(new URL('../scripts/client.mjs', import.meta.url));
export const roleRegistryPath = (platform = process.platform, env = process.env, home = os.homedir()) => path.join(userDataPath(platform, env, home), 'plugins-data', 'local.project-coordinator', 'roles.json');
