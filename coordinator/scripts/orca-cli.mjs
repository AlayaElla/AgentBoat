import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const appCli = path.resolve(path.dirname(process.execPath), process.platform === 'win32' ? 'resources/bin/orca.exe' : '../Resources/bin/orca');
export const executable = process.env.ORCA_CLI_COMMAND || (existsSync(appCli) ? appCli : process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'orca', 'resources', 'bin', 'orca.exe') : 'orca');

// Matches Orca CLI runtime/profile/metadata.ts, including custom profiles.
export function userDataPath(platform = process.platform, env = process.env, home = os.homedir()) {
  return env.ORCA_USER_DATA_PATH || (platform === 'win32'
    ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'orca')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'orca')
    : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'orca'));
}

export const releasePluginKey = 'alayaella.agentboat';
// The worker is bundled at the release root while client and hook scripts keep their source layout.
const workerRelease = existsSync(new URL('./setup.mjs', import.meta.url)) && existsSync(new URL('./orca-plugin.json', import.meta.url));
const releaseRoot = new URL(workerRelease ? './' : '../../', import.meta.url);
export const release = existsSync(new URL('setup.mjs', releaseRoot)) && existsSync(new URL('orca-plugin.json', releaseRoot));
const versionDir = path.resolve(fileURLToPath(releaseRoot));
const keyDir = path.dirname(versionDir);
const pluginsDir = path.dirname(keyDir);
const installed = release && /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/.test(path.basename(versionDir)) && path.basename(pluginsDir) === 'plugins';
export const activeUserDataPath = () => installed ? path.dirname(pluginsDir) : userDataPath();
export const pluginKey = installed ? path.basename(keyDir) : release ? releasePluginKey : 'local.' + releasePluginKey.split('.')[1];
export const clientPath = fileURLToPath(new URL(workerRelease ? './coordinator/scripts/client.mjs' : '../scripts/client.mjs', import.meta.url));
export const pluginDataPath = (root = activeUserDataPath()) => path.join(root, 'plugins-data', pluginKey);
export const roleRegistryPath = (...profile) => path.join(pluginDataPath(profile.length ? userDataPath(...profile) : undefined), 'roles.json');
