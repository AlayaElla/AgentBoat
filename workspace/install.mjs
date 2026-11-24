import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

function pathExecutable(name, args, env, verify) {
  const pathKey = Object.keys(env).find(key => process.platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH');
  const extension = process.platform === 'win32' ? '.exe' : '';
  // A child probe must run standalone, including when the worker inherits Electron's Node mode.
  const cleanEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())));
  for (const entry of (env[pathKey] || '').split(path.delimiter)) {
    const dir = entry.replace(/^"(.*)"$/, '$1');
    if (!path.isAbsolute(dir)) continue;
    const file = path.join(dir, name + extension);
    if (!existsSync(file)) continue;
    try {
      const output = execFileSync(file, args, { encoding: 'utf8', env: cleanEnv, cwd: dir, timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return verify(output) ? file : undefined;
    } catch (error) {
      if (['ENOENT', 'EACCES'].includes(error.code)) continue;
      return;
    }
  }
}
function standaloneNode(env) {
  return pathExecutable('node', ['-p', "process.release.name === 'node' && !process.versions.electron ? process.versions.node : ''"], env,
    output => Number(/^(\d+)\./.exec(output)?.[1]) >= 22);
}
function setupEnvironment(env) {
  const node = standaloneNode(env);
  if (!node) throw Error('在 PATH 中找不到可运行的独立 Node.js ≥22。请安装 Node.js 22 或更新版本并加入 PATH，再重启 Orca 或重新打开终端。');
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

function interruptedSkill(file) {
  const parent = path.dirname(file), prefix = '.' + path.basename(file) + '-refresh-';
  if (!existsSync(parent)) return;
  return readdirSync(parent, { withFileTypes: true }).filter(dir => dir.isDirectory() && dir.name.startsWith(prefix))
    .map(dir => path.join(parent, dir.name, 'old')).find(old => stat(old));
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
    if (linkPlan.before.value &&
        !samePath(path.resolve(path.dirname(linkPlan.before.location), linkPlan.before.value), shared.before.location) &&
        !samePath(path.resolve(path.dirname(claudeLink), linkPlan.before.value), installed))
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

function planSetup(home, env, codexHome) {
  const repository = installationRoot({ repair: false }).replaceAll('\\', '/');
  return setupPlan(home, codexHome, repository, setupEnvironment(env));
}

function codexDirectory(home, env, override) {
  if (override && !path.isAbsolute(override)) throw Error('AgentBoat 插件设置中的 CODEX_HOME 必须是绝对路径：' + override);
  return path.resolve(override || env.CODEX_HOME || path.join(home, '.codex'));
}

export function previewSetup({ home = os.homedir(), env = process.env, codexHome } = {}) {
  let codexHooks = '';
  const backups = backupRoot(home);
  try {
    const directory = codexDirectory(home, env, codexHome);
    codexHooks = path.join(directory, 'hooks.json');
    const plan = planSetup(home, env, directory);
    return { backupRoot: backups, codexHooks, paths: plan.changes.map(p => p.file), ...(plan.changes.length ? { confirmation: plan.confirmation } : {}) };
  } catch (error) {
    return { paths: [], backupRoot: backups, codexHooks, error: error.message };
  }
}

function withSetupLock(home, operation) {
  // Shared by all profiles and CODEX_HOME choices under this system account.
  const lock = path.join(realpathSync(home), '.agentboat-setup.lock');
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw Error('有另一次 AgentBoat 设置正在进行。若已确认安装进程退出，可移除空锁目录：' + lock);
    throw error;
  }
  try { return operation(); }
  finally { rmdirSync(lock); }
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

function saveTarget(plan) {
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
    const temp = location + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temp, desired, { flag: 'wx', mode: entries ? entries[0][2] & 0o777 : 0o600, flush: true });
      assertUnchanged(plan);
      renameSync(temp, location);
    } finally { rmSync(temp, { force: true }); }
  }
}

export function applySetup(confirmation, { home = os.homedir(), env = process.env, codexHome } = {}) {
  return withSetupLock(home, () => {
    const plan = planSetup(home, env, codexDirectory(home, env, codexHome));
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
        saveTarget(item);
        completed.push(item.file);
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
        const parent = path.dirname(file), prefix = '.' + name + '-refresh-';
        if (!stat(parent)?.isDirectory()) continue;
        // Only the interval between the two renames leaves both halves and no live directory.
        if (!stat(file)) {
          for (const dir of readdirSync(parent, { withFileTypes: true })) {
            if (!dir.isDirectory() || !dir.name.startsWith(prefix)) continue;
            const stage = path.join(parent, dir.name), old = path.join(stage, 'old'), next = path.join(stage, 'next');
            if (ownedSkill(snapshot(old, 'skill').value, name, repository) &&
                ownedSkill(snapshot(next, 'skill').value, name, repository)) {
              if (stat(file)) throw Error('skill 在恢复期间已更改：' + file);
              renameSync(old, file);
              rmSync(next, { recursive: true });
              rmdirSync(stage);
              break;
            }
          }
        }
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
