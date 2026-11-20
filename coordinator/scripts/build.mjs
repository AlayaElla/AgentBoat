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
// Rebuild the generated directory so incremental packages cannot retain retired fonts or decoders.
await rm(new URL('../src/assets/pdf', import.meta.url), { recursive: true, force: true });
for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) await cp(pdf + 'build/' + file, assets + file);
for (const file of ['LICENSE', 'cmaps', 'standard_fonts/FoxitSymbol.pfb', 'standard_fonts/FoxitDingbats.pfb', 'standard_fonts/LICENSE_FOXIT',
  'wasm/jbig2_nowasm_fallback.js', 'wasm/openjpeg_nowasm_fallback.js', 'wasm/LICENSE_JBIG2', 'wasm/LICENSE_OPENJPEG',
  'wasm/LICENSE_PDFJS_JBIG2', 'wasm/LICENSE_PDFJS_OPENJPEG']) {
  await cp(pdf + file, assets + file, { recursive: true });
}
await cp('src', 'plugin/src', { recursive: true });
const manifest = JSON.parse(await readFile('orca-plugin.json', 'utf8'));
manifest.main = 'worker.mjs';
await writeFile('plugin/orca-plugin.json', JSON.stringify(manifest, null, 2) + '\n');
