import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const [operation, destination, name = 'before'] = process.argv.slice(2);
if (!destination || !['backup', 'snapshot', 'compare'].includes(operation)) throw new Error('Usage: release-evidence.mjs backup|snapshot|compare <backup-dir> [snapshot-name]');
const data = path.join(process.env.APPDATA, 'orca/plugins-data/local.project-coordinator');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
function request(...args) {
  const reply = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/client.mjs'), ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 }));
  if (!reply.ok) throw new Error('Plugin read failed');
  return reply.result.result;
}
if (operation === 'backup') {
  await mkdir(destination, { recursive: false });
  await cp(data, path.join(destination, 'plugins-data'), { recursive: true, errorOnExist: true });
  await cp(path.join(root, 'plugin'), path.join(destination, 'plugin'), { recursive: true, errorOnExist: true });
  await mkdir(path.join(destination, 'evidence'));
}
if (operation === 'backup' || operation === 'snapshot') {
  const raw = await json(path.join(data, 'storage.json'));
  const projects = {};
  for (const key of Object.keys(raw).filter(k => k.startsWith('project:'))) projects[key.slice(8)] = request('read', key.slice(8)).project;
  const snapshot = { at: new Date().toISOString(), workspace: request('main-read'), catalog: request('projects'), projects };
  await save(path.join(destination, `snapshot-${name}.json`), snapshot);
  console.log(JSON.stringify({ snapshot: name, projects: Object.keys(projects).length, path: destination }));
} else {
  const before = await json(path.join(destination, 'snapshot-before.json'));
  const after = await json(path.join(destination, `snapshot-${name}.json`));
  const ids = [...new Set([...Object.keys(before.projects), ...Object.keys(after.projects)])];
  const differences = ids.filter(id => !isDeepStrictEqual(before.projects[id], after.projects[id]));
  const workspaceEqual = isDeepStrictEqual(before.workspace, after.workspace);
  const catalog = value => ({ ...value, projects: [...value.projects].sort((a, b) => a.id.localeCompare(b.id)) });
  const catalogEqual = isDeepStrictEqual(catalog(before.catalog), catalog(after.catalog));
  const result = { projects: ids.length, differences, workspaceEqual, catalogEqual };
  await save(path.join(destination, 'evidence', `comparison-${name}.json`), result);
  console.log(JSON.stringify(result));
  if (differences.length || !workspaceEqual || !catalogEqual) process.exitCode = 1;
}
