import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executable, releasePluginKey } from './orca-cli.mjs';

const [tag, output] = process.argv.slice(2);
if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag) || !output || process.argv.length !== 4) {
  throw new Error('用法：node coordinator/scripts/release.mjs vX.Y.Z <仓库外的全新输出目录>');
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const coordinator = path.join(root, 'coordinator');
if (!existsSync(path.join(coordinator, 'scripts/worker-reports.mjs'))) throw new Error('请在合入 Claude 与 Codex hooks 安装器后打包');
const out = path.resolve(output);
const relative = path.relative(root, out);
if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) || existsSync(out)) {
  throw new Error('输出目录必须在源码仓库外且尚不存在');
}
const run = (command, args, cwd = coordinator) => execFileSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
const git = args => run('git', args, out);
const node = (...args) => run(process.execPath, args);

run(executable, ['plugin', 'types', '.', '--json']);
node('node_modules/typescript/bin/tsc', '--noEmit', '-p', '.');
node('scripts/test-local.mjs');
node('scripts/build.mjs');

mkdirSync(out);
for (const [source, destination] of [
  ['LICENSE', 'LICENSE'], ['README.md', 'README.md'],
  ['coordinator/plugin/worker.mjs', 'worker.mjs'],
  ...['panel.html', 'panel.css', 'panel-page.ts', 'model.ts', 'task-state.mjs', 'artifact-versions.mjs', 'protocol.ts', 'feedback-drafts.ts', 'assets'].map(name => ['coordinator/plugin/src/' + name, 'src/' + name]),
  ...['client.mjs', 'lead-contact.mjs', 'orca-cli.mjs', 'cli-bridge.mjs', 'main-role-card.mjs', 'worker-reports.mjs'].map(name => ['coordinator/scripts/' + name, 'coordinator/scripts/' + name]),
  ['coordinator/scripts/setup.mjs', 'setup.mjs'],
  ...['skill', 'LINKS.md'].map(name => ['coordinator/' + name, 'coordinator/' + name]),
  ...['install.mjs', 'workspace.mjs', 'agent-launch.mjs', 'project-skills.mjs', 'harness/hook.mjs', 'skill/agentboat-workspace', 'templates/code.json', 'README.md'].map(name => ['workspace/' + name, 'workspace/' + name]),
]) {
  cpSync(path.join(root, source), path.join(out, destination), { recursive: true });
}
const manifest = JSON.parse(readFileSync(path.join(coordinator, 'plugin/orca-plugin.json'), 'utf8'));
if (manifest.id !== releasePluginKey.split('.')[1]) throw new Error('发布身份与清单 ID 不一致');
manifest.version = tag.slice(1);
writeFileSync(path.join(out, 'orca-plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
node('scripts/setup.test.mjs', out);
run(executable, ['plugin', 'validate', out, '--json']);
git(['init', '--initial-branch=release', '--quiet']);
const repository = 'https://github.com/AlayaElla/AgentBoat.git';
git(['remote', 'add', 'origin', repository]);
git(['add', '--all']);
git(['-c', 'user.name=AgentBoat Release', '-c', 'user.email=release@example.invalid', 'commit', '--quiet', '-m', `AgentBoat ${tag}`]);
run(executable, ['plugin', 'release-entry', '.', '--json'], out);
git(['tag', tag]);
console.log(`已生成 ${tag}。发布命令：git -C "${out}" push origin refs/tags/${tag}`);
