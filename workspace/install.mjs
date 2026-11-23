import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { installationRoot } from '../coordinator/scripts/orca-cli.mjs';

function sameProfile(root, repository) {
  return path.isAbsolute(root) && !path.relative(repository, root);
}

function hookSettings(file, handler, owned, matchers, inspect, repository) {
  const info = stat(file);
  if (info && !info.isFile()) throw Error(`${file} 必须是普通文件`);
  const original = info ? readFileSync(file) : undefined;
  const settings = original ? JSON.parse(original.toString('utf8').replace(/^\uFEFF/, '')) : {};
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(settings) || settings.hooks !== undefined && !object(settings.hooks)) throw Error(`${file} 的 hooks 格式不正确`);
  if (settings.disableAllHooks === true) throw Error(`${file} 已关闭所有 hooks`);
  const hooks = settings.hooks ??= {};
  let changed = false, registered = false;
  for (const event of new Set([...Object.keys(matchers), ...Object.keys(hooks)])) {
    const required = Object.hasOwn(matchers, event), matcher = matchers[event];
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups) || groups.some(group => !object(group) || !Array.isArray(group.hooks))) {
      if (required) throw Error(`${file} 的 ${event} hooks 格式不正确`);
      continue;
    }
    const found = groups.flatMap(group => group.hooks.filter(owned).map(hook => ({ matcher: group.matcher || '', hook })));
    for (const { hook } of found) {
      const script = hook.args?.[0] ?? /^node ['"](.+)['"] --agentboat-role-harness --codex$/.exec(hook.command)?.[1]?.replaceAll("'\\''", "'");
      if (typeof script === 'string' && sameProfile(path.resolve(script, '../../..'), repository)) registered = true;
    }
    if (!required && !found.length) continue;
    // Setup uses standalone Node. Orca's worker may use its own executable.
    const command = found[0]?.hook.command;
    const expected = inspect && handler.args && !/^node(?:\.exe)?$/i.test(path.basename(process.execPath)) &&
      typeof command === 'string' && path.isAbsolute(command) && stat(command)?.isFile() &&
      path.basename(command).toLowerCase() === (process.platform === 'win32' ? 'node.exe' : 'node') ? { ...handler, command } : handler;
    if (required && found.length === 1 && found[0].matcher === matcher && isDeepStrictEqual(found[0].hook, expected)) continue;
    changed = true;
    hooks[event] = groups.flatMap(group => {
      if (!group.hooks.some(owned)) return [group];
      const keep = group.hooks.filter(hook => !owned(hook));
      return keep.length ? [{ ...group, hooks: keep }] : [];
    });
    if (required) hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [handler] });
  }
  return { changed, registered, write() {
    if (!changed) return;
    const current = existsSync(file) ? readFileSync(file) : undefined;
    if (current ? !original?.equals(current) : original) throw Error(`${file} 已更新，请重试安装`);
    mkdirSync(path.dirname(file), { recursive: true });
    const id = randomUUID(), temp = file + '.' + id + '.tmp';
    if (original) writeFileSync(file + '.agentboat-' + id + '.bak', original, { flag: 'wx', mode: 0o600, flush: true });
    try {
      writeFileSync(temp, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode: info ? info.mode & 0o777 : 0o600, flush: true });
      renameSync(temp, file);
    } finally { rmSync(temp, { force: true }); }
  } };
}
function hookPlans(home, codexHome, repository, inspect = false) {
  const script = path.join(repository, 'workspace/harness/hook.mjs');
  if (!existsSync(script)) throw Error('找不到 AgentBoat hooks');
  const marker = '--agentboat-role-harness';
  const claude = () => hookSettings(path.join(home, '.claude', 'settings.json'),
    { type: 'command', command: process.execPath, args: [script, marker], timeout: 5, onFailure: 'continue' },
    hook => hook?.type === 'command' && Array.isArray(hook.args) && hook.args[1] === marker && path.basename(hook.args[0] || '') === 'hook.mjs',
    { SessionStart: 'startup|resume|compact|clear', PreToolUse: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Monitor', Stop: '' }, inspect, repository);
  const codexScript = process.platform === 'win32' ? `"${script.replaceAll('\\', '/')}"` : "'" + script.replaceAll("'", "'\\''") + "'";
  const codex = () => hookSettings(path.join(codexHome, 'hooks.json'),
    { type: 'command', command: `node ${codexScript} ${marker} --codex`, timeout: 5 },
    hook => hook?.type === 'command' && typeof hook.command === 'string' && /\/harness\/hook\.mjs['"] --agentboat-role-harness --codex$/.test(hook.command),
    { SessionStart: 'startup|resume|compact|clear|fork', PreToolUse: 'Bash|apply_patch', Stop: '' }, inspect, repository);
  return [claude, codex];
}

export function skillTargets(home) {
  return ['agentboat-workspace', 'orca-project-coordinator'].map(name => ({
    name, source: path.join(name === 'agentboat-workspace' ? 'workspace' : 'coordinator', 'skill', name),
    installed: path.join(home, '.agents/skills', name), claudeLink: path.join(home, '.claude/skills', name),
    antigravity: path.join(home, '.gemini/config/skills', name)
  }));
}

const stat = file => lstatSync(file, { throwIfNoEntry: false });
function skillTree(directory, repository, previous) {
  const tree = new Map(previous);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const existing = tree.get(entry.name);
      tree.set(entry.name, skillTree(file, repository, existing instanceof Map ? existing : undefined));
    } else if (entry.isFile()) {
      const bytes = readFileSync(file);
      tree.set(entry.name, repository && entry.name.endsWith('.md')
        ? Buffer.from(bytes.toString('utf8').replaceAll('{{AGENTBOAT_REPO}}', () => repository)) : bytes);
    } else throw Error(`skill 含有非常规文件：${file}`);
  }
  return tree;
}
function writeTree(directory, tree) {
  if (stat(directory) && !stat(directory).isDirectory()) throw Error(`安装目标必须是普通目录：${directory}`);
  mkdirSync(directory, { recursive: true });
  for (const [name, content] of tree) {
    const file = path.join(directory, name);
    if (content instanceof Map) writeTree(file, content);
    else {
      const existing = stat(file);
      if (existing && (!existing.isFile() || existing.nlink !== 1)) throw Error(`安装目标必须是独立文件：${file}`);
      writeFileSync(file, content);
    }
  }
}

export function install(home = os.homedir(), codexHome = path.join(home, '.codex')) {
  const repository = installationRoot().replaceAll('\\', '/');
  const targets = skillTargets(home);
  for (const { name, installed, claudeLink, antigravity } of targets) {
    const entry = stat(claudeLink);
    if (entry && (!entry.isSymbolicLink() || realpathSync(claudeLink) !== realpathSync(installed))) throw Error(`Claude 位置已有其他内容，未覆盖：${claudeLink}`);
    if (stat(installed) && !stat(installed).isDirectory()) throw Error(`安装目标必须是普通目录：${installed}`);
    if (stat(antigravity)) {
      const owner = skillOwner(antigravity, name);
      const previous = skillOwner(installed, name);
      if (!owner || ![repository, previous].some(root => root && sameProfile(owner, root)))
        throw Error(`Antigravity 位置已有其他内容，未覆盖：${antigravity}`);
    }
  }
  const hooks = hookPlans(home, codexHome, repository).map(plan => plan());
  for (const { source, installed, claudeLink, antigravity } of targets) {
    const tree = skillTree(path.join(repository, source), repository);
    writeTree(installed, tree);
    mkdirSync(path.dirname(claudeLink), { recursive: true });
    if (!existsSync(claudeLink)) symlinkSync(installed, claudeLink, process.platform === 'win32' ? 'junction' : 'dir');
    // agy ignores skill directory junctions on Windows.
    writeTree(antigravity, tree);
  }
  hooks.forEach(plan => plan.write());
  return { repository, skills: targets.map(({ installed, claudeLink, antigravity }) => ({ installed, claudeLink, antigravity })),
    codexHooks: path.join(codexHome, 'hooks.json'), codexTrust: '在 Codex CLI 输入 /hooks，查看并信任三条 AgentBoat hook。' };
}
function skillOwner(directory, name) {
  const file = path.join(directory, 'SKILL.md');
  if (!stat(directory)?.isDirectory() || !stat(file)?.isFile()) return;
  const text = readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)?.[1];
  // Profiles share the skill directory; setup embeds the selected profile's entry.
  const root = /"([^"\n]+)\/coordinator\/scripts\/client\.mjs"/.exec(text)?.[1];
  if (frontmatter?.split('\n').includes('name: ' + name) && root && path.isAbsolute(root)) return root;
}

function ownedSkill(directory, name, repository) {
  const root = skillOwner(directory, name);
  return root && sameProfile(root, repository);
}

export function refreshInstalledSkills(entry, home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, '.codex')) {
  const repository = entry.replaceAll('\\', '/');
  let configured = false, backup;
  const targets = skillTargets(home).flatMap(skill => [skill.installed, skill.antigravity].map(target => ({ ...skill, target })));
  for (const { name, source, target, antigravity } of targets) {
    try {
      const parent = path.dirname(target), prefix = '.' + name + '-refresh-';
      if (!stat(parent)?.isDirectory()) continue;
      // Only the interval between the two renames leaves both halves and no live directory.
      if (!stat(target)) {
        for (const dir of readdirSync(parent, { withFileTypes: true })) {
          if (!dir.isDirectory() || !dir.name.startsWith(prefix)) continue;
          const stage = path.join(parent, dir.name), old = path.join(stage, 'old');
          if (ownedSkill(old, name, repository) && ownedSkill(path.join(stage, 'next'), name, repository)) {
            renameSync(old, target);
            rmSync(path.join(stage, 'next'), { recursive: true });
            rmdirSync(stage);
            break;
          }
        }
      }
      if (!ownedSkill(target, name, repository)) continue;
      configured = true;
      const original = skillTree(target);
      const desired = skillTree(path.join(repository, source), repository, target === antigravity ? original : undefined);
      if (isDeepStrictEqual(original, desired)) continue;
      if (!backup) {
        const root = path.join(home, '.agentboat/backups');
        mkdirSync(root, { recursive: true, mode: 0o700 });
        backup = mkdtempSync(path.join(root, 'skill-refresh-' + Date.now() + '-'));
      }
      const stage = mkdtempSync(path.join(parent, prefix)), old = path.join(stage, 'old');
      try {
        const next = path.join(stage, 'next');
        writeTree(next, desired);
        if (!ownedSkill(next, name, repository)) throw Error('新版 SKILL.md 的身份或入口不匹配');
        const archive = target === antigravity ? path.join(backup, 'antigravity', name) : path.join(backup, name);
        cpSync(target, archive, { recursive: true, verbatimSymlinks: true });
        renameSync(target, old);
        try {
          if (!isDeepStrictEqual(skillTree(old), original)) throw Error('skill 在刷新期间已更改');
          renameSync(next, target);
        }
        catch (error) { renameSync(old, target); throw error; }
        rmSync(old, { recursive: true });
      } finally {
        if (!stat(old)) rmSync(stage, { recursive: true, force: true });
      }
    } catch (error) { console.error(`AgentBoat 刷新 ${name} 失败：${error.message}`); }
  }
  let changed = false;
  for (const plan of hookPlans(home, codexHome, repository, true)) {
    try {
      const hooks = plan();
      configured ||= hooks.registered;
      changed ||= hooks.changed;
    } catch (error) { changed = true; console.error(`AgentBoat 检查 hooks 失败：${error.message}`); }
  }
  return configured && changed;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(install(os.homedir(), process.env.CODEX_HOME || undefined), null, 2));
