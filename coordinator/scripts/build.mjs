import { build } from 'esbuild';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';

await build({
  entryPoints: ['src/worker.ts'],
  outfile: 'dist/worker.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  banner: { js: "import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url'; import path from 'node:path'; const require = createRequire(import.meta.url); const __filename = fileURLToPath(import.meta.url); const __dirname = path.dirname(__filename);" },
});
await mkdir('plugin', { recursive: true });
await cp('dist/worker.mjs', 'plugin/worker.mjs');
await cp('src', 'plugin/src', { recursive: true });
const manifest = JSON.parse(await readFile('orca-plugin.json', 'utf8'));
manifest.main = 'worker.mjs';
await writeFile('plugin/orca-plugin.json', JSON.stringify(manifest, null, 2) + '\n');
