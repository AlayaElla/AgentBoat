import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { executable } from './orca-cli.mjs';

const resources = path.resolve(path.dirname(executable), '../app.asar.unpacked/resources/plugins/declarative');
await mkdir('.orca/local-test', { recursive: true });
await writeFile('.orca/local-test/check-entry.mjs', `
import {mount, mockHost} from 'orca/testing';
import * as panel from '../../src/panel.tsx';
import scenarios from '../../src/panel.check.ts';
for (const [name, scenario] of Object.entries(scenarios)) {
  const view = await mount(panel, {...scenario, host:mockHost(scenario)});
  if (view.errors.length || view.warnings.length || view.refusals.length) throw new Error(JSON.stringify({name,errors:view.errors,warnings:view.warnings,refusals:view.refusals}));
  console.log(name, JSON.stringify(view.summary()));
  await view.unmount();
}
`);
await build({entryPoints:['.orca/local-test/check-entry.mjs'], outfile:'.orca/local-test/check.mjs', bundle:true, platform:'node',format:'esm',
  inject:['scripts/test-jsx.mjs'], tsconfigRaw:{compilerOptions:{jsx:'react',jsxFactory:'__orcaTestH',jsxFragmentFactory:'__orcaTestFragment'}},
  alias:{'orca/testing':path.join(resources,'orca-testing.mjs'),'orca':path.join(resources,'orca-runtime.mjs')},
  banner:{js:"import {createRequire as __r} from 'node:module'; const require=__r(import.meta.url);"}
});
execFileSync(process.execPath,['.orca/local-test/check.mjs'],{stdio:'inherit'});
