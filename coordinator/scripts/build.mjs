import { build } from 'esbuild';
import { mkdir, cp, rm, readFile, writeFile } from 'node:fs/promises';

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
// Generated source copy only; plugin data lives outside this directory.
await rm(new URL('../plugin/src', import.meta.url), { recursive: true, force: true });
const pdf = 'node_modules/pdfjs-dist/', assets = 'src/assets/pdf/';
await mkdir(assets, { recursive: true });
for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) await cp(pdf + 'build/' + file, assets + file);
for (const file of ['cmaps', 'standard_fonts', 'wasm', 'LICENSE']) await cp(pdf + file, assets + file, { recursive: true });
await cp('src', 'plugin/src', { recursive: true });
const manifest = JSON.parse(await readFile('orca-plugin.json', 'utf8'));
manifest.main = 'worker.mjs';
await writeFile('plugin/orca-plugin.json', JSON.stringify(manifest, null, 2) + '\n');
