import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executable } from './orca-cli.mjs';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const { build } = await import('esbuild');

// shortcut: Orca 1.4.256's Windows test loader refuses its own runtime import; remove when that runner works.
const cliPath = realpathSync(path.isAbsolute(executable) ? executable : execFileSync('which', [executable], { encoding: 'utf8' }).trim());
const resources = path.resolve(path.dirname(cliPath), '../app.asar.unpacked/resources/plugins/declarative');
await mkdir('.orca/local-test', { recursive: true });
const runtime = path.join(resources, 'orca-runtime.mjs');
const tests = ['butler', 'coordinator', 'feishu', 'links', 'link-messages', 'main-agent', 'backup-lead', 'bot-main', 'agents', 'role-registry'];
await build({
  entryPoints: tests.map(name => `src/${name}.test.ts`), outdir: '.orca',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  alias: { 'orca/testing': path.join(resources,'orca-testing.mjs'), 'orca': runtime },
  banner: {js:"import { createRequire as __testRequire } from 'node:module'; import { fileURLToPath as __testFile } from 'node:url'; import __testPath from 'node:path'; const require = __testRequire(import.meta.url); const __filename = __testFile(import.meta.url); const __dirname = __testPath.dirname(__filename);"},
  outExtension:{'.js':'.mjs'}
});
const home = await mkdtemp(path.join(tmpdir(), 'agentboat-tests-'));
try {
  execFileSync(process.execPath, ['--test', ...tests.map(name => `.orca/${name}.test.mjs`), 'scripts/client.test.mjs', 'scripts/lead-contact.test.mjs', 'scripts/cli-bridge.test.mjs', 'scripts/paths.test.mjs', 'scripts/stable-entry.test.mjs', '../workspace/install.test.mjs', '../workspace/workspace.test.mjs', '../workspace/project-skills.test.mjs', '../workspace/harness/hook.test.mjs'], { stdio: 'inherit', env: { ...process.env, AGENTBOAT_HOME: home } });
} finally {
  await rm(home, { recursive: true, force: true, maxRetries: 3 });
}
