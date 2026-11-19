import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
function hookSettings(home) {
  const file = path.join(home, '.claude', 'settings.json');
  const script = fileURLToPath(new URL('./harness/hook.mjs', import.meta.url));
  if (!existsSync(script)) throw Error('找不到 AgentBoat Claude hooks');
  let info;
  try { info = lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (info && !info.isFile()) throw Error('Claude settings.json 必须是普通文件');
  const original = info ? readFileSync(file) : undefined;
  const settings = original ? JSON.parse(original.toString('utf8').replace(/^\uFEFF/, '')) : {};
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(settings) || settings.hooks !== undefined && !object(settings.hooks)) throw Error('Claude hooks 设置格式不正确');
  if (settings.disableAllHooks === true) throw Error('Claude 已关闭所有 hooks');
  const hooks = settings.hooks ??= {};
  const before = JSON.stringify(hooks);
  const marker = '--agentboat-role-harness';
  const owned = hook => hook?.type === 'command' && Array.isArray(hook.args) && hook.args[1] === marker && path.basename(hook.args[0] || '') === 'hook.mjs';
  const handler = { type: 'command', command: process.execPath, args: [script, marker], timeout: 5, onFailure: 'continue' };
  for (const [event, matcher] of [
    ['SessionStart', 'startup|resume|compact|clear'], ['PreToolUse', 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Monitor'], ['Stop', '']
  ]) {
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups) || groups.some(group => !object(group) || !Array.isArray(group.hooks))) throw Error('Claude ' + event + ' hooks 格式不正确');
    hooks[event] = groups.flatMap(group => {
      if (!group.hooks.some(owned)) return [group];
      const keep = group.hooks.filter(hook => !owned(hook));
      return keep.length ? [{ ...group, hooks: keep }] : [];
    });
    hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [handler] });
  }
  return () => {
    if (JSON.stringify(hooks) === before) return;
    const current = existsSync(file) ? readFileSync(file) : undefined;
    if (current ? !original?.equals(current) : original) throw Error('Claude settings.json 已更新，请重试安装');
    const id = randomUUID(), temp = file + '.' + id + '.tmp';
    if (original) writeFileSync(file + '.agentboat-' + id + '.bak', original, { flag: 'wx', mode: 0o600, flush: true });
    try {
      writeFileSync(temp, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode: info ? info.mode & 0o777 : 0o600, flush: true });
      renameSync(temp, file);
    } finally { rmSync(temp, { force: true }); }
  };
}
export function install(home = os.homedir()) {
  const skills = ['agentboat-workspace', 'orca-project-coordinator'].map(name => ({
    source: fileURLToPath(new URL(name === 'agentboat-workspace' ? './skill/agentboat-workspace/' : '../coordinator/skill/orca-project-coordinator/', import.meta.url)),
    target: path.join(home, '.agents/skills', name), link: path.join(home, '.claude/skills', name)
  }));
  // Refuse a foreign directory before changing the installed skill; never request admin rights.
  for (const { target, link } of skills) {
    let entry;
    try { entry = lstatSync(link); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (entry && (!entry.isSymbolicLink() || realpathSync(link) !== realpathSync(target))) throw new Error(`Claude 位置已有其他内容，未覆盖：${link}`);
    if (existsSync(target) && (!lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink())) throw new Error(`安装目标必须是普通目录：${target}`);
  }
  const installHooks = hookSettings(home);
  function render(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) render(file);
      else if (entry.name.endsWith('.md')) writeFileSync(file, readFileSync(file, 'utf8').replaceAll('{{AGENTBOAT_REPO}}', repository));
    }
  }
  for (const { source, target, link } of skills) {
    mkdirSync(target, { recursive: true });
    cpSync(source, target, { recursive: true });
    render(target);
    mkdirSync(path.dirname(link), { recursive: true });
    if (!existsSync(link)) symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  installHooks();
  return { repository, skills: skills.map(({ target, link }) => ({ installed: target, claudeLink: link })) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(install(), null, 2));
