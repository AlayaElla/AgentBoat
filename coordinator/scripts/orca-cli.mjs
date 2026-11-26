import path from 'node:path';
import os from 'node:os';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

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

export const pluginKey = 'alayaella.agentboat';
// The worker is bundled at the release root while client and hook scripts keep their source layout.
const workerRelease = existsSync(new URL('./setup.mjs', import.meta.url)) && existsSync(new URL('./orca-plugin.json', import.meta.url));
const releaseRoot = new URL(workerRelease ? './' : '../../', import.meta.url);
export const release = existsSync(new URL('setup.mjs', releaseRoot)) && existsSync(new URL('orca-plugin.json', releaseRoot));
export function pluginVersionLabel() {
  try {
    const { version } = JSON.parse(readFileSync(new URL('orca-plugin.json', releaseRoot), 'utf8'));
    if (typeof version === 'string' && version.trim()) return `版本 v${version}`;
  } catch { /* Keep the panel available if the manifest cannot be read. */ }
  return '版本未知';
}
const versionDir = path.resolve(fileURLToPath(releaseRoot));
const keyDir = path.dirname(versionDir);
const pluginsDir = path.dirname(keyDir);
const versionHash = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/;
const installed = release && versionHash.test(path.basename(versionDir)) && path.basename(keyDir) === pluginKey && path.basename(pluginsDir) === 'plugins';
export const activeUserDataPath = () => installed ? path.dirname(pluginsDir) : userDataPath();
export function localOrcaRequest(cli, method, params, timeout = 5000) {
  cli = realpathSync(cli);
  const { RuntimeClient } = createRequire(import.meta.url)(path.resolve(path.dirname(cli), '../app.asar.unpacked/out/cli/runtime/client.js'));
  return new RuntimeClient(activeUserDataPath(), timeout, null, null, cli).call(method, params);
}
export async function ownerMessages(caller, cli, messageId) {
  if (!caller?.startsWith('orca_session_id:') || messageId !== undefined && !messageId.startsWith('orca:'))
    throw Error('请从 Orca 聊天查询用户原消息');
  // Public agent read omits journal IDs and the recorded input author.
  const sessionId = caller.slice('orca_session_id:'.length);
  const result = messageId === undefined
    ? await localOrcaRequest(cli, 'agentSession.history', { sessionId, direction: 'tail', limit: 60 })
    : await localOrcaRequest(cli, 'agentSession.item', { sessionId, itemId: messageId });
  const items = messageId === undefined ? result.result?.page?.items : [result.result?.item];
  if (!result.ok || !Array.isArray(items)) throw Error('Orca 未返回聊天记录');
  return items.flatMap(message => {
    const body = message?.body, block = body?.blocks?.length === 1 && body.blocks[0], typist = body?.typedBy;
    if (typeof message?.itemId !== 'string' || !message.itemId.startsWith('orca:') || messageId !== undefined && message.itemId !== messageId ||
        !Number.isFinite(message.observedAt) || body?.kind !== 'message' || body.role !== 'user' || body.from !== undefined ||
        (typist?.by !== 'host' && !(typist?.by === 'device' && typist.own === true)) || block?.type !== 'text' ||
        typeof block.text !== 'string' || !block.text.trim() || block.text.length > 8000) return [];
    return [{ messageId: message.itemId, text: block.text, receivedAt: new Date(message.observedAt).toISOString() }];
  });
}
export const stableRoot = () => path.resolve(activeUserDataPath(), 'agentboat-current');
const clientScript = 'coordinator/scripts/client.mjs';
export const stableClientPath = () => path.join(stableRoot(), clientScript);
export const clientPath = path.join(versionDir, clientScript);
export function promptClientPath() {
  if (installed) try { return path.join(installationRoot(), clientScript); } catch { /* Keep using this worker's own release. */ }
  return clientPath;
}
export const pluginDataPath = (root = activeUserDataPath()) => path.join(root, 'plugins-data', pluginKey);
export const roleRegistryPath = (...profile) => path.join(pluginDataPath(profile.length ? userDataPath(...profile) : undefined), 'roles.json');

// Orca owns current and prunes old releases. Keep our directory link outside its plugins tree.
function linkCurrentRelease(repair) {
  const link = stableRoot(), current = path.join(keyDir, 'current');
  for (let attempt = 0; attempt < 3; attempt++) {
    let hash;
    try { hash = readFileSync(current, 'utf8').trim(); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!versionHash.test(hash)) throw Error('AgentBoat 当前版本无效，请检查 Orca 插件安装');
    const target = path.join(keyDir, hash);
    if (!lstatSync(target, { throwIfNoEntry: false })?.isDirectory() ||
        ![clientScript, 'setup.mjs', 'orca-plugin.json'].every(file => existsSync(path.join(target, file))))
      throw Error('AgentBoat 当前版本文件尚未就绪，请稍后重试');
    const entry = lstatSync(link, { throwIfNoEntry: false });
    if (entry) {
      const previous = entry.isSymbolicLink() && path.resolve(path.dirname(link), readlinkSync(link));
      if (previous && !path.relative(previous, target)) return link;
      if (!previous || path.relative(path.dirname(previous), keyDir) || !versionHash.test(path.basename(previous)))
        throw Error(`固定入口已有其他内容，未覆盖：${link}`);
      if (!repair) throw Error(`固定入口需要更新，请重启 AgentBoat：${link}`);
      try { unlinkSync(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!repair) throw Error(`找不到固定入口，请重新打开工作间：${link}`);
    try { symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw Error(`AgentBoat 固定入口正在更新，请稍后重试：${link}`);
}

export function installationRoot({ repair = true } = {}) {
  if (!installed) return versionDir;
  const entry = linkCurrentRelease(repair);
  if (!entry) throw Error('找不到 AgentBoat 当前安装版本，请确认插件已启用');
  return entry;
}

export async function refreshReleaseSetup(codexHome) {
  if (!installed) return;
  const entry = installationRoot();
  if (path.relative(versionDir, realpathSync(entry))) return;
  const { refreshInstalledSkills } = await import(pathToFileURL(path.join(entry, 'workspace/install.mjs')).href);
  if (refreshInstalledSkills(entry, undefined, codexHome)) return pluginVersionLabel();
}
