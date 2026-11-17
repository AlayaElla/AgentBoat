import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
export function install(home = os.homedir()) {
  const skills = ['agentboat-workspace', 'orca-project-coordinator'].map(name => ({
    source: fileURLToPath(new URL(name === 'agentboat-workspace' ? './skill/agentboat-workspace/' : '../coordinator/skill/orca-project-coordinator/', import.meta.url)),
    target: path.join(home, '.agents/skills', name), link: path.join(home, '.claude/skills', name)
  }));
  // Refuse a foreign directory before changing the installed skill; never request admin rights.
  for (const { target, link } of skills) {
    let entry;
    try { entry = lstatSync(link); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (entry && (!entry.isSymbolicLink() || realpathSync(link) !== path.resolve(target))) throw new Error(`Claude 位置已有其他内容，未覆盖：${link}`);
    if (existsSync(target) && (!lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink())) throw new Error(`安装目标必须是普通目录：${target}`);
  }
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
  return { repository, skills: skills.map(({ target, link }) => ({ installed: target, claudeLink: link })) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(install(), null, 2));
