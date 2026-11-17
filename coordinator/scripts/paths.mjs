import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Matches Orca CLI runtime/profile/metadata.ts, including custom profiles.
export function userDataPath(platform = process.platform, env = process.env, home = os.homedir()) {
  return env.ORCA_USER_DATA_PATH || (platform === 'win32'
    ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'orca')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'orca')
    : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'orca'));
}

// Source scripts, bundled plugin and isolated tests all sit one level below coordinator.
export const clientPath = fileURLToPath(new URL('../scripts/client.mjs', import.meta.url));
