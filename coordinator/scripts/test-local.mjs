import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// shortcut: Orca 1.4.256's Windows test loader refuses its own runtime import; remove when that runner works.
const resources = path.resolve(path.dirname(process.env.ORCA_CLI_COMMAND), '../app.asar.unpacked/resources/plugins/declarative');
await mkdir('.orca/local-test', { recursive: true });
const runtime = path.join(resources, 'orca-runtime.mjs');
await build({
  entryPoints: ['src/coordinator.test.ts','src/feishu.test.ts','src/interface.test.tsx','src/links.test.ts','src/requests.test.ts'], outdir: '.orca/local-test',
  bundle: true, platform: 'node', format: 'esm', target: 'node22', jsx: 'transform', jsxFactory: '__orcaTestH', jsxFragment: '__orcaTestFragment',
  inject: ['scripts/test-jsx.mjs'], tsconfigRaw: {compilerOptions:{jsx:'react',jsxFactory:'__orcaTestH',jsxFragmentFactory:'__orcaTestFragment'}},
  alias: { 'orca/testing': path.join(resources,'orca-testing.mjs'), 'orca': runtime },
  banner: {js:"import { createRequire as __testRequire } from 'node:module'; import { fileURLToPath as __testFile } from 'node:url'; import __testPath from 'node:path'; const require = __testRequire(import.meta.url); const __filename = __testFile(import.meta.url); const __dirname = __testPath.dirname(__filename);"},
  outExtension:{'.js':'.mjs'}
});
execFileSync(process.execPath, ['--test', '.orca/local-test/coordinator.test.mjs', '.orca/local-test/feishu.test.mjs', '.orca/local-test/interface.test.mjs', '.orca/local-test/links.test.mjs', '.orca/local-test/requests.test.mjs'], {stdio:'inherit'});
