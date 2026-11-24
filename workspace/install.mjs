import { appendFileSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { serialize } from 'node:v8';
import path from 'node:path';
import os from 'node:os';
import { installationRoot } from '../coordinator/scripts/orca-cli.mjs';

const stat = file => lstatSync(file, { throwIfNoEntry: false });
const backupRoot = home => path.join(home, '.agentboat/backups');
const samePath = (a, b) => !path.relative(a, b);
function within(parent, child) {
  const relative = path.relative(parent, child);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
const marker = '--agentboat-role-harness';
const hookScript = 'workspace/harness/hook.mjs';

function envValue(env, name) {
  if (process.platform !== 'win32') return env[name];
  return env[Object.keys(env).find(key => key.toUpperCase() === name.toUpperCase())];
}

function pathExecutable(name, args, env, verify, extra = []) {
  const extension = process.platform === 'win32' ? '.exe' : '';
  // A child probe must run standalone, including when the worker inherits Electron's Node mode.
  const cleanEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())));
  for (const entry of [...(envValue(env, 'PATH') || '').split(path.delimiter), ...extra]) {
    const dir = entry.replace(/^"(.*)"$/, '$1');
    if (!path.isAbsolute(dir)) continue;
    const file = path.join(dir, name + extension);
    if (!existsSync(file)) continue;
    try {
      const output = execFileSync(file, args, { encoding: 'utf8', env: cleanEnv, cwd: dir, timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      if (verify(output)) return file;
    } catch {}
  }
}
function standaloneNode(env) {
  const windows = process.platform === 'win32';
  const programFiles = windows && (envValue(env, 'ProgramFiles') || path.join((envValue(env, 'SystemDrive') || 'C:') + '\\', 'Program Files'));
  const local = windows && (envValue(env, 'LOCALAPPDATA') || path.join(envValue(env, 'USERPROFILE') || os.homedir(), 'AppData', 'Local'));
  return pathExecutable('node', ['-p', "process.release.name === 'node' && !process.versions.electron ? process.versions.node : ''"], env,
    output => Number(/^(\d+)\./.exec(output)?.[1]) >= 22, windows ? [path.join(programFiles, 'nodejs'), path.join(local, 'Programs', 'nodejs')] : []);
}
function setupEnvironment(env) {
  const node = standaloneNode(env);
  if (!node) throw Error('找不到可运行的独立 Node.js ≥22。请安装 Node.js 22 或更新版本并加入 PATH，再重启 Orca 或重新打开终端。');
  if (!pathExecutable('git', ['--version'], env, output => output.startsWith('git version ')))
    throw Error('在 PATH 中找不到可运行的 Git。请安装 Git 并加入 PATH，再重启 Orca 或重新打开终端。');
  return node;
}

function settingsPlan(file, original, handler, matchers, repository, codex) {
  const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
  let settings;
  try { settings = original ? JSON.parse(original.toString('utf8').replace(/^\uFEFF/, '')) : {}; }
  catch { throw Error(file + ' 不是有效的 JSON，请修正后重试'); }
  if (!isObject(settings) || settings.hooks !== undefined && !isObject(settings.hooks)) throw Error(file + ' 的 hooks 格式不正确');
  if (settings.disableAllHooks === true) throw Error(file + ' 已关闭所有 hooks');
  const hooks = settings.hooks ??= {};
  const owned = hook => (Array.isArray(hook?.args) && hook.args.includes(marker)) ||
    (typeof hook?.command === 'string' && hook.command.includes(marker));
  let changed = false, registered = false;
  for (const event of new Set([...Object.keys(matchers), ...Object.keys(hooks)])) {
    const required = Object.hasOwn(matchers, event), matcher = matchers[event];
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups) || groups.some(group => !isObject(group) || !Array.isArray(group.hooks))) {
      if (required || JSON.stringify(groups).includes(marker)) throw Error(file + ' 的 ' + event + ' hooks 格式不正确');
      continue;
    }
    const found = groups.flatMap(group => group.hooks.filter(owned).map(hook => ({ matcher: group.matcher || '', hook })));
    for (const { hook } of found) {
      const quoted = /^.+? (["'])(.*)\1 --agentboat-role-harness --codex$/.exec(hook.command)?.[2];
      const script = codex ? quoted?.replaceAll("'\\''", "'") : hook.args?.[1] === marker && hook.args[0];
      if (typeof script !== 'string' || !path.isAbsolute(script) || !samePath(script, path.join(repository, hookScript)))
        throw Error(file + ' 的 ' + event + ' 含有其他 Orca 配置或归属未知的 AgentBoat hook：' + (script || hook.command || marker));
      registered = true;
    }
    if (!required && !found.length) continue;
    if (required && found.length === 1 && found[0].matcher === matcher && isDeepStrictEqual(found[0].hook, handler)) continue;
    changed = true;
    hooks[event] = groups.flatMap(group => {
      if (!group.hooks.some(owned)) return [group];
      const keep = group.hooks.filter(hook => !owned(hook));
      return keep.length ? [{ ...group, hooks: keep }] : [];
    });
    if (required) hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [handler] });
  }
  return { registered, desired: changed ? Buffer.from(JSON.stringify(settings, null, 2) + '\n') : original };
}

function hookTargets(home, codexHome, repository, node) {
  const script = path.join(repository, hookScript);
  if (!existsSync(script)) throw Error('找不到 AgentBoat hook：' + script);
  const quoted = process.platform === 'win32' ? '"' + script.replaceAll('\\', '/') + '"' : "'" + script.replaceAll("'", "'\\''") + "'";
  return [
    { file: path.join(home, '.claude', 'settings.json'), archive: '.claude/settings.json',
      handler: { type: 'command', command: node, args: [script, marker], timeout: 5, onFailure: 'continue' },
      matchers: { SessionStart: 'startup|resume|compact|clear', PreToolUse: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Monitor', Stop: '' } },
    { file: path.join(codexHome, 'hooks.json'), archive: '.codex/hooks.json', codex: true,
      handler: { type: 'command', command: 'node ' + quoted + ' ' + marker + ' --codex', timeout: 5 },
      matchers: { SessionStart: 'startup|resume|compact|clear|fork', PreToolUse: 'Bash|apply_patch', Stop: '' } },
  ];
}

export function skillTargets(home) {
  return ['agentboat-workspace', 'orca-project-coordinator'].map(name => ({
    name, source: path.join(name === 'agentboat-workspace' ? 'workspace' : 'coordinator', 'skill', name),
    installed: path.join(home, '.agents/skills', name), claudeLink: path.join(home, '.claude/skills', name),
    antigravity: path.join(home, '.gemini/config/skills', name)
  }));
}

const identity = info => [info.dev, info.ino, info.mode];
function skillTree(directory, repository, previous, entries) {
  const tree = new Map(previous);
  for (const name of readdirSync(directory).sort()) {
    const file = path.join(directory, name), info = lstatSync(file);
    entries?.push(identity(info));
    if (info.isDirectory()) {
      const existing = tree.get(name);
      if (existing && !(existing instanceof Map)) throw Error('skill 的目录位置已有文件：' + file);
      tree.set(name, skillTree(file, repository, existing, entries));
    } else if (info.isFile() && info.nlink === 1) {
      if (tree.get(name) instanceof Map) throw Error('skill 的文件位置已有目录：' + file);
      const bytes = readFileSync(file);
      tree.set(name, repository && name.endsWith('.md')
        ? Buffer.from(bytes.toString('utf8').replaceAll('{{AGENTBOAT_REPO}}', () => repository)) : bytes);
    } else throw Error('skill 含有非常规文件：' + file);
  }
  return tree;
}
function writeTree(directory, tree) {
  if (stat(directory) && !stat(directory).isDirectory()) throw Error('安装目标必须是普通目录：' + directory);
  mkdirSync(directory, { recursive: true });
  for (const [name, content] of tree) {
    const file = path.join(directory, name);
    if (content instanceof Map) writeTree(file, content);
    else {
      const existing = stat(file);
      if (existing && (!existing.isFile() || existing.nlink !== 1)) throw Error('安装目标必须是独立文件：' + file);
      if (!existing || !content.equals(readFileSync(file))) writeFileSync(file, content);
    }
  }
}
function ownedSkill(tree, name, repository) {
  const text = tree?.get('SKILL.md');
  if (!Buffer.isBuffer(text)) return false;
  const md = text.toString('utf8').replaceAll('\r\n', '\n');
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(md)?.[1];
  const roots = [...md.matchAll(/"([^"\n]+)\/coordinator\/scripts\/client\.mjs"/g)].map(match => match[1]);
  return frontmatter?.split('\n').includes('name: ' + name) && roots.length &&
    roots.every(root => path.isAbsolute(root) && samePath(root, repository));
}

function resolvedParent(directory) {
  if (stat(directory)) return realpathSync(directory);
  return path.join(resolvedParent(path.dirname(directory)), path.basename(directory));
}
function snapshot(file, kind) {
  const location = path.join(resolvedParent(path.dirname(file)), path.basename(file));
  const info = stat(file);
  if (!info) return { location };
  const entries = [identity(info)];
  if (kind === 'skill' && info.isDirectory()) return { location, entries, value: skillTree(file, undefined, undefined, entries) };
  if (kind === 'hook' && info.isFile() && info.nlink === 1) return { location, entries, value: readFileSync(file) };
  if (kind === 'link' && info.isSymbolicLink()) return { location, entries, value: readlinkSync(file) };
  throw Error('安装目标已有其他内容，未覆盖：' + file);
}

function stages(file, tag) {
  const parent = path.dirname(file), prefix = '.' + path.basename(file) + '-' + tag + '-';
  if (!existsSync(parent)) return [];
  return readdirSync(parent, { withFileTypes: true }).filter(dir => dir.isDirectory() && dir.name.startsWith(prefix))
    .map(dir => path.join(parent, dir.name));
}

function interruptedSkill(file) {
  return stages(file, 'refresh').map(dir => path.join(dir, 'old')).find(old => stat(old));
}

function skillRecovery(file, name, repository) {
  if (stat(file)) return;
  const old = interruptedSkill(file);
  if (!old) return;
  const stage = path.dirname(old), next = path.join(stage, 'next');
  if (!ownedSkill(snapshot(old, 'skill').value, name, repository) ||
      !ownedSkill(snapshot(next, 'skill').value, name, repository)) return;
  return () => {
    if (stat(file)) throw Error('skill 在恢复期间已更改：' + file);
    renameSync(old, file);
    rmSync(next, { recursive: true });
    rmdirSync(stage);
  };
}

function restoreFile(old, file) {
  if (!stat(old)?.isFile()) throw Error('请核对保留的原文件：' + old);
  linkSync(old, file);
  unlinkSync(old);
}

const sameInode = (a, b) => a?.isFile() && b?.isFile() && a.dev === b.dev && a.ino === b.ino;

function hookRecovery(file, repository) {
  const info = stat(file);
  if (info && (!info.isFile() || info.nlink === 1)) return;
  for (const stage of stages(file, 'agentboat')) {
    const old = path.join(stage, 'old'), next = path.join(stage, 'next'), owner = path.join(stage, 'owner');
    const current = path.join(stage, 'current');
    const linked = info && [old, next, current].find(candidate => sameInode(info, stat(candidate)));
    if (info ? !linked : !stat(next)?.isFile() || !stat(old)) continue;
    const location = path.join(resolvedParent(path.dirname(file)), path.basename(file));
    if (!stat(owner)?.isFile() || readFileSync(owner, 'utf8') !== JSON.stringify([repository, location]))
      throw Error('hooks 有其他 Orca 配置或归属未知的中断记录：' + stage);
    if (stat(current) && linked !== current) throw Error('上次 hooks 回滚中断，请核对保留的文件：' + current + ' → ' + file);
    return () => {
      if (!info) {
        restoreFile(old, location);
        rmSync(next, { force: true });
      } else {
        const live = stat(location);
        if (!sameInode(info, live) || !sameInode(live, stat(linked))) throw Error('hooks 在恢复期间已更改：' + file);
        if (linked !== next) rmSync(next, { force: true });
        unlinkSync(linked);
      }
      unlinkSync(owner);
      if (!stat(old)) rmdirSync(stage);
    };
  }
}

function setupRecovery(home, codexHome, repository) {
  const skills = skillTargets(home).flatMap(({ name, installed, antigravity }) =>
    [installed, antigravity].map(file => skillRecovery(file, name, repository)));
  const hooks = hookTargets(home, codexHome, repository).map(({ file }) => hookRecovery(file, repository));
  return [...skills, ...hooks].filter(Boolean);
}

function setupPlan(home, codexHome, repository, node) {
  const link = stat(repository);
  const entry = [realpathSync(repository), identity(link), link.isSymbolicLink() ? readlinkSync(repository) : ''];
  const plans = [];
  const add = (file, kind, archive) => {
    const plan = { file, kind, archive, before: snapshot(file, kind) };
    plans.push(plan);
    return plan;
  };
  for (const { name, source, installed, claudeLink, antigravity } of skillTargets(home)) {
    const src = path.join(repository, source);
    const shared = add(installed, 'skill', path.relative(home, installed));
    const copy = add(antigravity, 'skill', path.relative(home, antigravity));
    for (const plan of [shared, copy]) {
      const interrupted = !plan.before.value && interruptedSkill(plan.file);
      if (interrupted) throw Error('上次写入中断，请先核对原 skill：' + interrupted + ' → ' + plan.file);
      if (plan.before.value && !ownedSkill(plan.before.value, name, repository))
        throw Error('skill 已有其他 Orca 配置或归属未知的内容：' + plan.file);
      plan.desired = skillTree(src, repository, plan.before.value);
      if (!ownedSkill(plan.desired, name, repository)) throw Error('AgentBoat 的 SKILL.md 归属不匹配：' + src);
    }
    const linkPlan = add(claudeLink, 'link', path.relative(home, claudeLink));
    if (linkPlan.before.value && (!shared.before.entries || !existsSync(claudeLink) ||
        !samePath(realpathSync(claudeLink), realpathSync(installed))))
      throw Error('Claude 位置已有其他内容，未覆盖：' + claudeLink);
    linkPlan.desired = linkPlan.before.value ?? shared.before.location;
  }
  for (const { file, archive, handler, matchers, codex } of hookTargets(home, codexHome, repository, node)) {
    const plan = add(file, 'hook', archive);
    plan.desired = settingsPlan(file, plan.before.value, handler, matchers, repository, codex).desired;
  }
  const locations = plans.map(plan => plan.before.location);
  for (const [i, location] of locations.entries()) {
    for (const other of locations.slice(0, i)) {
      if (within(other, location) || within(location, other)) throw Error('安装路径重叠：' + other + ' 和 ' + location);
    }
  }
  const changes = plans.filter(p => !isDeepStrictEqual(p.before.value, p.desired));
  const confirmation = createHash('sha256').update(serialize({ repository, entry, node, plans })).digest('hex');
  return { plans, changes, confirmation, entry };
}

const setupRepository = () => installationRoot({ repair: false }).replaceAll('\\', '/');

export function validateCodexHome(value, platform = process.platform) {
  if (value === '') return value;
  const windows = platform === 'win32';
  const full = typeof value === 'string' && (windows
    ? /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/i.test(value) &&
      !/[<>:"|?*]/.test(value.replace(/^[a-z]:/i, ''))
    : value.startsWith('/'));
  if (!full || /[\x00-\x1f\x7f-\x9f]/.test(value) || value.split(windows ? /[\\/]/ : '/').some(part => part === '.' || part === '..'))
    throw Error('CODEX_HOME 必须是完整绝对路径，且不能含控制字符、. 或 .. 路径段。');
  return value;
}

function codexDirectory(home, env, override) {
  return path.resolve(validateCodexHome(override || envValue(env, 'CODEX_HOME') || path.join(home, '.codex')));
}

export function previewSetup({ home = os.homedir(), env = process.env, codexHome } = {}) {
  let codexHooks = '';
  const backups = backupRoot(home);
  try {
    const directory = codexDirectory(home, env, codexHome);
    codexHooks = path.join(directory, 'hooks.json');
    const repository = setupRepository();
    // A preview can finish restoring files moved by an earlier, authorized setup.
    if (setupRecovery(home, directory, repository).length)
      withSetupLock(home, () => setupRecovery(home, directory, repository).forEach(recover => recover()));
    const plan = setupPlan(home, directory, repository, setupEnvironment(env));
    return { backupRoot: backups, codexHooks, paths: plan.changes.map(p => p.file), ...(plan.changes.length ? { confirmation: plan.confirmation } : {}) };
  } catch (error) {
    return { paths: [], backupRoot: backups, codexHooks, error: error.message };
  }
}

const processIdentityFormat = process.platform === 'win32' ? /^\d{18,19}$/ :
  process.platform === 'linux' ? /^[a-f0-9-]{36}\/\d+$/ : /^\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}\s+\S.*$/;

function readProcessIdentity(pid) {
  const opts = { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    let value;
    if (process.platform === 'win32') {
      const system = envValue(process.env, 'SystemRoot') || 'C:\\Windows';
      value = execFileSync(path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          '(Get-Process -ErrorAction Stop -Id ' + pid + ').StartTime.ToUniversalTime().Ticks'], opts).trim();
    } else if (process.platform === 'linux') {
      const proc = readFileSync('/proc/' + pid + '/stat', 'utf8');
      const start = proc.slice(proc.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
      value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + '/' + start;
    } else if (process.platform === 'darwin') {
      // shortcut: ps reports whole seconds, use a native process identity if this blocks recovery.
      value = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm='],
        { ...opts, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).trim();
    }
    if (processIdentityFormat.test(value ?? '')) return value;
  } catch {}
}

let ownProcessIdentity;
function processIdentity(pid) {
  return pid === process.pid ? ownProcessIdentity ??= readProcessIdentity(pid) ?? '' : readProcessIdentity(pid);
}

function withSetupLock(home, operation) {
  // Shared by all profiles and CODEX_HOME choices under this system account.
  const lock = path.join(realpathSync(home), '.agentboat-setup.lock');
  const busy = () => Error('有另一次 AgentBoat 设置正在进行，或无法确认锁持有者。若已确认持有进程退出，可移除锁目录后重试：' + lock);
  const stage = mkdtempSync(lock + '-');
  const owner = 'pid-' + process.pid + '-' + randomUUID();
  const removeEmpty = () => {
    try { rmdirSync(lock); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  };
  try {
    writeFileSync(path.join(stage, owner), processIdentity(process.pid), { flag: 'wx', mode: 0o600, flush: true });
    // Publish the owner and directory together. An empty directory can only be between removals.
    for (let attempt = 0; attempt < 5; attempt++) {
      const entry = stat(lock);
      if (!entry) {
        try { renameSync(stage, lock); }
        catch (error) {
          if (stat(lock)) continue;
          throw error;
        }
        try { return operation(); }
        finally { unlinkSync(path.join(lock, owner)); removeEmpty(); }
      }
      if (!entry.isDirectory()) throw busy();
      let owners;
      try { owners = readdirSync(lock); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (owners.length) {
        const pid = Number(/^pid-([1-9]\d*)-[a-f0-9-]{36}$/.exec(owners[0])?.[1]);
        if (owners.length !== 1 || !Number.isInteger(pid) || pid > 0x7fffffff) throw busy();
        const record = path.join(lock, owners[0]);
        let exited = false;
        try { process.kill(pid, 0); }
        catch (error) {
          if (error.code !== 'ESRCH') throw busy();
          exited = true;
        }
        if (!exited) {
          let recorded;
          try {
            if (!lstatSync(record).isFile()) throw busy();
            recorded = readFileSync(record, 'utf8');
          }
          catch (error) { if (error.code === 'ENOENT') continue; throw busy(); }
          const actual = processIdentity(pid);
          if (!processIdentityFormat.test(recorded) || !actual || actual === recorded) throw busy();
        }
        try { unlinkSync(record); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      }
      removeEmpty();
    }
    throw busy();
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function assertUnchanged(plan) {
  if (!isDeepStrictEqual(snapshot(plan.file, plan.kind), plan.before)) throw Error('安装目标已更改，请重新核对：' + plan.file);
}

function swapSkill(plan, prepare) {
  const { location, entries, value } = plan.before;
  const stage = mkdtempSync(path.join(path.dirname(location), '.' + path.basename(location) + '-refresh-'));
  const old = path.join(stage, 'old'), next = path.join(stage, 'next');
  try {
    prepare(next);
    assertUnchanged(plan);
    if (entries) renameSync(location, old);
    try {
      if (entries) {
        const moved = snapshot(old, 'skill');
        if (!isDeepStrictEqual(moved.entries, entries) || !isDeepStrictEqual(moved.value, value))
          throw Error('skill 在写入期间已更改：' + plan.file);
      }
      if (stat(location)) throw Error('skill 在写入期间已更改：' + plan.file);
      renameSync(next, location);
    } catch (error) {
      if (stat(old)) {
        if (stat(location)) throw Error(error.message + '\n原内容保存在：' + old);
        renameSync(old, location);
      }
      throw error;
    }
    if (entries) rmSync(old, { recursive: true });
  } finally {
    if (!stat(old)) rmSync(stage, { recursive: true, force: true });
  }
}

function saveHook(plan, repository) {
  const { before, desired, file } = plan, { location, entries, value } = before;
  const stage = mkdtempSync(path.join(path.dirname(location), '.' + path.basename(location) + '-agentboat-'));
  const old = path.join(stage, 'old'), next = path.join(stage, 'next'), owner = path.join(stage, 'owner');
  const probe = stage + '.probe';
  const edited = () => Error('hooks 在写入期间已更改，请重新核对：' + file);
  const verifyOld = () => {
    if (!entries) return;
    const actual = snapshot(old, 'hook');
    if (!isDeepStrictEqual(actual.entries, entries) || !isDeepStrictEqual(actual.value, value)) throw edited();
  };
  let published = false, keepRecovery = false, probeLinked = false;
  try {
    writeFileSync(owner, JSON.stringify([repository, location]), { flag: 'wx', mode: 0o600, flush: true });
    writeFileSync(next, desired, { flag: 'wx', mode: entries ? entries[0][2] & 0o777 : 0o600, flush: true });
    if (entries) {
      try {
        linkSync(next, probe);
        probeLinked = true;
        unlinkSync(probe);
        probeLinked = false;
      }
      catch (error) { throw Error('无法在 hooks 目录验证硬链接，原文件保留：' + file + '\n' + error.message); }
    }
    assertUnchanged(plan);
    if (entries) renameSync(location, old);
    verifyOld();
    // Publish only into a vacant filename. Keep the actual displaced inode for recovery.
    linkSync(next, location);
    published = true;
    try { verifyOld(); }
    catch (error) {
      keepRecovery = true;
      const current = path.join(stage, 'current');
      renameSync(location, current);
      if (isDeepStrictEqual(identity(lstatSync(current)), identity(lstatSync(next))) && readFileSync(current).equals(desired)) {
        unlinkSync(current);
        published = false;
      } else {
        try { restoreFile(current, location); }
        catch { throw Error(error.message + '\n并发内容保存在：' + current); }
      }
      keepRecovery = false;
      throw error;
    }
    if (entries) return old;
  } catch (error) {
    if (!stat(old)) throw error;
    if (!published && !stat(location)) {
      keepRecovery = true;
      try { restoreFile(old, location); keepRecovery = false; }
      catch { throw Error(error.message + '\n被移走的原内容保存在：' + old); }
    }
    if (stat(old)) {
      keepRecovery = true;
      throw Error(error.message + '\n被移走的原内容保存在：' + old);
    }
    throw error;
  } finally {
    if (!keepRecovery) {
      if (probeLinked) rmSync(probe, { force: true });
      rmSync(next, { force: true });
      rmSync(owner, { force: true });
      if (!stat(old) && !stat(path.join(stage, 'current'))) rmdirSync(stage);
    }
  }
}

function saveTarget(plan, repository) {
  const { kind, before, desired } = plan, { location, entries } = before;
  assertUnchanged(plan);
  mkdirSync(path.dirname(location), { recursive: true });
  if (kind === 'link') {
    assertUnchanged(plan);
    symlinkSync(desired, location, process.platform === 'win32' ? 'junction' : 'dir');
  } else if (kind === 'skill') {
    swapSkill(plan, next => {
      if (entries) cpSync(location, next, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true, preserveTimestamps: true });
      if (entries) assertUnchanged(plan);
      writeTree(next, desired);
    });
  } else {
    return saveHook(plan, repository);
  }
}

export function applySetup(confirmation, { home = os.homedir(), env = process.env, codexHome } = {}) {
  return withSetupLock(home, () => {
    const repository = setupRepository(), directory = codexDirectory(home, env, codexHome);
    setupRecovery(home, directory, repository).forEach(recover => recover());
    const plan = setupPlan(home, directory, repository, setupEnvironment(env));
    if (!plan.changes.length) return { completed: [] };
    if (plan.confirmation !== confirmation) throw Error('首次设置的路径或文件已更改，请刷新并重新核对。');
    const assertEntry = () => {
      const repository = installationRoot({ repair: false });
      const link = lstatSync(repository);
      if (!isDeepStrictEqual([realpathSync(repository), identity(link), link.isSymbolicLink() ? readlinkSync(repository) : ''], plan.entry))
        throw Error('AgentBoat 固定入口已更改，请重新核对：' + repository);
    };
    const completed = [];
    let backup;
    try {
      const root = backupRoot(home);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      backup = mkdtempSync(path.join(root, 'setup-'));
      for (const item of plan.changes) {
        const { before, archive, kind } = item;
        assertUnchanged(item);
        if (!before.entries) continue;
        const file = path.join(backup, archive);
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        if (kind === 'link') writeFileSync(file + '.link', before.value, { flag: 'wx', mode: 0o600 });
        else if (kind === 'hook') writeFileSync(file, before.value, { flag: 'wx', mode: 0o600, flush: true });
        else cpSync(before.location, file, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
      }
      for (const item of plan.plans) assertUnchanged(item);
      for (const item of plan.changes) {
        assertEntry();
        const replaced = saveTarget(item, repository);
        completed.push(item.file);
        if (replaced) appendFileSync(path.join(backup, 'replaced-hooks.jsonl'), JSON.stringify({ file: item.file, replaced }) + '\n', { mode: 0o600, flush: true });
        appendFileSync(path.join(backup, 'completed.jsonl'), JSON.stringify(item.file) + '\n', { mode: 0o600, flush: true });
      }
      return { backup, completed };
    } catch (error) {
      throw Error(error.message + '\n已完成：' + (completed.join('、') || '无') + (backup ? '\n备份位置：' + backup : ''));
    }
  });
}

export function refreshInstalledSkills(entry, home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, '.codex')) {
  const repository = entry.replaceAll('\\', '/');
  let configured = false, changed = false, backup;
  const targets = skillTargets(home).flatMap(skill => [skill.installed, skill.antigravity].map(file => ({ ...skill, file })));
  const refresh = () => {
    for (const { name, source, file, antigravity } of targets) {
      try {
        if (!stat(path.dirname(file))?.isDirectory()) continue;
        skillRecovery(file, name, repository)?.();
        const before = snapshot(file, 'skill');
        if (!ownedSkill(before.value, name, repository)) continue;
        configured = true;
        const desired = skillTree(path.join(repository, source), repository, file === antigravity ? before.value : undefined);
        if (isDeepStrictEqual(before.value, desired)) continue;
        if (!ownedSkill(desired, name, repository)) throw Error('新版 SKILL.md 的身份或入口不匹配：' + file);
        if (!backup) {
          const root = backupRoot(home);
          mkdirSync(root, { recursive: true, mode: 0o700 });
          backup = mkdtempSync(path.join(root, 'skill-refresh-' + Date.now() + '-'));
        }
        const archive = file === antigravity ? path.join(backup, 'antigravity', name) : path.join(backup, name);
        cpSync(before.location, archive, { recursive: true, verbatimSymlinks: true });
        swapSkill({ file, kind: 'skill', before }, next => writeTree(next, desired));
      } catch (error) { console.error('AgentBoat 刷新 ' + name + ' 失败：' + error.message); }
    }
  };
  if (targets.some(({ file }) => stat(path.dirname(file)))) {
    try { withSetupLock(home, refresh); } catch (error) { console.error('AgentBoat 刷新 skill 失败：' + error.message); }
  }
  const node = standaloneNode(process.env);
  for (const { file, handler, matchers, codex } of hookTargets(home, codexHome, repository, node)) {
    try {
      const before = snapshot(file, 'hook').value, plan = settingsPlan(file, before, handler, matchers, repository, codex);
      configured ||= plan.registered;
      changed ||= !isDeepStrictEqual(before, plan.desired);
    } catch (error) { changed = true; console.error('AgentBoat 检查 hooks 失败：' + error.message); }
  }
  return configured && changed;
}
